// Drill for the two RELEASE-IRONRULES rules that became gates on 2026-08-19:
// 「跨机产物」 (a cross-machine artifact must not be destroyed silently) and
// 「磁盘」 (free space on the REPO's volume, checked before anything is written).
// Named, not numbered: that list renumbered twice while this was being written,
// so the ir2/ir5 in this filename is a stable id for the PAIR, not a coordinate
// into §1 — a §1 item number is exactly the kind of citation this repo's
// coordinate-anchors lint exists to stop people trusting.
//
// SUBJECTS (all public, so this test travels with them in the open-source
// export — IT-12: a test and its subject travel together or not at all):
//   scripts/publish-adopted-artifact-gate.mjs
//   scripts/publish-disk-space-gate.mjs
//   scripts/publish.mjs                      (read as TEXT — see below)
//
// 🔴 publish.mjs IS NEVER IMPORTED OR SPAWNED HERE, and that is not caution
// about speed. It has no isMainModule guard, so importing it RUNS it: the whole
// chain, ending in an upload to the LAN download center. Its wiring is
// therefore verified the only way it safely can be — by reading its bytes and
// asserting call ORDER, which is the property that matters anyway (a gate that
// runs after the removal it governs is not a gate).
//
// Everything else runs against fixtures under os.tmpdir(), never the real
// ./publish: a test that needs a 373 MiB build output in place is a test that
// quietly stops running.
//
// ── REVERSE CONTROL ON §6 ITSELF (2026-08-19, dev-pc-a) ────────────────────
// §6 asserts wiring by reading bytes, so it has to be shown that deleting the
// wiring turns it red. Two arms, publish.mjs restored and diffed byte-identical
// against a backup after each:
//
//   ARM 1 — the disk-gate call line replaced by a comment:
//     FAIL  all three anchors found (if this fails, the anchors rotted — …)
//     FAIL  the disk gate runs BEFORE verify:delivery — …
//     2 FAILURE(S)   (exit 1)
//   ARM 2 — the authoritative (second) cross-machine ask replaced by a literal:
//     FAIL  the cross-machine gate is asked twice (found 1): …
//     FAIL  the authoritative ask precedes rmSync(OUT) — …
//     2 FAILURE(S)   (exit 1)
//
// 🔴 ARM 1 also found a defect IN THIS TEST, which is why it was worth running:
// `indexOf` answers -1 for absent, and -1 < everything, so the ordering
// assertions were passing on a publish.mjs whose gate had been deleted. They
// now re-check `> -1` on their own operands. A negative assertion that cannot
// fail is worse than no assertion — it is the shape CLAUDE.md records as
// 「把缺陷写成了验收标准」.
//
// Run: `node scripts/ir2-ir5-publish-preflight-gates.test.mjs`

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISCARD_FLAG,
  KEEP_FLAG,
  ROUND_PLATFORM,
  adoptedRefusalMessage,
  classifyEntry,
  findCrossMachineArtifacts,
  readDisposition,
  removeAllExcept,
  verifyAdoptedArtifactsSurvive,
} from './publish-adopted-artifact-gate.mjs';
import {
  HEADROOM_FACTOR,
  MEASURED_BUNDLE_MIB,
  MEASURED_PUBLISH_MIB,
  MIN_FREE_MIB,
  ROUND_MIB,
  diskRefusalMessage,
  readFreeSpace,
  repoVolume,
  verifyDiskHeadroom,
} from './publish-disk-space-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECTION_NAMES = [
  '§1 disk threshold is derived',
  '§2 disk verdicts + which volume was measured',
  '§3 cross-machine detection',
  '§4 refusal text + flag hygiene',
  '§5 the clean step keeps exactly the keep set',
  '§6 wiring and call order in publish.mjs',
];

let failures = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); failures++; }
}

/** A publish/ fixture: this round's MSI, the staged portable directory, and
 *  whatever cross-machine files the caller asks for. */
