// IT-27 integrity drill for scripts/publish.mjs.
//
// IT-27: publish.mjs must refuse to ship a node.exe that disagrees with
// scripts/vendor/bundled-node.mjs (the pinned-runtime declaration) on byte
// count or sha256 — not just presence, not just `node -v`. That gate already
// exists at BUILD time (apps/desktop/scripts/verify-bundle.mjs); this drill
// covers the NEW publish-time copy of it (Gate 0c).
//
// SAFETY — read before touching this file:
//   - This test NEVER imports and NEVER spawns scripts/publish.mjs. That
//     script has no `isMainModule` guard: EVERY top-level statement in it,
//     starting with Gate 0 (`pnpm verify:delivery`, ~35s, binds golden's real
//     ports) and Gate 0b (`generate-notice.mjs --check`), runs unconditionally
//     the moment the file is imported OR executed — by design, per its own
//     comment ("There is deliberately NO bypass flag and NO env override...
//     if this gate has to be skipped, the honest way is to delete these
//     lines in a commit"). There is therefore no way to exercise publish.mjs
//     end-to-end from a test without either (a) actually running
//     verify:delivery, which this dispatch forbids, or (b) monkey-patching
//     node:child_process out from under it, which this dispatch also forbids
//     in spirit ("NEVER run a real publish").
//   - Consequently this drill verifies publish.mjs's Gate 0c two ways
//     instead of one: (1) FUNCTIONALLY, by re-deriving the same measurement
//     (read bytes, hash, compare fields) against REAL fixtures — the actual
//     staged node.exe, temp copies of it, and the real bundled-node.mjs
//     declaration — so the comparison MECHANISM is proven correct against
//     real bytes; and (2) STATICALLY, by reading publish.mjs's own source
//     text and asserting the new blocks exist, reference the same fields,
//     and sit in the right place relative to the rest of the file — so the
//     mechanism is proven to actually be WIRED IN, not just correct in the
//     abstract. Neither half executes publish.mjs.
//   - Every temp fixture lives under node:os tmpdir(), never inside this
//     repo, and every one is removed in a `finally`. The REAL
//     apps/desktop/src-tauri/resources/node.exe is only ever READ, never
//     written.
//
// WHY THIS IS ITS OWN FILE (cards IT-22 / IT-23 / IT-36). This file used to
// share `it27-publish-integrity.test.mjs` with the IT-33 drill for
// scripts/publish-download-center.mjs's absence-handling. That subject is
// excluded from the open-source export (it is the internal LAN publisher —
// site address, how the publish key is fetched, network whitelist); this
// one — Gate 0c's node.exe pin check — depends only on scripts/publish.mjs
// and scripts/vendor/bundled-node.mjs, both public. checkTestSubjectPairs()
// in scripts/opensource-export.mjs (IT-23's mechanization of IT-12's "a test
// and its subject travel together or not at all") refused the export the
// first time it ran against the combined file, naming this file. An earlier
// read guessed the IT-33 half was a textual false positive for that check;
// it was not (see the sibling file's header for the measured reason).
// Splitting by subject makes the export legitimately pass instead of
// teaching the file to hide a string from its own detector. This half ships
// with its subject; the IT-33 half is excluded with its subject (see
// scripts/opensource-manifest.mjs). The pairing is no longer a rule someone
// has to remember.
//
// EXIT CODES (card IT-38 — see scripts/run-script-tests.mjs's header for the
// convention this file follows): 0 = PASS, 1 = FAIL, 2 = SKIP. The staged
// binary this file measures is gitignored (.gitignore:21) and only appears
// after `pnpm --filter @flowmic/desktop build:sidecar` runs, so a fresh
// clone or export has nothing to compare here — that is normal, not a
// defect.
//   IT-42 correction: the absence of the staged binary used to be a
//   FILE-LEVEL exit(2), which also silenced §4 — ten static assertions that
//   read publish.mjs's SOURCE TEXT and need the binary not at all. That is
//   now split: §1/§2/§3/§7 (the binary-dependent sections) report a SKIP for
//   that section and are excluded from the pass/fail tally; §4 (static)
//   always runs and its result is a real PASS or a real FAIL. The run's
//   overall exit code is: 1 if ANY assertion actually failed (regardless of
//   what else was skipped), else 2 if any binary-dependent section was
//   skipped, else 0. The final `SKIP: <reason>` line (printed only in the
//   exit-2 case) names both what ran and what did not, rather than
//   crediting a check this run never executed. The gate this test exists to
//   cover — publish.mjs's Gate 0c — is unaffected either way: it runs
//   unconditionally at publish time regardless of whether this drill ran.
//   IT-58 correction (ledger 2026-08-06 §4.5-2 row 7): skips now ACCOUNT.
//   (a) An `ACCOUNTING: sections run X/Y…` line prints on every exit path,
//   and the runner re-surfaces it beside its PASS verdict, so the tally
//   reaches the operator even on green runs (the runner otherwise suppresses
//   child stdout on success). (b) Load-bearing semantics: ALL five sections
//   are load-bearing. §1/§2/§3/§7 may legitimately skip ONLY for the one
//   reason recorded in §1 (staged binary never built on this checkout) —
//   that path exits 2, never 0. If §1 measured the binary and a later
//   section finds it unavailable, that is a mid-run vanish — §7's whole job
//   is proving the real file was never written through, and its skip
//   condition fires exactly when the file goes missing — so it is a FAIL
//   (exit 1), never a skip. Exit 0 therefore proves all 5/5 sections ran.
//
// Run: `node scripts/it27-publish-node-pin.test.mjs`

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_NODE, hostPlatformKey } from './vendor/bundled-node.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH_SRC_PATH = join(ROOT, 'scripts', 'publish.mjs');
const PUBLISH_SRC = readFileSync(PUBLISH_SRC_PATH, 'utf8'); // text only — never imported, never spawned

