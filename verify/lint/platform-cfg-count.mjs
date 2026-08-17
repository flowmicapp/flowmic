// verify/lint/platform-cfg-count.mjs
// Pin how many conditionally-compiled non-Windows branches exist in the desktop
// crate, so that adding one cannot pass unnoticed.
//
// ── WHAT THIS DEFENDS AGAINST ────────────────────────────────────────────────
// Every gate in this repo runs on Windows. Code behind `#[cfg(not(windows))]`,
// `#[cfg(unix)]` or `#[cfg(target_os = "macos")]` is NOT COMPILED there, so for
// that code `cargo test` on the lead box has exactly zero proving power — a
// syntax error inside such a branch is green. That is not a defect in the gate;
// it is what conditional compilation means. It is invisible by construction.
//
// Three cases in a single day (2026-08-10) made the cost concrete:
//   - two tests asserted path semantics that only hold on Windows: the Mac said
//     `574 passed; 2 failed` on the very tree where Windows said `593 passed`;
//   - credentials are stored as plaintext only off Windows (the protect function
//     is the identity branch there), and nothing on Windows can observe that;
//   - a comment on the non-Windows `confirm_quit` arm asserted "there is no tray
//     there either, so this branch is never reached in practice" — while macOS
//     reaches it on every tray Quit.
//
// ── WHAT THIS IS, STATED PLAINLY: A TRIPWIRE, NOT A PROOF ────────────────────
// 🔴 This gate cannot verify anything about macOS. It only makes the count
// visible. Editing the constant below is a one-line way to make it green without
// running anything on a Mac — that is not a hole to be plugged, it is the point:
// the same shape as this repo's protocol event-count and error-code-count
// guards. Their value is that changing the number forces you to read the note
// attached to it. Whoever bumps this one reads: run it on the Mac.
//
// ⚠️ Do not describe this gate as "macOS is covered". Say what it does: it
// counts. The only honest judge of a non-Windows branch is a run on the Mac —
// `./scripts/mac-verify.sh` on that machine (see docs/FLEET.md §3).
//
// ── WHAT IT CANNOT SEE (and why the stricter design was rejected) ────────────
// Changing the BODY of an existing branch does not move the count, so this gate
// stays silent on it. The stricter alternative — record the rust subtree hash of
// the last all-green Mac run and fail when it drifts — was considered and
// deliberately NOT built: those branches live in 31 files including `inject/`
// and `shell/`, which change most days, so the gate would be red almost always.
// This repo has already paid for that mistake once and wrote the rule down:
// a gate that is red on arrival is ignored by the next day, which is worse than
// no gate, because it also teaches people to skim past red output.
//
// So the boundary is: this catches a NEW platform branch appearing. Verifying
// what any branch actually does remains a Mac run, enforced socially in FLEET.md
// and not here. Do not widen this comment into a claim the scanner cannot back.

