// api/checkin.js — 검표 코드로 입장 처리
// POST /api/checkin { resNum, code }

import { findReservation, updateReservation, getPerformance } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { resNum, code } = req.body;
  if (!resNum || !code)
    return res.status(400).json({ success: false, message: '예약번호와 코드를 입력해 주세요.' });

  // 공연 설정에서 검표 코드 확인
  const perf = await getPerformance();
  const checkinCode = perf.checkinCode || '';

  if (!checkinCode)
    return res.status(400).json({ success: false, message: '검표 코드가 설정되지 않았습니다. 관리자에게 문의하세요.' });

  if (String(code).trim() !== String(checkinCode).trim())
    return res.status(400).json({ success: false, message: '코드가 올바르지 않습니다.' });

  // 예약 확인
  const reservation = await findReservation(resNum);
  if (!reservation)
    return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });

  if (reservation.payStatus !== '입금확인')
    return res.status(400).json({ success: false, message: '입금이 확인되지 않은 예약입니다.' });

  if (reservation.checkedIn)
    return res.status(400).json({ success: false, message: '이미 입장 처리된 티켓입니다.' });

  // 입장 처리
  await updateReservation(resNum, {
    checkedIn:   true,
    checkedInAt: new Date().toISOString(),
  });

  return res.status(200).json({ success: true, name: reservation.name, session: reservation.session });
}
