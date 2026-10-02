import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { coldConfig, coldContextOptions, deliveryKind, judgeCold, markedSpeech, speechTime } from './emb13-cold-lib.mjs';
import fake from './emb13-cold-stt.cjs';

export function coldDrill(check) {
  check('RIG6 quiet release rejects missing silence, late release, reconnecting and duplicate sentences', () => {
    for (const quietPauseMs of [250, 600]) for (const gesture of ['tap', 'hold']) for (const touch of [false, true]) {
      const base = { surface: 'sdk', config: { ...coldConfig({}), quietRelease: true, quietPauseMs, gesture, touch },
        press: 1000, speechAt: 1500, observedSpeechAt: 1500, clockErrorMs: 8, timeOrigin: 100000,
        segments: [{ observedSpeechEndAt: 2200 }], stopAt: 2200 + quietPauseMs, releaseAt: 2200 + quietPauseMs,
        deliveries: ['entry', 'runtime', 'room'].map((kind) => ({ kind, requested: 100000, delivered: 103000 })),
        heard: 'First.', final: 'First.', receiptsOk: true, freshContext: true, cacheDisabled: true,
        startPresses: 1, observationMs: 14000, touchContext: touch,
        inputMethod: touch ? (gesture === 'hold' ? 'cdp-touch' : 'touchscreen.tap') : 'mouse',
        marks: [{ name: 'pointerdown', at: 1000, pointerType: touch ? 'touch' : 'mouse' }, { name: 'chunk-send', at: 11000 }],
        wire: [{ event: 'stt:final' }, { event: 'audio:start' }] };
      assert.equal(judgeCold(base).verdict, 'PASS');
      for (const bad of [{ segments: [] }, { segments: [{ observedSpeechEndAt: 2300 }] },
        { stopAt: base.stopAt - 150 }, { stopAt: base.stopAt + 150 }, { stopAt: 3100 },
        { marks: [...base.marks, { name: 'render', word: 'Reconnecting…' }] },
        { final: '' }, { heard: '' }, { final: 'First. First.' }, { receiptsOk: false },
        { wire: [...base.wire, { event: 'stt:final' }] }, { wire: [...base.wire, { event: 'audio:start' }] }]) {
        assert.equal(judgeCold({ ...base, ...bad }).verdict, 'FAIL');
      }
      assert.equal(judgeCold({ ...base, deliveries: base.deliveries.map((d) => ({ ...d, delivered: 102400 })) }).checks.releaseBeforeRuntime, false);
    }
  });
  check('RIG4 touch knobs and context have invalid-value and mouse reverse controls', () => {
    const config = coldConfig({ FLOWMIC_EMB13_TOUCH: '1', FLOWMIC_EMB13_GESTURE: 'hold' });
    assert.equal(config.gesture, 'hold');
    assert.equal(coldContextOptions(config).hasTouch, true);
    assert.equal(coldContextOptions(config).isMobile, true);
    assert.equal(coldContextOptions(coldConfig({})).hasTouch, false);
    assert.equal(coldContextOptions(coldConfig({})).isMobile, false);
    assert.throws(() => coldConfig({ FLOWMIC_EMB13_TOUCH: 'true' }));
    assert.throws(() => coldConfig({ FLOWMIC_EMB13_GESTURE: 'click' }));
  });
  check('RIG4 second-press and touch judges reject missing, late, reordered and mouse evidence', () => {
    const base = { surface: 'sdk', config: { ...coldConfig({}), secondPress: true }, press: 1000,
      speechAt: 1500, observedSpeechAt: 1500, clockErrorMs: 8, timeOrigin: 100000,
      deliveries: ['entry', 'runtime', 'room'].map((kind) => ({ kind, requested: 100000, delivered: 103000 })),
      heard: 'First tail.', final: 'First tail.', receiptsOk: true, freshContext: true, cacheDisabled: true,
      startPresses: 1, observationMs: 14000, firstStopAt: 2250, secondStopAt: 3600,
      segments: [{ press: 1000, speechAt: 1500, observedSpeechAt: 1500 }, { press: 2350, speechAt: 2850, observedSpeechAt: 2850 }],
      wire: [{ event: 'stt:final' }, { event: 'audio:start' }],
      marks: [{ name: 'chunk-send', at: 11000 }, { name: 'render', at: 11001, voice: 'listening' }] };
    assert.equal(judgeCold(base).verdict, 'PASS');
    for (const bad of [{ segments: [] }, { firstStopAt: 2400 }, { secondStopAt: 2300 },
      { segments: [base.segments[0], { press: 3100, speechAt: 3600, observedSpeechAt: 3600 }] },
      { segments: [base.segments[0], { ...base.segments[1], observedSpeechAt: null }] },
      { final: 'tail First.' }, { final: 'First. tail.' }, { heard: 'First. tail.' }, { wire: [...base.wire, { event: 'stt:final' }] },
      { marks: [{ name: 'render', at: 10999, word: 'Listening…' }, ...base.marks] }]) assert.equal(judgeCold({ ...base, ...bad }).verdict, 'FAIL');
    const touch = { ...base, config: { ...base.config, secondPress: false, touch: true }, touchContext: true,
      inputMethod: 'touchscreen.tap', marks: [...base.marks, { name: 'pointerdown', at: 1000, pointerType: 'touch' }] };
    assert.equal(judgeCold(touch).verdict, 'PASS');
    for (const bad of [{ touchContext: false }, { inputMethod: 'mouse' }, { marks: base.marks },
      { marks: [...base.marks, { name: 'pointerdown', at: 1000, pointerType: 'mouse' }] }]) assert.equal(judgeCold({ ...touch, ...bad }).verdict, 'FAIL');
    const hold = { ...touch, config: { ...touch.config, gesture: 'hold' }, inputMethod: 'cdp-touch', releaseAt: 8000 };
    assert.equal(judgeCold(hold).verdict, 'PASS');
    assert.equal(judgeCold({ ...hold, releaseAt: 1300 }).verdict, 'FAIL');
    assert.equal(judgeCold({ ...hold, inputMethod: 'touchscreen.tap' }).verdict, 'FAIL');
  });
  check('RIG3 latency defaults, overrides, route classes and invalid-value reverse controls', () => {
    assert.deepEqual(coldConfig({}), { touch: false, gesture: 'tap', challengeMs: 8000, entryMs: 1500, runtimeMs: 1500, roomMs: 1500, joinMs: 0, speechMs: 500, settleMs: 1800 });
    for (const [name, key] of [['CHALLENGE_DELAY', 'challengeMs'], ['ENTRY_DELAY', 'entryMs'], ['RUNTIME_DELAY', 'runtimeMs'], ['ROOM_DELAY', 'roomMs'], ['JOIN_DELAY', 'joinMs'], ['SPEECH_DELAY', 'speechMs'], ['COLD_SETTLE', 'settleMs']]) {
      assert.equal(coldConfig({ [`FLOWMIC_EMB13_${name}_MS`]: '12' })[key], 12);
      assert.equal(coldConfig({ [`FLOWMIC_EMB13_${name}_MS`]: '0' })[key], 0);
      for (const bad of ['NaN', '-1', '0.5', '60001']) assert.throws(() => coldConfig({ [`FLOWMIC_EMB13_${name}_MS`]: bad }));
    }
    for (const base of ['demo-card', 'integrator']) {
      assert.equal(deliveryKind(`/go/${base}/v1.js`), 'entry');
      assert.equal(deliveryKind(`/go/${base}/runtime.ab12.js`), 'runtime');
    }
    assert.equal(deliveryKind('/api/web/rooms'), 'room');
    for (const path of ['/api/web/anon', '/assets/site.js', '/try']) assert.equal(deliveryKind(path), null);
  });
  check('RIG3 press clock alignment survives late getUserMedia; mic-relative reverse control', () => {
    assert.equal(speechTime(1000, 1002, 2, 500), 2.498);
    assert.equal(speechTime(1000, 4000, 5, 500), 2.5); // Past onset, never restart at 5.5.
    let now = 1000, down, starts = [];
    class Audio {
      sampleRate = 16000; currentTime = 1; state = 'running';
      createMediaStreamDestination() { return { stream: { clone: () => ({ fake: true }) } }; }
      createConstantSource() { return { offset: {}, connect() {}, start() {} }; }
      createBufferSource() { return { connect() {}, start(t) { starts.push(t); } }; }
    }
    const context = { window: { __coldConfig: coldConfig({}), __coldSpeechTime: speechTime }, AudioContext: Audio,
      navigator: { mediaDevices: {} }, performance: { now: () => now }, document: { addEventListener(type, cb) { down = cb; } } };
    runInNewContext(readFileSync(new URL('./emb13-cold-mic.js', import.meta.url), 'utf8'), context);
    const press = () => down({ composedPath: () => [{ matches: () => true }] });
    press(); assert.deepEqual(starts, [1.5]);
    now = 4000; void context.navigator.mediaDevices.getUserMedia(); press();
    assert.deepEqual(starts, [1.5]); assert.equal(context.window.__coldMic.speechAt, 1500);
    assert.notEqual(context.window.__coldMic.speechAt, now + 500);
    context.window.__coldConfig.secondPress = true;
    press(); assert.deepEqual(starts, [1.5, 1.5]);
    assert.equal(context.window.__coldMic.segments.length, 2);
    assert.equal(context.window.__coldMic.segments[1].press, 4000);
    press(); assert.equal(starts.length, 2); // Stop cannot replay speech.
  });
  check('RIG3 PCM-dependent fake STT retains full prefix, loses clipped prefix, rejects silence and speech without pilots', () => {
    const wav = readFileSync(new URL('../apps/mobile/integration_test/fixtures/zh-6s.wav', import.meta.url));
    const samples = markedSpeech(wav), bytes = Buffer.alloc(samples.length * 2);
    samples.forEach((n, i) => bytes.writeInt16LE(Math.round(n * 32767), i * 2));
    const decode = (b) => { const d = fake.detector(); for (let i = 0; i < b.length; i += 997) d.push(b.subarray(i, i + 997)); return d.read().text; };
    assert.equal(decode(bytes), 'First tail');
    const parts = [0, 1].map((index) => {
      const samples = markedSpeech(wav, index), b = Buffer.alloc(samples.length * 2);
      samples.forEach((n, i) => b.writeInt16LE(Math.round(n * 32767), i * 2)); return b;
    });
    assert.equal(decode(Buffer.concat(parts)), 'First tail');
    assert.equal(decode(Buffer.concat(parts.toReversed())), 'tail First');
    assert.equal(decode(parts[0]), 'First'); assert.equal(decode(parts[1]), 'tail');
    assert.equal(decode(bytes.subarray(3 * 32000)), 'tail');
    assert.equal(decode(Buffer.alloc(bytes.length)), '');
    assert.equal(decode(wav.subarray(44)), '');
    assert.equal(decode(bytes.subarray(0, 320)), ''); // A transient cannot manufacture a word.
  });
  check('RIG3 judge rejects missing first word, false Listening, absent transport, late clock and missing evidence', () => {
    const base = { surface: 'sdk', config: coldConfig({}), press: 1000, speechAt: 1500, observedSpeechAt: 1500.0625, clockErrorMs: 8,
      deliveries: ['entry', 'runtime', 'room'].map((kind) => ({ kind, requested: 0, delivered: 1500 })),
      heard: 'First tail', final: 'First tail', receiptsOk: true, freshContext: true, cacheDisabled: true,
      startPresses: 1, observationMs: 14000, marks: [{ name: 'chunk-send', at: 11000 }, { name: 'render', at: 11001, voice: 'listening' }] };
    assert.equal(judgeCold(base).verdict, 'PASS');
    for (const bad of [{ heard: 'tail', final: 'tail' }, { final: '' }, { receiptsOk: false }, { marks: [] },
      { marks: [{ name: 'render', at: 10999, voice: 'listening' }, ...base.marks] },
      { marks: [{ name: 'render', at: 10999, word: 'Listening…' }, ...base.marks] },
      { speechAt: 4500 }, { observedSpeechAt: null }, { observedSpeechAt: 1600 }, { clockErrorMs: 21 }, { press: null }, { freshContext: false }, { cacheDisabled: false },
      { startPresses: 2 }, { observationMs: 1000 }, { error: 'probe failed' }, { deliveries: [] }, { surface: 'home' },
      { deliveries: base.deliveries.map((d) => ({ ...d, delivered: 25 })) }, { config: { ...base.config, joinMs: 1000 } }]) assert.equal(judgeCold({ ...base, ...bad }).verdict, 'FAIL');
    assert.equal(judgeCold({ ...base, surface: 'home', marks: [...base.marks, { name: 'challenge-start', at: 1000 }, { name: 'challenge-end', at: 9000 }] }).verdict, 'PASS');
    assert.equal(judgeCold({ ...base, marks: [{ name: 'chunk-send', at: 11000 }] }).verdict, 'PASS'); // Stop before join need never render Listening.
  });
}
