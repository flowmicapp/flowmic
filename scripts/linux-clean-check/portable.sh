# NR-107: runs INSIDE a fresh ubuntu:22.04 container (scripts/linux-clean-check.sh).
set -u
export DEBIAN_FRONTEND=noninteractive
V="$1"
ZIP="/art/FlowMic-${V}-portable-linux-x64.zip"
fail() { echo "FAIL $*"; exit 1; }
echo "CHECK image: $(. /etc/os-release; echo "$PRETTY_NAME"); -dev packages: $(dpkg -l | awk '/^ii/ && $2 ~ /-dev(:|$)/' | wc -l)"
[ -f "$ZIP" ] || fail "no $ZIP"
apt-get update -qq > /tmp/update.log 2>&1 || fail "apt-get update"
apt-get install -y -qq --no-install-recommends nodejs > /tmp/host-node.log 2>&1 || fail "install distro nodejs"
echo "CHECK old host Node before portable extraction: $(/usr/bin/node --version)"
/usr/bin/node -e 'if (+process.versions.node.split(".")[0] >= 22) process.exit(1)' || fail "host Node is not old"
apt-get install -y -qq --no-install-recommends unzip > /tmp/unzip.log 2>&1 || fail "install unzip (extraction tool only)"
cd /tmp && unzip -q "$ZIP" && cd FlowMic-linux-x64 || fail "extract $ZIP"
ls -la
LINKS="$(ldd ./flowmic-desktop | awk '{print $1}' | grep -v -E '^(linux-vdso\.so\.1|libc\.so\.6|/lib64/ld-linux-x86-64\.so\.2)$' || true)"
[ -z "$LINKS" ] || fail "launcher links more than libc: $LINKS"
echo "PASS launcher links libc only"
./.flowmic-desktop-bin > /tmp/old.log 2>&1
echo "CHECK what the pre-NR-107 layout did (real binary started directly): exit=$? $(head -1 /tmp/old.log)"

env -u DISPLAY -u WAYLAND_DISPLAY FLOWMIC_LAUNCHER_TRACE=1 ./flowmic-desktop > /tmp/missing.out 2> /tmp/missing.err
code=$?
cat /tmp/missing.err
[ "$code" -eq 127 ] || fail "launcher without libraries exited $code, expected 127"
grep -q '^sudo apt install ' /tmp/missing.err || fail "no install line on stderr"
grep -q 'notifier=stderr (no DISPLAY or WAYLAND_DISPLAY)' /tmp/missing.err || fail "stderr fallback not chosen"
echo "PASS libraries missing, headless: exit 127, install line on stderr, notifier=stderr"

DISPLAY=:99 FLOWMIC_LAUNCHER_TRACE=1 ./flowmic-desktop > /dev/null 2> /tmp/nodisplay.err
code=$?
grep 'flowmic-launcher:' /tmp/nodisplay.err
[ "$code" -eq 127 ] && grep -q 'no graphical notifier could be started' /tmp/nodisplay.err \
  || fail "DISPLAY set with no notifier installed: expected the stderr fallback"
echo "PASS DISPLAY set but no zenity/notify-send/xmessage: falls back to stderr"

CMD="$(grep '^sudo apt install ' /tmp/missing.err | sed 's/^sudo //')"
echo "CHECK running the printed line verbatim (container is root, so without sudo): $CMD"
$CMD -y --no-install-recommends > /tmp/libs.log 2>&1 || { tail -20 /tmp/libs.log; fail "the printed install line failed"; }
missing="$(ldd ./.flowmic-desktop-bin | grep -c 'not found')"
[ "$missing" -eq 0 ] || fail "after the printed install line, ldd still reports $missing missing"
echo "PASS the printed install line alone makes ldd on the real binary clean"

env -u DISPLAY -u WAYLAND_DISPLAY FLOWMIC_LAUNCHER_TRACE=1 timeout 15 ./flowmic-desktop > /tmp/start.log 2>&1
head -c 600 /tmp/start.log; echo
grep -q 'flowmic-launcher: libraries present; exec' /tmp/start.log || fail "launcher did not exec"
grep -q 'Failed to initialize GTK' /tmp/start.log || fail "the real binary did not reach GTK init"
echo "PASS libraries present: the launcher execs the real binary (it reaches GTK init; no display in a container)"
source /checks/local-service.sh
check_local_service "$PWD/flowmic-desktop" "$PWD/node" "$PWD/resources/server.js"
