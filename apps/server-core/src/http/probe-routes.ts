// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §6 (the four-dimensional probe {ok,
//     latency_ms, sample_output≤80, model_echoed}), §3 (per-engine transport),
//     §4 (BYOK judgement: user-supplied non-empty key, 'EMPTY' = platform endpoint)
//   docs/strategy/2026-07-25-full-gap-audit/02-DESKTOP.md GA-12
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D1/D3 (no silent failure; a probe
//     result is a ONE-SHOT reading, never a resident status light)
//   CLAUDE.md red line: no silent failures; anti-façade
//
// The "test connection" (测试连接) probe REST surface: POST /api/probe/llm +
// POST /api/probe/stt.
//
// Three invariants this module is built around, each mechanically checkable:
//
//  1. NOTHING IS PERSISTED. The config under test arrives IN THE REQUEST BODY
//     (the same `llm.config` / `stt.routings` shapes the settings store holds),
//     so this module imports NO settings repo, NO db module and NO billing
//     module — a probe cannot write a setting or move a counter because it has
//     no reference to anything that could. probe-routes.test.ts pins that
//     structurally (import scan) and behaviourally (spy BillingService).
//
//  2. NOTHING IS BILLED. ensureQuota / recordSttUsage / recordLlmUsage keep
//     their "exactly 1 production call site each" (各恰 1 生产调用点) discipline
//     (mock-billing §5) — a probe adds no
//     call site. BYOK/managed is still JUDGED here, with the engine layer's own
//     resolvers (resolveByok / isByokLlm), so the reading the owner sees matches
//     what a real session would be billed as.
//
//  3. NOTHING IS FAKED. A ws engine's probe is a handshake and says so
//     (`probe_kind: 'handshake'`, empty `sample_output`); it never invents a
//     transcript. `model_echoed` is what the PROVIDER echoed back, `null` when it
//     said nothing (the desktop renders "not provided" (未提供)).
//
// A dead endpoint answers HTTP 200 with `{ok:false, code, message}` — a named,
// protocol-whitelisted code, never a 500: an unreachable LAN box is a NORMAL
// probe outcome, not a server fault.
//
// FOURTH INVARIANT (RV-32, 2026-07-30): ONLY THIS MACHINE MAY ASK.
// The header below used to argue that standalone-only mounting was enough,
// because 「the desktop settings page is the only place this runs」. That was
// wrong in the one way that mattered: standalone is precisely the mode that binds
// every interface (a phone with no token must be able to pair), so 「not mounted
// in saas」 never meant 「not reachable from the LAN」. Any machine on the owner's
// network could POST a body naming an arbitrary host:port and read back reachable
// / refused / timed-out plus a latency — a port scanner running on someone else's
// PC. The desktop dials 127.0.0.1:41879 (desktop/src/lib/probe-client.ts baseUrl),
// so a loopback-only gate costs the real caller nothing. The CORS allow-list below
// stays: it is a BROWSER defence and curl has never cared about it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorCode, LlmProtocol, SttEngineId } from '@flowmic/protocol';
import { findLlmPreset } from '@flowmic/protocol';
import { isErrorCode } from '../errors';
import { streamerFor as defaultStreamerFor, type LlmConfig, type LlmStreamer } from '../compose/llm';
import { isByokLlm } from '../compose/llm-config';
import { defaultEngineFactory, isStreamingEngine, resolveByok } from '../stt/engine-factory';
import { configFromRouting, selectRouting, type EngineFactory, type Routing } from '../stt/engine-router';
import { SttEngineError, type FinalResult } from '../stt/engines/base';
import type { EngineSubscriber } from '../stt/orchestrator-types';
import { isModelComplete } from '../stt/sherpa/model-downloader';
import { resolveSherpaModelDir, SHERPA_REPO } from '../stt/sherpa/model-manifest';
import { isLocalRequest, refuseNonLocal } from './local-only';

/** What the probe was actually able to do — the desktop turns this into the
 *  honest caption under an empty `sample_output` (D3: never pretend a handshake
 *  was a transcription). */
export type ProbeKind = 'completion' | 'handshake' | 'transcribe' | 'local-model';

export interface ProbeOk {
  ok: true;
  /** Wall-clock ms for the whole probe (dial → first usable answer → teardown). */
  latency_ms: number;
  /** ≤ 80 chars. EMPTY for a handshake/local-model probe — see `probe_kind`. */
  sample_output: string;
  /** The model the service echoed back. `null` = the service did not say. */
  model_echoed: string | null;
  probe_kind: ProbeKind;
  /** Engine-layer BYOK judgement (06 §4) — informational only, nothing metered. */
  byok: boolean;
}

export interface ProbeFail {
  ok: false;
  code: ErrorCode;
  /** Raw technical detail (the collapsible "raw error" (原始错误) in the UI). The headline copy
   *  is rendered client-side from the protocol ERROR_CODES table. */
  message: string;
  latency_ms: number;
  /** Omitted when the failure happened before an engine could be resolved. */
  probe_kind?: ProbeKind;
}

export type ProbeResult = ProbeOk | ProbeFail;

/** 06 §6 — the sample is a TASTE of the output, not the output. */
export const SAMPLE_OUTPUT_MAX = 80;
export const DEFAULT_PROBE_TIMEOUT_MS = 12_000;
/** The probe turn: deliberately trivial so a probe costs ~nothing at a metered
 *  provider and cannot be mistaken for a real compose turn. */
export const PROBE_SYSTEM = 'Connectivity probe. Answer with the single word OK.';
export const PROBE_USER = 'ping';
/** 200 ms of 16 kHz mono s16le SILENCE — the smallest well-formed WAV body the
 *  batch engines will accept. Silence is the honest payload: we have no speech
 *  to send, so an empty transcript back is a correct answer, not a failure. */
export const PROBE_PCM_MS = 200;

function probePcm(): Buffer {
  return Buffer.alloc(Math.round((16_000 * 2 * PROBE_PCM_MS) / 1000));
}

/** Collapse whitespace and hard-cap at 80 chars (06 §6). */
export function clampSample(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= SAMPLE_OUTPUT_MAX ? flat : flat.slice(0, SAMPLE_OUTPUT_MAX);
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** A code from a lower layer is kept ONLY when it is a real protocol code and
 *  says something the generic *_PROBE_FAIL does not (auth, rate limit, …). */
function narrow(code: string, fallback: ErrorCode): ErrorCode {
  return isErrorCode(code) ? code : fallback;
}

class ProbeTimeout extends Error {
  constructor(ms: number) {
    super(`probe timed out after ${ms}ms`);
    this.name = 'ProbeTimeout';
  }
}

/** Race a promise against a deadline. The loser is NOT cancelled here — every
 *  caller tears its engine down in a `finally`, so no socket is left dangling. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeout(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── LLM probe ────────────────────────────────────────────────────────────────

export interface LlmProbeDeps {
  /** Test seam: the protocol → streamer dispatcher. Production passes nothing. */
  streamerFor?: (protocol: LlmProtocol) => LlmStreamer;
  /** Injectable fetch handed to the streamer (tests / no LAN dependency). */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

const PROTOCOLS: readonly LlmProtocol[] = ['openai-compatible', 'anthropic'];

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Parse the request body as an `llm.config`-shaped payload. Accepts BOTH shapes
 * the settings store accepts — a full inline config, or `preset_id` + overrides —
 * so the desktop can send exactly what it would save (llm-config.ts does the same
 * merge for the persisted value; here nothing is persisted).
 */
export function parseLlmProbeBody(body: unknown): LlmConfig {
  const raw = (body ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  const presetId = str(raw['preset_id']);
  if (presetId !== undefined) {
    const preset = findLlmPreset(presetId);
    if (!preset) throw new ProbeBadConfig('LLM_INVALID_MODEL', `unknown llm preset '${presetId}'`);
    merged['protocol'] = preset.protocol;
    merged['endpoint'] = preset.endpoint;
    merged['api_key'] = preset.api_key;
    merged['model'] = preset.model;
  }
  for (const k of ['protocol', 'endpoint', 'api_key', 'model'] as const) {
    if (raw[k] !== undefined) merged[k] = raw[k];
  }
  const protocol = str(merged['protocol']);
  const endpoint = str(merged['endpoint']);
  const model = str(merged['model']);
  if (protocol === undefined || !(PROTOCOLS as readonly string[]).includes(protocol)) {
    throw new ProbeBadConfig('LLM_INVALID_MODEL', `protocol must be one of ${PROTOCOLS.join('|')}`);
  }
  if (endpoint === undefined || endpoint.length === 0) {
    throw new ProbeBadConfig('LLM_INVALID_MODEL', 'endpoint is required');
  }
  if (model === undefined || model.length === 0) {
    throw new ProbeBadConfig('LLM_INVALID_MODEL', 'model is required');
  }
  return { protocol: protocol as LlmProtocol, endpoint, api_key: str(merged['api_key']) ?? '', model };
}

/** A body the probe refuses before it dials anything (fail loud, named code). */
class ProbeBadConfig extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'ProbeBadConfig';
  }
}

export async function probeLlm(body: unknown, deps: LlmProbeDeps = {}): Promise<ProbeResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const elapsed = (): number => Math.max(0, now() - startedAt);
  const fail = (code: ErrorCode, message: string): ProbeFail =>
    ({ ok: false, code, message, latency_ms: elapsed(), probe_kind: 'completion' });

  let cfg: LlmConfig;
  try {
    cfg = parseLlmProbeBody(body);
  } catch (err) {
    if (err instanceof ProbeBadConfig) return fail(err.code, err.message);
    return fail('LLM_PROBE_FAIL', messageOf(err));
  }

  const streamer = (deps.streamerFor ?? defaultStreamerFor)(cfg.protocol);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let text = '';
  let modelEchoed: string | null = null;
  let error: { code: string; message: string } | null = null;
  try {
    const iter = streamer({
      cfg,
      system: PROBE_SYSTEM,
      user: PROBE_USER,
      signal: controller.signal,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    for await (const ev of iter) {
      if (ev.kind === 'delta') {
        // Cap the accumulation too — a runaway model must not grow the buffer
        // just to be sliced to 80 chars at the end.
        if (text.length < SAMPLE_OUTPUT_MAX * 2) text += ev.text;
      } else if (ev.kind === 'done') {
        if (ev.full.length > 0) text = ev.full;
        modelEchoed = ev.model ?? null;
      } else {
        error = { code: ev.code, message: ev.message };
      }
    }
  } catch (err) {
    // A streamer must never throw (see compose/llm/types.ts) — if one ever does,
    // it is still a probe failure, never an HTTP 500.
    error = { code: 'LLM_PROBE_FAIL', message: messageOf(err) };
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) return fail('LLM_TIMEOUT', `no answer within ${timeoutMs}ms`);
  if (error) {
    // Keep the codes that DIAGNOSE (a wrong key / a throttle); everything else —
    // connection refused, HTTP 5xx, malformed stream — is what LLM_PROBE_FAIL
    // "LLM connection test failed" (大模型连接测试失败) exists to say. The raw text
    // still travels in `message`.
    const specific = error.code === 'LLM_AUTH_FAIL' || error.code === 'LLM_RATE_LIMITED' || error.code === 'LLM_INVALID_MODEL';
    return fail(specific ? narrow(error.code, 'LLM_PROBE_FAIL') : 'LLM_PROBE_FAIL', error.message);
  }
  return {
    ok: true,
    latency_ms: elapsed(),
    sample_output: clampSample(text),
    model_echoed: modelEchoed,
    probe_kind: 'completion',
    byok: isByokLlm(cfg),
  };
}

// ── STT probe ────────────────────────────────────────────────────────────────

export interface SttProbeDeps {
  /** Test seam: the engine-id → ctor switch. Production passes nothing. */
  engineFactory?: EngineFactory;
  /**
   * Is the built-in sherpa model already on disk? Deliberately a PRESENCE check
   * and not `SherpaLocalEngine.open()`. Historically open() would auto-DOWNLOAD
   * ~228 MB and a "test connection" (测试连接) button must never start a download
   * behind the
   * owner's back; since 2026-08-09 download is opt-in (DISC-2 ruling), but the
   * presence check stays the right probe — it answers "whether the model is
   * there" (模型在不在) without
   * loading a recognizer, and it cannot depend on what env the operator set.
   */
  sherpaModelReady?: () => Promise<boolean>;
  now?: () => number;
  timeoutMs?: number;
}

/** Which probe an engine id is CAPABLE of (the card's "graded by engine
 *  capability" — 按引擎能力分级). */
export function probeKindFor(engine: SttEngineId): ProbeKind {
  if (engine === 'sherpa-local') return 'local-model';
  // The persistent-session engines (funasr / deepgram / openai-realtime) open a
  // ws and then stream: a successful handshake is the whole reachable truth
  // without sending audio we do not have.
  return isStreamingEngine(engine) ? 'handshake' : 'transcribe';
}

interface SttProbeRequest {
  routings: Routing[];
  routing: Routing | null;
  language: string;
}

/** Parse the `stt.routings`-shaped body. Either a whole routings array (+ the
 *  language to resolve, run through the PRODUCTION §4 selection algorithm so the
 *  probe also tests the routing resolution) or one explicit routing row. */
export function parseSttProbeBody(body: unknown): SttProbeRequest {
  const raw = (body ?? {}) as Record<string, unknown>;
  const routings = Array.isArray(raw['routings']) ? (raw['routings'] as Routing[]) : [];
  const explicit = raw['routing'];
  const one = explicit !== null && typeof explicit === 'object' && !Array.isArray(explicit)
    ? (explicit as Routing)
    : null;
  const language = str(raw['language']) ?? one?.language ?? routings[0]?.language ?? '*';
  // NO managed-default fallback here: a probe must test what the OWNER
  // configured, not a platform default they never see (06 §4 "no implicit
  // fallback" — 无隐式回退).
  const routing = one ?? selectRouting(language, routings);
  return { routings, routing, language };
}

export async function probeStt(body: unknown, deps: SttProbeDeps = {}): Promise<ProbeResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const elapsed = (): number => Math.max(0, now() - startedAt);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const { routing, language } = parseSttProbeBody(body);
  if (!routing) {
    return { ok: false, code: 'STT_CONFIG_MISSING', message: `no routing matches language ${language}`, latency_ms: elapsed() };
  }
  const kind = probeKindFor(routing.engine_id);
  // T7: `source: 'user'` is true BY CONSTRUCTION here, not by assumption —
  // parseSttProbeBody above deliberately passes NO managedDefault to
  // selectRouting, so every routing reaching this line came from the owner's own
  // request body. If that ever changes, this literal has to change with it.
  // 🔴 RoutingSource gained a third value, `'seed'`, on 2026-08-06 (0.3.0 W1), and
  // it deliberately does NOT apply here: a probe body is an ad-hoc payload the
  // console posted, so it has no provenance to read — the owner typed these fields
  // to ask "can this config connect" (这个配置连得上吗). `'user'` keeps the BYOK
  // reading key-shape-based for
  // this diagnostic, which is the only honest answer available. A probe never
  // meters anything, so nothing bills off this line.
  const byok = resolveByok({ routing, source: 'user' });
  const fail = (code: ErrorCode, message: string): ProbeFail =>
    ({ ok: false, code, message, latency_ms: elapsed(), probe_kind: kind });

  if (kind === 'local-model') {
    const ready = deps.sherpaModelReady ?? ((): Promise<boolean> => isModelComplete(resolveSherpaModelDir()));
    let ok: boolean;
    try {
      ok = await withTimeout(ready(), timeoutMs);
    } catch (err) {
      return fail('STT_PROBE_FAIL', messageOf(err));
    }
    if (!ok) return fail('STT_CONFIG_MISSING', 'built-in sherpa model files are missing or incomplete');
    return { ok: true, latency_ms: elapsed(), sample_output: '', model_echoed: SHERPA_REPO, probe_kind: kind, byok };
  }

  const factory = deps.engineFactory ?? defaultEngineFactory;
  const attempt = await runEngineProbe(factory, routing, language, kind, timeoutMs);
  if (attempt.ok) {
    return {
      ok: true,
      latency_ms: elapsed(),
      sample_output: clampSample(attempt.text),
      // No bundled STT transport echoes a model id back (whisper returns
      // {text}, funspeech {status,result}, the ws engines nothing at all) — so
      // this is honestly null and the desktop shows "not provided" (未提供)
      // rather than
      // parroting the configured value back as if the service had confirmed it.
      model_echoed: null,
      probe_kind: kind,
      byok,
    };
  }

  // WSS → WS scheme mismatch (STT_PROBE_SCHEME_MISMATCH): the single most common
  // LAN misconfiguration — a plain FunASR box has no TLS, so `wss://` fails while
  // `ws://` works. Re-dial once over ws:// and, if THAT connects, say exactly
  // which knob to turn instead of a generic "connection failed" (连接失败).
  const endpoint = routing.endpoint ?? '';
  if (kind === 'handshake' && endpoint.startsWith('wss://')) {
    const downgraded: Routing = { ...routing, endpoint: `ws://${endpoint.slice('wss://'.length)}` };
    const retry = await runEngineProbe(factory, downgraded, language, kind, timeoutMs);
    if (retry.ok) return fail('STT_PROBE_SCHEME_MISMATCH', `wss:// handshake failed (${attempt.message}); ws:// connected`);
  }
  return fail(attempt.code, attempt.message);
}

type EngineAttempt = { ok: true; text: string } | { ok: false; code: ErrorCode; message: string };

/**
 * Drive one engine through the real production adapter. `open()` is the whole
 * probe for a ws engine (that IS the handshake); for a batch/http engine `open()`
 * is a local no-op, so the reachability test is the actual POST that `flush()`
 * performs — a genuine (silent-audio) transcription request, not a pretend one.
 */
async function runEngineProbe(
  factory: EngineFactory,
  routing: Routing,
  language: string,
  kind: ProbeKind,
  timeoutMs: number,
): Promise<EngineAttempt> {
  let engine: EngineSubscriber;
  try {
    engine = factory(routing.engine_id, configFromRouting(routing, language)) as EngineSubscriber;
  } catch (err) {
    return { ok: false, code: 'STT_CONFIG_MISSING', message: messageOf(err) };
  }
  // Attach BEFORE open(): an EventEmitter 'error' with no listener THROWS, and a
  // ws engine reports a mid-handshake failure on that channel (06 §3 / F-2044).
  const seen: { error: SttEngineError | null; final: FinalResult | null } = { error: null, final: null };
  engine.on('error', (e: SttEngineError) => { seen.error ??= e; });
  engine.on('final', (e: FinalResult) => { seen.final ??= e; });

  try {
    if (engine.open) await withTimeout(engine.open(), timeoutMs);
    if (kind === 'transcribe') {
      engine.push(probePcm(), 0);
      await withTimeout(engine.flush(), timeoutMs);
    }
  } catch (err) {
    return { ok: false, ...classify(err) };
  } finally {
    try {
      await engine.close();
    } catch {
      // A teardown failure never changes the probe's verdict.
    }
  }

  if (seen.error) return { ok: false, ...classify(seen.error) };
  return { ok: true, text: seen.final?.text ?? '' };
}

function classify(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof SttEngineError) return { code: narrow(err.code, 'STT_PROBE_FAIL'), message: err.message };
  if (err instanceof ProbeTimeout) return { code: 'STT_ENGINE_TIMEOUT', message: err.message };
  return { code: 'STT_PROBE_FAIL', message: messageOf(err) };
}

