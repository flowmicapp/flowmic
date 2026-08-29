// scripts/loadtest/lib/target-guard.mjs
//
// NR-5 / S0a (docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md item 7):
// "S0a presses the relay's OWN ceiling — do not hit the upstream vendors, and
// this tool must never be pointed at production." This module is the one place
// that decision is enforced in code, so a caller cannot quietly bypass it by
// constructing a URL somewhere else in the harness.
//
// Default target is loopback ONLY. A caller that wants to point this tool at a
// host that is not the local machine must say so explicitly, every time
// (`--i-know-this-is-not-production`) — there is no config file or env var that
// can carry that consent forward, on purpose: a stale flag in a saved script is
// exactly how a load generator ends up aimed at the production relay by accident.

/** Thrown by name so a caller (and a human reading a crash) can tell this was a
 *  deliberate refusal, not a network error. */
export class NonLoopbackTargetRefusedError extends Error {
  constructor(host) {
    super(
      `refusing to load-test host "${host}" — it is not loopback. `
      + 'This tool defaults to 127.0.0.1 and must never be pointed at a remote '
      + 'host (production or otherwise) without explicit, per-run consent. '
      + 'Pass --i-know-this-is-not-production if you really mean this.',
    );
    this.name = 'NonLoopbackTargetRefusedError';
    this.host = host;
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1', '[::1]']);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host).toLowerCase());
}

/** Throws NonLoopbackTargetRefusedError unless `host` is loopback or the caller
 *  passed the explicit override. Called once, at CLI-arg-resolution time —
 *  never re-derived later from state that could have drifted. */
export function assertTargetAllowed(host, { allowNonLoopback = false } = {}) {
  if (isLoopbackHost(host)) return;
  if (allowNonLoopback) return;
  throw new NonLoopbackTargetRefusedError(host);
}
