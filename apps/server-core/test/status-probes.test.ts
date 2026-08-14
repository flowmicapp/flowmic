// W-5a (REQ-13-03) — the status probe timer, its two probes, and GET /api/status.
//
// SPEC-REF: docs/strategy/2026-08-13-0263-design-task-book.md §9-2 (every ruling carries its reason;
//             §9-2.2 is this file's lead), §9-2.6 (W-5a acceptance: when the probe dies the endpoint answers
//             unknown-with-timestamp; the probe does not hit real session quota)
//           src/status/status-probes.ts / src/status/managed-stt-health.ts
//           src/http/status-routes.ts
//
// 🔴 WHAT THIS SUITE IS ACTUALLY FOR. The interesting failure of a status page is
// not "it showed the wrong colour" — it is "the thing measuring died and the page
// kept showing the last colour forever". That is a defect no green-path test can
// see, because on the green path the prober is alive. So §2 below KILLS the
// prober and asserts the endpoint stops making claims. Everything else in this
// file exists to make that section mean something: without §4's positive control
// a green "unknown" could just be a probe that never worked.
//
// ⚠️ NO REAL NETWORK ANYWHERE. Every probe is a seam (`probeStt` / `probeLlm`),
// and the one test that reaches the real STT resolver drives it with an env
// object rather than `process.env`. A suite that dialled Soniox would bill us to
// assert that we do not bill ourselves.

import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATUS_PROBE_INTERVAL_MS,
  STATUS_STALE_FACTOR,
  makeStatusProbes,
} from '../src/status/status-probes';
import { probeManagedSttLiveness } from '../src/status/managed-stt-health';
import { STATUS_ROUTE_PATH, tryHandleStatusRoutes } from '../src/http/status-routes';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

/** A verdict shaped like the real ones, minus the fields the route never reads. */
const UP = { ok: true };
const DOWN = { ok: false };

/** The wire shape, declared rather than indexed into. Under this workspace's
 *  `noUncheckedIndexedAccess`, `body['targets']['relay']` is `| undefined` and
 *  every assertion would need a `?.` — which would quietly turn a MISSING key
 *  into a passing `undefined === undefined` comparison. Naming the three keys
 *  makes an absent one a type error instead. */
interface TargetView {
  status: string;
  checked_at: number | null;
  version?: string;
  mode?: string;
}
interface StatusBody {
  checked_at?: number;
  targets: { relay: TargetView; managed_stt: TargetView; managed_llm: TargetView };
}

function response(): { res: ServerResponse; done: Promise<{ status: number; body: StatusBody }> } {
  let settle: (v: { status: number; body: StatusBody }) => void;
  const done = new Promise<{ status: number; body: StatusBody }>((r) => (settle = r));
  let status = 0;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(payload?: string) { settle({ status, body: payload ? (JSON.parse(payload) as StatusBody) : ({} as StatusBody) }); },
    once() { return res; },
  } as unknown as ServerResponse;
  return { res, done };
}

async function get(
  deps: Parameters<typeof tryHandleStatusRoutes>[2],
  url = STATUS_ROUTE_PATH,
  method = 'GET',
): Promise<{ handled: boolean; status: number; body: StatusBody }> {
  const { res, done } = response();
  const handled = tryHandleStatusRoutes({ url, method } as IncomingMessage, res, deps);
  if (!handled) return { handled, status: 0, body: {} as StatusBody };
  const out = await done;
  return { handled, ...out };
}

/** A runner with both probes seamed and a clock the test drives. */
function runnerWith(stt: unknown, llm: unknown, clock: { t: number }) {
  return makeStatusProbes({
    env: {},
    now: () => clock.t,
    probeStt: () => Promise.resolve(stt as { ok: boolean } | null),
    probeLlm: () => Promise.resolve(llm as { ok: boolean } | null),
  });
}

function depsFor(runner: ReturnType<typeof makeStatusProbes>, clock: { t: number }) {
  return { snapshot: () => runner.snapshot(clock.t), version: '0.2.62', mode: 'saas' as const, now: () => clock.t };
}