import path from 'node:path';
import { ROOT, walk, readText, rel } from './_util.mjs';
import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/platform-cfg-count.mjs` evaluates this file and exits 0
// without counting anything. On 2026-08-10 that silence was written down as
// "the tripwire did not fire" on a branch that had in fact moved the count —
// one step from retiring a gate that was working. See the guard's header.
//
// ⚠️ Only this lint carries the guard; the other 16 still exit 0 when run
// directly. Not a claim that they are safe — just where the burn happened.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'platform-cfg-count';

const SRC = path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'src');

// Measured 2026-08-10 on dev-pc-a at commit 290863e. If you changed one
// of these numbers, the change is invisible to every gate that runs on Windows:
// run `./scripts/mac-verify.sh` on the Mac (FlowMic-app@100.64.7.142) and quote
// its output, then update the number in the same commit.
//
// `cfg(unix)` 4 → 9 on 2026-08-10 (MAC-08 `ensure_user_only`: the fn, two call
// sites on the load paths, two tests). This is the gate's first real hit, and it
// behaved as designed — it fired on Windows, where none of those five lines
// compile, and the Mac run it demanded is quoted in the unified ledger.
//
// `cfg(target_os = "macos")` 25 → 26 and `cfg(windows)` 62 → 66 on 2026-08-11
// (B3, findings §3-1: `shell/clipboard_copy.rs` became a platform-neutral entry
// — the Windows half keeps the old CF_UNICODETEXT path byte-for-byte behind
// four new #[cfg(windows)] sites, and one new macOS arm dispatches to
// `inject::macos::pasteboard::write_text`).
// 🔴 THE MAC RUN THIS PROTOCOL DEMANDS HAS **NOT** HAPPENED FOR THIS BUMP.
// The change was prepared on the Windows lead box by the LAN lane; the macOS
// half is a PREPARED PATCH ONLY. The device line OWES: `./scripts/mac-verify.sh`
// on the Mac + a real capsule copy pasted into TextEdit, quoted in the ledger,
// before any delivery claim for B3. Updating this number does not stand in for
// that run — it only stops the tripwire from firing on a change that is
// already written down here by name.
// Two spellings added 2026-08-12 (NL-1 lane discovery): a new
// `#[cfg(not(target_os = "windows"))]` stub in inject/sendinput.rs sailed
// through this gate because the patterns pinned the short spellings only —
// the tripwire could not see the long form at all. Counts measured on
// dev-pc-b at the merge of the NL-1 lane: 11 long-form not-windows
// sites (10 predate the pattern and were never counted — this bump is the
// scanner widening, not code moving; the 11th is the NL-1 stub, whose owed
// Mac run is registered in audit-queue row 13) and 26 long-form windows
// sites as an added control.
// 0.3.8 (2026-08-17) — two non-Windows rows moved, and this time the Mac run
// the note demands HAS happened. `shell/autostart.rs` gained a real macOS
// read-back:
//   · `cfg(not(windows))` 24 → 23 — the do-nothing `registered_run_value`
//     narrowed from `not(windows)` to `not(any(windows, target_os = "macos"))`,
//     because macOS is no longer one of the platforms that cannot answer;
//   · `cfg(target_os = "macos")` 26 → 29 — two of the three are real
//     attributes (`registered_run_value`, `launch_agent_path`); ⚠️ THE THIRD IS
//     A COMMENT, the doc line on `launch_agent_command` explaining that a
//     `cfg(target_os = "macos")` change has zero proof on Windows. That is the
//     behaviour already written down below ("this scanner counts attribute text
//     wherever it appears, including inside comments") — recorded here as well
//     because a reader reconciling 3 against `grep -c '#\[cfg'` finds 2.
// 🔴 WHAT THAT STUB COST, since it is the reason the row moved: it returned
// `None`, `verify_enabled` read `None` as「not registered」, and so enabling
// autostart on a Mac reported FAILURE ON EVERY SUCCESS — with a correct
// LaunchAgent on disk the whole time (owner's Mac, 2026-08-17 08:35:29: the
// error line and the plist share a second).
// MEASURED ON THE MAC (Mac mini, FlowMic-app@100.64.7.142, macOS 26.5.1;
// exit codes captured, not inferred):
//   cargo test --lib --features app  → 688 passed; 0 failed  TESTS_EXIT=0
//   cargo test --lib                 → TESTS_NOFEAT_EXIT=0
//   cargo clippy --lib --features app -- -D warnings → CLIPPY_EXIT=0, 0 warnings
//   the four `launch_agent_tests` in particular: 4 passed; 0 failed
// ⚠️ That is NOT `pnpm verify:delivery` on the Mac — that machine has no pnpm.
// Say what ran, not what the gate is called (scripts/mac-verify.sh header).
//
// `cfg(target_os = "macos")` 29 → 32 in the very next commit: `shell/
// accessibility.rs`, which reports the Accessibility permission to the machine
// that can grant it (the switch is in System Settings on the Mac; the refusal
// only ever travelled to the phone in the user's pocket). Same Mac run as
// above — both files were on that machine for it, and the 688-test figure
// includes them.
const EXPECTED = {
  // Non-Windows: not compiled on the lead box. These are the ones that matter.
  'cfg(not(windows))': 23,
  'cfg(not(target_os = "windows"))': 11,
  'cfg(unix)': 9,
  'cfg(target_os = "macos")': 32,
  // Windows side, kept as a CONTROL. If every count collapses at once the
  // scanner broke; if only the non-Windows ones move, the code did. Those two
  // states must not produce the same verdict (the UP-7 marker lesson).
  // 66 → 71 (2026-08-13, LANE 6 / REQ-13-16). Five NEW Windows-only sites, all
  // for the `shell::capsule_watch` forensic instrument: its `mod` declaration
  // plus four touchpoint calls (capsule_resize / capsule_move /
  // capsule_click_through / capsule_drag). Windows-SIDE row, so this bump owes
  // no Mac run — and the non-Windows rows deliberately did not move, because the
  // instrument has no not-windows stub at all.
  // ⚠️ Learned the same day: this scanner counts ATTRIBUTE TEXT wherever it
  // appears, INCLUDING inside comments. Quoting `cfg(not(windows))` twice in a
  // module header moved the non-Windows census 24 → 26 with zero non-Windows
  // code in the change — i.e. prose alone can demand a Mac run. That is the
  // price of the "nobody can misread what it counts" design above and is worth
  // paying, but it has to be known: if a row moves and the diff has no matching
  // Rust item, look for the attribute in a comment before suspecting the code.
  'cfg(windows)': 71,
  'cfg(target_os = "windows")': 26,
  'cfg!(windows)': 4,
};

