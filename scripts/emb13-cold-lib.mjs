import { parseWav } from './emb13-live-rig-lib.mjs';

export const coldScenes = ['cold-first-word', 'cold-first-word-touch', 'second-press', 'quiet-release'];
export function coldContextOptions(config) {
  return { viewport: { width: 1280, height: 900 }, locale: 'en-US', permissions: ['microphone'],
    serviceWorkers: 'block', hasTouch: config.touch, isMobile: config.touch };
}

export function coldConfig(env = process.env) {
  const ms = (name, fallback) => {
    const n = Number(env[`FLOWMIC_EMB13_${name}_MS`] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 0 || n > 60000) throw new Error(`${name}_MS must be an integer in 0..60000`);
    return n;
  };
  const touch = env.FLOWMIC_EMB13_TOUCH ?? '0';
  const gesture = env.FLOWMIC_EMB13_GESTURE ?? 'tap';
  if (!['0', '1'].includes(touch)) throw new Error('TOUCH must be 0 or 1');
  if (!['tap', 'hold'].includes(gesture)) throw new Error('GESTURE must be tap or hold');
  return { touch: touch === '1', gesture, challengeMs: ms('CHALLENGE_DELAY', 8000), entryMs: ms('ENTRY_DELAY', 1500),
    runtimeMs: ms('RUNTIME_DELAY', 1500), roomMs: ms('ROOM_DELAY', 1500), joinMs: ms('JOIN_DELAY', 0),
    speechMs: ms('SPEECH_DELAY', 500), settleMs: ms('COLD_SETTLE', 1800) };
}

export function deliveryKind(path) {
  if (/\/go\/(demo-card|integrator)\/v1\.js$/.test(path)) return 'entry';
  if (/\/go\/(demo-card|integrator)\/.*\.js$/.test(path)) return 'runtime';
  if (path === '/api/web/rooms') return 'room';
  return null;
}

// WebAudio time and performance.now() sampled in the same press handler.
export function speechTime(pressMs, nowMs, audioSeconds, delayMs) {
  return audioSeconds + (pressMs + delayMs - nowMs) / 1000;
}

// Real local speech with two audible pilot tones identifying its segments.
// The fake adapter decodes pilots, NOT Mandarin. Its output labels are fixtures.
export function markedSpeech(wavBuffer, segment) {
  const wav = parseWav(wavBuffer);
  if (wav.channels !== 1 || wav.bitsPerSample !== 16 || wav.sampleRate !== 16000) throw new Error('cold fixture needs mono 16kHz PCM16');
  const pcm = new Float32Array((segment === undefined ? 6 : .7) * 16000);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / 16000;
    const hz = segment === undefined ? (t < .7 ? 700 : t >= 3.5 && t < 5.5 ? 1300 : 0) : segment === 0 ? 700 : 1300;
    pcm[i] = (i * 2 + 1 < wav.data.length ? wav.data.readInt16LE(i * 2) / 32768 * .25 : 0)
      + (hz ? .3 * Math.sin(2 * Math.PI * hz * t) : 0);
  }
  return Array.from(pcm);
}

