#!/bin/sh
# mac acceptance run — one command, attributable readings.
#
# ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
# Every gate in this repo runs on Windows. On the Mac mini there was no run at
# all: each measurement was hand-typed over SSH, which cost us twice on
# 2026-08-10 and both failures had the same shape — a green that could not say
# what it was green about.
#
#   1. The tree there was an rsync copy, not a git repo, so `git rev-parse`
#      answered `not a git repository`. A `cargo test` run reported
#      "578 passed / 0 failed" and it was believed to be main. It was measured
#      afterwards to be 194 files behind main (122 modified + 72 missing). The
#      number was real; it answered a different question. On the aligned tree
#      the same command reports 597.
#   2. Source was shipped with `git archive`, which carries the COMMIT time as
#      mtime. cargo correctly concluded nothing had changed and re-ran the old
#      binary — so a fix that was on disk reported failing, with a message that
#      no longer existed in the new source.
#
# So this script's first two jobs are not running tests. They are:
#   (a) refuse to run on a tree that cannot name its commit, and
#   (b) refuse to report a pass when the binary under test may predate the code.
#
# 🔴 An unattributable green is not a green. It is the same class as
# `scanner-blind` in the APK marker gates and in OPS-4: "I don't know" must
# never share a verdict with "it's fine".
#
# ── WHAT IT CANNOT DO (stated, not implied) ──────────────────────────────────
# `pnpm verify:delivery` cannot run here: there is no pnpm and no npm on this
# machine, and node exists ONLY as the runtime we stage into the app bundle.
# So this is NOT the delivery gate; it is the subset that this machine can
# honestly execute. Do not describe a pass here as "verify:delivery passed on
# mac" — that sentence would be false in a way nobody could see.
#
# Usage:  sh scripts/mac-verify.sh            (from the repo root)

set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 2

STAMP_DIR="$HOME/.flowmic-sync"
STAMP="$STAMP_DIR/last-verify-commit"
LOGS="$HOME/.flowmic-sync/logs"
mkdir -p "$LOGS" "$STAMP_DIR"

