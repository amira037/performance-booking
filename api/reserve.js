// api/reserve.js — 예약 처리 API
// POST /api/reserve

import {
  getSessions, addReservation, incrementBooked,
  getLocks, removeLock, getPerformance, addLog,
} from '../lib/db.js';
import { sendReservationAlimtalk } from '../lib/alimtalk.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { lockId, name, phone, email, sessionId, sessionLabel, ticketType, quantity, unitPrice, total, needProof } = req.body;

  // 필수값 확인
  if (!lockId || !name || !phone || !email || !sessionId)
    return res.status(400).json({ success: false, message: '필수 값 누락' });

  // 선점 유효성 확인
  const locks = await getLocks();
  const lock  = locks.find(l => l.lockId === lockId);

  if (!lock)
    return res.status(400).json({ success: false, message: '선점이 만료되었습니다. 다시 시도해 주세요.' });

  if (lock.expiresAt < Date.now())
    return res.status(400).json({ success: false, message: '선점 시간이 초과되었습니다. 다시 시도해 주세요.' });

  if (lock.sessionId !== sessionId || lock.quantity !== quantity)
    return res.status(400).json({ success: false, message: '선점 정보가 일치하지 않습니다.' });

  // 예약번호 생성
  const now      = new Date();
  const mmdd     = String(now.getMonth() + 1).padStart(2,'0') + String(now.getDate()).padStart(2,'0');
  const seq      = String(Date.now()).slice(-4);
  const resNum   = `DQ-${mmdd}-${seq}`;

  // 예약 저장
  const reservation = {
    resNum, name, phone, email,
    sessionId, session: sessionLabel,
    ticketType, quantity, unitPrice, total,
    needProof: needProof || false,
    payStatus:  '미입금',
    ticketSent: false,
    checkedIn:  false,
    createdAt:  now.toISOString(),
    processedAt: null,
  };

  await addReservation(reservation);

  // 선점 → 예약 완료로 전환 (선점 해제 + 좌석 확정)
  await removeLock(lockId);
  await incrementBooked(sessionId, quantity);

  // 예약 저장 완료 → 알림톡은 실패해도 예약은 성공 처리
  let sent = false;
  try {
    const perf = await getPerformance();
    const cancelUrl = (process.env.TICKET_BASE_URL || '').replace('/ticket.html', '') + '/cancel.html';
    sent = await sendReservationAlimtalk({
      customText:    perf.tpl01            || '',
      name, phone, resNum,
      session: sessionLabel,
      ticketType, quantity, total,
      perfName:      perf.name          || '공연',
      account:       perf.account       || '',
      accountHolder: perf.accountHolder || '',
      kakaopayLink:  perf.kakaopayLink  || '',
      cancelUrl,
    });
  } catch(alimErr) {
    console.error('알림톡 발송 오류 (예약은 완료됨):', alimErr.message);
  }

  try {
    await addLog({ resNum, name, phone, type: '예약확인', result: sent ? '성공' : '실패' });
  } catch(logErr) {}

  return res.status(200).json({ success: true, resNum });
}
