// RT-6-a drill for scripts/audio-ab-score.mjs, scripts/audio-ab-eval.mjs and
// scripts/audio-ab-adapters.mjs.
//
// WHY THIS FILE EXISTS. The bed's whole job is to produce numbers that a human
// will quote into a ledger and then rule on. A measuring instrument nobody
// measures is worse than no instrument: it produces something that LOOKS like a
// product measurement and is not. This drill drives the bed with a FAKE adapter
// that returns known text, so every score it produces is known in advance —
// no network, no engine, no corpus required.
//
// SAFETY:
//   - It imports the three subject modules. All three are pure at import time
//     (imports + declarations only; audio-ab-eval.mjs's CLI sits behind an
//     isMainModule guard, asserted in §7), so importing runs nothing.
//   - It NEVER calls a real adapter's `transcribe`. §6 calls `probe()` on the
//     real legs, which is contractually forbidden from downloading, installing
//     or spending money — that contract is itself asserted there.
//   - Every file it writes lives under os.tmpdir() and is removed in a finally.
//     Nothing in this repo is written.
//
// WHAT A GREEN RUN DOES NOT PROVE, stated so nobody reads more into it: that
// either real engine transcribes correctly. §6 measures reachability, not
// accuracy. The sherpa and soniox `transcribe` paths are exercised by the bed's
// CLI against a real engine, and that is a separate, reported measurement.
//
// EXIT CODES (card IT-38 convention — see scripts/run-script-tests.mjs's header):
// 0 = PASS, 1 = FAIL, 2 = SKIP. This file never skips as a whole: §1–§7 and
// §9–§11 depend only on repo source text and synthetic strings. §2's
// differential against the J2 original and §8's real-corpus calibration need
// `.local/` material that a fresh clone does not have; each is counted as unmeasured
// in its own bucket, never as a pass.
//
// ─────────────────────────────────────────────────────────────────────────────
// §9–§11 WERE ADDED AFTER THE BED PRODUCED A FALSE PRODUCT FINDING (2026-08-10)
// ─────────────────────────────────────────────────────────────────────────────
// §1–§8 were all green on the day a dead Soniox session (`server error 408`)
// was scored as speech, published as `recall 0.0000`, and carried into a ledger
// row and two commits. Nothing here was wrong; the drill simply never asked
// whether a row was a MEASUREMENT before asking what it measured. So:
//
//   §9  — a session that did not complete cannot become a recall number, and a
//         leg that never answered cannot "recover" a span. The subject is a
//         SIMULATED dead session at the adapter seam; no network is involved.
//   §10 — the word-boundary blindness (`getUserProfile` vs `get user profile`),
//         proven blind first and then given its own signal, with a property
//         check pinning the two normalisations together.
//   §11 — every leg must declare who assembled its text, and every report must
//         say so above the first number.
//
// 🔴 The lesson §9 encodes, stated once here because it generalises past this
// bed: BEFORE ASSERTING THAT A NUMBER IS RIGHT, ASSERT THAT IT IS A NUMBER
// ABOUT THE THING YOU THINK. §7 already asserted `segments === 0` for a leg
// where every segment crashed — and never looked at the `1.0000` the same
// object was printing beside it.
//
// Run: `node scripts/rt6-audio-ab-eval.test.mjs`
// Also run automatically by `pnpm verify:scripts` (inside verify:delivery),
// which DISCOVERS scripts/*.test.mjs by glob rather than by a hand-kept list.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  normalize, normalizeKeepSpace, extractPoints, scoreSegment, scoreOne, aggregate,
  lengthSignal, spanSurvival, deriveSpans, missingShape, DUP_SUSPECT_RATIO,
} from './audio-ab-score.mjs';
import {
  loadCorpus, readWavPcm, runLeg, compare, renderReport, parseArgs, assertOutsideGit, safeFileName, DEFAULT_CORPUS,
} from './audio-ab-eval.mjs';
import {
  parseSpec, buildAdapter, fakeAdapter, ADAPTERS, inspectSherpaModel, resolveSherpaModelDir,
  SHERPA_FILES, SHERPA_RECOGNIZER, SONIOX_CLEAN_FINISH,
} from './audio-ab-adapters.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TOTAL_SECTIONS = 11;

let failures = 0;
let unmeasured = 0;
let sectionsRun = 0;
const samples = {};