function fixture(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ir25-'));
  const outDir = join(root, 'publish');
  mkdirSync(join(outDir, 'FlowMic-portable', 'resources'), { recursive: true });
  writeFileSync(join(outDir, 'FlowMic-portable', 'resources', 'server.js'), 'sidecar');
  writeFileSync(join(outDir, 'FlowMic_9.9.9_x64_zh-CN.msi'), 'fixture msi');
  writeFileSync(join(outDir, 'FlowMic_9.9.9_x64_zh-CN.msi.sha256'), `${'0'.repeat(64)}  FlowMic_9.9.9_x64_zh-CN.msi\n`);
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(outDir, name), body);
  return { root, outDir };
}

const MAC_ZIP = 'FlowMic-9.9.9-portable-macos-arm64.zip';
const MAC_SHA = '8b1a9953c4611296a827abf8c47804d755ef985ab4d8e5b0a1e0c4d3f2b19a70';

// ── §1 the threshold is arithmetic, not a preference ───────────────────────
section('§1 the disk threshold is DERIVED from measured cost (not a round number someone liked)');
{
  assertTrue(ROUND_MIB === MEASURED_PUBLISH_MIB + MEASURED_BUNDLE_MIB, `one round = ${MEASURED_PUBLISH_MIB} MiB publish/ + ${MEASURED_BUNDLE_MIB} MiB bundle = ${ROUND_MIB} MiB`);
  assertTrue(MIN_FREE_MIB === ROUND_MIB * HEADROOM_FACTOR, `threshold = ${HEADROOM_FACTOR} × ${ROUND_MIB} = ${MIN_FREE_MIB} MiB`);
  // 🔴 The point of this assertion: a threshold that happens to be 1024/2048/
  // 4096 is one somebody chose and then justified. This one has to move when a
  // measurement moves, and the drill would rather be annoying than let the
  // number quietly become a taste.
  assertTrue(MIN_FREE_MIB % 1024 !== 0, `${MIN_FREE_MIB} is not a power-of-two MiB figure — it is the arithmetic`);
  assertTrue(MEASURED_PUBLISH_MIB > 0 && MEASURED_BUNDLE_MIB > 0, 'both terms are real measurements, neither is zero-filled');
}

// ── §2 verdicts, and the volume the reading came from ──────────────────────
section('§2 disk verdicts, and WHICH volume was measured');
{
  const stub = (freeMib) => () => ({ bsize: 4096, blocks: (400_000 * 1024 * 1024) / 4096, bfree: (freeMib * 1024 * 1024) / 4096, bavail: (freeMib * 1024 * 1024) / 4096 });

  assertTrue(readFreeSpace(ROOT, stub(MIN_FREE_MIB)).verdict === 'ok', `exactly ${MIN_FREE_MIB} MiB free ⇒ ok (the boundary is inclusive, stated by the test not guessed at)`);
  const low = readFreeSpace(ROOT, stub(MIN_FREE_MIB - 1));
  assertTrue(low.verdict === 'low' && low.freeMib === MIN_FREE_MIB - 1, `one MiB under ⇒ low, and it reports the figure it measured (${low.freeMib} MiB)`);

  const thrown = readFreeSpace(ROOT, () => { throw new Error('ENOSYS on this filesystem'); });
  assertTrue(thrown.verdict === 'unmeasurable' && /ENOSYS/.test(thrown.reason), 'statfs throwing ⇒ unmeasurable, carrying the reason');
  const garbage = readFreeSpace(ROOT, () => ({ bsize: 0, blocks: 0, bavail: 0 }));
  assertTrue(garbage.verdict === 'unmeasurable', 'a nonsense reading ⇒ unmeasurable, NOT "0 MiB free" (先核你的尺子: a broken ruler must not produce a verdict)');
  assertTrue(/says NOTHING about how much room you have/.test(diskRefusalMessage(garbage)), 'and its refusal says the measurement failed rather than making a claim about the disk');

  // 🔴 THE assertion this gate exists for: the reading is taken through the
  // REPO path. A gate that quietly measured the system volume would be green
  // on the machine whose repo volume is the full one — the exact case the
  // owner's 2026-08-18 ruling separates.
  const seen = [];
  readFreeSpace(ROOT, (p) => { seen.push(p); return { bsize: 4096, blocks: 1, bavail: 1 }; });
  assertTrue(seen.length === 1 && seen[0] === ROOT, `statfs was called with the repo root itself (${seen[0] === ROOT ? 'yes' : JSON.stringify(seen)}) — not a drive letter, not os.tmpdir()`);

  // POSITIVE CONTROL on the real filesystem — without it every assertion above
  // could be passing against a stub of a function that does not work here.
  // Deliberately does NOT assert 'ok': how much room this machine has is not
  // this drill's business, and asserting it would make the test fail for a
  // reason that has nothing to do with the code.
  const real = readFreeSpace(ROOT);
  assertTrue(real.verdict !== 'unmeasurable' && Number.isFinite(real.freeMib) && real.totalMib > 0, `POSITIVE CONTROL: a real reading on this machine — ${real.freeMib} MiB free of ${real.totalMib} MiB on ${real.volume}`);
  assertTrue(real.volume === repoVolume(ROOT), 'and it names the repo volume');

  const lines = [];
  const green = verifyDiskHeadroom(ROOT, () => {}, (m) => lines.push(m), stub(MIN_FREE_MIB + 10));
  assertTrue(green === true && /repo volume/.test(lines[0] ?? ''), `PASS line: ${lines[0] ?? '(none)'}`);
  const refusals = [];
  const red = verifyDiskHeadroom(ROOT, (m) => refusals.push(m), () => {}, stub(10));
  assertTrue(red === false && /10 MiB free/.test(refusals[0] ?? '') && /make room/.test(refusals[0] ?? ''), 'refusal names the measured figure AND the one safe deletion');
}

