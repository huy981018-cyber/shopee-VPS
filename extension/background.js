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

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') injectedTabs.delete(tabId);
});
chrome.tabs.onRemoved.addListener(tabId => injectedTabs.delete(tabId));

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
  // Self-ping mỗi 25s để tránh worker bị suspend
  chrome.alarms.create('keepAlive', { periodInMinutes: 25/60 });
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
      await reloadCustomLinkTab();
    }
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
    let tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
    if (!tabs.length) {
      const tab = await chrome.tabs.create({ url: 'https://affiliate.shopee.vn/offer/custom_link', active: false });
      await waitForTab(tab.id);
      tabs = [tab];
    }
    const tabId = tabs[0].id;
    await injectContentScript(tabId);
    const result = await sendMessageToTabWithRetry(tabId, { type: 'CONVERT_URLS', urls });
    const results = {};
    for (const url of urls) {
      results[url] = result?.results?.[url] ?? { error: 'Không nhận được kết quả' };
    }
    payload = { results };
  } catch (e) {
    payload = { error: e.message };
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