// lib/alimtalk.js — 솔라피 카카오 알림톡 발송

import crypto from 'crypto';

const SOLAPI_API_KEY    = process.env.SOLAPI_API_KEY;
const SOLAPI_API_SECRET = process.env.SOLAPI_API_SECRET;
const SENDER_PHONE      = process.env.SENDER_PHONE;
const KAKAO_CHANNEL_ID  = process.env.KAKAO_CHANNEL_ID;
const KAKAO_CHAT_URL    = process.env.KAKAO_CHAT_URL || 'https://pf.kakao.com/_xlUqEX/chat';

// 템플릿 코드 — Vercel 환경변수에서 관리
const TPL_RESERVE  = process.env.ALIMTALK_TEMPLATE_RESERVE  || 'TEMPLATE_01';
const TPL_TICKET   = process.env.ALIMTALK_TEMPLATE_TICKET   || 'TEMPLATE_02';
const TPL_REMINDER = process.env.ALIMTALK_TEMPLATE_REMINDER || 'TEMPLATE_03';
const TPL_CANCEL   = process.env.ALIMTALK_TEMPLATE_CANCEL   || 'TEMPLATE_CANCEL';

function generateSignature(timestamp) {
  const salt = Math.random().toString(36).substring(2);
  const msg  = timestamp + salt;
  const sig  = crypto.createHmac('sha256', SOLAPI_API_SECRET).update(msg).digest('hex');
  return { salt, signature: sig };
}

// 버튼 포함 알림톡 발송
async function sendAlimtalk(to, text, templateCode, buttons = []) {
  console.log('[ALIMTALK DEBUG] ===== 발송 시도 =====');
  console.log('[ALIMTALK DEBUG] 수신번호:', to);
  console.log('[ALIMTALK DEBUG] 템플릿코드:', templateCode);
  console.log('[ALIMTALK DEBUG] API_KEY:', SOLAPI_API_KEY ? SOLAPI_API_KEY.slice(0,8)+'...' : '❌ 없음');
  console.log('[ALIMTALK DEBUG] API_SECRET:', SOLAPI_API_SECRET ? '✅ 있음' : '❌ 없음');
  console.log('[ALIMTALK DEBUG] SENDER_PHONE:', SENDER_PHONE || '❌ 없음');
  console.log('[ALIMTALK DEBUG] CHANNEL_ID:', KAKAO_CHANNEL_ID || '❌ 없음');
  console.log('[ALIMTALK DEBUG] 버튼수:', buttons.length);

  try {
    const timestamp = new Date().toISOString();
    const { salt, signature } = generateSignature(timestamp);

    const kakaoOptions = {
      pfId:       KAKAO_CHANNEL_ID,
      templateId: templateCode,
    };
    if (buttons.length > 0) kakaoOptions.buttons = buttons;

    const requestBody = {
      message: {
        to: to.replace(/-/g, ''),
        from: SENDER_PHONE,
        text,
        type: 'ATA',
        kakaoOptions,
      },
    };

    console.log('[ALIMTALK DEBUG] 요청 body:', JSON.stringify(requestBody, null, 2));

    const res = await fetch('https://api.solapi.com/messages/v4/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `HMAC-SHA256 apiKey=${SOLAPI_API_KEY}, date=${timestamp}, salt=${salt}, signature=${signature}`,
      },
      body: JSON.stringify(requestBody),
    });

    const result = await res.json();
    console.log('[ALIMTALK DEBUG] 솔라피 응답:', JSON.stringify(result, null, 2));

    if (result.errorCode) {
      console.error('[ALIMTALK DEBUG] ❌ 오류코드:', result.errorCode);
      console.error('[ALIMTALK DEBUG] ❌ 오류메시지:', result.errorMessage);
      return false;
    }
    console.log('[ALIMTALK DEBUG] ✅ 발송 성공');
    return true;
  } catch(e) {
    console.error('[ALIMTALK DEBUG] ❌ 예외 발생:', e.message);
    console.error('[ALIMTALK DEBUG] 스택:', e.stack);
    return false;
  }
}

