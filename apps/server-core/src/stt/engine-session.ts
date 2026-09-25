// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2.3 (engine auto-reconnect:
//     OPEN→RECONNECTING [1/2/4s ×3]→OPEN|FAILED; replay: 5s replay buffer;
//     stt:engine-status visible throughout; 3 failures → stt:error{STT_NETWORK_DROP})
//   Ported from legacy stt/engine-session.ts (mechanism carried over unchanged, F-403/S-API-8).
//
// EngineSessionReconnectLadder: the per-session reconnect state machine. The
// orchestrator composes one per audio:start..audio:stop run and drives it
// through the SessionHooks contract — no private-field access, no duplicate
// state. ALL timer methods + wall-clock are injectable for deterministic tests.

import { AUDIO_DEFAULTS, engineReconnectDelayMs } from '@flowmic/protocol';
import { SttEngineError } from './engines/base';
import { raceSpawnTimeout } from './spawn-timeout';

// NR-96 follow-up: the schedule is DECLARED once, in `AUDIO_DEFAULTS` (book 06
// §1 `engine_reconnect`), and read here — it used to be a second literal copy of
// the same numbers. The ladder's worst case (retention window, capsule
// fallback watchdog) is derived from these by `engineReconnectWorstCaseMs`.
export const DEFAULT_BACKOFF_MS: readonly number[] = AUDIO_DEFAULTS.engine_reconnect_backoff_ms;
export const DEFAULT_MAX_RETRIES: number = AUDIO_DEFAULTS.engine_reconnect_max_retries;
export { engineReconnectWorstCaseMs } from '@flowmic/protocol';

/** card RC-1 — the ceiling on ONE wait of the long-recording ladder
 *  ({@link EngineSessionLadderOptions.unbounded}). Not a new number: the phone's
 *  own link ladder tops out at the same 30 s
 *  (`apps/mobile/lib/src/signaling/reconnect.dart` `maxBackoff`), and the web
 *  client's matches it (NR-96 design §3.6) — one product, one rule. */
export const UNBOUNDED_BACKOFF_CAP_MS = 30_000;

/** card RC-1 — the long-recording schedule: the declared rungs, then each wait
 *  doubles the last one, capped at {@link UNBOUNDED_BACKOFF_CAP_MS}
 *  (defaults ⇒ 1, 2, 4, 8, 16, 30, 30 … s). */
export function unboundedReconnectDelayMs(backoffMs: readonly number[], attemptIndex: number): number {
  const last = Math.max(0, backoffMs.length - 1);
  const base = engineReconnectDelayMs(backoffMs, Math.min(attemptIndex, last));
  const doublings = Math.max(0, attemptIndex - last);
  return Math.min(UNBOUNDED_BACKOFF_CAP_MS, base * 2 ** Math.min(doublings, 16));
}

/**
 * 🔴 card RC-1 — a leg WE closed (or replaced) while it was still opening.
 *
 * CR-12-E root cause §1.4: a pause cut closed a redial's opening leg, the ladder
 * then closed the rollover's fresh leg, one rung's spawn closed the previous
 * rung's — four "failures" in 3 s, three of them us closing each other's legs,
 * and the session died on `STT_NETWORK_DROP` with the network fine. Such a
 * rejection is not an engine failure: whoever closed the leg owns what comes
 * next. `orchestrator-core.ts spawnEngine` raises it when `open()` settles on a
 * leg that is no longer the current one; {@link EngineSessionReconnectLadder.handleEngineError}
 * returns on it without counting a rung, emitting a frame or closing anything.
 */
export class SupersededLegError extends Error {
  constructor(readonly original?: unknown) { super('engine leg superseded while opening'); this.name = 'SupersededLegError'; }
}

/** card RC-1 — the per-attempt handle a spawn fills in with the leg it created,
 *  so a failure can name WHICH leg failed (the ladder closes that one, never
 *  "whatever is current"). `leg` stays null until the engine exists. */
export interface SpawnAttempt { leg: unknown }

/** The ladder's `engine-status` payload. The last three fields are NR-96
 *  (book 15 §2.7, protocol `SttEngineStatusSchema`): the retry budget, put on
 *  every `reconnecting` frame and on no other, so a client can say "attempt n
 *  of N" and arm a watchdog from facts on the frame instead of a local guess.
 *  `retry_count` answers "how many attempts", never "is it alive" (law 5). */
