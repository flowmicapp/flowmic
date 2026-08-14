// D4 layer 1 — the process-level fatal guards.
//
// Before this card the process had NO uncaughtException/unhandledRejection
// handlers (index.ts installed SIGINT/SIGTERM only), and socket.io 4.8.3
// dispatches every handler in a bare process.nextTick with no try/catch —
// so one throwing handler was a whole-relay crash with every online user
// dropped at once. The guards must: log loudly WITH the stack, attempt the
// existing RV-65 graceful close, and ALWAYS exit non-zero (house red line:
// never swallow-and-continue at this layer), with a hard-exit budget in case
// the close itself hangs, and a rate-gate against fatal-storm re-entry.
//
// Driven over an injectable ProcessLike (a plain EventEmitter) — hanging real
// listeners off the vitest process would intercept vitest's own error
// handling.

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FATAL_EXIT_CODE,
  FATAL_HARD_EXIT_MS,
  RateGate,
  installProcessGuards,
  type ProcessLike,
} from '../src/error-handling';
import { SHUTDOWN_GRACE_MS } from '../src/shutdown';

interface LogLine {
  msg: string;
  fields: Record<string, unknown>;
}

function makeCapture(): { logger: { error(msg: string, fields?: Record<string, unknown>): void }; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return { lines, logger: { error: (msg, fields): void => { lines.push({ msg, fields: fields ?? {} }); } } };
}

