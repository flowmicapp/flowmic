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

import { SttEngineError } from './engines/base';

export const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000];
export const DEFAULT_MAX_RETRIES = 3;

export interface EngineSessionHooks {
  /** Spawn a fresh engine session (every reconnect is a brand-new session). */
  spawnEngine(): Promise<void>;
  /** Close the current engine session (drop listeners + dispose ws). */
  closeEngine(): Promise<void>;
  /** Feed the 5s replay buffer tail into the new engine. */
  replayBufferTail(): void;
  /** Stable engine id for the engine-status payload `provider` field. */
  currentEngineId(): string;
  /** Emit `engine-status {provider, status, retry_count?}` on the bus. */
  emitStatus(payload: { provider: string; status: 'ready' | 'reconnecting' | 'failed'; retry_count?: number }): void;
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
  private readonly _setTimeout: (fn: () => void, ms: number) => unknown;
  private readonly _clearTimeout: (handle: unknown) => void;

  constructor(
    private readonly hooks: EngineSessionHooks,
    options: EngineSessionLadderOptions = {},
  ) {
    this.backoff = options.reconnectBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this._setTimeout = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Read-only retry count for engine-status payloads emitted outside the ladder. */
  get retryCount(): number { return this._retryCount; }

  /**
   * OPEN → RECONNECTING on unexpected close. After `maxRetries` exhausted →
   * FAILED + STT_NETWORK_DROP. The `err` argument is otherwise UNREAD — this
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
  handleEngineError(err: Error): void {
    if (this.hooks.isTerminated()) return;
    const permanent = isPermanentEngineError(err);
    if (permanent !== null) {
      this.failTerminal(permanent.message, permanent.code);
      return;
    }
    if (this._retryCount >= this.maxRetries) {
      this.failTerminal('Engine reconnect exhausted');
      return;
    }
    const attempt = this._retryCount;
    this._retryCount += 1;
    this.hooks.emitStatus({
      provider: this.hooks.currentEngineId(),
      status: 'reconnecting',
      retry_count: this._retryCount,
    });
    void this.hooks.closeEngine();
    const delay = this.backoff[Math.min(attempt, this.backoff.length - 1)] ?? 1000;
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
    try {
      await this.hooks.spawnEngine();
      this.hooks.replayBufferTail();
      this._retryCount = 0;
      this.hooks.emitStatus({
        provider: this.hooks.currentEngineId(),
        status: 'ready',
      });
    } catch (err) {
      this.handleEngineError(reconnectSpawnError(err));
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
