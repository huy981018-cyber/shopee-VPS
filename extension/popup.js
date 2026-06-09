const statusEl = document.getElementById('status');

// Kiểm tra tab affiliate có đang mở và đã đăng nhập không
chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' }, (tabs) => {
  if (tabs.length) {
    statusEl.className = 'status ok';
    statusEl.textContent = '✓ Sẵn sàng — Tab Shopee Affiliate đang mở';
  } else {
    statusEl.className = 'status err';
    statusEl.textContent = '⚠️ Chưa mở tab Shopee Affiliate';
  }
});

function openAffiliate() {
  chrome.tabs.create({ url: 'https://affiliate.shopee.vn/offer/custom_link' });
}
