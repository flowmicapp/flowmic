#!/bin/bash
# NR-107 clean-machine check for the Linux artifacts (RELEASE-IRONRULES §1-28).
#
# The build distro has every -dev package installed, so starting the app there
# proves nothing about a user's machine (0.3.95 shipped that way and did not
# start on a stock Ubuntu 22.04 desktop). This runs each check in a fresh
# `ubuntu:22.04` container with no -dev packages:
#   deb          apt installs the .deb, resolves its dependencies, and `ldd` on
#                the installed binary finds every library;
#   portable     the launcher, without the libraries, exits 127 with the install
#                line on stderr; after running that exact line it execs the real
#                binary;
#   deb/portable also start the real desktop under Xvfb with old distro nodejs
#                on PATH, and require the bundled local service's HTTP 200.
#   portable-gui the launcher's graphical path: under Xvfb, zenity shows the
#                message window (the app's libraries are still absent).
#   deb-upgrade  (only when FLOWMIC_LEGACY_DEB is set, NR-114) installs that old
#                `flow-mic` .deb, then the new `flowmic` one, and requires that
#                only `flowmic` is left installed.
# A container cannot prove the GUI starts on a real desktop: that stays with the
# owner.
#
# Usage (in the Linux build distro, which has docker):
#   bash scripts/linux-clean-check.sh <artifact-dir> <version> [log-dir]
# <artifact-dir> holds FlowMic_<version>_amd64.deb and
# FlowMic-<version>-portable-linux-x64.zip (package-linux-local.mjs output).
set -u
if [ $# -lt 2 ]; then
  echo "usage: bash scripts/linux-clean-check.sh <artifact-dir> <version> [log-dir]" >&2
  exit 2
fi
ARTIFACTS="$(cd "$1" && pwd)" || exit 2
VERSION="$2"
LOGS="${3:-$ARTIFACTS/clean-check-logs}"
CHECKS="$(cd "$(dirname "$0")/linux-clean-check" && pwd)" || exit 2
mkdir -p "$LOGS"
FAILED=0
CHECK_LIST="deb portable portable-gui"
LEGACY_MOUNT=()
if [ -n "${FLOWMIC_LEGACY_DEB:-}" ]; then
  LEGACY_DIR="$(mktemp -d)"
  cp "$FLOWMIC_LEGACY_DEB" "$LEGACY_DIR/" || exit 2
  LEGACY_MOUNT=(-v "$LEGACY_DIR:/legacy:ro")
  CHECK_LIST="$CHECK_LIST deb-upgrade"
fi
TOTAL=$(echo $CHECK_LIST | wc -w)
for check in $CHECK_LIST; do
  docker run --rm -v "$ARTIFACTS:/art:ro" -v "$CHECKS:/checks:ro" "${LEGACY_MOUNT[@]}" ubuntu:22.04 \
    bash "/checks/$check.sh" "$VERSION" > "$LOGS/$check.log" 2>&1
  result=$?
  grep -E '^(CHECK|PASS|FAIL) ' "$LOGS/$check.log"
  echo "CONTAINER $check EXIT=$result (log: $LOGS/$check.log)"
  [ "$result" -eq 0 ] || FAILED=$((FAILED + 1))
done
if [ "$FAILED" -ne 0 ]; then
  echo "LINUX CLEAN CHECK FAIL | failed: $FAILED of $TOTAL"
  exit 1
fi
echo "LINUX CLEAN CHECK PASS | ${CHECK_LIST// /, } on ubuntu:22.04 (GUI on a real desktop is not covered)"
