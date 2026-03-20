// api/lock.js — 좌석 임시 선점 API
// POST /api/lock  → 선점 생성
// DELETE /api/lock → 선점 해제

import { getSessions, addLock, removeLock, getRemainSeats } from '../lib/db.js';

const LOCK_DURATION_MS = 10 * 60 * 1000; // 10분

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 선점 생성
  if (req.method === 'POST') {
    const { sessionId, quantity } = req.body;
    if (!sessionId || !quantity)
      return res.status(400).json({ success: false, message: '필수 값 누락' });

    const sessions = await getSessions();
    const session  = sessions.find(s => s.id === sessionId);
    if (!session)
      return res.status(404).json({ success: false, message: '회차를 찾을 수 없습니다.' });

    if (session.status !== 'open')
      return res.status(400).json({ success: false, message: '예매가 마감된 회차입니다.' });

    // 공연 4시간 전 마감 체크
    if (session.date && session.time) {
      const [h, m]  = session.time.split(':').map(Number);
      const perfTime = new Date(session.date + 'T' + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':00+09:00');
      const cutoff   = perfTime.getTime() - 4 * 60 * 60 * 1000;
      if (Date.now() >= cutoff) {
        return res.status(400).json({ success: false, message: '공연 4시간 전부터는 예매가 마감됩니다.' });
      }
    }

    const remain = await getRemainSeats(sessionId, session.seats);
    if (remain < quantity)
      return res.status(400).json({
        success: false,
        message: remain <= 0 ? '매진되었습니다.' : `잔여석이 ${remain}석뿐입니다.`,
        remain,
      });

    // 선점 생성
    const lockId = crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).substring(2) + Date.now().toString(36);

    const lock = {
      lockId,
      sessionId,
      quantity,
      expiresAt: Date.now() + LOCK_DURATION_MS,
    };

    await addLock(lock);

    return res.status(200).json({
      success:   true,
      lockId,
      expiresAt: lock.expiresAt,
      expiresIn: LOCK_DURATION_MS,
    });
  }

  // 선점 해제 (예약 취소 또는 타이머 만료)
  if (req.method === 'DELETE') {
    const { lockId } = req.body;
    if (!lockId)
      return res.status(400).json({ success: false, message: 'lockId 누락' });
    await removeLock(lockId);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
