#!/usr/bin/env bash
# deploy.sh — run tests, then restart Sela via PM2.
# Usage: bash scripts/deploy.sh

set -e
cd "$(dirname "$0")/.."

echo "=== Running tests before deploy ==="
node test/run-all.js

echo ""
echo "=== Tests passed — restarting Sela ==="
pm2 restart sela
echo "=== Deploy complete ==="
