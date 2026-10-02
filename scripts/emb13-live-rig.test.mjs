#!/usr/bin/env node
// Drill for the EMB-13 live rig (scripts/emb13-live-rig.mjs): the parts that can be
// checked with no browser, no relay and no managed minute.
//
//   1. The rig is OPT-IN. A run without FLOWMIC_EMB13_LIVE=1 (or with any value
//      other than exactly 1) must print one `SKIP:` line and exit 2 before it opens
//      a socket or writes state. That is the whole reason it is safe to leave in
//      scripts/: nothing in a gate can spend managed minutes by accident.
//   2. The helpers the rig's verdicts are built from (nearest-rank percentiles,
//      the insert rule, WAV padding, Socket.IO event parsing, secret redaction).
//      A wrong percentile or a wrong expected string would make a red row green,
//      and the rig's own rows would never say so.
//
// What this does NOT prove: that the rig drives a real browser and a real
// recogniser correctly. Only a live run does (see the rig's header and the EMB-13
// report). Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chunkMs, expectedInsert, liveEnabled, looksLikeChineseSpeech, padWavWithSilence, parseEnvFile, parseSocketIoEvent,
  parseWav, percentile, redact, summarize, verdict, wavDurationMs,
} from './emb13-live-rig-lib.mjs';
import { timings } from './emb13-live-driver.mjs';
import { budget, fixtureOnsetMs, overlap, placement, leadingSilence, onsetAlignedWav } from './emb13-wv7-lib.mjs';
import { wv7Drill } from './emb13-wv7-drill.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
let failures = 0;
function check(what, fn) {
  try { fn(); console.log(`  ok   ${what}`); } catch (e) { failures += 1; console.log(`  FAIL ${what}\n       ${String(e.message).split('\n')[0]}`); }
}