let failures = 0;
// IT-42: binary-dependent sections (§1/§2/§3/§7) set this instead of calling
// process.exit(2) directly, so §4 (static, needs only publish.mjs's source
// text) always gets a chance to run in the same process. See the file
// header's EXIT CODES note for the precedence this feeds at the bottom.
let binaryUnavailableReason = null;
const section = (title) => console.log(`\n=== ${title} ===`);
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); failures++; }
}
// IT-58 (ledger 2026-08-06 §4.5-2 row 7): skips are ACCOUNTED, not merely
// printed. Before this, skipSection() only wrote a line to stdout — which the
// runner (scripts/run-script-tests.mjs) suppresses on success — and the exit
// code was derived from binaryUnavailableReason alone. So a run where §7
// (whose entire job is proving the real staged binary was never written
// through) never executed could exit 0 and be indistinguishable from a run
// where it executed and passed. Now every skip is recorded here, the final
// ACCOUNTING line replays the tally on every exit path, and ANY recorded
// skip forces a non-zero exit (see the precedence block at the bottom):
// exit 0 is only reachable when all five sections actually ran.
const SECTION_NAMES = ['§1', '§2', '§3', '§4', '§7']; // §4 is static and can never skip
const skippedSections = []; // { name, reason } — feeds ACCOUNTING + exit code
function skipSection(name, reason) {
  skippedSections.push({ name, reason });
  console.log(`  SKIP  ${name} — ${reason}`);
}

