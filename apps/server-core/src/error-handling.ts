// SPEC-REF:
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D1 (no silent failure — in EITHER
//     direction: never swallow, never report undone as done)
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §2 (index.ts CLI / process lifetime)
//   Card D4 (0.3.0): one SQLite error must not take down the whole relay.
//
// Crash containment, two of D4's three layers (the third — the heartbeat DB
// write — lives in socket/handlers/heartbeat.handler.ts):
//
//   LAYER 1 — installProcessGuards(): uncaughtException / unhandledRejection.
//   Before this module the process had NO handlers for either (index.ts
//   installed signal handlers only), and socket.io 4.8.3 dispatches every
//   event handler inside a bare `process.nextTick` with no try/catch
//   (node_modules/.pnpm/socket.io@4.8.3/…/dist/socket.js:689-702,
//   `dispatch()` → `process.nextTick(() => … super.emitUntyped(…))`), so ONE
//   throwing handler — e.g. a disk-full SQLite write — killed the relay for
//   every online user at once, and systemd restarted it into the same wall
//   (crash loop). This layer NEVER swallows-and-continues (red line: a
//   process that has thrown past every frame is in unknown state): it logs
//   loudly with the stack, attempts the existing RV-65 graceful close on a
//   hard budget, and exits NON-ZERO so systemd restarts a fresh process.
//
//   LAYER 2 — wrapSocketHandlers(): per-socket containment so layer 1 is the
//   backstop, not the service. Patches `socket.on` at connection time (the
//   ONE central registration seam — bootstrap.ts registers every handler
//   through the connection callback) so a throwing/rejecting handler fails
//   THAT event, logs event name + socket id, and the connection + process
//   live on. `socket.off`/`removeListener` are patched alongside to preserve
//   remove-by-reference (room/liveness.ts:94 removes its sys:pong probe
//   listener by the original function identity).
//
// PRIVACY: handler-failure log lines carry event name, socket id, error
// message and stack — NEVER the event payload. Payloads can contain user
// speech (inject:request text, stt frames); the log file must not.

import type { Socket } from 'socket.io';
import { log } from './log';

type LogFields = Record<string, unknown>;
export interface GuardLogger {
  error(msg: string, fields?: LogFields): void;
}

/** Exit code for a fatal-path exit — non-zero on purpose: systemd's
 *  Restart=on-failure needs the failure to be visible in the exit status.
 *
 *  🔴 CORRECTION (D10 audit, 2026-08-05) — the sentence above is kept because it
 *  records what was believed when this was written, but its premise does not
 *  hold for this deployment. The private deployment repo's mirror of the live
 *  systemd unit says `Restart=always`, NOT `Restart=on-failure`. Under
 *  `Restart=always` systemd restarts on exit code 0
 *  and 1 alike, so this constant does not buy a RESTART — it buys VISIBILITY:
 *  `systemctl status` / journald record `status=1/FAILURE` instead of
 *  `status=0/SUCCESS`, which is the only place a fatal leaves a machine-readable
 *  trace.
 *
 *  ⚠️ And nothing reads that trace today — no scheduled probe, no OnFailure=, no
 *  WatchdogSec anywhere in the unit. That gap IS card D10; the full audit is
 *  docs/strategy/2026-08-05-d10-monitoring-and-alerting-cn.md §2.2.
 *
 *  ⚠️ Whether the LIVE unit still says `Restart=always` is UNVERIFIED — the
 *  deploy/ copy is a mirror and its own header warns 「THE BOX IS THE TRUTH, THE
 *  REPO IS A CLAIM」. Keep the exit code non-zero regardless: it is correct under
 *  both restart policies. */
export const FATAL_EXIT_CODE = 1;

/** Hard ceiling on the fatal path's graceful close. Must sit ABOVE
 *  shutdown.ts's SHUTDOWN_GRACE_MS (5 s — the http drain's own bound) so the
 *  graceful close gets its full budget, and WELL BELOW systemd's
 *  TimeoutStopSec=20 s so a hung close still exits cleanly instead of
 *  earning a SIGKILL. */
export const FATAL_HARD_EXIT_MS = 10_000;

/** Re-entry log window: a fatal storm (e.g. every pending write rejecting at
 *  once while the first fatal is already draining) logs one line per window
 *  with a suppressed-count, instead of one line per rejection. */
export const FATAL_REENTRY_LOG_WINDOW_MS = 1_000;

/** Handler-failure log window (layer 2), per event name. audio:chunk arrives
 *  many times per second; if its handler starts throwing (dead disk), one
 *  line per window — carrying how many it stands for — is the flood-safe
 *  honest record. */
export const HANDLER_FAILURE_LOG_WINDOW_MS = 5_000;

/**
 * One log line per window; everything else in the window is counted, and the
 * count rides out on the NEXT line — rate-limiting must reduce line volume,
 * never hide event volume (no silent failure applies to the limiter too).
 */
export class RateGate {
  private windowStartedAt = Number.NEGATIVE_INFINITY;
  private suppressed = 0;
  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** `null` → suppressed, log nothing. A number → log now; the number is how
   *  many acquisitions were suppressed since the last granted one. */
  tryAcquire(): number | null {
    const t = this.now();
    if (t - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = t;
      const n = this.suppressed;
      this.suppressed = 0;
      return n;
    }
    this.suppressed += 1;
    return null;
  }
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** The narrow slice of `process` the guards need — injectable so tests never
 *  hang real handlers off the vitest process. */
export interface ProcessLike {
  on(event: 'uncaughtException' | 'unhandledRejection', fn: (arg: unknown) => void): unknown;
  removeListener(event: 'uncaughtException' | 'unhandledRejection', fn: (arg: unknown) => void): unknown;
}

export interface ProcessGuardOpts {
  /** The RV-65 graceful shutdown (BootstrapHandle.close). The caller shares
   *  ONE memoized close between this and the signal path so the 5-step close
   *  sequence can never run twice (db.close() is not re-entrant). */
  close: () => Promise<void>;
  proc?: ProcessLike;
  /** Default: process.exit — the real thing, never a no-op (a fatal that does
   *  not end the process would be swallow-and-continue with extra steps). */
  exit?: (code: number) => void;
  logger?: GuardLogger;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  hardExitMs?: number;
  reentryGate?: RateGate;
}

/**
 * Layer 1. Install uncaughtException + unhandledRejection handlers: log the
 * stack, run the graceful close on a hard budget, exit non-zero. Re-entrant
 * fatals (another exception while the close is draining) are rate-gate
 * logged and NEVER restart the close — the first fatal already owns the
 * exit, and the hard timer guarantees it happens.
 *
 * Returns an uninstaller (tests only; production never uninstalls).
 */
export function installProcessGuards(opts: ProcessGuardOpts): () => void {
  const proc = opts.proc ?? (process as ProcessLike);
  const exit = opts.exit ?? ((code: number): void => process.exit(code));
  const logger = opts.logger ?? log;
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  const hardExitMs = opts.hardExitMs ?? FATAL_HARD_EXIT_MS;
  const gate = opts.reentryGate ?? new RateGate(FATAL_REENTRY_LOG_WINDOW_MS);
  let fatalInProgress = false;

  const onFatal = (kind: 'uncaughtException' | 'unhandledRejection', reason: unknown): void => {
    const err = asError(reason);
    if (fatalInProgress) {
      // Shutdown is already draining and the hard timer already guarantees a
      // non-zero exit — re-entering close() here could recurse forever if the
      // close path itself is what throws. Log (rate-gated) and stand down.
      const suppressed = gate.tryAcquire();
      if (suppressed !== null) {
        logger.error('fatal (re-entry): another fatal while shutting down', {
          kind,
          error: err.message,
          suppressedSinceLastLine: suppressed,
        });
      }
      return;
    }
    fatalInProgress = true;
    logger.error(`fatal: ${kind} — attempting graceful close, then exiting non-zero`, {
      error: err.message,
      stack: err.stack ?? null,
    });
    const timer = setTimeoutFn(() => {
      logger.error('fatal: graceful close overran its budget, forcing exit', { hardExitMs });
      exit(FATAL_EXIT_CODE);
    }, hardExitMs);
    // unref where available: the escape-hatch timer must never itself hold the
    // process open once close() has finished and exit() is a test stub.
    (timer as { unref?: () => void })?.unref?.();
    void Promise.resolve()
      .then(() => opts.close())
      .then(
        () => {
          logger.error('fatal: graceful close finished — exiting non-zero for supervisor restart', { kind });
          exit(FATAL_EXIT_CODE);
        },
        (closeErr: unknown) => {
          logger.error('fatal: graceful close itself failed — exiting non-zero', {
            kind,
            error: asError(closeErr).message,
          });
          exit(FATAL_EXIT_CODE);
        },
      );
  };

  const onException = (reason: unknown): void => onFatal('uncaughtException', reason);
  const onRejection = (reason: unknown): void => onFatal('unhandledRejection', reason);
  proc.on('uncaughtException', onException);
  proc.on('unhandledRejection', onRejection);
  return (): void => {
    proc.removeListener('uncaughtException', onException);
    proc.removeListener('unhandledRejection', onRejection);
  };
}

/** The slice of Socket the wrapper touches — structural so unit tests can
 *  drive a plain EventEmitter-backed fake. */
export interface WrappableSocket {
  id: string;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface WrapSocketOpts {
  logger?: GuardLogger;
  /** Per-event-name rate gates. Default: ONE module-shared map, deliberately
   *  shared across all sockets — a dead disk makes EVERY socket's handler
   *  throw, and per-socket gates would multiply the flood right back. */
  gateFor?: (event: string) => RateGate;
}

const sharedHandlerGates = new Map<string, RateGate>();
function defaultGateFor(event: string): RateGate {
  let gate = sharedHandlerGates.get(event);
  if (!gate) {
    gate = new RateGate(HANDLER_FAILURE_LOG_WINDOW_MS);
    sharedHandlerGates.set(event, gate);
  }
  return gate;
}

/**
 * Layer 2. Patch THIS socket's `on` so every handler registered after this
 * call — bootstrap registers all of them after it — is contained: a sync
 * throw or an async rejection fails that ONE event (the client's ack, if it
 * expected one, times out — the event honestly did fail) and the socket, the
 * other sockets and the process live on. The failure is logged with event
 * name + socket id + stack, never the payload (user text).
 *
 * `off`/`removeListener` are patched to translate the caller's original
 * listener reference to the wrapped one, so remove-by-reference
 * (room/liveness.ts sys:pong probes) keeps working.
 */
export function wrapSocketHandlers(socket: Socket | WrappableSocket, opts: WrapSocketOpts = {}): void {
  const logger = opts.logger ?? log;
  const gateFor = opts.gateFor ?? defaultGateFor;
  const target = socket as unknown as WrappableSocket;
  // event → (original listener → wrapped listener); per socket.
  const wrappedBy = new Map<string, Map<(...args: unknown[]) => void, (...args: unknown[]) => void>>();

  const report = (event: string, reason: unknown): void => {
    const err = asError(reason);
    const suppressed = gateFor(event).tryAcquire();
    if (suppressed === null) return;
    logger.error('socket handler failed — event dropped, connection kept', {
      event,
      socketId: target.id,
      error: err.message,
      stack: err.stack ?? null,
      suppressedSinceLastLine: suppressed,
    });
  };

  const originalOn = target.on.bind(target);
  const originalOff = target.off.bind(target);
  const originalRemove = target.removeListener.bind(target);

  target.on = (event: string, listener: (...args: unknown[]) => void): unknown => {
    const wrapped = function wrappedHandler(this: unknown, ...args: unknown[]): void {
      try {
        const out = listener.apply(this, args) as unknown;
        if (
          out !== null &&
          (typeof out === 'object' || typeof out === 'function') &&
          typeof (out as PromiseLike<unknown>).then === 'function'
        ) {
          void Promise.resolve(out as PromiseLike<unknown>).then(undefined, (err: unknown) => report(event, err));
        }
      } catch (err) {
        report(event, err);
      }
    };
    let forEvent = wrappedBy.get(event);
    if (!forEvent) {
      forEvent = new Map();
      wrappedBy.set(event, forEvent);
    }
    forEvent.set(listener, wrapped);
    return originalOn(event, wrapped);
  };

  const translateRemove = (
    remove: (event: string, listener: (...args: unknown[]) => void) => unknown,
  ): ((event: string, listener: (...args: unknown[]) => void) => unknown) => {
    return (event: string, listener: (...args: unknown[]) => void): unknown => {
      const forEvent = wrappedBy.get(event);
      const wrapped = forEvent?.get(listener);
      if (wrapped) {
        forEvent?.delete(listener);
        return remove(event, wrapped);
      }
      return remove(event, listener);
    };
  };
  target.off = translateRemove(originalOff);
  target.removeListener = translateRemove(originalRemove);
}