console.log('opt-in gate');
const stateDir = join(ROOT, '.local', 'emb13-live');
const runsBefore = existsSync(stateDir) ? readdirSync(stateDir).length : 0;
for (const value of [undefined, '0', 'true', '', '2']) {
  check(`FLOWMIC_EMB13_LIVE=${JSON.stringify(value)} skips with exit 2 and a SKIP line`, () => {
    // DRY=1 is set on purpose: were the gate ever broken, this spawn would resolve its configuration
    // and stop, instead of starting a relay and spending managed minutes inside a test.
    const env = { ...process.env, FLOWMIC_EMB13_DRY: '1' };
    delete env.FLOWMIC_EMB13_LIVE;
    if (value !== undefined) env.FLOWMIC_EMB13_LIVE = value;
    const r = spawnSync(process.execPath, [join(HERE, 'emb13-live-rig.mjs')], { env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 2, `exit ${r.status}; stderr: ${r.stderr.slice(0, 200)}`);
    assert.match(r.stdout, /^SKIP: /m);
    assert.equal(r.stdout.trim().split(/\r?\n/).length, 1, 'more than one line printed');
  });
}
check('LIVE=1 with DRY=1 resolves configuration and starts nothing', () => {
  const r = spawnSync(process.execPath, [join(HERE, 'emb13-live-rig.mjs')], {
    env: { ...process.env, FLOWMIC_EMB13_LIVE: '1', FLOWMIC_EMB13_DRY: '1' }, encoding: 'utf8', timeout: 20_000,
  });
  // 0 with a DRY line (configuration found) or 1 with a named missing input: both mean nothing was started.
  assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}`);
  assert.doesNotMatch(r.stdout, /^relay http/m);
  if (r.status === 0) assert.match(r.stdout, /^DRY: /m);
  else assert.match(r.stderr, /no built web client|no Soniox credentials|speech fixture|stt-cloud/);
});
check('a skipped run wrote no run directory', () => {
  const runsAfter = existsSync(stateDir) ? readdirSync(stateDir).length : 0;
  assert.equal(runsAfter, runsBefore);
});
check('liveEnabled is true only for exactly "1"', () => {
  assert.equal(liveEnabled({ FLOWMIC_EMB13_LIVE: '1' }), true);
  for (const v of ['0', 'true', 'yes', '', undefined]) assert.equal(liveEnabled({ FLOWMIC_EMB13_LIVE: v }), false);
});

console.log('statistics');
check('percentile is nearest-rank and returns an observed value', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(percentile([10, 20], 50), 10);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([null, undefined, 7], 50), 7);
});
check('summarize reports n so a thin sample cannot pass for a full one', () => {
  assert.deepEqual(summarize([300, 100, 200, null, 400, 500]), { n: 5, p50: 300, max: 500 });
  assert.deepEqual(summarize([]), { n: 0, p50: null, max: null });
});
check('verdict names every failing check', () => {
  assert.deepEqual(verdict({ a: true, b: false, c: undefined }), { pass: false, failed: ['b', 'c'] });
  assert.deepEqual(verdict({ a: true }), { pass: true, failed: [] });
});

console.log('insert rule (design 3.4, "write where")');
check('Latin sentence after text with no trailing space gets one leading space', () => {
  assert.deepEqual(expectedInsert('abc def', 3, ['hello there']), { value: 'abc hello there def', caret: 15 });
});
check('CJK sentence gets no separator', () => {
  const chinese = '\u4f60\u597d';
  assert.deepEqual(expectedInsert('abc def', 3, [chinese]), { value: `abc${chinese} def`, caret: 5 });
});
check('no separator at the start of the field, after whitespace, or before punctuation', () => {
  assert.equal(expectedInsert('', 0, ['hello']).value, 'hello');
  assert.equal(expectedInsert('abc ', 4, ['hello']).value, 'abc hello');
  assert.equal(expectedInsert('abc', 3, [', and more']).value, 'abc, and more');
});
check('a second sentence lands after the first', () => {
  assert.equal(expectedInsert('a', 1, ['one', 'two']).value, 'a one two');
});
check('looksLikeChineseSpeech needs six Han characters', () => {
  assert.equal(looksLikeChineseSpeech('\u5927\u5bb6\u597d\u6b22\u8fce\u4f7f\u7528'), true);
  assert.equal(looksLikeChineseSpeech('hello'), false);
  assert.equal(looksLikeChineseSpeech('\u5927\u5bb6\u597d'), false);
});

console.log('audio and wire helpers');
check('padWavWithSilence keeps the speech bytes and adds exactly the silence', () => {
  const rate = 16_000;
  const pcm = Buffer.alloc(rate * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE((i % 200) - 100, i);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const padded = parseWav(padWavWithSilence(Buffer.concat([header, pcm]), 500));
  assert.equal(wavDurationMs(padded), 1500);
  assert.ok(padded.data.subarray(0, pcm.length).equals(pcm), 'speech bytes changed');
  assert.ok(padded.data.subarray(pcm.length).every((b) => b === 0), 'padding is not silence');
  assert.equal(padded.sampleRate, rate);
});
check('parseWav refuses what the fake device cannot play', () => {
  assert.throws(() => parseWav(Buffer.from('not a wav file at all, definitely more than forty-four bytes long')));
});
check('parseSocketIoEvent reads events and ignores everything else', () => {
  assert.deepEqual(parseSocketIoEvent('42["inject:result",{"ok":false,"mode":"cached"}]'), { event: 'inject:result', payload: { ok: false, mode: 'cached' } });
  assert.deepEqual(parseSocketIoEvent('42/ns,["a",1]'), { event: 'a', payload: 1 });
  for (const junk of ['2', '3', '40', '43["ack"]', '42', '42[', '42[1,2]']) assert.equal(parseSocketIoEvent(junk), null, junk);
});
check('chunkMs: a 6400-byte 16 kHz mono chunk is 200 ms', () => {
  assert.equal(chunkMs(Buffer.alloc(6400).toString('base64')), 200);
  assert.equal(chunkMs(undefined), 0);
});
check('parseEnvFile and redact never leave a secret in printable output', () => {
  const env = parseEnvFile('# comment\nFLOWMIC_MANAGED_STT_API_KEY=abcdef0123456789\nBAD LINE\nX=1\n');
  assert.equal(env.FLOWMIC_MANAGED_STT_API_KEY, 'abcdef0123456789');
  assert.equal(redact('key abcdef0123456789 sent', [env.FLOWMIC_MANAGED_STT_API_KEY]), 'key <redacted> sent');
  assert.equal(redact('x=1', ['1']), 'x=1', 'a one-character secret would shred the log');
});

console.log('timings (the arithmetic every table cell is built from)');
check('receipts carry the code from the field the SDK really sends (`error`, not `code`)', () => {
  const run = { marks: [], listeningEpoch: 0, wire: [{ at: 1, dir: 'out', event: 'inject:result', detail: { ok: false, mode: 'cached', error: 'INJECT_TARGET_NOT_READY' } }] };
  assert.deepEqual(timings(run).receipts, [{ dir: 'out', ok: false, code: 'INJECT_TARGET_NOT_READY', mode: 'cached' }]);
});
check('press, listening, text and stop are measured from the right marks', () => {
  const press = (epoch) => ({ name: 'pointerdown', epoch, detail: { k: 'hold' } });
  const text = (epoch, s) => ({ name: 'flowmic:text', epoch, detail: { text: s } });
  const run = {
    listeningEpoch: 1300, marks: [press(1000), text(8400, 'a'), press(8000), text(8600, 'b')],
    wire: [
      { at: 1100, dir: 'out', event: 'audio:start', detail: {} },
      { at: 2200, dir: 'in', event: 'stt:level', detail: { amplitude_db: -20 } },
      { at: 2500, dir: 'in', event: 'stt:interim', detail: { text: 'x' } },
      { at: 8010, dir: 'out', event: 'audio:stop', detail: {} },
      { at: 8390, dir: 'in', event: 'stt:final', detail: {} },
    ],
  };
  const t = timings(run);
  assert.equal(t.clickToListeningMs, 300);
  assert.equal(t.firstTextFromStartMs, 7400);
  assert.equal(t.stopToFieldMs, 600, 'stop press to the LAST text');
  assert.equal(t.wireStopToFinalMs, 380);
  assert.equal(t.speechOnsetMs, 1100);
  assert.equal(t.onsetToInterimMs, 300);
  assert.deepEqual(t.sentences, ['a', 'b']);
});

check('WV7 missing measurements never pass a budget', () => {
  assert.deepEqual(budget([null, undefined, NaN], 100, 150), { n: 0, p50: null, p95: null, verdict: 'not measured' });
  assert.deepEqual(budget([20, 40, 80, 100, 160], 100, 150), { n: 5, p50: 80, p95: 160, verdict: 'FAIL' });
  assert.equal(budget([0, 0], 0, 0).verdict, 'PASS');
  assert.equal(budget([-1], 100, 150).verdict, 'FAIL');
});
check('WV7 silent device begins silent and then plays the original PCM unchanged', () => {
  const original = readFileSync(join(ROOT, 'apps/mobile/integration_test/fixtures/zh-6s.wav'));
  const source = parseWav(original), output = parseWav(leadingSilence(original, 5000));
  const silence = source.sampleRate * source.channels * source.bitsPerSample / 8 * 5;
  assert.equal(output.data.subarray(0, silence).every((v) => v === 0), true);
  assert.deepEqual(output.data.subarray(silence), source.data);
});
check('WV-T4 onset-aligned fixture starts on its first sound, keeps its length, and moves the lead-in, unchanged, to the end', () => {
  const original = readFileSync(join(ROOT, 'apps/mobile/integration_test/fixtures/zh-6s.wav'));
  const lead = fixtureOnsetMs(original);
  assert.ok(lead > 100, `the default fixture should have a lead-in (got ${lead} ms)`);
  const aligned = onsetAlignedWav(original);
  const src = parseWav(original), out = parseWav(aligned);
  assert.equal(aligned.length, original.length);
  assert.equal(out.data.length, src.data.length);
  assert.equal(fixtureOnsetMs(aligned), 0);
  const leadBytes = Math.round((lead / 1000) * src.sampleRate) * src.channels * 2;
  // The moved part is not silence in this recording, so a zero fill (round 2)
  // cannot pass the equality below: this is what makes it a rotation test.
  assert.ok(src.data.subarray(0, leadBytes).some((v) => v !== 0), 'the lead-in has content');
  assert.deepEqual(out.data.subarray(0, src.data.length - leadBytes), src.data.subarray(leadBytes));
  assert.deepEqual(out.data.subarray(src.data.length - leadBytes), src.data.subarray(0, leadBytes));
});
check('WV7 capsule checks geometry and actual hit testing, not its own side label', () => {
  const field = { left: 10, right: 110, top: 10, bottom: 40 };
  const capsule = { left: 10, right: 110, top: 48, bottom: 110 };
  const s = { viewport: { width: 1280, height: 900 }, field, capsule, button: field, pointerEvents: 'none', pressHitsButton: true, side: 'below' };
  assert.equal(placement(s).verdict, 'PASS');
  assert.equal(placement({ ...s, capsule: field }).verdict, 'FAIL');
  assert.equal(placement({ ...s, pointerEvents: 'auto' }).verdict, 'FAIL');
  assert.equal(placement({ ...s, pressHitsButton: false }).verdict, 'FAIL');
  assert.equal(placement({}).verdict, 'not measured');
  assert.equal(overlap(field, capsule), 0);
  assert.equal(overlap(field, field), 3000);
});

wv7Drill(check);
check('WV7d DRY prints the sentence plan before resolving live inputs', () => {
  const r = spawnSync(process.execPath, [join(HERE, 'emb13-live-rig.mjs')], {
    env: { ...process.env, FLOWMIC_EMB13_LIVE: '1', FLOWMIC_EMB13_DRY: '1', FLOWMIC_EMB13_WV7: '1',
      FLOWMIC_EMB13_WV7_SCENARIO: 'budget', FLOWMIC_EMB13_WV7_SURFACES: 'home,try,sdk', FLOWMIC_EMB13_SENTENCES: '4', FLOWMIC_EMB13_MAX_MINUTES: '25' },
    encoding: 'utf8', timeout: 20000,
  });
  assert.ok(r.status === 0 || r.status === 1);
  assert.match(r.stdout, /"sentences":4/); assert.match(r.stdout, /"estimatedMinutes":3/);
  assert.doesNotMatch(r.stdout, /^relay http/m);
  if (r.status === 0) assert.match(r.stdout, /nothing was started/);
});
check('WV7d over-cap DRY refuses before any relay or transcription can start', () => {
  const r = spawnSync(process.execPath, [join(HERE, 'emb13-live-rig.mjs')], {
    env: { ...process.env, FLOWMIC_EMB13_LIVE: '1', FLOWMIC_EMB13_DRY: '1', FLOWMIC_EMB13_WV7: '1',
      FLOWMIC_EMB13_WV7_SCENARIO: 'budget', FLOWMIC_EMB13_WV7_SURFACES: 'home,try,sdk', FLOWMIC_EMB13_SENTENCES: '100', FLOWMIC_EMB13_MAX_MINUTES: '25' },
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.status, 1); assert.match(r.stdout, /"estimatedMinutes":75/);
  assert.match(r.stderr, /estimated 75 minutes exceeds FLOWMIC_EMB13_MAX_MINUTES=25/);
  assert.doesNotMatch(r.stdout, /^relay http/m);
});
if (failures > 0) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
