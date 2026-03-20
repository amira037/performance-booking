// api/export.js — 예약 데이터 CSV/Excel 내보내기
// GET /api/export?format=csv

import { getReservations } from '../lib/db.js';

export default async function handler(req, res) {
  // 관리자 인증
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== (process.env.ADMIN_KEY || 'bluebline2025'))
    return res.status(401).json({ error: '인증 실패' });

  if (req.method !== 'GET') return res.status(405).end();

  const reservations = await getReservations();

  // CSV 생성
  const headers = [
    '예약번호','이름','연락처','이메일',
    '회차','예매유형','매수','단가','결제금액',
    '입금상태','증빙확인','티켓발송','입장여부',
    '예약일시','처리일시','입장일시',
  ];

  const rows = reservations.map(r => [
    r.resNum,
    r.name,
    r.phone,
    r.email,
    r.session,
    r.ticketType,
    r.quantity,
    r.unitPrice,
    r.total,
    r.payStatus,
    r.needProof ? '확인필요' : '',
    r.ticketSent ? '발송완료' : '미발송',
    r.checkedIn ? '입장완료' : '',
    r.createdAt   ? new Date(r.createdAt).toLocaleString('ko-KR')   : '',
    r.processedAt ? new Date(r.processedAt).toLocaleString('ko-KR') : '',
    r.checkedInAt ? new Date(r.checkedInAt).toLocaleString('ko-KR') : '',
  ]);

  const csvContent = [headers, ...rows]
    .map(row => row.map(cell => {
      const val = cell === null || cell === undefined ? '' : String(cell);
      // 쉼표/줄바꿈 포함 시 따옴표로 감싸기
      return val.includes(',') || val.includes('\n') ? `"${val.replace(/"/g, '""')}"` : val;
    }).join(','))
    .join('\n');

  // BOM 추가 (한글 엑셀 호환)
  const bom = '\uFEFF';
  const csv = bom + csvContent;

  // 파일명에 날짜 포함
  const date     = new Date().toLocaleDateString('ko-KR').replace(/\. /g,'-').replace('.','');
  const filename = encodeURIComponent(`예약목록_${date}.csv`);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  return res.status(200).send(csv);
}
