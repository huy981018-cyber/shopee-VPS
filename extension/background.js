// ============================================================
//  Background Service Worker — GCP version
//  Chrome và relay.py chạy cùng máy → poll localhost trực tiếp
// ============================================================

const RELAY = 'http://localhost:8080';
const activeJobs = new Set();
const injectedTabs = new Set();

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') injectedTabs.delete(tabId);
});
chrome.tabs.onRemoved.addListener(tabId => injectedTabs.delete(tabId));

async function relayLoop() {
  while (true) {
    try {
      const resp = await fetch(`${RELAY}/api/jobs`);
      if (!resp.ok) { await sleep(1000); continue; }
      const jobs = await resp.json();
      for (const [jobId, job] of Object.entries(jobs)) {
        if (!activeJobs.has(jobId)) {
          activeJobs.add(jobId);
          processRelayJob(jobId, job.urls ?? job);
        }
      }
    } catch {
      await sleep(1000);
    }
  }
}

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
  await fetch(`${RELAY}/api/result/${jobId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const RELOAD_INTERVAL_MINUTES = 30;
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('reloadCustomLink', { periodInMinutes: RELOAD_INTERVAL_MINUTES });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('reloadCustomLink', { periodInMinutes: RELOAD_INTERVAL_MINUTES });
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'reloadCustomLink') return;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/offer/custom_link' });
    for (const tab of tabs) {
      if (tab.id != null) chrome.tabs.reload(tab.id);
    }
  } catch (e) {}
});

// Poll command queue every second
async function commandLoop() {
  while (true) {
    try {
      const resp = await fetch(`${RELAY}/api/commands`);
      if (resp.ok) {
        const data = await resp.json();
        for (const cmd of data.commands || []) {
          if (cmd.action === 'reload_custom_link') {
            const tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/offer/custom_link' });
            for (const tab of tabs) {
              if (tab.id != null) await chrome.tabs.reload(tab.id);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[background] commandLoop error', e);
    }
    await sleep(1000);
  }
}

// Heartbeat mỗi 5s
async function heartbeatLoop() {
  while (true) {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
      await fetch(`${RELAY}/api/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ affiliate_tab: tabs.length > 0 }),
      });
    } catch {}
    await sleep(5000);
  }
}

relayLoop();
heartbeatLoop();
commandLoop();
