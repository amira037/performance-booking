// api/roster-import.js — 네이버/인터파크 파싱 결과를 Redis에 upsert
// POST /api/roster-import  { rows: [...] }
// rows 필드: { id, show_id, name, phone, type, qty, amount, source, cancelled }

import { getReservations, saveReservations, getSessions } from '../lib/db.js';

const ADMIN_KEY = process.env.ADMIN_KEY || 'bluebline2025';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_KEY)
    return res.status(401).json({ error: '인증 실패' });

  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'rows 배열이 필요합니다' });

  const [reservations, sessions] = await Promise.all([
    getReservations(),
    getSessions(),
  ]);

  // session id → label 역매핑
  const sessionLabelMap = Object.fromEntries(sessions.map(s => [s.id, s.label || '']));

  const list = [...reservations];
  let added = 0, updated = 0, cancelled = 0, skipped = 0;

  for (const row of rows) {
    const {
      id: resNum,
      show_id: sessionId,
      name,
      phone,
      type: ticketType,
      qty: quantity,
      amount: total,
      source,
      cancelled: isCancelled,
    } = row;

    if (!resNum || !name) { skipped++; continue; }

    const existingIdx = list.findIndex(r => r.resNum === resNum);

    if (existingIdx >= 0) {
      const existing = list[existingIdx];
      const updates  = { ...existing };
      let changed = false;

      // 취소 처리
      if (isCancelled && existing.payStatus !== '관리자취소') {
        updates.payStatus = '관리자취소';
        changed = true;
        cancelled++;
      }
      // qty / amount / type 변경 감지
      if (quantity && existing.quantity !== quantity)                   { updates.quantity = quantity; changed = true; }
      if (total !== undefined && existing.total !== total)              { updates.total = total; changed = true; }
      if (ticketType && existing.ticketType !== ticketType)             { updates.ticketType = ticketType; changed = true; }
      if (source && !existing.source)                                   { updates.source = source; changed = true; }

      if (changed) {
        list[existingIdx] = updates;
        if (!isCancelled) updated++;
      } else {
        skipped++;
      }
    } else {
      // 신규 추가
      if (!sessionId) { skipped++; continue; }

      const sessionLabel = sessionLabelMap[sessionId] || '';
      const now = new Date().toISOString();
      const unitPrice = (quantity > 0) ? Math.round((total || 0) / quantity) : 0;

      list.push({
        resNum,
        name,
        phone:       phone || '-',
        email:       '',
        sessionId,
        session:     sessionLabel,
        ticketType:  ticketType || '일반',
        quantity:    quantity   || 1,
        unitPrice,
        total:       total      || 0,
        needProof:   false,
        payStatus:   isCancelled ? '관리자취소' : '입금확인',
        ticketSent:  false,
        checkedIn:   false,
        checkedInAt: null,
        createdAt:   now,
        source:      source || '직접',
      });

      if (isCancelled) cancelled++; else added++;
    }
  }

  await saveReservations(list);
  return res.status(200).json({ success: true, added, updated, cancelled, skipped });
}
