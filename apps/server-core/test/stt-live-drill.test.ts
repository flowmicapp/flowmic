// 🔴 LIVE DRILL — real network, real vendor, real audio. NOT part of the normal
// suite: gated on `FLOWMIC_LIVE_STT=1` AND on `.local/soniox.env` existing.
//
// SPEC-REF:
//   docs/strategy/2026-08-02-m2-window-handoff-report.md §5 M2-3
//     (🔴 Soniox has never actually been run — adapter layer fully tested, real link unproven)
//   docs/strategy/2026-08-02-h6-soniox-streaming-adapter-card.md §-0b
//     (🔴 failover counts as delivered only after an [active drill] —「not drilled = not done」), §7 B half
//   docs/strategy/shots-2026-08-02-l9-soniox-output/README.md (this round's raw
//     evidence: what Soniox actually puts on the wire, and the two defects it
//     exposed)
//   CLAUDE.md rule: unit tests all green prove nothing about 「wiring」; every real path needs one real-end run
//
// WHY THIS EXISTS AS A TEST AND NOT A SCRIPT: the whole value of the run is that
// the sample comes out of the path PRODUCTION WALKS. So it drives
// `makeSttOrchestratorFactory` with NO injected `managedDefault` and NO injected
// `engineFactory`, i.e.:
//     SttSessionBridge → makeSttOrchestratorFactory → makePoolManagedDefault
//       → selectRoute → engine-router → defaultEngineFactory
//       → requireCloudEngine → @flowmic/stt-cloud → real `ws`
// 「how hard a measurement is depends on whether the mechanism that produced it is the path the product walks」.
//
// 🔴 2026-08-02 (L9) — WHAT THIS FILE USED TO BE, because the lesson is the
// reason it now looks like this. Three of its cases had NO ASSERTION AT ALL:
// they called `speak()` and `report()` and were green no matter what came back —
// including a run whose transcript was the empty string. One of them was named
// 「after the primary is judged dead, the pool fails over」 while nothing was ever
// killed and all three sessions ran on the primary. 「a test's name answered a question
// its function body never asked」. A drill that cannot fail is a screenshot.
//
// 🔴 NO KEY IS EVER PRINTED. The env is read into memory and only the LENGTH of
// the key is ever reported.
//
// Run:
//   pnpm --filter @flowmic/stt-cloud build   ← MANDATORY: server-core eats dist
//   FLOWMIC_LIVE_STT=1 npx vitest run test/stt-live-drill.test.ts --testTimeout 180000

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { SttSessionBridge } from '../src/engine/stt-session';
import { defaultEngineFactory, makeSttOrchestratorFactory } from '../src/stt/engine-factory';
import { loadPool } from '../src/stt/pool-config';
import { makePoolManagedDefault, resolvePoolRouting } from '../src/stt/pool-routing';
import { probeRouteLiveness } from '../src/stt/pool-health';
import { readOrchestratorTuningFromEnv } from '../src/stt/tuning-env';
import { log } from '../src/log';
import type { SettingRow, SettingsRepo } from '../src/db/repos/settings.repo';

const REPO = resolve(import.meta.dirname, '../../..');
const SONIOX_ENV = resolve(REPO, '.local/soniox.env');
const CLOUD_PKG = resolve(REPO, 'packages/stt-cloud/dist/index.cjs');
const LIVE = process.env.FLOWMIC_LIVE_STT === '1' && existsSync(SONIOX_ENV) && existsSync(CLOUD_PKG);

/** Real 16 kHz mono s16le speech already in the repo — nothing synthesised. */
const AUDIO = {
  zh: resolve(REPO, 'apps/mobile/integration_test/fixtures/zh-6s.wav'),
  en: resolve(REPO, 'scratch/spike-sherpa/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/test_wavs/en.wav'),
};
/** The LAN FunASR the relay falls back to — the pool's second real member. */
const FUNASR_ENDPOINT = process.env.FLOWMIC_LIVE_FUNASR ?? 'ws://100.64.7.68:10095';

