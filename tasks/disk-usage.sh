#!/bin/bash
# @desc: Disk-Usage des VPS + Container-Volumes als Report
# @server: n8n VPS
set -euo pipefail

echo "=== df -h ==="
df -h | head -20
echo
echo "=== docker volumes ==="
docker system df -v 2>/dev/null | head -40 || echo "kein docker im Container"
echo
df -h > disk-report.txt
echo "saved disk-report.txt"
