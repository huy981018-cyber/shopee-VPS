#!/usr/bin/env bash
# Launcher script - t? ??ng setup v? ch?y start.sh

set -e

echo "=== Setup shopee-VPS ==="

# C?i ??t dos2unix n?u ch?a c?
if ! command -v dos2unix &> /dev/null; then
    echo "C?i ??t dos2unix..."
    sudo apt update -y
    sudo apt install -y dos2unix
fi

# L?y th? m?c script hi?n t?i
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_SH="$SCRIPT_DIR/start.sh"

# Chuy?n ??i line endings t? Windows CRLF sang Unix LF
echo "Chuy?n ??i line endings..."
dos2unix "$START_SH" 2>/dev/null || sed -i 's/\r$//' "$START_SH"

# ??t permissions
echo "??t quy?n th?c thi..."
chmod +x "$START_SH"

# Ch?y start.sh
echo "=== Kh?i ??ng server ==="
"$START_SH"