#!/bin/bash
# Chạy 1 lần duy nhất trên GCP VM
set -e

echo "=== Cài các gói cần thiết ==="
sudo apt-get update -y
sudo apt-get install -y python3 wget

echo "=== Cài Google Chrome ==="
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get install -y ./google-chrome-stable_current_amd64.deb
rm google-chrome-stable_current_amd64.deb

echo ""
echo "=== Cài đặt xong. Chạy: bash start.sh ==="