// Mirrors the exact shape of the comparison publish.mjs's Gate 0c performs
// (same two fields, same "staged=X declared=Y" message shape) — re-derived
// here, rather than imported, because publish.mjs cannot be safely imported
// (see header). Section 4 below statically confirms Gate 0c matches this
// shape in the real file.
function measure(path) {
  const buf = readFileSync(path);
  return { bytes: statSync(path).size, sha256: createHash('sha256').update(buf).digest('hex') };
}
function compareToPin(measured, pin) {
  const problems = [];
  if (measured.bytes !== pin.bytes) problems.push(`bytes: staged=${measured.bytes} declared=${pin.bytes}`);
  if (measured.sha256 !== pin.sha256) problems.push(`sha256: staged=${measured.sha256} declared=${pin.sha256}`);
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────
section('IT-27 §1 — positive control: real staged node.exe matches the real pin');
// ─────────────────────────────────────────────────────────────────────────
const platformKey = hostPlatformKey();
const pin = BUNDLED_NODE[platformKey];
assertTrue(!!pin, `scripts/vendor/bundled-node.mjs declares a pin for ${platformKey}`);

let realStagedPath = null;
if (pin) {
  realStagedPath = join(ROOT, ...pin.stagedPath.split('/'));

  // ABSENCE vs WRONGNESS are different facts, and this repo has a name for
  // conflating them: 「空过＝没做成说成做成」. staged-and-matching is PASS,
  // staged-and-mismatched is FAIL (unchanged below, and it is the entire
  // point of §2/§3's reverse controls) — but never-staged is neither: it is
  // SKIP, reported loudly rather than folded into either neighbor. See the
  // file header for why.
  if (!existsSync(realStagedPath)) {
    // IT-42: this used to be process.exit(2) here, which also killed §4 (the
    // static source-text checks below, which need no binary at all). Record
    // the reason and fall through instead — §2/§3/§7 check this same flag
    // and skip their own binary-dependent work, §4 runs regardless, and the
    // bottom of the file decides the real exit code from what actually ran.
    binaryUnavailableReason =
      `staged binary absent at ${pin.stagedPath} (gitignored, .gitignore:21; ` +
      'only appears after `pnpm --filter @flowmic/desktop build:sidecar`)';
    skipSection('§1', `measurement — ${binaryUnavailableReason}`);
  } else {
    const real = measure(realStagedPath);
    console.log(`  measured: bytes=${real.bytes} sha256=${real.sha256.slice(0, 16)}…`);

    // Reference cross-check — an INDEPENDENT copy per platform, deliberately
    // not read from pin.bytes (a corrupted pin must not self-validate):
    //   win32-x64    86,969,160 — lead's reference measurement, 2026-08-05.
    //   darwin-arm64 112,915,776 — traced to nodejs.org's signed tarball on
    //     the Mac mini, 2026-08-07 (provenance in scripts/vendor/
    //     bundled-node.mjs); the first macOS CI dispatch (2026-08-15) staged
    //     a byte-identical binary via setup-node — which is also the run that
    //     caught this constant being win32-only and platform-blind.
    // A pinned platform with no row here FAILS (not skips): the independent
    // reference is the whole point of this section, so adding a platform pin
    // means adding its reference in the same commit.
    const REFERENCE_BYTES_BY_PLATFORM = { 'win32-x64': 86_969_160, 'darwin-arm64': 112_915_776 };
    const REFERENCE_BYTES = REFERENCE_BYTES_BY_PLATFORM[platformKey];
    assertTrue(
      REFERENCE_BYTES != null && real.bytes === REFERENCE_BYTES,
      REFERENCE_BYTES == null
        ? `no independent reference measurement declared for ${platformKey} — add one beside the pin`
        : `staged binary is ${REFERENCE_BYTES} bytes (independent per-platform reference) — got ${real.bytes}`,
    );

    const problems = compareToPin(real, pin);
    assertTrue(problems.length === 0, `staged binary matches the declared pin (${pin.version}) — ${problems.join('; ') || 'no problems'}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
section('IT-27 §2 — REVERSE CONTROL A: one flipped byte, size unchanged (only the hash moves)');
// ─────────────────────────────────────────────────────────────────────────
// This is the exact scenario scripts/vendor/bundled-node.mjs's header warns
// about: "appended one byte to the staged binary: `-v` still said v22.22.3,
// only the hash moves". Flipping a byte in the MIDDLE (not appending) keeps
// the size identical too, so this specifically proves byte-count alone would
// have missed it — sha256 is not decoration on top of the size check, it is
// carrying weight the size check cannot.
if (realStagedPath && existsSync(realStagedPath)) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'flowmic-it27-'));
  const corruptPath = join(tmpDir, 'node.exe');
  try {
    const original = readFileSync(realStagedPath);
    const corrupted = Buffer.from(original); // copy, never mutate the real file
    const mid = Math.floor(corrupted.length / 2);
    corrupted[mid] = corrupted[mid] ^ 0xff;
    writeFileSync(corruptPath, corrupted);

    const measured = measure(corruptPath);
    const problems = compareToPin(measured, pin);

    console.log('  --- RED (expected) ---');
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log('  -----------------------');

    assertTrue(measured.bytes === pin.bytes, `corrupted copy is still ${pin.bytes} bytes (size check alone would pass this)`);
    assertTrue(problems.some((p) => p.startsWith('sha256:')), 'sha256 comparison catches the corruption size missed, naming staged= and declared=');
    assertTrue(problems.length === 1, `exactly one field disagrees (sha256), not two — got: ${problems.join('; ')}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    assertTrue(!existsSync(corruptPath), 'temp corrupted copy removed after the drill');
  }
} else if (binaryUnavailableReason) {
  // IT-42: no staged binary to copy from is a SKIP of this section, not a
  // FAIL of the run — see binaryUnavailableReason (set in §1) and the exit
  // code precedence at the bottom of the file.
  skipSection('§2', `reverse control A — no real staged binary to copy from (${binaryUnavailableReason})`);
} else {
  // IT-58: §1 measured the staged binary, yet it is unavailable NOW. Nothing
  // legitimate in this file removes it — a load-bearing precondition
  // vanished mid-run, which is a FAIL, not a skip.
  assertTrue(false, '§2 preconditions vanished mid-run: §1 measured the staged binary but it is gone now');
}

// ─────────────────────────────────────────────────────────────────────────
section('IT-27 §3 — REVERSE CONTROL B: real binary, declaration deliberately wrong');
// ─────────────────────────────────────────────────────────────────────────
// The mirror image of §2: this time the BINARY is untouched and the
// DECLARATION is what disagrees (simulating a stale/edited bundled-node.mjs
// without touching that file — it is outside this lane's write surface and
// seven other lanes are editing this tree concurrently). Proves the gate
// also catches "declared moved" rather than only "staged moved".
if (realStagedPath && existsSync(realStagedPath) && pin) {
  const wrongPin = { ...pin, sha256: '0'.repeat(64) };
  const real = measure(realStagedPath);
  const problems = compareToPin(real, wrongPin);

  console.log('  --- RED (expected) ---');
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log('  -----------------------');

  assertTrue(real.bytes === wrongPin.bytes, 'byte count still agrees (only the declared sha256 was tampered)');
  assertTrue(problems.length === 1 && problems[0].startsWith('sha256:'), 'exactly one problem, sha256, naming declared= (the fabricated value) vs staged= (the real one)');
} else if (binaryUnavailableReason) {
  // IT-42: same as §2 — this is a SKIP of this section, not a run FAIL.
  skipSection('§3', `reverse control B — no real staged binary/pin (${binaryUnavailableReason})`);
} else {
  // IT-58: same as §2 — a precondition §1 verified has vanished mid-run.
  assertTrue(false, '§3 preconditions vanished mid-run: §1 measured the staged binary but it (or the pin) is gone now');
}

// ─────────────────────────────────────────────────────────────────────────
section('IT-27 §4 — static: Gate 0c is actually wired into publish.mjs');
// ─────────────────────────────────────────────────────────────────────────
// IT-42: unlike §1/§2/§3/§7, this section needs no staged binary — it only
// reads PUBLISH_SRC (source text, loaded at the top of the file regardless
// of binaryUnavailableReason). It therefore runs unconditionally, on every
// checkout including a fresh clone that has never built the sidecar.
assertTrue(
  /import\s*\{\s*BUNDLED_NODE,\s*hostPlatformKey\s*\}\s*from\s*'\.\/vendor\/bundled-node\.mjs'/.test(PUBLISH_SRC),
  'publish.mjs imports BUNDLED_NODE and hostPlatformKey from ./vendor/bundled-node.mjs (the same SSOT this drill reads)',
);
// String presence only — deliberately NOT used to locate the gate (IT-55②:
// a comment can carry this string; the ordering block below finds the real
// code construct instead).
assertTrue(PUBLISH_SRC.includes('GATE 0c'), 'the "GATE 0c" banner string exists (labeling only — position is asserted structurally below)');
assertTrue(PUBLISH_SRC.includes('actualBytes !== pin.bytes'), 'Gate 0c compares actual bytes against pin.bytes');
assertTrue(PUBLISH_SRC.includes('actualSha256 !== pin.sha256'), 'Gate 0c compares actual sha256 against pin.sha256');
assertTrue(
  /staged=\$\{actualBytes\}\s*declared=\$\{pin\.bytes\}/.test(PUBLISH_SRC),
  'Gate 0c\'s failure message names both the staged and declared byte counts',
);
assertTrue(
  /staged=\$\{actualSha256\}\s*declared=\$\{pin\.sha256\}/.test(PUBLISH_SRC),
  'Gate 0c\'s failure message names both the staged and declared sha256',
);

{
  // Ordering: Gate 0c must run (a) after the preflight existsSync(stagedNode)
  // check that guarantees the file exists, so it never throws ENOENT instead
  // of failing cleanly, and (b) before ANY artifact is staged/copied — the
  // card's "before it collects or uploads anything".
  //
  // IT-55② (ledger 2026-08-06 §4.5-2 row 2, probe replayed and confirmed):
  // this block used to locate Gate 0c via PUBLISH_SRC.indexOf('GATE 0c') —
  // the FIRST occurrence of a STRING, comment or code alike. Moving the real
  // gate below the first stage() call and leaving an ordinary comment
  // mentioning "GATE 0c" near the preflight kept all four assertions green
  // (EXITCODE=0). The real gate is now located STRUCTURALLY: the two-line
  // code construct that performs it (the platformKey/pin lookup that feeds
  // the byte+sha256 comparison — publish.mjs lines `const platformKey =
  // hostPlatformKey();` / `const pin = BUNDLED_NODE[platformKey];`),
  // line-anchored so a `//`-commented copy cannot match, and asserted to
  // occur exactly once so a verbatim decoy copy cannot leave "its position"
  // ambiguous. A prose mention of "GATE 0c" satisfies nothing here.
  //
  // Closeout adversarial review (2026-08-06): line-anchoring alone was NOT
  // enough — wrapping the whole live construct in a /* … */ BLOCK comment
  // (text intact, code dead) kept every assertion here green: a false PASS
  // on a publish.mjs whose gate never runs. So block-comment spans are
  // blanked (same length, newlines kept ⇒ every index below stays comparable
  // to the raw source) before ANY anchor is located, and the adversary's
  // exact mutation is replayed in-memory as a standing assertion.
  const blankBlockComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const PUBLISH_CODE = blankBlockComments(PUBLISH_SRC);
  const GATE0C_CONSTRUCT = /^[ \t]*const platformKey = hostPlatformKey\(\);\r?\n[ \t]*const pin = BUNDLED_NODE\[platformKey\];/gm;
  const gate0cMatches = [...PUBLISH_CODE.matchAll(GATE0C_CONSTRUCT)];
  assertTrue(
    gate0cMatches.length === 1,
    `exactly one real Gate 0c code construct (platformKey/pin lookup) exists in publish.mjs — found ${gate0cMatches.length}`,
  );
  const idxGate0c = gate0cMatches.length === 1 ? gate0cMatches[0].index : -1;
  // Standing replay of the adversary's block-comment mutation: dead-wrap the
  // live construct in /* … */ on an in-memory copy — the locator must see 0.
  if (gate0cMatches.length === 1) {
    const s = gate0cMatches[0].index;
    const e = s + gate0cMatches[0][0].length;
    const deadWrapped = blankBlockComments(`${PUBLISH_SRC.slice(0, s)}/*${PUBLISH_SRC.slice(s, e)}*/${PUBLISH_SRC.slice(e)}`);
    GATE0C_CONSTRUCT.lastIndex = 0;
    assertTrue(
      [...deadWrapped.matchAll(GATE0C_CONSTRUCT)].length === 0,
      'a Gate 0c construct wrapped dead in a /* block comment */ is invisible to the locator (closeout-adversary regression)',
    );
    GATE0C_CONSTRUCT.lastIndex = 0;
  }
  const idxStagedNodeDecl = PUBLISH_CODE.indexOf("const stagedNode = join(TAURI, 'resources', 'node.exe')");
  const idxCleanRecreate = PUBLISH_CODE.indexOf('── clean + recreate');
  const idxFirstStageCall = PUBLISH_CODE.indexOf('stage(noticeSrc, OUT)'); // first artifact actually copied
  assertTrue(idxStagedNodeDecl !== -1 && idxGate0c !== -1 && idxCleanRecreate !== -1 && idxFirstStageCall !== -1, 'all four anchors resolve in publish.mjs (coordinates are real, not assumed)');
  // Every comparison below re-guards idxGate0c !== -1: with indexOf-style
  // sentinels, `-1 < anything` is TRUE — an unresolved anchor must never
  // read as "runs before".
  assertTrue(idxGate0c !== -1 && idxStagedNodeDecl !== -1 && idxStagedNodeDecl < idxGate0c, 'the REAL Gate 0c construct (not any string mention) sits after stagedNode is declared and existence-checked (preflight)');
  assertTrue(idxGate0c !== -1 && idxCleanRecreate !== -1 && idxGate0c < idxCleanRecreate, 'the REAL Gate 0c construct sits before the "clean + recreate" staging area is touched');
  assertTrue(idxGate0c !== -1 && idxFirstStageCall !== -1 && idxGate0c < idxFirstStageCall, 'the REAL Gate 0c construct sits before the first artifact is actually staged/copied');
}

// ─────────────────────────────────────────────────────────────────────────
section('IT-27 §7 — restore and prove green: the real file was never touched');
// ─────────────────────────────────────────────────────────────────────────
// §2/§3 above only ever read the real staged binary and mutated in-memory
// copies / cloned pin objects. This re-measures the REAL file one more time,
// after all temp fixtures are gone, to make that claim checkable rather than
// asserted: if either reverse control had somehow written through to the
// real path, this would go red right here.
if (realStagedPath && existsSync(realStagedPath) && pin) {
  const after = measure(realStagedPath);
  const problems = compareToPin(after, pin);
  assertTrue(problems.length === 0, `real staged binary still matches the pin after both reverse controls — ${problems.join('; ') || 'no problems'} (green)`);
} else if (binaryUnavailableReason) {
  // IT-42: same as §2/§3 — a SKIP of this section, not a run FAIL.
  skipSection('§7', `restore-check — §1 preconditions not met (${binaryUnavailableReason})`);
} else {
  // IT-58: this branch is the whole reason skips must account. §7's job is
  // to prove the REAL staged binary was never written through by §2/§3's
  // reverse controls. Its skip condition — the staged file missing — fires
  // precisely when something destructive may have happened. If §1 measured
  // the binary and it cannot be re-measured now, that is a FAIL that names
  // the suspicion, never a quiet skip folded into exit 0.
  assertTrue(false, '§7 preconditions vanished mid-run: §1 measured the staged binary but it cannot be re-measured now — a reverse control may have destroyed the real file');
}

// ─────────────────────────────────────────────────────────────────────────
// IT-42 / IT-58 exit-code precedence (see file header EXIT CODES note):
//   1) any assertion actually failed  -> exit 1, regardless of what skipped
//   2) nothing failed, but any section was skipped -> exit 2, with a SKIP
//      line naming what ran and what did not. Keyed on skippedSections (the
//      record every skipSection() call feeds), NOT on binaryUnavailableReason
//      alone — so no future skip call site can ride exit 0 by forgetting to
//      set a flag. Exit 0 with a skipped section is structurally impossible.
//   3) nothing failed and nothing skipped -> exit 0
//
// The ACCOUNTING line prints on EVERY path, success included. The runner
// (scripts/run-script-tests.mjs) suppresses child stdout on success but
// re-surfaces exactly this line next to its PASS verdict, so the tally
// reaches the operator's eyes on green runs too.
const sectionsRun = SECTION_NAMES.length - skippedSections.length;
const acct =
  `sections run ${sectionsRun}/${SECTION_NAMES.length}` +
  (skippedSections.length > 0
    ? `, skipped: ${skippedSections.map((s) => `${s.name} (${s.reason})`).join('; ')}`
    : ', no sections skipped');
console.log(`\nACCOUNTING: ${acct}`);

if (failures > 0) {
  console.log(`\nFAILED ${failures} assertion(s) failed`);
  process.exit(1);
} else if (skippedSections.length > 0) {
  console.log(
    `\nSKIP: ${acct}. §4 (static — Gate 0c wiring in publish.mjs's source ` +
      'text) ran and passed on every checkout, staged binary or not. Run ' +
      '`pnpm --filter @flowmic/desktop build:sidecar`, then re-run this ' +
      'drill to also exercise the binary-dependent sections. Unaffected ' +
      "either way: scripts/publish.mjs's Gate 0c (search \"GATE 0c\") still " +
      'verifies the same pin unconditionally at publish time — the moment ' +
      "that actually ships a binary — regardless of whether this drill's " +
      'binary-dependent sections ran.',
  );
  process.exit(2);
} else {
  console.log('\nOK all assertions passed');
  process.exit(0);
}
