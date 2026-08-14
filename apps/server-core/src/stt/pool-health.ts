// SPEC-REF:
//   docs/strategy/2026-07-30-platform-ops-console-and-engine-pool.md A6 §3-3
//     (🔴 a degrade must be [SPOKEN ALOUD], never a silent switch to a weaker engine)
//   docs/strategy/2026-08-02-h6-soniox-streaming-adapter-card.md §-0f tail
//     (production strategy = priority + health-based failover; health is the one value the runtime actually reads at run time),
//     §-0b (🔴 failover only counts as delivered once it has been [ACTIVELY DRILLED] — "not drilled = not done")
//
// LIVENESS — the runtime half of "is this route usable right now".
//
// 🔴 WHY THIS IS NOT `http/probe-routes.ts`'s `probeStt`, and this is a finding
// rather than a preference:
//
//   `probeKindFor(streaming) === 'handshake'`, and `runEngineProbe` for a
//   handshake does `await engine.open()` and then closes immediately. That is a
//   correct test for FunASR/Deepgram/OpenAI-Realtime, which refuse DURING the
//   handshake. **Soniox does not.** It accepts the ws upgrade unconditionally and
//   validates the first JSON config frame IN BAND, answering afterwards.
//   Measured against the live service 2026-08-02, three consecutive runs:
//       open() resolved after 1944 / 953 / 891 ms
//       the refusal frame arrived  291 / 290 / 280 ms AFTER that
//   ⇒ a handshake probe that closes on open() reports **OK for an account that
//   cannot transcribe a single word** (the observed refusal was
//   `402 organization_balance_exhausted`). It is the classic shape: one value
//   ("the socket opened") being used to answer a different question ("will this
//   engine produce text").
//
//   So this probe keeps the socket open for a SETTLE WINDOW after `open()` and
//   lets the engine's own error channel speak. `http/probe-routes.ts` has the
//   same gap and is another lane's file — REPORTED, not edited here.
//
// ⚠️ Cost: the probe sends NO audio, and Soniox bills by audio duration, so an
// open-and-close costs no transcription minutes. Do not "improve" this by
// pushing sample audio — that would make health checks a billed activity.

import type { SttEngine, SttEngineConfig } from './engines/base';
import { SttEngineError } from './engines/base';
import type { EngineFactory, Routing } from './engine-router';
import { configFromRouting } from './engine-router';
import { isStreamingEngine } from './streaming-engines';
import type { PoolRoute } from '../pool/select-route';
import { log } from '../log';

/**
 * 🔴 The ONE definition of "this route is broken beyond saving".
 *
 * Derived from the engine-layer code, not from `retryable`: `retryable` answers
 * "would re-dialing this connection help" and these two answer "this route is broken for everyone". A 429
 * (`STT_ENGINE_RATE_LIMITED`) is non-fatal on purpose — waiting helps and the
 * route is fine; declaring it dead would evict the platform's primary over a
 * momentary throttle.
 *
 * The producer side of this contract is
 * `packages/stt-cloud/src/engines/soniox.ts classifySonioxError`, which
 * deliberately carries NO `routeFatal` field so that this stays the single
 * answer. Both files name each other; keep it that way.
 */
export const ROUTE_FATAL_CODES: ReadonlySet<string> = new Set([
  'STT_ENGINE_AUTH_FAIL',
  'STT_CONFIG_MISSING',
]);

export interface LivenessVerdict {
  readonly ok: boolean;
  /** Engine-layer code when it failed, else null. */
  readonly code: string | null;
  /** The provider's own words. For Soniox this carries the raw `error_type`,
   *  which is the only place the precise fact survives (no new ERROR_CODES). */
  readonly message: string;
  /** true ⇒ do not send traffic here until an operator acts. */
  readonly fatal: boolean;
  readonly elapsed_ms: number;
}

export interface LivenessOptions {
  /** How long to keep listening after `open()` resolves. Must exceed the
   *  in-band refusal latency measured above (~290 ms) with margin. */
  settleMs?: number;
  /** Ceiling for `open()` itself. */
  openTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_SETTLE_MS = 900;
const DEFAULT_OPEN_TIMEOUT_MS = 8_000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** EventEmitter view of an engine — engines subclass EventEmitter but the
 *  `SttEngine` interface deliberately does not declare `on` (see base.ts). */
type EngineSubscriber = SttEngine & { on(ev: 'error', fn: (e: SttEngineError) => void): unknown };

/**
 * Open one route through the REAL production adapter path and report what the
 * provider actually said.
 *
 * `factory` defaults to nothing on purpose — there is no friendly default
 * implementation here. A DI default that quietly answers "healthy" would be the
 * exact anti-pattern this repo bans ("a DI default must not be a friendly empty
 * implementation"): every route
 * would look alive forever and failover would never fire.
 */
export async function probeRouteLiveness(
  factory: EngineFactory,
  routing: Routing,
  language: string,
  opts: LivenessOptions = {},
): Promise<LivenessVerdict> {
  const now = opts.now ?? Date.now;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const openTimeoutMs = opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const t0 = now();

  let engine: EngineSubscriber;
  const cfg: SttEngineConfig = configFromRouting(routing, language);
  try {
    engine = factory(routing.engine_id, cfg) as EngineSubscriber;
  } catch (err) {
    // Construction failure = the route cannot be built at all (e.g. a cloud
    // engine whose private package is absent). Always fatal: no retry fixes it.
    return { ok: false, code: 'STT_CONFIG_MISSING', message: messageOf(err), fatal: true, elapsed_ms: now() - t0 };
  }

  // Attach BEFORE open(): an EventEmitter 'error' with no listener THROWS.
  let seen: SttEngineError | null = null;
  engine.on('error', (e: SttEngineError) => { seen ??= e; });

  try {
    if (engine.open) {
      await Promise.race([
        engine.open(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`open() exceeded ${openTimeoutMs} ms`)), openTimeoutMs).unref?.()),
      ]);
    }
    // 🔴 THE SETTLE WINDOW. Skipped for non-streaming engines: they have no
    // persistent session to say anything in band, and waiting would only make
    // startup slower. Exits early the moment an error lands.
    if (isStreamingEngine(routing.engine_id) && settleMs > 0) {
      await new Promise<void>((resolve) => {
        const done = setTimeout(resolve, settleMs);
        done.unref?.();
        const poll = setInterval(() => {
          if (seen !== null) { clearTimeout(done); clearInterval(poll); resolve(); }
        }, 25);
        poll.unref?.();
      });
    }
  } catch (err) {
    const code = err instanceof SttEngineError ? err.code : 'STT_ENGINE_TIMEOUT';
    return {
      ok: false, code, message: messageOf(err),
      fatal: ROUTE_FATAL_CODES.has(code), elapsed_ms: now() - t0,
    };
  } finally {
    try { await engine.close(); } catch { /* teardown never changes a verdict */ }
  }

  if (seen !== null) {
    const e: SttEngineError = seen;
    return {
      ok: false, code: e.code, message: e.message,
      fatal: ROUTE_FATAL_CODES.has(e.code), elapsed_ms: now() - t0,
    };
  }
  return { ok: true, code: null, message: '', fatal: false, elapsed_ms: now() - t0 };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The registry `selectRoute`'s `isAvailable` reads.
 * ──────────────────────────────────────────────────────────────────────────── */

