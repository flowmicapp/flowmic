#!/usr/bin/env bash
# Host driver for test/store_shots/store_shots_app.dart (macOS only).
#
#   apps/mobile/test/store_shots/run_ios.sh <simulator-udid> <out-dir> [scene,scene]
#
# Boots the simulator if needed, pins a clean status bar, runs the rig with
# `flutter run`, and takes `xcrun simctl io screenshot` each time the rig prints
# `STORESHOT:<name>`. Only kills the flutter process it started itself (by PID).
set -euo pipefail

DEV="${1:?simulator udid}"
OUT="${2:?output dir}"
ONLY="${3:-}"
TALL=false
[ "${4:-}" = tall ] && TALL=true
HERE="$(cd "$(dirname "$0")" && pwd)"
MOBILE="$(cd "$HERE/../.." && pwd)"
mkdir -p "$OUT"

state="$(xcrun simctl list devices | grep "$DEV" || true)"
if ! grep -q Booted <<<"$state"; then
  xcrun simctl boot "$DEV"
  xcrun simctl bootstatus "$DEV" -b
fi
xcrun simctl ui "$DEV" appearance light || true
# 9:41 in the status bar (an ISO string also pins the iPad's date), and the
# app's own clock shifted so timeline rows read 9:4x as well: simctl hands
# SIMCTL_CHILD_* variables to the launched app, and a POSIX TZ moves Dart's
# local time without touching the simulator or the host clock.
# simctl only takes the fractional-seconds UTC form (measured: `+08:00`,
# `+0800` and a bare `Z` are all refused).
T941="$(date -u -r "$(date -j -f '%Y-%m-%d %H:%M' "$(date +%Y-%m-%d) 09:41" +%s)" +%Y-%m-%dT%H:%M:00.000Z)"
xcrun simctl status_bar "$DEV" override --time "$T941" --dataNetwork wifi \
  --wifiMode active --wifiBars 3 --cellularMode active --cellularBars 4 \
  --operatorName '' --batteryState discharging --batteryLevel 100

now=$(( 10#$(date -u +%H) * 60 + 10#$(date -u +%M) ))
off=$(( 580 - now ))
if (( off > 840 )); then off=$(( off - 1440 )); fi
if (( off < -720 )); then off=$(( off + 1440 )); fi
if (( off >= 0 )); then sign='-'; abs=$off; else sign='+'; abs=$(( -off )); fi
SIMCTL_CHILD_TZ="$(printf 'SHT%s%02d:%02d' "$sign" $(( abs / 60 )) $(( abs % 60 )))"
export SIMCTL_CHILD_TZ

LOG="$OUT/run.log"
: >"$LOG"
cd "$MOBILE"
flutter run -d "$DEV" -t test/store_shots/store_shots_app.dart \
  --dart-define=STORE_SHOTS_ONLY="$ONLY" --dart-define=STORE_SHOTS_TALL="$TALL" </dev/null >"$LOG" 2>&1 &
FPID=$!
trap 'kill "$FPID" 2>/dev/null || true' EXIT

seen=0
deadline=$((SECONDS + 1200))
while :; do
  if ! kill -0 "$FPID" 2>/dev/null; then echo "flutter run exited early"; break; fi
  if ((SECONDS > deadline)); then echo "timeout"; break; fi
  # bash 3.2 on macOS: no mapfile, so walk the marker list by line number.
  total=$(grep -oE 'STORESHOT(_FAIL)?:[^ ]*|STORESHOT_DONE' "$LOG" | wc -l | tr -d ' ' || true)
  while ((seen < total)); do
    seen=$((seen + 1))
    m="$(grep -oE 'STORESHOT(_FAIL)?:[^ ]*|STORESHOT_DONE' "$LOG" | sed -n "${seen}p" || true)"
    case "$m" in
      STORESHOT_DONE) echo "done"; kill "$FPID" 2>/dev/null || true; wait "$FPID" 2>/dev/null || true
        xcrun simctl status_bar "$DEV" clear || true; exit 0 ;;
      STORESHOT_FAIL:*) echo "FAIL ${m#STORESHOT_FAIL:}" ;;
      STORESHOT:*) n="${m#STORESHOT:}"; sleep 0.8
        xcrun simctl io "$DEV" screenshot --type=png "$OUT/$n.png" >/dev/null 2>&1
        echo "shot $n" ;;
    esac
  done
  sleep 0.3
done
kill "$FPID" 2>/dev/null || true
xcrun simctl status_bar "$DEV" clear || true
exit 1
