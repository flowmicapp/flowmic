# NR-114: runs INSIDE a fresh ubuntu:22.04 container (scripts/linux-clean-check.sh,
# only when FLOWMIC_LEGACY_DEB names the old package). 0.3.96 was installed as
# `flow-mic`; the new .deb is `flowmic` and owns the same files, so it must
# replace the old package instead of stopping on a file conflict.
set -u
export DEBIAN_FRONTEND=noninteractive
V="$1"
DEB="/art/FlowMic_${V}_amd64.deb"
OLD="/legacy/$(ls /legacy | grep -E '^FlowMic_.*_amd64\.deb$' | head -1)"
fail() { echo "FAIL $*"; exit 1; }
[ -f "$DEB" ] || fail "no $DEB"
[ -f "$OLD" ] || fail "no legacy .deb under /legacy"
[ "$(dpkg-deb -f "$OLD" Package)" = "flow-mic" ] || fail "$(basename "$OLD") is not the legacy flow-mic package"
apt-get update -qq > /tmp/update.log 2>&1 || fail "apt-get update"
apt-get install -y --no-install-recommends "$OLD" > /tmp/old.log 2>&1 || { tail -20 /tmp/old.log; fail "apt install legacy $OLD"; }
echo "PASS legacy installed: $(dpkg-query -W -f='${Package} ${Version} ${Status}' flow-mic)"
apt-get install -y --no-install-recommends "$DEB" > /tmp/new.log 2>&1 || { tail -20 /tmp/new.log; fail "apt install $DEB over flow-mic"; }
grep -E "^(Removing|Unpacking|Setting up) flow" /tmp/new.log
INSTALLED="$(dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 2>/dev/null | awk '$1 ~ /^.i/ && $2 ~ /^flow/ {print $2}' | sort | tr '\n' ' ')"
[ "$INSTALLED" = "flowmic " ] || fail "installed flow* packages after upgrade: '$INSTALLED', expected only flowmic"
echo "PASS upgrade from flow-mic: installed flow* packages = $INSTALLED"
[ -x /usr/bin/flowmic-desktop ] || fail "/usr/bin/flowmic-desktop missing after upgrade"
dpkg -S /usr/bin/flowmic-desktop
[ "$(dpkg -S /usr/bin/flowmic-desktop | cut -d: -f1)" = "flowmic" ] || fail "/usr/bin/flowmic-desktop not owned by flowmic"
[ -s /usr/share/applications/FlowMic.desktop ] || fail "menu entry missing after upgrade"
echo "PASS upgrade: binary and menu entry owned by flowmic"
apt-get remove -y flowmic > /tmp/remove.log 2>&1 || fail "apt remove flowmic after upgrade"
[ ! -e /usr/bin/flowmic-desktop ] || fail "binary left behind after apt remove flowmic"
echo "PASS apt remove flowmic after upgrade leaves no binary"