// ── §3 what counts as a cross-machine artifact ─────────────────────────────
section('§3 cross-machine detection — from the name on disk, no receipt file');
{
  const v = { version: '9.9.9' };
  assertTrue(classifyEntry(MAC_ZIP, v)?.atRisk === true, 'this version\'s adopted macOS zip ⇒ at risk');
  assertTrue(classifyEntry('FlowMic-9.9.9-macos-arm64.zip', v)?.atRisk === true, 'the raw Mac-mini name (no -portable- segment) ⇒ also at risk');
  assertTrue(classifyEntry('FlowMic-9.9.9-portable-linux-x64.zip', v)?.atRisk === true, 'a linux portable zip ⇒ at risk (the rule is not macOS-specific)');
  assertTrue(classifyEntry(`FlowMic-9.9.9-portable-${ROUND_PLATFORM}.zip`, v) === null, `this round's own ${ROUND_PLATFORM} zip ⇒ NOT cross-machine (this run rebuilds it)`);
  assertTrue(classifyEntry('FlowMic_9.9.9_x64_zh-CN.msi', v) === null, 'an MSI ⇒ not in the adoptable set');
  assertTrue(classifyEntry('FlowMic-9.9.9-release.apk', v) === null, 'an APK ⇒ not in the adoptable set');
  assertTrue(classifyEntry(`${MAC_ZIP}.sha256`, v) === null, 'a sidecar is not classified on its own (it rides with its artifact)');
  const stale = classifyEntry('FlowMic-0.0.1-portable-macos-arm64.zip', v);
  assertTrue(stale !== null && stale.atRisk === false, 'a macOS zip for ANOTHER version ⇒ seen, but NOT at risk (refusing there would be a red on correct behaviour)');
  assertTrue(classifyEntry('FlowMic-macos-arm64.zip', v)?.atRisk === true, 'a macOS zip with no version in its name ⇒ at risk (nothing here can prove it belongs to a finished round)');

  // NO FALSE RED — the case that decides whether this gate survives contact
  // with a normal round.
  const plain = fixture();
  try {
    const r = verifyAdoptedArtifactsSurvive({ outDir: plain.outDir, version: '9.9.9', argv: [] });
    assertTrue(r.refusal === null && r.keep.length === 0, `a normal round (MSI + staged portable dir, nothing adopted) ⇒ no refusal, empty keep set — "${r.notice}"`);
  } finally { rmSync(plain.root, { recursive: true, force: true }); }

  const withMac = fixture({ [MAC_ZIP]: 'PKmac', [`${MAC_ZIP}.sha256`]: `${MAC_SHA}  ${MAC_ZIP}\n` });
  try {
    const found = findCrossMachineArtifacts({ outDir: withMac.outDir, version: '9.9.9' });
    assertTrue(found.atRisk.length === 1 && found.atRisk[0].name === MAC_ZIP, 'the real directory read finds exactly the adopted artifact');
    assertTrue(found.atRisk[0].attested === MAC_SHA, 'and reads the attested hash out of its sidecar (the hash the producing machine printed)');
  } finally { rmSync(withMac.root, { recursive: true, force: true }); }
}

