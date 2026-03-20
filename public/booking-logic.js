// ============================================================
// 예매 페이지 선점 로직 패치
// index.html의 <script> 내용을 아래로 교체
// ============================================================

// ── 전역 상태 ────────────────────────────────────────────────
let selectedSession = null;
let currentLockId   = null;
let lockTimer       = null;
let lockExpiresAt   = null;
let timerInterval   = null;
let CONFIG          = { sessions: [], presets: [], performance: {}, account: '', accountHolder: '' };

// ── 초기화 ───────────────────────────────────────────────────
async function init() {
  try {
    const res  = await fetch('/api/config');
    const data = await res.json();
    CONFIG = data;
    renderSessions();
    renderTicketTypes();
    updatePrice();
  } catch(e) {
    alert('서버 연결 오류. 잠시 후 다시 시도해 주세요.');
  }
}

// ── 회차 렌더 ────────────────────────────────────────────────
function renderSessions() {
  const grid = document.getElementById('session-grid');
  grid.innerHTML = CONFIG.sessions.map(s => {
    const isSoldOut = s.remain === 0 || s.status !== 'open' || s.timeClosed;
    const isLow     = !isSoldOut && s.remain <= 3;
    const isTimeClosed = s.timeClosed;
    const isAnyClose = isSoldOut || isTimeClosed;

    // 마감 전 남은 시간 계산
    let closingLabel = '';
    if (!isAnyClose && s.closesAt) {
      const minsLeft = Math.floor((s.closesAt - Date.now()) / 60000);
      if (minsLeft <= 60 && minsLeft > 0) closingLabel = ` (분 후 마감)`;
    }

    const remainText = isAnyClose
      ? (isTimeClosed ? '예매 마감' : '매진')
      : isLow ? `마감임박 ${s.remain}석${closingLabel}`
      : `잔여 ${s.remain}석${closingLabel}`;
    const remainClass = isAnyClose ? 'sold' : isLow ? 'low' : '';
    const d    = new Date(s.date + 'T00:00:00');
    const days = ['일','월','화','수','목','금','토'];
    const dateLabel = `${d.getMonth()+1}월 ${d.getDate()}일 (${days[d.getDay()]})`;

    return `
    <div class="session-card${isSoldOut ? ' sold-out' : ''}"
         onclick="${isSoldOut ? '' : `selectSession('${s.id}')`}"
         id="session-${s.id}">
      <div class="session-info">
        <div class="session-date">${dateLabel}</div>
        <div class="session-time">${s.time}</div>
      </div>
      <div class="session-right">
        <div class="session-remain ${remainClass}">${remainText}</div>
        <div class="check-icon">
          <svg viewBox="0 0 10 10" fill="none" stroke="#0f0f0f" stroke-width="1.5" stroke-linecap="round">
            <path d="M2 5l2.5 2.5 4-4"/>
          </svg>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderTicketTypes() {
  const sel = document.getElementById('ticket-type');
  sel.innerHTML = CONFIG.presets.map(p =>
    `<option value="${p.name}">${p.name} — ${p.price === 0 ? '무료' : p.price.toLocaleString() + '원'}</option>`
  ).join('');
}

// ── 회차 선택 → 선점 요청 ────────────────────────────────────
async function selectSession(id) {
  // 이전 선점 해제
  if (currentLockId) await releaseLock();

  selectedSession = id;
  document.querySelectorAll('.session-card').forEach(el => el.classList.remove('selected'));
  document.getElementById(`session-${id}`).classList.add('selected');
  document.getElementById('err-session').classList.remove('show');

  // 수량 먼저 읽기
  const qty = parseInt(document.getElementById('quantity').value) || 1;
  await requestLock(id, qty);
}

// 수량 변경 시 선점 갱신
async function onQuantityChange() {
  updatePrice();
  if (selectedSession) {
    if (currentLockId) await releaseLock();
    const qty = parseInt(document.getElementById('quantity').value) || 1;
    await requestLock(selectedSession, qty);
  }
}

async function requestLock(sessionId, quantity) {
  try {
    const res  = await fetch('/api/lock', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sessionId, quantity }),
    });
    const data = await res.json();

    if (!data.success) {
      showLockError(data.message);
      selectedSession = null;
      document.getElementById(`session-${sessionId}`).classList.remove('selected');
      return;
    }

    currentLockId = data.lockId;
    lockExpiresAt = data.expiresAt;
    startTimer(data.expiresIn);
    showTimerBanner();

    document.getElementById('dot2').classList.add('active');

  } catch(e) {
    console.error('선점 오류:', e);
  }
}

async function releaseLock() {
  if (!currentLockId) return;
  clearInterval(timerInterval);
  try {
    await fetch('/api/lock', {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ lockId: currentLockId }),
    });
  } catch(e) {}
  currentLockId = null;
  hideTimerBanner();
}

// ── 타이머 UI ────────────────────────────────────────────────
function startTimer(durationMs) {
  clearInterval(timerInterval);
  const endAt = Date.now() + durationMs;

  timerInterval = setInterval(() => {
    const remaining = endAt - Date.now();
    if (remaining <= 0) {
      clearInterval(timerInterval);
      onLockExpired();
      return;
    }
    const min = String(Math.floor(remaining / 60000)).padStart(2,'0');
    const sec = String(Math.floor((remaining % 60000) / 1000)).padStart(2,'0');
    const el  = document.getElementById('timer-text');
    if (el) el.textContent = `${min}:${sec}`;

    // 3분 이하 경고 색상
    const banner = document.getElementById('timer-banner');
    if (banner && remaining < 180000) banner.classList.add('urgent');
  }, 1000);
}

function showTimerBanner() {
  let banner = document.getElementById('timer-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'timer-banner';
    banner.innerHTML = `
      <span id="timer-icon">⏱</span>
      <span id="timer-text">10:00</span>
      <span id="timer-label"> 안에 예매를 완료해 주세요</span>`;
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0;
      background: #1a1a0f; border-bottom: 1px solid #c9a84c;
      color: #c9a84c; font-size: 13px; letter-spacing: 0.1em;
      padding: 12px; text-align: center; z-index: 999;
      transition: background 0.3s;`;
    document.body.prepend(banner);
    document.body.style.paddingTop = '44px';
  }
  banner.style.display = 'block';
}

function hideTimerBanner() {
  const banner = document.getElementById('timer-banner');
  if (banner) { banner.style.display = 'none'; banner.classList.remove('urgent'); }
  document.body.style.paddingTop = '0';
}

function showLockError(msg) {
  const el = document.getElementById('err-session');
  el.textContent = msg || '선점에 실패했습니다.';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}

function onLockExpired() {
  currentLockId   = null;
  selectedSession = null;
  hideTimerBanner();
  document.querySelectorAll('.session-card').forEach(el => el.classList.remove('selected'));
  alert('선점 시간(10분)이 초과되었습니다.\n회차를 다시 선택해 주세요.');
  // 잔여석 새로고침
  fetch('/api/config').then(r => r.json()).then(data => {
    CONFIG = data;
    renderSessions();
  });
}

// ── 가격 계산 ────────────────────────────────────────────────
function updatePrice() {
  const typeName = document.getElementById('ticket-type').value;
  const qty      = parseInt(document.getElementById('quantity').value);
  const preset   = CONFIG.presets.find(p => p.name === typeName);
  if (!preset) return;

  const total = preset.price * qty;
  document.getElementById('price-type-label').textContent   = preset.name;
  document.getElementById('price-unit-display').textContent = preset.price === 0 ? '무료' : preset.price.toLocaleString() + '원';
  document.getElementById('price-qty-display').textContent  = qty + '매';
  document.getElementById('price-total').textContent        = total === 0 ? '무료' : total.toLocaleString() + '원';
  document.getElementById('deadline-amount').textContent    = total === 0 ? '무료 (입금 불필요)' : total.toLocaleString() + '원';

  document.getElementById('proof-notice').style.display = preset.needProof ? 'flex' : 'none';
}

// ── 전화번호 포맷 ─────────────────────────────────────────────
function formatPhone(input) {
  let val = input.value.replace(/\D/g,'');
  if (val.length > 11) val = val.slice(0,11);
  if (val.length >= 8) val = val.slice(0,3)+'-'+val.slice(3,7)+'-'+val.slice(7);
  else if (val.length >= 4) val = val.slice(0,3)+'-'+val.slice(3);
  input.value = val;
}

function copyAccount() {
  const acc = CONFIG.account || '';
  navigator.clipboard.writeText(acc).then(() => {
    const btn = document.querySelector('.copy-btn');
    if (btn) { btn.textContent = '복사됨'; setTimeout(() => btn.textContent = '복사', 1500); }
  });
}

// ── 유효성 검사 ───────────────────────────────────────────────
function validate() {
  let valid = true;

  if (!selectedSession || !currentLockId) {
    const el = document.getElementById('err-session');
    el.textContent = '회차를 선택해 주세요.';
    el.classList.add('show');
    valid = false;
  }

  const name = document.getElementById('name').value.trim();
  const nameErr = document.getElementById('err-name');
  if (!name) { nameErr.classList.add('show'); document.getElementById('name').classList.add('error'); valid = false; }
  else { nameErr.classList.remove('show'); document.getElementById('name').classList.remove('error'); }

  const phone = document.getElementById('phone').value.replace(/-/g,'');
  const phoneErr = document.getElementById('err-phone');
  if (!/^01[0-9]{8,9}$/.test(phone)) { phoneErr.classList.add('show'); document.getElementById('phone').classList.add('error'); valid = false; }
  else { phoneErr.classList.remove('show'); document.getElementById('phone').classList.remove('error'); }

  const email = document.getElementById('email').value.trim();
  const emailErr = document.getElementById('err-email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { emailErr.classList.add('show'); document.getElementById('email').classList.add('error'); valid = false; }
  else { emailErr.classList.remove('show'); document.getElementById('email').classList.remove('error'); }

  return valid;
}

// ── 예매 제출 ────────────────────────────────────────────────
async function submitBooking() {
  if (!validate()) return;

  const typeName = document.getElementById('ticket-type').value;
  const qty      = parseInt(document.getElementById('quantity').value);
  const preset   = CONFIG.presets.find(p => p.name === typeName);
  const session  = CONFIG.sessions.find(s => s.id === selectedSession);
  const total    = preset.price * qty;

  const d    = new Date(session.date + 'T00:00:00');
  const days = ['일','월','화','수','목','금','토'];
  const sessionLabel = `${d.getMonth()+1}월 ${d.getDate()}일 (${days[d.getDay()]}) ${session.time}`;

  document.getElementById('booking-form').style.display = 'none';
  document.getElementById('loading').classList.add('show');
  clearInterval(timerInterval);

  try {
    const res = await fetch('/api/reserve', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lockId:       currentLockId,
        name:         document.getElementById('name').value.trim(),
        phone:        document.getElementById('phone').value.trim(),
        email:        document.getElementById('email').value.trim(),
        sessionId:    selectedSession,
        sessionLabel,
        ticketType:   typeName,
        quantity:     qty,
        unitPrice:    preset.price,
        total,
        needProof:    preset.needProof,
      }),
    });

    const result = await res.json();
    document.getElementById('loading').classList.remove('show');

    if (result.success) {
      currentLockId = null;
      hideTimerBanner();
      showSuccess(result.resNum, total, sessionLabel);
    } else {
      document.getElementById('booking-form').style.display = 'block';
      alert(result.message || '예매 중 오류가 발생했습니다.');
      if (result.message && result.message.includes('선점')) {
        selectedSession = null;
        renderSessions();
      }
    }
  } catch(e) {
    document.getElementById('loading').classList.remove('show');
    document.getElementById('booking-form').style.display = 'block';
    alert('네트워크 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

function showSuccess(resNum, total, sessionLabel) {
  const deadline = new Date(Date.now() + 24*3600*1000);
  const deadlineStr = deadline.toLocaleDateString('ko-KR', { month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' });
  const perf = CONFIG.performance;

  document.getElementById('dot3').classList.add('active');
  document.getElementById('success-res-num').textContent = resNum;
  document.getElementById('s-account').textContent      = (perf.account || '').replace(/^[^\s]+ /, '');
  document.getElementById('s-amount').textContent       = total === 0 ? '무료' : total.toLocaleString() + '원';
  document.getElementById('s-deadline').textContent     = deadlineStr + ' 까지';
  document.getElementById('success-screen').classList.add('show');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 페이지 이탈 시 선점 해제
window.addEventListener('beforeunload', () => { if (currentLockId) releaseLock(); });

init();
