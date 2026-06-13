// ============================================================
//  Background Service Worker — GCP version (FIX: persistent + keepalive)
//  Dùng content-script ports để giữ worker sống thay vì chỉ dùng alarms
// ============================================================

let RELAY = 'http://localhost:8080';

// Load RELAY URL từ storage
chrome.storage.sync.get('relayUrl', (data) => {
  if (data.relayUrl) RELAY = data.relayUrl;
  console.log('[background] RELAY URL:', RELAY);
});

const activeJobs = new Set();
const injectedTabs = new Set();
let cachedAffiliateTabId = null;
let pollIntervalId = null;
let commandIntervalId = null;
let connectedPorts = new Set(); // track content-script ports

// ============================================================
//  PERSISTENT PORT CONNECTION — Giữ Service Worker sống
//  Content script mở port → worker không bị terminate
// ============================================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'shopee-aff-content') {
    console.log('[background] Content script connected via port');
    connectedPorts.add(port);

    // Khi có port kết nối → bắt đầu polling real-time
    startPolling();

    port.onMessage.addListener((msg) => {
      if (msg.type === 'KEEPALIVE') {
        // Chỉ cần nhận message là worker đã được giữ sống
      }
      // Xử lý kết quả từ content script nếu gửi qua port
      if (msg.type === 'CONVERT_RESULT') {
        handleConvertResult(msg.jobId, msg.result);
      }
    });

    port.onDisconnect.addListener(() => {
      console.log('[background] Content script port disconnected');
      connectedPorts.delete(port);
      if (connectedPorts.size === 0) {
        stopPolling();
      }
    });
  }
});

function startPolling() {
  if (pollIntervalId) return; // đã chạy rồi
  console.log('[background] Starting real-time polling (setInterval)');

  // Poll jobs mỗi 1.5 giây — real-time nhờ port giữ worker sống
  pollIntervalId = setInterval(() => {
    pollJobs();
  }, 1500);

  // Poll commands mỗi 2 giây
  commandIntervalId = setInterval(() => {
    pollCommands();
  }, 2000);
}

function stopPolling() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  if (commandIntervalId) {
    clearInterval(commandIntervalId);
    commandIntervalId = null;
  }
  console.log('[background] Stopped real-time polling (no ports)');
}

// ============================================================
//  Alarms backup — khi không có content-script port nào kết nối
//  (tối thiểu 1 phút trong MV3, dùng làm fallback)
// ============================================================

chrome.runtime.onStartup.addListener(() => {
  createAlarms();
});
chrome.runtime.onInstalled.addListener(() => {
  createAlarms();
});

function createAlarms() {
  // Chỉ tạo alarms cho các tác vụ không cần real-time
  // Heartbeat mỗi 1 phút (MV3 minimum)
  chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
  // Reload custom_link tab mỗi 30 phút
  chrome.alarms.create('reloadCustomLink', { periodInMinutes: 30 });
  // Wake-up check: kiểm tra xem cần kết nối lại không
  chrome.alarms.create('wakeupCheck', { periodInMinutes: 1 });
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
    case 'wakeupCheck':
      // Khi worker thức dậy từ alarm, kiểm tra có tab affiliate không
      // Nếu có, thử inject content script để kích hoạt port connection
      await tryWakeUpContentScript();
      break;
  }
});

// ============================================================
//  Wakeup — khi worker bị terminate rồi thức dậy
// ============================================================

async function tryWakeUpContentScript() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
    if (tabs.length > 0) {
      const tab = tabs.find(t => t.status === 'complete');
      if (tab && tab.id != null) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          // Khi content.js chạy, nó sẽ connect port → polling tự động bắt đầu
        } catch {}
      }
    }
    // Nếu không có tab nào, không sao — lần sau mở tab sẽ tự kết nối
  } catch {}
}

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
    
    // Inject content script để content.js luôn sẵn sàng
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch {}
    
    // Ping content script để đảm bảo nó đã lắng nghe message
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
  try {
    await fetch(`${RELAY}/api/result/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {}
}

// Handle convert result sent via port (from content.js)
function handleConvertResult(jobId, result) {
  try {
    fetch(`${RELAY}/api/result/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
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