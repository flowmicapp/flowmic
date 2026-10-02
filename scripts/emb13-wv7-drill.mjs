import assert from 'node:assert/strict';
import { coldDrill } from './emb13-cold-drill.mjs';
import { readFileSync } from 'node:fs';
import { finalEscrow } from './emb13-wv7-new-scenes.mjs';
import { placement, budget } from './emb13-wv7-lib.mjs';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { assertBudget, correlation, decomposition, judgeDecomposition, judgeEsc, judgeFirstWord, judgeHold, judgeReusedSilence, judgeGesture, firstReaction, judgeFirstClick, browserMeasurement, recordBrowserFlow, judgePhoneLink,
  normalizeSpeech, pass, quantileInterval, relayInterim, requestPolicy, resolveWv7Config, statistics, stratifiedStatistics } from './emb13-wv7-acceptance.mjs';

export function wv7Drill(check) {
  coldDrill(check);
  check('WV7d browser probe preserves socket bytes and observes capture/receive clocks without auth data', () => {
    class Node { connect(destination) { return destination; } }
    class Source extends Node {}
    class Worklet extends Node {}
    class Processor extends Node {}
    class Socket {
      constructor() { this.listeners = {}; }
      addEventListener(name, fn) { this.listeners[name] = fn; }
      send(data) { this.sent = data; return 'sent'; }
    }
    Object.defineProperty(Socket.prototype, 'onmessage', { configurable: true, get() { return null; }, set() {} });
    const events = {}, tasks = [];
    const context = { window: { WebSocket: Socket, addEventListener(type, fn) { events[type] = fn; } }, setTimeout(fn) { tasks.push(fn); }, AudioNode: Node, MediaStreamAudioSourceNode: Source,
      AudioWorkletNode: Worklet, ScriptProcessorNode: Processor, navigator: {},
      performance: { now: () => 120, timeOrigin: 100000 }, PerformanceObserver: { supportedEntryTypes: [] },
      document: { addEventListener() {} }, requestAnimationFrame() {}, atob: (b64) => Buffer.from(b64, 'base64').toString('binary') };
    runInNewContext(readFileSync(new URL('./emb13-wv7-probe.js', import.meta.url), 'utf8'), context);
    const esc = { key: 'Escape', defaultPrevented: false };
    events.keydown(esc);
    assert.equal(context.window.__wv7.marks.some((m) => m.name === 'escape-dispatched'), false);
    esc.defaultPrevented = true; // Product's later document capture listener.
    tasks.splice(0).forEach((fn) => fn());
    assert.equal(context.window.__wv7.marks.at(-1).prevented, true);
    events.keydown({ key: 'Escape', defaultPrevented: false }); tasks.splice(0).forEach((fn) => fn());
    assert.equal(context.window.__wv7.marks.at(-1).prevented, false);
    const socket = new context.window.WebSocket('ws://localhost');
    assert.ok(Object.getOwnPropertyDescriptor(context.window.WebSocket.prototype, 'onmessage'));
    const packet = '42["audio:chunk",{"seq":0,"ts_ms":100100,"data_b64":"/3//fw=="}]';
    assert.equal(socket.send(packet), 'sent'); assert.equal(socket.sent, packet);
    socket.send('42["auth",{"token":"private-fixture-token"}]');
    socket.listeners.message({ data: '42["stt:interim",{"text":"hello"}]' });
    socket.listeners.message({ data: '42["stt:final",{"text":"local fixture"}]' });
    assert.equal(context.window.__wv7.marks.some((m) => m.name === 'wire-final'), true);
    const backend = new Worklet(); assert.equal(new Source().connect(backend), backend);
    const marks = context.window.__wv7.marks;
    assert.equal(marks.find((m) => m.name === 'chunk-send').loud, true);
    assert.equal(marks.find((m) => m.name === 'wire-interim').chars, 5);
    assert.equal(marks.find((m) => m.name === 'capture-begin').at, 120);
    assert.doesNotMatch(JSON.stringify(marks), /private-fixture-token|data_b64|hello/);
  });
  check('WV7d redacted correlation and PASS/FAIL helper', () => {
    assert.equal(pass(true), 'PASS'); assert.equal(pass(false), 'FAIL');
    assert.match(correlation('private-room'), /^[a-f0-9]{20}$/);
    assert.equal(correlation('private-room'), correlation('private-room'));
    assert.notEqual(correlation('private-room'), correlation('other-room'));
  });
  check('WV7d order-statistic intervals expose unbounded small-sample p95', () => {
    const xs = Array.from({ length: 10 }, (_, i) => i + 1);
    assert.deepEqual(quantileInterval(xs, .95).ranks, [8, 11]);
    assert.equal(quantileInterval(xs, .95).upper, null);
    assert.deepEqual(quantileInterval(xs, .5).ranks, [2, 9]);
    const large = quantileInterval(Array.from({ length: 1000 }, (_, i) => i), .95);
    assert.ok(large.lower > 930 && large.upper < 970);
    assert.equal(quantileInterval([], .95).lower, null);
    assert.equal(quantileInterval([], .95).upper, null);
    assert.throws(() => quantileInterval(xs, 1));
  });
  check('WV7d statistics retain failures, timeouts, >2s denominator and strata', () => {
    const rows = [{ liveWord: 100, cold: true, firstUse: true }, { liveWord: 3000, cold: false, firstUse: false },
      { liveWord: null, failed: true, timeout: true, cold: true, firstUse: true }];
    const s = statistics(rows);
    assert.equal(s.n, 3); assert.equal(s.measured, 2); assert.equal(s.failures, 1); assert.equal(s.timeouts, 1);
    assert.equal(s.p50, 100); assert.equal(s.p95, 3000); assert.equal(s.fractionAbove2s, .5);
    assert.deepEqual(s.allAttemptFractionAbove2sBounds, [1 / 3, 2 / 3]);
    const strata = stratifiedStatistics(rows);
    assert.equal(strata.cold.n, 2); assert.equal(strata.warm.n, 1);
    assert.equal(strata['first-use'].failures, 1); assert.equal(strata.subsequent.n, 1);
    assert.equal(stratifiedStatistics([{ reaction: 8, cold: true, firstUse: true }], 'reaction').cold.p50, 8);
    assert.equal(statistics([{ liveWord: -1 }]).failures, 1);
    assert.equal(statistics([]).p95, null);
  });
  check('WV7d request policy PASS plus API, identity and homepage prefetch reverse controls', () => {
    const script = { host: 'challenges.cloudflare.com', path: '/turnstile/v0/api.js' };
    assert.equal(requestPolicy('try', [script]).verdict, 'PASS');
    assert.equal(requestPolicy('home', []).verdict, 'PASS');
    assert.equal(requestPolicy('home', [script]).verdict, 'FAIL');
    for (const surface of ['home', 'try', 'sdk']) {
      for (const path of ['/api/web/anon', '/api/web/rooms', '/api/web/status']) assert.equal(requestPolicy(surface, [{ host: 'localhost', path }]).verdict, 'FAIL');
      assert.equal(requestPolicy(surface, [], 1).verdict, 'FAIL');
    }
  });
  check('WV7d state-scoped Esc PASS plus every cancellation/host-key/dialog reverse control', () => {
    const base = { focused: true, keys: [{ key: ' ', reachedHost: true, prevented: false }, { key: 'Enter', reachedHost: true, prevented: false }],
      keyAudioEdges: 0, prevented: true, reachedHost: false, cancelled: true, initial: 'host', final: 'host',
      inputEvents: 0, lateRestart: false, observationMs: 5500, delayedFinalDelivered: true };
    for (const phase of ['recording', 'connecting', 'finishing']) {
      const row = { ...base, phase, observedPhase: phase };
      assert.equal(judgeEsc(row), 'PASS');
      for (const bad of [{ focused: false }, { prevented: false }, { reachedHost: true }, { cancelled: false }, { final: 'late final' },
        { inputEvents: 1 }, { lateRestart: true }, { observationMs: 100 }, { observedPhase: 'inactive' }, { keys: [] }, { keyAudioEdges: 1 }]) assert.equal(judgeEsc({ ...row, ...bad }), 'FAIL');
      for (const key of [' ', 'Enter']) assert.equal(judgeEsc({ ...row, keys: base.keys.map((k) => k.key === key ? { ...k, prevented: true } : k) }), 'FAIL');
      assert.equal(judgeEsc({ ...row, dialog: true, dialogOpen: true }), 'PASS');
      assert.equal(judgeEsc({ ...row, dialog: true, dialogOpen: false }), 'FAIL');
    }
    assert.equal(judgeEsc({ ...base, phase: 'finishing', observedPhase: 'finishing', delayedFinalDelivered: false }), 'FAIL');
    const idle = { ...base, phase: 'inactive', observedPhase: 'inactive', prevented: false, reachedHost: true, dialog: true, dialogOpen: false };
    assert.equal(judgeEsc(idle), 'PASS');
    assert.equal(judgeEsc({ ...idle, prevented: true }), 'FAIL');
    assert.equal(judgeEsc({ ...idle, focused: false }), 'FAIL');
    assert.equal(judgeEsc({ ...idle, reachedHost: false }), 'FAIL');
    assert.equal(judgeEsc({ ...idle, dialogOpen: true }), 'FAIL');
  });
  check('WV7d cold external hold PASS plus click-only and duplicate-start reverse controls', () => {
    const row = { heldMs: 500, beforeRelease: 'listening', initial: '', final: 'speech', starts: 1, stops: 1, lateRestart: false };
    assert.equal(judgeHold(row), 'PASS');
    for (const bad of [{ heldMs: 350 }, { beforeRelease: 'ready' }, { final: '' }, { starts: 2 }, { stops: 0 }, { lateRestart: true }]) assert.equal(judgeHold({ ...row, ...bad }), 'FAIL');
  });
  check('WV7d exact reused-silence sequence PASS plus stale-level/reacquisition reverse controls', () => {
    const rows = ['toggle', 'hold', 'escape', 'quiet'].map((gesture) => ({ gesture, verdict: 'PASS' }));
    Object.assign(rows[3], { evidence: { quiet: { voice: 'listening', word: 'Cannot hear you' }, returned: { voice: 'listening', word: 'Listening' } }, wire: [{ event: 'audio:start' }], marks: [] });
    assert.equal(judgeReusedSilence(rows), 'PASS');
    assert.equal(judgeReusedSilence(rows.slice(1)), 'FAIL');
    assert.equal(judgeReusedSilence([...rows.slice(0, 3), { ...rows[3], marks: [{ name: 'gum' }] }]), 'FAIL');
    assert.equal(judgeReusedSilence(rows.map((r, i) => i === 0 ? { ...r, verdict: 'FAIL' } : r)), 'FAIL');
    rows[3].evidence.quiet.word = 'Listening'; assert.equal(judgeReusedSilence(rows), 'FAIL');
  });
  check('WV7d first word <=200ms PASS plus late-onset, lost-word and unbuffered reverse controls', () => {
    assert.equal(normalizeSpeech(' 你好，世界！\n'), '你好世界'); assert.equal(normalizeSpeech(null), '');
    const row = { pressToOnsetMs: 180, presses: 1, roomAfterOnset: true, noAudioBeforeRoom: true, firstSeq: 0, buffered: true,
      reference: '你好世界', prefix: 2, heard: '你好世界', inserted: true, receiptsOk: true };
    assert.equal(judgeFirstWord(row), 'PASS');
    for (const bad of [{ pressToOnsetMs: 201 }, { pressToOnsetMs: null }, { presses: 2 }, { roomAfterOnset: false }, { noAudioBeforeRoom: false },
      { firstSeq: 1 }, { buffered: false }, { reference: '' }, { heard: '世界' }, { inserted: false }, { receiptsOk: false }]) assert.equal(judgeFirstWord({ ...row, ...bad }), 'FAIL');
  });
  check('WV7d same-clock decomposition PASS plus render delay and missing capture reverse controls', () => {
    const input = { key: 'safe', timeOrigin: 100000, marks: [{ name: 'capture-begin', at: 100 }, { name: 'audio-onset', at: 180 },
      { name: 'chunk-send', at: 200, loud: true }, { name: 'wire-interim', at: 1000, chars: 2 }, { name: 'render', at: 1010, interim: 'hi' }] };
    const d = decomposition(input);
    assert.equal(d.onsetToChunk, 20); assert.equal(d.onsetToWire, 820); assert.equal(d.wireToRender, 10);
    assert.equal(d.captureToOnset, 80); assert.equal(d.relay.vendorLegOpened, null); assert.equal(judgeDecomposition(d), 'PASS');
    assert.equal(judgeDecomposition(decomposition({ ...input, marks: input.marks.slice(1) })), 'FAIL');
    assert.equal(judgeDecomposition(decomposition({ ...input, marks: input.marks.map((m) => m.name === 'render' ? { ...m, at: 1510 } : m) })), 'FAIL');
    const warm = decomposition({ ...input, captureReused: true, marks: input.marks.slice(1) });
    assert.equal(judgeDecomposition(warm), 'PASS');
    assert.equal(warm.captureMeasurement, 'not applicable (capture reused)');
    assert.equal(warm.captureToOnset, null); assert.equal(warm.onsetToWire, 820);
    assert.equal(judgeDecomposition(decomposition({ ...input, captureReused: true, marks: input.marks.slice(2) })), 'FAIL');
    const fallback = decomposition({ key: 'safe', timeOrigin: 100000, wire: [{ event: 'audio:chunk', at: 100200 }] });
    assert.equal(fallback.browser.firstChunk, 200); assert.equal(fallback.browser.interimReceive, null);
  });
  check('RIG2 late-final local protocol delayedFinalDelivered=true after cancel PASS; insertion reverse FAIL', () => {
    let cancelled = false, field = 'host', clock = 100, received = 0;
    const hold = finalEscrow((message) => { if (message.includes('"stt:final"')) { received++; if (!cancelled) field += ' late'; } }, () => clock);
    hold.receive('42["stt:final",{"text":"local final fixture"}]');
    assert.equal(hold.pending.length, 1); assert.equal(received, 0);
    cancelled = true; clock = 200; hold.release();
    assert.equal(received, 1); assert.equal(field, 'host'); assert.deepEqual(hold.delivered, [200]);
    const row = { focused: true, phase: 'finishing', observedPhase: 'finishing', keys: [' ', 'Enter'].map((key) => ({ key, reachedHost: true, prevented: false })),
      keyAudioEdges: 0, prevented: true, reachedHost: false, cancelled, initial: 'host', final: field, inputEvents: 0, lateRestart: false, observationMs: 5500, delayedFinalDelivered: received === 1 };
    assert.equal(judgeEsc(row), 'PASS');
    assert.equal(judgeEsc({ ...row, delayedFinalDelivered: false }), 'FAIL');
    assert.equal(judgeEsc({ ...row, final: 'host late', inputEvents: 1 }), 'FAIL');
  });
  check('RIG2 gesture rows independently PASS and FAIL for quiet double tap, speech and next-press error clearing', () => {
    const quick = { gesture: 'quick-double-tap', elapsedMs: 200, speechDetected: false, initial: '', final: '', inputEvents: 0, quietThroughout: true, observationMs: 5200, lateRestart: false };
    assert.equal(judgeGesture(quick), 'PASS');
    for (const bad of [{ elapsedMs: 1000 }, { speechDetected: true }, { final: 'text' }, { inputEvents: 1 }, { quietThroughout: false }, { observationMs: 100 }, { lateRestart: true }]) assert.equal(judgeGesture({ ...quick, ...bad }), 'FAIL');
    for (const gesture of ['toggle', 'hold']) {
      const row = { gesture, initial: '', final: 'speech', finalState: { voice: 'added', error: '' } };
      assert.equal(judgeGesture(row), 'PASS');
      for (const bad of [{ failed: true }, { final: '' }, { finalState: { error: 'red' } }]) assert.equal(judgeGesture({ ...row, ...bad }), 'FAIL');
    }
    const clear = { gesture: 'error-cleared', errorBefore: true, errorAfterPress: false, pressFeedback: true };
    assert.equal(judgeGesture(clear), 'PASS');
    for (const bad of [{ errorBefore: false }, { errorAfterPress: true }, { pressFeedback: false }]) assert.equal(judgeGesture({ ...clear, ...bad }), 'FAIL');
  });
  check('RIG2 SDK real single-click feedback PASS; chooser, invisible button and slow reaction FAIL', () => {
    const initial = { visible: false, pressed: 'false' };
    const pressed = { name: 'render', at: 115, buttonVisible: true, pressed: 'true' };
    const capsule = { name: 'render', at: 120, visible: true, voice: 'starting' };
    const reaction = firstReaction([pressed, capsule], initial, 100);
    assert.equal(reaction, 15); assert.equal(firstReaction([capsule], initial, 100), 20);
    assert.equal(firstReaction([{ ...pressed, buttonVisible: false }], initial, 100), null);
    assert.equal(firstReaction([{ name: 'render', at: 110, nativeActive: true }], initial, 100), null);
    const row = { startPresses: 1, listening: true, reaction };
    assert.equal(judgeFirstClick(row), 'PASS'); assert.equal(budget([reaction], 100, 150).verdict, 'PASS');
    for (const bad of [{ startPresses: 2 }, { listening: false }, { reaction: null }]) assert.equal(judgeFirstClick({ ...row, ...bad }), 'FAIL');
    assert.equal(budget([firstReaction([{ ...capsule, at: 400 }], initial, 100)], 100, 150).verdict, 'FAIL');
  });
  check('RIG2 dockTop geometry PASS; field/control overlap and clipped capsule FAIL', () => {
    const box = (left, top, right, bottom) => ({ left, top, right, bottom });
    const row = { capsule: box(8, 8, 208, 88), field: box(8, 93, 208, 129), button: box(210, 93, 245, 129),
      viewport: { width: 300, height: 141 }, side: 'dockTop', pointerEvents: 'none', pressHitsButton: true };
    assert.equal(placement(row).verdict, 'PASS');
    for (const capsule of [row.field, row.button, box(-1, 8, 208, 88), box(8, 8, 301, 88), box(8, -1, 208, 88), box(8, 130, 208, 142)]) assert.equal(placement({ ...row, capsule }).verdict, 'FAIL');
  });
  check('RIG2 WebKit measured PASS; missing or failed row is FAIL and honestly not measured', () => {
    assert.equal(browserMeasurement('WebKit', { measured: true }).verdict, 'PASS');
    for (const row of [undefined, {}, { error: 'probe failed' }, { measured: true, failed: true }]) {
      assert.equal(browserMeasurement('WebKit', row).verdict, 'FAIL');
      assert.equal(browserMeasurement('WebKit', row).measurement, 'WebKit not measured');
    }
  });
  check('RIG2 missing WebKit result row is preserved without a crash; actual measured flow PASS', () => {
    const result = { flows: [], checks: {} };
    assert.equal(recordBrowserFlow(result, 'sdk', 'WebKit').verdict, 'FAIL');
    assert.equal(result.flows[0].measurement, 'WebKit not measured');
    result.flows.push({ surface: 'home', measured: true });
    assert.equal(recordBrowserFlow(result, 'home', 'WebKit').verdict, 'PASS');
    assert.equal(recordBrowserFlow(result, 'try', 'WebKit').verdict, 'FAIL');
    assert.equal(result.flows.length, 3);
  });
  check('RIG2 optional SDK phone link in panel PASS; missing panel or link FAIL', () => {
    assert.equal(judgePhoneLink({ panelVisible: true, linkVisible: true }), 'PASS');
    assert.equal(judgePhoneLink({ panelVisible: false, linkVisible: true }), 'FAIL');
    assert.equal(judgePhoneLink({ panelVisible: true, linkVisible: false }), 'FAIL');
  });
  check('WV7d relay log joins one hashed room and sentence interval without inventing vendor times', () => {
    const epoch = Date.parse('2026-09-30T10:00:00Z');
    const line = '[2026-09-30T10:00:00.000Z] INFO stt.interim first frame of this utterance {"room":"private-room","chars":2}';
    assert.equal(relayInterim(line, correlation('private-room'), epoch - 1, epoch + 1), epoch);
    assert.equal(relayInterim(line, correlation('other'), epoch - 1, epoch + 1), null);
    assert.equal(relayInterim(line, correlation('private-room'), epoch + 1, epoch + 2), null);
    assert.equal(relayInterim(`${line}\n${line}`, correlation('private-room'), epoch - 1, epoch + 1), null);
    assert.equal(relayInterim('not JSON', 'safe', 0, 1), null);
  });
  check('WV7d sentence configuration and minutes cap PASS plus overspend reverse control', () => {
    const config = resolveWv7Config({}, []);
    assert.equal(config.sentences, 10); assert.equal(config.maxMinutes, 25); assert.equal(config.estimatedMinutes, 29.25);
    assert.throws(() => assertBudget(config), /exceeds/);
    assert.equal(resolveWv7Config({ FLOWMIC_EMB13_WV7_SCENARIO: 'gestures' }, []).estimatedMinutes, 5.25);
    const big = resolveWv7Config({ FLOWMIC_EMB13_SENTENCES: '100', FLOWMIC_EMB13_WV7_SCENARIO: 'budget' }, []);
    assert.equal(big.estimatedMinutes, 75); assert.equal(big.verdict, 'FAIL'); assert.throws(() => assertBudget(big), /exceeds/);
    assert.equal(resolveWv7Config({ FLOWMIC_EMB13_SENTENCES: '40', FLOWMIC_EMB13_WV7_SCENARIO: 'budget', FLOWMIC_EMB13_MAX_MINUTES: '30' }, []).verdict, 'PASS');
    assert.throws(() => resolveWv7Config({ FLOWMIC_EMB13_SENTENCES: '0' }, []));
    assert.throws(() => resolveWv7Config({ FLOWMIC_EMB13_MAX_MINUTES: 'NaN' }, []));
    assert.throws(() => resolveWv7Config({ FLOWMIC_EMB13_WV7_SURFACES: 'home,home' }, []));
    assert.throws(() => resolveWv7Config({ FLOWMIC_EMB13_WV7_SCENARIO: 'typo' }, []));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failures = 0;
  wv7Drill((name, fn) => { try { fn(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); } });
  process.exitCode = failures ? 1 : 0;
  console.log(failures ? `${failures} failed` : 'all WV7 drill checks passed');
}
