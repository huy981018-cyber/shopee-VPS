#!/bin/bash
cd "$(dirname "$0")"

cleanup() {
    echo "Dừng tất cả..."
    pkill -f "relay.py" 2>/dev/null
    pkill -f "google-chrome" 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM

while true; do
    echo "[$(date '+%H:%M:%S')] Dừng các tiến trình cũ..."
    pkill -f "relay.py" 2>/dev/null; sleep 1
    pkill -f "google-chrome" 2>/dev/null; sleep 1

    echo "[$(date '+%H:%M:%S')] Khởi động Python Server..."
    python3 relay.py &
    sleep 2

    echo "[$(date '+%H:%M:%S')] Khởi động Chrome với Extension..."
    google-chrome-stable \
        --no-first-run \
        --disable-extensions-except="$(pwd)/extension" \
        --load-extension="$(pwd)/extension" \
        --user-data-dir="$HOME/.config/shopeeaff-chrome" \
        "https://affiliate.shopee.vn/offer/custom_link" &

    echo "[$(date '+%H:%M:%S')] Tất cả đang chạy. Đợi 15 phút rồi restart..."
    sleep 900

    echo "[$(date '+%H:%M:%S')] Đang restart..."
done
