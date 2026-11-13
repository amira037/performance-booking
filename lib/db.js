// lib/db.js — Redis(Upstash) 데이터 접근 공통 모듈 (다중 공연 지원)

import { Redis } from '@upstash/redis';

const kv = new Redis({
  url:   process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ============================================================
// 키 구조 (schemaVersion 2)
//
// [전역]
// schemaVersion          → 2
// performances           → 공연 목록 [{ id, name, resPrefix, archived, createdAt }]
// defaultPerformance     → 공연 ID (p 파라미터 없이 접속 시 사용)
// resIndex               → Hash  예약번호 → 공연 ID
//
// [공연별]  p:{pid}:...
// p:{pid}:res            → Hash  예약번호 → 예약 객체
// p:{pid}:sessions       → 회차 배열
// p:{pid}:presets        → 할인 프리셋 배열
// p:{pid}:performance    → 공연/기획사 설정 객체
// p:{pid}:locks          → 선점 배열
// p:{pid}:seatAlloc      → 판매처별 배정 좌석수
// p:{pid}:logs           → 발송 로그 (최근 500건)
// p:{pid}:seats:{sid}    → 회차별 예약 수 카운터
//
// [v1 레거시] reservations, sessions, presets, performance, locks, seatAlloc, logs
//   → 마이그레이션 시 복사만 하고 삭제하지 않음 (백업용)
// ============================================================

const SCHEMA_VERSION = 2;
const k = (pid, name) => `p:${pid}:${name}`;

const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);

export const DEFAULT_RES_PREFIX = 'DQ';

export function emptyPerformance() {
  return {
    name: '', agency: '', tel: '', email: '',
    subtitle: '', host: '', organizer: '', sponsor: '',
    open: 'open', maxQty: 4,
    account: '', accountHolder: '',
    kakaopayLink: '',
    resPrefix: DEFAULT_RES_PREFIX,
  };
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

function newPid() {
  return 'pf' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// ── 마이그레이션 (v1 → v2) ────────────────────────────────

let migrated = false;

export async function ensureMigrated() {
  if (migrated) return;
  const ver = Number(await kv.get('schemaVersion')) || 1;
  if (ver >= SCHEMA_VERSION) { migrated = true; return; }

  // 동시 실행 방지
  const got = await kv.set('migrateLock', '1', { nx: true, ex: 60 });
  if (!got) {
    // 다른 인스턴스가 진행 중 → 완료될 때까지 잠시 대기
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if ((Number(await kv.get('schemaVersion')) || 1) >= SCHEMA_VERSION) { migrated = true; return; }
    }
    throw new Error('데이터 마이그레이션 대기 시간 초과');
  }

  try {
    const [reservations, sessions, presets, performance, locks, seatAlloc, logs] = await Promise.all(
      ['reservations', 'sessions', 'presets', 'performance', 'locks', 'seatAlloc', 'logs'].map(key => kv.get(key))
    );

    const pid  = newPid();
    const perf = { ...emptyPerformance(), ...(performance || {}) };
    if (!perf.resPrefix) perf.resPrefix = DEFAULT_RES_PREFIX;

    const p = kv.pipeline();
    p.set(k(pid, 'performance'), perf);
    p.set(k(pid, 'sessions'),    sessions  || []);
    p.set(k(pid, 'presets'),     presets   || getDefaultPresets());
    p.set(k(pid, 'locks'),       locks     || []);
    p.set(k(pid, 'seatAlloc'),   seatAlloc || {});
    p.set(k(pid, 'logs'),        logs      || []);

    const list = reservations || [];
    if (list.length) {
      const resHash = {}, idxHash = {};
      for (const r of list) {
        if (!r.resNum) continue;
        resHash[r.resNum] = r;
        idxHash[r.resNum] = pid;
      }
      p.hset(k(pid, 'res'), resHash);
      p.hset('resIndex', idxHash);
    }

    p.set('performances', [{
      id: pid, name: perf.name || '기존 공연', resPrefix: perf.resPrefix,
      archived: false, createdAt: new Date().toISOString(),
    }]);
    p.set('defaultPerformance', pid);
    p.set('schemaVersion', SCHEMA_VERSION);
    await p.exec();

    console.log(`[MIGRATE] v1 → v2 완료: 공연 ${pid}, 예약 ${list.length}건`);
    migrated = true;
  } finally {
    await kv.del('migrateLock');
  }
}

// ── 공연 목록 ──────────────────────────────────────────────

export async function listPerformances() {
  await ensureMigrated();
  return (await kv.get('performances')) || [];
}

async function savePerformanceList(list) {
  await kv.set('performances', list);
}

export async function getDefaultPid() {
  await ensureMigrated();
  const pid = await kv.get('defaultPerformance');
  if (pid) return String(pid);
  const list = await listPerformances();
  return list[0]?.id || null;
}

export async function setDefaultPid(pid) {
  const list = await listPerformances();
  if (!list.some(p => p.id === pid)) return false;
  await kv.set('defaultPerformance', pid);
  return true;
}

// 요청에서 공연 ID 결정: 헤더 x-perf-id → 쿼리 ?p= → 바디 pid → 기본 공연
export async function resolvePid(req) {
  const raw = req.headers?.['x-perf-id'] || req.query?.p || req.body?.pid || '';
  const list = await listPerformances();
  if (raw) {
    const hit = list.find(p => p.id === String(raw));
    return hit ? hit.id : null;
  }
  return getDefaultPid();
}

// 예약번호로 공연 ID 찾기 (인덱스 → 없으면 기본 공연)
export async function pidForResNum(resNum) {
  await ensureMigrated();
  const pid = await kv.hget('resIndex', resNum);
  return pid ? String(pid) : getDefaultPid();
}

export async function createPerformance({ name, resPrefix, copyFrom }) {
  const list = await listPerformances();
  const pid  = newPid();

  let perf    = emptyPerformance();
  let presets = getDefaultPresets();
  if (copyFrom && list.some(p => p.id === copyFrom)) {
    const src = perfDb(copyFrom);
    const [srcPerf, srcPresets] = await Promise.all([src.getPerformance(), src.getPresets()]);
    // 공연 고유 정보는 비우고, 기획사·계좌·알림톡 설정 등은 그대로 복사
    perf = {
      ...srcPerf,
      subtitle: '', posterUrl: '', notice: '', checkinCode: '',
    };
    presets = srcPresets;
  }
  perf.name      = name;
  perf.resPrefix = resPrefix || perf.resPrefix || DEFAULT_RES_PREFIX;

  const db = perfDb(pid);
  await Promise.all([
    db.savePerformance(perf),
    db.savePresets(presets),
    kv.set(k(pid, 'sessions'), []),
  ]);
  list.push({ id: pid, name, resPrefix: perf.resPrefix, archived: false, createdAt: new Date().toISOString() });
  await savePerformanceList(list);
  return pid;
}

export async function setPerformanceArchived(pid, archived) {
  const list = await listPerformances();
  const item = list.find(p => p.id === pid);
  if (!item) return false;
  item.archived = Boolean(archived);
  await savePerformanceList(list);
  return true;
}

// ── 예약번호 생성 (전 공연 통틀어 중복 방지) ───────────────

export async function allocateResNum(pid, prefix) {
  const now  = new Date(Date.now() + 9 * 60 * 60 * 1000); // KST
  const mmdd = String(now.getUTCMonth() + 1).padStart(2, '0') + String(now.getUTCDate()).padStart(2, '0');
  for (let i = 0; i < 10; i++) {
    const seq = i === 0
      ? String(Date.now()).slice(-4)
      : String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const resNum = `${prefix || DEFAULT_RES_PREFIX}-${mmdd}-${seq}`;
    const ok = await kv.hsetnx('resIndex', resNum, pid);
    if (ok) return resNum;
  }
  throw new Error('예약번호 생성 실패 (재시도 초과)');
}

// ── 공연별 데이터 접근 ─────────────────────────────────────

export function perfDb(pid) {
  if (!pid) throw new Error('공연 ID가 없습니다.');

  const resKey = k(pid, 'res');

  const db = {
    pid,

    // 예약
    async getReservations() {
      const all = (await kv.hgetall(resKey)) || {};
      return Object.values(all).map(parse)
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    },
    async findReservation(resNum) {
      const r = await kv.hget(resKey, resNum);
      return r ? parse(r) : null;
    },
    async addReservation(reservation) {
      const p = kv.pipeline();
      p.hset(resKey, { [reservation.resNum]: reservation });
      p.hset('resIndex', { [reservation.resNum]: pid });
      await p.exec();
      return reservation;
    },
    // 여러 건 일괄 저장 (신규/수정 모두)
    async upsertReservations(list) {
      if (!list.length) return;
      const resHash = {}, idxHash = {};
      for (const r of list) { resHash[r.resNum] = r; idxHash[r.resNum] = pid; }
      const p = kv.pipeline();
      p.hset(resKey, resHash);
      p.hset('resIndex', idxHash);
      await p.exec();
    },
    async updateReservation(resNum, updates) {
      const cur = await db.findReservation(resNum);
      if (!cur) return null;
      const next = { ...cur, ...updates };
      await kv.hset(resKey, { [resNum]: next });
      return next;
    },
    async deleteReservation(resNum) {
      const p = kv.pipeline();
      p.hdel(resKey, resNum);
      p.hdel('resIndex', resNum);
      await p.exec();
    },
    async clearReservations() {
      const resNums = (await kv.hkeys(resKey)) || [];
      const p = kv.pipeline();
      if (resNums.length) p.hdel('resIndex', ...resNums);
      p.del(resKey);
      await p.exec();
    },

    // 선점 (Lock)
    async getLocks() {
      return (await kv.get(k(pid, 'locks'))) || [];
    },
    async addLock(lock) {
      const now   = Date.now();
      const valid = (await db.getLocks()).filter(l => l.expiresAt > now);
      valid.push(lock);
      await kv.set(k(pid, 'locks'), valid);
      return lock;
    },
    async removeLock(lockId) {
      const locks = await db.getLocks();
      await kv.set(k(pid, 'locks'), locks.filter(l => l.lockId !== lockId));
    },
    async cleanExpiredLocks() {
      const locks = await db.getLocks();
      const now   = Date.now();
      const valid = locks.filter(l => l.expiresAt > now);
      if (valid.length !== locks.length) await kv.set(k(pid, 'locks'), valid);
      return valid;
    },
    async getLockedSeats(sessionId) {
      const locks = await db.cleanExpiredLocks();
      return locks.filter(l => l.sessionId === sessionId).reduce((sum, l) => sum + l.quantity, 0);
    },
    async clearLocks() {
      await kv.set(k(pid, 'locks'), []);
    },

    // 회차
    async getSessions() {
      return (await kv.get(k(pid, 'sessions'))) || [];
    },
    async saveSessions(data) {
      await kv.set(k(pid, 'sessions'), data);
    },
    async clearSessions() {
      await kv.set(k(pid, 'sessions'), []);
    },

    // 판매처별 배정 좌석수
    async getSeatAlloc() {
      return (await kv.get(k(pid, 'seatAlloc'))) || {};
    },
    async saveSeatAlloc(data) {
      await kv.set(k(pid, 'seatAlloc'), data);
    },

    // 회차별 예약 수 카운터
    async getBookedCount(sessionId) {
      return Number(await kv.get(k(pid, `seats:${sessionId}`))) || 0;
    },
    async incrementBooked(sessionId, qty) {
      return kv.incrby(k(pid, `seats:${sessionId}`), qty);
    },
    async decrementBooked(sessionId, qty) {
      const next = await kv.decrby(k(pid, `seats:${sessionId}`), qty);
      if (next < 0) { await kv.set(k(pid, `seats:${sessionId}`), 0); return 0; }
      return next;
    },
    async clearSeatsForSessions(sessionIds) {
      if (!sessionIds?.length) return;
      await kv.del(...sessionIds.map(id => k(pid, `seats:${id}`)));
    },

    // 잔여석 계산 (실제 예약 기록 + 선점 기준)
    async getRemainSeats(sessionId, totalSeats) {
      const [reservations, locked] = await Promise.all([
        db.getReservations(),
        db.getLockedSeats(sessionId),
      ]);
      const isDirectSrc = r => !r.source || r.source === '직접';
      const booked = reservations
        .filter(r => r.sessionId === sessionId && (
          (r.payStatus === '입금확인' && isDirectSrc(r)) ||
          r.payStatus === '미입금' ||
          r.payStatus === '현장결제예정'
        ))
        .reduce((sum, r) => sum + (r.quantity || 0), 0);
      return Math.max(0, totalSeats - booked - locked);
    },

    // 할인 프리셋
    async getPresets() {
      return (await kv.get(k(pid, 'presets'))) || getDefaultPresets();
    },
    async savePresets(data) {
      await kv.set(k(pid, 'presets'), data);
    },

    // 공연 설정 (목록의 이름·접두어도 함께 갱신)
    async getPerformance() {
      const perf = (await kv.get(k(pid, 'performance'))) || emptyPerformance();
      if (!perf.resPrefix) perf.resPrefix = DEFAULT_RES_PREFIX;
      return perf;
    },
    async savePerformance(data) {
      await kv.set(k(pid, 'performance'), data);
      const list = (await kv.get('performances')) || [];
      const item = list.find(p => p.id === pid);
      if (item && (item.name !== data.name || item.resPrefix !== data.resPrefix)) {
        item.name      = data.name;
        item.resPrefix = data.resPrefix || DEFAULT_RES_PREFIX;
        await savePerformanceList(list);
      }
    },

    // 발송 로그
    async getLogs() {
      return (await kv.get(k(pid, 'logs'))) || [];
    },
    async addLog(log) {
      const logs = await db.getLogs();
      logs.push({ ...log, ts: new Date().toISOString() });
      if (logs.length > 500) logs.splice(0, logs.length - 500);
      await kv.set(k(pid, 'logs'), logs);
    },
  };

  return db;
}
