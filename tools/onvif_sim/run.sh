#!/usr/bin/env bash
# Start the PTZ simulator: go2rtc first, then the camera.
#
#     tools/onvif_sim/run.sh            # advertise the LAN address
#     tools/onvif_sim/run.sh --ip X     # or a given one
#
# Expects the environment set up as in README.md, under .local/onvif-sim/.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV="$ROOT/.local/onvif-sim"

"$ENV/bin/go2rtc" -config "$HERE/go2rtc.yaml" >"$ENV/go2rtc.log" 2>&1 &
GO2RTC=$!
trap 'kill $GO2RTC 2>/dev/null || true' EXIT

# IPyCam decides between go2rtc and its own fallback by probing go2rtc's API, so
# it must be listening before the camera starts.
for _ in $(seq 1 50); do
  curl -s -o /dev/null http://127.0.0.1:1984/api && break
  sleep 0.1
done

# IPyCam keeps its presets in the working directory; keep them out of the repo.
cd "$ENV"
"$ENV/venv/bin/python" "$HERE/ptz_camera.py" "$@"