FAILED=0
SKIPPED=0
# Must exist before section 3 runs, because section 3 is inside `if cargo exists`
# and the summary reads this unconditionally. Under `set -u` an unset variable
# aborts the script — so a machine without cargo would crash at the very end,
# after every test had already passed. Default 0 = "not entitled to define the
# baseline", which is the safe direction: it can only cause an extra UNKNOWN,
# never a silently disarmed guard.
WRITE_STAMP=0
note() { printf '%s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILED=$((FAILED + 1)); }
pass() { printf 'PASS %s\n' "$*"; }
skip() { printf 'SKIP %s\n' "$*"; SKIPPED=$((SKIPPED + 1)); }

note "=== FlowMic mac acceptance run ==="
note "repo: $REPO"
note ""

# ── 0. Attribution. Nothing else runs until this passes. ─────────────────────
# Note the asymmetry on purpose: a missing git, a dirty tree, and a detached
# HEAD are three different problems, and lumping them into one message is how
# the next person ends up guessing.
note "--- 0. can this tree name its commit? ---"
if ! command -v git >/dev/null 2>&1; then
  fail "attribution: no git on this machine — every reading below would be unattributable"
  note ""
  note "REFUSING TO RUN. An unattributable green is not a green."
  exit 1
fi
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  fail "attribution: not a git repository — this is the rsync-copy state that cost us the 578-vs-597 confusion"
  note "  fix: see ~/.flowmic-sync/README.txt (adds git metadata WITHOUT touching the working tree)"
  note ""
  note "REFUSING TO RUN."
  exit 1
fi

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
# The rust subtree's own hash, NOT HEAD. These answer two different questions and
# the staleness check below needs the second one. Measured 2026-08-10: the commit
# that added this very script moved HEAD while touching zero .rs files, so a
# HEAD-based check would have called a correct run "stale". One value answering
# two questions is this repo's #1 defect shape; here it would have made the guard
# cry wolf on every docs-only commit, and a guard that always fires is off.
RUST_TREE="$(git rev-parse "HEAD:apps/desktop/src-tauri/src" 2>/dev/null || echo unknown)"
note "  HEAD  = $HEAD_SHA"
note "  desc  = $(git log --oneline -1 2>/dev/null)"
note "  dirty = $DIRTY tracked file(s)"
if [ "$DIRTY" != "0" ]; then
  # Deliberately a warning, not a refusal: iterating on a fix locally is a
  # legitimate reason to be dirty. What is NOT legitimate is quoting the
  # resulting numbers as "the readings for <commit>", so say so here.
  note "  ⚠️  tree is dirty — readings below belong to NO commit. Do not quote them"
  note "      as '<sha> is green'. Quote them as 'a local edit on top of <sha>'."
fi
pass "attribution ($HEAD_SHA)"
note ""

# ── 1. Locate the toolchain. On this machine NOTHING is on PATH. ─────────────
# `command -v node` is empty here, brew has no node, and there is no nvm. The
# only node on the machine is the runtime we stage into the app bundle — which
# is fine, and is exactly the one `verify-bundle` asserts is the pinned build.
note "--- 1. toolchain (none of these are on PATH on this machine) ---"
NODE="$REPO/apps/desktop/src-tauri/resources/node"
CARGO="$HOME/.cargo/bin/cargo"
FLUTTER="$HOME/development/flutter/bin/flutter"

for pair in "node:$NODE" "cargo:$CARGO" "flutter:$FLUTTER"; do
  tool="${pair%%:*}"
  path="${pair#*:}"
  if [ -x "$path" ]; then
    note "  $tool -> $path"
  else
    note "  $tool -> MISSING ($path)"
  fi
done
note ""

# ── 2. lint (node) ──────────────────────────────────────────────────────────
note "--- 2. verify:lint ---"
if [ -x "$NODE" ]; then
  "$NODE" verify/lint/run-all.mjs >"$LOGS/lint.log" 2>&1
  LINT_EXIT=$?
  tail -1 "$LOGS/lint.log" | sed 's/^/  /'
  if [ "$LINT_EXIT" -eq 0 ]; then
    pass "verify:lint"
  else
    fail "verify:lint (exit $LINT_EXIT) — see $LOGS/lint.log"
  fi
else
  skip "verify:lint — staged node not found; a source tree without it is incomplete, not merely unlintable"
fi
note ""

# ── 3. cargo test, with the staleness check that 2026-08-10 paid for ────────
note "--- 3. cargo test --lib ---"
if [ -x "$CARGO" ]; then
  ( cd apps/desktop/src-tauri && "$CARGO" test --lib ) >"$LOGS/cargo.log" 2>&1
  CARGO_EXIT=$?
  # 🔴 `|| echo 0` is WRONG here and it silently disarmed this whole guard for
  # one run (measured 2026-08-10, first execution of this script): `grep -c`
  # exits 1 when the count is zero, so on zero matches BOTH sides ran and the
  # variable became "0\n0". It printed as two lines ("...: 0" / "0 time(s)"),
  # which is how it was noticed — but the real damage is below: `[ "$COMPILED" =
  # "0" ]` can never be true for "0\n0", so the staleness check was dead in the
  # exact case it exists for. A guard built to catch a false green WAS one.
  # `|| true` swallows the exit code without appending a second line.
  COMPILED="$(grep -c 'Compiling flowmic-desktop' "$LOGS/cargo.log" 2>/dev/null || true)"
  [ -n "$COMPILED" ] || COMPILED=0
  RESULT="$(grep -m1 '^test result:' "$LOGS/cargo.log" 2>/dev/null || echo '(no test result line)')"
  note "  $RESULT"
  note "  recompiled this crate: $COMPILED time(s)"

  LAST=""
  [ -f "$STAMP" ] && LAST="$(cat "$STAMP" 2>/dev/null || echo '')"

  # This is the whole point of the stamp file: it records which rust SOURCE the
  # binary on disk was built from. If the source moved and cargo did NOT rebuild
  # our crate, whatever just ran is older than the code on disk — and it looks
  # exactly like a normal pass.
  #
  # 🔴 Three states, not two. Measured 2026-08-10 on the second run of this
  # script: with no stamp yet (the first run was dirty, so correctly wrote none)
  # this guard fired "STALE" on a run that was in fact fine. It had no baseline
  # to compare against — it did not have the fact its own verdict requires.
  # That is R11 verbatim, in the guard written to enforce attributability. The
  # honest third answer is UNKNOWN, and the next action differs for each:
  # STALE -> touch + rebuild; UNKNOWN -> establish a baseline. Collapsing them
  # sends you to rebuild for several minutes and then to believe the guard works.
  #
  # A baseline may only be written by a run that actually compiled, otherwise a
  # genuinely stale binary gets recorded as "matches current source" and the
  # guard is disarmed for every run after it.
  WRITE_STAMP=0
  STALE=0
  if [ -z "$LAST" ]; then
    if [ "$COMPILED" != "0" ]; then
      note "  baseline established (this run compiled the crate)"
      WRITE_STAMP=1
    else
      note "  ⚠️  staleness UNKNOWN: no baseline, and nothing was compiled this run."
      note "      To establish one: find apps/desktop/src-tauri/src -name '*.rs' -exec touch {} + && re-run"
    fi
  elif [ "$LAST" != "$RUST_TREE" ] && [ "$COMPILED" = "0" ] && [ "$DIRTY" = "0" ]; then
    STALE=1
  else
    WRITE_STAMP=1
  fi

  if [ "$STALE" = "1" ]; then
    fail "cargo test: rust source moved ($LAST -> $RUST_TREE) but the crate was NOT recompiled — you are looking at a STALE binary, not at this commit"
    note "  cause seen before: git archive/rsync carries old mtimes, so cargo sees no change"
    note "  fix: find apps/desktop/src-tauri/src -name '*.rs' -exec touch {} + && re-run"
    note "  the test result line above is real, but it belongs to OLDER code than what is checked out"
  elif [ "$CARGO_EXIT" -eq 0 ]; then
    pass "cargo test --lib"
  else
    fail "cargo test --lib (exit $CARGO_EXIT) — see $LOGS/cargo.log"
  fi
else
  skip "cargo test — cargo not found at $CARGO"
fi
note ""

# ── 4. mobile tests — via make, NEVER via bare `flutter test` ───────────────
# 🔴 `make test` depends on `gen`, and that dependency is load-bearing on any
# fresh checkout. `lib/generated/*.g.dart` is generated from @flowmic/protocol
# and is gitignored, so on this machine it did not exist. Measured 2026-08-10,
# first ever mobile run here with bare `flutter test`:
#
#     484 passed / 142 failed
#     Failed to load ".../timeline_clear_boundary_test.dart":
#       Error when reading 'lib/generated/flowmic_events.g.dart': No such file
#
# One missing build step, 142 red tests, and it fails during COMPILATION — so
# the failures name test files that have nothing wrong with them. The obvious
# misreading ("mobile is broken on mac") is a false defect that would cost a
# day. Same family as UP-7 (bare `flutter build apk` silently drops the
# self-update module), with the failure direction inverted: UP-7 fails silently
# and ships, this fails loudly and wastes time.
#
# `make gen` invokes a bare `node`, which is NOT on PATH here, so the staged
# runtime's directory is prepended for this call only.
note "--- 4. mobile tests (make test = gen + flutter test) ---"
if [ -x "$FLUTTER" ] && command -v make >/dev/null 2>&1 && [ -x "$NODE" ]; then
  (
    cd apps/mobile || exit 2
    PATH="$(dirname "$NODE"):$(dirname "$FLUTTER"):$PATH" make test
  ) >"$LOGS/mobile.log" 2>&1
  MOBILE_EXIT=$?
  tail -3 "$LOGS/mobile.log" | sed 's/^/  /'
  if [ "$MOBILE_EXIT" -eq 0 ]; then
    pass "mobile tests"
  else
    # Distinguish "codegen never ran" from "a test actually failed": they need
    # opposite actions, so they must not share a verdict.
    if grep -q "flowmic_events.g.dart': No such file" "$LOGS/mobile.log" 2>/dev/null; then
      fail "mobile tests: codegen did not run — this is a build-step failure, NOT a product failure; do not report the named test files as broken"
    else
      fail "mobile tests (exit $MOBILE_EXIT) — see $LOGS/mobile.log"
    fi
  fi
else
  skip "mobile tests — need flutter ($FLUTTER), make, and the staged node"
fi
note ""

# ── 5. bundle verification (asserts the staged runtime, by RUNNING it) ──────
note "--- 5. verify-bundle ---"
if [ -x "$NODE" ]; then
  "$NODE" apps/desktop/scripts/verify-bundle.mjs >"$LOGS/bundle.log" 2>&1
  BUNDLE_EXIT=$?
  tail -2 "$LOGS/bundle.log" | sed 's/^/  /'
  if [ "$BUNDLE_EXIT" -eq 0 ]; then
    pass "verify-bundle"
  else
    fail "verify-bundle (exit $BUNDLE_EXIT) — see $LOGS/bundle.log"
  fi
else
  skip "verify-bundle — staged node not found"
fi
note ""

# ── summary ────────────────────────────────────────────────────────────────
# Both conditions are load-bearing and they guard different things.
#   DIRTY=0      — a baseline taken from an edited tree names a commit that was
#                  never built, so every later run compares against fiction.
#   WRITE_STAMP  — set by section 3 only when this run is entitled to define the
#                  baseline. Writing it unconditionally would record a stale or
#                  unknown binary as "matches current source", which disarms the
#                  guard permanently and silently. That is the failure mode this
#                  whole script exists to prevent, so it must not live here.
if [ "$DIRTY" = "0" ] && [ "$WRITE_STAMP" = "1" ]; then
  printf '%s' "$RUST_TREE" >"$STAMP"
fi

note "=== summary ==="
note "  commit  : $HEAD_SHA"
note "  dirty   : $DIRTY tracked file(s)"
note "  failed  : $FAILED"
note "  skipped : $SKIPPED"
note "  logs    : $LOGS"
note ""
note "⚠️  This is NOT verify:delivery. There is no pnpm on this machine, so the"
note "    types/clippy/golden segments did not run. Say what ran, not what the"
note "    gate is called."
if [ "$FAILED" -gt 0 ]; then
  note "RESULT: FAIL ($FAILED)"
  exit 1
fi
if [ "$SKIPPED" -gt 0 ]; then
  note "RESULT: PASS with $SKIPPED skipped — a skip is not a pass, read the list above"
  exit 0
fi
note "RESULT: PASS (all segments ran)"
exit 0
