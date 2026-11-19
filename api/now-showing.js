// api/now-showing.js — 홈페이지용 "지금 공연 중" 공개 목록
// GET /api/now-showing
//
// 보관(archived)되지 않았고, 오늘 이후 회차가 남아 있는 공연만 돌려준다.
// 예약자 정보 등 민감한 데이터는 포함하지 않는다.

import { perfDb, listPerformances } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const todayStr = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }))
    .toISOString().slice(0, 10);
  const base = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;

  try {
    const list = (await listPerformances()).filter(p => !p.archived);

    const items = await Promise.all(list.map(async p => {
      const db = perfDb(p.id);
      const [performance, sessions] = await Promise.all([db.getPerformance(), db.getSessions()]);
      const upcoming = (sessions || [])
        .filter(s => s.date && s.date >= todayStr)
        .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
      if (!upcoming.length) return null;

      const allDates = (sessions || []).map(s => s.date).filter(Boolean).sort();
      // 예매 상태: open(예매 중) / soon(오픈 예정) / closed(마감) — 홈페이지 배지·버튼이 씀
      const status = performance.open === 'closed' ? 'closed'
        : performance.open === 'soon' ? 'soon'
        : upcoming.some(s => s.status === 'open') ? 'open'
        : upcoming.some(s => s.status === 'soon') ? 'soon'
        : 'closed';
      return {
        id:          p.id,
        name:        performance.name || p.name,
        subtitle:    performance.subtitle || '',
        posterUrl:   performance.posterUrl || '',
        firstDate:   allDates[0],
        lastDate:    allDates[allDates.length - 1],
        nextDate:    upcoming[0].date,
        status,
        bookingOpen: status === 'open',
        bookingUrl:  `${base}/?p=${encodeURIComponent(p.id)}`,
      };
    }));

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      items: items.filter(Boolean).sort((a, b) => a.nextDate.localeCompare(b.nextDate)),
    });
  } catch (e) {
    console.error('[now-showing]', e);
    return res.status(500).json({ items: [], error: '목록을 불러오지 못했습니다.' });
  }
}
