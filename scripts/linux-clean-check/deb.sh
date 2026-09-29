# NR-107: runs INSIDE a fresh ubuntu:22.04 container (scripts/linux-clean-check.sh).
set -u
export DEBIAN_FRONTEND=noninteractive
V="$1"
DEB="/art/FlowMic_${V}_amd64.deb"
fail() { echo "FAIL $*"; exit 1; }
echo "CHECK image: $(. /etc/os-release; echo "$PRETTY_NAME")"
echo "CHECK -dev packages before: $(dpkg -l | awk '/^ii/ && $2 ~ /-dev(:|$)/' | wc -l)"
echo "CHECK webkit2gtk-4.1 / soup-3.0 / javascriptcoregtk-4.1 before: $(dpkg -l | awk '/^ii/ && $2 ~ /(webkit2gtk-4.1|soup-3.0|javascriptcoregtk-4.1)/' | wc -l)"
[ -f "$DEB" ] || fail "no $DEB"
# NR-114: the Debian package name is flowmic (Tauri alone would write flow-mic).
PKG="$(dpkg-deb -f "$DEB" Package)"
[ "$PKG" = "flowmic" ] || fail "dpkg-deb -f Package is '$PKG', expected flowmic"
echo "PASS dpkg-deb -f Package: $PKG"
# The minimized ubuntu:22.04 image tells dpkg to skip /usr/share/doc/* (its
# /etc/dpkg/dpkg.cfg.d/excludes); a desktop install has no such file. Without
# this, the NOTICE check below reads the image, not the package. (Measured
# 2026-09-27, same image: the 0.3.96 Tauri-built .deb, whose data.tar names
# entries without the leading ./, still installed its NOTICE; the NR-114 repack,
# which writes dpkg-deb's standard ./ names, had it filtered out.)
rm -f /etc/dpkg/dpkg.cfg.d/excludes
apt-get update -qq > /tmp/update.log 2>&1 || fail "apt-get update"
apt-get install -y -qq --no-install-recommends nodejs > /tmp/host-node.log 2>&1 || fail "install distro nodejs"
echo "CHECK old host Node before deb install: $(/usr/bin/node --version)"
/usr/bin/node -e 'if (+process.versions.node.split(".")[0] >= 22) process.exit(1)' || fail "host Node is not old"
apt-get install -y --no-install-recommends "$DEB" > /tmp/install.log 2>&1 || { tail -20 /tmp/install.log; fail "apt install $DEB"; }
echo "PASS apt install $(basename "$DEB") resolved its dependencies ($(grep -c '^Setting up' /tmp/install.log) packages set up)"
dpkg -s flowmic | grep -E '^(Package|Status|Version|Depends|Provides|Conflicts|Replaces):' || fail "dpkg -s flowmic"
dpkg -l flowmic | tail -1
ldd /usr/bin/flowmic-desktop > /tmp/ldd.txt || fail "ldd /usr/bin/flowmic-desktop"
if grep -q 'not found' /tmp/ldd.txt; then grep 'not found' /tmp/ldd.txt; fail "ldd reports missing libraries"; fi
echo "PASS ldd /usr/bin/flowmic-desktop: $(wc -l < /tmp/ldd.txt) libraries, 0 not found"
grep -E 'webkit2gtk-4.1|javascriptcoregtk-4.1|soup-3.0' /tmp/ldd.txt
for f in /usr/lib/FlowMic/resources/node_modules/*/*.so /usr/lib/FlowMic/resources/node_modules/*/*.node; do
  [ -e "$f" ] || continue
  if ldd "$f" | grep -q 'not found'; then fail "ldd $f reports missing libraries"; fi
done
echo "PASS native addon libraries: 0 not found"
ls /usr/lib/x86_64-linux-gnu/libayatana-appindicator3.so.1 > /dev/null 2>&1 || fail "tray library (dlopen'd at runtime) not installed"
echo "PASS tray library present (dlopen'd at runtime, not in DT_NEEDED)"
[ "$(/usr/lib/FlowMic/resources/node --version)" = "v22.22.3" ] || fail "bundled node"
for f in /usr/lib/FlowMic/resources/server.js /usr/share/doc/flowmic/NOTICE /usr/share/applications/FlowMic.desktop; do
  [ -s "$f" ] || fail "payload missing: $f"
done
ls /usr/share/icons/hicolor/*/apps/flowmic-desktop.png > /dev/null 2>&1 || fail "menu icon"
echo "PASS payload: bundled node v22.22.3, server.js, NOTICE, menu entry and icons"
cat /usr/share/applications/FlowMic.desktop
timeout 15 /usr/bin/flowmic-desktop > /tmp/start.log 2>&1
code=$?
head -c 500 /tmp/start.log; echo
if grep -q 'error while loading shared libraries' /tmp/start.log; then fail "the loader refused the binary"; fi
grep -q 'Failed to initialize GTK' /tmp/start.log || fail "headless start did not reach GTK init (exit $code)"
echo "PASS headless start got past the loader to GTK init (no display in a container)"
source /checks/local-service.sh
check_local_service /usr/bin/flowmic-desktop /usr/lib/FlowMic/resources/node /usr/lib/FlowMic/resources/server.js
# NR-114: the uninstall command the user is told is `sudo apt remove flowmic`.
apt-get remove -y flowmic > /tmp/remove.log 2>&1 || { tail -20 /tmp/remove.log; fail "apt remove flowmic"; }
[ ! -e /usr/bin/flowmic-desktop ] || fail "/usr/bin/flowmic-desktop still present after apt remove flowmic"
dpkg -s flowmic 2>/dev/null | grep -q '^Status: install ok installed' && fail "flowmic still installed after apt remove"
echo "PASS apt remove flowmic: package removed, /usr/bin/flowmic-desktop gone"
