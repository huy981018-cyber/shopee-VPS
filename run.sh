#!/usr/bin/env bash
# Launcher script - tự động setup và chạy start.sh

set -e

echo "=== Setup shopee-VPS ==="

# Cài đặt dos2unix nếu chưa có
if ! command -v dos2unix &> /dev/null; then
    echo "Cài đặt dos2unix..."
    sudo apt update -y
    sudo apt install -y dos2unix
fi

# Lấy thư mục script hiện tại
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_SH="$SCRIPT_DIR/start.sh"

# Chuyển đổi line endings từ Windows CRLF sang Unix LF
echo "Chuyển đổi line endings..."
dos2unix "$START_SH" 2>/dev/null || sed -i 's/\r$//' "$START_SH"

# Đặt permissions
echo "Đặt quyền thực thi..."
chmod +x "$START_SH"

# Chạy start.sh
echo "=== Khởi động server ==="
"$START_SH"