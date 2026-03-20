// api/admin.js — 관리자 전용 API
// POST /api/admin  { action, ...payload }

import {
  getReservations, updateReservation, findReservation,
  getSessions, saveSessions,
  getPresets, savePresets,
  getPerformance, savePerformance,
  decrementBooked, incrementBooked, addLog,
} from '../lib/db.js';
import { sendTicketAlimtalk } from '../lib/alimtalk.js';

const ADMIN_KEY = process.env.ADMIN_KEY || 'bluebline2025';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 관리자 인증
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_KEY)
    return res.status(401).json({ error: '인증 실패' });

  // 전체 데이터 조회
  if (req.method === 'GET') {
    const [reservations, sessions, presets, performance] = await Promise.all([
      getReservations(),
      getSessions(),
      getPresets(),
      getPerformance(),
    ]);
    return res.status(200).json({ reservations, sessions, presets, performance });
  }

  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { action, ...payload } = req.body;

  // ── 입금 확인 처리 ──────────────────────────────────────
  if (action === 'confirmPayment') {
    const { resNum } = payload;
    const reservation = await findReservation(resNum);
    if (!reservation)
      return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });

    await updateReservation(resNum, {
      payStatus:   '입금확인',
      processedAt: new Date().toISOString(),
    });

    const perf      = await getPerformance();
    const ticketUrl = generateTicketUrl(resNum, reservation, perf);

    let sent = false;
    try {
      sent = await sendTicketAlimtalk({
        name:      reservation.name,
        phone:     reservation.phone,
        resNum,
        session:   reservation.session,
        quantity:  reservation.quantity,
        needProof: reservation.needProof,
        perfName:  perf.name || '공연',
        ticketUrl,
      });
    } catch(alimErr) {
      console.error('티켓 알림톡 오류 (입금확인은 완료됨):', alimErr.message);
    }
    try { await addLog({ resNum, name: reservation.name, phone: reservation.phone, type: '티켓발송', result: sent ? '성공' : '실패' }); } catch(e) {}
    return res.status(200).json({ success: true, ticketUrl });
  }

  // ── 예약 취소 ────────────────────────────────────────────
  if (action === 'cancel') {
    const { resNum } = payload;
    const reservation = await findReservation(resNum);
    if (!reservation) return res.status(404).json({ success: false });

    await updateReservation(resNum, { payStatus: '관리자취소' });

    // 입금확인 전 취소면 좌석 복구
    if (reservation.payStatus !== '입금확인') {
      await decrementBooked(reservation.sessionId, reservation.quantity);
    }
    return res.status(200).json({ success: true });
  }

  // ── 티켓 재발송 ──────────────────────────────────────────
  if (action === 'resendTicket') {
    const { resNum } = payload;
    const reservation = await findReservation(resNum);
    if (!reservation) return res.status(404).json({ success: false });

    const perf      = await getPerformance();
    const ticketUrl = generateTicketUrl(resNum, reservation, perf);

    try {
      await sendTicketAlimtalk({
        name:      reservation.name,
        phone:     reservation.phone,
        resNum,
        session:   reservation.session,
        quantity:  reservation.quantity,
        needProof: reservation.needProof,
        perfName:  perf.name || '공연',
        ticketUrl,
      });
    } catch(alimErr) {
      console.error('티켓 재발송 오류:', alimErr.message);
    }
    try { await addLog({ resNum, name: reservation.name, phone: reservation.phone, type: '티켓재발송', result: '성공' }); } catch(e) {}
    return res.status(200).json({ success: true });
  }

  // ── 입장 처리 ────────────────────────────────────────────
  if (action === 'checkIn') {
    const { resNum } = payload;
    await updateReservation(resNum, {
      checkedIn:   true,
      checkedInAt: new Date().toISOString(),
    });
    return res.status(200).json({ success: true });
  }

  // ── 공연 설정 저장 ───────────────────────────────────────
  if (action === 'savePerformance') {
    await savePerformance(payload.data);
    return res.status(200).json({ success: true });
  }

  // ── 회차 추가/수정/삭제 ──────────────────────────────────
  if (action === 'addSession') {
    const sessions = await getSessions();
    sessions.push(payload.session);
    await saveSessions(sessions);
    return res.status(200).json({ success: true });
  }

  if (action === 'updateSession') {
    const sessions = await getSessions();
    const idx = sessions.findIndex(s => s.id === payload.session.id);
    if (idx === -1) return res.status(404).json({ success: false });
    sessions[idx] = { ...sessions[idx], ...payload.session };
    await saveSessions(sessions);
    return res.status(200).json({ success: true });
  }

  if (action === 'deleteSession') {
    const sessions = await getSessions();
    await saveSessions(sessions.filter(s => s.id !== payload.id));
    return res.status(200).json({ success: true });
  }

  // ── 프리셋 저장/토글 ─────────────────────────────────────
  if (action === 'savePreset') {
    const presets = await getPresets();
    if (presets.some(p => p.name === payload.preset.name))
      return res.status(400).json({ success: false, message: '이미 존재하는 프리셋입니다.' });
    presets.push({ ...payload.preset, active: true });
    await savePresets(presets);
    return res.status(200).json({ success: true });
  }

  if (action === 'togglePreset') {
    const presets = await getPresets();
    const idx = presets.findIndex(p => p.name === payload.name);
    if (idx === -1) return res.status(404).json({ success: false });
    presets[idx].active = payload.active;
    await savePresets(presets);
    return res.status(200).json({ success: true });
  }

  // ── 신청 무시 ────────────────────────────────────────────
  if (action === 'dismissRequest') {
    const { resNum } = payload;
    await updateReservation(resNum, { changeRequest: null });
    return res.status(200).json({ success: true });
  }

  // ── 회차 변경 (관리자 직권) ─────────────────────────────
  if (action === 'changeSession') {
    const { resNum, newSessionId, newSessionLabel } = payload;
    const reservation = await findReservation(resNum);
    if (!reservation) return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });

    // 기존 회차 좌석 복구
    if (reservation.payStatus === '입금확인' || reservation.payStatus === '미입금') {
      await decrementBooked(reservation.sessionId, reservation.quantity);
    }
    // 새 회차 좌석 추가
    await incrementBooked(newSessionId, reservation.quantity);

    await updateReservation(resNum, {
      sessionId: newSessionId,
      session:   newSessionLabel,
    });
    return res.status(200).json({ success: true });
  }

  // deletePreset
  if (action === 'deletePreset') {
    const presets = await getPresets();
    await savePresets(presets.filter(p => p.name !== payload.name));
    return res.status(200).json({ success: true });
  }
  // reorderPresets
  if (action === 'reorderPresets') {
    if (Array.isArray(payload.presets)) await savePresets(payload.presets);
    return res.status(200).json({ success: true });
  }
  return res.status(400).json({ error: 'unknown action' });
}

// ── 티켓 URL 생성 ─────────────────────────────────────────

function generateTicketUrl(resNum, r, perf) {
  const base   = process.env.TICKET_BASE_URL || '';
  const params = new URLSearchParams({
    res:       resNum,
    name:      r.name,
    perf:      perf.name       || '',
    agency:    perf.agency     || '',
    tel:       perf.tel        || '',
    sub:       perf.subtitle   || '',
    host:      perf.host       || '',
    organizer: perf.organizer  || '',
    sponsor:   perf.sponsor    || '',
    session:   r.session,
    type:      r.ticketType,
    qty:       r.quantity,
    proof:     r.needProof ? 'true' : 'false',
  });
  return `${base}?${params.toString()}`;
}
