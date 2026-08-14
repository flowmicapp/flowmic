// Fixture-based probes for verify/lint/coordinate-anchors.mjs (IT-55 / IT-59 /
// IT-60 / IT-64 / IT-65). Until this file existed, that lint was the only gate in the suite
// with no test of any kind — the third-iteration ledger's three-arm probe
// (§4.5-1) was run by hand against the live tree and then deleted. This file
// makes those probes a permanent specification, driven against a DISPOSABLE
// fixture tree via the lint's exported scanTree(), so nothing here ever
// touches (or depends on) the real repo's scan face.
//
// Every reference written into a fixture is assembled with cite() so that no
// live `path:NNN` coordinate appears in THIS file's source — this file sits in
// scripts/ and is itself scanned by the lint it tests.
//
// Run directly: `node scripts/coordinate-anchors-lint.test.mjs`

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanTree, findNew } from '../verify/lint/coordinate-anchors.mjs';

let failures = 0;
const section = (title) => console.log(`\n=== ${title} ===`);
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

/** Assemble `<path>:<line>` without writing that shape into this source file. */
const cite = (p, n) => p + ':' + String(n);
const BT = '`'; // backtick, for quoted tokens inside fixture comments

const T = mkdtempSync(join(tmpdir(), 'fmca-fixture-'));
const put = (rel, content) => {
  const abs = join(T, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
};

function hitsFor(scan, file) {
  return scan.hits.filter((h) => h.file === file);
}

try {
  // ── fixture target: `ROOT`-shaped line at 13, countLines at 126 ──────────
  // Mirrors the real _util.mjs shape the ledger's probe used: line 13 contains
  // the word `path` (as path.resolve), countLines is ~113 lines further down.
  const target = [];
  for (let i = 1; i <= 130; i++) target.push(`// filler line ${i}`);
  target[12] = "export const ROOT = path.resolve(here, '..', '..');"; // line 13
  target[125] = 'export function countLines(text) {'; // line 126
  target[99] = "  mode = 'sendinput'; // InjectMode literal"; // line 100
  put('packages/fix/util.mjs', target.join('\n') + '\n');

  // ── §4.5-1 three arms: the SAME false claim (countLines is NOT at line 13),
  //    differing only in which prose word rides along ───────────────────────
  const FALSE_CITE = cite('packages/fix/util.mjs', 13);
  put(
    'scripts/armA.mjs',
    `// The ${BT}path${BT} of ${BT}countLines${BT} is pinned at ${FALSE_CITE} for reuse.\n`
  );
  put('scripts/armB.mjs', `// ${BT}countLines${BT} is defined at ${FALSE_CITE} and reused.\n`);
  put('scripts/armC.mjs', `// countLines is defined at ${FALSE_CITE} along the path.\n`);

  // ── the trap the tightening must NOT spring: an all-lowercase QUOTED
  //    protocol literal is a real anchor ────────────────────────────────────
  put(
    'scripts/literal.mjs',
    `// The ${BT}sendinput${BT} literal branch is assigned at ${cite('packages/fix/util.mjs', 100)}.\n`
  );

  // ── a true claim, for the green control ──────────────────────────────────
  put(
    'scripts/true-claim.mjs',
    `// ${BT}countLines${BT} is defined at ${cite('packages/fix/util.mjs', 126)} (fixture).\n`
  );

  // ── row 8: the same true claim, unwrapped vs re-wrapped (symbol pushed two
  //    physical lines from the coordinate — the shape that used to go red) ──
  put(
    'scripts/wrap-v1.mjs',
    `// The countLines helper counts trailing newlines exactly; see ${cite('packages/fix/util.mjs', 126)}.\n`
  );
  put(
    'scripts/wrap-v2.mjs',
    '// The countLines helper counts trailing\n' +
      '// newlines exactly; see\n' +
      `// ${cite('packages/fix/util.mjs', 126)}.\n`
  );

  // ── row 8 at baseline level: the same FALSE claim, unwrapped vs re-wrapped,
  //    must produce the SAME claim digest ──────────────────────────────────
  put(
    'scripts/digest-v1.mjs',
    `// The countLines helper is exported at ${FALSE_CITE} beside its test.\n`
  );
  put(
    'scripts/digest-v2.mjs',
    '// The countLines helper is\n' + `// exported at ${FALSE_CITE}\n` + '// beside its test.\n'
  );

  // ── IT-60: generated files carrying rotten refs must not be scanned ──────
  put('apps/gen/thing.g.dart', `// bogus: ${cite('packages/fix/util.mjs', 13)} countLines\n`);
  put('apps/gen/thing.freezed.dart', `// bogus: ${cite('packages/fix/util.mjs', 13)} countLines\n`);
  put('apps/gen/real.dart', '// no references here\n');

  const scan = await scanTree(T);

  section('IT-55 ① — three-arm probe (ledger §4.5-1) all arms now red');
  const a = hitsFor(scan, 'scripts/armA.mjs');
  const b = hitsFor(scan, 'scripts/armB.mjs');
  const c = hitsFor(scan, 'scripts/armC.mjs');
  assertTrue(a.length === 1, 'arm A (quoted prose `path` rides along) is RED');
  assertTrue(
    a.length === 1 && a[0].why.startsWith('no anchor within'),
    'arm A fails on the anchor check, not (a)/(b)/(c)'
  );
  assertTrue(b.length === 1, 'arm B (true symbol, false line) is RED — was already caught');
  assertTrue(c.length === 1, 'arm C (sentence-final bare "path.") is RED');
  // Wide-window control for the ±3 discrimination: countLines IS in the target
  // file (line 126), so a whole-file search would pass all three arms; ±3
  // around line 13 refuses them. That is the property ANCHOR_WINDOW's comment
  // claims, checked here by machine instead of by hand.
  assertTrue(
    b.length === 1 && b[0].why.includes('countLines'),
    'arm B tried the true symbol and still failed the ±3 window (whole-file search would pass)'
  );

  section('IT-55 ① — lowercase protocol literal is NOT false-rejected');
  assertTrue(
    hitsFor(scan, 'scripts/literal.mjs').length === 0,
    'quoted `sendinput` anchors a true citation (allowlist, the §4.5-5 trap)'
  );

  section('IT-55 — green control');
  assertTrue(
    hitsFor(scan, 'scripts/true-claim.mjs').length === 0,
    'a true claim with a real symbol at the cited line is GREEN'
  );

  section('IT-55 row 8 — rewrap insensitivity');
  assertTrue(hitsFor(scan, 'scripts/wrap-v1.mjs').length === 0, 'unwrapped true claim is GREEN');
  assertTrue(
    hitsFor(scan, 'scripts/wrap-v2.mjs').length === 0,
    'the SAME claim re-wrapped across three lines stays GREEN (used to go red at ±1 lines)'
  );

  const d1 = hitsFor(scan, 'scripts/digest-v1.mjs');
  const d2 = hitsFor(scan, 'scripts/digest-v2.mjs');
  assertTrue(d1.length === 1 && d2.length === 1, 'both digest probes are RED (false claim)');
  assertTrue(
    d1.length === 1 && d2.length === 1 && d1[0].digest === d2[0].digest,
    'claim digest is identical for wrapped and unwrapped forms — rewrap cannot invalidate a baseline entry'
  );

  section('IT-59 — baseline pins the claim, not just the coordinate');
  const pinned = b[0]; // arm B, as if baselined
  assertTrue(
    findNew([pinned], [pinned.pinKey]).length === 0,
    'a pinned claim at a pinned coordinate is absorbed by the baseline'
  );
  // Same coordinate, invented claim. Under the old coordinate-only baseline
  // this was measured PASS 0 new; the digest must now make it a NEW hit.
  put(
    'scripts/armB.mjs',
    `// Proven safe by the audit of ${FALSE_CITE}: ${BT}countLines${BT} never reallocates.\n`
  );
  const rescan = await scanTree(T);
  const forged = hitsFor(rescan, 'scripts/armB.mjs');
  assertTrue(forged.length === 1, 'the forged claim is still red on its own');
  assertTrue(
    forged.length === 1 && forged[0].key === pinned.key,
    'forged claim occupies the SAME coordinate key (the old baseline slot)'
  );
  assertTrue(
    forged.length === 1 && findNew(forged, [pinned.pinKey]).length === 1,
    'the baselined slot does NOT absorb the invented claim — digest mismatch makes it NEW'
  );

  section('IT-60 — scan face excludes generated files regardless of codegen state');
  assertTrue(scan.generatedExcluded === 2, 'both *.g.dart and *.freezed.dart artifacts excluded');
  assertTrue(
    scan.hits.every((h) => !h.file.endsWith('.g.dart') && !h.file.endsWith('.freezed.dart')),
    'no hit originates from a generated file (its rotten ref is invisible)'
  );
  // Face count: 9 scripts/ probes (armB rewritten, still one file) + 1 target
  // + 1 real.dart — generated files not counted.
  assertTrue(
    rescan.fileCount === 11,
    `face counts only non-generated files (got ${rescan.fileCount}, want 11)`
  );

  // ── IT-64: the pin must certify the TARGET's cited window, not only the
  //    referrer's sentence ──────────────────────────────────────────────────
  // These fixtures are written AFTER the two scans above on purpose: adding
  // files here would otherwise move the face count those assertions pin.
  //
  // The defect being closed (ruling 2026-08-06-it64-anchor-lint-tolerances-are-
  // a-choice.md): before this card the pinKey digested ONLY referrer text, so a
  // baselined coordinate stayed absorbed while the code it points at was
  // rewritten wholesale. The pin certified nothing about the thing it pointed
  // at. The first probe below is the reverse control — it was WATCHED RED
  // against the pre-fix lint and green after.

  // A rotted citation of line 60, of the kind that lives in the baseline: the
  // claimed symbol is nowhere near the cited line, so the hit is RED and would
  // be pinned as a debt.
  const pinTarget = [];
  for (let i = 1; i <= 90; i++) pinTarget.push(`// pinned target filler ${i}`);
  pinTarget[59] = 'export function evictOneUnlockedSocket(map) {'; // line 60
  put('packages/fix/pinned-target.mjs', pinTarget.join('\n') + '\n');
  put(
    'scripts/pinned-claim.mjs',
    `// The ${BT}PAIR_IP_MAX_KEYS${BT} budget is enforced at ${cite('packages/fix/pinned-target.mjs', 60)} (rotted).\n`
  );

  // The invariance pair: same shape, but the target's cited window is only
  // REFORMATTED — reindented, whitespace runs widened, and one word moved
  // across a line break WITHOUT changing the window's line count.
  const invTarget = [];
  for (let i = 1; i <= 90; i++) invTarget.push(`// invariance filler ${i}`);
  invTarget[57] = '//   the evictor walks the map and drops'; // line 58
  invTarget[58] = '//   the first unlocked socket it finds'; // line 59
  invTarget[59] = 'export function evictOneUnlockedSocket(map) {'; // line 60
  put('packages/fix/inv-target.mjs', invTarget.join('\n') + '\n');
  put(
    'scripts/inv-claim.mjs',
    `// The ${BT}SOCKET_IDLE_TTL_MS${BT} budget is enforced at ${cite('packages/fix/inv-target.mjs', 60)} (rotted).\n`
  );

  const scan3 = await scanTree(T);
  const pinnedT = hitsFor(scan3, 'scripts/pinned-claim.mjs');
  const pinnedI = hitsFor(scan3, 'scripts/inv-claim.mjs');

  section('IT-64 — the pin certifies the target window (reverse control)');
  assertTrue(pinnedT.length === 1, 'the rotted citation is RED and therefore pinnable');
  assertTrue(pinnedI.length === 1, 'the invariance citation is RED and therefore pinnable');

  // (a) THE DEFECT: rewrite the target's ±ANCHOR_WINDOW region wholesale. The
  //     referrer sentence is untouched, so the referrer digest cannot notice.
  const rewritten = pinTarget.slice();
  for (let i = 56; i <= 62; i++) rewritten[i] = `// wholly rewritten body, line ${i + 1}`;
  put('packages/fix/pinned-target.mjs', rewritten.join('\n') + '\n');
  const scan4 = await scanTree(T);
  const afterRewrite = hitsFor(scan4, 'scripts/pinned-claim.mjs');
  assertTrue(afterRewrite.length === 1, 'still exactly one hit after the target rewrite');
  assertTrue(
    afterRewrite.length === 1 && afterRewrite[0].key === pinnedT[0].key,
    'the rewrite occupies the SAME coordinate key (same baseline slot)'
  );
  assertTrue(
    afterRewrite.length === 1 && afterRewrite[0].digest === pinnedT[0].digest,
    'the REFERRER digest is unchanged — the referrer half genuinely could not see this'
  );
  assertTrue(
    afterRewrite.length === 1 && afterRewrite[0].targetDigest !== pinnedT[0].targetDigest,
    'the TARGET digest changed when the cited region was rewritten'
  );
  assertTrue(
    afterRewrite.length === 1 && findNew(afterRewrite, [pinnedT[0].pinKey]).length === 1,
    'REVERSE CONTROL: a pinned coordinate goes NEW when its target region is rewritten (was absorbed before IT-64)'
  );

  // (b) INVARIANCE: reformat only. Reindent, widen whitespace runs, and move a
  //     word across a line break inside the window (line count preserved).
  const reflowed = invTarget.slice();
  reflowed[57] = '//\t\t the evictor walks the map   and drops the';
  reflowed[58] = '//  first unlocked   socket it finds';
  reflowed[59] = '    export function evictOneUnlockedSocket(map) {';
  put('packages/fix/inv-target.mjs', reflowed.join('\n') + '\n');
  const scan5 = await scanTree(T);
  const afterReflow = hitsFor(scan5, 'scripts/inv-claim.mjs');
  assertTrue(afterReflow.length === 1, 'still exactly one hit after the target reflow');
  assertTrue(
    afterReflow.length === 1 && afterReflow[0].targetDigest === pinnedI[0].targetDigest,
    'reindent + widened whitespace + a word moved across a line break do NOT move the target digest'
  );
  assertTrue(
    afterReflow.length === 1 && findNew(afterReflow, [pinnedI[0].pinKey]).length === 0,
    'a purely reformatted target stays absorbed by its baseline entry (no churn)'
  );

  // ── IT-65: the TARGET window keeps its comment leaders ────────────────────
  // The defect these two probes close was reproduced twice (adversarial review
  // + supervisor, on the real tree): IT-64 hashed the target window through the
  // REFERRER's normalizer, which strips comment leaders because on the referrer
  // side a leader is noise. On the target side a leader is MEANING. The
  // supervisor's real-tree probe on a baselined coordinate:
  //   append a marker to the cited line          -> FAIL, 3 new   (caught)
  //   prefix `// ` to the cited line (deleted!)  -> PASS, 0 new   (NOT caught)
  // Both probes below were WATCHED RED against the pre-fix lint and green after.

  // (a) The cited line is COMMENTED OUT — semantically deleted, byte-identical
  //     to the pre-fix normalizer's view of it.
  const outTarget = [];
  for (let i = 1; i <= 90; i++) outTarget.push(`// commented-out target filler ${i}`);
  outTarget[59] = 'export function evictOneUnlockedSocket(map) {'; // line 60
  put('packages/fix/commented-target.mjs', outTarget.join('\n') + '\n');
  put(
    'scripts/commented-claim.mjs',
    `// The ${BT}SOCKET_EVICT_BUDGET${BT} rule is enforced at ${cite('packages/fix/commented-target.mjs', 60)} (rotted).\n`
  );

  // (b) A leading `*` is dropped. Chosen because it is the .rs case: `*count`
  //     dereferences, `count` does not, and the old leader regex ate the `*`
  //     (it is also a block-comment interior marker) so the two collided.
  const starTarget = [];
  for (let i = 1; i <= 90; i++) starTarget.push(`// deref target filler ${i}`);
  starTarget[59] = '    *count += 1;'; // line 60
  put('packages/fix/deref-target.mjs', starTarget.join('\n') + '\n');
  put(
    'scripts/deref-claim.mjs',
    `// The ${BT}DEREF_BUDGET${BT} rule is enforced at ${cite('packages/fix/deref-target.mjs', 60)} (rotted).\n`
  );

  const scan6 = await scanTree(T);
  const pinnedOut = hitsFor(scan6, 'scripts/commented-claim.mjs');
  const pinnedStar = hitsFor(scan6, 'scripts/deref-claim.mjs');

  section('IT-65 — comment leaders are MEANING on the target side');
  assertTrue(pinnedOut.length === 1, '(a) the commented-out probe starts RED and is therefore pinnable');
  assertTrue(pinnedStar.length === 1, '(b) the deref probe starts RED and is therefore pinnable');

  const outMut = outTarget.slice();
  outMut[59] = '// export function evictOneUnlockedSocket(map) {';
  put('packages/fix/commented-target.mjs', outMut.join('\n') + '\n');
  const starMut = starTarget.slice();
  starMut[59] = '    count += 1;';
  put('packages/fix/deref-target.mjs', starMut.join('\n') + '\n');
  const scan7 = await scanTree(T);
  const afterOut = hitsFor(scan7, 'scripts/commented-claim.mjs');
  const afterStar = hitsFor(scan7, 'scripts/deref-claim.mjs');

  assertTrue(
    afterOut.length === 1 && afterOut[0].digest === pinnedOut[0].digest,
    '(a) the REFERRER digest is unchanged — the referrer half genuinely cannot see this'
  );
  assertTrue(
    afterOut.length === 1 && afterOut[0].targetDigest !== pinnedOut[0].targetDigest,
    '(a) the TARGET digest changes when the cited line is commented OUT'
  );
  assertTrue(
    afterOut.length === 1 && findNew(afterOut, [pinnedOut[0].pinKey]).length === 1,
    '(a) REVERSE CONTROL: commenting out the cited line makes the pinned hit NEW (was absorbed under IT-64)'
  );
  assertTrue(
    afterStar.length === 1 && afterStar[0].targetDigest !== pinnedStar[0].targetDigest,
    '(b) the TARGET digest changes when a leading `*` is dropped (`*count` vs `count`)'
  );
  assertTrue(
    afterStar.length === 1 && findNew(afterStar, [pinnedStar[0].pinKey]).length === 1,
    '(b) REVERSE CONTROL: dropping a leading `*` makes the pinned hit NEW (collided under IT-64)'
  );

  // ── IT-65 (d): the invariance claim IT-64's header made and did not keep ──
  // IT-64's header claimed "a word moved across a line break at constant line
  // count" is invariant. The closeout review found the exception: when the
  // DONOR line is left holding only its leader it normalizes to '' and the join
  // emitted a double space, so the digest moved. Dropping empties from the
  // words half makes the claim true rather than narrower — pinned here so the
  // header's claim has a machine behind it. Trailing whitespace rides along in
  // the same probe: it is the other invariance the header asserts and nothing
  // pinned it either.
  const donorTarget = [];
  for (let i = 1; i <= 90; i++) donorTarget.push(`// donor target filler ${i}`);
  donorTarget[57] = '// alpha beta'; // line 58
  donorTarget[58] = '// gamma'; // line 59
  donorTarget[59] = 'export function evictOneUnlockedSocket(map) {'; // line 60
  put('packages/fix/donor-target.mjs', donorTarget.join('\n') + '\n');
  put(
    'scripts/donor-claim.mjs',
    `// The ${BT}DONOR_BUDGET${BT} rule is enforced at ${cite('packages/fix/donor-target.mjs', 60)} (rotted).\n`
  );
  const scan8 = await scanTree(T);
  const pinnedDonor = hitsFor(scan8, 'scripts/donor-claim.mjs');
  assertTrue(pinnedDonor.length === 1, '(d) the donor probe starts RED and is therefore pinnable');

  const donorMut = donorTarget.slice();
  donorMut[57] = '//'; // donor left holding ONLY its leader
  donorMut[58] = '// alpha beta gamma'; // same words, same order, same line count
  donorMut[59] = 'export function evictOneUnlockedSocket(map) {   '; // + trailing whitespace
  put('packages/fix/donor-target.mjs', donorMut.join('\n') + '\n');
  const scan9 = await scanTree(T);
  const afterDonor = hitsFor(scan9, 'scripts/donor-claim.mjs');
  assertTrue(
    afterDonor.length === 1 && afterDonor[0].targetDigest === pinnedDonor[0].targetDigest,
    '(d) a word moved across a line break that EMPTIES the donor line, plus trailing whitespace, do NOT move the target digest'
  );
  assertTrue(
    afterDonor.length === 1 && findNew(afterDonor, [pinnedDonor[0].pinKey]).length === 0,
    '(d) that reflow stays absorbed by its baseline entry (no churn)'
  );
} finally {
  rmSync(T, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nOK coordinate-anchors probes' : `\nFAILED ${failures} probe(s)`);
process.exit(failures === 0 ? 0 : 1);
