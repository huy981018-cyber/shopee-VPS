#!/bin/bash
# Ch?y 1 l?n duy nh?t tr?n GCP VM
set -e

echo "=== C?i c?c g?i c?n thi?t ==="
sudo apt-get update -y
sudo apt-get install -y python3 wget

echo "=== C?i Google Chrome ==="
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get install -y ./google-chrome-stable_current_amd64.deb
rm google-chrome-stable_current_amd64.deb

echo ""
echo "=== C?i ??t xong. Ch?y: bash start.sh ==="