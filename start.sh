#!/usr/bin/env bash
cd "$(dirname "$0")"

cleanup() {
    echo "Dừng tất cả..."
    pkill -f "relay.py" 2>/dev/null
    pkill -f "google-chrome" 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM

RESTART_INTERVAL=1800  # 30 phút
RELOAD_MIN=1500        # 25 phút
RELOAD_MAX=1800        # 30 phút

while true; do
    echo "[$(date '+%H:%M:%S')] Dừng các tiến trình cũ..."
    pkill -f "relay.py" 2>/dev/null; sleep 1
    pkill -f "google-chrome" 2>/dev/null; sleep 1

    echo "[$(date '+%H:%M:%S')] Khởi động Python Server..."
    python3 relay.py &
    sleep 2

    END_TIME=$(($(date +%s) + $RESTART_INTERVAL))
    echo "[$(date '+%H:%M:%S')] Server sẽ restart sau 30 phút..."

    while [ $(date +%s) -lt $END_TIME ]; do
        WAIT_TIME=$((RANDOM % (RELOAD_MAX - RELOAD_MIN + 1) + RELOAD_MIN))
        echo "[$(date '+%H:%M:%S')] Đợi $((WAIT_TIME / 60)) phút rồi reload custom_link..."
        sleep $WAIT_TIME

        if [ $(date +%s) -lt $END_TIME ]; then
            echo "[$(date '+%H:%M:%S')] Reload tab custom_link..."
            xdotool search --name "custom_link" key F5 2>/dev/null || true
        fi
    done

    echo "[$(date '+%H:%M:%S')] Khởi động lại server..."
done
