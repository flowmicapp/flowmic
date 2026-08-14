// WP-R23-1 — 4-digit pairing-code brute-force guard.
//
// Two layers exercised here:
//   • deterministic unit tests over PairRateLimiter with an injected clock
//     (per-socket backoff curve, success reset, per-IP window + drain);
//   • real-server integration (in-process socket.io) proving the wiring:
//     a normal pair is never throttled, a single socket spraying wrong codes is
//     locked out after the free budget, and a many-socket single-IP spray trips
//     the IP cap — every rejection an honest PAIR_RATE_LIMITED (never disguised
//     as PAIR_INVALID_CODE).
//
// 🔴 C2 (2026-08-05) — WHAT THE IT-25 BLOCK BELOW DOES AND DOES NOT CLAIM.
// The shipped IT-25 commit justified lock-aware eviction with a threat model
// ("spraying throwaway sockets would unlock a throttled socket") and a guarantee
// ("can never hand a throttled socket a fresh budget"). Both were measured false:
// the disconnect edge already resets a socket for one reconnect, and evicting a
// LAPSED entry destroys its escalation ladder. The tests here are deliberately
// named for the narrow properties that survived measurement, and two of them pin
// the FALSIFIED half on purpose — a test named for a guarantee the code does not
// have is worse than no test, because the next reader stops checking.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import {
  PairRateLimiter,
  PAIR_SOCKET_FREE_ATTEMPTS,
  PAIR_SOCKET_BACKOFF_BASE_MS,
  PAIR_SOCKET_BACKOFF_CAP_MS,
  PAIR_SOCKET_MAX_KEYS,
  PAIR_SOCKET_DROP_WARN_MS,
  PAIR_IP_WINDOW_MS,
  PAIR_IP_MAX_FAILURES,
  PAIR_IP_MAX_KEYS,
} from '../src/room/pair-rate-limit';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

