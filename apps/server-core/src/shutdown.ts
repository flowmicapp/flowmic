// The ordered stop sequence for a bootstrapped server, and the two helpers it
// leans on. Split out of bootstrap.ts (ledger card J-a) unchanged: bootstrap.ts
// answers "what is wired to what", this file answers "how does this process stop,
// and when it hangs, which step is it stuck in".
//
// SPEC-REF: docs/rebuild/13-LESSONS-LEARNED.md §4 (deploy: bind fail-loud);
//   RV-65 (docs/strategy/2026-07-30-task-package-v1.md).

import type { Server as HttpServer } from 'node:http';
import { log } from './log';

// RV-65 — "the server says it's shutting down, and then it doesn't".
//
// ⚠️ CORRECTION (the lead, 2026-07-31, after this fix was checked against the
// real Node source): the widely-repeated belief that "httpServer.close()'s
// callback only fires once every connection ends — close() itself closes
// nothing" is OUT OF DATE for the Node version this actually ships on. Since
// Node 18.2 (lib/_http_server.js's httpServerPreClose(), confirmed present in
// BOTH the v22.11.0 production runtime and this dev machine's v22.22.3 by
// fetching that exact tagged source), close() ALREADY auto-releases
// GENUINELY IDLE keep-alive sockets by itself, in milliseconds — verified
// empirically: a bare `http.Agent({keepAlive:true})` idle connection closed
// in ~2ms with NO fix applied whatsoever.
// ⇒ **A regression test that only opens an idle keep-alive connection will
// PASS even on the UNFIXED code.** That is a false negative, not proof of a
// fix — this exact mistake was made once while writing shutdown-drain.test.ts
// (the first draft passed red-before-green with no fix present) and was only
// caught because the card required proving red first. Next person: if you are
// about to "verify" a close()-related fix with a plain idle connection, it
// will lie to you.
// The gap that genuinely needs the fix below is a connection with a request
// IN FLIGHT (headers still arriving, or a response not yet `finished`):
// Node's own idle-sweep explicitly skips those
// (`closeIdleConnections()`'s own `!socket._httpMessage.finished` guard), and
// nothing in a stock close() ever forces them or bounds the wait — the
// documented contract is "closes existing connections... finally closed when
// all connections are ended," full stop, no deadline. shutdown-drain.test.ts
// reproduces THAT shape (a raw socket with unterminated HTTP headers), not an
// idle one, and DOES fail on the unfixed code.
//
// ✅ MEASURED IN PRODUCTION, 2026-07-31 11:58 CST (0.2.29 deploy + one
// controlled `systemctl restart` of the FIXED binary). Before: "shutting
// down", 20 s of nothing, `stop-sigterm timed out`, SIGKILL. After: a clean
// exit in 5.0 s, no SIGKILL, all five step lines present — AND the step lines
// named the culprit, which is the half that could not have been guessed:
//     retention.stop            0 ms
//     closeSocket (socket.io)   6 ms   ← NOT the one; it was the main suspect
//     audioRegistry.stopAll     0 ms
//     httpServer close+drain    5001 ms + the forced-close WARN  ← THIS one
//     db.close                  6 ms
// So the hang really is in the httpServer step and really does need a bound:
// something on that server does not drain on its own even now.
// ⚠️ STILL NOT PROVEN, and deliberately left open: WHICH connection that is.
// "a request in flight" is the shape the regression test reproduces and the
// only shape
// Node's own idle-sweep provably cannot touch, but nothing here has identified
// the production one by name. What is proven is narrower and is what matters
// operationally: the wait is now BOUNDED (5 s, not 20 s + SIGKILL) and the
// forced cutoff SAYS SO. "rewriting it a different way and it stopped
// crashing" proves nothing until the trigger is
// reproduced (this repo's written rule, volume-13) — the step lines are what turned the next
// deploy into a measurement instead of a coin flip, and they are why the
// suspect list shrank from four steps to one on the very first run.
//
// SHUTDOWN_GRACE_MS must stay SIGNIFICANTLY below systemd's 20s
// (deploy/flowmic-app.service TimeoutStopSec) — a grace close to it
// reproduces the same SIGKILL with extra steps, not a fix.
export const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Drains httpServer's remaining connections on a bounded budget instead of
 * waiting on them indefinitely. Order (each step only matters for what the
 * previous one left behind):
 *   1. `httpServer.close()` — stops accepting NEW connections; ALSO, as of
 *      the Node version this ships on, sweeps idle ones itself (the plain
 *      nginx-keepalive-with-nothing-in-flight case). This is usually enough
 *      by itself and resolves in milliseconds.
 *   2. `closeIdleConnections()` — called explicitly too, defensively: cheap,
 *      idempotent, and does not depend on close()'s internal sweep timing.
 *   3. A bounded grace window for anything still genuinely mid-request (the
 *      case Node's own idle-sweep cannot touch by definition). If nothing is
 *      left, the close() callback from step 1 fires first and the grace timer
 *      is cancelled — the common path never waits out the grace.
 *   4. At the deadline, `closeAllConnections()` forces every remaining socket
 *      shut — this MAY truncate a genuine in-flight response, which is why it
 *      is the last resort, not the first move — and this is logged (red line:
 *      no silent failure applies to shutdown too: a forced cutoff must say so, not
 *      just quietly proceed).
 */
function closeHttpServerWithGrace(server: HttpServer, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      resolve();
    };
    server.close(() => finish());
    server.closeIdleConnections();
    const graceTimer = setTimeout(() => {
      if (settled) return;
      // Fired ⇒ at least one connection was still open (request in flight,
      // not idle — see the header above) after the grace window — say so
      // BEFORE forcing, since closeAllConnections() itself cannot report
      // which requests it just cut off.
      log.warn('shutdown: connection(s) still open after grace window, forcing close', { graceMs });
      server.closeAllConnections();
      finish();
    }, graceMs);
  });
}

