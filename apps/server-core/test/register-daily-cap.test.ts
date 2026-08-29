// Card NR-2a item 3 — the ANTI-ABUSE FLOOR under free managed-STT quota.
//
// SPEC-REF:
//   docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md item 3 — owner,
//     verbatim: 「会不会出现狂刷邮箱来套取免费额度的情况，因为免费额度对于运营者
//     来说也是有成本的」
//   docs/decisions/2026-08-27-owner-web-rulings-batch-2.md item 4 — the number
//     itself, ruled: 「同一 IP 或同一来源指纹（需要思考如何获取）每天最多注册 2
//     个账号」. It was 10 (first-responsible) until that ruling; every assertion
//     below reads REGISTER_MAX_PER_DAY rather than a literal, so the change
//     moved one constant and nothing else.
//   src/auth/register-rate-limit.ts REGISTER_MAX_PER_DAY (the whole argument for
//     why the existing 5/10-min brake cannot answer this)
//   src/http/auth-routes.ts (the two call sites + the file-head enumeration of
//     what was DELIBERATELY NOT built)
//   docs/strategy/2026-08-25-unregistered-trial-allowance-design.md §6 — the
//     precedent for the shape: a cheap, greppable record beats an unauditable
//     mechanism
//
// ⚠️ WHAT THIS FILE DOES NOT CLAIM. Neither the cap nor the log line stops an
// adversary who rotates source addresses; nothing here pretends otherwise (the
// constant's own doc says so). What they buy is a price and a receipt.
//
// *** HUMAN-AUDIT SENSITIVE (auth/rate-limit) ***

// ── 🔴 WHY THESE IMPORTS ARE STATIC, WHICH IS A TIMING FACT AND NOT A STYLE ──
// The last test in this file boots a REAL server, so it needs `startServer`.
// It first reached for it with `await import('../src/bootstrap')` INSIDE the
// test body, and that is a 5-second bug with a 3.5-second fuse.
//
// MEASURED (2026-08-27, dev-pc-a): the dynamic import ALONE costs **3516 ms**
// — vitest transforms bootstrap's entire module graph at that moment — while
// the boot and the HTTP round trip it was written to measure cost ~175 ms
// together. vitest's default `testTimeout` is 5000 ms and it covers the test
// BODY, so 70% of the budget was being spent loading modules. On an idle
// machine that passes; inside `pnpm verify:delivery`, where this stage runs
// after cargo and the goldens and shares the box with other workers, it does
// not — acceptance saw it time out.
//
// A static import moves the identical work into vitest's COLLECT phase, which
// no per-test timeout covers, and which every other server-booting test file in
// this suite has always used. The measurement below therefore times what it
// claims to time.
//
// ⚠️ THE GENERAL SHAPE, because this file is not special: a test that loads its
// subject inside its own body is charging module-transform time to a deadline
// meant for behaviour — and it fails first on the slowest machine, i.e. never
// on the one that wrote it. Same class as the deadline note in
// test/coupling-replay.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { log } from '../src/log';
import {
  RegisterRateLimiter,
  REGISTER_DAY_WINDOW_MS,
  REGISTER_MAX_ATTEMPTS,
  REGISTER_MAX_PER_DAY,
  makeAuthRateLimiters,
  resolveRegisterDailyCap,
} from '../src/auth/register-rate-limit';

/** Held outside the test so teardown runs even when the test never reaches its
 *  own cleanup. The `finally` this replaces could not: a vitest timeout ABORTS
 *  the body, so a timed-out run used to leak both a listening port and a
 *  globally mocked `log.info` into whatever ran next in this worker. */
let server: BootstrapHandle | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await server.close();
  server = null;
});

