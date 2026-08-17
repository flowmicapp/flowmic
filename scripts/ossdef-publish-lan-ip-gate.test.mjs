// Drill for scripts/publish-lan-ip-gate.mjs — the wiring half of card
// OSS-DEFAULTS face 5.
//
// WHAT THIS GUARDS. scripts/scan-artifact-lan-ip.mjs could answer "do the bytes
// we hand out carry the owner's private ranges?" and nothing called it, through
// two windows, with its own header saying so. The gate under test is the call
// site, plus the accounting that lets that call site be GREEN on a correct tree
// instead of red from birth (the reason the previous release window refused to
// wire it — see the gate's header).
//
// SAFETY — read before touching this file:
//   - This test NEVER imports and NEVER spawns scripts/publish.mjs. That script
//     has no isMainModule guard: every top-level statement runs on import,
//     starting with Gate 0 (`pnpm verify:delivery`, minutes, binds golden's real
//     ports) and ending with an upload to the owner's LAN download centre.
//     publish.mjs is read here as TEXT ONLY. Same rule as the UP-7 drill.
//   - It DOES import scripts/publish-lan-ip-gate.mjs, which is pure at import
//     (its refuseDirectRun guard only fires when node's entry script IS that
//     file). That is why the gate is a separate module from the publisher: the
//     drill exercises the SAME functions publish.mjs calls, rather than
//     re-deriving them — a test that re-implements its subject proves only that
//     the test agrees with itself.
//   - Every fixture lives under node:os tmpdir() and is removed in a `finally`.
//     Nothing in this repo is written. No real build artifact is modified: §5
//     builds its own tree rather than planting an address in apps/desktop/.
//
// 🔴 FIXTURES ARE BUILT FROM `RANGES`, NEVER FROM A TYPED-OUT ADDRESS. The public
// export rewrites the ranges tree-wide by literal substitution, so a hand-typed
// address here would have to be rewritten by that same pass to keep meaning the
// same thing — and a hand-typed one that the pass happens to miss becomes a test
// asserting about an address the exported tree no longer contains. Deriving the
// fixture from the imported literal makes that impossible by construction. The
// sibling drill records the same trap from the other direction (its "10.1.2.3 IS
// CHOSEN, NOT ARBITRARY" note).
//
// EXIT CODES (card IT-38, scripts/run-script-tests.mjs): 0 = PASS, 1 = FAIL,
// 2 = SKIP. This file never skips — every section runs on synthetic fixtures and
// repo source text, both of which exist in a fresh clone.
//
// Run: `node scripts/ossdef-publish-lan-ip-gate.test.mjs`

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RANGES, CONTROL } from './scan-artifact-lan-ip.mjs';
// The account itself, not just the number derived from it — see §1 on why a
// budget of 0 and a missing row must not read the same.
import { WAIVERS } from '../verify/lint/no-lan-ip.mjs';
import {
  DECLARED_CARRIERS,
  LAN_IP_SCAN_TARGETS,
  classifyFindings,
  lanIpRefusalMessage,
  presetCatalogueBudget,
  scanPublishArtifactsForLanIp,
  verifyArtifactsCarryNoLanIp,
} from './publish-lan-ip-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH_SRC = readFileSync(join(ROOT, 'scripts', 'publish.mjs'), 'utf8'); // text only
const GATE_SRC = readFileSync(join(ROOT, 'scripts', 'publish-lan-ip-gate.mjs'), 'utf8');

const [OFFICE_LAN, PROD_VPN] = RANGES;
const BUDGET = presetCatalogueBudget();

let failures = 0;
let sectionsRun = 0;
const TOTAL_SECTIONS = 6;
const section = (title) => {
  sectionsRun += 1;
  console.log(`\n=== ${title} ===`);
};
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

const SIDECAR_REL = 'apps/desktop/src-tauri/resources/server.js';
const FRONTEND_REL = 'apps/desktop/dist/assets/main-Fixture01.js';

/** One preset-catalogue entry's worth of bytes, exactly as the real catalogue
 *  lands in a bundle: a labelled endpoint literal. */
const presetEntry = (i) => `{label:"LAN preset ${i}",endpoint:"http://${OFFICE_LAN}68:${9000 + i}/v1"}`;

/** A stand-in for a built bundle: the CONTROL token (every real artifact carries
 *  the product name), `presets` catalogue entries, and whatever extra text the
 *  caller wants to plant. */
