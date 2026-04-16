// api/cron-reminder.js — 공연 당일 리마인드 자동 발송 (직접 예약자만)
// Vercel Cron: 매일 09:00 KST (00:00 UTC)
// vercel.json → "crons": [{ "path": "/api/cron-reminder", "schedule": "0 0 * * *" }]

import { getSessions, getReservations, getPerformance, addLog } from '../lib/db.js';
import { sendReminderAlimtalk } from '../lib/alimtalk.js';

export default async function handler(req, res) {
  // Vercel Cron 인증 (CRON_SECRET 환경변수)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: '인증 실패' });
  }

  // 오늘 날짜 (KST = UTC+9)
  const kstNow   = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayKST = kstNow.toISOString().slice(0, 10); // YYYY-MM-DD

  const [sessions, reservations, perf] = await Promise.all([
    getSessions(),
    getReservations(),
    getPerformance(),
  ]);

  // 오늘 공연 회차만 필터
  const todaySessions = sessions.filter(s => s.date === todayKST);

  if (todaySessions.length === 0) {
    console.log('[CRON-REMINDER] 오늘 공연 없음:', todayKST);
    return res.status(200).json({ success: true, message: '오늘 공연 없음', sent: 0, date: todayKST });
  }

  const base = (process.env.TICKET_BASE_URL || '').replace('/ticket.html', '');
  let sent = 0, failed = 0;

  for (const session of todaySessions) {
    // 직접 예약 + 입금확인 상태만 대상
    const targets = reservations.filter(r =>
      r.sessionId === session.id &&
      r.payStatus === '입금확인' &&
      r.source    === '직접'
    );

    console.log(`[CRON-REMINDER] 회차: ${session.id} (${session.date}) — 대상 ${targets.length}명`);

    for (const r of targets) {
      try {
        const ticketUrl = `${base}/ticket.html?res=${encodeURIComponent(r.resNum)}`;
        const ok = await sendReminderAlimtalk({
          customText:   perf.tpl03      || '',
          btn1Name:     perf.tplBtn03_1 || '',
          templateCode: perf.tplCode03  || '',
          name:     r.name,
          phone:    r.phone,
          resNum:   r.resNum,
          session:  r.session,
          perfName: perf.name || '공연',
          ticketUrl,
        });

        if (ok) {
          sent++;
          await addLog({ resNum: r.resNum, name: r.name, phone: r.phone, type: '당일리마인드(자동)', result: '성공' });
        } else {
          failed++;
          await addLog({ resNum: r.resNum, name: r.name, phone: r.phone, type: '당일리마인드(자동)', result: '실패' });
        }

        // 솔라피 속도 제한 대응
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (e) {
        console.error('[CRON-REMINDER] 발송 오류:', r.resNum, e.message);
        failed++;
      }
    }
  }

  console.log(`[CRON-REMINDER] 완료 — 성공 ${sent}건, 실패 ${failed}건`);
  return res.status(200).json({ success: true, sent, failed, date: todayKST });
}
