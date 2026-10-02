// Offline judges shared by the browser rig and its drill. No auth identifiers.
import { createHash } from 'node:crypto';
import { coldConfig, coldScenes } from './emb13-cold-lib.mjs';
import { percentile } from './emb13-live-rig-lib.mjs';

export const pass = (ok) => ok ? 'PASS' : 'FAIL';
export const normalizeSpeech = (value) => String(value ?? '').replace(/[\s\p{P}]/gu, '');
export function correlation(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
}

// Exact central binomial order-statistic ranks for an independent-sample 95% CI.
// Rank 0 / n+1 means unbounded, not the observed minimum / maximum.
export function quantileInterval(values, p) {
  if (!(p > 0 && p < 1)) throw new Error('quantile must be between 0 and 1');
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b), n = xs.length;
  let logChoose = 0, cumulative = 0, low = null, high = null;
  for (let k = 0; k <= n; k++) {
    if (k) logChoose += Math.log(n - k + 1) - Math.log(k);
    cumulative += Math.exp(logChoose + k * Math.log(p) + (n - k) * Math.log1p(-p));
    if (low === null && cumulative >= 0.025) low = k;
    if (high === null && cumulative >= 0.975) high = k + 1;
  }
  low ??= 0; high ??= n + 1;
  return { confidence: 0.95, ranks: [low, high], lower: low > 0 ? xs[low - 1] : null,
    upper: high <= n ? xs[high - 1] : null, assumption: 'independent sentences; paired sessions are clustered, nominal coverage only' };
}
export function statistics(rows, metric = 'liveWord') {
  const xs = rows.map((r) => r[metric]).filter((v) => Number.isFinite(v) && v >= 0);
  const missing = rows.length - xs.length;
  const above = xs.filter((v) => v > 2000).length;
  return { n: rows.length, measured: xs.length, missing,
    failures: rows.filter((r) => r.failed || !Number.isFinite(r[metric]) || r[metric] < 0).length,
    timeouts: rows.filter((r) => r.timeout).length,
    p50: percentile(xs, 50), p95: percentile(xs, 95),
    p50Interval: quantileInterval(xs, 0.5), p95Interval: quantileInterval(xs, 0.95),
    above2s: above, fractionAbove2s: xs.length ? above / xs.length : null,
    allAttemptFractionAbove2sBounds: rows.length ? [above / rows.length, (above + missing) / rows.length] : [null, null] };
}
export function stratifiedStatistics(rows, metric = 'liveWord') {
  return Object.fromEntries(['all', 'cold', 'warm', 'first-use', 'subsequent'].map((s) => [s,
    statistics(rows.filter((r) => s === 'all' || (s === 'cold' ? r.cold : s === 'warm' ? !r.cold : s === 'first-use' ? r.firstUse : !r.firstUse)), metric)]));
}
export function requestPolicy(surface, requests, mintedIdentities = requests.filter((r) => r.mintedIdentity).length) {
  const api = requests.filter((r) => r.path.startsWith('/api/web/'));
  const challenge = requests.filter((r) => r.host === 'challenges.cloudflare.com');
  return { api: api.length, anonymousRequests: api.filter((r) => /\/anon(?:\/|$)/.test(r.path)).length,
    mintedIdentities, challenge: challenge.length,
    verdict: pass(api.length === 0 && mintedIdentities === 0 && (surface === 'try' || challenge.length === 0)) };
}
export function judgeEsc(r) {
  const active = ['recording', 'connecting', 'finishing'].includes(r.phase);
  const hostKeys = [' ', 'Enter'].every((key) => r.keys?.some((e) => e.key === key && e.reachedHost && !e.prevented)) && r.keyAudioEdges === 0;
  return pass(r.focused === true && hostKeys && r.observedPhase === r.phase && (active
    ? r.prevented === true && r.reachedHost === false && r.cancelled === true && r.initial === r.final && r.inputEvents === 0 && r.lateRestart === false && r.observationMs >= 5000 && (r.phase !== 'finishing' || r.delayedFinalDelivered === true) && (!r.dialog || r.dialogOpen === true)
    : r.prevented === false && r.reachedHost === true && (!r.dialog || r.dialogOpen === false)));
}
export function judgeHold(r) {
  return pass(r.heldMs > 350 && r.beforeRelease === 'listening' && r.final.length > r.initial.length && r.starts === 1 && r.stops === 1 && !r.lateRestart);
}
export function judgeReusedSilence(rows) {
  const q = rows.at(-1);
  return pass(rows.map((r) => r.gesture).join(',') === 'toggle,hold,escape,quiet' && rows.every((r) => r.verdict === 'PASS') && q?.evidence?.quiet?.voice === 'listening'
    && /CantHear|hear/i.test(q.evidence.quiet.word) && q.evidence.returned?.voice === 'listening'
    && !/CantHear|hear/i.test(q.evidence.returned.word) && q.wire.filter((f) => f.event === 'audio:start').length === 1
    && q.marks?.filter((m) => m.name === 'gum').length === 0);
}
export function judgeGesture(r) {
  if (r.failed) return 'FAIL';
  if (r.gesture === 'quick-double-tap') return pass(r.elapsedMs < 1000 && r.elapsedMs >= 0 && r.speechDetected === false
    && r.initial === r.final && r.inputEvents === 0 && r.quietThroughout === true && r.observationMs >= 5000 && !r.lateRestart);
  if (r.gesture === 'error-cleared') return pass(r.errorBefore === true && r.errorAfterPress === false && r.pressFeedback === true);
  if (r.gesture === 'escape') return pass(r.initial === r.final && r.evidence?.cancelled?.voice === 'cancelled');
  return pass(['toggle', 'hold', 'quiet'].includes(r.gesture) && r.final?.length > r.initial?.length
    && !r.finalState?.error && r.finalState?.voice !== 'heardNothing'
    && (r.gesture !== 'hold' || r.holdBeganBeforeRelease !== false));
}
export function firstReaction(marks, initial, press) {
  if (!Number.isFinite(press)) return null;
  const r = marks.find((m) => m.name === 'render' && m.at >= press &&
    ((m.visible && (!initial.visible || m.voice !== initial.voice || m.word !== initial.word)) ||
     (m.buttonVisible && m.pressed === 'true' && initial.pressed !== 'true') ||
     (m.buttonVisible && m.busy === 'true' && initial.busy !== 'true' && m.svgVisual !== initial.svgVisual)));
  return r ? r.at - press : null;
}
export function judgeFirstClick(r) {
  return pass(r.startPresses === 1 && r.listening === true && Number.isFinite(r.reaction) && r.reaction >= 0);
}
export function browserMeasurement(kind, row) {
  return { verdict: pass(!!row && !row.error && !row.failed && row.measured === true),
    measurement: row && !row.error && !row.failed && row.measured === true ? `${kind} measured` : `${kind} not measured` };
}
export function recordBrowserFlow(result, surface, kind, wire = []) {
  let row = result.flows.at(-1);
  if (!row || row.surface !== surface) { row = { surface, measured: false }; result.flows.push(row); }
  Object.assign(row, browserMeasurement(kind, row), { wire });
  result.checks[surface] = row.verdict;
  return row;
}
export function judgePhoneLink(r) { return pass(r.panelVisible === true && r.linkVisible === true); }
export function judgeFirstWord(r) {
  return pass(Number.isFinite(r.pressToOnsetMs) && r.pressToOnsetMs >= 0 && r.pressToOnsetMs <= 200
    && r.presses === 1 && r.roomAfterOnset && r.noAudioBeforeRoom && r.firstSeq === 0 && r.buffered
    && r.reference.length >= r.prefix && r.heard.startsWith(r.reference.slice(0, r.prefix)) && r.inserted && r.receiptsOk);
}
export function decomposition({ key, timeOrigin, marks = [], wire = [], relay = {}, captureReused = false }) {
  const at = (name) => marks.find((m) => m.name === name)?.at ?? null;
  const first = (event, predicate = () => true) => wire.find((m) => m.event === event && predicate(m));
  const wireAt = (event, predicate) => { const m = first(event, predicate); return m && Number.isFinite(timeOrigin) ? m.at - timeOrigin : null; };
  const browser = { timeOrigin: timeOrigin ?? null, captureBegin: at('capture-begin'), speechOnset: at('audio-onset'),
    firstChunk: at('chunk-send') ?? wireAt('audio:chunk'), firstLoudChunk: marks.find((m) => m.name === 'chunk-send' && m.loud)?.at ?? null,
    interimReceive: marks.find((m) => m.name === 'wire-interim' && m.chars > 0)?.at ?? null,
    render: marks.find((m) => m.name === 'render' && m.interim)?.at ?? null };
  const delta = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
  return { key, browser, captureReused, captureMeasurement: captureReused && browser.captureBegin === null ? 'not applicable (capture reused)' : Number.isFinite(browser.captureBegin) ? 'measured' : 'not measured', relay: { audioArrival: null, vendorLegOpened: null, firstAudioFed: null, firstVendorInterim: null, relayInterimSent: null, ...relay },
    onsetToChunk: delta(browser.speechOnset, browser.firstLoudChunk), onsetToWire: delta(browser.speechOnset, browser.interimReceive),
    wireToRender: delta(browser.interimReceive, browser.render), captureToOnset: delta(browser.captureBegin, browser.speechOnset) };
}
export function judgeDecomposition(d, renderLimit = 100) {
  return pass(Object.entries(d.browser).every(([key, value]) => Number.isFinite(value) || (key === 'captureBegin' && value === null && d.captureReused === true)) && d.wireToRender >= 0 && d.wireToRender <= renderLimit);
}
export function resolveWv7Config(env = process.env, argv = process.argv) {
  const integer = (name, fallback) => { const v = Number(env[name] ?? fallback); if (!Number.isSafeInteger(v) || v < 1) throw new Error(`${name} must be a positive integer`); return v; };
  const sentences = integer('FLOWMIC_EMB13_SENTENCES', 2 * integer('FLOWMIC_EMB13_RUNS', 5));
  const t4Runs = integer('FLOWMIC_EMB13_T4_RUNS', 5);
  const scenario = argv.find((a) => a.startsWith('--wv7-scenario='))?.split('=')[1] ?? env.FLOWMIC_EMB13_WV7_SCENARIO ?? 'all';
  const surfaces = (env.FLOWMIC_EMB13_WV7_SURFACES ?? 'home,try,sdk').split(',');
  if (surfaces.some((s) => !['home', 'try', 'sdk'].includes(s)) || new Set(surfaces).size !== surfaces.length) throw new Error('invalid WV7 surfaces');
  const counts = { 'cold-first-word': 1, 'cold-first-word-touch': 1, 'second-press': 1, 'quiet-release': 1, budget: sentences, 'escape-scoped': 6, 'cold-hold': 1, 'reused-silence': 5, gestures: 7, 'phone-link': 1, 'request-policy': 0, 'first-word': t4Runs + 2,
    behaviour: 8, screenshots: 12, quiet: 4, keyboard: 3, placement: 2, browsers: 6, inspect: 1,
    toggle: 2, hold: 2, 'tap-hold': 7, escape: 2, 'escape-field': 2, finishing: 2 };
  counts.all = sentences + 6 + 1 + 5 + 7 + t4Runs + 2 + 3;
  if (!(scenario in counts)) throw new Error('unknown WV7 scenario');
  const maxMinutes = Number(env.FLOWMIC_EMB13_MAX_MINUTES ?? 25);
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('FLOWMIC_EMB13_MAX_MINUTES must be positive');
  const cold = coldScenes.includes(scenario) ? { ...coldConfig(env), secondPress: scenario === 'second-press' } : null;
  if (scenario === 'cold-first-word-touch') cold.touch = true;
  if (scenario === 'quiet-release') {
    cold.quietRelease = true;
    cold.quietPauseMs = Number(env.FLOWMIC_EMB13_QUIET_PAUSE_MS ?? 250);
    if (![250, 600].includes(cold.quietPauseMs)) throw new Error('QUIET_PAUSE_MS must be 250 or 600');
  }
  if (cold?.secondPress && cold.gesture !== 'tap') throw new Error('second-press requires tap');
  const plannedSentences = counts[scenario] * surfaces.length;
  const estimatedMinutes = plannedSentences * 15 / 60;
  return { scenario, surfaces, sentences, t4Runs, plannedSentences, estimatedMinutes, maxMinutes,
    ...(cold ? { cold } : {}),
    estimateBasis: '15 seconds streamed per planned recording; estimate, not billing guarantee',
    verdict: pass(estimatedMinutes <= maxMinutes) };
}
export function assertBudget(config) {
  if (config.verdict !== 'PASS') throw new Error(`estimated ${config.estimatedMinutes} minutes exceeds FLOWMIC_EMB13_MAX_MINUTES=${config.maxMinutes}`);
  return config;
}

// Existing server-core log: room-scoped first interim immediately before emit.
// Match hashed room plus sentence wall-time bounds; never export the raw room.
export function relayInterim(log, roomHash, start, end) {
  const matches = [];
  for (const line of log.split(/\r?\n/)) {
    try {
      const legacy = line.match(/^\[([^\]]+)\] INFO stt\.interim first frame of this utterance (\{.*\})$/);
      const r = legacy ? { ...JSON.parse(legacy[2]), ts: legacy[1], msg: 'stt.interim first frame of this utterance' } : JSON.parse(line);
      if (r.msg !== 'stt.interim first frame of this utterance' && r.message !== 'stt.interim first frame of this utterance') continue;
      const at = typeof r.time === 'number' ? r.time : Date.parse(r.ts ?? r.time ?? r.timestamp);
      const room = r.room ?? r.data?.room ?? r.meta?.room;
      if (room && correlation(room) === roomHash && at >= start && at <= end) matches.push(at);
    } catch { /* Non-JSON output cannot be assigned a fabricated timestamp. */ }
  }
  return matches.length === 1 ? matches[0] : null;
}