export interface EngineStatusPayload {
  provider: string;
  status: 'ready' | 'reconnecting' | 'failed';
  retry_count?: number;
  retry_max?: number;
  retry_in_ms?: number;
  attempt_timeout_ms?: number;
  /** card RC-3b — on the `ready` that ENDS a reconnect only (see
   *  {@link EngineSessionReconnectLadder} `attemptReconnect`): the audio
   *  milliseconds re-fed from the retention ring to the new leg. The phone
   *  subtracts it from what it captured during the outage; the rest no engine
   *  heard (book 04 `stt:engine-status` row, RC-3b note).
   *  ⚠️ 更正（RC-L，2026-09-24）：the replay now also re-feeds what the dead leg was handed and never answered
   *  (`replay-debt.ts` `answeredFloorSeq`), so this can exceed the outage; the phone's owed range therefore
   *  starts at its own last acknowledged position and ends at 「capture position at `ready` − replayed_ms」,
   *  which holds for both relays because the replay always runs contiguously up to now (rerun-3 root cause §8 RC-L). */
  replayed_ms?: number;
}

/** NR-96 — the progress fields of an `engine-status` payload, copied only when
 *  present and numeric. The bridge (`engine/stt-session.ts`) builds its outbound
 *  frame field by field, so a field it does not copy is a field the phone never
 *  sees; this is its one copy site for all four.
 *  card RC-3b — and for `replayed_ms`, the fifth, for the same reason. */
