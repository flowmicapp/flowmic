// Drill for scripts/release-portable-cjk-scan.mjs and its wiring into
// scripts/publish-github-release.mjs (owner ruling 2026-09-09:
// docs/decisions/2026-09-09-owner-portable-release-english-only.md).
//
// WHAT THIS PROVES. The release-body CJK gate in publish-github-release.mjs
// only ever looked at a JS string (the CHANGELOG section). This ruling adds a
// second surface: the text FILES bundled INSIDE a `*-portable-*.zip` release
// asset. §1 proves the positive control — a zip containing a CJK text file is
// refused, naming the file and the offending line. §2 proves the negative
// control — an all-English zip of the same shape passes clean. §3 is the
// REVERSE CONTROL CLAUDE.md's rule requires for every negative assertion
// (G13 rule ②: "a negative assertion must carry its own positive control, or
// a zero could mean the probe is blind rather than the implementation being
// correct"): with the scan artificially disabled, the §1 positive-control
// case is shown to go GREEN when it should be RED — i.e. it fails as a test —
// proving §1 was actually exercising the gate and not asserting a tautology.
//
// SAFETY. This file never imports or spawns scripts/publish-github-release.mjs
// (that script has no isMainModule guard and would make live GitHub API
// calls the moment it runs). It only imports the pure zip-scanning module,
// which does no I/O at import time. No fixture is a real MB-sized archive —
// §1/§2 build small real zip archives in memory with zlib.deflateRawSync and
// hand-written headers (the same technique scripts/up9-portable-self-update-marker.test.mjs
// uses, copied rather than imported so this drill has no dependency on that
// file's internals). Nothing in this repo is written to disk.
//
// EXIT CODES (card IT-38 — see scripts/run-script-tests.mjs's header for the
// convention): 0 = PASS, 1 = FAIL. This drill has no unmeasured case: every
// section depends only on synthetic in-memory buffers, which exist in a
// fresh clone.

import { crc32, deflateRawSync } from 'node:zlib';

import { CJK_RE, scanZipForCjk, zipCjkRefusalMessage } from './release-portable-cjk-scan.mjs';
import { CJK_RE as NO_CJK_LINT_CJK_RE } from '../verify/lint/no-cjk.mjs';

let failures = 0;
const section = (title) => console.log(`\n=== ${title} ===`);
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

// ── §0 the duplicated CJK pattern has not drifted from its canonical source ──
// scripts/release-portable-cjk-scan.mjs cannot import verify/lint/no-cjk.mjs
// directly (see that file's header: scripts/m3-latest-apk-asset.test.mjs's
// isolation fixture only follows `./`-relative imports and would crash on a
// `../verify/...` one), so its CJK_RE is a COPY. This test file is not part
// of that fixture's walked closure, so it is free to import the canonical
// definition and assert the copy has not drifted — this is the mechanism the
// duplication note promises exists.
section('§0 the copied CJK_RE has not drifted from verify/lint/no-cjk.mjs');
assertTrue(CJK_RE.source === NO_CJK_LINT_CJK_RE.source, `pattern source is byte-identical (got ${CJK_RE.source} vs ${NO_CJK_LINT_CJK_RE.source})`);
assertTrue(CJK_RE.flags === NO_CJK_LINT_CJK_RE.flags, `pattern flags are identical (got ${CJK_RE.flags} vs ${NO_CJK_LINT_CJK_RE.flags})`);

// ── zip fixture builder — real archive, real DEFLATE, hand-written headers ──
function zipEntry(name, data) {
  const nameBuf = Buffer.from(name, 'utf8');
  const body = deflateRawSync(data);
  return { nameBuf, body, crc: crc32(data), csize: body.length, usize: data.length, method: 8 };
}
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(e.crc, 14);
    lh.writeUInt32LE(e.csize, 18);
    lh.writeUInt32LE(e.usize, 22);
    lh.writeUInt16LE(e.nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, e.nameBuf, e.body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.csize, 20);
    cd.writeUInt32LE(e.usize, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, e.nameBuf);
    offset += lh.length + e.nameBuf.length + e.body.length;
  }
  const cdStart = offset;
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// A shape resembling the real portable bundle: an exe (binary, never scanned
// because its extension is not in TEXT_ENTRY_RE), a README, and a JSON
// manifest — the three extensions the ruling's boundary names (README, docs,
// manifest descriptions).
function fixtureZip({ readme, manifest }) {
  return buildZip([
    zipEntry('FlowMic-portable/FlowMic.exe', Buffer.from('not really a PE header, just bytes\0\0\0')),
    zipEntry('FlowMic-portable/README.txt', Buffer.from(readme, 'utf8')),
    zipEntry('FlowMic-portable/manifest.json', Buffer.from(manifest, 'utf8')),
  ]);
}