function assertTrue(cond, msg) {
  if (cond) { console.log(`    ✓ ${msg}`); return true; }
  failures += 1;
  console.error(`    ✗ ${msg}`);
  return false;
}
function assertEq(got, want, msg) {
  const ok = Object.is(got, want);
  if (ok) { console.log(`    ✓ ${msg} (${JSON.stringify(got)})`); return true; }
  failures += 1;
  console.error(`    ✗ ${msg} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  return false;
}
function notMeasured(what, why) {
  unmeasured += 1;
  console.log(`    ⚠ unmeasured: ${what}\n      ${why}`);
}
// Sections are awaited one at a time. Two of them are async, and letting those
// run detached would print the ACCOUNTING line before their assertions had a
// chance to fail — a green summary covering work that had not finished is the
// same false-report shape this whole bed exists to prevent.
async function section(title, fn) {
  console.log(`\n${title}`);
  sectionsRun += 1;
  await fn();
}

// A reference long enough that a 10%-ish loss is expressible, in the register
// the corpus actually uses (spoken Mandarin with embedded English jargon).
const REF = '明天下午三点在十二楼小会议室过一下 API 的 schema，把上周 review 剩下的两个问题也带上。';

/** Real WAV bytes — the bed reads the header rather than assuming it. */
function mkWav(samplesN) {
  const pcm = Buffer.alloc(samplesN * 2);
  for (let i = 0; i < samplesN; i += 1) pcm.writeInt16LE(Math.round(3000 * Math.sin(i / 12)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Build a two-segment corpus under os.tmpdir(), hand it to `fn`, always remove
 * it. Nothing in this repo is written — see this file's SAFETY note.
 *
 * @param {(corpus: ReturnType<typeof loadCorpus>) => Promise<void>|void} fn
 */
async function withTempCorpus(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'rt6-corpus-'));
  try {
    writeFileSync(join(tmp, 'seg-01.wav'), mkWav(16000));
    writeFileSync(join(tmp, 'seg-02.wav'), mkWav(8000));
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify({
      version: 1,
      segments: {
        1: { file: 'seg-01.wav', script: REF, duration_sec: 1.0, sample_rate: 16000 },
        2: { file: 'seg-02.wav', script: '把上周 review 剩下的两个问题也带上', duration_sec: 0.5, sample_rate: 16000 },
      },
    }));
    await fn(loadCorpus(tmp));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
await section('§1 the metric behaves the way the J2 original does (literal cases)', () => {
  let n = 0;

  // (a) identity
  const a = scoreSegment(REF, REF);
  assertEq(a.recall, 1.0, 'identical strings score exactly 1.0'); n += 1;
  assertEq(a.missing.length, 0, 'and lose nothing'); n += 1;

  // (b) legitimate polish must NOT read as loss
  const polished = '明天下午三点，在十二楼小会议室，过一下 API 的 schema。把上周 review 剩下的两个问题也带上。';
  const b = scoreSegment(REF, polished);
  assertTrue(b.recall >= 0.95, `re-punctuation is not content loss (recall ${b.recall.toFixed(4)} >= 0.95)`); n += 1;

  // (c) a dropped tail
  const c = scoreSegment(REF, REF.slice(0, Math.floor(REF.length / 2)));
  assertTrue(c.recall < 0.8, `half the script dropped scores < 0.8 (${c.recall.toFixed(4)})`); n += 1;
  assertTrue(c.missing.length > 0, 'and names what went missing'); n += 1;

  // (d) empty
  const d = scoreSegment(REF, '');
  assertEq(d.recall, 0.0, 'an empty hypothesis scores 0.0'); n += 1;
  assertEq(d.missing.length, extractPoints(normalize(REF)).length, 'and every reference point is reported missing'); n += 1;

  // (e) extra text must not reduce recall — the property the whole metric choice rests on
  const e = scoreSegment(REF, `好的没问题，${REF}，另外我再补一句。`);
  assertEq(e.recall, 1.0, 'added text does not reduce recall (recall, not F-score, on purpose)'); n += 1;

  samples['§1 metric behaviour'] = n;
});

// ---------------------------------------------------------------------------
await section('§2 differential against the J2 original in .local (the port is not a fork)', async () => {
  const ORIGINAL = join(ROOT, '.local', 'n1-eval', 'segment-score.mjs');
  if (!existsSync(ORIGINAL)) {
    samples['§2 J2 differential'] = 0;
    notMeasured(
      'the port could not be diffed against the J2 original',
      `${ORIGINAL} is absent (.local is gitignored, so a fresh clone never has it). ` +
      'This is counted as UNMEASURED, not as a pass: a direction with zero samples is a skip. ' +
      '§1 above still pins the port against the original\'s own documented behaviour.',
    );
    return;
  }
  const orig = await import(pathToFileURL(ORIGINAL).href);
  let n = 0;
  // Real corpus text when available, literal text otherwise — the point is that
  // the two implementations agree bit for bit on whatever they are both fed.
  const pairs = [
    [REF, REF],
    [REF, REF.slice(0, 20)],
    [REF, ''],
    [REF, `${REF}${REF}`],
    ['今天天气很好下午记得带伞开会别忘了带电脑', '今天天气很好'],
  ];
  if (existsSync(join(DEFAULT_CORPUS, 'manifest.json'))) {
    const c = loadCorpus(DEFAULT_CORPUS);
    if (c.segments.length >= 2) {
      // P3's C2 control: ref = seg1+seg2, hyp = seg1 — a whole segment lost.
      pairs.push([c.segments[0].reference + c.segments[1].reference, c.segments[0].reference]);
      // P3's C7 control: is the stick blind? ref = seg2, hyp = seg1.
      pairs.push([c.segments[1].reference, c.segments[0].reference]);
    }
  }
  for (const [ref, hyp] of pairs) {
    const mine = scoreSegment(ref, hyp);
    const theirs = orig.scoreSegment(ref, hyp);
    assertEq(mine.recall, theirs.recall, `same recall as the original for ref[${ref.length}]/hyp[${hyp.length}]`);
    assertEq(mine.missing.join('|'), theirs.missing.join('|'), '  and the same missing list');
    n += 2;
  }
  samples['§2 J2 differential'] = n;
});

// ---------------------------------------------------------------------------
await section('§3 span survival — the one hard verdict, and the aggregate cannot hide it', () => {
  let n = 0;
  const spans = deriveSpans(REF);
  assertEq(spans.join(','), 'API,schema,review', 'Latin spans are derived from the script (no second hand-kept list)'); n += 1;

  const kept = spanSurvival(REF, REF);
  assertTrue(kept.ok, 'an exact transcript keeps every span'); n += 1;
  assertEq(kept.source, 'derived', 'and reports that the spans were derived, not authored'); n += 1;

  const dropped = spanSurvival(REF, REF.replace(/schema/g, ''));
  assertTrue(!dropped.ok, 'dropping one English word fails span survival'); n += 1;
  assertEq(dropped.lost.join(','), 'schema', 'and names exactly which span went'); n += 1;

  const declared = spanSurvival(REF, REF, ['十二楼']);
  assertEq(declared.source, 'manifest', 'a manifest-declared span list overrides the derived one'); n += 1;

  // Punctuation/spacing differences must not read as a lost span.
  assertTrue(spanSurvival(REF, REF.replace(/API/g, 'A.P.I.')).ok, 'a span punctuated differently still counts as kept'); n += 1;

  // 🔴 The hazard RT-6's language_hints_strict card names, reproduced: an
  // aggregate that looks healthy over one dead code-switch case.
  const many = [];
  for (let i = 0; i < 14; i += 1) many.push(scoreOne('今天下午三点开会讨论产品计划', '今天下午三点开会讨论产品计划'));
  many.push(scoreOne(REF, REF.replace(/schema/g, '')));
  const agg = aggregate(many);
  assertTrue(agg.recall > 0.99, `aggregate recall still reads healthy (${agg.recall.toFixed(4)})`); n += 1;
  assertEq(agg.spanLossSegments.length, 1, 'yet the aggregate carries the span loss out as a COUNT, not an average'); n += 1;
  assertEq(agg.spanLossSegments[0], 14, 'and points at the exact segment'); n += 1;

  samples['§3 span survival'] = n;
});

// ---------------------------------------------------------------------------
await section('§4 loss SHAPE — P3\'s "one block or a scatter?" discriminator', () => {
  let n = 0;
  const block = scoreOne(REF, REF.slice(0, Math.floor(REF.length * 0.5)));
  assertEq(block.shape.shape, 'block', 'a dropped tail reads as `block`'); n += 1;

  const scattered = [...REF].filter((_, i) => i % 4 !== 0).join('');
  const scat = scoreOne(REF, scattered);
  assertEq(scat.shape.shape, 'scatter', 'every 4th character deleted reads as `scatter`'); n += 1;

  // 🔴 The pair is the point. Two losses of comparable SIZE and opposite SHAPE
  // is exactly the confusion P3 flagged (a dropped segment vs. a bad
  // microphone), and a discriminator that cannot separate them is decoration.
  assertTrue(
    Math.abs(block.recall - scat.recall) < 0.35,
    `the two are close in size (block ${block.recall.toFixed(4)} vs scatter ${scat.recall.toFixed(4)}) — so the SHAPE is what separates them`,
  ); n += 1;
  assertTrue(block.shape.longestRun > scat.shape.longestRun * 2, `and their longest runs differ by more than 2× (${block.shape.longestRun} vs ${scat.shape.longestRun})`); n += 1;
  assertEq(missingShape(REF, []).shape, 'none', 'no loss reads as `none`'); n += 1;

  samples['§4 loss shape'] = n;
});

// ---------------------------------------------------------------------------
await section('§5 the duplication blind spot is real, and lenRatio is what sees it', () => {
  let n = 0;
  // First prove the blindness rather than assuming it. If recall ever starts
  // catching duplication, this assertion goes red and the lenRatio flag can be
  // retired — that is the point of asserting a blind spot instead of describing it.
  const dup = scoreSegment(REF, `${REF}${REF}`);
  assertEq(dup.recall, 1.0, 'text said TWICE scores a perfect recall — the metric is blind to it by construction'); n += 1;

  const sig = lengthSignal(REF, `${REF}${REF}`);
  assertTrue(sig.duplicationSuspect, `lenRatio ${sig.lenRatio.toFixed(2)} > ${DUP_SUSPECT_RATIO} flags it`); n += 1;
  assertTrue(Math.abs(sig.lenRatio - 2.0) < 0.01, 'and the ratio is ~2.0, i.e. the number itself is readable'); n += 1;

  const clean = lengthSignal(REF, REF);
  assertTrue(!clean.duplicationSuspect, 'a faithful transcript is not flagged'); n += 1;
  const polished = lengthSignal(REF, '明天下午三点，在十二楼小会议室，过一下 API 的 schema。把上周 review 剩下的两个问题也带上。');
  assertTrue(!polished.duplicationSuspect, `nor is legitimate re-punctuation (ratio ${polished.lenRatio.toFixed(2)})`); n += 1;

  samples['§5 duplication blind spot'] = n;
});

// ---------------------------------------------------------------------------
await section('§6 adapters: registry, spec parsing, and probes that refuse rather than fix', () => {
  let n = 0;
  assertEq(Object.keys(ADAPTERS).sort().join(','), 'assemblyai,fake,openrouter,sherpa-local,soniox', 'the registry holds the five legs'); n += 1;

  const spec = parseSpec('soniox:{"extraConfig":{"enable_endpoint_detection":true}}');
  assertEq(spec.name, 'soniox', 'a spec parses its adapter name'); n += 1;
  assertEq(spec.config.extraConfig.enable_endpoint_detection, true, 'and its JSON config'); n += 1;
  let threw = false;
  try { parseSpec('soniox:{not json}'); } catch { threw = true; }
  assertTrue(threw, 'malformed config throws instead of being silently ignored'); n += 1;

  // Two legs of the SAME engine must be distinguishable in the report.
  const a = buildAdapter('soniox');
  const b = buildAdapter('soniox:{"extraConfig":{"enable_endpoint_detection":true}}');
  assertTrue(a.name !== b.name, `an A/B of one engine against itself yields two distinct column names (${a.name} vs ${b.name})`); n += 1;

  // 🔴 The probe contract, asserted on the source rather than trusted: no probe
  // may consult the auto-download switch. Owner ruling 2026-08-09 made the
  // download opt-in, and an eval bed quietly opting in would revert it.
  const adapterSrc = readFileSync(join(HERE, 'audio-ab-adapters.mjs'), 'utf8');
  const codeLines = adapterSrc.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
  assertTrue(
    !codeLines.some((l) => l.includes('FLOWMIC_SHERPA_AUTO_DOWNLOAD')),
    'no executable line in the adapters reads FLOWMIC_SHERPA_AUTO_DOWNLOAD (the switch is named only in comments)',
  ); n += 1;
  assertTrue(!codeLines.some((l) => /ensureSherpaModel|downloadOne|fetch\(/.test(l)), 'and none of them downloads a model'); n += 1;

  // 🔴 Anchor the duplicated sherpa constants to their TypeScript authority. The
  // .mjs bed cannot import TS, so the copies are pinned by measurement instead
  // of by a "keep in sync" comment.
  // LM-CAT (2026-08-22) moved the authorities: the SenseVoice file manifest
  // lives on the catalog row (model-catalog.ts; model-manifest.ts re-exports a
  // derived view) and the recognizer config lives in the typed builder
  // (loader-config.ts; sherpa-local.ts no longer inlines it).
  const catalogTs = readFileSync(join(ROOT, 'apps/server-core/src/stt/sherpa/model-catalog.ts'), 'utf8');
  const loaderTs = readFileSync(join(ROOT, 'apps/server-core/src/stt/sherpa/loader-config.ts'), 'utf8');
  const engineTs = readFileSync(join(ROOT, 'apps/server-core/src/stt/engines/sherpa-local.ts'), 'utf8');
  for (const f of SHERPA_FILES) {
    assertTrue(catalogTs.includes(`'${f.path}'`), `model-catalog.ts still lists ${f.path}`);
    assertTrue(catalogTs.includes(String(f.size).replace(/\B(?=(\d{3})+(?!\d))/g, '_')), `  at the pinned size ${f.size}`);
    n += 2;
  }
  assertTrue(loaderTs.includes(`useInverseTextNormalization: ${SHERPA_RECOGNIZER.useInverseTextNormalization}`), 'loader-config.ts still sets useInverseTextNormalization the way the bed does'); n += 1;
  assertTrue(loaderTs.includes(`language: '${SHERPA_RECOGNIZER.language}'`), 'and the same decode language'); n += 1;
  assertTrue(engineTs.includes(`featureDim: ${SHERPA_RECOGNIZER.featureDim}`), 'and the same feature dim'); n += 1;

  // An absent model must produce a refusal that names the state, including the
  // partial-download case — the state that looks like progress and behaves like absence.
  const tmp = mkdtempSync(join(tmpdir(), 'rt6-sherpa-'));
  try {
    const empty = inspectSherpaModel(tmp);
    assertTrue(!empty.ok, 'an empty directory is not a model'); n += 1;
    writeFileSync(join(tmp, 'model.int8.onnx.part'), 'x');
    const partial = inspectSherpaModel(tmp);
    assertTrue(!partial.ok && partial.partials.length === 1, 'a .part file is reported as a partial, not as a model'); n += 1;
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  assertTrue(typeof resolveSherpaModelDir({ FLOWMIC_SHERPA_MODEL_DIR: 'X:/m' }) === 'string' && resolveSherpaModelDir({ FLOWMIC_SHERPA_MODEL_DIR: 'X:/m' }) === 'X:/m', 'FLOWMIC_SHERPA_MODEL_DIR overrides the model dir'); n += 1;

  samples['§6 adapters + probe contract'] = n;
});

// ---------------------------------------------------------------------------
await section('§7 the bed end to end, driven by fakes — known text in, known scores out', async () => {
  let n = 0;

  // The CLI must not run on import (this whole file would otherwise have
  // launched it eight sections ago).
  const evalSrc = readFileSync(join(HERE, 'audio-ab-eval.mjs'), 'utf8');
  assertTrue(evalSrc.includes('const isMain =') && evalSrc.includes('if (isMain) {'), 'audio-ab-eval.mjs guards its CLI behind an isMainModule check'); n += 1;

  // The renderer was split out at the 800-line cap. Pin that it stays ONE
  // definition: a re-export is one answer under two names, but a second
  // `function renderReport` would be a second answer to "how is this reported",
  // and the whole P0/P2 disclosure lives in the renderer.
  const renderDefs = ['audio-ab-eval.mjs', 'audio-ab-report.mjs', 'audio-ab-score.mjs', 'audio-ab-adapters.mjs']
    .filter((f) => existsSync(join(HERE, f)))
    .filter((f) => /^export function renderReport/m.test(readFileSync(join(HERE, f), 'utf8')));
  assertEq(renderDefs.join(','), 'audio-ab-report.mjs', 'renderReport is defined in exactly one file (audio-ab-eval.mjs re-exports it, it does not redefine it)'); n += 1;

  assertTrue(parseArgs(['--a=fake', '--segments=1,3']).segments.join(',') === '1,3', 'CLI args parse'); n += 1;

  // 🔴 Regression pin for a defect this bed actually hit on its first real run:
  // a leg configured with Soniox's `context` field produced a name full of
  // quotes and full-width colons, both legs transcribed 26s of real audio
  // correctly, and the run then died on writeFileSync/ENOENT — measurement done,
  // evidence discarded at the last step. `context` is one of the four knobs RT-6
  // exists to A/B, so a long-string config is the normal case, not an edge one.
  const nasty = safeFileName('2026-01-01-soniox-vs-soniox-context="FlowMic 是一款产品：A、B"');
  assertTrue(/^[A-Za-z0-9._=-]+$/.test(nasty), `a config-derived filename is sanitised (${nasty})`); n += 1;
  assertTrue(nasty.includes('soniox-vs-soniox'), 'and still says which legs it compared'); n += 1;
  assertTrue(buildAdapter('soniox:{"extraConfig":{"context":"' + 'x'.repeat(300) + '"}}').name === 'soniox-context',
    'a long-string knob contributes its KEY to the leg name, never its value'); n += 1;
  assertTrue(buildAdapter('soniox:{"extraConfig":{"enable_endpoint_detection":true}}').name === 'soniox-enable_endpoint_detection=true',
    'while a short scalar knob still shows its value (that is what makes an A/B readable)'); n += 1;
  let threw = false;
  try { parseArgs(['--nope']); } catch { threw = true; }
  assertTrue(threw, 'an unknown argument is rejected rather than ignored'); n += 1;

  // 🔴 The report may never be written where git could pick it up. Asserted with
  // an injected `git check-ignore` so it holds regardless of this machine's
  // .gitignore, and in BOTH directions.
  let refused = false;
  try { assertOutsideGit(join(ROOT, 'docs', 'leak.md'), 'report path', () => ({ status: 1 })); } catch { refused = true; }
  assertTrue(refused, 'a tracked in-repo path is REFUSED for the report'); n += 1;
  assertTrue(assertOutsideGit(join(ROOT, '.local', 'x.md'), 'report path', () => ({ status: 0 })).ok, 'a gitignored in-repo path is allowed'); n += 1;
  assertTrue(assertOutsideGit(join(tmpdir(), 'x.md'), 'report path', () => { throw new Error('git must not be consulted for a path outside the tree'); }).ok, 'a path outside the tree is allowed without consulting git'); n += 1;

  // Build a tiny synthetic corpus: real WAV bytes, written to tmpdir, never here.
  const tmp = mkdtempSync(join(tmpdir(), 'rt6-corpus-'));
  try {
    const mkWav = (samplesN) => {
      const pcm = Buffer.alloc(samplesN * 2);
      for (let i = 0; i < samplesN; i += 1) pcm.writeInt16LE(Math.round(3000 * Math.sin(i / 12)), i * 2);
      const h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
      h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
      h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
      h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
      return Buffer.concat([h, pcm]);
    };
    writeFileSync(join(tmp, 'seg-01.wav'), mkWav(16000));
    writeFileSync(join(tmp, 'seg-02.wav'), mkWav(8000));
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify({
      version: 1,
      segments: {
        1: { file: 'seg-01.wav', script: REF, duration_sec: 1.0, sample_rate: 16000 },
        2: { file: 'seg-02.wav', script: '把上周 review 剩下的两个问题也带上', duration_sec: 0.5, sample_rate: 16000 },
      },
    }));

    const corpus = loadCorpus(tmp);
    assertEq(corpus.segments.length, 2, 'the corpus loads'); n += 1;
    assertEq(corpus.segments[0].id, '1', 'and keeps the manifest\'s own segment keys (they are object keys, not array indices)'); n += 1;

    const wav = readWavPcm(corpus.segments[0].path);
    assertEq(wav.fmt.sampleRate, 16000, 'the WAV header is READ, not assumed'); n += 1;
    assertEq(wav.pcm.length, 32000, 'and the data chunk is extracted whole'); n += 1;

    // ── A/B: perfect vs droptail ────────────────────────────────────────────
    const legA = await runLeg(fakeAdapter({ __name: 'fakeA', mode: 'perfect' }), corpus.segments);
    const legB = await runLeg(fakeAdapter({ __name: 'fakeB', mode: 'droptail', fraction: 0.5 }), corpus.segments);
    const cmp = compare(corpus, legA, legB);

    assertEq(cmp.aggA.recall, 1.0, 'leg A (perfect) aggregates to exactly 1.0 — known text in, known score out'); n += 1;
    assertTrue(cmp.aggB.recall < 0.7, `leg B (half dropped) aggregates well below it (${cmp.aggB.recall.toFixed(4)})`); n += 1;
    assertEq(cmp.identicalCount, 0, 'and no segment is byte-identical between the legs (RT-6 D1a\'s column)'); n += 1;
    assertEq(cmp.errorsA + cmp.errorsB, 0, 'with no adapter errors'); n += 1;

    // ── 🔴 REVERSE CONTROL. Corrupt the fake and the bed must see it. ───────
    // Two directions, because "the score dropped" and "the verdict fired" are
    // different claims and only one of them is mechanical.
    const legPerfectB = await runLeg(fakeAdapter({ __name: 'fakeB2', mode: 'perfect' }), corpus.segments);
    const clean = compare(corpus, legA, legPerfectB);
    assertEq(clean.spanRegressions.length, 0, 'CONTROL: two identical legs show no span regression'); n += 1;
    assertEq(clean.identicalCount, 2, 'CONTROL: and every segment is byte-identical'); n += 1;
    assertEq(clean.aggB.recall, 1.0, 'CONTROL: and B scores 1.0'); n += 1;

    const legSpanKiller = await runLeg(fakeAdapter({ __name: 'fakeSpanKiller', mode: 'dropspan' }), corpus.segments);
    const regressed = compare(corpus, legA, legSpanKiller);
    assertTrue(regressed.spanRegressions.length > 0, `REVERSE CONTROL: delete the English spans and the verdict FIRES (${regressed.spanRegressions.length} segment(s))`); n += 1;
    assertTrue(
      regressed.aggB.recall > 0.9,
      `REVERSE CONTROL: …while the aggregate recall stays high (${regressed.aggB.recall.toFixed(4)}) — proving the verdict is not just a recall threshold wearing a different name`,
    ); n += 1;
    assertTrue(
      regressed.segments.some((s) => s.spanRegressed.includes('schema')),
      'REVERSE CONTROL: and it names the span that went',
    ); n += 1;

    const legSilent = await runLeg(fakeAdapter({ __name: 'fakeSilent', mode: 'silent' }), corpus.segments);
    const silent = compare(corpus, legA, legSilent);
    assertEq(silent.aggB.recall, 0.0, 'REVERSE CONTROL: an empty transcript scores 0.0, not "n/a"'); n += 1;

    const legDup = await runLeg(fakeAdapter({ __name: 'fakeDup', mode: 'duplicate' }), corpus.segments);
    const dup = compare(corpus, legA, legDup);
    assertEq(dup.aggB.recall, 1.0, 'REVERSE CONTROL: duplicated text still scores 1.0 recall…'); n += 1;
    assertTrue(dup.segments.every((s) => s.b.score.length.duplicationSuspect), '…and every segment is flagged by lenRatio instead'); n += 1;

    // ── the report renders and carries the verdict ──────────────────────────
    const md = renderReport({ corpus, legA, legB: legSpanKiller, cmp: regressed, startedAt: 'T', machine: 'drill', notes: [] });
    assertTrue(md.includes('SPAN REGRESSION'), 'the rendered report leads with the span-regression verdict'); n += 1;
    assertTrue(md.includes('no pass threshold on recall'), 'and repeats the no-threshold rule where the numbers are read'); n += 1;
    assertTrue(md.includes('| seg |'), 'and contains the per-segment table'); n += 1;
    assertTrue(md.includes(REF.slice(0, 12)), 'and quotes the reference for the human read'); n += 1;

    // An adapter that throws is recorded as an error, NOT scored as silence.
    const boom = { name: 'boom', describe: () => 'always throws', probe: async () => ({ ready: true }), transcribe: async () => { throw new Error('engine exploded'); } };
    const legBoom = await runLeg(boom, corpus.segments);
    const cmpBoom = compare(corpus, legA, legBoom);
    assertEq(cmpBoom.errorsB, 2, 'a throwing adapter is counted as errors'); n += 1;
    assertEq(cmpBoom.aggB.segments, 0, 'and contributes nothing to the aggregate (a crash is not a 0.0 score)'); n += 1;
    // 🔴 This assertion is new, and its absence is why the defect below survived
    // review: the line above proved "0 segments scored" and NOBODY LOOKED AT THE
    // RECALL PRINTED BESIDE IT. `refPoints === 0 ? 1 : …` made a leg where every
    // single segment crashed aggregate to a perfect 1.0000, under the heading
    // "micro-avg recall". A drill that checks the denominator and not the
    // numerator is how a fabricated number stays green.
    assertEq(cmpBoom.aggB.recall, null, '🔴 …and its aggregate recall is null, NOT the vacuous-truth 1.0000'); n += 1;
    // Read the B cell of the recall row specifically — leg A legitimately scores
    // 1.0000 in the same table, so a whole-document search would be satisfied by
    // the wrong number and would have stayed green through the defect.
    const boomMd = renderReport({ corpus, legA, legB: legBoom, cmp: cmpBoom, startedAt: 'T', machine: 'drill', notes: [] });
    const recallRow = boomMd.split('\n').find((l) => l.startsWith('| micro-avg recall'));
    assertEq(recallRow.split('|').map((c) => c.trim())[3], 'n/a',
      '   and the aggregate table\'s B cell reads n/a, not 1.0000, for a leg that scored nothing'); n += 1;
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  samples['§7 bed end-to-end (fakes)'] = n;
});

// ---------------------------------------------------------------------------
await section('§8 P3 calibration reproduced on the real corpus (when it is present)', () => {
  const manifest = join(DEFAULT_CORPUS, 'manifest.json');
  if (!existsSync(manifest)) {
    samples['§8 P3 calibration'] = 0;
    notMeasured(
      'the P3 calibration could not be reproduced',
      `${manifest} is absent (.local is gitignored). Counted as UNMEASURED, not as a pass.`,
    );
    return;
  }
  let n = 0;
  const c = loadCorpus(DEFAULT_CORPUS);
  const s1 = c.segments[0].reference;
  const s2 = c.segments[1].reference;

  // P3 ledger §3-2, 【measured】, four controls. C2's 0.5474 is the load-bearing one:
  // it is the real N-1 failure shape (a whole segment gone) and it is the number
  // the P3 controller re-derived by hand rather than inheriting from P2.
  assertEq(scoreSegment(s1, s1).recall, 1.0, 'C1 identical → 1.0000'); n += 1;
  const c2 = scoreSegment(s1 + s2, s1).recall;
  assertTrue(Math.abs(c2 - 0.5474) < 0.0001, `C2 whole segment dropped → ${c2.toFixed(4)} (P3 measured 0.5474)`); n += 1;
  const c7 = scoreSegment(s2, s1).recall;
  assertTrue(c7 < 0.25, `C7 wrong segment entirely → ${c7.toFixed(4)} (the "is the stick blind?" control; P3 read ~0.15)`); n += 1;
  const c6 = scoreSegment(s1, [...s1].map((ch, i) => (i > 0 && i % 6 === 0 ? `，${ch}` : ch)).join('')).recall;
  assertEq(c6, 1.0, 'C6 a comma every 6 characters → 1.0000 (re-punctuation is not loss)'); n += 1;

  // And the corpus really does carry the code-switch material RT-6 needs.
  const withSpans = c.segments.filter((s) => deriveSpans(s.reference).length > 0);
  assertTrue(withSpans.length >= 5, `the corpus carries ${withSpans.length} code-switch/jargon segment(s) — the set RT-6's context + language_hints_strict cards said did not exist`); n += 1;
  console.log(`      segments with Latin spans: ${withSpans.map((s) => `${s.id}:${JSON.stringify(deriveSpans(s.reference))}`).join(' ')}`);

  samples['§8 P3 calibration'] = n;
});