type ProgressKey = 'retry_count' | 'retry_max' | 'retry_in_ms' | 'attempt_timeout_ms' | 'replayed_ms';
export function engineStatusProgress(e: Partial<EngineStatusPayload>): Pick<EngineStatusPayload, ProgressKey> {
  const out: Pick<EngineStatusPayload, ProgressKey> = {};
  for (const k of ['retry_count', 'retry_max', 'retry_in_ms', 'attempt_timeout_ms', 'replayed_ms'] as const) {
    const v = e[k];
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

export interface EngineSessionHooks {
  /** Spawn a fresh engine session (every reconnect is a brand-new session).
   *  card RC-1 — fills `attempt.leg` with the leg it created. */
  spawnEngine(attempt: SpawnAttempt): Promise<void>;
  /** Close the current engine session (drop listeners + dispose ws).
   *  card RC-1 — with `leg`, only if that leg IS the current one. */
  closeEngine(leg?: unknown): Promise<void>;
  /** Feed the 5s replay buffer tail into the new engine.
   *  card RC-3b — returns the audio milliseconds it handed over (the
   *  `replayed_ms` of the `ready` that follows); `void` from a hook that cannot
   *  say, in which case the frame carries no such field. */
  replayBufferTail(): number | void;
  /** Stable engine id for the engine-status payload `provider` field. */
  currentEngineId(): string;
  /** Emit `engine-status` on the bus (shape: {@link EngineStatusPayload}). */
  emitStatus(payload: EngineStatusPayload): void;
  /** Emit terminal `error {code, message, retryable}` (S-API-8). */
  emitError(payload: { code: string; message: string; retryable: boolean }): void;
  /** Soft-segment timer disarm on terminal failure. */
  clearSoftSegmentTimer(): void;
  /** True once the orchestrator has been closed; the ladder MUST NOT emit any
   *  further status/error events past this gate. */
  isTerminated(): boolean;
}

export interface EngineSessionLadderOptions {
  reconnectBackoffMs?: readonly number[];
  maxRetries?: number;
  /** NR-96 — the cap on ONE rung's spawn. The orchestrator passes its
   *  `engineSpawnTimeoutMs` (the same cap the cold open and `dialLeg` race), so
   *  a vendor that accepts TCP and never finishes the handshake costs one rung,
   *  not the rest of the session (RT3-C, `stt-outage-loss.test.ts` CASE 4).
   *  Absent ⇒ no race AND no `attempt_timeout_ms` on the frame: a field that
   *  promises a bound nobody enforces would be a lie. */
  attemptTimeoutMs?: number;
  /** card RC-1 — a LONG RECORDING (`audio:start.continuous === true`, book 04):
   *  never give up on count (book 06 §2.3, 2026-08-29 addendum — the session
   *  degrades, it does not end). `retry_max` is absent from every frame,
   *  waits follow {@link unboundedReconnectDelayMs}. An error the ENGINE
   *  declared `retryable:false` still ends it at once (L2): that sentence is
   *  true, and retrying cannot make it false. Bounded by the session's own
   *  ceiling and the user's stop. */
  unbounded?: boolean;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * The engine-session reconnect ladder. One instance per audio:start..audio:stop.
 * The orchestrator owns the engine field and replay buffer; the ladder owns
 * ONLY the retry timing and state.
 */
export class EngineSessionReconnectLadder {
  private _retryCount = 0;
  private reconnectTimer: unknown = null;
  private readonly maxRetries: number;
  private readonly backoff: readonly number[];
  private readonly attemptTimeoutMs: number | undefined;
  private readonly unbounded: boolean;
  private _gaveUp = false;
  private readonly _setTimeout: (fn: () => void, ms: number) => unknown;
  private readonly _clearTimeout: (handle: unknown) => void;

  constructor(
    private readonly hooks: EngineSessionHooks,
    options: EngineSessionLadderOptions = {},
  ) {
    this.backoff = options.reconnectBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.attemptTimeoutMs = options.attemptTimeoutMs;
    this.unbounded = options.unbounded === true;
    this._setTimeout = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Read-only retry count for engine-status payloads emitted outside the ladder. */
  get retryCount(): number { return this._retryCount; }

  /** card RC-7 — the ladder has spoken its terminal verdict (`failTerminal`).
   *  Read by `orchestrator-core.ts` so a late-opening leg cannot take the session
   *  back, and no silence redial dials after it. Never true on an `unbounded`
   *  ladder except through an engine-declared permanent error. */
  get gaveUp(): boolean { return this._gaveUp; }

  /**
   * OPEN → RECONNECTING on unexpected close. After `maxRetries` exhausted →
   * FAILED + STT_NETWORK_DROP (never, on an `unbounded` ladder — card RC-1). `leg` names the leg that
   * failed (card RC-1: only that one is closed). The `err` argument is otherwise UNREAD (beyond the
   * card RC-1 `SupersededLegError` check below) — this
   * file has no logger and never had one (the only `console.` on this path is
   * this sentence; a `git -S` anchor stood here until it started matching the
   * commit that introduced it) — and the ladder uses a fixed
   * terminal message so the exposed error payload is stable across engine
   * implementations (S-API-8 requires the literal `code:'STT_NETWORK_DROP'`,
   * never the underlying ws message).
   *
   * ⚠️ 「consumed only by logging」 is what that sentence used to say, and it was
   * false the whole time (Card ENG-2, 2026-08-13 — anti-façade ④: a comment asserting
   * behaviour elsewhere, with no anchor anyone could grep). Corrected in place
   * rather than deleted, because the clause it was attached to — 「the permanence
   * check is the ONLY reader of this argument」 — is exactly what makes
   * {@link reconnectSpawnError} load-bearing: a fabricated `err` on that path is
   * not a cosmetic loss, it is the whole input to the only decision made here.
   *
   * 🔴 EXCEPT WHEN THE ENGINE ALREADY SAID RETRYING IS POINTLESS (2026-08-02,
   * L2, found by the first REAL Soniox round-trip).
   *
   * The ladder used to ignore `SttEngineError.retryable` completely and climb
   * all three rungs for ANY error. Against a live vendor refusal
   * (`402 organization_balance_exhausted`) that produced, in order:
   *   · three reconnects to a service that refuses every single time, 7 s of
   *     backoff spent on a certainty;
   *   · a terminal `STT_NETWORK_DROP` "network interruption, recognition session
   *     terminated" — FALSE. The
   *     network was fine; the platform's STT account was out of funds. The one
   *     sentence the operator needed was thrown away by the fixed message;
   *   · and for any utterance shorter than the ladder (a 6 s recording, i.e.
   *     the normal case) the session ended BEFORE rung 3, so the phone received
   *     NO final and NO error at all — [measured] the drill's SESSION 1 showed
   *     `FINALS: []  errors: []`. That is the no-silent-failure red line, live.
   *
   * `retryable` is not a new signal: `base.ts` has always declared it and every
   * engine sets it. It simply had no reader on this path. Honouring it makes the
   * terminal verdict immediate AND truthful — the engine's own code and message
   * are passed through, so `STT_ENGINE_AUTH_FAIL` +
   * 「[organization_balance_exhausted] …」 reaches the log and the phone instead
   * of a network story. The phone's FSM already branches on exactly this field
   * (`ptt_inbound.dart` → `onSttTerminalError`), so it closes PROCESSING at once
   * instead of idling out its 15 s stall net.
   */
  handleEngineError(err: Error, leg?: unknown): void {
    if (this.hooks.isTerminated() || this._gaveUp) return; // card RC-7: after the verdict, nothing climbs again
    // 🔴 card RC-1 — a leg somebody else closed while it opened is not a failure;
    // that somebody owns what comes next. No rung, no frame, nothing closed.
    if (err instanceof SupersededLegError) return;
    const permanent = isPermanentEngineError(err);
    if (permanent !== null) {
      this.failTerminal(permanent.message, permanent.code);
      return;
    }
    if (!this.unbounded && this._retryCount >= this.maxRetries) {
      this.failTerminal('Engine reconnect exhausted');
      return;
    }
    const attempt = this._retryCount;
    this._retryCount += 1;
    const delay = this.unbounded
      ? unboundedReconnectDelayMs(this.backoff, attempt) // card RC-1: capped, never exhausted
      : engineReconnectDelayMs(this.backoff, attempt); // the same rule the worst case sums
    // NR-96: the budget rides the frame — the SAME `delay` the timer below is
    // armed with, the SAME cap `attemptReconnect` races. Read, not restated.
    // card RC-1: an unbounded ladder has no total, and `retry_max` absent IS
    // how the frame says so (book 04 `stt:engine-status` row).
    this.hooks.emitStatus({
      provider: this.hooks.currentEngineId(),
      status: 'reconnecting',
      retry_count: this._retryCount,
      ...(this.unbounded ? {} : { retry_max: this.maxRetries }),
      retry_in_ms: delay,
      ...(this.attemptTimeoutMs !== undefined ? { attempt_timeout_ms: this.attemptTimeoutMs } : {}),
    });
    // 🔴 card RC-1 — close the leg that FAILED, never 「whatever is current」: this
    // line used to close the current engine unconditionally, i.e. the fresh leg a
    // rollover or another rung had just started (root cause §1.4 step 2).
    void this.hooks.closeEngine(leg);
    this.clearReconnectTimer(); // one rung in flight, never two timers racing each other
    this.reconnectTimer = this._setTimeout(() => { void this.attemptReconnect(); }, delay);
  }

  /** Disarm any pending reconnect timer. Idempotent. */
  clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this._clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Returns true iff a reconnect attempt is currently scheduled. */
  hasPendingReconnect(): boolean {
    return this.reconnectTimer !== null;
  }

  private async attemptReconnect(): Promise<void> {
    if (this.hooks.isTerminated()) return;
    this.reconnectTimer = null;
    const attempt: SpawnAttempt = { leg: null }; // card RC-1: which leg this rung made
    try {
      // NR-96 — the rung's spawn is capped like the cold open and `dialLeg`.
      // A timeout rejects with a plain SpawnTimeoutError, which
      // `reconnectSpawnError` passes on as a retryable failure: it counts as one
      // rung and the ladder climbs (or gives up) exactly as for a refused dial.
      const spawn = this.hooks.spawnEngine(attempt);
      await (this.attemptTimeoutMs === undefined
        ? spawn
        : raceSpawnTimeout(spawn, this.attemptTimeoutMs, this._setTimeout, this._clearTimeout));
      // card RC-3b — what the replay ACTUALLY handed the new leg, read off the
      // feed itself, on the frame that says the leg is back: the phone has no
      // other way to know how much of its outage the relay still held.
      const replayedMs = this.hooks.replayBufferTail();
      this._retryCount = 0;
      this.hooks.emitStatus({
        provider: this.hooks.currentEngineId(),
        status: 'ready',
        ...(typeof replayedMs === 'number' ? { replayed_ms: replayedMs } : {}),
      });
    } catch (err) {
      this.handleEngineError(reconnectSpawnError(err), attempt.leg);
    }
  }

  /** `code` defaults to the S-API-8 literal for the reconnect-exhausted case;
   *  a permanent engine error passes its OWN code through, because that is the
   *  one sentence that is actually true about it.
   *
   *  🔴 OPEN ACCOUNT (Card ENG-2, REGISTERED — deliberately not closed here). When
   *  the budget is EXHAUSTED this default still overwrites whatever the engine
   *  last said, so a run that died on three `STT_ENGINE_RATE_LIMITED` refusals
   *  ends as "network interruption". That is the card's own shape — but the literal is
   *  written into a BEHAVIOUR CONTRACT (docs/rebuild/06 §2.3 "3 failures →
   *  stt:error{STT_NETWORK_DROP}", S-API-8), and that document's change
   *  discipline is "change the doc first, then change the implementation". Changing it is therefore a ruling, not a
   *  fix, and this card does not have one. What ENG-2 does close is the site
   *  where a PERMANENT named error could never reach a verdict at all — see
   *  {@link reconnectSpawnError}. */
  private failTerminal(message: string, code = 'STT_NETWORK_DROP'): void {
    this._gaveUp = true; // card RC-7 — read by `gaveUp`; set BEFORE the frames, so no listener sees a live ladder
    this.hooks.emitStatus({
      provider: this.hooks.currentEngineId(),
      status: 'failed',
      retry_count: this._retryCount,
    });
    this.hooks.emitError({ code, message, retryable: false });
    this.hooks.clearSoftSegmentTimer();
    this.clearReconnectTimer();
  }
}

/**
 * 🔴 Card ENG-2 (fix-029), the RECONNECT half — what a failed reconnect spawn
 * hands back to {@link EngineSessionReconnectLadder.handleEngineError}.
 *
 * THE ACCOUNT. That catch used to bind NOTHING (`catch {`) and synthesise
 * `new Error('Engine spawn failed during reconnect')`, i.e. the engine's own
 * verdict was thrown away one line before the only code that reads it. Two
 * consequences, and the second is the one the user sees:
 *   · `isPermanentEngineError` could only ever answer `null` on this path ⇒ a
 *     vendor that refuses every handshake (a `402 organization_balance_exhausted`
 *     on the re-open; sherpa-local's `STT_CONFIG_MISSING` when the addon/model
 *     is gone) was retried the whole budget — the pointless climb L2 removed for
 *     mid-session errors, still running here;
 *   · the run then ended on `failTerminal`'s default `STT_NETWORK_DROP`
 *     "network interruption, recognition session terminated", which is FALSE for both of those and sends the
 *     operator to check a network that works.
 *
 * Same card, same defect, THIRD site: the cold open was closed by
 * `cold-open-verdict.ts`, the mid-session and flush paths by L2
 * (`isPermanentEngineError` / `flushErrorVerdict`). This is the one they left,
 * and it is the only one of the four where the error was not merely RE-CODED but
 * DESTROYED — so no verdict function downstream could have rescued it.
 *
 * ⚠️ ONLY the permanent case changes behaviour. A retryable `SttEngineError`
 * (a ws drop, an HTTP 429) still answers `null` at the permanence check and
 * still climbs exactly as before; a non-engine rejection keeps the literal it
 * always had. This function decides NO verdict — it stops us inventing the fact
 * the verdict is read off (R11: the layer that makes the judgment must have in
 * hand the facts it needs in order to make it).
 *
 * ⚠️ The ROUTER's `SttConfigMissingError` is deliberately NOT passed through as
 * well, and the non-change has a reason rather than an oversight: the production
 * factory (`engine-factory.ts makeSttOrchestratorFactory`) closes over a
 * routings SNAPSHOT taken at `audio:start`, so a reconnect asks the same
 * question the cold open already answered — a session that got this far got an
 * engine once and gets one again. Handling it here would be a recovery path for
 * a state nobody has observed, which is how façades are built.
 */
function reconnectSpawnError(err: unknown): Error {
  if (err instanceof SttEngineError) return err;
  if (err instanceof SupersededLegError) return err; // card RC-1 — must reach the ladder's own check intact
  return new Error('Engine spawn failed during reconnect');
}

/**
 * Is this an engine error the engine itself declared unretryable?
 *
 * 🔴 `instanceof SttEngineError` — CLASS IDENTITY, and it holds across the
 * private cloud package too: `packages/stt-cloud` never declares its own error
 * class, it is handed server-core's real one (`host.ts` explains why at length).
 * If that ever changes, this check answers `false` and the ONLY symptom is three
 * pointless reconnects — so keep the host injection.
 *
 * Returns null when the error is retryable, unknown-shaped, or a plain `Error`
 * (the ladder's own spawn-failure signal) — all of which keep the old
 * climb-the-ladder behaviour.
 */
function isPermanentEngineError(err: Error): { code: string; message: string } | null {
  if (!(err instanceof SttEngineError)) return null;
  if (err.retryable !== false) return null;
  return { code: err.code, message: err.message };
}