// ────────────────────────────────────────────────────────────────────────────
describe('§1 GET /api/status returns each target with its own timestamp', () => {
  it('serves relay + both managed lines, each carrying checked_at', async () => {
    const clock = { t: 1_000_000 };
    const runner = runnerWith(UP, UP, clock);
    await runner.runOnce();

    clock.t += 5_000; // the answer is assembled later than the measurement
    const { handled, status, body } = await get(depsFor(runner, clock));

    expect(handled).toBe(true);
    expect(status).toBe(200);
    const targets = body.targets;
    expect(Object.keys(targets).sort()).toEqual(['managed_llm', 'managed_stt', 'relay']);
    expect(targets.managed_stt).toEqual({ status: 'up', checked_at: 1_000_000 });
    expect(targets.managed_llm).toEqual({ status: 'up', checked_at: 1_000_000 });

    // 🔴 The envelope's clock and each measurement's clock are DIFFERENT values,
    // and the gap is the fact a reader needs: the page is live, the numbers under
    // it are five seconds old. One shared timestamp would hide exactly that.
    expect(body.checked_at).toBe(1_005_000);
    expect(targets.relay).toEqual({ status: 'up', checked_at: 1_005_000, version: '0.2.62', mode: 'saas' });
  });

  it('publishes no error strings and no percentages (§9-2.5)', async () => {
    const clock = { t: 1 };
    // A verdict carrying everything an operator would want and a public reader
    // must not get: the provider's own words and our credential's state.
    const leaky = { ok: false, code: 'STT_ENGINE_AUTH_FAIL', message: '402 organization_balance_exhausted', fatal: true, elapsed_ms: 12 };
    const runner = runnerWith(leaky, null, clock);
    await runner.runOnce();
    const { body } = await get(depsFor(runner, clock));

    const wire = JSON.stringify(body);
    expect(wire).not.toContain('organization_balance_exhausted');
    expect(wire).not.toContain('STT_ENGINE_AUTH_FAIL');
    expect(wire).not.toContain('elapsed_ms');
    // No uptime number can be honest when nothing is stored (§9-2.3).
    expect(wire).not.toMatch(/uptime|sla|%/i);
  });

  it('refuses a non-GET by name, and ignores paths it does not own', async () => {
    const clock = { t: 1 };
    const deps = depsFor(runnerWith(UP, UP, clock), clock);
    expect((await get(deps, STATUS_ROUTE_PATH, 'POST')).status).toBe(405);
    expect((await get(deps, '/api/statuses')).handled).toBe(false);
    expect((await get(deps, '/api/health')).handled).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🔴 THE REVERSE CONTROL. §9-2.6's acceptance is "kill the probe process ⇒ the page cell must turn to 'unknown',
// watch it turn". Killing the timer is `stop()`; "watching it turn" is advancing the
// clock past the staleness horizon with nothing refreshing the store.
//
// RED CAPTURED (2026-08-12, machine dev-pc-b). `viewOf`'s staleness line
//     if (at - stored.checked_at > STATUS_STALE_FACTOR * intervalMs) …
// was replaced by `if (at - stored.checked_at < 0)` — i.e. the check disabled,
// which is what a dead prober's endpoint reduces to. Result: 2 failed | 13 passed,
// both failures in THIS describe, verbatim:
//     AssertionError: expected 'up' to be 'unknown' // Object.is equality
//     AssertionError: expected 'down' to be 'unknown' // Object.is equality
// The first IS the cached green; the second is the remembered outage.
//
// 🔴 THE OTHER 13 STAYED GREEN, and that is the part worth writing down: §1's
// shape assertions, §4's positive controls and §5's import scan all pass happily
// against a store that never expires anything. Nothing but the two assertions
// below stands between us and a page that lies forever — so if a future edit
// finds them inconvenient, it is removing the whole feature, not a test.
describe('§2 REVERSE CONTROL — a dead prober stops making claims', () => {
  it('turns every measured target to unknown past 2x the interval', async () => {
    const clock = { t: 0 };
    const runner = runnerWith(UP, UP, clock);
    runner.start();
    await runner.runOnce();
    expect(runner.snapshot(clock.t).managed_stt.status).toBe('up');

    // The prober dies. Nothing else changes.
    runner.stop();

    // Still inside the horizon: the last measurement is still an answer.
    clock.t = STATUS_STALE_FACTOR * STATUS_PROBE_INTERVAL_MS;
    expect(runner.snapshot(clock.t).managed_stt.status).toBe('up');

    // One millisecond past it: it is not an answer any more.
    clock.t += 1;
    const { body } = await get(depsFor(runner, clock));
    const targets = body.targets;
    expect(targets.managed_stt.status).toBe('unknown');
    expect(targets.managed_llm.status).toBe('unknown');

    // 🔴 And the timestamp goes with it. A row that says "unknown" beside a
    // fresh-looking `checked_at` is the cached green wearing a hat.
    expect(targets.managed_stt.checked_at).toBeNull();

    // The relay row is NOT probed, so it never goes stale — a process reporting
    // that it is answering is measuring itself, and that measurement is sound.
    expect(targets.relay.status).toBe('up');
  });

  it('a stale DOWN also becomes unknown, not a remembered outage', async () => {
    // The design's sentence is "never stay green", and the symmetric case is the one a
    // carve-out would get wrong: a fixed outage still reported as broken is the
    // same lie pointed the other way, during recovery, when it matters most.
    const clock = { t: 0 };
    const runner = runnerWith(DOWN, DOWN, clock);
    await runner.runOnce();
    expect(runner.snapshot(clock.t).managed_stt.status).toBe('down');
    clock.t = STATUS_STALE_FACTOR * STATUS_PROBE_INTERVAL_MS + 1;
    expect(runner.snapshot(clock.t).managed_stt.status).toBe('unknown');
  });

  it('a target never measured reads unknown, not up', async () => {
    // Boot state. `pool-health.ts`'s registry is optimistic for the opposite
    // reason (refusing traffic on boot would be worse); a PAGE has no such
    // pressure, and "never measured" is not "good".
    const runner = runnerWith(UP, UP, { t: 0 });
    expect(runner.snapshot(0).managed_stt).toEqual({ status: 'unknown', checked_at: null });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('§3 not-configured is its own word, never an outage', () => {
  it('reports not_configured when the managed line is absent', async () => {
    const clock = { t: 500 };
    const runner = runnerWith(null, null, clock); // null = "no measurable managed line"
    await runner.runOnce();
    const { body } = await get(depsFor(runner, clock));
    const targets = body.targets;

    expect(targets.managed_stt.status).toBe('not_configured');
    // It IS a measurement — it has a timestamp — it is just not a failure.
    expect(targets.managed_stt.checked_at).toBe(500);
    expect(targets.managed_stt.status).not.toBe('down');
    expect(targets.managed_stt.status).not.toBe('unknown');
  });

  it('the STT probe itself returns null for an unset env, and a FATAL verdict for a broken one', async () => {
    // 🔴 Three env states, three different answers — this is where "not
    // configured" and "configured but wrong" are actually distinguished, and
    // collapsing them would publish an outage for a deployment that simply has
    // no managed STT.
    await expect(probeManagedSttLiveness({})).resolves.toBeNull();
    await expect(probeManagedSttLiveness({ FLOWMIC_MANAGED_STT_ENABLED: '0' })).resolves.toBeNull();

    // ENABLED with a bad engine id: `managedDefaultRouting` throws (fail loud at
    // startup), and the probe turns that into a verdict rather than propagating —
    // a health probe must never answer with an exception.
    const broken = await probeManagedSttLiveness({
      FLOWMIC_MANAGED_STT_ENABLED: '1',
      FLOWMIC_MANAGED_STT_ENGINE: 'not-a-real-engine',
    });
    expect(broken).not.toBeNull();
    expect(broken?.ok).toBe(false);
    expect(broken?.fatal).toBe(true);
    expect(broken?.code).toBe('STT_CONFIG_MISSING');
  });

  it('a probe that THREW records nothing — it says nothing about the target', async () => {
    // pool-health.ts's rule, verbatim: inventing a `down` here would publish an
    // outage for a bug in our own probe. The previous value stands and then
    // expires on its own, so a permanently throwing probe ends at "unknown".
    const clock = { t: 0 };
    const runner = makeStatusProbes({
      env: {},
      now: () => clock.t,
      probeStt: () => Promise.reject(new Error('probe blew up')),
      probeLlm: () => Promise.resolve(UP),
    });
    await expect(runner.runOnce()).resolves.toBeUndefined(); // never rejects
    expect(runner.snapshot(clock.t).managed_stt.status).toBe('unknown');
    expect(runner.snapshot(clock.t).managed_llm.status).toBe('up'); // positive control
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🔴 THE POSITIVE CONTROL FOR §2. Every assertion up there is that something
// reads "unknown", and a probe that never works reads "unknown" too. These pin
// that a FRESH result is reported faithfully in both directions — without them,
// §2 could pass against a completely broken store.
describe('§4 positive control — a fresh result is reported faithfully', () => {
  it('up and down both survive the round trip, and a recovery is visible', async () => {
    const clock = { t: 10 };
    let sttVerdict: unknown = UP;
    const runner = makeStatusProbes({
      env: {},
      now: () => clock.t,
      probeStt: () => Promise.resolve(sttVerdict as { ok: boolean } | null),
      probeLlm: () => Promise.resolve(DOWN),
    });

    await runner.runOnce();
    let targets = (await get(depsFor(runner, clock))).body.targets;
    expect(targets.managed_stt.status).toBe('up');
    expect(targets.managed_llm.status).toBe('down'); // the two are independent

    // The line breaks…
    sttVerdict = DOWN;
    clock.t += 1_000;
    await runner.runOnce();
    expect(runner.snapshot(clock.t).managed_stt.status).toBe('down');

    // …and comes back. A status page that cannot show recovery is not a status
    // page; this is the assertion the stale-DOWN carve-out in §2 would have
    // broken in production rather than here.
    sttVerdict = UP;
    clock.t += 1_000;
    await runner.runOnce();
    targets = (await get(depsFor(runner, clock))).body.targets;
    expect(targets.managed_stt.status).toBe('up');
  });

  it('overlapping rounds are refused — one round at a time', async () => {
    // A probe can outlive the interval (the STT settle window is ~900 ms and
    // open() has an 8 s ceiling); overlapping rounds would open provider
    // sessions faster than they close.
    let starts = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const runner = makeStatusProbes({
      env: {},
      probeStt: async () => { starts += 1; await gate; return UP; },
      probeLlm: () => Promise.resolve(UP),
    });
    const first = runner.runOnce();
    await runner.runOnce();      // must be a no-op while the first is in flight
    expect(starts).toBe(1);
    release();
    await first;
    await runner.runOnce();
    expect(starts).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🔴 STRUCTURAL, NOT A PROMISE IN A COMMENT. §9-2.6 requires that probing does
// not spend quota. The metering seam is `recordSttUsage` (billing/usage-tracker.ts,
// exactly-one discipline: exactly one production caller, in the session finalizer). The
// honest way to assert "the probe is not metered" is that no path from the probe modules can
// REACH it — a runtime assertion would only prove the one case it exercised.
describe('§5 the probe path cannot reach the metering seam', () => {
  const PROBE_MODULES = [
    join(SRC, 'status', 'status-probes.ts'),
    join(SRC, 'status', 'managed-stt-health.ts'),
    join(SRC, 'http', 'status-routes.ts'),
  ];

  it('imports neither the usage tracker nor the quota guard', () => {
    for (const file of PROBE_MODULES) {
      const src = readFileSync(file, 'utf8');
      const imports = [...src.matchAll(/^\s*import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1] ?? '');
      // Positive control on the extractor itself: if the regex ever stops
      // matching (quote style, a reformat, dynamic import()), the filter below
      // would pass against an empty list forever. Every probe module has real
      // imports; an empty scan means the ruler broke, not that the claim holds.
      expect(imports.length, `import scan matched nothing in ${file}`).toBeGreaterThan(0);
      expect(imports.filter((s) => /usage-tracker|quota-guard|usage\.repo|usage-events/.test(s))).toEqual([]);
    }
  });

  it('names the seam it must not touch, so a future edit meets the word', () => {
    // A positive control on the scan itself: if `recordSttUsage` were renamed and
    // this regex went silently unmatched everywhere, the test above would keep
    // passing against nothing. This pins that the seam still exists under that
    // name in the file the assertion is about.
    const tracker = readFileSync(join(SRC, 'billing', 'usage-tracker.ts'), 'utf8');
    expect(tracker).toMatch(/recordSttUsage/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('§6 the timer is armed, disarmable, and does not hold the process', () => {
  it('start() kicks one round immediately and is idempotent', async () => {
    let rounds = 0;
    const runner = makeStatusProbes({
      env: {},
      probeStt: () => { rounds += 1; return Promise.resolve(UP); },
      probeLlm: () => Promise.resolve(UP),
    });
    runner.start();
    runner.start();               // idempotent — not a second interval
    await vi.waitFor(() => expect(rounds).toBe(1));
    runner.stop();
    runner.stop();                // idempotent
  });

  it('the interval and the staleness factor are the named constants', () => {
    // They multiply each other, so they must move together — pinning both here
    // means a change to either has to be deliberate.
    expect(STATUS_PROBE_INTERVAL_MS).toBe(60_000);
    expect(STATUS_STALE_FACTOR).toBe(2);
  });
});
