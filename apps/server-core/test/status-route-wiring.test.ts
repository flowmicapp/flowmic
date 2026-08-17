// SPEC-REF:
//   docs/strategy/2026-08-13-wp5-review-annex.md §4-2 — "`/api/status` wiring has
//     zero proof: no test hits that path from `startServer` (precedent =
//     `health-db-probe-wiring.test.ts`); the W-5b status page depends on it being
//     truly live in production". THIS FILE IS THAT ACCOUNT, closed.
//   docs/strategy/2026-08-13-0263-design-task-book.md §9 (REQ-13-03 service-availability status page),
//     §9-2.1 (the page only reads the most recent result + timestamp), §9-2.2 (anti-cache ⇒ unknown),
//     §9-2.5 (no SLA, no percentage anywhere on the page), §9-2.6 (W-5a acceptance)
//   apps/server-core/src/http/status-routes.ts   (the handler)
//   apps/server-core/src/http/router.ts:413 (`tryHandleStatusRoutes` — the MOUNT
//     under test)
//   apps/server-core/src/bootstrap-http-deps.ts:195 (`statusSnapshot` — the DEPS
//     wiring under test)
//   apps/server-core/src/bootstrap.ts:361 (`makeStatusProbes` — the ONE runner)
//   apps/server-core/src/bootstrap.ts:688 (`statusProbes.start()` — armed after
//     listen, which is why the boot round is already landing)
//   apps/server-core/test/health-db-probe-wiring.test.ts (the precedent this mirrors)
//   CLAUDE.md anti-façade ③: "unit tests all green prove nothing about wiring; every real path needs one real-end run"
//
// ── 🔴 WHY THIS FILE EXISTS, STATED AS THE DIFFERENCE IT MAKES ───────────────
// `test/status-probes.test.ts` is a good suite and it proves nothing about this.
// Every one of its route assertions calls `tryHandleStatusRoutes` DIRECTLY and
// hands it a `snapshot` the test itself wrote. Delete the router branch
// (router.ts:413), or delete the `status:` field (bootstrap-http-deps.ts:189),
// and all 15 of those tests stay green while `GET /api/status` answers 404 on
// every deployed relay — and the W-5b status page, whose entire job is to be
// readable on the day the product is not, shows nothing. That is the exact shape
// of this repo's #1 historical bug class, and the only instrument that can see it
// is a real socket on a real boot.
//
// So every assertion below is made against a server started by `startServer`,
// over `fetch`, on the bound port. Nothing here constructs a dep object.
//
// ── ⚠️ THE ENV IS CONTROLLED, THE PROBES ARE NOT FAKED ──────────────────────
// `beforeEach` deletes every `FLOWMIC_MANAGED_*` key from `process.env`. That is
// NOT a stubbed probe: it puts this boot into a real, shipped deployment state
// ("this machine has no managed line configured"), which both probe modules answer with `null` →
// `not_configured` WITHOUT dialling anyone. The alternative — inheriting whatever
// the developer's shell has — would make a green run mean "the machine had no
// keys today" and a configured machine would bill us to run the test suite.
// The probes underneath are the production `probeManagedSttLiveness` /
// `probeManagedLlmLiveness`; no seam in this file replaces them.
//
// ── 🔴 CORRECTION TO THE CARD THAT ORDERED THIS FILE (measured, not assumed) ─
// The card asked for "the route must serve the never-measured `unknown` shape
// (`checked_at: null`) without the timer having fired」. MEASURED ON A REAL BOOT
// (machine dev-pc-a, 2026-08-13): it does not, and it should not.
// `statusProbes.start()` (bootstrap.ts:661) kicks `runOnce()` immediately — by
// design, so a fresh relay is not blind for a whole interval — and with no
// managed line configured both probes resolve to `null` in a microtask, long
// before a fetch can land. The wire therefore shows `not_configured` with a real
// timestamp. §4 asserts THAT, honestly, and §5 gets the `unknown`/`null` shape
// onto the wire the only way it legitimately occurs on a running relay: by
// letting a stored result EXPIRE (§9-2.2) under an injected clock. Asserting the
// card's version would have meant faking a probe or racing the boot.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_VERSION, startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { STATUS_ROUTE_PATH } from '../src/http/status-routes';
import { PC_PRESENCE_PATH } from '../src/http/presence-routes';
import { STATUS_PROBE_INTERVAL_MS, STATUS_STALE_FACTOR } from '../src/status/status-probes';

