// ============================================================
//  Background Service Worker — v3.0 (WebSocket only)
//  WebSocket persistent connection → giữ worker sống vĩnh viễn
//  Jobs + commands được push real-time, không cần polling
// ============================================================

let RELAY = 'http://localhost:8080';
let WS_URL = 'ws://localhost:8081';

let ws = null;
let wsReconnectTimer = null;
let wsHeartbeatTimer = null;
const activeJobs = new Set();
const injectedTabs = new Set();
let cachedAffiliateTabId = null;

// ============================================================
//  WebSocket — kết nối persistent tới relay server
//  Chrome không thể terminate worker khi WebSocket đang mở
// ============================================================

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log('[background] Connecting WebSocket to', WS_URL);
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn('[background] WebSocket creation failed', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[background] WebSocket connected');
    // Gửi heartbeat mỗi 15s để giữ kết nối sống
    startHeartbeat();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWSMessage(msg);
    } catch (e) {
      console.warn('[background] Invalid WS message', e);
    }
  };

  ws.onclose = (event) => {
    console.log('[background] WebSocket disconnected (code:', event.code, ')');
    stopHeartbeat();
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.warn('[background] WebSocket error');
  };
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  // Thử kết nối lại sau 1s
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket();
  }, 1000);
}

function startHeartbeat() {
  stopHeartbeat();
  // Gửi heartbeat + affiliate_tab status mỗi 15s
  wsHeartbeatTimer = setInterval(async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }
    try {
      const tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
      ws.send(JSON.stringify({
        type: 'heartbeat',
        affiliate_tab: tabs.length > 0
      }));
    } catch {}
  }, 15000);
}

function stopHeartbeat() {
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch {}
  }
}

// ============================================================
//  Xử lý message từ WebSocket
// ============================================================

async function handleWSMessage(msg) {
  console.log('[background] WS message:', msg.type);

  switch (msg.type) {
    case 'connected':
      console.log('[background] Confirmed connected to relay');
      break;

    case 'heartbeat_ack':
      // Relay xác nhận heartbeat
      break;

    case 'new_job':
      // Job mới từ relay — push qua WebSocket
      if (msg.job_id && msg.urls && !activeJobs.has(msg.job_id)) {
        activeJobs.add(msg.job_id);
        processRelayJob(msg.job_id, msg.urls);
      }
      break;

    case 'jobs':
      // Danh sách jobs hiện tại (khi mới kết nối)
      if (msg.jobs) {
        for (const [jobId, job] of Object.entries(msg.jobs)) {
          if (!activeJobs.has(jobId)) {
            activeJobs.add(jobId);
            processRelayJob(jobId, job.urls ?? job);
          }
        }
      }
      break;

    case 'commands':
      // Lệnh từ relay
      if (Array.isArray(msg.commands) && msg.commands.length) {
        console.log('[background] received commands', msg.commands);
        await handleCommands(msg.commands);
      }
      break;

    case 'pong':
      break;
  }
}

async function handleCommands(commands) {
  for (const cmd of commands) {
    if (cmd.action === 'reload_custom_link') {
      await ensureAffiliateTabFresh();
    }
    // warmup không còn cần thiết — WebSocket giữ worker sống 24/7
  }
}

// ============================================================
//  Fallback: dùng chrome.alarms + HTTP polling khi WebSocket
//  không kết nối được (lần đầu tiên worker chạy)
// ============================================================

chrome.runtime.onStartup.addListener(() => {
  createAlarms();
  connectWebSocket();
});
chrome.runtime.onInstalled.addListener(() => {
  createAlarms();
  connectWebSocket();
});

function createAlarms() {
  // Heartbeat backup mỗi 1 phút
  chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
  // Reload custom_link tab mỗi 30 phút
  chrome.alarms.create('reloadCustomLink', { periodInMinutes: 30 });
  // Kiểm tra WebSocket connection mỗi 30s
  chrome.alarms.create('checkWS', { periodInMinutes: 0.5 });
  console.log('[background] Backup alarms created');
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case 'heartbeat':
      await sendHeartbeat();
      break;
    case 'reloadCustomLink':
      await reloadCustomLinkTab();
      break;
    case 'checkWS':
      // Nếu WebSocket không kết nối, thử kết nối lại
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        connectWebSocket();
      }
      break;
  }
});

