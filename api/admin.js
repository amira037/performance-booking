// api/admin.js — 관리자 전용 API
// POST /api/admin  { action, ...payload }

import {
  getReservations, addReservation, updateReservation, findReservation,
  deleteReservation,
  getSessions, saveSessions,
  getSeatAlloc, saveSeatAlloc,
  getPresets, savePresets,
  getPerformance, savePerformance,
  getLocks,
  decrementBooked, incrementBooked, setBookedCount, addLog, getLogs,
  clearReservations, clearSessions, clearLocks, clearSeatsForSessions,
} from '../lib/db.js';
import { sendTicketAlimtalk, sendReminderAlimtalk, sendChangeCompleteAlimtalk, sendCancelCompleteAlimtalk } from '../lib/alimtalk.js';

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
    const [reservations, sessions, presets, performance, seatAlloc] = await Promise.all([
      getReservations(),
      getSessions(),
      getPresets(),
      getPerformance(),
      getSeatAlloc(),
    ]);

    // 각 회차의 실제 booked 수 계산 (입금확인 + 미입금 모두 포함)
    const sessionsWithBooked = sessions.map(s => {
      const confirmed = reservations.filter(r => r.sessionId === s.id && r.payStatus === '입금확인').reduce((sum, r) => sum + (r.quantity||0), 0);
      const pending   = reservations.filter(r => r.sessionId === s.id && (r.payStatus === '미입금' || r.payStatus === '현장결제예정')).reduce((sum, r) => sum + (r.quantity||0), 0);
      return { ...s, bookedConfirmed: confirmed, bookedPending: pending, booked: confirmed + pending };
    });

    return res.status(200).json({ reservations, sessions: sessionsWithBooked, presets, performance, seatAlloc });
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
        customText:   perf.tpl02     || '',
        btn1Name:     perf.tplBtn02_1 || '',
        templateCode: perf.tplCode02 || '',
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
    const { resNum, silent } = payload;
    const reservation = await findReservation(resNum);
    if (!reservation) return res.status(404).json({ success: false });

    await updateReservation(resNum, { payStatus: '관리자취소' });

    // 취소 시 항상 좌석 복구
    if (!reservation.payStatus.includes('취소')) {
      await decrementBooked(reservation.sessionId, reservation.quantity);
    }

    // 고객 취소 완료 알림톡 (silent=true이면 발송 안 함)
    if (!silent && reservation.phone) {
      try {
        const perf = await getPerformance();
        await sendCancelCompleteAlimtalk({
          customText:   perf.tpl05     || '',
          templateCode: perf.tplCode05 || '',
          name:    reservation.name,
          phone:   reservation.phone,
          resNum,
          session: reservation.session,
          perfName: perf.name || '공연',
        });
      } catch(e) { console.error('취소 완료 알림 오류:', e.message); }
    }

    return res.status(200).json({ success: true });
  }

  // ── 변경 알림 재발송 ─────────────────────────────────────
  if (action === 'resendChange') {
    const { resNum } = payload;
    const reservation = await findReservation(resNum);
    if (!reservation) return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });

    const perf = await getPerformance();
    let sent = false;
    try {
      sent = await sendChangeCompleteAlimtalk({
        customText:   perf.tpl04     || '',
        btn1Name:     perf.tplBtn04_1 || '',
        templateCode: perf.tplCode04 || '',
        name:     reservation.name,
        phone:    reservation.phone,
        resNum,
        session:  reservation.session,
        quantity: reservation.quantity,
        perfName: perf.name || '공연',
      });
    } catch(e) { console.error('변경 알림 재발송 오류:', e.message); }
    try { await addLog({ resNum, name: reservation.name, phone: reservation.phone, type: '변경알림재발송', result: sent ? '성공' : '실패' }); } catch(e) {}
    return res.status(200).json({ success: true, sent });
  }

  // ── 티켓 재발송 ──────────────────────────────────────────
  if (action === 'resendTicket') {
    const { resNum } = payload;
    console.log('[RESEND DEBUG] 재발송 시작:', resNum);

    const reservation = await findReservation(resNum);
    console.log('[RESEND DEBUG] 예약 조회:', reservation ? '✅ 있음' : '❌ 없음');
    console.log('[RESEND DEBUG] phone:', reservation?.phone || '❌ 없음');
    if (!reservation) return res.status(404).json({ success: false });

    const perf      = await getPerformance();
    const ticketUrl = generateTicketUrl(resNum, reservation, perf);
    console.log('[RESEND DEBUG] ticketUrl:', ticketUrl);
    console.log('[RESEND DEBUG] sendTicketAlimtalk 타입:', typeof sendTicketAlimtalk);

    try {
      const result = await sendTicketAlimtalk({
        customText:   perf.tpl02     || '',
        btn1Name:     perf.tplBtn02_1 || '',
        templateCode: perf.tplCode02 || '',
        name:      reservation.name,
        phone:     reservation.phone,
        resNum,
        session:   reservation.session,
        quantity:  reservation.quantity,
        needProof: reservation.needProof,
        perfName:  perf.name || '공연',
        ticketUrl,
      });
      console.log('[RESEND DEBUG] 발송 결과:', result);
    } catch(alimErr) {
      console.error('[RESEND DEBUG] ❌ 예외:', alimErr.message);
      console.error('[RESEND DEBUG] 스택:', alimErr.stack);
    }
    try { await addLog({ resNum, name: reservation.name, phone: reservation.phone, type: '티켓재발송', result: '성공' }); } catch(e) {}
    return res.status(200).json({ success: true });
  }

  // ── 입장 처리 ────────────────────────────────────────────
  if (action === 'checkIn') {
    const { resNum } = payload;
    if (!resNum) return res.status(400).json({ success: false, message: '예약번호가 없습니다.' });
    const checked = payload.checked !== undefined ? Boolean(payload.checked) : true;
    try {
      const result = await updateReservation(resNum, {
        checkedIn:   checked,
        checkedInAt: checked ? new Date().toISOString() : null,
      });
      if (!result) return res.status(404).json({ success: false, message: `예약을 찾을 수 없습니다. (${resNum})` });
      return res.status(200).json({ success: true });
    } catch(e) {
      console.error('[checkIn] 오류:', resNum, e.message);
      return res.status(500).json({ success: false, message: '입장 처리 중 오류가 발생했습니다: ' + e.message });
    }
  }

  // ── 공연 설정 저장 ───────────────────────────────────────
  if (action === 'savePerformance') {
    await savePerformance(payload.data);
    return res.status(200).json({ success: true });
  }

  // ── 회차 추가/수정/삭제 ──────────────────────────────────
  if (action === 'addSession') {
    try {
      const sessions = await getSessions();
      sessions.push(payload.session);
      await saveSessions(sessions);
      return res.status(200).json({ success: true });
    } catch(e) {
      console.error('[addSession] Redis 오류:', e.message);
      return res.status(500).json({ success: false, message: 'Redis 저장 오류: ' + e.message });
    }
  }

  if (action === 'updateSession') {
    try {
      const sessions = await getSessions();
      const idx = sessions.findIndex(s => s.id === payload.session.id);
      if (idx === -1) return res.status(404).json({ success: false, message: '회차를 찾을 수 없습니다.' });
      sessions[idx] = { ...sessions[idx], ...payload.session };
      await saveSessions(sessions);
      return res.status(200).json({ success: true });
    } catch(e) {
      console.error('[updateSession] Redis 오류:', e.message);
      return res.status(500).json({ success: false, message: 'Redis 저장 오류: ' + e.message });
    }
  }

  if (action === 'deleteSession') {
    try {
      const sessions = await getSessions();
      await saveSessions(sessions.filter(s => s.id !== payload.id));
      return res.status(200).json({ success: true });
    } catch(e) {
      console.error('[deleteSession] Redis 오류:', e.message);
      return res.status(500).json({ success: false, message: 'Redis 저장 오류: ' + e.message });
    }
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

  // ── 직권 예약 추가 ──────────────────────────────────────────
  if (action === 'addManualReservation') {
    const { name, phone, email, sessionId, sessionLabel, ticketType, quantity, unitPrice, total, needProof, sendAlim, onSite } = payload;
    if (!name || !sessionId)
      return res.status(400).json({ success: false, message: '이름과 회차는 필수입니다.' });

    const now      = new Date();
    const mmdd     = String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0');
    const seq      = String(Date.now()).slice(-4);
    const resNum   = 'DQ-' + mmdd + '-' + seq;

    const reservation = {
      resNum, name, phone: phone||'', email: email||'',
      sessionId, session: sessionLabel,
      ticketType: ticketType||'초대권', quantity: quantity||1,
      unitPrice: unitPrice||0, total: total||0,
      needProof: needProof||false,
      payStatus:  onSite ? '현장결제예정' : '입금확인',
      ticketSent: false, checkedIn: false,
      source: '직접',
      createdAt:  now.toISOString(),
      processedAt: onSite ? null : now.toISOString(),
      note: onSite ? '현장결제 예정 (관리자 등록)' : '관리자 직권 등록',
    };

    await addReservation(reservation);
    await incrementBooked(sessionId, quantity||1);

    // 알림톡 발송: 현장결제예정이면 발송하지 않음
    if (sendAlim && phone && !onSite) {
      try {
        const perf = await getPerformance();
        const ticketUrl = generateTicketUrl(resNum, reservation, perf);
        await sendTicketAlimtalk({
          customText:   perf.tpl02     || '',
          btn1Name:     perf.tplBtn02_1 || '',
          templateCode: perf.tplCode02 || '',
          name, phone, resNum,
          session: sessionLabel,
          quantity: quantity||1,
          needProof: needProof||false,
          perfName: perf.name||'공연',
          ticketUrl,
        });
      } catch(e) { console.error('직권 등록 알림톡 오류:', e.message); }
    }

    return res.status(200).json({ success: true, resNum });
  }

  // ── 개별 리마인드 발송 ───────────────────────────────────────
  if (action === 'sendReminder') {
    const { resNum } = payload;
    const reservation = await findReservation(resNum);
    if (!reservation) return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });
    if (reservation.payStatus !== '입금확인')
      return res.status(400).json({ success: false, message: '입금확인 상태가 아닙니다.' });

    const perf = await getPerformance();
    const base = (process.env.TICKET_BASE_URL || 'https://ticket-alarm-manage.vercel.app/ticket.html').replace('/ticket.html', '');
    const ticketUrl = base + '/ticket.html?res=' + encodeURIComponent(resNum);

    try {
      await sendReminderAlimtalk({
        customText:   perf.tpl03     || '',
        btn1Name:     perf.tplBtn03_1 || '',
        templateCode: perf.tplCode03 || '',
        name:     reservation.name,
        phone:    reservation.phone,
        resNum,
        session:  reservation.session,
        perfName: perf.name || '공연',
        ticketUrl,
      });
    } catch(e) { console.error('리마인드 오류:', e.message); }

    return res.status(200).json({ success: true });
  }

  // ── 회차 전체 리마인드 발송 ──────────────────────────────────
  if (action === 'sendReminderAll') {
    const { sessionId } = payload;
    const all  = await getReservations();
    const targets = all.filter(r => r.sessionId === sessionId && r.payStatus === '입금확인');
    if (!targets.length) return res.status(200).json({ success: true, count: 0 });

    const perf = await getPerformance();
    const base = (process.env.TICKET_BASE_URL || 'https://ticket-alarm-manage.vercel.app/ticket.html').replace('/ticket.html', '');

    let count = 0;
    for (const r of targets) {
      try {
        const ticketUrl = base + '/ticket.html?res=' + encodeURIComponent(r.resNum);
        await sendReminderAlimtalk({
          customText:   perf.tpl03     || '',
          btn1Name:     perf.tplBtn03_1 || '',
          templateCode: perf.tplCode03 || '',
          name:     r.name,
          phone:    r.phone,
          resNum:   r.resNum,
          session:  r.session,
          perfName: perf.name || '공연',
          ticketUrl,
        });
        count++;
        // 발송 간격 0.5초 (솔라피 속도 제한)
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch(e) { console.error('리마인드 오류:', r.resNum, e.message); }
    }

    return res.status(200).json({ success: true, count });
  }

  // ── 결제금액 변경 ────────────────────────────────────────
  if (action === 'changePrice') {
    const { resNum, newTotal } = payload;
    const total = parseInt(newTotal);
    if (isNaN(total) || total < 0) return res.status(400).json({ success: false, message: '올바른 금액을 입력해 주세요.' });

    const reservation = await findReservation(resNum);
    if (!reservation) return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });

    const qty = reservation.quantity || 1;
    const unitPrice = Math.round(total / qty);
    await updateReservation(resNum, { total, unitPrice });
    try { await addLog({ resNum, name: reservation.name, phone: reservation.phone, type: '금액변경', result: `${reservation.total}→${total}원` }); } catch(e) {}

    return res.status(200).json({ success: true });
  }

  // ── 인원(매수) 변경 ──────────────────────────────────────
  if (action === 'changeQuantity') {
    const { resNum, newQuantity } = payload;
    const qty = parseInt(newQuantity);
    if (!qty || qty < 1) return res.status(400).json({ success: false, message: '올바른 매수를 입력해 주세요.' });

    const reservation = await findReservation(resNum);
    if (!reservation) return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });

    const diff = qty - (reservation.quantity || 0);
    if (diff > 0) {
      await incrementBooked(reservation.sessionId, diff);
    } else if (diff < 0) {
      await decrementBooked(reservation.sessionId, Math.abs(diff));
    }

    const newTotal = Math.round((reservation.unitPrice || 0) * qty);
    await updateReservation(resNum, { quantity: qty, total: newTotal, changeRequest: null });

    // 고객 변경완료 알림톡 + 변경티켓 발송
    let alimSent = false;
    if (reservation.phone) {
      try {
        const perf = await getPerformance();
        alimSent = await sendChangeCompleteAlimtalk({
          customText:   perf.tpl04      || '',
          btn1Name:     perf.tplBtn04_1 || '',
          templateCode: perf.tplCode04  || '',
          name: reservation.name, phone: reservation.phone, resNum,
          session: reservation.session, quantity: qty,
          perfName: perf.name || '공연',
        });
      } catch(e) {
        console.error('변경완료 알림 오류(인원):', e.message);
      }
    }
    try { await addLog({ resNum, name: reservation.name, phone: reservation.phone, type: '인원변경', result: `${reservation.quantity}→${qty}매 · ${reservation.phone ? (alimSent ? '성공' : '실패') : '-'}` }); } catch(e) {}

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
      changeRequest: null,
    });
    // 고객 변경완료 알림톡 + 변경티켓 발송
    let alimSentSession = false;
    if (reservation.phone) {
      try {
        const perf = await getPerformance();
        alimSentSession = await sendChangeCompleteAlimtalk({
          customText:   perf.tpl04      || '',
          btn1Name:     perf.tplBtn04_1 || '',
          templateCode: perf.tplCode04  || '',
          name: reservation.name, phone: reservation.phone, resNum,
          session: newSessionLabel, quantity: reservation.quantity,
          perfName: perf.name || '공연',
        });
      } catch(e) {
        console.error('변경완료 알림 오류(회차):', e.message);
      }
    }
    try { await addLog({ resNum, name: reservation.name, phone: reservation.phone, type: '회차변경', result: `${reservation.session}→${newSessionLabel} · ${reservation.phone ? (alimSentSession ? '성공' : '실패') : '-'}` }); } catch(e) {}

    return res.status(200).json({ success: true });
  }

  // ── 프리셋 이름 변경 + 기존 예약 ticketType 동기화 ────────
  if (action === 'syncPresetName') {
    const { oldName, newName } = payload;
    if (!oldName || !newName) return res.status(400).json({ success: false });
    const all = await getReservations();
    let count = 0;
    for (const r of all) {
      if (r.ticketType === oldName) {
        await updateReservation(r.resNum, { ticketType: newName });
        count++;
      }
    }
    return res.status(200).json({ success: true, count });
  }

  // ── 알 수 없는 권종 예약 조회 ────────────────────────────
  if (action === 'getUnknownTicketTypes') {
    const all     = await getReservations();
    const presets = await getPresets();
    const names   = new Set(presets.map(p => p.name));
    const unknown = all.filter(r => r.ticketType && !names.has(r.ticketType));
    return res.status(200).json({ success: true, reservations: unknown });
  }

  // ── 예약 권종 수동 수정 ──────────────────────────────────
  if (action === 'fixTicketType') {
    const { resNum, newTicketType } = payload;
    if (!resNum || !newTicketType) return res.status(400).json({ success: false });
    await updateReservation(resNum, { ticketType: newTicketType });
    return res.status(200).json({ success: true });
  }

  // ── 예약 삭제 (DB에서 완전 제거) ─────────────────────────
  if (action === 'deleteReservation') {
    const { resNum } = payload;
    const reservation = await findReservation(resNum);
    if (!reservation) return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });

    // 취소 상태가 아니면 삭제 거부
    if (!reservation.payStatus.includes('취소')) {
      return res.status(400).json({ success: false, message: '취소된 예약만 삭제할 수 있습니다.' });
    }
    await deleteReservation(resNum);
    return res.status(200).json({ success: true });
  }

  // ── 판매처별 배정 좌석수 저장 ────────────────────────────
  if (action === 'saveSeatAlloc') {
    await saveSeatAlloc(payload.seatAlloc || {});
    return res.status(200).json({ success: true });
  }

  // ── 전체 데이터 백업 ─────────────────────────────────────
  if (action === 'backup') {
    const [reservations, sessions, presets, performance, locks] = await Promise.all([
      getReservations(),
      getSessions(),
      getPresets(),
      getPerformance(),
      getLocks(),
    ]);
    return res.status(200).json({
      success: true,
      data: {
        exportedAt: new Date().toISOString(),
        reservations,
        sessions,
        presets,
        performance,
        locks,
      },
    });
  }

  // ── 좌석 캐시 재동기화 ───────────────────────────────────────
  if (action === 'syncSeats') {
    const [reservations, sessions] = await Promise.all([getReservations(), getSessions()]);
    await Promise.all(sessions.map(s => {
      const count = reservations
        .filter(r => r.sessionId === s.id && (r.payStatus === '입금확인' || r.payStatus === '미입금' || r.payStatus === '현장결제예정'))
        .reduce((sum, r) => sum + (r.quantity || 0), 0);
      return setBookedCount(s.id, count);
    }));
    return res.status(200).json({ success: true });
  }

  // ── 새 공연 초기화 ────────────────────────────────────────
  if (action === 'resetPerformance') {
    const { keepPresets = true, keepPerformance = true } = payload;

    // 현재 회차 ID 목록 확보 (seats:* 키 삭제용)
    const sessions = await getSessions();
    const sessionIds = sessions.map(s => s.id);

    await Promise.all([
      clearReservations(),
      clearSessions(),
      clearLocks(),
      clearSeatsForSessions(sessionIds),
    ]);

    if (!keepPresets)     await savePresets([]);
    if (!keepPerformance) await savePerformance({
      name: '', agency: '', tel: '', email: '',
      subtitle: '', host: '', organizer: '', sponsor: '',
      open: 'open', maxQty: 4,
      account: '', accountHolder: '',
      kakaopayLink: '',
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

  if (action === 'updatePhone') {
    const { resNum, phone } = payload;
    const reservation = await findReservation(resNum);
    if (!reservation) return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });
    await updateReservation(resNum, { phone: phone || '' });
    try { await addLog({ resNum, name: reservation.name, phone: reservation.phone, type: '연락처변경', result: `${reservation.phone||'-'}→${phone||'-'}` }); } catch(e) {}
    return res.status(200).json({ success: true });
  }

  if (action === 'getLogs') {
    const logs = await getLogs();
    return res.status(200).json({ success: true, logs });
  }

  return res.status(400).json({ error: 'unknown action' });
}

// ── 티켓 URL 생성 ─────────────────────────────────────────

function generateTicketUrl(resNum, r, perf) {
  // 버튼 URL 300자 제한으로 예약번호만 파라미터로 전달
  const base = (process.env.TICKET_BASE_URL || '').replace('/ticket.html', '');
  return `${base}/ticket.html?res=${encodeURIComponent(resNum)}`;
}