// ── REST plumbing ────────────────────────────────────────────────────────────

export interface ProbeRoutesDeps {
  llm?: LlmProbeDeps;
  stt?: SttProbeDeps;
}

export const PROBE_LLM_PATH = '/api/probe/llm';
export const PROBE_STT_PATH = '/api/probe/stt';

/**
 * The desktop WebView origins. A tight allow-list rather than `*`: the probe
 * makes the server dial an ARBITRARY url from the request body, so letting any
 * web page the owner happens to visit reach it would hand every site a LAN
 * port-scanner on localhost. (The routes themselves are mounted standalone-only —
 * see router.ts.)
 */
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
  'http://localhost:1420',
  'http://127.0.0.1:1420',
]);

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers['origin'];
  if (typeof origin !== 'string' || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'origin',
  };
}

const BODY_CAP = 64_000;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > BODY_CAP) raw = raw.slice(0, BODY_CAP);
    });
    req.on('end', () => {
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** Mounted from http/router.ts. Returns true iff it owned the request. */
export function tryHandleProbeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProbeRoutesDeps = {},
): boolean {
  const url = (req.url ?? '/').split('?')[0] ?? '/';
  if (url !== PROBE_LLM_PATH && url !== PROBE_STT_PATH) return false;
  const method = req.method ?? 'GET';

  // RV-32: refused before the method switch, so an off-box caller cannot even get
  // a successful CORS preflight — a 204 that promises a POST which will be
  // refused would be a lie told one round-trip early. Nothing is dialed, nothing
  // is parsed: the refusal happens before the body is read.
  if (!isLocalRequest(req)) {
    refuseNonLocal(req, res, url);
    return true;
  }

  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return true;
  }
  if (method !== 'POST') return false; // → the router's 404 (unknown route)

  void (async (): Promise<void> => {
    const body = await readJsonBody(req);
    let result: ProbeResult;
    try {
      result = url === PROBE_LLM_PATH
        ? await probeLlm(body, deps.llm ?? {})
        : await probeStt(body, deps.stt ?? {});
    } catch (err) {
      // Last-resort net. A probe NEVER answers 500: an unreachable box is a
      // normal reading, and the desktop has exactly one parse path.
      result = {
        ok: false,
        code: url === PROBE_LLM_PATH ? 'LLM_PROBE_FAIL' : 'STT_PROBE_FAIL',
        message: messageOf(err),
        latency_ms: 0,
      };
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(req) });
    res.end(JSON.stringify(result));
  })();
  return true;
}