const SECRET = 'status-route-wiring-secret-32-bytes-ok';

/** 🔴 The literal, not the constant, is what the world asks for: the W-5b page
 *  and any operator's curl carry a string, not an import. Fetching through
 *  `STATUS_ROUTE_PATH` would keep this file green through a rename that breaks
 *  every caller — `PC_PRESENCE_PATH`'s own doc comment makes the same distinction
 *  in prose ("the route is /api/pc/presence" vs "whatever the constant says"). The
 *  constant is pinned against the literal instead, so a rename is a failure here
 *  rather than a silent 404 in production. */
const WIRE_PATH = '/api/status';

/** The wire shape, declared rather than indexed into: under this workspace's
 *  `noUncheckedIndexedAccess` a missing key would compare `undefined ===
 *  undefined` and pass. Naming the keys makes an absent one a type error. */
interface TargetView {
  status: string;
  checked_at: number | null;
  version?: string;
  mode?: string;
}
interface StatusBody {
  checked_at: number;
  targets: { relay: TargetView; managed_stt: TargetView; managed_llm: TargetView };
}

/** Every word the endpoint is allowed to publish. The store collapses a rich
 *  verdict (`code` / `message` / `fatal` / `elapsed_ms`) to ONE of these — §2
 *  asserts the collapse happened on the WIRE rather than trusting that it did. */
const ALLOWED_STATUS = ['up', 'down', 'not_configured', 'unknown'];

let server: BootstrapHandle | null = null;
const savedEnv = new Map<string, string | undefined>();

/** The clock bootstrap threads into the probe runner (bootstrap.ts, the `now` handed to `makeStatusProbes`). Frozen
 *  at boot so a measurement's timestamp is an exact expected value, advanced by
 *  hand in §5 so staleness is a decision the test makes rather than a wait. */
const clock = { t: 0 };

beforeEach(() => {
  clock.t = Date.now();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FLOWMIC_MANAGED_')) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  }
});