// ⚠️ Still invisible after the 2026-08-12 widening — DECLARED, not silent
// (census of the whole crate that day, `grep -rEoh '#\[cfg\([^]]*\)\]'`):
// compound forms. The ones that do NOT compile on the lead box and therefore
// carry the same risk as the counted rows: 9× `all(not(target_os =
// "windows"), not(target_os = "macos"))`, 1× `all(not(windows),
// not(target_os = "macos"))`, 1× `all(feature = "app", not(target_os =
// "windows"))`, 1× `all(target_os = "macos", not(test))`.
// 0.3.8 adds five more to this hand-kept census, as the paragraph below
// requires — and all five are genuinely uncounted, because the `macos` pattern
// wants `cfg(` immediately followed by `target_os` and every one of these has
// something in between: 1× `#[cfg(not(any(windows, target_os = "macos")))]`,
// 1× `#[cfg(any(target_os = "macos", test))]` and 1× MACRO-form
// `cfg!(any(windows, target_os = "macos"))` — the constant
// `READ_BACK_IMPLEMENTED`, which exists so that 「no read-back on this
// platform」 and 「nothing is registered」 stop being the same `None` (all three
// in `shell/autostart.rs`); plus 3× `#[cfg(not(target_os = "macos"))]` in
// `shell/accessibility.rs`, the arms that make a Windows build answer
// 「this platform has no such permission」 rather than 「not granted」.
// Pinning those
// needs a cfg-expression parser, which would trade the tripwire's main
// virtue (nobody can misread what it counts) for coverage; rejected for the
// same reason the subtree-hash design above was. If a card adds MORE
// compound platform cfgs, extend this census by hand in the same commit.

// Attribute form `#[cfg(...)]` and macro form `cfg!(...)` are counted
// separately because they are different things: the attribute removes code from
// the build, the macro is a runtime-visible boolean in code that always
// compiles. Only the former can hide a compile error.
const PATTERNS = [
  ['cfg(not(windows))', /#\[cfg\(not\(windows\)\)\]/g],
  ['cfg(not(target_os = "windows"))', /#\[cfg\(not\(target_os\s*=\s*"windows"\)\)\]/g],
  ['cfg(unix)', /#\[cfg\(unix\)\]/g],
  ['cfg(target_os = "macos")', /cfg\(target_os\s*=\s*"macos"\)/g],
  ['cfg(windows)', /#\[cfg\(windows\)\]/g],
  ['cfg(target_os = "windows")', /#\[cfg\(target_os\s*=\s*"windows"\)\]/g],
  ['cfg!(windows)', /cfg!\(windows\)/g],
];

// Which keys sit on the Windows side (control rows). Membership, not
// string-prefix: `cfg(target_os = "windows")` does not start with
// `cfg(windows)`, so the old startsWith test would have routed a control-row
// drift into the "run the Mac" hint.
const WINDOWS_SIDE = new Set(['cfg(windows)', 'cfg(target_os = "windows")', 'cfg!(windows)']);

export default async function run() {
  // `walk` prunes `target/` via DEFAULT_SKIP_DIRS, so dependency build scripts
  // cannot inflate these counts.
  const files = (await walk(SRC)).filter((f) => f.endsWith('.rs'));
  if (files.length === 0) {
    return {
      status: 'FAIL',
      detail: `found 0 .rs files under ${rel(SRC)} — the scan is blind, which is not the same as clean`,
    };
  }

  const counts = Object.fromEntries(PATTERNS.map(([k]) => [k, 0]));
  for (const file of files) {
    const src = await readText(file);
    if (src == null) continue;
    for (const [key, re] of PATTERNS) {
      counts[key] += (src.match(re) ?? []).length;
    }
  }

  // Control assertion. Every count reading zero means the regexes stopped
  // matching rust, not that the crate became platform-neutral.
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return {
      status: 'FAIL',
      detail:
        `0 platform cfg sites across ${files.length} .rs files — this crate has dozens ` +
        `(Windows injection, macOS stubs), so the scanner is blind, not the code neutral`,
    };
  }

  const drift = [];
  const driftKeys = [];
  for (const [key, expected] of Object.entries(EXPECTED)) {
    const actual = counts[key];
    if (actual !== expected) {
      drift.push(`${key}: expected ${expected}, found ${actual}`);
      driftKeys.push(key);
    }
  }

  if (drift.length > 0) {
    const nonWindowsMoved = driftKeys.some((k) => !WINDOWS_SIDE.has(k));
    const hint = nonWindowsMoved
      ? `A non-Windows branch count moved. That code does NOT compile on this machine, so ` +
        `nothing here can tell you whether it works: run ./scripts/mac-verify.sh on the Mac ` +
        `and quote its output, then update EXPECTED in ${rel(path.join(ROOT, 'verify', 'lint', 'platform-cfg-count.mjs'))} in the same commit`
      : `Only Windows-side counts moved; update EXPECTED. (If ALL counts moved, suspect the scanner, not the code.)`;
    return { status: 'FAIL', detail: `${drift.join(' | ')} — ${hint}` };
  }

  const nonWin =
    counts['cfg(not(windows))'] +
    counts['cfg(not(target_os = "windows"))'] +
    counts['cfg(unix)'] +
    counts['cfg(target_os = "macos")'];
  return {
    status: 'PASS',
    detail:
      `${files.length} .rs files, ${nonWin} non-Windows cfg site(s) unchanged ` +
      `(none of them compiled by this gate — see file header)`,
  };
}
