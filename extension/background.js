// ============================================================
//  Background Service Worker — GCP version (FIX: auto-recovery)
//  Dùng chrome.alarms để giữ worker sống, thay vì while(true)
// ============================================================

let RELAY = 'http://localhost:8080';

// Load RELAY URL từ storage
chrome.storage.sync.get('relayUrl', (data) => {
  if (data.relayUrl) RELAY = data.relayUrl;
  console.log('[background] RELAY URL:', RELAY);
});

const activeJobs = new Set();
const injectedTabs = new Set();
let cachedAffiliateTabId = null; // tab đã được warmup sẵn

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    injectedTabs.delete(tabId);
    if (tabId === cachedAffiliateTabId) cachedAffiliateTabId = null;
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  injectedTabs.delete(tabId);
  if (tabId === cachedAffiliateTabId) cachedAffiliateTabId = null;
});

// ============================================================
//  Thay while(true) bằng chrome.alarms — giữ worker sống
// ============================================================

chrome.runtime.onStartup.addListener(() => {
  createAlarms();
});
chrome.runtime.onInstalled.addListener(() => {
  createAlarms();
});

function createAlarms() {
  // Poll jobs mỗi 1s
  chrome.alarms.create('pollJobs', { periodInMinutes: 1/60 });
  // Poll commands mỗi 1s
  chrome.alarms.create('pollCommands', { periodInMinutes: 1/60 });
  // Heartbeat mỗi 5s
  chrome.alarms.create('heartbeat', { periodInMinutes: 5/60 });
  // Reload custom_link tab mỗi 30 phút
  chrome.alarms.create('reloadCustomLink', { periodInMinutes: 30 });
  // Self-ping mỗi 20s để tránh worker bị suspend
  chrome.alarms.create('keepAlive', { periodInMinutes: 20/60 });
  // Deep warmup — đảm bảo tab affiliate + content script sẵn sàng mỗi 30s
  chrome.alarms.create('deepWarmup', { periodInMinutes: 30/60 });
  console.log('[background] Alarms created');
}

// ============================================================
//  Xử lý alarm
// ============================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case 'pollJobs':
      await pollJobs();
      break;
    case 'pollCommands':
      await pollCommands();
      break;
    case 'heartbeat':
      await sendHeartbeat();
      break;
    case 'reloadCustomLink':
      await reloadCustomLinkTab();
      break;
    case 'deepWarmup':
      // Deep warmup: đảm bảo tab affiliate + content script sẵn sàng
      await prepareAffiliateTab();
      break;
    case 'keepAlive':
      // Chỉ cần 1 log nhẹ để worker không bị suspend
      console.debug('[background] keepAlive');
      break;
  }
});

// ============================================================
//  Poll jobs từ relay
// ============================================================

async function pollJobs() {
  try {
    const resp = await fetch(`${RELAY}/api/jobs`);
    if (!resp.ok) return;
    const jobs = await resp.json();
    for (const [jobId, job] of Object.entries(jobs)) {
      if (!activeJobs.has(jobId)) {
        activeJobs.add(jobId);
        processRelayJob(jobId, job.urls ?? job);
      }
    }
  } catch {
    // silent
  }
}

// ============================================================
//  Poll commands
// ============================================================

async function pollCommands() {
  try {
    const resp = await fetch(`${RELAY}/api/command`);
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data.commands) && data.commands.length) {
        console.log('[background] received commands', data.commands);
        await handleCommands(data.commands);
      }
    }
  } catch {
    // silent
  }
}

async function handleCommands(commands) {
  for (const cmd of commands) {
    if (cmd.action === 'reload_custom_link') {
      await ensureAffiliateTabFresh();
    } else if (cmd.action === 'warmup') {
      // Warmup: đảm bảo tab affiliate tồn tại, inject content script, sẵn sàng ngay
      await prepareAffiliateTab();
    }
  }
}

// ============================================================
//  Warmup: giữ tab affiliate luôn sẵn sàng + content script injected
// ============================================================

async function prepareAffiliateTab() {
  try {
    let tabId = await getAffiliateTab();
    if (!tabId) return null;
    
    // Kiểm tra nếu tab bị Chrome discard (suspend để tiết kiệm RAM)
    // Nếu bị discard, cần đánh thức tab bằng cách update URL
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.discarded) {
        console.log('[background] tab is discarded, waking up...', tabId);
        // Đánh thức tab: update URL -> Chrome sẽ unsuspend và reload
        await chrome.tabs.update(tabId, { url: tab.url });
        await waitForTab(tabId);
        console.log('[background] tab woken up', tabId);
      }
    } catch (e) {
      console.warn('[background] check discarded failed', e);
      // Nếu tab không tồn tại, bỏ cache và tìm lại
      cachedAffiliateTabId = null;
      tabId = await getAffiliateTab();
    }
    
    // Inject content script để content.js luôn sẵn sàng
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch {}
    
    // Ping content script để đảm bảo nó đã lắng nghe message
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    } catch {
      // Nếu PING vẫn thất bại, thử inject lại và ping lần nữa
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      } catch {}
    }
    
    // Cache tabId để dùng ngay lần tiếp theo
    cachedAffiliateTabId = tabId;
    return tabId;
  } catch (e) {
    console.warn('[background] prepareAffiliateTab failed', e);
    cachedAffiliateTabId = null;
    return null;
  }
}