describe('the anti-abuse floor: a daily cap on account mints', () => {
  it('🔴 a rate limit cannot bound a total — the DAY window is a second, separate counter', () => {
    let t = Date.parse('2026-09-01T00:00:00.000Z');
    const daily = new RegisterRateLimiter({
      now: () => t,
      windowMs: REGISTER_DAY_WINDOW_MS,
      maxAttempts: REGISTER_MAX_PER_DAY,
    });
    // A full day's budget, spent slowly enough that the 5/10-min BURST brake
    // would have allowed every single one of them — which is the whole point:
    // the burst brake bounds a rate and this bounds a total.
    for (let i = 0; i < REGISTER_MAX_PER_DAY; i++) {
      expect(daily.check('1.2.3.4').allowed, `mint ${i + 1}`).toBe(true);
      daily.record('1.2.3.4');
      t += 20 * 60 * 1000;
    }
    const over = daily.check('1.2.3.4');
    expect(over.allowed).toBe(false);
    expect(over.retryAfterMs).toBeGreaterThan(0);

    // Another address is untouched: the cap is per-IP, and it says so.
    expect(daily.check('5.6.7.8').allowed).toBe(true);

    // The window really slides: a day after the FIRST mint, one slot opens.
    t = Date.parse('2026-09-01T00:00:00.000Z') + REGISTER_DAY_WINDOW_MS + 1;
    expect(daily.check('1.2.3.4').allowed).toBe(true);
  });

  it('the two limiters are separate instances — a spent day budget is not a spent login budget', () => {
    // The wiring assertion for that lives in bootstrap; what this pins is the
    // property that makes the wiring worth having: two counters, two answers.
    const burst = new RegisterRateLimiter({ now: () => 0 });
    const daily = new RegisterRateLimiter({ now: () => 0, windowMs: REGISTER_DAY_WINDOW_MS, maxAttempts: REGISTER_MAX_PER_DAY });
    for (let i = 0; i < REGISTER_MAX_PER_DAY; i++) daily.record('1.2.3.4');
    expect(daily.check('1.2.3.4').allowed).toBe(false);
    expect(burst.check('1.2.3.4').allowed).toBe(true);
  });
});