export function judgeCold(row) {
  const finite = Number.isFinite;
  const firstChunk = row.marks?.find((m) => m.name === 'chunk-send')?.at;
  const listening = row.marks?.filter((m) => m.name === 'render' && (m.voice === 'listening' || /listening/i.test(m.word ?? ''))) ?? [];
  const delivered = (kind, ms) => row.deliveries?.some((d) => d.kind === kind && finite(d.delivered) && d.delivered - d.requested >= ms - 20);
  const challengeStart = row.marks?.find((m) => m.name === 'challenge-start')?.at;
  const challengeEnd = row.marks?.find((m) => m.name === 'challenge-end')?.at;
  const checks = {
    alignment: finite(row.press) && finite(row.speechAt) && finite(row.clockErrorMs)
      && finite(row.observedSpeechAt) && Math.abs(row.observedSpeechAt - row.speechAt) <= 20
      && Math.abs(row.speechAt - row.press - row.config.speechMs) <= 20 && row.clockErrorMs <= 20,
    firstWord: /^First\b/.test(row.heard ?? '') && /^First\b/.test(row.final ?? ''),
    tail: row.config.quietRelease || (/tail/.test(row.heard ?? '') && /tail/.test(row.final ?? '')),
    inserted: row.receiptsOk === true,
    truthfulListening: listening.every((m) => finite(firstChunk) && m.at >= firstChunk),
    transport: finite(firstChunk),
    observed: row.freshContext === true && row.cacheDisabled === true && row.startPresses === 1
      && row.observationMs >= 7000 && !row.error,
    latency: delivered('entry', row.config.entryMs) && delivered('runtime', row.config.runtimeMs) && delivered('room', row.config.roomMs)
      && (!row.config.joinMs || delivered('join', row.config.joinMs))
      && (row.surface === 'sdk' || (finite(challengeStart) && finite(challengeEnd) && challengeEnd - challengeStart >= row.config.challengeMs - 20)),
  };
  if (row.config.touch) {
    const pointers = row.marks?.filter((m) => m.name === 'pointerdown' && m.at >= row.press - 20) ?? [];
    checks.touch = row.touchContext === true && pointers.length > 0 && pointers.every((m) => m.pointerType === 'touch')
      && row.inputMethod === (row.config.gesture === 'hold' ? 'cdp-touch' : 'touchscreen.tap');
  }
  if (row.config.gesture === 'hold') checks.hold = row.releaseAt - row.press >= row.config.speechMs + (row.config.quietRelease ? 700 + row.config.quietPauseMs : 6000);
  if (row.config.quietRelease) {
    const end = row.segments?.[0]?.observedSpeechEndAt;
    const runtime = row.deliveries?.filter((d) => d.kind === 'runtime' && finite(d.delivered)).map((d) => d.delivered - row.timeOrigin) ?? [];
    checks.quietPause = finite(end) && finite(row.stopAt)
      && Math.abs(end - row.speechAt - 700) <= 20
      && row.stopAt - end >= row.config.quietPauseMs - 20
      && row.stopAt - end <= row.config.quietPauseMs + 100;
    checks.releaseBeforeRuntime = runtime.length > 0 && row.stopAt < Math.min(...runtime);
    checks.noReconnecting = !row.marks?.some((m) => m.name === 'render' && /reconnect|linkDown/i.test(`${m.voice ?? ''} ${m.word ?? ''} ${m.error ?? ''}`));
    checks.oneSentence = row.final === 'First.' && row.heard === 'First.'
      && row.wire?.filter((f) => f.event === 'stt:final').length === 1
      && row.wire?.filter((f) => f.event === 'audio:start').length === 1;
  }
  if (row.config.secondPress) {
    const runtime = row.deliveries?.filter((d) => d.kind === 'runtime').map((d) => d.delivered - row.timeOrigin) ?? [];
    checks.secondPress = row.segments?.length === 2 && row.press < row.firstStopAt
      && row.firstStopAt < row.segments[1].press && row.segments[1].press < row.secondStopAt
      && runtime.length > 0 && row.segments[1].press < Math.min(...runtime);
    checks.secondAlignment = row.segments?.length === 2 && row.segments.every((s) => finite(s.observedSpeechAt)
      && Math.abs(s.observedSpeechAt - s.speechAt) <= 20 && Math.abs(s.speechAt - s.press - row.config.speechMs) <= 20);
    checks.oneSentence = row.final === 'First tail.' && row.heard === 'First tail.'
      && row.wire?.filter((f) => f.event === 'stt:final').length === 1
      && row.wire?.filter((f) => f.event === 'audio:start').length === 1;
  }
  return { checks, verdict: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL' };
}