// ---------------------------------------------------------------------------
await section('§9 🔴 P0 — a session that did not complete CANNOT become a recall number', async () => {
  let n = 0;

  // ── the contract, pinned at the source ─────────────────────────────────────
  // `completed` is derived inside finish() from the one clean reason, so a new
  // terminal path cannot arrive already-complete. Asserted on the literal
  // because a rename that touched one and not the other would make every
  // session VOID (loud) instead of every session complete (silent) — and only
  // one of those two directions is safe to get wrong.
  const adapterSrc = readFileSync(join(HERE, 'audio-ab-adapters.mjs'), 'utf8');
  assertEq(SONIOX_CLEAN_FINISH, 'finished:true', 'the one clean terminal reason is a named constant'); n += 1;
  assertTrue(adapterSrc.includes('finish(SONIOX_CLEAN_FINISH)'), 'and the `finished === true` branch calls finish() WITH that constant'); n += 1;
  assertTrue(adapterSrc.includes('const completed = why === SONIOX_CLEAN_FINISH;'),
    'and `completed` is DERIVED from the reason, not passed in by each of the five call sites'); n += 1;
  for (const deadPath of ['server error', 'TIMEOUT ', 'ws closed', 'ws error:']) {
    assertTrue(adapterSrc.includes(`finish(\`${deadPath}`) || adapterSrc.includes(`finish('${deadPath}`),
      `  the ${JSON.stringify(deadPath.trim())} path still routes through finish() (so it is covered by the derivation)`);
    n += 1;
  }

  await withTempCorpus(async (corpus) => {
    const legGood = await runLeg(fakeAdapter({ __name: 'good', mode: 'perfect' }), corpus.segments);

    // ── the simulated 408 / dead session ─────────────────────────────────────
    // 🔴 The subject reproduces the MEASURED shape, not the convenient one: the
    // adapter returns partial TEXT alongside completed:false. The 2026-08-10
    // run that this fix exists for had `TIMEOUT 120000ms` with 75 final tokens
    // and scored 0.6201 — a `finalTokens === 0` guard would have passed it.
    const legDead = await runLeg(fakeAdapter({ __name: 'dead', mode: 'incomplete' }), corpus.segments);
    const rows = legDead.rows;
    assertEq(rows.length, 2, 'the dead leg still produces a row per segment (the run is not aborted)'); n += 1;
    assertTrue(rows.every((r) => r.void), 'every dead row is marked VOID'); n += 1;
    assertTrue(rows.every((r) => r.score === null), 'a VOID row has NO score object at all — not a zero, not an n/a'); n += 1;
    assertTrue(rows.every((r) => r.text === null), 'and no `text`, so nothing downstream can score it after the fact'); n += 1;
    // Optional chaining on purpose: when this section goes red (which is the
    // point of a reverse control) it must print every failing assertion, not
    // die on the first null and hide the rest behind a TypeError. A drill whose
    // failure mode is a stack trace makes the operator debug the drill.
    assertTrue(rows.every((r) => r.void?.partialText.length > 0), 'while the partial text survives as a DIAGNOSTIC, under a name no scorer reads'); n += 1;
    assertTrue(rows.every((r) => r.void?.why.includes('408')), 'and the row carries the reason the session died'); n += 1;
    assertEq(rows.filter((r) => r.error).length, 0, 'a void is NOT folded into `error` (a throw and a dead session have different causes)'); n += 1;

    const cmp = compare(corpus, legGood, legDead);
    assertEq(cmp.aggB.recall, null, '🔴 the aggregate over zero scored rows is null, NOT 1.0000'); n += 1;
    assertEq(cmp.aggB.segments, 0, '   with zero segments scored'); n += 1;
    assertEq(cmp.voidsB.join(','), '1,2', 'and the comparison names exactly which segments were void'); n += 1;
    assertEq(cmp.errorsB, 0, 'while the ERROR counter — the one the 2026-08-10 report showed as 0 — stays 0, correctly'); n += 1;

    // 🔴 THE PHANTOM RECOVERY, the second half of the same defect.
    const legLostSpans = await runLeg(fakeAdapter({ __name: 'lost', mode: 'dropspan' }), corpus.segments);
    const phantom = compare(corpus, legLostSpans, legDead);
    assertEq(phantom.segments.reduce((t, s) => t + s.spanRecovered.length, 0), 0,
      '🔴 a VOID leg recovers NOTHING (`?? []` used to read "no lost list" as "lost nothing" and credited a TLS failure with 7 recovered spans)'); n += 1;
    assertEq(phantom.segments.reduce((t, s) => t + s.spanRegressed.length, 0), 0, '   and regresses nothing either — both directions'); n += 1;
    assertTrue(phantom.segments.every((s) => s.pairScored === false), '   because the pair is reported as NOT COMPARABLE'); n += 1;
    assertTrue(phantom.segments.every((s) => s.identical === null), '   including D1a identity: two nulls are not "byte-identical"'); n += 1;

    // ── the report says VOID, in the words a reader needs ────────────────────
    const md = renderReport({ corpus, legA: legGood, legB: legDead, cmp, startedAt: 'T', machine: 'drill', notes: [] });
    assertTrue(md.includes('VOID row(s)'), 'the report leads §1 with the void count'); n += 1;
    assertTrue(md.includes('NOT SCORED, NOT A ZERO'), 'and says in words that a void is not a zero'); n += 1;
    assertTrue(md.includes('**VOID**'), 'the per-segment table prints VOID in the recall cell'); n += 1;
    assertTrue(!/\|\s*0\.0000\s*\|/.test(md), '🔴 and the string "0.0000" appears in NO table cell of this report'); n += 1;
    assertTrue(md.includes('NOT A/B-COMPARABLE'), 'and the pair is declared non-comparable'); n += 1;

    // ── 🔴 ONE VOID AMONG N — the shape that actually happened ───────────────
    // N-of-N voids are the easy case (the leg obviously measured nothing). The
    // dangerous case is a single dead session inside a run that still looks
    // healthy: the aggregate keeps printing a plausible corpus average that is
    // silently over a subset. On 2026-08-10 that subset average was 0.8010 where
    // the honest one was 0.9840.
    const legMostly = await runLeg(fakeAdapter({ __name: 'mostly', mode: 'incomplete', voidSegments: ['2'] }), corpus.segments);
    assertEq(legMostly.rows.filter((r) => r.void).length, 1, 'a leg can be void on ONE segment and fine on the others'); n += 1;
    assertEq(legMostly.rows.filter((r) => r.score).length, 1, 'and the healthy segment still scores'); n += 1;
    const mixed = compare(corpus, legGood, legMostly);
    assertEq(mixed.aggB.segments, 1, '🔴 the aggregate is over 1 segment, not 2 — the denominator is the thing a reader must see'); n += 1;
    assertEq(mixed.voidsB.join(','), '2', 'and the void is named'); n += 1;
    const mixedMd = renderReport({ corpus, legA: legGood, legB: legMostly, cmp: mixed, startedAt: 'T', machine: 'drill', notes: [] });
    assertTrue(mixedMd.includes('| …computed over | 2 of 2 | 1 of 2 |'),
      '🔴 and the report prints the denominator on the line directly under the recall it belongs to'); n += 1;
    assertTrue(/No span regression\*\* across the 1 of 2 segment/.test(mixedMd),
      '🔴 the green tick states its own basis — "no regression" over a subset is a different claim from over the corpus'); n += 1;
    assertTrue(mixedMd.includes('this tick does not cover them'), '   and says outright which segments it does not cover'); n += 1;

    // ── the two shapes must stay apart ───────────────────────────────────────
    // `silent` COMPLETED and said nothing: that is a real, bad result and must
    // still score 0.0. If this ever voids too, the fix has swallowed a genuine
    // finding — which is the failure direction opposite to the one being fixed.
    const legSilent = await runLeg(fakeAdapter({ __name: 'silent', mode: 'silent' }), corpus.segments);
    const silent = compare(corpus, legGood, legSilent);
    assertEq(silent.aggB.recall, 0.0, 'CONTROL: a leg that COMPLETED and returned nothing still scores 0.0000…'); n += 1;
    assertEq(silent.voidsB.length, 0, '   …and is NOT void — "said nothing" and "never answered" stay two different findings'); n += 1;

    // ── absence of the declaration is void, not assumed-complete ─────────────
    const undeclared = {
      name: 'legacy', describe: () => 'an adapter written before the contract',
      assembler: { kind: 'synthetic', note: 'test double' },
      probe: async () => ({ ready: true }),
      transcribe: async (_p, seg) => ({ text: seg.reference }),   // perfect text, no `completed`
    };
    const legLegacy = await runLeg(undeclared, corpus.segments);
    assertTrue(legLegacy.rows.every((r) => r.void), '🔴 an adapter that omits `completed` is VOIDED even though its text is PERFECT'); n += 1;
    assertTrue(Boolean(legLegacy.rows[0].void?.why.includes('did not declare')), '   and the reason names the missing declaration rather than blaming the engine'); n += 1;
  });

  samples['§9 P0 void sessions'] = n;
});