/** One armed timer at a time is all the guard uses; fire() runs it on demand. */
function makeManualTimer(): { setTimeoutFn: (fn: () => void, ms: number) => unknown; fire: () => void; armedMs: number[] } {
  const armedMs: number[] = [];
  let pending: (() => void) | null = null;
  return {
    armedMs,
    setTimeoutFn: (fn, ms): unknown => {
      pending = fn;
      armedMs.push(ms);
      return { unref: (): void => {} };
    },
    fire: (): void => {
      pending?.();
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function harness(overrides: {
  close?: () => Promise<void>;
  reentryGate?: RateGate;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
} = {}): {
  proc: EventEmitter;
  lines: LogLine[];
  exits: number[];
  closes: number;
  uninstall: () => void;
} {
  const proc = new EventEmitter();
  const { logger, lines } = makeCapture();
  const exits: number[] = [];
  const state = { closes: 0 };
  const uninstall = installProcessGuards({
    close: overrides.close ?? ((): Promise<void> => { state.closes += 1; return Promise.resolve(); }),
    proc: proc as unknown as ProcessLike,
    exit: (code): void => { exits.push(code); },
    logger,
    ...(overrides.setTimeoutFn ? { setTimeoutFn: overrides.setTimeoutFn } : {}),
    ...(overrides.reentryGate ? { reentryGate: overrides.reentryGate } : {}),
  });
  return { proc, lines, exits, get closes() { return state.closes; }, uninstall };
}

describe('RateGate — one line per window, volume counted not hidden', () => {
  it('grants the first, suppresses inside the window, reports the suppressed count on the next grant', () => {
    let t = 1_000;
    const gate = new RateGate(30_000, () => t);
    expect(gate.tryAcquire()).toBe(0); // first: granted, nothing was suppressed
    expect(gate.tryAcquire()).toBeNull();
    expect(gate.tryAcquire()).toBeNull();
    t += 30_000;
    expect(gate.tryAcquire()).toBe(2); // the two swallowed ones ride out here
    t += 30_000;
    expect(gate.tryAcquire()).toBe(0); // a quiet window resets to zero
  });
});

describe('installProcessGuards — fatal ⇒ loud log + graceful close + non-zero exit', () => {
  it('uncaughtException: logs message AND stack, closes, exits non-zero', async () => {
    const h = harness();
    const boom = new Error('disk full: SQLITE_FULL');
    h.proc.emit('uncaughtException', boom);
    await flush();

    expect(h.closes).toBe(1);
    expect(h.exits).toEqual([FATAL_EXIT_CODE]);
    expect(FATAL_EXIT_CODE).not.toBe(0); // non-zero IS the systemd restart contract
    const first = h.lines[0]!;
    expect(first.msg).toContain('uncaughtException');
    expect(first.fields.error).toBe('disk full: SQLITE_FULL');
    expect(String(first.fields.stack)).toContain('error-guards.test.ts'); // a real stack, not a placeholder
    h.uninstall();
  });

  it('unhandledRejection: same path, and a non-Error reason is still stringified', async () => {
    const h = harness();
    h.proc.emit('unhandledRejection', 'string reason');
    await flush();

    expect(h.closes).toBe(1);
    expect(h.exits).toEqual([FATAL_EXIT_CODE]);
    expect(h.lines[0]!.msg).toContain('unhandledRejection');
    expect(h.lines[0]!.fields.error).toBe('string reason');
    h.uninstall();
  });

  it('a close() that REJECTS still exits non-zero — the guard never swallows', async () => {
    const h = harness({ close: (): Promise<void> => Promise.reject(new Error('db.close exploded')) });
    h.proc.emit('uncaughtException', new Error('original fatal'));
    await flush();

    expect(h.exits).toEqual([FATAL_EXIT_CODE]);
    expect(h.lines.some((l) => l.msg.includes('graceful close itself failed'))).toBe(true);
    h.uninstall();
  });

  it('a close() that HANGS is cut off by the hard-exit budget', async () => {
    const timer = makeManualTimer();
    const h = harness({
      close: (): Promise<void> => new Promise(() => {}), // never settles
      setTimeoutFn: timer.setTimeoutFn,
    });
    h.proc.emit('uncaughtException', new Error('fatal with a stuck close'));
    await flush();
    expect(h.exits).toEqual([]); // still draining — no premature exit

    timer.fire(); // the budget elapses
    expect(h.exits).toEqual([FATAL_EXIT_CODE]);
    expect(h.lines.some((l) => l.msg.includes('forcing exit'))).toBe(true);
    // The budget must exceed the http drain's own bound (close gets its full
    // grace) and stay under systemd's TimeoutStopSec=20s (no SIGKILL).
    expect(timer.armedMs).toEqual([FATAL_HARD_EXIT_MS]);
    expect(FATAL_HARD_EXIT_MS).toBeGreaterThan(SHUTDOWN_GRACE_MS);
    expect(FATAL_HARD_EXIT_MS).toBeLessThan(20_000);
    h.uninstall();
  });

  it('re-entry: a second fatal while draining never restarts close, and a fatal STORM is rate-gated', async () => {
    let t = 0;
    const gate = new RateGate(1_000, () => t);
    const timer = makeManualTimer();
    const h = harness({
      close: (): Promise<void> => new Promise(() => {}), // keep the drain open so re-entries land mid-shutdown
      reentryGate: gate,
      setTimeoutFn: timer.setTimeoutFn,
    });
    h.proc.emit('uncaughtException', new Error('first fatal'));
    await flush();

    // The storm: three more fatals inside one gate window.
    h.proc.emit('uncaughtException', new Error('re-entry 1'));
    h.proc.emit('unhandledRejection', new Error('re-entry 2'));
    h.proc.emit('uncaughtException', new Error('re-entry 3'));
    await flush();

    const reentryLines = h.lines.filter((l) => l.msg.includes('re-entry'));
    expect(reentryLines).toHaveLength(1); // one line for three fatals…
    expect(reentryLines[0]!.fields.suppressedSinceLastLine).toBe(0);

    t += 1_000; // …and the NEXT window's line carries the suppressed count
    h.proc.emit('uncaughtException', new Error('re-entry 4'));
    await flush();
    const after = h.lines.filter((l) => l.msg.includes('re-entry'));
    expect(after).toHaveLength(2);
    expect(after[1]!.fields.suppressedSinceLastLine).toBe(2);

    // Close was attempted exactly once for the whole storm.
    expect(h.lines.filter((l) => l.msg.startsWith('fatal: uncaughtException')).length).toBe(1);
    timer.fire();
    expect(h.exits).toEqual([FATAL_EXIT_CODE]);
    h.uninstall();
  });

  it('uninstall removes the listeners (test hygiene contract)', () => {
    const h = harness();
    expect(h.proc.listenerCount('uncaughtException')).toBe(1);
    expect(h.proc.listenerCount('unhandledRejection')).toBe(1);
    h.uninstall();
    expect(h.proc.listenerCount('uncaughtException')).toBe(0);
    expect(h.proc.listenerCount('unhandledRejection')).toBe(0);
  });
});

describe('production wiring — the guards are installed, not just implemented', () => {
  // Anti-façade: a capability nobody calls is the #1 historical defect class.
  // These pins read the REAL entry files so deleting the wiring (while the
  // module and its unit tests stay green) turns this file red.
  const src = (rel: string): string => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

  it('index.ts installs the process guards over the memoized close', () => {
    const index = src('index.ts');
    expect(index).toContain('installProcessGuards({ close: closeOnce })');
    // Both exits stay wired: fatal path non-zero via guards, signal path via shutdown().
    expect(index).toContain("process.on('SIGTERM'");
  });

  it('bootstrap.ts wraps every connection socket BEFORE any handler registration', () => {
    const bootstrap = src('bootstrap.ts');
    const wrapAt = bootstrap.indexOf('wrapSocketHandlers(socket)');
    const firstRegisterAt = bootstrap.indexOf('registerAuthHandlers(socket');
    expect(wrapAt).toBeGreaterThan(-1);
    expect(firstRegisterAt).toBeGreaterThan(-1);
    expect(wrapAt).toBeLessThan(firstRegisterAt); // patch first, register after
  });
});