describe('FLOWMIC_REGISTER_DAILY_CAP: a harness seam that cannot become a bypass', () => {
  // 🔴 WHY THIS SEAM EXISTS AT ALL, pinned here rather than left to the comment
  // in the source: the golden suite dials LOOPBACK, so every account it creates
  // shares one address bucket, and several cases mint three or more by design.
  // At the owner's cap of 2 those cases could not build their own fixture —
  // measured, 2026-08-27: G17 and G18 failed with
  // `429 REGISTER_RATE_LIMITED, retry_after_ms 86399843`.
  //
  // The three properties below are what keep that from becoming a way to turn
  // the ruling off. The FIRST one is the load-bearing one.
  //
  // ── 🔴 REVERSE CONTROL — run red once, then reverted (2026-08-27) ─────────
  // `resolveRegisterDailyCap` was made to ignore its argument (`const raw = '';`,
  // drill-marked DRILL-DAILYCAP-ENV), i.e. the seam existed as a function and
  // reached nothing. Red output:
  //
  //   FAIL … > a raised value really raises the budget, and only that budget
  //   AssertionError: the override did not reach the mint limiter: expected
  //     false to be true
  //   FAIL … > 🔴 junk NEVER disables the cap — it falls back to 2 and says so
  //   AssertionError: a typo that silently keeps the default is a typo nobody
  //     finds: expected +0 to be 7
  //   Tests  2 failed | 4 passed (6)
  //
  // ⚠️ THE DEFAULT TEST STAYED GREEN THROUGHOUT, which is the point of running
  // this: a resolver that ignores the environment entirely still satisfies
  // 「the default is 2」. Pinning only that would have been a green suite over a
  // dead seam — and the symptom would have surfaced as G17/G18 still failing,
  // three minutes away in a different command.
  // Drill reverted, 6/6 green, residue grep for DRILL-DAILYCAP-ENV = 0.
  it('🔴 the DEFAULT is the owner-ruled 2 — an absent variable changes nothing', () => {
    expect(REGISTER_MAX_PER_DAY, 'the owner-ruled number itself moved').toBe(2);
    expect(resolveRegisterDailyCap({})).toBe(REGISTER_MAX_PER_DAY);
    expect(resolveRegisterDailyCap({ FLOWMIC_REGISTER_DAILY_CAP: '' })).toBe(REGISTER_MAX_PER_DAY);
    expect(resolveRegisterDailyCap({ FLOWMIC_REGISTER_DAILY_CAP: '   ' })).toBe(REGISTER_MAX_PER_DAY);
    // …and the factory really consults it, so the resolver is not a function
    // that only tests call. Two limiters from two environments, and the ONLY
    // one that moves is the mint budget.
    const plain = makeAuthRateLimiters(() => 0, {});
    for (let i = 0; i < REGISTER_MAX_PER_DAY; i++) plain.accountMint.record('1.2.3.4');
    expect(plain.accountMint.check('1.2.3.4').allowed, 'the default cap is not in force').toBe(false);
  });

  it('a raised value really raises the budget, and only that budget', () => {
    const raised = makeAuthRateLimiters(() => 0, { FLOWMIC_REGISTER_DAILY_CAP: '50' });
    for (let i = 0; i < 40; i++) raised.accountMint.record('1.2.3.4');
    expect(raised.accountMint.check('1.2.3.4').allowed, 'the override did not reach the mint limiter').toBe(true);
    // 🔴 THE NEGATIVE HALF, and it is the one that would catch a careless
    // widening: the 5/10-min BURST brake must be untouched by this variable.
    // Wiring it to the same number would let a golden env silently disable the
    // brake for login as well, which is a different budget answering a
    // different question.
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) raised.register.record('1.2.3.4');
    expect(raised.register.check('1.2.3.4').allowed, 'the burst brake was widened too').toBe(false);
  });

  it('🔴 junk NEVER disables the cap — it falls back to 2 and says so by name', () => {
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    // '0' and '-1' are the dangerous ones: a naive `Number(raw) || default`
    // would take 0 as falsy and quietly pass it on as「no accounts at all」,
    // and a naive `>= 0` would take it as「the cap is off」. Both are wrong in
    // opposite directions, so both are pinned.
    for (const value of ['0', '-1', 'off', 'none', '2.5', 'Infinity', 'NaN']) {
      expect(resolveRegisterDailyCap({ FLOWMIC_REGISTER_DAILY_CAP: value }), value).toBe(REGISTER_MAX_PER_DAY);
    }
    expect(errors.mock.calls.length, 'a typo that silently keeps the default is a typo nobody finds').toBe(7);
    expect((errors.mock.calls[0] as [string, Record<string, unknown>])[1].env).toBe('FLOWMIC_REGISTER_DAILY_CAP');
  });
});

describe('the account-mint log line', () => {
  // 🔴 AN EXPLICIT TIMEOUT, WITH ITS REASON, on the coupling-replay precedent
  // (§「sizing a window to a PRODUCT deadline, not to how fast this machine
  // happens to be」). What is being measured here is a real boot: schema
  // reconcile, seeding, socket server, listen — ~175 ms on this box and an
  // unknown multiple of that on a loaded CI runner. The default 5 s is a
  // framework number that has nothing to do with that work, and a test which
  // fails because the box was busy reports a defect that does not exist.
  it('🔴 exists, and carries the IP without carrying the address', { timeout: 20_000 }, async () => {
    // owner's concern is 「被薅了」 — which is only discoverable if a mint leaves
    // a record. The line is asserted on the REAL route, not on a comment.
    const infos = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const config = loadConfig({ mode: 'saas', secret: 'mint-log-secret-32-bytes-aaaaaaaaaa', port: 0, dbPath: ':memory:', trustedProxies: [] });
    server = await startServer(config, {});
    const res = await fetch(`http://127.0.0.1:${server.port}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'minted@v.co', password: 'longenough1' }),
    });
    expect(res.status).toBe(201);
    const line = infos.mock.calls.find(([m]) => String(m) === 'auth: account minted');
    expect(line, 'every account mint must leave one structured line').toBeTruthy();
    const fields = (line as [string, Record<string, unknown>])[1];
    expect(typeof fields.ip).toBe('string');
    expect(fields.source).toBe('register');
    // No address in the line: `user_id` identifies the account without
    // writing an email into a file that outlives it.
    expect(JSON.stringify(fields)).not.toContain('minted@v.co');
  });
});
