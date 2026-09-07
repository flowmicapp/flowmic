// ── STRUCTURAL SPLIT (2026-08-29) ───────────────────────────────────────────
// This is the SOURCE-CENSUS half of usage-events.test.ts, moved out VERBATIM
// when that file crossed the 1200-line test cap verify/lint/file-size.mjs
// enforces. The two halves ask different kinds of question and it shows: the
// file this came from RUNS the meter and asserts what it recorded, while these
// assertions read the source tree and count who is allowed to call what.
//
// 🔴 A CENSUS IS COUNTED OVER SOURCE, NOT BEHAVIOUR, ON PURPOSE. A second
// caller of a metering seam added by someone who did not read the design passes
// every functional test in this repo and silently double-counts a user. Only
// counting the callers catches that — which also means these tests go red for
// legitimate work, and going red is the moment to decide whether the new caller
// should exist, not the moment to widen a list.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USAGE_EVENTS_RETENTION_DAYS } from '../src/db/retention';

const SRC_FOR_TOGGLE = fileURLToPath(new URL('../src', import.meta.url));
const SRC = SRC_FOR_TOGGLE;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : abs.endsWith('.ts') ? [abs] : [];
  });
}

/** Files under src/ whose CODE (comments stripped — this repo comments heavily
 *  and half those comments name the symbol) mentions `symbol`, excluding the
 *  files listed as its own definition. */
function mentions(symbol: string, exclude: string[] = []): string[] {
  return walk(SRC)
    .filter((f) => !exclude.some((e) => f.endsWith(join(...e.split('/')))))
    .filter((f) => {
      const code = readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
      return new RegExp(`\\b${symbol}\\b`).test(code);
    })
    .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
}

/** The same census over a LITERAL substring, for expressions a word-boundary
 *  regex cannot spell (`db.usageEvents`). Comments stripped for the same reason. */
function mentionsLiteral(text: string, exclude: string[] = []): string[] {
  return walk(SRC)
    .filter((f) => !exclude.some((e) => f.endsWith(join(...e.split('/')))))
    .filter((f) => readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '').includes(text))
    .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
}

