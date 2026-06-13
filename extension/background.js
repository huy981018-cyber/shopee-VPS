// ============================================================
//  Background Service Worker — OPTIMIZED FOR SPEED
//  Giữ worker sống, tự động refresh tab affiliate, xử lý job nhanh
// ============================================================

let RELAY = 'http://localhost:8080';

// Load RELAY URL từ storage
chrome.storage.sync.get('relayUrl', (data) => {
  if (data.relayUrl) RELAY = data.relayUrl;
  console.log('[background] RELAY URL:', RELAY);
});

const activeJobs = new Set();
let lastTabReload = 0; // timestamp lần cuối reload tab affiliate
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 phút

// ============================================================
//  Giữ worker sống — dùng long-lived connection
// ============================================================

function createKeepAlivePort() {
  try {
    const port = chrome.runtime.connect({ name: 'keepAlive' });
    port.onDisconnect.addListener(() => setTimeout(createKeepAlivePort, 100));
  } catch (e) {
    setTimeout(createKeepAlivePort, 1000);
  }
}

chrome.runtime.onStartup.addListener(() => {
  createKeepAlivePort();
  createAlarms();
});

chrome.runtime.onInstalled.addListener(() => {
  createKeepAlivePort();
  createAlarms();
});

function createAlarms() {
  // Poll jobs mỗi 500ms (nhanh hơn)
  chrome.alarms.create('pollJobs', { periodInMinutes: 0.5 / 60 });
  // Poll commands mỗi 1s
  chrome.alarms.create('pollCommands', { periodInMinutes: 1 / 60 });
  // Heartbeat mỗi 5s
  chrome.alarms.create('heartbeat', { periodInMinutes: 5 / 60 });
  // Refresh tab affiliate mỗi 5 phút (chủ động, tránh stale)
  chrome.alarms.create('refreshTab', { periodInMinutes: 5 });
  // KeepAlive mỗi 15s
  chrome.alarms.create('keepAlive', { periodInMinutes: 15 / 60 });
}

// ============================================================
//  Xử lý alarm
// ============================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case 'pollJobs':     await pollJobs(); break;
    case 'pollCommands': await pollCommands(); break;
    case 'heartbeat':    await sendHeartbeat(); break;
    case 'refreshTab':
      // Refresh tab affiliate định kỳ — giữ page luôn mới
      await ensureAffiliateTabFresh();
      break;
    case 'keepAlive':
      // Ping nhẹ để worker không bị suspend
      try { await fetch(`${RELAY}/api/ping`); } catch {}
      break;
  }
});

// ============================================================
//  Poll jobs từ relay (nhanh hơn)
// ============================================================

async function pollJobs() {
  try {
    const resp = await fetch(`${RELAY}/api/jobs`);
    if (!resp.ok) return;
    const jobs = await resp.json();
    for (const [jobId, job] of Object.entries(jobs)) {
      if (!activeJobs.has(jobId)) {
        activeJobs.add(jobId);
        // Xử lý bất đồng bộ, không await
        processRelayJob(jobId, job.urls ?? job);
      }
    }
  } catch {}
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
        handleCommands(data.commands);
      }
    }
  } catch {}
}

async function handleCommands(commands) {
  for (const cmd of commands) {
    if (cmd.action === 'reload_custom_link') {
      await ensureAffiliateTabFresh();
    }
  }
}

// ============================================================
//  Đảm bảo tab affiliate luôn mới
// ============================================================

async function ensureAffiliateTabFresh() {
  try {
    let tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
    
    // Nếu không có tab nào, tạo mới
    if (!tabs.length) {
      const tab = await chrome.tabs.create({ url: 'https://affiliate.shopee.vn/offer/custom_link', active: false });
      await waitForTab(tab.id);
      lastTabReload = Date.now();
      return tab.id;
    }
    
    // Lấy tab custom_link
    const targetTab = tabs.find(tab => tab.url && tab.url.includes('/offer/custom_link')) || tabs[0];
    
    // Reload nếu đã quá REFRESH_INTERVAL
    if (Date.now() - lastTabReload > REFRESH_INTERVAL) {
      await chrome.tabs.reload(targetTab.id);
      await waitForTab(targetTab.id);
      lastTabReload = Date.now();
    }
    
    return targetTab.id;
  } catch (e) {
    console.warn('[background] ensureAffiliateTabFresh failed', e);
    return null;
  }
}

// ============================================================
//  Xử lý job chuyển đổi link (tối ưu tốc độ)
// ============================================================

async function processRelayJob(jobId, urls) {
  let payload;
  
  try {
    // Lấy tab affiliate (sẽ refresh nếu cần trong ensureAffiliateTabFresh)
    const tabId = await getAffiliateTab();
    if (!tabId) {
      payload = { error: 'Không có tab affiliate' };
      return;
    }
    
    // Inject content script và gửi message
    const result = await sendMessageToTab(tabId, { type: 'CONVERT_URLS', urls });
    
    const results = {};
    for (const url of urls) {
      results[url] = result?.results?.[url] ?? { error: 'Không nhận được kết quả' };
    }
    payload = { results };
    
  } catch (e) {
    console.error('[background] processRelayJob failed:', e.message);
    
    // Thử lần cuối: tạo tab mới và chạy lại
    try {
      const tab = await chrome.tabs.create({ url: 'https://affiliate.shopee.vn/offer/custom_link', active: false });
      await waitForTab(tab.id);
      const result = await sendMessageToTab(tab.id, { type: 'CONVERT_URLS', urls });
      const results = {};
      for (const url of urls) {
        results[url] = result?.results?.[url] ?? { error: 'Không nhận được kết quả' };
      }
      payload = { results };
      lastTabReload = Date.now();
    } catch (e2) {
      payload = { error: e2.message };
    }
  } finally {
    activeJobs.delete(jobId);
  }
  
  // Gửi kết quả về relay
  try {
    await fetch(`${RELAY}/api/result/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {}
}

// Lấy tab affiliate (tự động tạo nếu chưa có)
async function getAffiliateTab() {
  let tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
  
  if (!tabs.length) {
    const tab = await chrome.tabs.create({ url: 'https://affiliate.shopee.vn/offer/custom_link', active: false });
    await waitForTab(tab.id);
    lastTabReload = Date.now();
    return tab.id;
  }
  
  const targetTab = tabs.find(tab => tab.url && tab.url.includes('/offer/custom_link')) || tabs[0];
  return targetTab.id;
}

function waitForTab(tabId, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeout);
    
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        setTimeout(resolve, 300); // chờ 300ms cho page ổn định
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendMessageToTab(tabId, message) {
  // Inject content script trước
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {}
  
  // Gửi message với retry nhanh
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      });
    } catch (err) {
      if (attempt < 2) {
        await sleep(200);
        try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); } catch {}
      } else {
        throw err;
      }
    }
  }
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