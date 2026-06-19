#!/bin/bash
# Run the Mac worker against the CLOUD server, so jobs you trigger from your PHONE
# (at the Railway URL) get rendered here on your Mac and delivered to Telegram.
#
# Trade-off: while this is running, the worker is pointed at the cloud — NOT at your
# local dev server. Use dev.sh for local-only work; use this for phone access.
# Your Mac must stay awake + this must keep running for phone-triggered jobs to render.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
CLOUD="${CLOUD_URL:-https://tedca-os-production.up.railway.app}"

echo "stopping any existing worker…"
pgrep -f "tedca-os/worker" | xargs kill -9 2>/dev/null || true
sleep 1

echo "starting worker → $CLOUD"
(cd "$DIR/worker" && BACKEND_URL="$CLOUD" nohup node \
  --env-file-if-exists="$DIR/../.env" --env-file="$DIR/.env" \
  "$DIR/worker/index.js" > /tmp/tedca-worker-cloud.log 2>&1 &)
sleep 5

if grep -qiE "online|heartbeat|polling|connected" /tmp/tedca-worker-cloud.log 2>/dev/null; then
  echo "✓ worker connected to the cloud — phone-triggered jobs will render on this Mac"
elif grep -qiE "401|unauthor|failed to connect|claim failed" /tmp/tedca-worker-cloud.log 2>/dev/null; then
  echo "✗ worker could NOT authenticate to the cloud."
  echo "  → The WORKER_TOKEN in Railway's env must match the one in tedca-os/.env."
  tail -6 /tmp/tedca-worker-cloud.log
else
  echo "worker started — confirm with:  tail -f /tmp/tedca-worker-cloud.log"
  tail -6 /tmp/tedca-worker-cloud.log
fi
