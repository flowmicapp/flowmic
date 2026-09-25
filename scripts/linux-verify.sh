#!/bin/bash
# Linux desktop verification. This is not verify:delivery:fast and writes no
# release receipt. Both feature sets must run: Windows and macOS cannot compile
# Linux-only branches. A failed stage does not conceal the remaining readings.
#
# Run from a Linux checkout: bash scripts/linux-verify.sh
# Dependencies and the pinned sidecar runtime must be prepared first. Building
# the desktop uses the product command, never a bare cargo binary without UI.
# All generated files default to this checkout; WSL callers must keep it on the
# repository volume and must put CARGO_HOME on that volume as well.
set -u
set -o pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
LOGS="$REPO/.local/linux-verify"
mkdir -p "$LOGS"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO/.local/linux-target}"
export TMPDIR="${TMPDIR:-$REPO/.local/linux-tmp}"
mkdir -p "$CARGO_TARGET_DIR" "$TMPDIR"

if [ "$(uname -s)" != Linux ]; then
  echo 'LINUX GATE FAIL | ran: none | skipped: all (Linux host required)'
  exit 1
fi
if ! HEAD_SHA="$(git rev-parse HEAD)"; then
  echo 'LINUX GATE FAIL | ran: none | skipped: all (unattributable checkout)'
  exit 1
fi
echo "Linux desktop verification: commit=$HEAD_SHA"
git status --short
echo "backend: GDK_BACKEND=${GDK_BACKEND:-unset} XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-unset} DISPLAY=${DISPLAY:-unset} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-unset}"
echo "logs: $LOGS"
# Fail as an environment diagnosis before compiling. Do not turn a wrong host
# runtime, DrvFS permission semantics, or Windows dependencies into product reds.
PREREQUISITES=0
prerequisite() {
  echo "PREREQUISITE $1: $2"
  PREREQUISITES=$((PREREQUISITES + 1))
}
PIN="$(tr -d '\r\n' < "$REPO/.node-version")"
ACTUAL_NODE="$(node --version 2>/dev/null || true)"
if [ "$ACTUAL_NODE" != "v$PIN" ]; then
  prerequisite NODE_PIN "expected v$PIN, found ${ACTUAL_NODE:-missing}; put pinned Linux Node on PATH"
fi
PERMISSION_PROBE="$(mktemp "$TMPDIR/linux-permissions.XXXXXX")"
if [ -z "$PERMISSION_PROBE" ]; then
  prerequisite POSIX_TMPDIR "cannot create probe in $TMPDIR; select a writable Linux filesystem"
else
  chmod 600 "$PERMISSION_PROBE"
  if [ "$(stat -c %a "$PERMISSION_PROBE")" != 600 ]; then
    prerequisite POSIX_TMPDIR "$TMPDIR does not preserve mode 0600; set TMPDIR to ext4 (DrvFS without metadata cannot run credential tests)"
  fi
  rm -f "$PERMISSION_PROBE"
fi
if ! (cd "$REPO/apps/desktop" && node --input-type=module -e '
  const { createRequire } = await import("node:module");
  const desktopRequire = createRequire(process.cwd() + "/package.json");
  const viteRequire = createRequire(desktopRequire.resolve("vite"));
  const esbuild = viteRequire("esbuild");
  esbuild.transformSync("let verified = true");
  const rollup = viteRequire("rollup");
  const build = await rollup.rollup({input:"probe",plugins:[{name:"probe",resolveId:()=>"probe",load:()=>"export default true"}]});
  await build.close();
') > "$LOGS/native-dependencies.log" 2>&1; then
  prerequisite LINUX_NATIVE_DEPENDENCIES "esbuild/rollup cannot run; install with pnpm install --frozen-lockfile in a separate Linux checkout, never overwrite a shared Windows node_modules; see $LOGS/native-dependencies.log"
fi
if [ "$PREREQUISITES" -ne 0 ]; then
  echo "LINUX GATE BLOCKED | ran: environment-preflight | skipped: all product stages | prerequisites: $PREREQUISITES"
  exit 2
fi
FAILED=0
RAN=''
run_stage() {
  local name="$1"
  shift
  RAN="${RAN:+$RAN, }$name"
  echo "RUN $name: $*"
  "$@" > "$LOGS/$name.log" 2>&1
  local result=$?
  tail -n 8 "$LOGS/$name.log"
  echo "STAGE $name EXIT=$result"
  if [ "$result" -ne 0 ]; then
    FAILED=$((FAILED + 1))
  fi
}

# The pin may be absent on a baseline tree. Record that failure, then still
# attempt each Rust stage: missing resources are a distinct, visible outcome.
run_stage sidecar pnpm --filter @flowmic/desktop build:sidecar
MANIFEST=apps/desktop/src-tauri/Cargo.toml
run_stage clippy-core cargo clippy --manifest-path "$MANIFEST" --lib --locked -- -D warnings
run_stage clippy-app cargo clippy --manifest-path "$MANIFEST" --lib --features app --locked -- -D warnings
run_stage tests-core cargo test --manifest-path "$MANIFEST" --lib --locked
run_stage tests-app cargo test --manifest-path "$MANIFEST" --lib --features app --locked
run_stage production-preflight cargo test --manifest-path "$MANIFEST" --test linux_production_preflight --features app --locked
run_stage doctests cargo test --manifest-path "$MANIFEST" --doc --locked
run_stage desktop-build pnpm --filter @flowmic/desktop tauri:build

if [ "$FAILED" -ne 0 ]; then
  echo "LINUX GATE FAIL | ran: $RAN | skipped: none | failed: $FAILED"
  exit 1
fi
echo "LINUX GATE PASS | ran: $RAN | skipped: none"