// ============================================================
//  Poll HTTP fallback — dùng khi WebSocket chưa kết nối
// ============================================================

let fallbackPollTimer = null;

function startFallbackPolling() {
  if (fallbackPollTimer) return;
  // Poll mỗi 2s khi WebSocket chưa sẵn sàng
  fallbackPollTimer = setInterval(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Đã có WebSocket, dừng fallback
      stopFallbackPolling();
      return;
    }
    await pollJobs();
    await pollCommands();
  }, 2000);
}

function stopFallbackPolling() {
  if (fallbackPollTimer) {
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
  }
}

// ============================================================
//  Warmup: giữ tab affiliate luôn sẵn sàng
// ============================================================

async function prepareAffiliateTab() {
  try {
    let tabId = await getAffiliateTab();
    if (!tabId) return null;
    
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.discarded) {
        console.log('[background] tab is discarded, waking up...', tabId);
        await chrome.tabs.update(tabId, { url: tab.url });
        await waitForTab(tabId);
        console.log('[background] tab woken up', tabId);
      }
    } catch (e) {
      console.warn('[background] check discarded failed', e);
      cachedAffiliateTabId = null;
      tabId = await getAffiliateTab();
    }
    
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch {}
    
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      } catch {}
    }
    
    cachedAffiliateTabId = tabId;
    return tabId;
  } catch (e) {
    console.warn('[background] prepareAffiliateTab failed', e);
    cachedAffiliateTabId = null;
    return null;
  }
}

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
    let tabId = cachedAffiliateTabId;
    let fallback = false;
    
    if (!tabId) {
      let tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
      if (!tabs.length) {
        const tab = await chrome.tabs.create({ url: 'https://affiliate.shopee.vn/offer/custom_link', active: false });
        await waitForTab(tab.id);
        tabs = [tab];
      }
      tabId = tabs[0].id;
      fallback = true;
    }
    
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.discarded) {
        await chrome.tabs.update(tabId, { url: tab.url });
        await waitForTab(tabId);
      }
    } catch {
      let tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
      if (!tabs.length) {
        const tab = await chrome.tabs.create({ url: 'https://affiliate.shopee.vn/offer/custom_link', active: false });
        await waitForTab(tab.id);
        tabs = [tab];
      }
      tabId = tabs[0].id;
      fallback = true;
    }
    
    if (fallback || !injectedTabs.has(tabId)) {
      await injectContentScript(tabId);
    }
    
    const result = await sendMessageToTabWithRetry(tabId, { type: 'CONVERT_URLS', urls });
    const results = {};
    for (const url of urls) {
      results[url] = result?.results?.[url] ?? { error: 'Không nhận được kết quả' };
    }
    payload = { results };
    
    cachedAffiliateTabId = tabId;
  } catch (e) {
    payload = { error: e.message };
    cachedAffiliateTabId = null;
  } finally {
    activeJobs.delete(jobId);
  }
  
  // Gửi kết quả qua WebSocket (ưu tiên) hoặc HTTP fallback
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsSend({ type: 'result', job_id: jobId, result: payload });
  } else {
    try {
      await fetch(`${RELAY}/api/result/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {}
  }
}

// ============================================================
//  Fallback HTTP polling (khi WebSocket chưa kết nối)
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

async function pollCommands() {
  try {
    const resp = await fetch(`${RELAY}/api/command`);
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data.commands) && data.commands.length) {
        console.log('[background] received commands (HTTP fallback)', data.commands);
        await handleCommands(data.commands);
      }
    }
  } catch {
    // silent
  }
}

// ============================================================
//  Heartbeat HTTP fallback
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

// ============================================================
//  Helpers (giữ nguyên)
// ============================================================

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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ============================================================
//  Khởi tạo: kết nối WebSocket ngay lập tức
//  + fallback HTTP polling khi WebSocket chưa sẵn sàng
// ============================================================

connectWebSocket();
startFallbackPolling();

// Khi extension được load, kiểm tra tab affiliate và warmup
chrome.runtime.onStartup.addListener(() => {
  prepareAffiliateTab();
});
chrome.runtime.onInstalled.addListener(() => {
  prepareAffiliateTab();
});

// Cũng warmup ngay khi load
prepareAffiliateTab();