afterEach(async () => {
  if (server) {
    await server.close().catch(() => undefined);
    server = null;
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

async function boot(mode: 'standalone' | 'saas'): Promise<string> {
  const config = mode === 'saas'
    ? loadConfig({ mode, secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [] })
    : loadConfig({ mode, secret: SECRET, port: 0, dbPath: ':memory:' });
  server = await startServer(config, { now: () => clock.t });
  return `http://127.0.0.1:${server.port}`;
}

/** 🔴 NO `headers` ARGUMENT, EVER, IN THIS FILE. The absence IS the assertion for
 *  §1's "no credential" claim: `fetch` sends no Authorization of its own, so a
 *  200 here is a 200 for an anonymous caller. The positive control that this
 *  server can in fact refuse one lives beside that test. */
async function get(url: string, path = WIRE_PATH): Promise<{ status: number; type: string; text: string; body: StatusBody }> {
  const res = await fetch(`${url}${path}`);
  const text = await res.text();
  let body = {} as StatusBody;
  try { body = JSON.parse(text) as StatusBody; } catch { /* non-JSON is a failure the caller asserts */ }
  return { status: res.status, type: res.headers.get('content-type') ?? '', text, body };
}

/** The boot round is async (`void runOnce()` inside `start()`), so "it landed"
 *  is a poll, not an assumption. Polls the WIRE, not the store — a store that
 *  updates while the route reads a different instance is precisely the bug this
 *  file is here to catch. */
async function waitForMeasured(url: string): Promise<StatusBody> {
  let last = {} as StatusBody;
  await vi.waitFor(async () => {
    last = (await get(url)).body;
    expect(last.targets.managed_stt.checked_at, 'the boot probe round never reached the wire').not.toBeNull();
  }, { timeout: 5_000, interval: 25 });
  return last;
}

// ────────────────────────────────────────────────────────────────────────────
describe('§1 the route is MOUNTED on a real server, in both modes, without a credential', () => {
  it('standalone: GET /api/status answers 200 JSON with the full envelope', async () => {
    const url = await boot('standalone');
    const { status, type, body } = await get(url);

    // 🔴 THE ONE ASSERTION THE WHOLE FILE IS FOR. 404 here ⇒ router.ts:413 or
    // bootstrap-http-deps.ts:189 is gone, and status-probes.test.ts cannot see it.
    expect(status, 'GET /api/status did not answer 200 — the route is not mounted').toBe(200);
    expect(type).toContain('application/json');

    // The envelope's own clock, distinct from each target's (§9-2.1). It is
    // `Date.now()` and NOT the injected clock — bootstrap-http-deps.ts:189 does
    // not thread `overrides.now` into the route deps. That is registered as annex
    // §4-9 ("status deps single field, two clocks") and is harmless in production, where both
    // clocks are `Date.now()`; asserted as a NUMBER here rather than as a value,
    // so this file neither depends on the split nor hides it.
    expect(typeof body.checked_at).toBe('number');
    expect(Object.keys(body.targets).sort()).toEqual(['managed_llm', 'managed_stt', 'relay']);

    for (const [name, target] of Object.entries(body.targets)) {
      expect(ALLOWED_STATUS, `${name} published a word outside the enum`).toContain(target.status);
      expect(Object.hasOwn(target, 'checked_at'), `${name} has no checked_at`).toBe(true);
      // 🔴 The invariant that makes "unknown" mean anything (§9-2.2): a row that
      // refuses to answer must not carry a fresh-looking timestamp, and a row
      // that answers must carry the timestamp of ITS measurement.
      if (target.status === 'unknown') expect(target.checked_at, `${name}: unknown with a timestamp`).toBeNull();
      else expect(typeof target.checked_at, `${name}: a measured row with no timestamp`).toBe('number');
    }

    // The relay row is self-evident (this response existing IS the measurement)
    // and carries the two fields the page prints beside it.
    expect(body.targets.relay.status).toBe('up');
    expect(body.targets.relay.mode).toBe('standalone');
    // The build, from the SAME constant /api/health publishes — a literal here
    // would need editing on every version bump and would prove less.
    expect(body.targets.relay.version).toBe(SERVER_VERSION);
    expect(body.targets.relay.checked_at).toBe(body.checked_at);
  });

  it('saas: the same path answers 200 and names the OTHER mode — mounted in both, as router.ts:413 claims', async () => {
    // Without this half, a mount accidentally placed inside a `config.mode ===
    // 'standalone'` block (the branch three lines below it in router.ts) would
    // pass the test above forever while the PUBLIC deployment — the only one a
    // status page is for — answered 404.
    const url = await boot('saas');
    const { status, body } = await get(url);
    expect(status).toBe(200);
    expect(body.targets.relay.mode).toBe('saas');
    expect(body.targets.relay.version).toBe(SERVER_VERSION);
  });

  it('no credential is required — and the same server DOES refuse one that needs it', async () => {
    const url = await boot('saas');
    // Anonymous: the `get` helper sends no Authorization header at all.
    expect((await get(url)).status).toBe(200);

    // 🔴 POSITIVE CONTROL. Without it, the 200 above is equally explained by
    // "this server authenticates nothing in test mode". `/api/pc/presence` is
    // mounted unconditionally on the same boot (`presence: { registry, store }`) and
    // takes a Bearer — an anonymous GET must be refused. Two routes, one server,
    // one request shape, opposite answers ⇒ the 200 is a decision about /api/status.
    const gated = await get(url, PC_PRESENCE_PATH);
    expect(gated.status, 'the credential control did not refuse — the 200 above proves nothing').toBe(401);
  });

  it('the path constant and the published literal are the same string', async () => {
    // Everything above fetches the LITERAL; this is the one line that ties the
    // constant to it, so a rename fails loudly instead of quietly 404-ing the
    // W-5b page (whose URL is a string in another repo).
    expect(STATUS_ROUTE_PATH).toBe(WIRE_PATH);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🔴 THE LEAK BOUNDARY, MEASURED ON THE WIRE. status-routes.ts argues in prose
// that the verdict's `code` and the provider's own `message` are never published
// — the real strings being things like `402 organization_balance_exhausted` and
// `STT_ENGINE_AUTH_FAIL`, i.e. our billing state and our credential state handed
// to anyone who asks. `status-probes.test.ts` asserts that against a verdict IT
// authored; this asserts it against the bytes a real server sent to a real
// anonymous client, which is the only place the promise is actually kept.
describe('§2 the serialized body carries no operator strings and no credentials', () => {
  it('no code, message, api_key, provider host, percentage or SLA anywhere in the bytes', async () => {
    const url = await boot('saas');
    const { text } = await get(url);

    // Positive control on the ruler: an empty/garbled body would pass every
    // `not.toContain` below. This file has been bitten-adjacent by that shape
    // ("check your ruler first"), so the scan asserts it is scanning something.
    expect(text.length, 'nothing to scan — the assertions below would pass on an empty body').toBeGreaterThan(50);
    expect(text).toContain('managed_stt');

    for (const forbidden of ['code', 'message', 'api_key', 'apiKey', 'endpoint', 'elapsed_ms', 'fatal']) {
      expect(text, `the wire published \`${forbidden}\``).not.toContain(forbidden);
    }
    // Provider identity is not published either: which vendor we buy from is not
    // an answer a public reader is owed, and it is a shopping list for anyone
    // deciding what to attack.
    for (const host of ['soniox', 'deepseek', 'openai', 'aliyun', 'volc', '.com', 'http']) {
      expect(text.toLowerCase(), `the wire named a provider/host: ${host}`).not.toContain(host);
    }
    // §9-2.5 — v1 stores no history, so any percentage would be computed from
    // nothing. There must not be one to compute from.
    expect(text).not.toMatch(/uptime|sla|%|\bavailability\b/i);

    // And the whole body is only the three keys plus the envelope clock: a scan
    // for forbidden strings cannot see a NEW leaky key, so pin the key set too.
    const { body } = await get(url);
    expect(Object.keys(body).sort()).toEqual(['checked_at', 'targets']);
    expect(Object.keys(body.targets.managed_stt).sort()).toEqual(['checked_at', 'status']);
    expect(Object.keys(body.targets.managed_llm).sort()).toEqual(['checked_at', 'status']);
    expect(Object.keys(body.targets.relay).sort()).toEqual(['checked_at', 'mode', 'status', 'version']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('§3 method and path — the refusals, with their positive halves', () => {
  it('POST on the path is refused 405 by name, while GET on it is 200', async () => {
    const url = await boot('standalone');
    const post = await fetch(`${url}${WIRE_PATH}`, { method: 'POST' });
    expect(post.status, 'status-routes.ts:81-84 — a non-GET must be named, not served').toBe(405);
    expect(await post.json()).toEqual({ error: 'METHOD_NOT_ALLOWED' });
    // The positive half in the same test: a 405 that is really "this server
    // refuses everything" would prove nothing.
    expect((await get(url)).status).toBe(200);
  });

  it('a neighbouring path is NOT swallowed — the prefix match does not overreach', async () => {
    const url = await boot('standalone');
    // status-routes.ts:80 accepts the exact path or `?query`; `/api/statuses`
    // must fall through to the router's 404, or this branch would be shadowing
    // paths that belong to someone else.
    expect((await get(url, '/api/statuses')).status).toBe(404);
    // …and the documented query form IS served (that same line's other half).
    expect((await get(url, `${WIRE_PATH}?t=1`)).status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🔴 THE ASSERTION THAT OUTLIVES "IS IT MOUNTED". A route can be mounted and
// still be a façade: hand it a snapshot from a SECOND `makeStatusProbes()`
// instance that nobody ever `start()`ed and it answers 200 forever, with every
// row reading "unknown" for the life of the process. The `const statusProbes`
// construction note in bootstrap.ts names that shape outright — "a fresh instance
// per request would be a timer that never accumulates a result (the
// ReleaseSuppression trap)」 — and these two tests are what tells the difference.
// They can only be written against a real boot.
describe('§4 the route serves the STARTED timer’s store, not a second instance', () => {
  it('the boot round’s real measurement reaches the wire, stamped with the injected clock', async () => {
    const url = await boot('standalone');
    const body = await waitForMeasured(url);

    // 🔴 The timestamp is the fingerprint: `clock.t` is the value bootstrap
    // threaded into `makeStatusProbes` (bootstrap.ts, the `now` handed to `makeStatusProbes`). A row carrying it
    // came from THAT runner — the one `start()` armed — through the route's
    // `snapshot` closure (bootstrap-http-deps.ts:189). An unstarted twin would
    // read `null` here until the process died.
    expect(body.targets.managed_stt.checked_at).toBe(clock.t);
    expect(body.targets.managed_llm.checked_at).toBe(clock.t);

    // The env this boot ran under has no managed lines (see the header), and
    // "not configured" is a MEASUREMENT with its own word — never `down`, never `unknown`.
    expect(body.targets.managed_stt.status).toBe('not_configured');
    expect(body.targets.managed_llm.status).toBe('not_configured');
  });

  it('the snapshot is read PER REQUEST, not captured once at wiring time', async () => {
    // §9-2.1's "the page only reads the most recent result" has a wiring corollary: if bootstrap had
    // passed a VALUE instead of the `() => statusProbes.snapshot()` closure, the
    // first response would be frozen forever and no later measurement would ever
    // publish. Two requests separated by a clock move show the read happening at
    // request time.
    const url = await boot('standalone');
    await waitForMeasured(url);
    const first = (await get(url)).body;

    clock.t += 1_000;
    const second = (await get(url)).body;
    // The relay row is stamped by the route itself on each request…
    expect(second.checked_at).toBeGreaterThanOrEqual(first.checked_at);
    // …and the store is consulted again rather than replayed (same value here
    // because no new round ran — the point is that §5's change is VISIBLE).
    expect(second.targets.managed_stt.checked_at).toBe(clock.t - 1_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🔴 THE ANTI-CACHE RULE, END TO END, ON A REAL SERVER (§9-2.2). This is the
// `unknown` + `checked_at: null` shape the card asked for, obtained the only way
// a running relay ever produces it: a stored result EXPIRES. Nothing here fakes a
// probe — the production probes ran at boot, and time is the only thing moved.
//
// Why it belongs in the WIRING file and not only in status-probes.test.ts: that
// suite proves the STORE expires values. This proves the expiry survives the trip
// through bootstrap's closure, the router branch and JSON serialization — i.e.
// that the page a reader loads during an outage of our own prober says "don't know"
// rather than a confident, months-old green.
describe('§5 a stale store publishes unknown/null through the real route', () => {
  it('past 2x the interval every managed row reads unknown with a null timestamp, and the relay row does not', async () => {
    const url = await boot('standalone');
    await waitForMeasured(url); // ← the boot round landed; now let it go stale.

    // One millisecond inside the horizon: still an answer.
    clock.t += STATUS_STALE_FACTOR * STATUS_PROBE_INTERVAL_MS;
    expect((await get(url)).body.targets.managed_stt.status).toBe('not_configured');

    // One past it: not an answer any more.
    clock.t += 1;
    const { status, body } = await get(url);
    expect(status).toBe(200); // the endpoint still answers — it just stops claiming
    expect(body.targets.managed_stt).toEqual({ status: 'unknown', checked_at: null });
    expect(body.targets.managed_llm).toEqual({ status: 'unknown', checked_at: null });

    // 🔴 The relay row is NOT probed and never goes stale: this response existing
    // is its measurement. A test that let it drift to `unknown` too would be
    // asserting that a process cannot tell whether it is running.
    expect(body.targets.relay.status).toBe('up');
    expect(body.targets.relay.checked_at).toBe(body.checked_at);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🔴 REVERSE CONTROL — SEEN RED FOR REAL (2026-08-13, machine dev-pc-a).
//
// The mount is unconditional in production (bootstrap-http-deps.ts:189 passes
// `status:` with no env gate, deliberately — see its comment), so there is no
// seam a test can drive to un-mount it. The control was therefore run as a
// transient one-line edit to router.ts:413, the branch this whole file is about:
//
//     -    if (deps.status && tryHandleStatusRoutes(req, res, deps.status)) return true;
//     +    // if (deps.status && tryHandleStatusRoutes(req, res, deps.status)) return true;
//
// `npx vitest run test/status-route-wiring.test.ts` → **Tests 9 failed | 1 passed**.
// Verbatim (ANSI stripped; the one survivor is §1's constant-vs-literal identity
// check, which makes no request):
//
//   FAIL … §1 … > standalone: GET /api/status answers 200 JSON with the full envelope
//   AssertionError: GET /api/status did not answer 200 — the route is not mounted: expected 404 to be 200 // Object.is equality
//   FAIL … §1 … > saas: the same path answers 200 and names the OTHER mode — mounted in both, as router.ts:413 claims
//   AssertionError: expected 404 to be 200 // Object.is equality
//   FAIL … §1 … > no credential is required — and the same server DOES refuse one that needs it
//   AssertionError: expected 404 to be 200 // Object.is equality
//   FAIL … §2 … > no code, message, api_key, provider host, percentage or SLA anywhere in the bytes
//   AssertionError: nothing to scan — the assertions below would pass on an empty body: expected 21 to be greater than 50
//   FAIL … §3 … > POST on the path is refused 405 by name, while GET on it is 200
//   AssertionError: status-routes.ts:81-84 — a non-GET must be named, not served: expected 404 to be 405 // Object.is equality
//   FAIL … §3 … > a neighbouring path is NOT swallowed — the prefix match does not overreach
//   AssertionError: expected 404 to be 200 // Object.is equality
//   FAIL … §4 … > the boot round’s real measurement reaches the wire, stamped with the injected clock
//   Error: Test timed out in 5000ms.
//   FAIL … §4 … > the snapshot is read PER REQUEST, not captured once at wiring time
//   Error: Test timed out in 5000ms.
//   FAIL … §5 … > past 2x the interval every managed row reads unknown with a null timestamp, and the relay row does not
//   Error: Test timed out in 5000ms.
//
// ⚠️ Note §2's failure line: the ruler's positive control fired FIRST — 21 bytes
// is the router's 404 body, and every `not.toContain` below it would have passed
// happily on it. That is the "check your ruler first" shape caught by construction.
//
// 🔴 THE PART WORTH WRITING DOWN: `test/status-probes.test.ts` was run against
// the SAME broken tree and reported **15 passed** — the entire existing suite is
// blind to the route being unreachable on every deployed relay. That is the
// annex §4-2 account in one line, and it is why this file is not a duplicate.
//
// router.ts was then restored and verified untouched (`git status --porcelain`
// and `git diff --stat` on `apps/server-core/src` both empty; the marker string
// greps to zero), and this file re-run green: 10 passed.
