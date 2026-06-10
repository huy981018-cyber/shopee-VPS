console.log('[content] content script loaded');

if (!window.__shopeeAffToolContentInstalled) {
  window.__shopeeAffToolContentInstalled = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CONVERT_URLS') {
      console.log('[content] CONVERT_URLS received', message.urls);
      convertUrls(message.urls).then(sendResponse).catch((err) => {
        console.error('[content] convertUrls failed', err);
        sendResponse({ results: message.urls.reduce((acc, url) => ({ ...acc, [url]: { error: err.message } }), {}) });
      });
      return true;
    }
  });
}

const BATCH_SIZE = 5;

async function convertUrls(urls) {
  const results = {};

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    console.log(`[content] batch ${Math.floor(i / BATCH_SIZE) + 1}`, batch);

    const ui = await convertAllViaPageUi(batch);
    const batchResults = ui.results;

    Object.assign(results, batchResults);

    if (i + BATCH_SIZE < urls.length) await sleep(1000);
  }

  return { results };
}

// ============================================================
//  Page UI — submit tất cả URLs 1 lần, đọc kết quả theo thứ tự
// ============================================================

let _cachedInput = null;
let _cachedButton = null;

async function convertAllViaPageUi(urls) {
  if (!_cachedInput?.isConnected) _cachedInput = findAffiliateInputField();
  if (!_cachedButton?.isConnected) _cachedButton = findAffiliateSubmitButton();
  const inputField = _cachedInput;
  const button = _cachedButton;

  if (!inputField || !button) throw new Error('Không tìm thấy form chuyển đổi trên trang affiliate');

  // Ghi nhớ các short link đã có trên trang + chính các link input để loại trừ
  const existingLinks = new Set(collectAllShortLinks());
  urls.forEach(u => existingLinks.add(u));

  inputField.focus();
  inputField.value = urls.join('\n');
  inputField.dispatchEvent(new Event('input', { bubbles: true }));
  inputField.dispatchEvent(new Event('change', { bubbles: true }));

  const clickTarget = getClickableElement(button);
  console.log('[content] found input field', inputField, 'submit button', button, 'click target', clickTarget);
  console.log('[content] clicking convert button once');
  clickTarget.scrollIntoView({ block: 'center', inline: 'center' });
  clickTarget.focus();
  simulateUserClick(clickTarget);

  const newLinks = await waitForNewLinks(urls.length, existingLinks);
  console.log('[content] page UI got new links', newLinks);

  // Map theo thứ tự
  const results = {};
  urls.forEach((url, i) => {
    if (newLinks[i]) {
      results[url] = { affLink: newLinks[i] };
    } else {
      results[url] = { error: 'Không nhận được kết quả' };
    }
  });

  // Reset input
  inputField.value = '';
  inputField.dispatchEvent(new Event('input', { bubbles: true }));

  return { results };
}

function waitForNewLinks(count, existingLinks) {
  return new Promise(resolve => {
    let lastLinks = [];
    let stableTimer = null;

    const finish = () => {
      observer.disconnect();
      clearTimeout(timeout);
      clearTimeout(stableTimer);
      resolve(lastLinks.slice(-count));
    };

    const timeout = setTimeout(() => {
      clearTimeout(stableTimer);
      finish();
    }, 8000);

    const check = () => {
      const all = collectAllShortLinks().filter(l => !existingLinks.has(l));
      if (all.length > 0) {
        lastLinks = Array.from(new Set(all));
      }
      if (lastLinks.length >= count) {
        clearTimeout(stableTimer);
        stableTimer = setTimeout(finish, 500);
      }
    };

    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    check(); // kiểm tra ngay lần đầu
  });
}

function collectAllShortLinks() {
  const pattern = /https?:\/\/(?:s\.shopee\.vn|shope\.ee|shp\.ee)\/[A-Za-z0-9]+/g;
  const seen = new Set();
  const links = [];
  // Ưu tiên tìm trong dialog/modal trước, sau đó toàn trang
  const scope = document.querySelector('[role="dialog"], .ant-modal-body, .shopee-modal') || document.body;
  for (const el of scope.querySelectorAll('input, textarea, div, span, p, label, a')) {
    const text = getCleanText(el).trim();
    if (!text) continue;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (!seen.has(m[0])) { seen.add(m[0]); links.push(m[0]); }
    }
    pattern.lastIndex = 0;
  }
  return links;
}

// ============================================================
//  Helpers
// ============================================================

function findAffiliateInputField() {
  const fields = Array.from(document.querySelectorAll('textarea, input[type=text], input:not([type])'));
  const isUsable = el => !el.disabled && !el.readOnly && el.offsetParent !== null;
  const isModal = el => !!el.closest('div[role="dialog"], .modal, .ant-modal');
  const isSubId = el => /sub[_-]?id/i.test((el.id || el.name || el.getAttribute('aria-label') || ''));
  const kw = /lấy link|link rút gọn|link|url|đường dẫn|custom link|original/i;

  return fields.find(el => isUsable(el) && !isModal(el) && !isSubId(el) && kw.test(el.placeholder || ''))
    || fields.find(el => isUsable(el) && !isModal(el) && !isSubId(el) && kw.test(el.getAttribute('aria-label') || el.name || el.id || ''))
    || fields.find(el => isUsable(el) && !isModal(el) && el.tagName === 'TEXTAREA')
    || fields.find(el => isUsable(el) && !isModal(el) && !isSubId(el));
}

function findAffiliateSubmitButton() {
  const elements = Array.from(document.querySelectorAll('button, input[type=button], input[type=submit], a[role=button], [role=button], a, span, div'));
  const label = el => (el.textContent || el.value || '').trim();
  const isVisible = el => el.offsetParent !== null || el.getClientRects().length > 0;
  const hasPrimaryAction = text => /chuyển đổi|lấy link|tạo link|convert|generate|đổi link/i.test(text);
  const isCopy = text => /copy|sao chép|sao-chep|copy link|copyurl/i.test(text);
  const scored = el => {
    const text = label(el);
    if (!text || !isVisible(el)) return -1;
    if (isCopy(text)) return -1;
    if (hasPrimaryAction(text)) return 10;
    if (/submit|convert|generate|đổi|lấy/i.test(text)) return 5;
    return -1;
  };

  const candidates = elements
    .map(el => ({ el, score: scored(el) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score);

  return candidates.length ? candidates[0].el : null;
}

function getCleanText(el) {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value;
  return Array.from(el.childNodes)
    .filter(n => n.nodeType === Node.TEXT_NODE)
    .map(n => n.textContent)
    .join(' ');
}

function getClickableElement(el) {
  if (!(el instanceof Element)) return el;
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a' || tag === 'input') return el;
  return el.closest('button, input[type=button], input[type=submit], a, [role=button]') || el;
}

function simulateUserClick(el) {
  if (!(el instanceof Element)) return;
  const opts = { bubbles: true, cancelable: true, view: window };

  if (typeof el.click === 'function') {
    el.click();
    return;
  }

  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
    el.dispatchEvent(new MouseEvent(type, opts));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
