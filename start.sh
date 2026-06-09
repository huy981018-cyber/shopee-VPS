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

    echo "[$(date '+%H:%M:%S')] Server đang chạy. Đợi 1 giờ rồi restart..."
    sleep 3600

    echo "[$(date '+%H:%M:%S')] Reload tab affiliate trước khi restart..."
    xdotool search --name "custom_link" key F5 2>/dev/null || true

    echo "[$(date '+%H:%M:%S')] Đang restart..."
done
