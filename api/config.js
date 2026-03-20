// api/config.js — 예매 페이지용 공개 설정 조회
// GET /api/config

import { getSessions, getPresets, getPerformance, getBookedCount, getLockedSeats } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const [sessions, presets, performance] = await Promise.all([
    getSessions(),
    getPresets(),
    getPerformance(),
  ]);

  // 공연 4시간 전 자동 마감 체크
  const CUTOFF_HOURS = 4;
  const now = Date.now();

  function isClosedByTime(s) {
    if (!s.date || !s.time) return false;
    const [h, m] = s.time.split(":").map(Number);
    const perf   = new Date(s.date + "T" + String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0") + ":00+09:00");
    return now >= perf.getTime() - CUTOFF_HOURS * 60 * 60 * 1000;
  }

  function getClosesAt(s) {
    if (!s.date || !s.time) return null;
    const [h, m] = s.time.split(":").map(Number);
    const perf   = new Date(s.date + "T" + String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0") + ":00+09:00");
    return perf.getTime() - CUTOFF_HOURS * 60 * 60 * 1000;
  }

  // 회차별 잔여석 계산 (예약완료 + 선점 + 시간 마감 포함)
  const sessionsWithRemain = await Promise.all(
    sessions.map(async s => {
      const booked     = await getBookedCount(s.id);
      const locked     = await getLockedSeats(s.id);
      const remain     = Math.max(0, s.seats - booked - locked);
      const timeClosed = isClosedByTime(s);
      // 관리자 수동 마감 or 시간 마감이면 closed
      const effectiveStatus = (s.status === "closed" || timeClosed) ? "closed" : s.status;
      return { ...s, booked, locked, remain, status: effectiveStatus, timeClosed, closesAt: getClosesAt(s) };
    })
  );

  return res.status(200).json({
    performance,
    sessions: sessionsWithRemain,
    presets:  presets.filter(p => p.active),
    account:       performance.account       || '',
    accountHolder: performance.accountHolder || '',
  });
}
