#!/bin/bash
# Restart the full Tedca OS dev stack (server :8790, app :5173, worker).
# Idempotent — safe to run any time. Logs in /tmp/tedca-*.log
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "stopping old processes…"
lsof -ti :8790 | xargs kill -9 2>/dev/null || true
# ALSO kill servers NOT holding the port: a watchdog respawn that lost the EADDRINUSE
# race keeps running its send loops portless (zombie), survives the lsof kill, and can
# squat the send-owner lock while unable to send (the Jul 6 stall). npm-spawned servers
# have no "tedca-os" in argv, so match the script path itself.
pgrep -f "server/src/index.js" | xargs kill -9 2>/dev/null || true
# pkill -f can miss processes with spaces in path; also kill by scanning pgrep output
pgrep -f "tedca-os/worker" | xargs kill -9 2>/dev/null || true
pgrep -f "tedca-os/app.*vite" | xargs kill -9 2>/dev/null || true
sleep 1

echo "starting server…"
(cd "$DIR/server" && nohup npm start > /tmp/tedca-server.log 2>&1 &)
sleep 2

echo "starting app…"
(cd "$DIR/app" && nohup npm run dev > /tmp/tedca-app.log 2>&1 &)

echo "starting worker…"
# Override BACKEND_URL so the local worker talks to the local server, not the cloud.
# Record this worker's PID + start time so the watchdog ADOPTS it instead of thinking
# the worker is down (stale pid file) and spawning a SECOND one → duplicate worker.
(cd "$DIR/worker" && BACKEND_URL=http://localhost:8790 nohup node --env-file-if-exists="$DIR/../.env" --env-file="$DIR/.env" "$DIR/worker/index.js" > /tmp/tedca-worker.log 2>&1 & echo $! > /tmp/tedca-worker.pid)
date +%s > /tmp/tedca-worker.started
sleep 3

# verify all three
ok=1
curl -s -m 3 http://localhost:8790/api/health | grep -q ok && echo "✓ server  :8790" || { echo "✗ server DOWN — tail /tmp/tedca-server.log"; ok=0; }
APP_PORT=$(grep -o "localhost:[0-9]*" /tmp/tedca-app.log | head -1 | cut -d: -f2)
[ -n "$APP_PORT" ] && curl -s -m 3 -o /dev/null "http://localhost:$APP_PORT" && echo "✓ app     :$APP_PORT" || { echo "✗ app DOWN — tail /tmp/tedca-app.log"; ok=0; }
pgrep -f "tedca-os/worker" >/dev/null && echo "✓ worker  polling" || { echo "✗ worker DOWN — tail /tmp/tedca-worker.log"; ok=0; }
[ "$ok" = "1" ] && echo "all up → http://localhost:${APP_PORT:-5173}"