function bundleText({ presets = 0, extra = '' } = {}) {
  const entries = Array.from({ length: presets }, (_, i) => presetEntry(i)).join(',');
  return `/*${CONTROL} bundle*/const H="127.0.0.1";const P=[${entries}];${extra}`;
}

/** Writes a fake artifact tree under a fresh tmp root and returns its path. */
function fixtureRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'ossdef-gate-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

// ── §1 what is scanned, and what is deliberately not ────────────────────────
section('§1 the gate reads the artifacts about to ship, not last round’s output');
{
  assertTrue(LAN_IP_SCAN_TARGETS.includes(SIDECAR_REL), 'the sidecar bundle is scanned');
  assertTrue(LAN_IP_SCAN_TARGETS.includes('apps/desktop/dist'), 'the built desktop frontend is scanned');
  // 🔴 THE ONE THAT MATTERS. The scanner's own DEFAULT_TARGETS include publish/,
  // and at the moment this gate runs publish/ still holds LAST round's
  // artifacts — publish.mjs clears it further down. A gate that refused this
  // round over last round's bytes would be measuring somebody else's build,
  // which is exactly what the previous window caught itself doing by hand.
  assertTrue(
    !LAN_IP_SCAN_TARGETS.some((t) => t === 'publish' || t.startsWith('publish/')),
    'publish/ is deliberately NOT a target (it holds the previous round at gate time)',
  );
  // 🔴 THIS ASSERTION USED TO BE `BUDGET > 0`, AND 0.3.8 MADE IT FALSE ON A
  // CORRECT TREE. The catalogue stopped carrying the owner's office addresses
  // (owner 2026-08-17: no built-in personalised configuration in the STT/LLM
  // settings), so the declared budget is legitimately 0 — and the old assertion
  // was the only thing standing between「the account says zero because the
  // catalogue is clean」and「the account says zero because the waiver row
  // vanished」. Deleting it would have thrown that distinction away, which is
  // the same 「unknown must not share a verdict with fine」 rule this whole gate
  // is built on.
  //
  // ⇒ the guard moved to the TABLE instead of the number: the row must still be
  // there, and it must still explain itself. A missing row also yields 0 (§3
  // pins that separately), and now the two are told apart here.
  assertTrue(Number.isInteger(BUDGET) && BUDGET >= 0, `the declared budget is a count (${BUDGET})`);
  {
    const row = WAIVERS.find((w) => w.file === 'packages/protocol/src/engine-presets.ts');
    assertTrue(row !== undefined, 'the preset catalogue still has a waiver ROW — 0 is an account, not an absence');
    assertTrue(row?.code === BUDGET, 'and the budget this gate reads is that row’s own code count');
  }
}