/**
 * 🔴 A KEY THAT IS SHAPED RIGHT AND IS NOT A KEY — the whole active-kill
 * mechanism (§③ below). 64 zeros: same length as a real Soniox key, so it gets
 * past nothing but our own eyes. Verified against the live service 2026-08-02:
 *   {"error_code":401,"error_type":"unauthenticated",
 *    "error_message":"Incorrect API key provided. …"}
 * which `classifySonioxError` maps to STT_ENGINE_AUTH_FAIL / retryable:false,
 * and which `ROUTE_FATAL_CODES` counts as route-fatal. That chain is exactly the
 * production failure mode「this route's credentials are dead」, so the drill kills a route the
 * way reality kills one.
 * ⚠️ NOT a bad ENDPOINT: a refused TCP connect classifies as STT_ENGINE_TIMEOUT,
 * which is deliberately NON-fatal (`pool-health.ts`: one 500 must not evict the
 * platform's primary), so it would not trigger failover at all. Measured that
 * distinction rather than assumed it.
 */
const DEAD_KEY = '0'.repeat(64);

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** WAV → raw PCM payload (all three fixtures are 16 kHz mono s16le). */
function pcmOf(path: string): Buffer {
  const b = readFileSync(path);
  let off = 12;
  while (off < b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') return b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

function settingsEmpty(): SettingsRepo {
  return {
    readAll: (): SettingRow[] => [],
    read: (): SettingRow | null => null,           // no user routings ⇒ managed path
    write: (): SettingRow => { throw new Error('unused'); },
    remove: (): boolean => false,
  };
}

interface RunResult {
  interims: string[];
  finals: { text: string; duration_ms: number }[];
  errors: { code: string; message: string; retryable: boolean }[];
  status: { provider: string; status: string }[];
  billedMs: number | null;
  isByok: boolean | null;
}

type Build = ReturnType<typeof makeSttOrchestratorFactory>;

/**
 * 🔴 BUILT ONCE, like production. `stt-factory.ts makeSttSessionFactory` calls
 * `makeSttOrchestratorFactory` exactly once per server boot, so the pool's
 * health registry is shared across every session. Building it per utterance —
 * as the first version of this drill did — gives each session a FRESH registry
 * and failover can never happen, which looked like a code bug for ten minutes
 * and was a harness bug. The harness must match the lifetime it is measuring.
 */
let sharedBuild: Build | null = null;
function build0(): Build {
  sharedBuild ??= makeSttOrchestratorFactory({
    settings: settingsEmpty(),
    mode: 'saas',
    // 🔴 L9: THIS LINE WAS MISSING and it made a whole class of measurement
    // impossible. Production is `stt-factory.ts:117 orchestratorOptions:
    // readOrchestratorTuningFromEnv()`; this drill constructed the orchestrator
    // with NO options, so `FLOWMIC_STT_FLUSH_TIMEOUT_MS` was silently ignored
    // and every attempt to test 「is the 3 s flush window too short?」 measured
    // 3000 ms no matter what the env said. The knob looked broken; the harness
    // was. Same shape as the shared-registry note above: 「the path the product actually walks」
    // includes the options production passes.
    orchestratorOptions: readOrchestratorTuningFromEnv(),
  });
  return sharedBuild;
}

/**
 * One utterance, through the production seam.
 *
 * 🔴 THE CHUNK SHAPE AND THE CLOCK ARE PART OF THE PATH (L9). This used to push
 * 1920-byte frames every 10 ms with `ts_ms = seq * 60`, and BOTH of those broke
 * the measurement:
 *
 *  · `ts_ms` is a WALL CLOCK on the wire. `audio_capture.dart:126 _wallClock()`
 *    = `DateTime.now().millisecondsSinceEpoch`, and `AudioSession.pushChunk`
 *    USED TO prune the replay ring with `RingBuffer.push(chunk, Date.now())` —
 *    i.e. the ring compared the client's `ts_ms` against the SERVER's clock.
 *    Feeding it audio-relative timestamps (0, 60, 120…) made every entry look
 *    ~55 years stale, so `prune()` emptied the ring on every push and
 *    `replayBufferTail()` — the thing that fills the cold-open gap while
 *    `engine.open()` is in flight (0.9–1.9 s against Soniox) — replayed NOTHING.
 *    Measured effect: the vendor never heard the first ~4 s of a 6 s utterance
 *    and the drill's first interim was already 「系统的」. That truncation was
 *    read as a Soniox quality problem for an hour. It was the harness.
 *    ✅ THE PRODUCTION HALF OF THAT IS NOW CLOSED (card M3-4b, 2026-08-02): the ring
 *    carries its own `recv_ms` and retention never looks at `ts_ms`, so a phone
 *    whose wall clock is off no longer empties (or unbounds) the replay buffer.
 *    Keep sending a real wall clock here anyway — `ts_ms` still rides through to
 *    the engine as CAPTURE ORDER, which is a different question and still real.
 *  · 6400 B / 200 ms is what the phone actually sends (mobile accumulates to a
 *    6400-byte boundary), and real-time pacing is what the flush window has to
 *    survive. Pushing 6 s of audio in 1 s left the vendor a backlog at flush
 *    that production never has.
 *
 * ✅ 2026-08-02 — the ring's cross-clock comparison was a REAL production
 * fragility (a phone merely 5 s off the relay emptied the same ring the same
 * way, silently). It was booked as card M3-4b and is now FIXED with the reverse
 * control this file's note asked for: `test/stt-replay-clock.test.ts` runs the
 * same reconnect at −10 s / 0 / +10 s skew and requires a byte-identical replay.
 * Deliberately NOT parameterised into THIS file: the skew knob belongs where it
 * can be run on every commit, and a drill that needs a vendor key and real money
 * to red is 「a screenshot」 by this file's own rule.
 */
async function speak(build: Build, lang: 'zh' | 'en'): Promise<RunResult> {
  const out: RunResult = { interims: [], finals: [], errors: [], status: [], billedMs: null, isByok: null };
  const bridge = new SttSessionBridge({
    build,
    emitter: {
      emit(ev, payload): void {
        const p = payload as Record<string, unknown>;
        if (ev === 'stt:interim') out.interims.push(String(p['text'] ?? ''));
        if (ev === 'stt:final') out.finals.push({ text: String(p['text'] ?? ''), duration_ms: Number(p['duration_ms'] ?? 0) });
        if (ev === 'stt:error') out.errors.push({ code: String(p['code']), message: String(p['message']), retryable: Boolean(p['retryable']) });
        if (ev === 'stt:engine-status') out.status.push({ provider: String(p['provider']), status: String(p['status']) });
      },
    },
    userId: 'live-drill',
    mode: 'realtime',
    sourceLang: lang,
    onComplete: (ms, byok) => { out.billedMs = ms; out.isByok = byok; },
  });

  const pcm = pcmOf(AUDIO[lang]);
  const FRAME = 6400;                       // 200 ms @ 16 kHz mono s16le — the phone's chunk
  for (let off = 0, seq = 0; off < pcm.length; off += FRAME, seq += 1) {
    bridge.pushChunk(seq, pcm.subarray(off, Math.min(off + FRAME, pcm.length)).toString('base64'), Date.now());
    await new Promise((r) => setTimeout(r, 200));   // real time, like a microphone
  }
  await bridge.finish();
  bridge.dispose();
  return out;
}

function report(title: string, r: RunResult): void {
  console.log(`\n──── ${title} ────`);
  console.log(`  engine-status : ${JSON.stringify(r.status)}`);
  console.log(`  interims(${r.interims.length}) first: ${JSON.stringify(r.interims[0] ?? '')}`);
  console.log(`  interims(${r.interims.length}) last : ${JSON.stringify(r.interims.at(-1) ?? '')}`);
  console.log(`  FINALS        : ${JSON.stringify(r.finals)}`);
  console.log(`  errors        : ${JSON.stringify(r.errors)}`);
  console.log(`  billed_ms=${r.billedMs} is_byok=${r.isByok}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE ASSERTIONS. Each one names the failure it would have caught.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 🔴 no silent failure — the money half. Applies to EVERY session in this file.
 *
 * Observed on 2026-08-02 before the fix: `FINALS: [{"text":""}]`, `errors: []`,
 * `billed_ms=5460, is_byok=false`. Not one character transcribed, not one error
 * raised, and the user's minute-quota debited anyway. Whether that SHOULD be
 * billed is a policy question and belongs to owner; whether it may be SILENT is
 * not a question at all.
 */
function assertNoSilentEmpty(r: RunResult): void {
  const text = r.finals.at(-1)?.text ?? '';
  const billed = r.billedMs ?? 0;
  if (text === '' && billed > 0) {
    expect(
      r.errors.map((e) => e.code),
      `billed ${billed} ms and transcribed 0 characters with NO error — that is a silent failure (red line), `
      + 'and it is also the exact shape a user pays for and cannot explain',
    ).not.toEqual([]);
  }
}

/**
 * 🔴 A TRANSCRIPT IS A CLAIM, SO ASSERT ITS CONTENT — not its existence.
 *
 * `expect(text).not.toBe('')` alone would have been GREEN for every broken run
 * this round produced: the tail-truncation bug still returned 8–11 characters.
 * So each fixture gets (a) a length floor set well above what the failure mode
 * could reach, and (b) substrings taken from the OPENING and the END of the
 * utterance — because the specific defect ate the head, and a floor alone cannot
 * see which half is missing.
 *
 * ⚠️ Deliberately NOT pinned to the vendor's exact string. Soniox renders the
 * brand as 「FlowMat 流脉」 and FunASR as 「fullmat流麦」; a proper-noun mishearing
 * is a quality observation, not a broken link, and a test that reds on it would
 * be retired within a week. The pinned substrings are ordinary words the model
 * has no reason to get wrong.
 */
interface Expectation { readonly minChars: number; readonly head: string; readonly tail: string }
const EXPECT: Record<'zh' | 'en', Expectation> = {
  // Spoken: 「大家好，欢迎使用 FlowMic 流麦语音输入系统的中文识别基线测试本。」 = 30 chars.
  // Live Soniox, whole utterance: 「大家好，欢迎使用 FlowMat 流脉语音输入系统的中文识别基线测试。本。」
  // The tail-truncation failure topped out at 11 chars (「系统的中文识别基线测试」),
  // so 20 is unreachable from it while leaving a third of the sentence as slack.
  zh: { minChars: 20, head: '大家好', tail: '中文识别基线测试' },
  // Spoken: 「…called for the boy and presented him with fifty pieces of gold」.
  // The truncated failure produced 「50 pieces of g」 (14 chars).
  en: { minChars: 40, head: 'boy', tail: 'pieces of' },
};

function assertTranscriptIsTrustworthy(r: RunResult, lang: 'zh' | 'en'): void {
  const e = EXPECT[lang];
  const text = r.finals.at(-1)?.text ?? '';
  expect(r.finals, 'no stt:final at all — the utterance never settled').not.toHaveLength(0);
  expect(text, 'the vendor returned NOTHING for six seconds of real speech').not.toBe('');
  expect(
    text.length,
    `transcript is ${text.length} chars: ${JSON.stringify(text)} — below the floor for this fixture, `
    + 'which is what a half-delivered utterance looks like',
  ).toBeGreaterThanOrEqual(e.minChars);
  // 🔴 The head assertion is the one that catches 「the engine only received the second half」. A length
  // floor cannot: 20 characters of the WRONG 20 would pass it.
  expect(text, `the OPENING of the utterance is missing — the engine was fed only the tail`).toContain(e.head);
  expect(text, 'the END of the utterance is missing — the flush closed early').toContain(e.tail);
}

/**
 * 🔴 THE LIVE PREVIEW IS OUTPUT TOO, AND THE FINAL CANNOT SPEAK FOR IT.
 *
 * Found by this drill on 2026-08-02 the first time it printed the English
 * interims: the last one was the sentence THREE TIMES over
 * (「…him withThe tribal…of goldThe tribal…of gold.」) while `stt:final` was
 * perfectly clean — because the final comes from the engine's own final event
 * and the preview comes from `mergeOnlineDraft`. Every assertion above was green
 * on that run. Two different producers, two different questions.
 *
 * ⚠️ Fixture-specific by construction: it asserts the opening phrase appears at
 * most ONCE per frame, which is only a defect signal because neither fixture
 * says it twice. A drill is allowed to know its own audio.
 */
function assertPreviewNeverDoubles(r: RunResult, lang: 'zh' | 'en'): void {
  const head = EXPECT[lang].head;
  for (const [i, frame] of r.interims.entries()) {
    const occurrences = frame.split(head).length - 1;
    expect(
      occurrences,
      `interim[${i}] repeats the opening ${occurrences}× — the live preview is piling the utterance onto itself: ${JSON.stringify(frame)}`,
    ).toBeLessThanOrEqual(1);
  }
}

describe.skipIf(!LIVE)('🔴 LIVE: Soniox real link + failover drill', () => {
  let key = '';
  let model = '';

  beforeAll(() => {
    const env = readEnvFile(SONIOX_ENV);
    key = env['FLOWMIC_MANAGED_STT_API_KEY'] ?? '';
    model = env['FLOWMIC_MANAGED_STT_MODEL'] ?? 'stt-rt-v5';
    expect(key.length, 'no key in .local/soniox.env').toBeGreaterThan(10);
    // The private package is not a dependency of server-core (that is what keeps
    // it out of the desktop sidecar), so point the loader at the built artefact —
    // the same override a real deployment uses.
    process.env.FLOWMIC_STT_CLOUD_MODULE = CLOUD_PKG;
    process.env.FLOWMIC_STT_POOL = JSON.stringify([
      {
        id: 'soniox-prod', provider: 'soniox', model,
        api: '', region: '*', languages: ['zh', 'en'], role: 'primary',
        enabled: true, priority: 0, api_key: key,
      },
      {
        id: 'funasr-lan', provider: 'funasr', model: '', api: FUNASR_ENDPOINT,
        region: '*', languages: ['zh', 'en'], role: 'backup', enabled: true, priority: 10,
      },
    ]);
    console.log(`\n[drill] pool = soniox-prod(primary) + funasr-lan(backup @ ${FUNASR_ENDPOINT})`);
    console.log(`[drill] soniox key length = ${key.length} (never printed)`);
    console.log(`[drill] cloud package     = ${CLOUD_PKG}`);
    console.log(`[drill] orchestrator tuning from env = ${JSON.stringify(readOrchestratorTuningFromEnv())} (empty = defaults; set FLOWMIC_STT_FLUSH_TIMEOUT_MS to move the cap)`);
  });

  it('🔴 PRECONDITION: the built cloud package is not STALE', () => {
    // Cost me a wrong conclusion once, 2026-08-02: the classifier fix was in
    // `src` while `requireCloudEngine` loaded a dist built minutes earlier, so
    // the live probe reported the OLD verdict and it looked like a code bug.
    // Same shape CLAUDE.md already documents for @flowmic/protocol
    // (「server-core consumes dist, not src」) — nothing rebuilds this package
    // automatically, and neither verify:types nor verify:lint can see it.
    // 「a discipline that has to be remembered has already been missed twice, so automate it」— so it is checked here,
    // where being wrong costs a false network verdict.
    const distMs = statSync(CLOUD_PKG).mtimeMs;
    const srcDir = resolve(REPO, 'packages/stt-cloud/src');
    const newest = ['index.ts', 'host.ts', 'engines/soniox.ts']
      .map((f) => statSync(resolve(srcDir, f)).mtimeMs)
      .reduce((a, b) => Math.max(a, b));
    expect(
      distMs,
      `packages/stt-cloud/dist is OLDER than its src — run \`pnpm --filter @flowmic/stt-cloud build\` first, or this drill measures the previous build`,
    ).toBeGreaterThanOrEqual(newest);
  });

  it('the pool really ranks Soniox first before anything is killed', () => {
    const pool = loadPool(process.env);
    const { selection } = resolvePoolRouting(pool, 'zh');
    if (selection.outcome !== 'selected') throw new Error(`unexpected: ${JSON.stringify(selection)}`);
    console.log(`[drill] intended route = ${selection.route.id} (${selection.route.provider}), candidates=${selection.ranked_route_ids.length}, ranked=${selection.ranked_route_ids.join(' > ')}`);
    expect(selection.route.id).toBe('soniox-prod');
    // 🔴 card §-0b: more than one candidate ⇒ the pool is genuinely choosing.
    expect(selection.ranked_route_ids.length).toBeGreaterThan(1);
  });

  it('SESSION 1 (zh) — REAL Soniox, through the production seam, and the text is CHECKED', async () => {
    const r = await speak(build0(), 'zh');
    report('SESSION 1 · zh · primary = soniox-prod (REAL NETWORK)', r);

    // WHICH ROUTE SERVED IT — asserted from the selection algorithm, not read off
    // a log line. `engine-status.provider` answers a DIFFERENT question (which
    // ENGINE was built), and with two soniox routes in a pool it cannot tell them
    // apart at all; the route id is the only value that names the route.
    const { selection } = resolvePoolRouting(loadPool(process.env), 'zh');
    expect(selection.outcome).toBe('selected');
    if (selection.outcome === 'selected') expect(selection.route.id).toBe('soniox-prod');
    expect(r.status.map((s) => s.provider)).toContain('soniox');

    assertTranscriptIsTrustworthy(r, 'zh');
    assertPreviewNeverDoubles(r, 'zh');
    assertNoSilentEmpty(r);
    expect(r.errors, 'a clean run must raise no errors').toEqual([]);
    // Whatever else is true, this session must NOT be BYOK: the key is ours.
    expect(r.isByok).toBe(false);
    // Managed streaming ⇒ VAD-gated billing: the meter must move, and it must not
    // exceed the audio we actually sent (5.46 s voiced of a 6.0 s fixture).
    expect(r.billedMs).toBeGreaterThan(0);
    expect(r.billedMs!).toBeLessThanOrEqual(6_000);
  }, 120_000);

  it('SESSION 2 (en) — English, the reason Soniox was bought at all', async () => {
    const r = await speak(build0(), 'en');
    report('SESSION 2 · en · soniox-prod', r);
    assertTranscriptIsTrustworthy(r, 'en');
    assertPreviewNeverDoubles(r, 'en');
    assertNoSilentEmpty(r);
    expect(r.errors).toEqual([]);
    expect(r.isByok).toBe(false);
  }, 120_000);

  /* ──────────────────────────────────────────────────────────────────────────
   * ③ THE FAILOVER DRILL — with an ACTIVE kill.
   *
   * 🔴 What was here before was not a drill. The primary was dead because the
   * OWNER'S ACCOUNT HAD NO FUNDS — an outage we were living through, not a
   * mechanism we could operate. The moment the account was topped up, the same
   * test kept passing while exercising nothing at all (it had no assertions, so
   * it could not notice). 「failover counts as delivered only after an [active drill]」 means the drill has
   * to be able to KILL something on demand.
   *
   * What is production code here: the pool loader, `selectRoute`, the health
   * registry, `probeRouteLiveness`, `defaultEngineFactory`, `requireCloudEngine`,
   * the real `ws`, and the vendor. What is a fixture: the two rows of the pool
   * (that is the operator's job) and the fact that the drill keeps a reference to
   * the health registry so it can WAIT for the verdict instead of hoping — in
   * production that gap is filled by the next user.
   * ────────────────────────────────────────────────────────────────────────── */
  it('🔴 FAILOVER DRILL — a route is actively killed, and the pool moves off it', async () => {
    const failoverEnv: NodeJS.ProcessEnv = {
      ...process.env,
      FLOWMIC_STT_POOL: JSON.stringify([
        {
          id: 'soniox-dead', provider: 'soniox', model, api: '', region: '*',
          languages: ['zh'], role: 'primary', enabled: true, priority: 0, api_key: DEAD_KEY,
        },
        {
          id: 'soniox-live', provider: 'soniox', model, api: '', region: '*',
          languages: ['zh'], role: 'backup', enabled: true, priority: 10, api_key: key,
        },
      ]),
    };
    const pmd = makePoolManagedDefault({ env: failoverEnv, factory: defaultEngineFactory });
    expect(pmd.health, 'a configured pool with no health registry can never fail over').not.toBeNull();

    // ── 1. INTENT: with nothing measured, the pool sends traffic to the primary.
    const intent = resolvePoolRouting(pmd.pool, 'zh');
    expect(intent.selection.outcome).toBe('selected');
    if (intent.selection.outcome !== 'selected') return;
    expect(intent.selection.route.id).toBe('soniox-dead');
    expect(intent.selection.failover, 'nothing has failed yet').toBeNull();

    // ── 2. THE KILL, measured — the real probe, the real vendor, the real refusal.
    const deadRouting = pmd.pool.routingOf('soniox-dead');
    expect(deadRouting).not.toBeNull();
    const verdict = await probeRouteLiveness(defaultEngineFactory, deadRouting!, 'zh');
    console.log(`[drill] KILL verdict for soniox-dead = ${JSON.stringify(verdict)}`);
    expect(verdict.ok).toBe(false);
    // Three separate assertions on purpose (D1 rule): 「it failed」, 「it failed THIS
    // way」 and 「that verdict is route-fatal」 are three questions, and only the
    // third one actually moves traffic.
    expect(verdict.code).toBe('STT_ENGINE_AUTH_FAIL');
    expect(verdict.fatal).toBe(true);
    expect(verdict.message).toContain('unauthenticated');

    // ── 3. Let the PRODUCTION registry learn it. `resolve()` kicks the background
    // refresh exactly as an audio:start would; we only wait for what the next
    // user would have waited through.
    const failoverLines: unknown[][] = [];
    const spy = vi.spyOn(log, 'error').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('FAILED OVER')) failoverLines.push(args);
    });
    try {
      pmd.resolve('zh');
      const deadline = Date.now() + 20_000;
      for (;;) {
        const snap = pmd.health!.snapshot()['soniox-dead'];
        if (snap !== undefined && !snap.available) break;
        if (Date.now() > deadline) throw new Error(`the health registry never marked soniox-dead unavailable: ${JSON.stringify(pmd.health!.snapshot())}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      // The route is out. Now the SAME resolver must move.
      const routing = pmd.resolve('zh');
      expect(routing, 'the pool returned nothing after failover — that would surface as「该语言尚未配置识别引擎」, which is false').not.toBeNull();
      expect(routing!.api_key, 'the surviving route must carry the LIVE key, not the dead one').toBe(key);
      expect(routing!.api_key).not.toBe(DEAD_KEY);
    } finally {
      spy.mockRestore();
    }

    // ── 4. ROUTE_ID CHANGED — asserted on the value, not inferred from the log.
    const after = resolvePoolRouting(pmd.pool, 'zh', (route) => pmd.health!.isAvailable(route));
    expect(after.selection.outcome).toBe('selected');
    if (after.selection.outcome !== 'selected') return;
    expect(after.selection.route.id).toBe('soniox-live');
    expect(after.selection.route.id).not.toBe(intent.selection.route.id);

    // ── 5. leave a trace (A6 §3-3: a failover is never silent). Both the structured value
    // the log line is built from, AND the line itself.
    expect(after.selection.failover).not.toBeNull();
    expect(after.selection.failover!.intended_route_id).toBe('soniox-dead');
    expect(after.selection.failover!.skipped_route_ids).toContain('soniox-dead');
    expect(failoverLines.length, 'the failover produced no ERROR-level trace — an operator would never learn it happened').toBeGreaterThan(0);
    console.log(`[drill] failover trace = ${JSON.stringify(failoverLines[0])}`);

    // ── 6. AND IT STILL TRANSCRIBES. The dead route physically cannot produce a
    // character (its key is refused before any audio is accepted), so a real
    // transcript here is end-to-end proof that the session ran on the survivor —
    // which is a stronger statement than any id comparison.
    const failoverBuild = makeSttOrchestratorFactory({
      settings: settingsEmpty(),
      mode: 'saas',
      managedDefault: pmd.resolve,
      orchestratorOptions: readOrchestratorTuningFromEnv(),
    });
    const r = await speak(failoverBuild, 'zh');
    report('FAILOVER · zh · served by soniox-live after soniox-dead was killed', r);
    assertTranscriptIsTrustworthy(r, 'zh');
    assertPreviewNeverDoubles(r, 'zh');
    assertNoSilentEmpty(r);
    expect(r.errors, 'the surviving route must serve a CLEAN session — the dead one is out of the way').toEqual([]);
  }, 180_000);
});
