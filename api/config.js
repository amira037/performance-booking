// api/config.js — 예매 페이지용 공개 설정 조회
// GET /api/config

import { getSessions, getPresets, getPerformance, getReservations } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const [sessions, presets, performance, reservations] = await Promise.all([
    getSessions(),
    getPresets(),
    getPerformance(),
    getReservations(),
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

  // 회차별 잔여석 계산 (실제 예약 기록 기준)
  const sessionsWithRemain = sessions.map(s => {
      const booked = reservations
        .filter(r => r.sessionId === s.id && (r.payStatus === '입금확인' || r.payStatus === '미입금' || r.payStatus === '현장결제예정'))
        .reduce((sum, r) => sum + (r.quantity || 0), 0);
      const remain = Math.max(0, s.seats - booked);
      const timeClosed = isClosedByTime(s);
      // 관리자 수동 마감 or 시간 마감이면 closed
      const effectiveStatus = (s.status === "closed" || timeClosed) ? "closed" : s.status;
      return { ...s, booked, remain, status: effectiveStatus, timeClosed, closesAt: getClosesAt(s) };
    });

  // 날짜/시간 순으로 정렬
  sessionsWithRemain.sort((a, b) => {
    const at = new Date(a.date + 'T' + (a.time||'00:00'));
    const bt = new Date(b.date + 'T' + (b.time||'00:00'));
    return at - bt;
  });

  // 취소/변경 정책 마감 시각 계산 헬퍼 (각 회차 기준)
  function deadlineTs(sessionDate, sessionTime, daysBeforePerf, hour) {
    if (daysBeforePerf === -1) return null; // 제한 없음
    const [h, m] = sessionTime.split(':').map(Number);
    const perfDate = new Date(sessionDate + 'T' + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':00+09:00');
    const deadline = new Date(perfDate);
    deadline.setDate(deadline.getDate() - daysBeforePerf);
    deadline.setHours(hour, 0, 0, 0);
    return deadline.getTime();
  }

  return res.status(200).json({
    performance,
    sessions: sessionsWithRemain,
    presets:  presets.filter(p => p.active),
    account:       performance.account       || '',
    accountHolder: performance.accountHolder || '',
  });
}
