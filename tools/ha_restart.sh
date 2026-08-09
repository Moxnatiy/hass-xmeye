#!/usr/bin/env bash
# Restart the development Home Assistant.
#
# Shutdown can take half a minute, and while the old process lives the new one
# refuses to start because of the PID file. So wait until it is really gone.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/.ha-config"
BIN="$ROOT/.ha-venv/bin/hass"

stop() {
  pgrep -f "$BIN" >/dev/null 2>&1 || return 0
  pkill -f "$BIN" 2>/dev/null || true
  # Home Assistant winds itself down in about twenty seconds, mostly because of
  # the database. A development instance has nothing worth saving, so give it a
  # short grace period and then free the port by force.
  for _ in $(seq 1 6); do
    pgrep -f "$BIN" >/dev/null 2>&1 || return 0
    sleep 1
  done
  pkill -9 -f "$BIN" 2>/dev/null || true
  for _ in $(seq 1 10); do
    pgrep -f "$BIN" >/dev/null 2>&1 || return 0
    sleep 1
  done
  echo "the process will not go away; check by hand"
}

start() {
  rm -f "$CONF/.HA_VERSION.lock" 2>/dev/null || true
  nohup "$BIN" -c "$CONF" --log-file "$CONF/home-assistant.log" \
    >"$CONF/stdout.log" 2>&1 &
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -m 2 -w "%{http_code}" http://localhost:8123/ 2>/dev/null)
    if [ "$code" != "000" ]; then
      echo "HA came up in ~${i}s (HTTP $code)"
      return 0
    fi
    sleep 1
  done
  echo "HA did not come up; last lines:"
  tail -5 "$CONF/stdout.log"
  return 1
}

case "${1:-restart}" in
  stop) echo "stopping…"; stop; echo "stopped" ;;
  start) start ;;
  *) echo "stopping…"; t0=$SECONDS; stop; echo "stopped in $((SECONDS-t0))s"; start ;;
esac
