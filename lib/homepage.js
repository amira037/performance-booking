// lib/homepage.js — 극단 아리랑 홈페이지(arirangv.com)에 같은 공연이 있으면 그 상세 페이지 주소를 찾는다.
// 홈페이지의 /now-map.json(최근 공연 목록: 제목·기간·주소)을 읽어 제목이나 기간으로 맞춰 본다.
// 홈페이지 쪽 같은 규칙: 극단 아리랑 홈페이지 website/src/lib/booking.ts

const MAP_URL = process.env.HOMEPAGE_MAP_URL || 'https://arirangv.com/now-map.json';
let cache = { at: 0, data: null };

async function loadMap() {
  if (cache.data && Date.now() - cache.at < 10 * 60 * 1000) return cache.data;
  try {
    const r = await fetch(MAP_URL, { signal: AbortSignal.timeout(2500) });
    if (r.ok) cache = { at: Date.now(), data: await r.json() };
  } catch (e) {
    console.warn('[homepage] 공연 목록을 못 불러옴:', e.message);
  }
  return cache.data || [];
}

// 띄어쓰기·괄호·연도·'극단 아리랑'·'기념' 같은 말을 빼고 비교
const matchKey = s => String(s || '').normalize('NFC')
  .replace(/(19|20)\d\d(년)?/g, '')
  .replace(/극단\s*아리랑|창작\s*신작|낭독\s*공연|기념/g, '')
  .replace(/[\s<>\[\]()!?·.,'"‘’“”「」『』〈〉《》:\-~]/g, '')
  .toLowerCase();

function sameShow(a, b) {
  const x = matchKey(a), y = matchKey(b);
  if (x.length < 2 || y.length < 2) return false;
  if (x === y) return true;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  return s.length >= 3 && s.length * 2 >= l.length && l.includes(s);
}

// 기간이 겹치고 시작일이나 끝나는 날이 같으면 이름이 달라도 같은 공연
function sameDates(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !bStart) return false;
  aEnd ||= aStart; bEnd ||= bStart;
  return aStart <= bEnd && bStart <= aEnd && (aStart === bStart || aEnd === bEnd);
}

/**
 * @param {string} pid       예매 시스템 공연 ID
 * @param {string} name      예매 시스템 공연 이름
 * @param {Array}  sessions  회차 목록 (date: 'YYYY-MM-DD')
 * @returns {Promise<string>} 홈페이지 공연 상세 주소, 없으면 ''
 */
export async function homepageUrlFor(pid, name, sessions) {
  const map = await loadMap();
  if (!map.length) return '';
  const dates = (sessions || []).map(s => s.date).filter(Boolean).sort();
  const first = dates[0], last = dates[dates.length - 1];
  const hit = map.find(m => m.booking_id && m.booking_id === pid)
    ?? map.find(m => !m.booking_id && sameDates(m.start, m.end, first, last))
    ?? map.find(m => !m.booking_id && sameShow(m.title, name)
                     && (!m.year || !first || m.year >= Number(first.slice(0, 4)) - 1));
  return hit?.url || '';
}
