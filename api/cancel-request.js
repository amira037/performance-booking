// api/cancel-request.js — 관객 취소 신청 API
// POST /api/cancel-request

import { findReservation, updateReservation, addLog, getPerformance } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { resNum, phone, reason, refundBank, refundAccount, refundHolder } = req.body;

  if (!resNum || !phone)
    return res.status(400).json({ success: false, message: '예약번호와 연락처를 입력해 주세요.' });

  // 예약 조회
  const reservation = await findReservation(resNum.toUpperCase().trim());
  if (!reservation)
    return res.status(404).json({ success: false, message: '예약 정보를 찾을 수 없습니다.\n예약번호를 다시 확인해 주세요.' });

  // 연락처 일치 확인 (끝 4자리만 비교 — 개인정보 보호)
  const inputLast4 = phone.replace(/-/g, '').slice(-4);
  const savedLast4 = String(reservation.phone).replace(/-/g, '').slice(-4);
  if (inputLast4 !== savedLast4)
    return res.status(400).json({ success: false, message: '연락처가 일치하지 않습니다.' });

  // 이미 취소된 예약
  if (reservation.payStatus.includes('취소'))
    return res.status(400).json({ success: false, message: '이미 취소된 예약입니다.' });

  // 이미 입장한 예약
  if (reservation.checkedIn)
    return res.status(400).json({ success: false, message: '이미 입장 처리된 티켓은 취소할 수 없습니다.' });

  // 조회 모드 (lookup: true) — 예약 정보만 반환, 실제 취소 처리 안 함
  if (req.body.lookup) {
    return res.status(200).json({
      success:   true,
      resNum:    reservation.resNum,
      name:      reservation.name,
      session:   reservation.session,
      payStatus: reservation.payStatus,
    });
  }

  // ── 날짜 변경 신청 ──
  if (req.body.requestType === 'change') {
    const { newSessionId, newSessionLabel } = req.body;
    if (!newSessionId || !newSessionLabel)
      return res.status(400).json({ success: false, message: '변경할 회차 정보가 없습니다.' });

    // 예약 상태에 변경신청 기록
    await updateReservation(resNum, {
      changeRequest: { type: 'change', newSessionId, newSessionLabel, requestedAt: new Date().toISOString() }
    });
    await addLog({
      resNum,
      name:   reservation.name,
      phone:  reservation.phone,
      type:   '날짜변경신청',
      result: '접수',
      error:  newSessionLabel,
    });

    // 관리자 알림
    const perf2 = await getPerformance();
    if (perf2.tel) {
      try {
        const { sendCancelRequestAlimtalk } = await import('../lib/alimtalk.js');
        await sendCancelRequestAlimtalk({
          adminPhone: perf2.tel,
          resNum, name: reservation.name,
          session: reservation.session,
          total:   reservation.total,
          reason:  '날짜변경 신청 → ' + newSessionLabel,
          perfName: perf2.name || '공연',
        });
      } catch(e) {}
    }
    return res.status(200).json({ success: true, resNum, name: reservation.name });
  }

  // 예약 상태에 취소신청 기록
  await updateReservation(resNum, {
    changeRequest: {
      type:          'cancel',
      reason:        reason        || '',
      refundBank:    refundBank    || '',
      refundAccount: refundAccount || '',
      refundHolder:  refundHolder  || '',
      requestedAt:   new Date().toISOString(),
    }
  });

  // 취소 신청 로그 저장
  await addLog({
    resNum,
    name:   reservation.name,
    phone:  reservation.phone,
    type:   '취소신청',
    result: '접수',
    error:  reason || '',
  });

  // 관리자에게 카카오 알림톡 발송 (선택 — 관리자 번호가 있을 때)
  const perf = await getPerformance();
  const notifyPhone = perf.adminPhone || perf.tel;
  if (notifyPhone) {
    try {
      const { sendCancelRequestAlimtalk } = await import('../lib/alimtalk.js');
      await sendCancelRequestAlimtalk({
        adminPhone: notifyPhone,
        resNum,
        name:    reservation.name,
        session: reservation.session,
        total:   reservation.total,
        reason:  reason || '사유 없음',
        perfName: perf.name || '공연',
      });
    } catch(e) {
      console.error('관리자 알림 오류:', e.message);
    }
  }

  return res.status(200).json({
    success: true,
    message: '취소 신청이 접수되었습니다.\n담당자 확인 후 처리해 드립니다.',
    resNum,
    name: reservation.name,
    session: reservation.session,
    payStatus: reservation.payStatus,
  });
}