// ============================================================
// 템플릿 1 — 예약 접수 + 입금 안내
// ============================================================
export async function sendReservationAlimtalk({
  name, phone, resNum, session, ticketType, quantity,
  total, perfName, account, accountHolder, kakaopayLink, cancelUrl, customText,
  btn1Name, btn2Name, templateCode,
}) {
  const isFree    = total === 0;
  const amountStr = isFree ? '무료' : Number(total).toLocaleString() + '원';

  let text = '';
  if (customText) {
    // admin에서 편집한 커스텀 템플릿 사용 — 변수 치환
    text = customText
      .replace(/#{공연명}/g,     perfName)
      .replace(/#{예약번호}/g,   resNum)
      .replace(/#{이름}/g,       name)
      .replace(/#{회차}/g,       session)
      .replace(/#{예매유형}/g,   ticketType)
      .replace(/#{매수}/g,       String(quantity))
      .replace(/#{결제금액}/g,   amountStr)
      .replace(/#{계좌번호}/g,   account)
      .replace(/#{예금주}/g,     accountHolder)
      .replace(/#{카카오페이링크}/g, kakaopayLink || '');
  } else {
    // 기본 템플릿
    let paymentBlock = '';
    if (isFree) {
      paymentBlock = '본 티켓은 무료입니다. 별도 입금이 필요하지 않습니다.';
    } else {
      paymentBlock = '[방법 1] 계좌이체\n' + account + '\n예금주: ' + accountHolder;
      if (kakaopayLink) {
        paymentBlock += '\n\n[방법 2] 카카오페이 송금\n' + kakaopayLink + '\n송금 시 ' + amountStr + '을 입력해 주세요.';
      }
    }
    text = `[${perfName}] 예약이 접수되었습니다.

■ 예약번호: ${resNum}
■ 예매자: ${name}
■ 회차: ${session}
■ 유형: ${ticketType} × ${quantity}매
■ 결제금액: ${amountStr}

${paymentBlock}${isFree ? '' : `
입금기한: 예약 후 24시간 이내
입금 확인 후 모바일 티켓이 발송됩니다.
미입금 시 예약이 자동 취소됩니다.`}`;
  }

  const buttons = [];
  if (!isFree) {
    buttons.push({
      buttonName: btn1Name || '입금완료알리기',
      buttonType: 'WL',
      linkMo: KAKAO_CHAT_URL,
      linkPc: KAKAO_CHAT_URL,
    });
  }
  if (cancelUrl) {
    buttons.push({
      buttonName: btn2Name || '예매변경/취소신청',
      buttonType: 'WL',
      linkMo: cancelUrl,
      linkPc: cancelUrl,
    });
  }

  return sendAlimtalk(phone, text, templateCode || TPL_RESERVE, buttons);
}

// ============================================================
// 템플릿 2 — 입금 확인 + 티켓 발송
// ============================================================
export async function sendTicketAlimtalk({
  name, phone, resNum, session, quantity, needProof, perfName, ticketUrl, customText, btn1Name, templateCode,
}) {
  console.log('[TICKET DEBUG] sendTicketAlimtalk 호출됨');
  console.log('[TICKET DEBUG] phone:', phone || '❌ 없음');
  console.log('[TICKET DEBUG] resNum:', resNum);
  console.log('[TICKET DEBUG] ticketUrl:', ticketUrl ? '✅ 있음' : '❌ 없음');

  const proofNote = needProof ? '\n⚠️ 입장 시 할인 증빙 서류를 지참해 주세요.' : '';
  let text = '';
  if (customText) {
    text = customText
      .replace(/#{공연명}/g,   perfName)
      .replace(/#{예약번호}/g, resNum)
      .replace(/#{이름}/g,     name)
      .replace(/#{회차}/g,     session)
      .replace(/#{매수}/g,     String(quantity))
      .replace(/#{티켓링크}/g, ticketUrl);
    if (needProof) text += proofNote;
  } else {
    text = `[${perfName}] 입금이 확인되었습니다.

■ 예약번호: ${resNum}
■ 예매자: ${name}
■ 회차: ${session}
■ 매수: ${quantity}매${proofNote}

모바일 티켓:
${ticketUrl}

공연 30분 전까지 입장해 주세요.`;
  }

  const baseUrl = (process.env.TICKET_BASE_URL || 'https://ticket-alarm-manage.vercel.app/ticket.html').replace('/ticket.html', '');
  const btnUrl  = baseUrl + '/ticket.html?res=' + encodeURIComponent(resNum);

  const buttons = [{
    buttonName: btn1Name || '모바일티켓',
    buttonType: 'WL',
    linkMo: btnUrl,
    linkPc: btnUrl,
  }];

  return sendAlimtalk(phone, text, templateCode || TPL_TICKET, buttons);
}

// ============================================================
// 템플릿 3 — 공연 당일 리마인드
// ============================================================
export async function sendReminderAlimtalk({
  name, phone, resNum, session, perfName, ticketUrl, customText, btn1Name, templateCode,
}) {
  let text = '';
  if (customText) {
    text = customText
      .replace(/#{공연명}/g,   perfName)
      .replace(/#{이름}/g,     name)
      .replace(/#{회차}/g,     session)
      .replace(/#{예약번호}/g, resNum);
  } else {
    text = `[${perfName}] 오늘 공연 안내입니다.

■ 예매자: ${name}
■ 회차: ${session}
■ 예약번호: ${resNum}

공연 30분 전까지 입장해 주세요.
모바일 티켓을 미리 준비해 주세요.`;
  }

  const baseUrl = (process.env.TICKET_BASE_URL || 'https://ticket-alarm-manage.vercel.app/ticket.html').replace('/ticket.html', '');
  const btnUrl  = baseUrl + '/ticket.html?res=' + encodeURIComponent(resNum);

  const buttons = [{
    buttonName: btn1Name || '모바일티켓',
    buttonType: 'WL',
    linkMo: btnUrl,
    linkPc: btnUrl,
  }];

  return sendAlimtalk(phone, text, templateCode || TPL_REMINDER, buttons);
}

// ============================================================
// 취소 신청 — 관리자에게 발송
// ============================================================
export async function sendCancelRequestAlimtalk({
  adminPhone, resNum, name, session, total, reason, perfName,
}) {
  const text =
`[${perfName}] 취소 신청이 접수되었습니다.

■ 예약번호: ${resNum}
■ 예매자: ${name}
■ 회차: ${session}
■ 결제금액: ${total === 0 ? '무료' : Number(total).toLocaleString() + '원'}
■ 취소 사유: ${reason}

관리자 페이지에서 취소 처리해 주세요.`;

  return sendAlimtalk(adminPhone, text, TPL_CANCEL);
}