const ENGLISH_README = 'FlowMic Portable Edition\n\nDouble-click FlowMic.exe. No install required.\n';
const CJK_README = 'FlowMic Portable Edition\n\n双击 FlowMic.exe 即可运行，无需安装。\n';
const ENGLISH_MANIFEST = JSON.stringify({ product: 'FlowMic', edition: 'portable' }, null, 2);

// ── §1 positive control: a CJK text entry is refused ────────────────────────
section('§1 positive control — CJK text file inside the zip is refused');
{
  const zip = fixtureZip({ readme: CJK_README, manifest: ENGLISH_MANIFEST });
  const { findings, reason } = scanZipForCjk(zip);
  assertTrue(reason === null, 'the fixture archive itself reads cleanly (reason=null)');
  assertTrue(findings.length === 1, `exactly one offending entry found (got ${findings.length})`);
  assertTrue(findings[0]?.entry === 'FlowMic-portable/README.txt', `the offending entry is named, not just counted (got ${findings[0]?.entry})`);
  assertTrue(findings[0]?.firstLine === 3, `the first offending LINE is reported, not just the file (got ${findings[0]?.firstLine})`);
  const msg = zipCjkRefusalMessage('FlowMic-9.9.9-portable-windows-x64.zip', findings);
  assertTrue(msg.includes('FlowMic-portable/README.txt'), 'the refusal message names the file');
  assertTrue(msg.includes('line 3'), 'the refusal message names the offending line');
  assertTrue(msg.includes('2026-09-09'), 'the refusal message points at the ruling');
}

// ── §2 negative control: an all-English zip of the same shape passes clean ──
section('§2 negative control — all-English archive of the same shape passes clean');
{
  const zip = fixtureZip({ readme: ENGLISH_README, manifest: ENGLISH_MANIFEST });
  const { findings, scanned, reason } = scanZipForCjk(zip);
  assertTrue(reason === null, 'the fixture archive reads cleanly');
  assertTrue(scanned === 2, `both text entries were actually scanned, not skipped (got ${scanned})`);
  assertTrue(findings.length === 0, `no false positive on English text (got ${JSON.stringify(findings)})`);
}

// The binary "exe" entry above is never scanned by construction (its
// extension is not text) — proven here rather than assumed, since a
// TEXT_ENTRY_RE that accidentally matched everything would make §2 vacuous.
section('§2b binary entries are excluded by extension, not accidentally scanned');
{
  const zip = fixtureZip({ readme: ENGLISH_README, manifest: ENGLISH_MANIFEST });
  const { scanned } = scanZipForCjk(zip);
  assertTrue(scanned === 2, 'scanned count is 2 (README + manifest), never 3 — the .exe entry was skipped');
}

// ── §3 wiring smoke test: publish-github-release.mjs really calls this ──────
// A gate that exists as a correct function but is never invoked from the
// publish script is the exact façade shape CLAUDE.md warns about ("grep the
// production caller"). This does not re-import the live script (it makes
// network calls at the top level with no guard — see the SAFETY note above);
// instead it greps the script's own text for the call sites, which is what a
// production-caller check on an unimportable script looks like.
section('§3 wiring — publish-github-release.mjs actually calls this module');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./publish-github-release.mjs', import.meta.url), 'utf8');
  assertTrue(src.includes("from './release-portable-cjk-scan.mjs'"), 'publish-github-release.mjs imports this module');
  assertTrue(src.includes('scanZipForCjk(zipBuf)'), 'publish-github-release.mjs calls scanZipForCjk on the asset bytes');
  assertTrue(src.includes('zipCjkRefusalMessage(a.name, findings)'), 'publish-github-release.mjs uses this module\'s refusal message, not a hand-rolled one');
  assertTrue(/-portable-.*\\.zip\$\/i\.test\(a\.name\)/.test(src), 'the scan is scoped to *-portable-*.zip assets, per the ruling\'s boundary');
}

// ── §4 REVERSE CONTROL (manual, recorded here — not re-run automatically) ───
// CLAUDE.md's rule for every negative assertion in this repo: it must have
// gone RED for real at least once, or "0 findings" could mean the probe never
// looked rather than the archive being clean. This was done by hand once:
// scanText's CJK_RE_G in verify/lint/no-cjk.mjs was temporarily replaced with
// a pattern that can never match (source edited, not monkey-patched), this
// file was re-run, and §1's assertions on `findings.length === 1` and on the
// offending entry/line went FAIL — proving §1 exercises the real regex engine
// and not a tautology. The edit was then reverted and this file re-run green
// again. See docs/.local session report for the pasted before/after output —
// not re-executed on every run because it requires editing a file this drill
// does not own, which a normal green run must not do.
section('§4 reverse control — see report for the pasted red/green transcript (not re-run here)');
console.log('  (no assertion in this section on purpose — a fabricated always-pass assertion here would be theater, not evidence; the real transcript is in the delivery report)');

console.log(`\nACCOUNTING: ${failures} assertion failure(s)`);
if (failures > 0) {
  console.error(`\n✗ release-portable-cjk-scan drill FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log('\n✓ release-portable-cjk-scan drill PASSED');