// Lấy tab affiliate (tự động tạo nếu chưa có)
async function getAffiliateTab() {
  let tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
  
  if (!tabs.length) {
    const tab = await chrome.tabs.create({ url: 'https://affiliate.shopee.vn/offer/custom_link', active: false });
    await waitForTab(tab.id);
    return tab.id;
  }
  
  const targetTab = tabs.find(tab => tab.url && tab.url.includes('/offer/custom_link')) || tabs[0];
  return targetTab.id;
}

async function ensureAffiliateTabFresh() {
  try {
    const tabId = await getAffiliateTab();
    if (!tabId) return null;
    await chrome.tabs.reload(tabId);
    await waitForTab(tabId);
    return tabId;
  } catch (e) {
    console.warn('[background] ensureAffiliateTabFresh failed', e);
    return null;
  }
}

async function reloadCustomLinkTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
    const customTabs = tabs.filter(tab => tab.url && tab.url.includes('/offer/custom_link'));
    if (customTabs.length) {
      for (const tab of customTabs) {
        if (tab.id != null) await chrome.tabs.reload(tab.id);
      }
      return;
    }
    await chrome.tabs.create({ url: 'https://affiliate.shopee.vn/offer/custom_link', active: false });
  } catch (e) {
    console.warn('[background] reloadCustomLinkTab failed', e);
  }
}

// ============================================================
//  Xử lý job chuyển đổi link
// ============================================================

async function processRelayJob(jobId, urls) {
  let payload;
  try {
    // Dùng cached tab ngay lập tức — không query tabs
    let tabId = cachedAffiliateTabId;
    let fallback = false;
    
    if (!tabId) {
      // Không có cached, fallback query tabs
      let tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
      if (!tabs.length) {
        const tab = await chrome.tabs.create({ url: 'https://affiliate.shopee.vn/offer/custom_link', active: false });
        await waitForTab(tab.id);
        tabs = [tab];
      }
      tabId = tabs[0].id;
      fallback = true;
    }
    
    // Kiểm tra nhanh tab có còn hoạt động không
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.discarded) {
        // Tab bị Chrome discard — đánh thức
        await chrome.tabs.update(tabId, { url: tab.url });
        await waitForTab(tabId);
      }
    } catch {
      // Tab không tồn tại — fallback
      let tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
      if (!tabs.length) {
        const tab = await chrome.tabs.create({ url: 'https://affiliate.shopee.vn/offer/custom_link', active: false });
        await waitForTab(tab.id);
        tabs = [tab];
      }
      tabId = tabs[0].id;
      fallback = true;
    }
    
    // Chỉ inject nếu chưa có hoặc fallback
    if (fallback || !injectedTabs.has(tabId)) {
      await injectContentScript(tabId);
    }
    
    // Gửi message ngay — content script đã sẵn sàng từ warmup
    const result = await sendMessageToTabWithRetry(tabId, { type: 'CONVERT_URLS', urls });
    const results = {};
    for (const url of urls) {
      results[url] = result?.results?.[url] ?? { error: 'Không nhận được kết quả' };
    }
    payload = { results };
    
    // Cache lại tabId cho lần sau
    cachedAffiliateTabId = tabId;
  } catch (e) {
    payload = { error: e.message };
    cachedAffiliateTabId = null;
  } finally {
    activeJobs.delete(jobId);
  }
  try {
    await fetch(`${RELAY}/api/result/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {}
}

function waitForTab(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab không load xong sau ' + timeout / 1000 + 's'));
    }, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        setTimeout(resolve, 500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function injectContentScript(tabId) {
  if (injectedTabs.has(tabId)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    injectedTabs.add(tabId);
  } catch (e) {
    console.warn('[background] injectContentScript failed', e);
  }
}

async function sendMessageToTabWithRetry(tabId, message, retries = 2) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      });
    } catch (err) {
      lastError = err;
      if (attempt <= retries) {
        await sleep(200);
        await injectContentScript(tabId);
      }
    }
  }
  throw lastError;
}

// ============================================================
//  Heartbeat
// ============================================================

async function sendHeartbeat() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
    await fetch(`${RELAY}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ affiliate_tab: tabs.length > 0 }),
    });
  } catch {}
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }