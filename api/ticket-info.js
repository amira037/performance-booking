// api/ticket-info.js — 예약번호로 티켓 정보 조회
// GET /api/ticket-info?res=DQ-0323-0461

import { findReservation, getPerformance } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const resNum = req.query.res;
  if (!resNum)
    return res.status(400).json({ success: false, message: '예약번호가 없습니다.' });

  const [reservation, perf] = await Promise.all([
    findReservation(resNum),
    getPerformance(),
  ]);

  if (!reservation)
    return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });

  // 입금확인 된 예약만 티켓 표시
  if (reservation.payStatus !== '입금확인')
    return res.status(403).json({ success: false, message: '입금 확인 전 티켓은 조회할 수 없습니다.' });

  return res.status(200).json({
    success:    true,
    resNum:     reservation.resNum,
    name:       reservation.name,
    session:    reservation.session,
    seatType:   reservation.ticketType,
    quantity:   reservation.quantity,
    needProof:  reservation.needProof,
    checkedIn:  reservation.checkedIn,
    // 공연 정보
    perfName:   perf.name       || '',
    perfSub:    perf.subtitle   || '',
    agency:     perf.agency     || '',
    tel:        perf.tel        || '',
    host:       perf.host       || '',
    organizer:  perf.organizer  || '',
    sponsor:    perf.sponsor    || '',
    poster:     perf.posterUrl  || '',
    notice:     perf.notice     || '',
  });
}