// ── §2 the four verdicts ────────────────────────────────────────────────────
section('§2 leak / blind / nothing-to-scan / ok are four different answers');
{
  // (a) a declared carrier carrying exactly the catalogue → ok
  {
    const root = fixtureRoot({ [SIDECAR_REL]: bundleText({ presets: BUDGET }) });
    try {
      const scan = scanPublishArtifactsForLanIp([SIDECAR_REL], root);
      assertTrue(scan.verdict === 'ok', 'declared carrier with exactly the catalogue → ok');
      assertTrue(scan.undeclared.length === 0, '…and nothing lands in the UNDECLARED column');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // (a-bis) 🔴 THE DECLARED COLUMN ITSELF, which case (a) stopped exercising the
  // day the real budget became 0: with nothing to find, `declared` is empty for
  // the right reason and an empty `declared` proves nothing about the machinery.
  // So it is driven directly, with a SYNTHETIC budget — `classifyFindings` takes
  // one precisely so this can be asked without a catalogue to point at.
  // ⚠️ Synthetic on purpose. Making the fixture match today's real budget would
  // re-couple this assertion to a number that is now expected to stay 0 forever,
  // i.e. it would go quiet again and stay quiet.
  {
    const synthetic = 3;
    const finding = { file: SIDECAR_REL, range: OFFICE_LAN, count: synthetic };
    const exact = classifyFindings([finding], synthetic);
    assertTrue(
      exact.declared.length === 1 && exact.undeclared.length === 0,
      'a carrier whose count IS the budget lands in the DECLARED column',
    );
    const fewer = classifyFindings([{ ...finding, count: synthetic - 1 }], synthetic);
    assertTrue(
      fewer.undeclared.length === 1,
      '…and one FEWER is undeclared — a stale account reads as evidence somebody checked',
    );
  }
  // (b) one address beside the catalogue → leak
  {
    const root = fixtureRoot({
      [SIDECAR_REL]: bundleText({ presets: BUDGET, extra: `const X="http://${OFFICE_LAN}99:9999";` }),
    });
    try {
      const scan = scanPublishArtifactsForLanIp([SIDECAR_REL], root);
      assertTrue(scan.verdict === 'leak', 'catalogue + 1 → leak (budget+1 is not the declared count)');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // (c) an undeclared FILE with a single hit → leak, even below the budget.
  // This is the case a `count <= budget` rule would have waved through.
  {
    const root = fixtureRoot({
      'apps/desktop/dist/assets/vendor-Fixture01.js': bundleText({ extra: `const X="http://${OFFICE_LAN}99:1";` }),
    });
    try {
      const scan = scanPublishArtifactsForLanIp(['apps/desktop/dist'], root);
      assertTrue(scan.verdict === 'leak', 'a NON-carrier file with 1 hit → leak, though 1 is under the budget');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // (d) the VPN range is in no account at all
  {
    const root = fixtureRoot({ [SIDECAR_REL]: bundleText({ extra: `const V="http://${PROD_VPN}68:8080";` }) });
    try {
      const scan = scanPublishArtifactsForLanIp([SIDECAR_REL], root);
      assertTrue(scan.verdict === 'leak', 'the VPN range is never declared, even in a declared carrier');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // (e) blind — files read, control absent. NOT reportable as clean.
  {
    const root = fixtureRoot({ [SIDECAR_REL]: 'const h="127.0.0.1";// no product token here\n' });
    try {
      const scan = scanPublishArtifactsForLanIp([SIDECAR_REL], root);
      assertTrue(scan.verdict === 'blind', 'zero hits + control absent → blind, NOT ok');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // (f) nothing to scan — the scanner's exit 2 case A.
  {
    const root = mkdtempSync(join(tmpdir(), 'ossdef-gate-empty-'));
    try {
      const scan = scanPublishArtifactsForLanIp([SIDECAR_REL], root);
      assertTrue(scan.verdict === 'nothing-to-scan', 'no target exists → nothing-to-scan, NOT ok');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // (g) precedence: a tree that is both blind AND hit-free must read blind, and
  // a tree with nothing in it must not be reported as "blind" (that would claim
  // files were read). One wrong verdict here sends an operator down the wrong road.
  {
    const scanNothing = scanPublishArtifactsForLanIp([join(tmpdir(), `ossdef-absent-${Date.now()}`)], ROOT);
    assertTrue(scanNothing.verdict === 'nothing-to-scan' && scanNothing.scanned === 0, 'nothing-to-scan is decided before blind');
  }
}

// ── §3 both directions of the declared count ────────────────────────────────
section('§3 the declared count is exact — MORE is new debt, FEWER is a stale account');
{
  const mk = (count) => [{ file: SIDECAR_REL, range: OFFICE_LAN, count }];
  assertTrue(classifyFindings(mk(BUDGET), BUDGET).undeclared.length === 0, `exactly ${BUDGET} → declared`);
  assertTrue(classifyFindings(mk(BUDGET + 1), BUDGET).undeclared.length === 1, `${BUDGET + 1} → undeclared (something rode in beside the catalogue)`);
  // 🔴 The half that is easy to leave out, and the reason `<=` was not written:
  // a shrunken count reads as evidence somebody checked, while actually meaning
  // the waiver in verify/lint/no-lan-ip.mjs no longer describes the tree.
  assertTrue(classifyFindings(mk(BUDGET - 1), BUDGET).undeclared.length === 1, `${BUDGET - 1} → undeclared (stale account, not a clean bill)`);
  // The budget comes from the lint's WAIVERS table, not from a copy kept here.
  assertTrue(
    /WAIVERS/.test(GATE_SRC) && /no-lan-ip\.mjs'/.test(GATE_SRC),
    'the budget is READ from verify/lint/no-lan-ip.mjs, not duplicated',
  );
  assertTrue(
    presetCatalogueBudget([]) === 0,
    'a missing waiver entry yields budget 0 — every hit becomes undeclared rather than silently blessed',
  );
  assertTrue(DECLARED_CARRIERS.every((c) => c.why && c.why.length > 0), 'every declared carrier states WHY it may carry the catalogue');
}

// ── §4 the refusals an operator actually reads ──────────────────────────────
section('§4 each refusal names WHAT leaked, FROM WHERE, and what to do — and they differ');
{
  const leakScan = {
    verdict: 'leak', scanned: 2, controlSeen: 2, budget: BUDGET, targets: LAN_IP_SCAN_TARGETS,
    findings: [], declared: [], undeclared: [{ file: SIDECAR_REL, range: OFFICE_LAN, count: 1, carrier: null }],
  };
  const leak = lanIpRefusalMessage(leakScan);
  assertTrue(leak.includes(SIDECAR_REL), 'leak refusal names the ARTIFACT the address came from');
  assertTrue(leak.includes(OFFICE_LAN), 'leak refusal names the RANGE that matched');
  // Verbatim in the scanner's own `<file>: <count> × <range>` shape, so the
  // publish boundary and a hand-run of the scanner read identically.
  assertTrue(leak.includes(`${SIDECAR_REL}: 1 × ${OFFICE_LAN}`), 'the finding is surfaced in the scanner’s own hit format');
  assertTrue(/refusing to stage anything/i.test(leak), 'leak refusal says nothing gets staged');

  const blind = lanIpRefusalMessage({ ...leakScan, verdict: 'blind', undeclared: [] });
  assertTrue(/BLIND/.test(blind), 'blind refusal says the scan is blind');
  assertTrue(/NOTHING about whether the bytes are clean/i.test(blind), 'blind refusal refuses to make a claim about the artifact');
  // 🔴 The two must not send anyone down the same road: one means "find the
  // leak", the other means "the ruler is broken, do not go leak-hunting".
  assertTrue(!/refusing to stage anything/i.test(blind) && !blind.includes(`× ${OFFICE_LAN}`), 'blind refusal does NOT report a leak it did not find');

  const nothing = lanIpRefusalMessage({ ...leakScan, verdict: 'nothing-to-scan', scanned: 0, undeclared: [] });
  assertTrue(/NOTHING TO SCAN/.test(nothing), 'nothing-to-scan refusal says so in its own words');
  assertTrue(/build:sidecar/.test(nothing), 'nothing-to-scan refusal names the action (build first)');
  assertTrue(!/BLIND/.test(nothing), 'nothing-to-scan is NOT spelled as blind — 0 files read is a different fact from 0 controls seen');
  assertTrue(nothing !== blind && blind !== leak, 'all three refusals are distinct texts');
}

// ── §5 red then green, through the same function publish.mjs calls ──────────
// §2 proved the verdicts. This proves the whole path an operator hits: bytes on
// disk → the exported gate → refusal, and the same path going green when the
// planted address is removed. A gate that has never been seen red is not known
// to be capable of going red.
section('§5 RED then GREEN through verifyArtifactsCarryNoLanIp() on real files');
{
  const planted = `http://${OFFICE_LAN}99:9999/v1`;
  const root = fixtureRoot({
    [SIDECAR_REL]: bundleText({ presets: BUDGET, extra: `const LEAK="${planted}";` }),
    [FRONTEND_REL]: bundleText({ presets: BUDGET }),
  });
  try {
    const refusals = [];
    const oks = [];
    const red = verifyArtifactsCarryNoLanIp((m) => refusals.push(m), (m) => oks.push(m),
      [SIDECAR_REL, 'apps/desktop/dist'], root);
    assertTrue(red === false, 'RED: a planted LAN address refuses the publish');
    assertTrue(refusals.length === 1, '…with exactly one refusal message');
    console.log('\n--- verbatim refusal ---\n' + refusals[0] + '\n------------------------');
    assertTrue(refusals[0].includes(SIDECAR_REL), '…naming the artifact');
    assertTrue(refusals[0].includes(OFFICE_LAN), '…naming the range');

    // Remove ONLY the planted address; the catalogue stays. The two states
    // differ in that one string and nothing else, so the verdict flip is
    // attributable to it.
    writeFileSync(join(root, SIDECAR_REL), bundleText({ presets: BUDGET }));
    const okMsgs = [];
    const green = verifyArtifactsCarryNoLanIp((m) => refusals.push(m), (m) => okMsgs.push(m),
      [SIDECAR_REL, 'apps/desktop/dist'], root);
    assertTrue(green === true, 'GREEN: the same path accepts the catalogue alone');
    assertTrue(refusals.length === 1, '…adding no further refusal');
    console.log(`  green line: ${okMsgs[0]}`);
    assertTrue(/declared preset-catalogue occurrence/.test(okMsgs[0] ?? ''), '…and the pass line reports the declared account rather than claiming "clean"');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── §6 wiring: the gate is not merely correct, it is CALLED ─────────────────
// A correct mechanism nobody invokes is this repo's headline historical bug
// class — and it is the exact history of this scanner, which sat uncalled
// through two windows. publish.mjs cannot be spawned here (see the header), so
// the wiring is proven from its source text.
section('§6 publish.mjs calls it, before anything is staged, with no bypass');
{
  assertTrue(
    /import\s*\{[^}]*verifyArtifactsCarryNoLanIp[^}]*\}\s*from\s*'\.\/publish-lan-ip-gate\.mjs'/s.test(PUBLISH_SRC),
    'publish.mjs imports verifyArtifactsCarryNoLanIp from publish-lan-ip-gate.mjs',
  );
  assertTrue(
    /from '\.\/scan-artifact-lan-ip\.mjs'/.test(GATE_SRC),
    'the gate imports the scanner’s functions (no shelling out, no second implementation)',
  );
  const callIdx = PUBLISH_SRC.indexOf('verifyArtifactsCarryNoLanIp(fail, ok)');
  assertTrue(callIdx !== -1, 'it is called with the publisher’s own fail/ok collectors');
  assertTrue(
    /if \(!verifyArtifactsCarryNoLanIp\(fail, ok\)\) process\.exit\(1\)/.test(PUBLISH_SRC),
    'a refusal exits non-zero rather than being collected and forgotten',
  );
  // 🔴 ORDER IS THE REQUIREMENT. Anything after the staging section has already
  // copied the sidecar into publish/ and the portable bundle — by then the leak
  // is staged for distribution and refusing is too late.
  const firstStage = PUBLISH_SRC.indexOf('stage(noticeSrc, OUT)');
  const clearOut = PUBLISH_SRC.indexOf('rmSync(OUT,');
  assertTrue(firstStage !== -1 && callIdx < firstStage, 'the gate runs BEFORE the first stage() call');
  assertTrue(clearOut !== -1 && callIdx < clearOut, 'and before publish/ is cleared and recreated');
  // No bypass, matching Gate 0's precedent.
  assertTrue(
    !/SKIP_LAN_IP|--force-lan|FLOWMIC_SKIP_LAN_IP|ALLOW_LAN_IP/.test(PUBLISH_SRC) &&
      !/SKIP_LAN_IP|--force-lan|FLOWMIC_SKIP_LAN_IP|ALLOW_LAN_IP/.test(GATE_SRC),
    'no skip flag or env override exists for this gate',
  );
  assertTrue(!/process\.env\./.test(GATE_SRC), 'the gate module reads no environment variable at all');
  // The stale claim must not survive the wiring that falsified it.
  const SCANNER_SRC = readFileSync(join(ROOT, 'scripts', 'scan-artifact-lan-ip.mjs'), 'utf8');
  assertTrue(
    !/⚠️ NOT WIRED INTO/.test(SCANNER_SRC),
    'the scanner’s "NOT WIRED / OPEN ACCOUNT" header no longer states it as current fact',
  );
}

console.log(
  `\nACCOUNTING: sections run ${sectionsRun}/${TOTAL_SECTIONS}, ${failures} assertion failure(s), ` +
    `declared preset budget ${BUDGET}/bundle from verify/lint/no-lan-ip.mjs`,
);
if (failures > 0) {
  console.error(`\n✗ OSS-DEFAULTS publish LAN-IP gate drill FAILED (${failures} assertion(s))`);
  process.exit(1);
}
if (sectionsRun !== TOTAL_SECTIONS) {
  console.error(`\n✗ drill ran ${sectionsRun}/${TOTAL_SECTIONS} sections — a partial run is not a pass.`);
  process.exit(1);
}
console.log('\n✓ OSS-DEFAULTS publish LAN-IP gate drill PASSED');