// ---------------------------------------------------------------------------
await section('§10 P1 — the word-boundary signal the primary metrics are blind to', async () => {
  let n = 0;

  // 🔴 The blindness is PROVEN before the new signal is trusted, in both
  // metrics. If either of these two ever goes red, the signal below can be
  // retired — that is what asserting a blind spot is for.
  const refFused = '帮我调一下 getUserProfile 这个接口';
  const hypSpaced = '帮我调一下 get user profile 这个接口';
  assertEq(scoreSegment(refFused, hypSpaced).recall, 1.0, 'recall scores `get user profile` as a perfect transcript of `getUserProfile`'); n += 1;
  const sp = spanSurvival(refFused, hypSpaced);
  assertTrue(sp.ok && sp.lost.length === 0, 'and span survival — the one hard verdict — also calls it kept'); n += 1;

  // The new signal, and the fact that it did NOT move the old numbers.
  assertEq(sp.respaced.join(','), 'getUserProfile', '🔴 …while `respaced` names it (the measured seg-11 difference: baseline fused 8/8, context spaced 8/8)'); n += 1;
  assertEq(sp.exact.length, 0, 'and `exact` is empty for that span'); n += 1;
  assertEq(sp.kept.join(','), 'getUserProfile', 'CONTROL: `kept` is unchanged — exact+respaced is a PARTITION of kept, not a new verdict'); n += 1;
  assertEq(sp.exact.length + sp.respaced.length, sp.kept.length, '   and the partition is exhaustive'); n += 1;

  const exactHit = spanSurvival(refFused, refFused);
  assertEq(exactHit.exact.join(','), 'getUserProfile', 'a transcript with the script\'s own spacing is `exact`'); n += 1;
  assertEq(exactHit.respaced.length, 0, 'and nothing is respaced'); n += 1;
  assertTrue(spanSurvival(REF, REF.replace(/API/g, 'A.P.I.')).exact.includes('API'),
    '🔴 punctuation is NOT a boundary change — "A.P.I." is still `exact`, or the signal would cry wolf on every engine that punctuates'); n += 1;

  // 🔴 The normalisation pair is pinned by a PROPERTY, not by a comment. STRIP_RE
  // is bit-pinned by §2/§8; STRIP_KEEP_SPACE_RE must be the same class minus
  // whitespace, and this is the check that says so.
  const probes = [
    REF, refFused, hypSpaced,
    '`~!@#$%^&*()_-+=[]{}|\\;:\'",.<>/?', '，。！？；：、“”‘’（）【】『』「」《》〈〉…—～·￥',
    'a b\tc\nd　e', 'MiXeD CaSe 中文 123',
  ];
  let mismatches = 0;
  for (const s of probes) if (normalize(s) !== normalizeKeepSpace(s).replace(/ /g, '')) mismatches += 1;
  assertEq(mismatches, 0, 'PROPERTY: normalize(s) === normalizeKeepSpace(s) with spaces removed, over every stripped character'); n += 1;
  assertEq(normalizeKeepSpace('  Get   User  Profile 。 '), 'get user profile', 'and normalizeKeepSpace collapses runs, lowercases, strips punctuation, trims'); n += 1;

  // End to end: two legs that differ ONLY in word boundaries.
  await withTempCorpus(async (corpus) => {
    const legA = await runLeg(fakeAdapter({ __name: 'fused', mode: 'perfect' }), corpus.segments);
    const legB = await runLeg(fakeAdapter({ __name: 'spaced', mode: 'respaced' }), corpus.segments);
    const cmp = compare(corpus, legA, legB);
    assertEq(cmp.aggA.recall, cmp.aggB.recall, '🔴 two legs differing only in word boundaries have IDENTICAL aggregate recall…'); n += 1;
    assertEq(cmp.spanRegressions.length, 0, '   …and zero span regressions — the primary criterion cannot see the difference'); n += 1;
    assertTrue(cmp.spanFormChanges.length > 0, `   …while the form signal reports it (${cmp.spanFormChanges.length} segment(s))`); n += 1;
    assertTrue(cmp.segments.some((s) => s.spanFormLostInB.includes('API')), '   naming the span whose boundaries moved'); n += 1;
    const md = renderReport({ corpus, legA, legB, cmp, startedAt: 'T', machine: 'drill', notes: [] });
    assertTrue(md.includes('WORD BOUNDARIES'), 'and the report states it beside the verdict'); n += 1;
    assertTrue(md.includes('NOT a verdict'), 'explicitly as a signal, not a verdict'); n += 1;
  });

  samples['§10 P1 word-boundary signal'] = n;
});

