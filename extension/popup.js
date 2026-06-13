const statusEl = document.getElementById('status');
const relayStatusEl = document.getElementById('relayStatus');
const fixBtn = document.getElementById('fixBtn');

// Kiểm tra tab affiliate có đang mở và đã đăng nhập không
chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' }, (tabs) => {
  if (tabs.length) {
    statusEl.className = 'status ok';
    statusEl.textContent = `✓ Sẵn sàng — Tab Shopee Affiliate đang mở (${tabs.length} tab)`;
  } else {
    statusEl.className = 'status err';
    statusEl.textContent = '⚠️ Chưa mở tab Shopee Affiliate';
  }
});

// Kiểm tra kết nối relay server
async function checkRelay() {
  try {
    // Lấy relay URL từ storage
    const data = await chrome.storage.sync.get('relayUrl');
    const relay = data.relayUrl || 'http://localhost:8080';
    
    const resp = await fetch(`${relay}/api/health`);
    if (resp.ok) {
      const health = await resp.json();
      relayStatusEl.className = 'status ok';
      if (health.extension) {
        relayStatusEl.textContent = `✓ Relay OK • Extension: kết nối • Jobs: ${health.pending_jobs || 0}`;
      } else {
        relayStatusEl.textContent = `✓ Relay OK • ⚠️ Extension chưa kết nối (jobs: ${health.pending_jobs || 0})`;
      }
    } else {
      relayStatusEl.className = 'status err';
      relayStatusEl.textContent = '⚠️ Relay server không phản hồi';
    }
  } catch (e) {
    relayStatusEl.className = 'status err';
    relayStatusEl.textContent = '⚠️ Không thể kết nối relay server';
  }
}

checkRelay();

// Refresh trạng thái mỗi 3 giây
setInterval(checkRelay, 3000);

// Nút Fix — gửi lệnh reset extension
fixBtn.addEventListener('click', async () => {
  fixBtn.disabled = true;
  fixBtn.textContent = 'Đang xử lý...';
  
  try {
    const data = await chrome.storage.sync.get('relayUrl');
    const relay = data.relayUrl || 'http://localhost:8080';
    
    const resp = await fetch(`${relay}/api/fix-extension`, { method: 'POST' });
    if (resp.ok) {
      fixBtn.textContent = '✓ Đã reset extension state!';
      setTimeout(() => {
        fixBtn.textContent = 'Fix Extension';
        fixBtn.disabled = false;
      }, 2000);
    } else {
      fixBtn.textContent = '❌ Lỗi!';
      setTimeout(() => {
        fixBtn.textContent = 'Fix Extension';
        fixBtn.disabled = false;
      }, 2000);
    }
  } catch (e) {
    fixBtn.textContent = '❌ Lỗi kết nối!';
    setTimeout(() => {
      fixBtn.textContent = 'Fix Extension';
      fixBtn.disabled = false;
    }, 2000);
  }
});

function openAffiliate() {
  chrome.tabs.create({ url: 'https://affiliate.shopee.vn/offer/custom_link' });
}