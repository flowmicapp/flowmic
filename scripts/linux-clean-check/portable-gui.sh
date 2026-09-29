# NR-107: runs INSIDE a fresh ubuntu:22.04 container (scripts/linux-clean-check.sh).
# The launcher's graphical path. Installs Xvfb, zenity, x11-utils (xwininfo) and
# xdotool only; the app's own libraries stay absent.
set -u
export DEBIAN_FRONTEND=noninteractive
V="$1"
ZIP="/art/FlowMic-${V}-portable-linux-x64.zip"
fail() { echo "FAIL $*"; exit 1; }
apt-get update -qq > /tmp/update.log 2>&1 || fail "apt-get update"
apt-get install -y -qq --no-install-recommends unzip xvfb zenity x11-utils xdotool > /tmp/tools.log 2>&1 \
  || fail "install Xvfb/zenity/x11-utils/xdotool"
echo "CHECK webkit2gtk-4.1 / soup-3.0 / javascriptcoregtk-4.1 installed: $(dpkg -l | awk '/^ii/ && $2 ~ /(webkit2gtk-4.1|soup-3.0|javascriptcoregtk-4.1)/' | wc -l)"
cd /tmp && unzip -q "$ZIP" && cd FlowMic-linux-x64 || fail "extract $ZIP"
Xvfb :42 -screen 0 1280x800x24 > /tmp/xvfb.log 2>&1 &
sleep 2
export DISPLAY=:42
FLOWMIC_LAUNCHER_TRACE=1 ./flowmic-desktop > /tmp/l.out 2> /tmp/l.err &
LPID=$!
WID=''
for _ in $(seq 1 20); do
  WID="$(xdotool search --name 'FlowMic cannot start' 2> /dev/null | head -1)"
  [ -n "$WID" ] && break
  sleep 1
done
[ -n "$WID" ] || { cat /tmp/l.err; fail "no message window appeared on the display"; }
echo "PASS a window titled \"$(xdotool getwindowname "$WID")\" is on the display"
ps -eo args | grep '[z]enity --error' | cut -c1-400
xdotool windowfocus --sync "$WID" key Return
for _ in $(seq 1 20); do kill -0 "$LPID" 2> /dev/null || break; sleep 1; done
if kill -0 "$LPID" 2> /dev/null; then pkill -KILL zenity; pkill -KILL xmessage; fail "the launcher did not return after the dialog was closed"; fi
wait "$LPID"
code=$?
grep 'flowmic-launcher:' /tmp/l.err
[ "$code" -eq 127 ] || fail "launcher exited $code after the dialog, expected 127"
grep -q 'notifier=zenity' /tmp/l.err || fail "zenity was not the notifier"
echo "PASS libraries missing, display present: zenity showed the message; OK closed it; launcher exited 127"