describe('A2-5 census — nothing shipped here is a capability with no caller', () => {
  it('the census can actually fail (it is not matching nothing)', () => {
    expect(mentions('makeUsageEventsRepo')).not.toEqual([]);
    expect(mentions('thisSymbolDoesNotExistAnywhere')).toEqual([]);
  });

  it('the repo is CONSTRUCTED by db/connection.ts', () => {
    expect(mentions('makeUsageEventsRepo', ['db/repos/usage-events.repo.ts'])).toEqual(['db/connection.ts']);
  });

  it('🔴 `db.usageEvents` is handed out in EXACTLY the two wiring files, and nowhere else', () => {
    // Two files, named. A third means somebody grew a second writer or a second
    // reader of a collection surface — the one place that has to stay a decision
    // rather than a habit. (bootstrap.ts hands it to the meter AND the sweep;
    // bootstrap-http-deps.ts hands it to the read route. Every consumer takes a
    // `Pick<>` slice, so none of them can do the others' job.)
    // ⚠️ `billing/usage-tracker.ts` is excluded and it is worth saying why the
    // census SAW it: the string appears there inside the boot-time throw's
    // message ('bootstrap must pass `events: db.usageEvents`'), which is prose
    // in a string rather than a consumer. Excluding it by name rather than
    // widening the matcher keeps the census strict — and the fact that a plain
    // substring scan found it at all is the census working, not misfiring.
    // ── 2026-08-29 multi-node: now THREE, and the third is a structural split ──
    // `node/node-runtime.ts` holds the meter's construction, which moved out of
    // bootstrap.ts VERBATIM when multi-node wiring pushed that file over the
    // 800-line cap. It is not a new consumer — it is the SAME consumer at a new
    // address, and it is where the replica/writer tracker choice is made.
    // ── 2026-08-30: STILL THREE, and bootstrap.ts is no longer one of them ──
    // The retention leg moved to `bootstrap-sweeps.ts` for the SAME reason and
    // in the same shape (bootstrap.ts sat at exactly 800 again when the deadline
    // refund sweep needed arming). Same consumer, new address — and note that
    // this test is what NOTICED the move: it went red on a change that was
    // mechanically correct, which is precisely what a census is for. The count
    // is unchanged because nothing new consumes the sink.
    // ── 2026-08-30, second move in one day: the OPERATOR read went to
    // `bootstrap-ops-deps.ts` when bootstrap-http-deps.ts hit the same cap.
    //
    // 🔴 NOW FOUR FILES, AND THE COUNT WENT UP WITHOUT A NEW CONSUMER — which
    // is worth stating, because a census whose number rises usually means
    // somebody grew a reader. It did not: bootstrap-http-deps.ts was handing the
    // sink to TWO routes (the account's own `/api/cloud/usage/events` and the
    // operator's cross-account twin), and the split separated them. Same four
    // logical consumers — the retention sweep, the meter, the account read, the
    // operator read — at four addresses instead of three.
    expect(mentionsLiteral('db.usageEvents', ['billing/usage-tracker.ts']).sort()).toEqual([
      'bootstrap-http-deps.ts',
      'bootstrap-ops-deps.ts',
      'bootstrap-sweeps.ts',
      'node/node-runtime.ts',
    ]);
  });

  it('🔴 bootstrap really threads the SWITCH and the SINK into the meter', () => {
    // The 「not wired」 shape for this card would be a switch nobody reads: config
    // grows a field, the tracker grows a branch, and bootstrap never connects
    // them — every test in this file would still pass, because they all build
    // the tracker themselves.
    //
    // 🔴 2026-08-29 — THE THREADING NOW SPANS TWO FILES AND BOTH HALVES ARE
    // ASSERTED, plus the call between them. The meter's construction moved to
    // node/node-runtime.ts when bootstrap.ts crossed the 800-line cap; narrowing
    // this to whichever file still matched is the failure the sibling test four
    // blocks down names. The third assertion is not decoration: without it
    // node-runtime.ts could become an orphan with all of these still green.
    const strip = (f: string): string =>
      readFileSync(join(SRC, f), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    const boot = strip('bootstrap.ts');
    const runtime = strip('node/node-runtime.ts');
    const sweeps = strip('bootstrap-sweeps.ts');
    expect(runtime).toContain('usageEventsEnabled: config.usageEventsEnabled');
    expect(runtime).toContain('events: db.usageEvents');
    expect(boot).toContain('wireNodeRuntime(');
    // …the retention leg, deliberately NOT behind the switch. 🔴 2026-08-30: it
    // moved to bootstrap-sweeps.ts and the CALL is asserted beside it, for the
    // reason the paragraph above gives about node-runtime.ts — without the call
    // assertion the sweeps file could become an orphan with this still green.
    expect(sweeps).toContain('usageEvents: db.usageEvents');
    // 🔴 2026-09-01: bootstrap no longer names `startBackgroundSweeps` — the
    // assembly moved one door further out, to `startSweepsForBootstrap` in the
    // same file, so that `serviceRefunder` is built once instead of twice. BOTH
    // links are asserted: bootstrap calls the wrapper, and the wrapper calls the
    // sweeps. Asserting only the first would let the wrapper stop starting
    // anything with this test still green — which is the orphan the paragraph
    // above is about, moved one link along.
    expect(boot).toContain('startSweepsForBootstrap(');
    expect(sweeps).toContain('startBackgroundSweeps(');
  });

  it('recordQuotaRefusal is called from EXACTLY the two user-facing admission points', () => {
    // NOT from engine/stt-factory.ts, which is the THIRD `ensureQuota` site: that
    // one is a VALVE (this session gets no polish), not a refusal of anything the
    // user asked for, and recording it as 「was blocked」 would put a row on the user's
    // usage page for a turn that succeeded.
    //
    // ⚠️ THE QUESTION IS WHO *DECIDES* TO REFUSE. Two classes are excluded BY
    // NAME (so a third still has to be added on purpose): implementations of
    // UsageTracker, which PERFORM a decision made elsewhere — the local meter
    // and, since 2026-08-29, the forwarding one a replica installs — and
    // forwarded-write.ts, which REPLAYS a refusal another node decided on.
    // Listing a replay here would say this writer turned a user away; it did
    // not, it recorded that a replica did.
    expect(mentions('recordQuotaRefusal', [
      'billing/usage-tracker.ts',
      'node/forwarding-usage-tracker.ts',
      'node/forwarded-write.ts',
    ]).sort()).toEqual([
      'socket/handlers/audio.handler.ts',
      'socket/handlers/compose.handler.ts',
    ]);
  });

  it('the route module is mounted by the router, and its deps are built by bootstrap', () => {
    // 🔴 TWO FILES, ONE ROUTER, AND THE SPLIT IS WHY. `HttpDeps` moved VERBATIM
    // out of `http/router.ts` into `http/router-deps.ts` on 2026-08-12 because
    // router.ts stood at 795 of the 800-line cap (verify/lint/file-size.mjs).
    // So the MOUNT (the `tryHandle…` call) is still in router.ts and the DEP
    // FIELD's type now lives beside it in router-deps.ts. Both halves are still
    // asserted — an assertion narrowed to one file after a split is how a
    // wiring census quietly stops covering the thing it was built for.
    expect(mentions('tryHandleUsageEventsRoutes', ['http/usage-events-routes.ts'])).toEqual(['http/router.ts']);
    expect(mentions('UsageEventsRoutesDeps', ['http/usage-events-routes.ts']).sort()).toEqual(['http/router-deps.ts']);
  });

  it('the retention constant is read by the sweep AND surfaced on BOTH read surfaces', () => {
    // All three consumers matter: one enforces the horizon, the other two TELL
    // the reader it exists, so an empty tail is readable as 「it expired」 rather than
    // 「never used」. 🔴 The ops surface needs it MORE than the account one, because an
    // operator draws conclusions about a person from a blank page.
    expect(mentions('USAGE_EVENTS_RETENTION_DAYS', ['db/retention.ts']).sort()).toEqual([
      'http/ops-usage-events-routes.ts',
      'http/usage-events-routes.ts',
    ]);
  });

  it('the ops twin is mounted by the router and its deps are built by bootstrap', () => {
    // The same wiring census the account-side twin gets. A route module that
    // nothing mounts is the 「a capability was defined and nobody calls it」 shape with an HTTP path attached.
    // 🔴 2026-09-07 — THE ADDRESS CHANGED, THE PROPERTY DID NOT. The six
    // saas-only operator mounts moved out of router.ts into
    // `http/router-ops-mounts.ts` when that file stood at exactly the 800-line
    // cap and the REQ-002 pair could not be added without crossing it (the same
    // forced split that produced ops-refund-release-routes.ts). This assertion
    // still says the one thing it was written to say — SOMETHING mounts this
    // module — and it went red on the move rather than silently following it,
    // which is the whole reason it names a file.
    expect(mentions('tryHandleOpsUsageEventsRoutes', ['http/ops-usage-events-routes.ts'])).toEqual(['http/router-ops-mounts.ts']);
    expect(mentions('OpsUsageEventsRoutesDeps', ['http/ops-usage-events-routes.ts']).sort()).toEqual(['http/router-deps.ts']);
    // 🔴 And bootstrap really builds it — the dep field, not just the type.
    //
    // 🔴 2026-08-30 — THE OPERATOR SURFACES MOVED to `bootstrap-ops-deps.ts`
    // when bootstrap-http-deps.ts crossed the 800-line cap (gs-3 wired a refund
    // action and a mail channel into the purchase queue). Same construction, new
    // address. The CALL is asserted beside the field for the reason the sibling
    // case above states: without it the new file could become an orphan and this
    // would still be green.
    const ops = readFileSync(join(SRC, 'bootstrap-ops-deps.ts'), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    expect(ops).toContain('opsUsageEvents:');
    const boot = readFileSync(join(SRC, 'bootstrap-http-deps.ts'), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    expect(boot).toContain('opsHttpDeps(');
  });

  it('🔴 the quota guard still reads usage_records and has NO path to usage_events', () => {
    // The card's hardest constraint, as a grep: the month bucket stays the single
    // source of truth for enforcement. A `usageEvents` mention inside the guard
    // means somebody started enforcing on a table that shrinks on its own.
    const guard = readFileSync(join(SRC, 'billing', 'quota-guard.ts'), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    expect(guard).not.toContain('usageEvents');
    expect(guard).not.toContain('usage_events');
    expect(guard).toContain('usageRepo.get');
  });
});