// ── §4 the refusal names the file and the flags; flags are strict ──────────
section('§4 refusal text + flag hygiene');
{
  const f = fixture({ [MAC_ZIP]: 'PKmac', [`${MAC_ZIP}.sha256`]: `${MAC_SHA}  ${MAC_ZIP}\n` });
  try {
    const args = { outDir: f.outDir, version: '9.9.9' };
    const bare = verifyAdoptedArtifactsSurvive({ ...args, argv: [] });
    assertTrue(bare.refusal !== null, 'no flag ⇒ REFUSED (the silent destruction is what this gate exists to stop)');
    assertTrue(bare.refusal.includes(MAC_ZIP), 'the refusal names the file at risk');
    assertTrue(bare.refusal.includes(KEEP_FLAG) && bare.refusal.includes(DISCARD_FLAG), 'and names both ways to proceed on purpose');
    assertTrue(bare.refusal.includes(MAC_SHA), 'and prints the attested sha256, so re-adopting afterwards needs only the source file');
    assertTrue(bare.refusal.includes('adopt-artifact.mjs'), 'and names the exact command to re-adopt with');
    assertTrue(bare.keep.length === 0, 'a refusal keeps nothing — it does not half-proceed');

    const keep = verifyAdoptedArtifactsSurvive({ ...args, argv: ['node', 'publish', KEEP_FLAG] });
    assertTrue(keep.refusal === null && keep.keep.join(',') === `${MAC_ZIP},${MAC_ZIP}.sha256`, `${KEEP_FLAG} ⇒ the artifact AND its sidecar are kept (a kept artifact with no sidecar is one the uploader refuses)`);
    const discard = verifyAdoptedArtifactsSurvive({ ...args, argv: ['node', 'publish', DISCARD_FLAG] });
    assertTrue(discard.refusal === null && discard.keep.length === 0 && /destroyed on purpose/.test(discard.notice), `${DISCARD_FLAG} ⇒ proceeds, and SAYS it is destroying them`);

    const both = verifyAdoptedArtifactsSurvive({ ...args, argv: [KEEP_FLAG, DISCARD_FLAG] });
    assertTrue(both.refusal !== null && /opposite things/.test(both.refusal), 'both flags at once ⇒ refused by name, never resolved by precedence');
    const valued = verifyAdoptedArtifactsSurvive({ ...args, argv: [`${KEEP_FLAG}=1`] });
    assertTrue(valued.refusal !== null && /is not accepted/.test(valued.refusal), `${KEEP_FLAG}=1 ⇒ rejected by name (IT-07), not silently read as "unstated"`);
    assertTrue(readDisposition([]).mode === 'unstated' && readDisposition([KEEP_FLAG]).mode === 'keep' && readDisposition([DISCARD_FLAG]).mode === 'discard', 'readDisposition maps the three states');

    // A file with no sidecar still refuses, and says why keeping it would not help.
    const orphan = findCrossMachineArtifacts({ outDir: f.outDir, version: '9.9.9' }).atRisk.map((a) => ({ ...a, hasSidecar: false, attested: null }));
    assertTrue(/NO .*\.sha256 beside it/.test(adoptedRefusalMessage(orphan)), 'an artifact with no sidecar is named as such (the download center would refuse it anyway)');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}

// ── §5 the clean step, and the reverse control that reproduces today's loss ─
section('§5 the clean step keeps EXACTLY the keep set');
{
  const f = fixture({ [MAC_ZIP]: 'PKmac payload', [`${MAC_ZIP}.sha256`]: `${MAC_SHA}  ${MAC_ZIP}\n` });
  try {
    const before = readFileSync(join(f.outDir, MAC_ZIP));
    const keep = verifyAdoptedArtifactsSurvive({ outDir: f.outDir, version: '9.9.9', argv: [KEEP_FLAG] }).keep;
    const r = removeAllExcept(f.outDir, keep);
    const left = readdirSync(f.outDir).sort();
    assertTrue(left.join(',') === `${MAC_ZIP},${MAC_ZIP}.sha256`, `only the kept pair survives (left: ${left.join(', ')})`);
    assertTrue(readFileSync(join(f.outDir, MAC_ZIP)).equals(before), 'the kept artifact is byte-identical — the clean step never touched it');
    assertTrue(r.removed.includes('FlowMic-portable'), 'the staged portable DIRECTORY is removed too (recursive, not skipped as a non-file)');
    assertTrue(!existsSync(join(f.outDir, 'FlowMic_9.9.9_x64_zh-CN.msi')), 'this round\'s own MSI is removed as usual — the round rebuilds it');
  } finally { rmSync(f.root, { recursive: true, force: true }); }

  // 🔴 REVERSE CONTROL: with an empty keep set the adopted artifact is gone.
  // This is not a hypothetical — it is publish.mjs's behaviour before this
  // gate existed, reproduced here so that "the gate is what saves it" is a
  // measured claim rather than a story.
  const g = fixture({ [MAC_ZIP]: 'PKmac payload' });
  try {
    removeAllExcept(g.outDir, []);
    assertTrue(!existsSync(join(g.outDir, MAC_ZIP)), 'REVERSE-CONTROL: keep=[] ⇒ the adopted artifact is destroyed (today\'s silent loss, reproduced)');
    assertTrue(readdirSync(g.outDir).length === 0, 'and publish/ is empty, exactly as rmSync(OUT) would leave it');
  } finally { rmSync(g.root, { recursive: true, force: true }); }
}

// ── §6 wiring: read publish.mjs's bytes, assert ORDER ──────────────────────
section('§6 wiring and call order in publish.mjs (read as text — never imported, it would publish)');
{
  const src = readFileSync(join(ROOT, 'scripts', 'publish.mjs'), 'utf8');
  const at = (needle) => src.indexOf(needle);

  const disk = at('verifyDiskHeadroom(');
  const gate0 = at("spawnSync('pnpm', ['verify:delivery']");
  const clean = at('rmSync(OUT, { recursive: true, force: true })');
  const adoptCalls = [...src.matchAll(/verifyAdoptedArtifactsSurvive\(/g)].map((m) => m.index);

  assertTrue(at("from './publish-disk-space-gate.mjs'") > -1, 'publish.mjs imports the disk gate');
  assertTrue(at("from './publish-adopted-artifact-gate.mjs'") > -1, 'publish.mjs imports the cross-machine gate');
  assertTrue(disk > -1 && gate0 > -1 && clean > -1, 'all three anchors found (if this fails, the anchors rotted — fix the test, not the code)');
  // 🔴 Every ordering assertion below re-checks `> -1` on its own operands, and
  // that is not belt-and-braces: `indexOf` answers -1 for "absent", and -1 is
  // LESS THAN every real index — so a deleted call site would satisfy a bare
  // `a < b` and this section would go green on a publish.mjs with no gate in it
  // at all. Measured while writing the reverse control for exactly that.
  assertTrue(disk > -1 && disk < gate0, 'the disk gate runs BEFORE verify:delivery — i.e. before this process writes a byte (that is what makes it a preflight)');
  assertTrue(adoptCalls.length === 2, `the cross-machine gate is asked twice (found ${adoptCalls.length}): once early for a cheap refusal, once next to the removal it governs`);
  assertTrue(adoptCalls[0] > -1 && adoptCalls[0] < gate0, 'the early ask precedes Gate 0, so an operator is not told after ten minutes');
  assertTrue(adoptCalls[1] > -1 && adoptCalls[1] < clean, 'the authoritative ask precedes rmSync(OUT) — a gate that runs after the removal is not a gate');
  assertTrue(at('removeAllExcept(OUT, adoptedNow.keep') > -1 && at('adoptedNow.keep.length > 0') > -1, 'and the keep set is what decides between the selective clean and the whole-directory wipe');
  assertTrue(/if \(adoptedNow\.refusal\) \{ fail\(adoptedNow\.refusal\); process\.exit\(1\); \}/.test(src), 'the refusal at the clean site EXITS rather than setting a flag somebody might not read again');
}

const acct = `sections run ${SECTION_NAMES.length}/${SECTION_NAMES.length}, no sections skipped`;
console.log(`\nACCOUNTING: ${acct}`);
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
