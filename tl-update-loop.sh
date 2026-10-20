#!/bin/bash
# Cold-email status to Telegram every 30 min, but only inside the send window
# (Mon-Fri 8:00-16:59 ET) so it never pings at 3am. Runs until killed.
#   stop with:  pkill -f tl-update-loop
WS="/Users/yoljean/Downloads/Ted Workspace"
cd "$WS/tedca-os/server" || exit 1
while true; do
  h=$(TZ=America/New_York date +%H); d=$(TZ=America/New_York date +%u)
  if [ "$d" -le 5 ] && [ "$h" -ge 08 ] && [ "$h" -lt 17 ]; then
    /usr/local/bin/node --env-file-if-exists="$WS/.env" --env-file="$WS/tedca-os/.env" \
      cold-email-tl-update.mjs >> /tmp/tedca-tl-update.log 2>&1
  fi
  sleep 1800
done
