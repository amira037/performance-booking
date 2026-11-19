// lib/booking-status.js — 공연 전체 예매 상태 판단 (자동 오픈 포함)
//
// 예매 페이지(api/config), 서버 예약 처리(api/lock, api/reserve),
// 홈페이지 목록(api/now-showing)이 모두 이 함수 하나로 "지금 열렸나"를 판단한다.
// ※ public/admin.html 의 perfBookingStatus()는 이 파일과 같은 규칙의 복사본이다. 바꿀 때 함께 바꿀 것.
//
// performance.open   : 'open' | 'soon' | 'closed'  (관리자가 고른 값)
// performance.openAt : 'YYYY-MM-DDTHH:mm' (한국 시간) — 'soon'일 때 이 시각이 되면 자동으로 'open'

// 'YYYY-MM-DDTHH:mm' (KST) → epoch ms. 형식이 틀리면 null
export function kstTs(dateTime) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(String(dateTime || ''));
  if (!m) return null;
  const t = new Date(`${m[1]}T${m[2]}:${m[3]}:00+09:00`).getTime();
  return Number.isNaN(t) ? null : t;
}

// 지금 관객 기준 공연 전체 예매 상태
export function perfBookingStatus(perf, { archived = false, now = Date.now() } = {}) {
  if (archived || !perf || perf.open === 'closed') return 'closed';
  if (perf.open === 'soon') {
    const t = kstTs(perf.openAt);
    return t !== null && now >= t ? 'open' : 'soon';
  }
  return 'open';
}

export const STATUS_MESSAGE = {
  soon:   '아직 예매가 오픈되지 않았습니다.',
  closed: '예매가 마감되었습니다.',
};