interface HealthEntry {
  available: boolean;
  code: string | null;
  message: string;
  checked_at: number;
}

export interface RouteHealthRegistry {
  /** The `selectRoute` seam. SYNCHRONOUS — selection must not await I/O on the
   *  audio:start path (A6 §4a: zero extra latency). */
  isAvailable(route: PoolRoute): boolean;
  /** Fold in a verdict (probe or a live session's terminal error). Logged BOTH
   *  ways: a route coming back is as much news as one going down. */
  record(routeId: string, verdict: LivenessVerdict): void;
  /** Kick an async refresh if this route's entry is missing or stale. Fire and
   *  forget — never awaited by selection. */
  refresh(route: PoolRoute, routing: Routing, language: string): void;
  snapshot(): Readonly<Record<string, HealthEntry>>;
}

export interface HealthRegistryDeps {
  /** 🔴 REQUIRED, no default. See {@link probeRouteLiveness} on why a friendly
   *  default is forbidden here. */
  factory: EngineFactory;
  /** How long a verdict is trusted before a refresh is kicked. */
  ttlMs?: number;
  now?: () => number;
  liveness?: LivenessOptions;
}

const DEFAULT_TTL_MS = 60_000;

export function makeRouteHealthRegistry(deps: HealthRegistryDeps): RouteHealthRegistry {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const entries = new Map<string, HealthEntry>();
  const inFlight = new Set<string>();

  function record(routeId: string, verdict: LivenessVerdict): void {
    const prev = entries.get(routeId);
    // 🔴 A non-fatal failure does NOT evict the route. Otherwise one 500 from
    // the provider takes the platform's primary out for the whole TTL.
    const available = verdict.ok || !verdict.fatal;
    const entry: HealthEntry = {
      available,
      code: verdict.code,
      message: verdict.message,
      checked_at: now(),
    };
    entries.set(routeId, entry);
    if (prev?.available === available) return;
    // Leave a trace (A6 §3-3). Both directions, at a level someone actually reads.
    if (!available) {
      log.error('stt.pool route marked UNAVAILABLE', {
        route_id: routeId, code: verdict.code, provider_said: verdict.message, elapsed_ms: verdict.elapsed_ms,
      });
      return;
    }
    // 🔴 「first measurement」 and 「recovered」 are two different facts and must
    // not share one sentence: a first-ever probe logging 「available AGAIN」 tells
    // the reader a route went down and came back when nothing of the sort
    // happened. Found in the live drill 2026-08-02.
    log.info(
      prev === undefined ? 'stt.pool route measured healthy (first probe)' : 'stt.pool route is available again',
      { route_id: routeId, elapsed_ms: verdict.elapsed_ms },
    );
  }

  return {
    isAvailable(route): boolean {
      const e = entries.get(route.id);
      // Unknown ⇒ optimistic. A route nobody has measured yet must not be
      // treated as dead: that would refuse traffic on boot, before any probe has
      // had a chance to run, and "not yet measured" is not "broken".
      return e === undefined ? true : e.available;
    },
    record,
    refresh(route, routing, language): void {
      const e = entries.get(route.id);
      if (e !== undefined && now() - e.checked_at < ttlMs) return;
      if (inFlight.has(route.id)) return;
      inFlight.add(route.id);
      void probeRouteLiveness(deps.factory, routing, language, deps.liveness ?? {})
        .then((v) => record(route.id, v))
        .catch((err) => {
          // A probe that itself threw says nothing about the route — record
          // nothing rather than invent a verdict.
          log.warn('stt.pool liveness probe threw', { route_id: route.id, error: messageOf(err) });
        })
        .finally(() => { inFlight.delete(route.id); });
    },
    snapshot(): Readonly<Record<string, HealthEntry>> {
      return Object.fromEntries([...entries].map(([k, v]) => [k, { ...v }]));
    },
  };
}