describe('PairRateLimiter (unit, injected clock)', () => {
  it('lets a normal pairing through — a handful of attempts stay allowed', () => {
    let t = 1_000;
    const lim = new PairRateLimiter({ now: () => t });
    // 4 misses (< free budget) never lock the socket.
    for (let i = 0; i < PAIR_SOCKET_FREE_ATTEMPTS - 1; i++) {
      expect(lim.check('sock', '1.2.3.4').allowed).toBe(true);
      lim.recordFailure('sock', '1.2.3.4');
      t += 100;
    }
    expect(lim.check('sock', '1.2.3.4').allowed).toBe(true);
  });

  it('locks the socket with exponential backoff after the free budget', () => {
    let t = 0;
    const lim = new PairRateLimiter({ now: () => t });
    // Burn the free attempts; each stays allowed at the point of attempt.
    for (let i = 0; i < PAIR_SOCKET_FREE_ATTEMPTS; i++) {
      expect(lim.check('s', 'ip').allowed).toBe(true);
      lim.recordFailure('s', 'ip');
    }
    // The Nth failure (== free budget) arms the first backoff step (base·2^0).
    const d1 = lim.check('s', 'ip');
    expect(d1.allowed).toBe(false);
    expect(d1.retryAfterMs).toBe(PAIR_SOCKET_BACKOFF_BASE_MS);

    // After the lock elapses, one more miss doubles the backoff.
    t += PAIR_SOCKET_BACKOFF_BASE_MS;
    expect(lim.check('s', 'ip').allowed).toBe(true);
    lim.recordFailure('s', 'ip');
    expect(lim.check('s', 'ip').retryAfterMs).toBe(PAIR_SOCKET_BACKOFF_BASE_MS * 2);
  });

  it('caps the per-socket backoff', () => {
    let t = 0;
    const lim = new PairRateLimiter({ now: () => t });
    // Accumulate many misses, clearing each prior lock by advancing time, so the
    // failure counter climbs well past the cap's doubling threshold.
    for (let i = 0; i < PAIR_SOCKET_FREE_ATTEMPTS + 20; i++) {
      t += PAIR_SOCKET_BACKOFF_CAP_MS; // step past any prior lock first
      lim.recordFailure('s', 'ip');
    }
    // Assert the freshly-armed lock (measured from the last failure, same instant).
    expect(lim.check('s', 'ip').retryAfterMs).toBe(PAIR_SOCKET_BACKOFF_CAP_MS);
  });

  it('resets the socket on a successful pair', () => {
    let t = 0;
    const lim = new PairRateLimiter({ now: () => t });
    for (let i = 0; i < PAIR_SOCKET_FREE_ATTEMPTS; i++) lim.recordFailure('s', 'ip');
    expect(lim.check('s', 'ip').allowed).toBe(false);
    lim.recordSuccess('s');
    expect(lim.check('s', 'ip').allowed).toBe(true);
  });

  it('caps per-IP failures within the window even across sockets', () => {
    let t = 0;
    const lim = new PairRateLimiter({ now: () => t });
    // Spread one failure across many DISTINCT sockets so no socket ever locks —
    // only the IP axis is under test.
    for (let i = 0; i < PAIR_IP_MAX_FAILURES; i++) {
      const sid = `s${i}`;
      expect(lim.check(sid, 'shared-ip').allowed).toBe(true);
      lim.recordFailure(sid, 'shared-ip');
      t += 10;
    }
    // A fresh socket from the same IP is now blocked purely by the IP window.
    const d = lim.check('fresh', 'shared-ip');
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBeGreaterThan(0);
    // A different IP is unaffected.
    expect(lim.check('fresh', 'other-ip').allowed).toBe(true);
  });

  it('drains the per-IP window as failures age out', () => {
    let t = 0;
    const lim = new PairRateLimiter({ now: () => t });
    for (let i = 0; i < PAIR_IP_MAX_FAILURES; i++) {
      lim.recordFailure(`s${i}`, 'ip');
    }
    expect(lim.check('fresh', 'ip').allowed).toBe(false);
    // Once the whole window has passed, the IP is clean again.
    t += PAIR_IP_WINDOW_MS + 1;
    expect(lim.check('fresh', 'ip').allowed).toBe(true);
  });

  // IT-08 — IP-table bound (DiagUploadThrottle / DIAG_MAX_KEYS shape).
  it('POSITIVE CONTROL: ordinary per-IP failure window still refuses after PAIR_IP_MAX_FAILURES', () => {
    let t = 0;
    const lim = new PairRateLimiter({ now: () => t });
    for (let i = 0; i < PAIR_IP_MAX_FAILURES; i++) {
      const sid = `pos-${i}`;
      expect(lim.check(sid, 'shared-ip').allowed).toBe(true);
      lim.recordFailure(sid, 'shared-ip');
      t += 10;
    }
    const denied = lim.check('pos-fresh', 'shared-ip');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(lim.check('pos-fresh', 'other-ip').allowed).toBe(true);
  });

  it('enforces the IP key cap via oldest-first eviction (PAIR_IP_MAX_KEYS shape)', () => {
    const maxKeys = 4;
    const lim = new PairRateLimiter({
      now: () => 1_000,
      maxKeys,
      ipMaxFailures: 2,
      // Keep socket backoff out of the way — one failure per socket.
      socketFreeAttempts: 100,
    });
    lim.recordFailure('sv0', 'victim');
    lim.recordFailure('sv1', 'victim');
    expect(lim.check('sv2', 'victim').allowed).toBe(false);

    for (let i = 0; i < maxKeys - 1; i++) {
      lim.recordFailure(`sf${i}`, `flood-${i}`);
    }
    expect(lim.check('sv3', 'victim').allowed).toBe(false);

    lim.recordFailure(`sf${maxKeys - 1}`, `flood-${maxKeys - 1}`);
    expect(lim.check('sv4', 'victim').allowed).toBe(true);
    expect(PAIR_IP_MAX_KEYS).toBe(512);
  });

  it('a swept expired IP key behaves as a fresh IP (not a lingering denial)', () => {
    let t = 0;
    const lim = new PairRateLimiter({
      now: () => t,
      ipMaxFailures: 2,
      socketFreeAttempts: 100,
    });
    lim.recordFailure('s0', 'stale');
    lim.recordFailure('s1', 'stale');
    expect(lim.check('s2', 'stale').allowed).toBe(false);
    t += PAIR_IP_WINDOW_MS + 1;
    expect(lim.check('s3', 'stale').allowed).toBe(true);
    lim.recordFailure('s4', 'stale');
    expect(lim.check('s5', 'stale').allowed).toBe(true);
  });

  it('sweep clears a full table of stale IP keys so a live IP is not evicted by ghosts', () => {
    let t = 0;
    const maxKeys = 4;
    const lim = new PairRateLimiter({
      now: () => t,
      maxKeys,
      ipMaxFailures: 2,
      socketFreeAttempts: 100,
    });
    for (let i = 0; i < maxKeys; i++) lim.recordFailure(`ss${i}`, `stale-${i}`);
    lim.recordFailure('sl0', 'live');
    lim.recordFailure('sl1', 'live');
    t += PAIR_IP_WINDOW_MS + 1;
    lim.recordFailure('sl2', 'live');
    lim.recordFailure('sl3', 'live');
    expect(lim.check('sl4', 'live').allowed).toBe(false);
    for (let i = 0; i < maxKeys - 1; i++) lim.recordFailure(`so${i}`, `other-${i}`);
    expect(lim.check('sl5', 'live').allowed).toBe(false);
    expect(lim.check('sx', 'stale-0').allowed).toBe(true);
  });

  // IT-25 — sockets-table bound. IT-08 capped the IP table (PAIR_IP_MAX_KEYS,
  // above) but missed this one: one entry per socket that ever failed a pair
  // attempt, never expiring, and opening a socket.io connection to add an
  // entry costs an unauthenticated caller nothing.
  it('IT-25 POSITIVE CONTROL: bounds the sockets table — pushing past the cap never grows it further', () => {
    const socketMaxKeys = 4;
    let t = 0;
    const lim = new PairRateLimiter({
      now: () => t,
      socketMaxKeys,
      socketFreeAttempts: 100, // keep every entry unlocked so eviction always finds a victim
    });
    for (let i = 0; i < socketMaxKeys + 20; i++) {
      lim.recordFailure(`s${i}`, `ip${i}`);
      expect(lim.socketTableSize).toBeLessThanOrEqual(socketMaxKeys);
    }
    expect(lim.socketTableSize).toBe(socketMaxKeys);
    expect(PAIR_SOCKET_MAX_KEYS).toBe(512);
  });

  // IT-25 — the assertion that actually matters, and the ONLY guarantee the
  // eviction policy makes: A LIVE LOCK IS NEVER CUT SHORT. A size bound alone
  // would pass on an implementation that evicts the wrong entry, because this
  // table holds live backoff locks and not merely a count — an eviction of a
  // locked entry would make housekeeping retract a refusal the limiter is
  // issuing at that very moment.
  //
  // ⚠️ Read the scope narrowly, deliberately. This does NOT prove the limiter
  // is un-resettable by an attacker (it is trivially resettable — see "not an
  // attacker bound" below), and it does NOT protect the escalation ladder (see
  // "RESIDUAL" below, which pins the opposite). Naming it more broadly than
  // this is how the shipped claim came to overstate itself.
  //
  // Reverse control (C2, run 2026-08-05): changing the predicate in
  // evictOneUnlockedSocket to ignore lockedUntil turns this test red on the
  // first flood iteration; restored, green.
  it('IT-25 a LIVE lock is never cut short — flooding new sockets cannot evict a locked entry', () => {
    let t = 1_000;
    const socketMaxKeys = 3;
    const lim = new PairRateLimiter({
      now: () => t,
      socketMaxKeys,
      socketFreeAttempts: 2, // lock fast
    });
    // Lock 'victim' FIRST, so it is the OLDEST entry in the table — the one
    // naive "always evict oldest" (the IP-table shape) would pick first.
    lim.recordFailure('victim', 'ip-victim');
    lim.recordFailure('victim', 'ip-victim');
    expect(lim.check('victim', 'ip-victim').allowed).toBe(false);

    // Flood brand-new sockets, each failing only ONCE so it never locks itself
    // and is always an eligible (unlocked) eviction victim — the shape most
    // likely to dislodge the victim. ⚠️ Not "the cheapest attack": resetting
    // this layer costs one reconnect, no flood required (see the "NOT the
    // attacker bound" test). This measures pressure on the table, not an
    // adversary's best move. Push far past socketMaxKeys.
    for (let i = 0; i < socketMaxKeys * 10; i++) {
      lim.recordFailure(`attacker-${i}`, `ip-attacker-${i}`);
      // Checked on EVERY iteration, not just at the end — a bug could evict
      // the victim transiently and reinsert it unlocked.
      expect(lim.check('victim', 'ip-victim').allowed).toBe(false);
    }
    expect(lim.socketTableSize).toBeLessThanOrEqual(socketMaxKeys);
  });

  // IT-25 RESIDUAL — the half the eviction predicate does NOT protect, pinned so
  // nobody reads the guarantee above as broader than it is.
  //
  // `evictOneUnlockedSocket` tests `now >= lockedUntil`: it protects the LOCK.
  // The next backoff step is computed from `failures`, and a lapsed entry is an
  // ordinary eviction candidate that leaves carrying its whole accumulated
  // count. So a flood CAN reset an escalation ladder — it just cannot cut a live
  // lock short.
  //
  // This test exists because the shipped commit message claimed the table "can
  // never hand a throttled socket a fresh budget". Measured here: it can, once
  // the lock has elapsed. The paired CONTROL is what makes the number mean
  // something — without it, "next lock = 0" could just be a mis-set-up socket.
  it('IT-25 RESIDUAL (measured, documented): evicting a LAPSED entry does reset the escalation ladder', () => {
    const escalate = (lim: PairRateLimiter, tick: () => void): void => {
      // Climb well past the doubling threshold so the next step is pinned at the
      // cap; step past each armed lock so every failure is actually recorded.
      for (let i = 0; i < 12; i++) {
        tick();
        lim.recordFailure('victim', 'ip-victim');
      }
    };

    // ── CONTROL: same ladder, NO flood. The entry survives, so the next miss
    //    after the lock elapses re-arms at the cap.
    let tc = 1_000;
    const control = new PairRateLimiter({
      now: () => tc,
      socketMaxKeys: 3,
      socketFreeAttempts: 2,
      ipMaxFailures: 1_000_000, // isolate the socket axis
    });
    escalate(control, () => { tc += PAIR_SOCKET_BACKOFF_CAP_MS + 1; });
    expect(control.check('victim', 'ip-victim').retryAfterMs).toBe(PAIR_SOCKET_BACKOFF_CAP_MS);
    tc += PAIR_SOCKET_BACKOFF_CAP_MS + 1; // let the live lock elapse
    expect(control.check('victim', 'ip-victim').allowed).toBe(true);
    control.recordFailure('victim', 'ip-victim');
    expect(control.check('victim', 'ip-victim').retryAfterMs).toBe(PAIR_SOCKET_BACKOFF_CAP_MS);

    // ── MEASUREMENT: identical, then flood throwaway sockets while the victim's
    //    lock is LAPSED. Each flood socket fails once so it never locks itself.
    let t = 1_000;
    const lim = new PairRateLimiter({
      now: () => t,
      socketMaxKeys: 3,
      socketFreeAttempts: 2,
      ipMaxFailures: 1_000_000,
    });
    escalate(lim, () => { t += PAIR_SOCKET_BACKOFF_CAP_MS + 1; });
    expect(lim.check('victim', 'ip-victim').retryAfterMs).toBe(PAIR_SOCKET_BACKOFF_CAP_MS);
    t += PAIR_SOCKET_BACKOFF_CAP_MS + 1;
    for (let i = 0; i < 30; i++) lim.recordFailure(`flood-${i}`, `ip-flood-${i}`);

    lim.recordFailure('victim', 'ip-victim');
    // The ladder is gone: this reads as the victim's FIRST miss, still inside a
    // restored free budget. Control said 30 000 at this exact point.
    expect(lim.check('victim', 'ip-victim').retryAfterMs).toBe(0);
    expect(lim.check('victim', 'ip-victim').allowed).toBe(true);
  });

  // IT-25 — the framing correction. The per-socket table is NOT an anti-attacker
  // control; capping it did not make it one. The production disconnect edge
  // deletes the entry outright (grep `pairLimiter.forget` →
  // src/socket/handlers/mobile.handler.ts) and a reconnect arrives with a fresh
  // socket.id, so this layer is reset for the price of one reconnect — cheaper
  // than any table manipulation. Both halves are asserted together on purpose:
  // the second is what makes the first safe to state out loud.
  it('IT-25 the sockets table is NOT the attacker bound — the per-IP window is', () => {
    const spray = (lim: PairRateLimiter): number => {
      let allowed = 0;
      for (let i = 0; i < 100; i++) {
        const sid = `sock-${i}`; // a reconnect mints a brand-new socket id
        if (lim.check(sid, '9.9.9.9').allowed) allowed++;
        lim.recordFailure(sid, '9.9.9.9');
        lim.forget(sid); // the disconnect edge, verbatim
      }
      return allowed;
    };

    // With ONLY the per-socket layer live, socket rotation defeats it entirely.
    let t = 0;
    const socketOnly = new PairRateLimiter({ now: () => t, ipMaxFailures: 1_000_000 });
    expect(spray(socketOnly)).toBe(100);

    // With the real config, the per-IP window is what actually binds — and it
    // binds at exactly its configured budget.
    t = 0;
    const real = new PairRateLimiter({ now: () => t });
    expect(spray(real)).toBe(PAIR_IP_MAX_FAILURES);
  });

  // IT-25 — evidence for the state the cap introduced. When the table is full
  // and every entry is live-locked, `recordFailure` cannot record at the socket
  // layer. That is defensible; being INVISIBLE is not. Two surfaces, and the
  // positive control below proves neither fires in the ordinary case.
  it('IT-25 a failure dropped at the socket layer is counted, and the per-IP layer still binds', () => {
    let t = 1_000;
    const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const lim = new PairRateLimiter({
      now: () => t,
      socketMaxKeys: 2,
      socketFreeAttempts: 1, // lock on the first miss
      ipMaxFailures: 3,
      warn: (msg, fields) => lines.push({ msg, fields }),
    });
    // Fill the table with entries that are ALL under a live lock.
    lim.recordFailure('locked-a', 'ip-a');
    lim.recordFailure('locked-b', 'ip-b');
    expect(lim.check('locked-a', 'ip-a').allowed).toBe(false);
    expect(lim.check('locked-b', 'ip-b').allowed).toBe(false);
    expect(lim.droppedFailureCount).toBe(0); // nothing dropped yet

    // Newcomers now cannot be recorded at the socket layer.
    for (let i = 0; i < 3; i++) lim.recordFailure(`drop-${i}`, 'attacker-ip');
    expect(lim.socketTableSize).toBe(2);
    expect(lim.droppedFailureCount).toBe(3);
    // ...but the per-IP window was stamped every single time, so the attempts
    // were never un-limited — only untracked at one layer.
    expect(lim.check('probe', 'attacker-ip').allowed).toBe(false);
  });

  it('IT-25 POSITIVE CONTROL: the drop counter and warning stay silent on the ordinary path', () => {
    let t = 0;
    const lines: string[] = [];
    const lim = new PairRateLimiter({
      now: () => t,
      socketMaxKeys: 4,
      socketFreeAttempts: 100, // every entry stays unlocked → eviction always succeeds
      warn: (msg) => lines.push(msg),
    });
    for (let i = 0; i < 50; i++) {
      lim.recordFailure(`s${i}`, `ip${i}`);
      t += 1;
    }
    expect(lim.socketTableSize).toBe(4);
    expect(lim.droppedFailureCount).toBe(0);
    expect(lines).toEqual([]);
  });

  // IT-25 — the warning must be BOUNDED, not per-request. Commit 2da57f0 removed
  // exactly this amplifier once already (a sync log append per refusal), and
  // diag-routes.ts's shouldWarnOnceForWindow is the established idiom. A flood is
  // precisely the condition under which this branch fires, so a line per dropped
  // failure would turn an attack into disk work.
  //
  // Reverse control (C2, run 2026-08-05): dropping the
  // `now - lastWarnAt >= PAIR_SOCKET_DROP_WARN_MS` budget so every drop logs
  // turns this test red (25 lines vs 1); restored, green.
  it('IT-25 the saturation warning is rate-budgeted, and carries the count the budget suppresses', () => {
    let t = 1_000;
    const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const lim = new PairRateLimiter({
      now: () => t,
      socketMaxKeys: 2,
      socketFreeAttempts: 1,
      // The locks must outlive the WARNING budget, or the second half of this
      // test would be measuring eviction rather than the log budget.
      socketBackoffBaseMs: PAIR_SOCKET_DROP_WARN_MS * 10,
      socketBackoffCapMs: PAIR_SOCKET_DROP_WARN_MS * 10,
      ipMaxFailures: 1_000_000, // isolate the socket axis
      warn: (msg, fields) => lines.push({ msg, fields }),
    });
    lim.recordFailure('locked-a', 'ip-a');
    lim.recordFailure('locked-b', 'ip-b');

    // 25 drops inside ONE budget window ⇒ exactly one line.
    for (let i = 0; i < 25; i++) {
      lim.recordFailure(`drop-${i}`, 'attacker-ip');
      t += 10; // well inside PAIR_SOCKET_DROP_WARN_MS
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe('pair_rate_limit.socket_table_saturated');
    expect(lines[0]?.fields?.dropped_total).toBe(1);
    expect(lim.droppedFailureCount).toBe(25);

    // Past the budget the next drop reports again — and the line accounts for
    // everything the budget swallowed, so bounding the lines never loses the
    // magnitude.
    t += PAIR_SOCKET_DROP_WARN_MS;
    // The locks must still be live, or the drop path would not be reached.
    expect(lim.check('locked-a', 'ip-a').allowed).toBe(false);
    lim.recordFailure('drop-late', 'attacker-ip');
    expect(lines).toHaveLength(2);
    expect(lines[1]?.fields?.dropped_since_last_line).toBe(25);
    expect(lines[1]?.fields?.dropped_total).toBe(26);
  });
});

// ── real-server wiring ──────────────────────────────────────────────────────
describe('mobile:pair rate limit (real server)', () => {
  let server: BootstrapHandle;
  let url: string;
  const sockets: ClientSocket[] = [];

  function connect(): Promise<ClientSocket> {
    const s = ioClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(s);
    return new Promise((resolve, reject) => {
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('connect timeout')), 3000);
    });
  }

  function ack<T = Record<string, unknown>>(s: ClientSocket, event: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), 3000);
      s.emit(event, payload, (res: T) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  async function registerPc(name: string, inst: string): Promise<string> {
    const pc = await connect();
    const reg = await ack<{ short_code?: string }>(pc, 'pc:register', { device_name: name, client_instance_id: inst });
    if (!reg.short_code) throw new Error('pc:register returned no short_code');
    return reg.short_code;
  }

  /** A code guaranteed NOT to be the active one (so the resolve misses). */
  function wrongCode(active: string): string {
    const n = (Number(active) + 1) % 10000;
    return String(n).padStart(4, '0');
  }

  beforeAll(async () => {
    // Own server instance → the in-memory limiter starts clean, no cross-file
    // IP-window bleed.
    const config = loadConfig({ port: 0, dbPath: ':memory:', secret: 'pair-rate-limit-secret-32-bytes-long!!' });
    server = await startServer(config);
    url = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await server.close();
  });

  it('never throttles a legitimate first pairing', async () => {
    const code = await registerPc('PC-normal', 'inst-normal-0000000000000000');
    const mobile = await connect();
    const res = await ack<Record<string, unknown>>(mobile, 'mobile:pair', { short_code: code });
    expect(res.error).toBeUndefined();
    expect(res.mobile_token).toBeTruthy();
  });

  it('locks a single socket after the free budget, then a fresh phone still pairs', async () => {
    const code = await registerPc('PC-backoff', 'inst-backoff-000000000000000');
    const bad = wrongCode(code);
    const attacker = await connect();

    // The free budget of misses each fail HONESTLY with PAIR_INVALID_CODE.
    for (let i = 0; i < PAIR_SOCKET_FREE_ATTEMPTS; i++) {
      const r = await ack<Record<string, unknown>>(attacker, 'mobile:pair', { short_code: bad });
      expect(r.error).toBe('PAIR_INVALID_CODE');
    }
    // The next attempt on the SAME socket is throttled — distinct code.
    const throttled = await ack<Record<string, unknown>>(attacker, 'mobile:pair', { short_code: bad });
    expect(throttled.error).toBe('PAIR_RATE_LIMITED');
    expect(typeof throttled.retry_after_ms).toBe('number');

    // A different phone with the RIGHT code is unaffected (normal path intact).
    const good = await connect();
    const ok = await ack<Record<string, unknown>>(good, 'mobile:pair', { short_code: code });
    expect(ok.error).toBeUndefined();
    expect(ok.mobile_token).toBeTruthy();
  });

  it('trips the per-IP cap across many sockets from one host', async () => {
    // Fresh code; spread wrong guesses across DISTINCT sockets so the per-socket
    // backoff never fires — only the shared-IP window is exercised.
    const code = await registerPc('PC-ip', 'inst-ip-cap-00000000000000000');
    const bad = wrongCode(code);
    // The prior test already put failures on this IP; keep pushing across new
    // sockets until a fresh socket is IP-blocked before its own free budget.
    let blocked = false;
    for (let i = 0; i < PAIR_IP_MAX_FAILURES + 5 && !blocked; i++) {
      const s = await connect();
      const r = await ack<Record<string, unknown>>(s, 'mobile:pair', { short_code: bad });
      if (r.error === 'PAIR_RATE_LIMITED') blocked = true;
    }
    expect(blocked).toBe(true);
  });
});
