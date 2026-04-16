// lib/db.js — Vercel KV 데이터 접근 공통 모듈
// Vercel KV는 Redis 기반 key-value 스토리지
// 무료 플랜: 월 30만 건 요청, 256MB

import { Redis } from '@upstash/redis';

const kv = new Redis({
  url:   process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ============================================================
// 키 구조
// reservations          → 전체 예약 배열
// sessions              → 회차 설정 배열
// presets               → 할인 프리셋 배열
// performance           → 공연/기획사 설정 객체
// locks                 → 선점 목록 배열
// seats:{sessionId}     → 회차별 예약 완료 수
// ============================================================

// ── 예약 ──────────────────────────────────────────────────

export async function getReservations() {
  return (await kv.get('reservations')) || [];
}

export async function saveReservations(data) {
  await kv.set('reservations', data);
}

export async function addReservation(reservation) {
  const list = await getReservations();
  list.push(reservation);
  await saveReservations(list);
  return reservation;
}

export async function updateReservation(resNum, updates) {
  const list = await getReservations();
  const idx  = list.findIndex(r => r.resNum === resNum);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...updates };
  await saveReservations(list);
  return list[idx];
}

export async function findReservation(resNum) {
  const list = await getReservations();
  return list.find(r => r.resNum === resNum) || null;
}

// ── 선점 (Lock) ───────────────────────────────────────────

export async function getLocks() {
  return (await kv.get('locks')) || [];
}

export async function addLock(lock) {
  const locks = await getLocks();
  // 만료된 선점 자동 정리
  const now   = Date.now();
  const valid = locks.filter(l => l.expiresAt > now);
  valid.push(lock);
  await kv.set('locks', valid);
  return lock;
}

export async function removeLock(lockId) {
  const locks = await getLocks();
  const updated = locks.filter(l => l.lockId !== lockId);
  await kv.set('locks', updated);
}

export async function cleanExpiredLocks() {
  const locks = await getLocks();
  const now   = Date.now();
  const valid = locks.filter(l => l.expiresAt > now);
  if (valid.length !== locks.length) {
    await kv.set('locks', valid);
  }
  return valid;
}

// 특정 회차의 선점 수 합계
export async function getLockedSeats(sessionId) {
  const locks = await cleanExpiredLocks();
  return locks
    .filter(l => l.sessionId === sessionId)
    .reduce((sum, l) => sum + l.quantity, 0);
}

// ── 회차 ──────────────────────────────────────────────────

export async function getSessions() {
  return (await kv.get('sessions')) || [];
}

export async function saveSessions(data) {
  await kv.set('sessions', data);
}

// ── 판매처별 배정 좌석수 ──────────────────────────────────

export async function getSeatAlloc() {
  return (await kv.get('seatAlloc')) || {};
}

export async function saveSeatAlloc(data) {
  await kv.set('seatAlloc', data);
}

// 회차별 예약 완료 수 (빠른 조회용 캐시)
export async function getBookedCount(sessionId) {
  return (await kv.get(`seats:${sessionId}`)) || 0;
}

export async function incrementBooked(sessionId, qty) {
  const current = await getBookedCount(sessionId);
  await kv.set(`seats:${sessionId}`, current + qty);
  return current + qty;
}

export async function decrementBooked(sessionId, qty) {
  const current = await getBookedCount(sessionId);
  const next    = Math.max(0, current - qty);
  await kv.set(`seats:${sessionId}`, next);
  return next;
}

// 잔여석 계산 (예약완료 + 선점 제외)
export async function getRemainSeats(sessionId, totalSeats) {
  const booked = await getBookedCount(sessionId);
  const locked = await getLockedSeats(sessionId);
  return Math.max(0, totalSeats - booked - locked);
}

// ── 할인 프리셋 ────────────────────────────────────────────

export async function getPresets() {
  return (await kv.get('presets')) || getDefaultPresets();
}

export async function savePresets(data) {
  await kv.set('presets', data);
}

function getDefaultPresets() {
  return [
    { name: '일반',             price: 30000, needProof: false, active: true },
    { name: '얼리버드',         price: 24000, needProof: false, active: true },
    { name: '학생',             price: 24000, needProof: true,  active: true },
    { name: '팬클럽/멤버십',    price: 21000, needProof: true,  active: true },
    { name: '단체 (5인 이상)',  price: 24000, needProof: false, active: true },
    { name: '장애인/국가유공자',price: 15000, needProof: true,  active: true },
    { name: '초대권',           price: 0,     needProof: true,  active: true },
  ];
}

// ── 공연 설정 ──────────────────────────────────────────────

export async function getPerformance() {
  return (await kv.get('performance')) || {
    name: '', agency: '', tel: '', email: '',
    subtitle: '', host: '', organizer: '', sponsor: '',
    open: 'open', maxQty: 4,
    account: '', accountHolder: '',
    kakaopayLink: '',
  };
}

export async function savePerformance(data) {
  await kv.set('performance', data);
}

// ── 예약 삭제 / 전체 초기화 ───────────────────────────────

export async function deleteReservation(resNum) {
  const list = await getReservations();
  await saveReservations(list.filter(r => r.resNum !== resNum));
}

export async function clearReservations() {
  await kv.set('reservations', []);
}

export async function clearSessions() {
  await kv.set('sessions', []);
}

export async function clearLocks() {
  await kv.set('locks', []);
}

export async function clearSeatsForSessions(sessionIds) {
  if (!sessionIds || !sessionIds.length) return;
  await Promise.all(sessionIds.map(id => kv.del(`seats:${id}`)));
}

// ── 발송 로그 ──────────────────────────────────────────────

export async function addLog(log) {
  const logs = (await kv.get('logs')) || [];
  logs.push({ ...log, ts: new Date().toISOString() });
  // 최근 500건만 유지
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await kv.set('logs', logs);
}