// ---------------------------------------------------------------------------
await section('§11 P2 — the bed is a second assembler, and every report has to say so', async () => {
  let n = 0;

  // Every registry leg declares provenance. This is the enforcement that makes
  // the disclosure impossible to forget: a new adapter is red on the day it is
  // written, not on the day someone re-reads the header.
  for (const name of Object.keys(ADAPTERS)) {
    const ad = buildAdapter(name);
    assertTrue(ad.assembler && typeof ad.assembler.kind === 'string' && typeof ad.assembler.note === 'string',
      `adapter ${JSON.stringify(name)} declares { kind, note }`);
    n += 1;
  }
  const soniox = buildAdapter('soniox');
  assertEq(soniox.assembler.kind, 'bed-local', 'the soniox leg admits its text is assembled HERE, not by the product'); n += 1;
  assertTrue(soniox.assembler.note.includes('TokenAccumulator'), 'and names the product class it does not run'); n += 1;
  assertTrue(soniox.assembler.note.includes('<end>'), 'and the marker that already produced a false product finding'); n += 1;

  await withTempCorpus(async (corpus) => {
    const legA = await runLeg(buildAdapter('fake'), corpus.segments);
    const legB = await runLeg({
      ...buildAdapter('fake:{"mode":"droptail"}'),
      name: 'pseudo-soniox',
      assembler: { kind: 'bed-local', note: 'joins vendor tokens itself; never runs TokenAccumulator' },
    }, corpus.segments);
    assertEq(legB.assembler.kind, 'bed-local', 'runLeg carries the declaration onto the leg (and so into the JSON report)'); n += 1;

    const cmp = compare(corpus, legA, legB);
    const md = renderReport({ corpus, legA, legB, cmp, startedAt: 'T', machine: 'drill', notes: [] });
    assertTrue(md.includes('NOT WHAT THE PRODUCT WOULD EMIT'), '🔴 the report says so ABOVE the first number, not in a footnote'); n += 1;
    assertTrue(md.includes('never runs TokenAccumulator'), 'quoting the leg\'s own note rather than a sentence written in the renderer'); n += 1;
    assertTrue(md.indexOf('NOT WHAT THE PRODUCT WOULD EMIT') < md.indexOf('## 1. Verdict'), 'and it appears before §1'); n += 1;

    // An undeclared leg is reported and costs an exit code — it does NOT throw
    // away a finished run. The `safeFileName` regression above this file records
    // what discarding evidence at the last step costs.
    const legMute = await runLeg({
      name: 'mute', describe: () => 'declares nothing',
      probe: async () => ({ ready: true }),
      transcribe: async (_p, seg) => ({ text: seg.reference, completed: true }),
    }, corpus.segments);
    const cmpMute = compare(corpus, legA, legMute);
    assertEq(cmpMute.undeclaredAssembler.join(','), 'mute', 'an undeclared leg is named in the comparison'); n += 1;
    let rendered = null;
    try { rendered = renderReport({ corpus, legA, legB: legMute, cmp: cmpMute, startedAt: 'T', machine: 'drill', notes: [] }); } catch { /* must not throw */ }
    assertTrue(rendered !== null, 'and the report still RENDERS — a finished run is never discarded at the last step'); n += 1;
    assertTrue(rendered.includes('DID NOT DECLARE ITS ASSEMBLER'), 'while saying loudly that the provenance is unknown'); n += 1;
    assertEq(cmpMute.aggB.recall, 1.0, 'CONTROL: its numbers are still computed — undeclared provenance is not a void'); n += 1;
  });

  samples['§11 P2 assembler provenance'] = n;
});

// ---------------------------------------------------------------------------

console.log('\nSAMPLES PER CASE:');
for (const [k, v] of Object.entries(samples)) console.log(`  ${String(v).padStart(3)}  ${k}`);
console.log(`\nACCOUNTING: sections run ${sectionsRun}/${TOTAL_SECTIONS}, ${failures} assertion failure(s), ${unmeasured} unmeasured case(s)`);
if (failures > 0) {
  console.error(`\n✗ RT-6-a drill FAILED (${failures} assertion(s))`);
  process.exit(1);
}
if (sectionsRun !== TOTAL_SECTIONS) {
  console.error(`\n✗ RT-6-a drill ran ${sectionsRun}/${TOTAL_SECTIONS} sections — a partial run is not a pass.`);
  process.exit(1);
}
if (unmeasured > 0) console.log(`\n⚠ ${unmeasured} case(s) unmeasured — green here does NOT include them.`);
console.log('\n✓ RT-6-a drill PASSED');