/**
 * RV-65 follow-up (the lead, 2026-07-31): close() is a 4-step sequence and, before
 * this, the ONLY visible trace of a stuck shutdown was "shutting down"
 * followed by silence until systemd's SIGKILL — no way to tell which of the
 * four steps never returned. This wraps each step with a start/done (or
 * start/threw) log pair so a stuck shutdown's LAST log line names the exact
 * step it never left. This is deliberately NOT a guess at which step is
 * guilty — see the correction above SHUTDOWN_GRACE_MS: we have only proven
 * what did NOT hang production (a plain idle connection), not what did. The
 * next production SIGTERM either logs all five "done" lines, or its last
 * line is the answer.
 */
async function announceShutdownStep<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const startedAt = Date.now();
  log.info('shutdown: step start', { step: name });
  try {
    const result = await fn();
    log.info('shutdown: step done', { step: name, ms: Date.now() - startedAt });
    return result;
  } catch (err) {
    log.error('shutdown: step threw', {
      step: name,
      ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Everything close() has to stop, in the order it has to stop them. Each field
 *  is the live object bootstrap already holds — this interface exists to name the
 *  list, not to widen it. */
export interface ShutdownSteps {
  retention: { stop(): void };
  /** W-5a (REQ-13-03) — the status probe timer. Same shape and same reason as
   *  `retention`: a live interval keeps the process (and the tests) alive, and a
   *  tick that fired mid-teardown would open a provider session while we are
   *  closing. Disarmed FIRST, beside retention, for exactly that reason. */
  statusProbes: { stop(): void };
  closeSocket: () => Promise<void> | void;
  audioRegistry: { stopAll(): void };
  httpServer: HttpServer;
  db: { close(): void };
}

/** THE ordered stop sequence. One list, one order, one owner. */
export function makeShutdownSequence(steps: ShutdownSteps): () => Promise<void> {
  const { retention, statusProbes, closeSocket, audioRegistry, httpServer, db } = steps;
  return async (): Promise<void> => {
    // GA-06: disarm the sweep FIRST — a tick that fired after db.close() would
    // hit dead statements, and a live 24h timer would keep the process alive.
    await announceShutdownStep('retention.stop', () => retention.stop());
    // W-5a: the same argument, one line later. This timer touches no DB, so its
    // order relative to `retention` is free; it is here rather than at the end so
    // that BOTH timers are dead before anything starts closing.
    await announceShutdownStep('statusProbes.stop', () => statusProbes.stop());
    // socket.io is mounted on this SAME httpServer (createSocketServer) —
    // its close() (io.disconnectSockets(true) + engine.close()) is a
    // SEPARATE drain from the httpServer step below, not a subset of it.
    // If socket.io is what actually hangs in production, the httpServer
    // fix below never even gets a turn — this step's own start/done pair
    // is what would show that, not the httpServer step's warn line.
    await announceShutdownStep('closeSocket (socket.io)', () => closeSocket());
    // GA-04: closing the socket server fires every disconnect, which arms a
    // grace window per paired mobile. Disarm them AFTER that (a live 30 s
    // timer would hold the process — and the tests — open) and dispose the
    // engines they were holding.
    await announceShutdownStep('audioRegistry.stopAll', () => audioRegistry.stopAll());
    await announceShutdownStep('httpServer close+drain', () => closeHttpServerWithGrace(httpServer, SHUTDOWN_GRACE_MS));
    await announceShutdownStep('db.close', () => db.close());
  };
}
