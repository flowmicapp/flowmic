// A2-5 / REQ-12-08 — the per-event usage log, end to end.
//
// SPEC-REF: docs/strategy/2026-08-12-req1208-usage-log-storage-audit-and-design.md
//             §5.2 (columns) §5.3 (write points + the two hard constraints)
//             §5.4 (retention) §5.5 (the read API) §5.6 (failure directions)
//             §6 (this file is that acceptance table)
//           src/db/schema.ts `-- 14. usage_events`
//           CLAUDE.md red line: no silent failure / one value answers one question / anti-façade
//           *** HUMAN-AUDIT SENSITIVE (billing + a new collection surface) ***
//
// FIVE blocks, in the order a reviewer needs them:
//   ① the repo            — the mechanism, against real sqlite;
//   ② the meter           — the switch, BYOK, ordering, and what a failed append
//                           may NOT cost;
//   ③ the call sites      — real handlers → real guard → real tracker → real DB,
//                           because 「the tracker has a method」 and 「production
//                           calls it」 are two different sentences;
//   ④ the read route      — a real saas server, a real Bearer;
//   ⑤ the census          — every new symbol has a production caller.
//
// The retention leg lives in test/retention-cleanup.test.ts (beside the
// `usage_records` exemption it must not break), and the migration lives in
// test/migration-idempotency.test.ts (beside the other twelve tables).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'socket.io';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { loadConfig } from '../src/config';
import { log } from '../src/log';
import { BillingService } from '../src/billing/billing-service';
import { makeQuotaGuard } from '../src/billing/quota-guard';
import {
  makeUsageTracker,
  RECORD_BYOK_EVENTS,
  USAGE_EVENTS_SWITCH_LOG,
  type UsageTracker,
} from '../src/billing/usage-tracker';
import { currentMonth } from '../src/db/repos/usage.repo';
import { USAGE_EVENTS_PAGE_MAX, type UsageEventsRepo } from '../src/db/repos/usage-events.repo';
import { USAGE_EVENTS_RETENTION_DAYS } from '../src/db/retention';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps } from '../src/socket/handlers/audio.handler';
import { registerComposeHandlers, type ComposeHandlerDeps } from '../src/socket/handlers/compose.handler';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { signJwt } from '../src/auth/jwt';

/** `src/`, for the two blocks that read source instead of behaviour (the BYOK
 *  toggle's shape, and the census at the bottom). Declared once, up here,
 *  because the census block is far below its first use. */
const SRC_FOR_TOGGLE = fileURLToPath(new URL('../src', import.meta.url));

const USER = 'u-events';
const OTHER = 'u-other';
const NOW = Date.parse('2026-08-12T00:00:00.000Z');
const MONTH = currentMonth(() => NOW);

/** A2-5 — the two character counts the metering seam carries
 *  ([[SttCharCounts]]). 🔴 THE TWO NUMBERS ARE DIFFERENT ON PURPOSE, in every
 *  fixture in this file: equal ones would let a wiring that passes ONE of them
 *  twice — or that swaps them — pass every assertion below. 41 > 38 is also the
 *  real-world direction (polish shortens more often than it lengthens). */
const CHARS = { transcript: 41, delivered: 38 } as const;

function freshDb(): DbConnection {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('usage-events-secret-32-bytes!!!') });
  db.users.insert({ id: USER, display_name: 'U', plan: 'free' });
  db.users.insert({ id: OTHER, display_name: 'O', plan: 'free' });
  return db;
}

/** Every row this account owns, oldest first. A wide-open window, because these
 *  assertions are about WHAT WAS WRITTEN, never about paging. */
function allEvents(db: DbConnection, userId = USER): ReturnType<UsageEventsRepo['listForUser']>['rows'] {
  return db.usageEvents.listForUser(userId, { from: 0, to: Number.MAX_SAFE_INTEGER, limit: 500 }).rows;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * ① THE REPO — the mechanism, against real sqlite.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('usage_events repo', () => {
  let db: DbConnection;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('append returns a STRICTLY INCREASING id, and that id is the paging cursor', () => {
    const a = db.usageEvents.append({ user_id: USER, occurred_at: NOW, kind: 'stt', stt_ms: 1, outcome: 'ok' });
    const b = db.usageEvents.append({ user_id: USER, occurred_at: NOW, kind: 'stt', stt_ms: 1, outcome: 'ok' });
    // Same millisecond on purpose: this is the case a timestamp cannot order,
    // and the reason the key is an AUTOINCREMENT integer (db/schema.ts).
    expect(b).toBeGreaterThan(a);
  });

  it('🔴 is_byok is stored as INTEGER 1/0 — never TEXT, never a JS boolean', () => {
    db.usageEvents.append({ user_id: USER, occurred_at: NOW, kind: 'stt', stt_ms: 5, is_byok: true, outcome: 'ok' });
    db.usageEvents.append({ user_id: USER, occurred_at: NOW, kind: 'stt', stt_ms: 5, is_byok: false, outcome: 'ok' });
    const raw = db.raw.prepare('SELECT is_byok, typeof(is_byok) AS t FROM usage_events ORDER BY id').all();
    // A TEXT '0' is TRUTHY in JS — the permanent_free trap. `typeof()` is the
    // only assertion that can tell 0 from '0' after the driver has coerced them.
    expect(raw).toEqual([{ is_byok: 1, t: 'integer' }, { is_byok: 0, t: 'integer' }]);
  });

  it('🔴 occurred_at is stored as INTEGER ms — a fractional input is rounded, not stored as REAL', () => {
    db.usageEvents.append({ user_id: USER, occurred_at: NOW + 0.4, kind: 'llm', tokens_in: 3, outcome: 'ok' });
    const raw = db.raw.prepare('SELECT occurred_at, typeof(occurred_at) AS t FROM usage_events').get();
    expect(raw).toEqual({ occurred_at: NOW, t: 'integer' });
  });

  it('an omitted channel is NULL — 「unknown」 is storable and is not invented', () => {
    db.usageEvents.append({ user_id: USER, occurred_at: NOW, kind: 'stt', stt_ms: 1, outcome: 'ok' });
    expect(allEvents(db)[0]?.channel).toBeNull();
  });

  it('the time window is half-open [from, to) — the boundary ms belongs to exactly one window', () => {
    db.usageEvents.append({ user_id: USER, occurred_at: 100, kind: 'stt', stt_ms: 1, outcome: 'ok' });
    db.usageEvents.append({ user_id: USER, occurred_at: 200, kind: 'stt', stt_ms: 1, outcome: 'ok' });
    expect(db.usageEvents.listForUser(USER, { from: 100, to: 200, limit: 10 }).rows.map((r) => r.occurred_at)).toEqual([100]);
    expect(db.usageEvents.listForUser(USER, { from: 200, to: 300, limit: 10 }).rows.map((r) => r.occurred_at)).toEqual([200]);
  });

  it('🔴 next_after_id is null ONLY when there is provably no next page — including an exactly-full last page', () => {
    // 4 rows, limit 2. The naive `rows.length < limit` test would call page 2
    // 「not the last」 forever; the limit+1 probe row is what gets this right.
    for (let i = 0; i < 4; i += 1) {
      db.usageEvents.append({ user_id: USER, occurred_at: NOW + i, kind: 'stt', stt_ms: 1, outcome: 'ok' });
    }
    const p1 = db.usageEvents.listForUser(USER, { from: 0, to: NOW + 99, limit: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.next_after_id).not.toBeNull();
    const p2 = db.usageEvents.listForUser(USER, { from: 0, to: NOW + 99, limit: 2, after_id: p1.next_after_id! });
    expect(p2.rows).toHaveLength(2); // exactly full…
    expect(p2.next_after_id).toBeNull(); // …and provably the last
  });

  it('listForUser never returns another account\'s rows (with a positive control that the other account HAS some)', () => {
    db.usageEvents.append({ user_id: OTHER, occurred_at: NOW, kind: 'stt', stt_ms: 7, outcome: 'ok' });
    expect(allEvents(db, USER)).toEqual([]);
    expect(allEvents(db, OTHER)).toHaveLength(1); // the probe is not blind
  });

  it('purgeOlderThan is scoped to ONE account and reports what it deleted', () => {
    db.usageEvents.append({ user_id: USER, occurred_at: 100, kind: 'stt', stt_ms: 1, outcome: 'ok' });
    db.usageEvents.append({ user_id: USER, occurred_at: 500, kind: 'stt', stt_ms: 1, outcome: 'ok' });
    db.usageEvents.append({ user_id: OTHER, occurred_at: 100, kind: 'stt', stt_ms: 1, outcome: 'ok' });
    expect(db.usageEvents.purgeOlderThan(USER, 400)).toBe(1);
    expect(allEvents(db, USER).map((r) => r.occurred_at)).toEqual([500]);
    expect(allEvents(db, OTHER)).toHaveLength(1); // the other account is untouched
    expect(db.usageEvents.purgeOlderThan(USER, 400)).toBe(0); // idempotent
  });

  it('a non-integer limit THROWS rather than guessing (the HTTP layer refuses before this)', () => {
    expect(() => db.usageEvents.listForUser(USER, { from: 0, to: 1, limit: 0 })).toThrow(RangeError);
    expect(() => db.usageEvents.listForUser(USER, { from: 0, to: 1, limit: 1.5 })).toThrow(RangeError);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ② THE METER — the switch, BYOK, ordering, and the failure direction.
 * ═════════════════════════════════════════════════════════════════════════════ */

/** The tracker built EXACTLY as bootstrap builds it, over a real DB. */
function tracker(db: DbConnection, enabled: boolean): UsageTracker {
  return makeUsageTracker(db.usage, {
    mode: 'saas',
    usageEventsEnabled: enabled,
    events: db.usageEvents,
    now: () => NOW,
  });
}

describe('the switch — FLOWMIC_USAGE_EVENTS_ENABLED', () => {
  let db: DbConnection;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('🔴 OFF (the default) ⇒ ZERO rows, while the month bucket is metered exactly as before', () => {
    const t = tracker(db, false);
    t.recordSttUsage(USER, { is_byok: false }, 60_000, CHARS);
    t.recordLlmUsage(USER, { is_byok: false }, 10, 20);
    t.recordQuotaRefusal(USER, 'stt', USER);

    expect(allEvents(db)).toEqual([]);
    // The positive control for that zero: metering DID happen, so the empty
    // table means 「the switch held」 and not 「the harness never fired」.
    expect(db.usage.get(USER, MONTH)).toMatchObject({ stt_minutes: 1, llm_tokens_in: 10, llm_tokens_out: 20 });
  });

  it('🔴 ON ⇒ rows are written, and the month bucket is IDENTICAL to the OFF run', () => {
    const t = tracker(db, true);
    t.recordSttUsage(USER, { is_byok: false }, 60_000, CHARS);
    t.recordLlmUsage(USER, { is_byok: false }, 10, 20);

    expect(allEvents(db).map((r) => ({ kind: r.kind, stt_ms: r.stt_ms, tokens_in: r.tokens_in, outcome: r.outcome }))).toEqual([
      { kind: 'stt', stt_ms: 60_000, tokens_in: 0, outcome: 'ok' },
      { kind: 'llm', stt_ms: 0, tokens_in: 10, outcome: 'ok' },
    ]);
    // Byte-for-byte the same billing as the OFF case above. The whole card is
    // additive, and this is the assertion that says so.
    expect(db.usage.get(USER, MONTH)).toMatchObject({ stt_minutes: 1, llm_tokens_in: 10, llm_tokens_out: 20 });
  });

  it('🔴 the default really is OFF in a config nobody configured', () => {
    // Read through loadConfig, not a hand-written `false`: the thing under test
    // is what an UNSET env var produces on a real deployment.
    const before = process.env.FLOWMIC_USAGE_EVENTS_ENABLED;
    delete process.env.FLOWMIC_USAGE_EVENTS_ENABLED;
    try {
      const base = { mode: 'saas' as const, secret: 'x'.repeat(32), port: 0, dbPath: ':memory:', trustedProxies: [] };
      expect(loadConfig(base).usageEventsEnabled).toBe(false);
      // …and it fails CLOSED on junk. A switch guarding a collection promise
      // must not turn itself on because somebody typed 「yes」.
      process.env.FLOWMIC_USAGE_EVENTS_ENABLED = 'yes';
      expect(loadConfig(base).usageEventsEnabled).toBe(false);
      process.env.FLOWMIC_USAGE_EVENTS_ENABLED = '1';
      expect(loadConfig(base).usageEventsEnabled).toBe(true);
    } finally {
      if (before === undefined) delete process.env.FLOWMIC_USAGE_EVENTS_ENABLED;
      else process.env.FLOWMIC_USAGE_EVENTS_ENABLED = before;
    }
  });

  it('🔴 the switch ANNOUNCES itself at startup, in BOTH directions', () => {
    // A switch nobody can observe is worse than no switch: an operator has to be
    // able to answer 「is this machine collecting per-event detail」 from the log alone. A line that only
    // appeared when ON would make its absence mean either 「it is off」 or 「this build has no
    // such switch」 — two different facts, one silence.
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    try {
      tracker(db, false);
      tracker(db, true);
      const lines = info.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith(USAGE_EVENTS_SWITCH_LOG));
      expect(lines).toEqual([`${USAGE_EVENTS_SWITCH_LOG} DISABLED`, `${USAGE_EVENTS_SWITCH_LOG} ENABLED`]);
      // The env var's NAME is in the payload, so an operator greps one string
      // and gets both the state and the knob that changes it.
      expect(info.mock.calls.at(-1)?.[1]).toMatchObject({ env: 'FLOWMIC_USAGE_EVENTS_ENABLED', enabled: true });
    } finally {
      info.mockRestore();
    }
  });

  it('🔴 ON with no sink REFUSES TO CONSTRUCT — 「enabled」 must never be a lie', () => {
    // The book 13 §7 F1 ② rule applied where it bites: an optional dep is allowed
    // only in the state where it is genuinely not needed (collection off). Turn
    // collection on without wiring a sink and the process fails at BOOT, not at
    // the first utterance.
    expect(() => makeUsageTracker(db.usage, { mode: 'saas', usageEventsEnabled: true })).toThrow(
      /no usage_events sink was wired/,
    );
    // …and the harmless combination is still harmless.
    expect(() => makeUsageTracker(db.usage, { mode: 'saas' })).not.toThrow();
  });
});

describe('BYOK — the one behaviour this card CHANGES', () => {
  let db: DbConnection;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('🔴 an own-key session gets a ROW (is_byok=1) and is billed NOTHING', () => {
    const t = tracker(db, true);
    t.recordSttUsage(USER, { is_byok: true }, 90_000, CHARS);
    t.recordLlmUsage(USER, { is_byok: true }, 11, 22);

    const rows = allEvents(db);
    expect(rows.map((r) => ({ kind: r.kind, is_byok: r.is_byok }))).toEqual([
      { kind: 'stt', is_byok: 1 },
      { kind: 'llm', is_byok: 1 },
    ]);
    // 🔴 THE HALF THAT MUST NOT MOVE: no month bucket exists at all.
    expect(db.usage.get(USER, MONTH)).toBeNull();
  });

  it('the toggle is a REAL toggle: the constant is true today, and the branch above reads it', () => {
    // 🔴 THE REVERSE CONTROL FOR THE TEST ABOVE WAS RUN BY HAND, and it is
    // recorded here rather than automated, because automating it would mean
    // stubbing an ESM binding the module reads directly — a mechanism the
    // production path does not have, i.e. a measurement of the wrong thing.
    //
    // 【measured 2026-08-12, LAN FABLE lead-dev machine】 with
    // `billing/usage-tracker.ts` edited to `RECORD_BYOK_EVENTS: boolean = false`
    // and nothing else changed, `npx vitest run test/usage-events.test.ts`:
    //
    //   AssertionError: expected [] to deeply equal
    //     [ { kind: 'stt', is_byok: 1 }, ...(1) ]        ← the row vanished
    //   AssertionError: expected false to be true        ← this assertion
    //   Tests  2 failed | 41 passed  (43)
    //
    // …and the `usage.get(...) === null` half stayed green in both directions,
    // which is the point: the toggle moves the RECORD and never the BILL.
    // Restored to `true` immediately; `grep -n "RECORD_BYOK_EVENTS: boolean"`
    // shows one line and it reads `= true`.
    expect(RECORD_BYOK_EVENTS).toBe(true);
    const src = readFileSync(join(SRC_FOR_TOGGLE, 'billing', 'usage-tracker.ts'), 'utf8');
    // The branch that consumes it, verbatim — so 「flip the constant」 stays a
    // one-line change and cannot quietly become a constant nothing reads.
    expect(src).toContain('engine.is_byok && !RECORD_BYOK_EVENTS');
  });
});

describe('quota refusals — 「zero minutes」 and 「was blocked」 are two statements', () => {
  let db: DbConnection;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('🔴 a refusal records stt_ms=0 AND outcome!=ok, and the two are DISTINGUISHABLE from a real zero', () => {
    const t = tracker(db, true);
    t.recordQuotaRefusal(USER, 'stt', USER);
    // The thing a refusal must not be confusable with: an `llm` event, whose
    // stt_ms is also 0 — and which succeeded.
    t.recordLlmUsage(USER, { is_byok: false }, 5, 5);

    const rows = allEvents(db);
    expect(rows.map((r) => ({ kind: r.kind, stt_ms: r.stt_ms, outcome: r.outcome }))).toEqual([
      { kind: 'stt', stt_ms: 0, outcome: 'quota_refused' },
      { kind: 'llm', stt_ms: 0, outcome: 'ok' },
    ]);
    // 🔴 THE POINT, as an assertion rather than a comment: the two rows have the
    // SAME numbers and DIFFERENT meanings. Anyone who folds `outcome` into the
    // counts makes these two rows identical.
    expect(rows[0]?.stt_ms).toBe(rows[1]?.stt_ms);
    expect(rows[0]?.outcome).not.toBe(rows[1]?.outcome);
  });

  it('🔴 2026-08-17 — the row says WHOSE QUOTA refused, which is not always whose attempt it was', () => {
    const t = tracker(db, true);
    // ① the acting account's own ceiling. The two ids AGREE, and the agreement
    //    is a measurement — the caller looked and found they were the same.
    t.recordQuotaRefusal(USER, 'stt', USER);
    // ② the QTA-2 shape: the phone acts, the paired PC OWNER's ledger says no.
    //    The row stays the ACTING account's (those are the minutes that would
    //    have been metered) and must stop asserting that THAT account is out.
    t.recordQuotaRefusal(USER, 'stt', OTHER);
    // ③ a successful row names nobody — nothing refused anything, and NULL is
    //    the only value that says so. Filling it with `user_id` here would put
    //    "not recorded" and "the acting account" back into one sentence.
    t.recordSttUsage(USER, { is_byok: false }, 60_000, CHARS);

    expect(db.raw.prepare('SELECT user_id, outcome, refused_user_id FROM usage_events ORDER BY id').all()).toEqual([
      { user_id: USER, outcome: 'quota_refused', refused_user_id: USER },
      { user_id: USER, outcome: 'quota_refused', refused_user_id: OTHER },
      { user_id: USER, outcome: 'ok', refused_user_id: null },
    ]);
    // 🔴 `user_id` DID NOT CHANGE MEANING (owner's ruling, 2026-08-17): all three
    // rows are still the acting account's, so a row written before this column
    // existed reads exactly as it always did. And the gate account gets no row
    // of its own — being asked is not being metered.
    expect(allEvents(db, OTHER)).toEqual([]);
  });

  it('🔴 C5 — every row the METER writes says channel=cloud, and none says lan', () => {
    // owner 2026-08-12: 「channel」 is the DELIVERY channel and the detail table
    // records only cloud-relay traffic. This layer answers that from a fact it
    // HAS (`config.mode`), which is why 'cloud' is a measurement here and was a
    // guess before the ruling.
    const t = tracker(db, true);
    t.recordSttUsage(USER, { is_byok: false }, 60_000, CHARS);
    t.recordLlmUsage(USER, { is_byok: false }, 5, 7);
    t.recordQuotaRefusal(USER, 'stt', USER);
    const channels = allEvents(db).map((r) => r.channel);
    expect(channels).toEqual(['cloud', 'cloud', 'cloud']);
    // 🔴 The negative half, stated as its own assertion because owner's ② is
    // explicit about it: nothing may start writing 'lan' 「for symmetry」. A row
    // with that value would not be new data — it would mean the mode gate was
    // widened.
    expect(channels).not.toContain('lan');
  });

  it('a refusal moves NO counter — it is not a metering call wearing a different name', () => {
    const t = tracker(db, true);
    t.recordQuotaRefusal(USER, 'llm', USER);
    expect(db.usage.get(USER, MONTH)).toBeNull();
  });

  it('standalone records nothing at all — there is no account layer and no quota to refuse', () => {
    const t = makeUsageTracker(db.usage, {
      mode: 'standalone', usageEventsEnabled: true, events: db.usageEvents, now: () => NOW,
    });
    t.recordSttUsage(USER, { is_byok: false }, 60_000, CHARS);
    t.recordQuotaRefusal(USER, 'stt', USER);
    expect(allEvents(db)).toEqual([]);
  });
});

describe('🔴 the failure direction — a broken event log may NEVER cost the meter or the session', () => {
  let db: DbConnection;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  /** A sink that always throws — a full disk, a locked page, a dropped table. */
  const brokenSink = { append(): number { throw new Error('disk on fire'); } };

  it('the month bucket is EXACT even though every append throws, and nothing propagates', () => {
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    try {
      const t = makeUsageTracker(db.usage, {
        mode: 'saas', usageEventsEnabled: true, events: brokenSink, now: () => NOW,
      });
      // 🔴 It MUST NOT throw. `recordSttUsage` is reached from a bare setTimeout
      // and from the shutdown loop (engine/stt-session.ts `dispose`), where an
      // uncaught throw kills the relay process.
      expect(() => t.recordSttUsage(USER, { is_byok: false }, 120_000, CHARS)).not.toThrow();
      expect(() => t.recordLlmUsage(USER, { is_byok: false }, 4, 6)).not.toThrow();
      expect(() => t.recordQuotaRefusal(USER, 'stt', USER)).not.toThrow();
      // The meter is untouched: this is the 「degrade to the month bucket staying accurate, the detail log missing one row」
      // direction the design chose (§5.6).
      expect(db.usage.get(USER, MONTH)).toMatchObject({ stt_minutes: 2, llm_tokens_in: 4, llm_tokens_out: 6 });
      // 🔴 AND IT IS NOT SILENT (red line, both directions): three failures, three
      // ERROR lines naming the table.
      const lines = errors.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('usage_events: append FAILED'));
      expect(lines).toHaveLength(3);
    } finally {
      errors.mockRestore();
    }
  });

  it('positive control: the SAME calls against a working sink log NO error', () => {
    // Without this, 「three error lines」 above could be a spy that sees
    // everything rather than a spy that saw these three.
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    try {
      const t = tracker(db, true);
      t.recordSttUsage(USER, { is_byok: false }, 120_000, CHARS);
      expect(errors.mock.calls.filter((c) => String(c[0]).startsWith('usage_events:'))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('🔴 the ORDER is increment-then-append: a throwing sink cannot prevent the bucket', () => {
    // The design's §6-1 reverse control, and it was RUN rather than reasoned.
    //
    // 【measured 2026-08-12, LAN FABLE lead-dev machine】 with the append moved ABOVE the
    // `repo.increment` call in `recordSttUsage` and nothing else changed,
    // `npx vitest run test/usage-events.test.ts`:
    //
    //   → expected [Function] to not throw an error but 'Error: disk on fire'
    //     was thrown            ← the throw now reaches the caller (FATAL on the
    //                             setTimeout / shutdown paths)
    //   → disk on fire          ← and this test's own bucket assertion never ran
    //   → expected [ Array(1) ] to deeply equal []   ← the OFF-switch test too:
    //                             the moved line bypassed `appendEvent`'s gate
    //   Tests  3 failed | 40 passed  (43)
    //
    // Restored; `grep -rn "REVERSE-CONTROL-A25" src/` = 0 hits (the only hits in
    // the tree are this paragraph), suite back to 43/43.
    // Note the SECOND failure above: moving the append also moved it
    // out from behind the switch — which is why the gate lives inside
    // `appendEvent` and not at each call site.
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    try {
      makeUsageTracker(db.usage, { mode: 'saas', usageEventsEnabled: true, events: brokenSink, now: () => NOW })
        .recordSttUsage(USER, { is_byok: false }, 60_000, CHARS);
      expect(db.usage.get(USER, MONTH)?.stt_minutes).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('the reconciliation relationship is <=, never =', () => {
  let db: DbConnection;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('🔴 after retention sweeps, SUM(usage_events) is LESS than usage_records — and that is correct', () => {
    const t = tracker(db, true);
    t.recordSttUsage(USER, { is_byok: false }, 60_000, CHARS);
    t.recordSttUsage(USER, { is_byok: false }, 60_000, CHARS);
    expect(db.usage.get(USER, MONTH)?.stt_minutes).toBe(2);

    // One of the two events ages out. (The sweep itself is tested in
    // retention-cleanup.test.ts; this asserts the CONSEQUENCE nobody may
    // 「fix」 by pointing the quota at the event table.)
    db.raw.prepare('UPDATE usage_events SET occurred_at = ? WHERE id = (SELECT MIN(id) FROM usage_events)').run(0);
    db.usageEvents.purgeOlderThan(USER, NOW - USAGE_EVENTS_RETENTION_DAYS * 86_400_000);

    const summed = allEvents(db).reduce((n, r) => n + r.stt_ms, 0) / 60_000;
    expect(summed).toBe(1);
    expect(db.usage.get(USER, MONTH)?.stt_minutes).toBe(2);
    expect(summed).toBeLessThan(db.usage.get(USER, MONTH)!.stt_minutes);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ③ THE CALL SITES — real handlers, real guard, real tracker, real DB.
 *
 * 「the tracker has a method」 and 「production calls it」 are two sentences, and
 * only the second one is worth anything (book 13 §7 F1 ③).
 * ═════════════════════════════════════════════════════════════════════════════ */

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: USER } };
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

const AUDIO_START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

/** guard + tracker wired the way bootstrap wires them, over `db`. */
function realWiring(db: DbConnection): { guard: ReturnType<typeof makeQuotaGuard>; usageTracker: UsageTracker } {
  const billing = new BillingService({
    settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: false, now: () => NOW,
  });
  return {
    guard: makeQuotaGuard(db.usage, { effectiveLimits: (u) => billing.effectiveLimits(u) }, { mode: 'saas', now: () => NOW }),
    usageTracker: tracker(db, true),
  };
}

describe('the production call sites really reach recordQuotaRefusal', () => {
  let db: DbConnection;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('🔴 audio:start over quota ⇒ ONE quota_refused row, written by the handler', () => {
    // Spend the whole free STT budget (20 minutes, billing/plans.ts).
    db.usage.increment(USER, MONTH, { stt_minutes: 999 });
    const { guard, usageTracker } = realWiring(db);
    const store = new RoomStore<FakeSocket>();
    const mobile = new FakeSocket('m');
    const deps: AudioHandlerDeps = {
      io: {} as unknown as import('socket.io').Server,
      guard,
      usageTracker,
      store: store as unknown as RoomStore<Socket>,
    };
    registerAudioHandlers(mobile as unknown as Socket, deps);

    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', AUDIO_START, (r) => { ack = r as Record<string, unknown>; });

    expect(ack?.error).toBe('QUOTA_EXCEEDED');
    expect(allEvents(db).map((r) => ({ kind: r.kind, stt_ms: r.stt_ms, outcome: r.outcome }))).toEqual([
      { kind: 'stt', stt_ms: 0, outcome: 'quota_refused' },
    ]);
  });

  it('positive control: the SAME handler with budget left writes NO refusal row', () => {
    // Otherwise the row above could be 「the handler always writes one」.
    const { guard, usageTracker } = realWiring(db);
    const store = new RoomStore<FakeSocket>();
    const mobile = new FakeSocket('m');
    registerAudioHandlers(mobile as unknown as Socket, {
      io: {} as unknown as import('socket.io').Server,
      guard,
      usageTracker,
      store: store as unknown as RoomStore<Socket>,
    });
    mobile.fire('audio:start', AUDIO_START, () => {});
    expect(allEvents(db)).toEqual([]);
  });

  /** One real audio:start through real handler → real guard → real tracker →
   *  real DB, with the PC OWNER account wired the way bootstrap wires it
   *  (QTA-2's `pcOwnerUserId`). Returns the ack so a caller can prove the
   *  refusal actually happened rather than inferring it from an empty table. */
  function fireAudioStart(conn: DbConnection, pcOwner: string): Record<string, unknown> | undefined {
    const { guard, usageTracker } = realWiring(conn);
    const mobile = new FakeSocket('m');
    registerAudioHandlers(mobile as unknown as Socket, {
      io: {} as unknown as import('socket.io').Server,
      guard,
      usageTracker,
      store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
      pcOwnerUserId: () => pcOwner,
    });
    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', AUDIO_START, (r) => { ack = r as Record<string, unknown>; });
    return ack;
  }

  it('🔴 a PC-owner-quota refusal names the PC OWNER as the refuser, on the PHONE account\'s row', () => {
    // The DESKTOP account is out of minutes; the phone's own budget is intact.
    // Before this card the row read "user_id=USER, quota_refused" and nothing
    // else — a sentence that was FALSE about USER.
    db.usage.increment(OTHER, MONTH, { stt_minutes: 999 });
    expect(fireAudioStart(db, OTHER)?.error).toBe('QUOTA_EXCEEDED');
    // 🔴 Taken at the HANDLER and not at the tracker: "the tracker has a third
    // parameter" and "audio.handler.ts forwards the JUDGED account" are two
    // different sentences, and only the second one repairs the row.
    expect(db.raw.prepare('SELECT user_id, outcome, refused_user_id FROM usage_events').all())
      .toEqual([{ user_id: USER, outcome: 'quota_refused', refused_user_id: OTHER }]);
    // The gate account is ASKED, never metered and never logged: QTA-2's rule
    // that one recording may not decrement two ledgers.
    expect(allEvents(db, OTHER)).toEqual([]);
  });

  it('positive control: the acting account\'s own refusal names ITSELF — equal, never absent', () => {
    // Without this row, an implementation that always wrote the PC owner's id —
    // or that wrote whatever the second gate last touched — passes the test
    // above perfectly. The PC owner here has budget and is never the refuser.
    db.usage.increment(USER, MONTH, { stt_minutes: 999 });
    expect(fireAudioStart(db, OTHER)?.error).toBe('QUOTA_EXCEEDED');
    expect(db.raw.prepare('SELECT user_id, refused_user_id FROM usage_events').all())
      .toEqual([{ user_id: USER, refused_user_id: USER }]);
  });

  it('🔴 compose:start over quota ⇒ ONE quota_refused row of kind llm', async () => {
    // `_out`: since owner 2026-08-14 only OUTPUT tokens accrue against the budget.
    db.usage.increment(USER, MONTH, { llm_tokens_out: 99_000_000 });
    const { guard, usageTracker } = realWiring(db);
    const store = new RoomStore<FakeSocket>();
    const mobile = new FakeSocket('m');
    const deps: ComposeHandlerDeps = {
      io: {} as unknown as import('socket.io').Server,
      guard,
      usageTracker,
      store: store as unknown as RoomStore<Socket>,
    };
    registerComposeHandlers(mobile as unknown as Socket, deps);

    let ack: Record<string, unknown> | undefined;
    mobile.fire('compose:start', { task: 'organize', source_text: 'x' }, (r) => { ack = r as Record<string, unknown>; });
    await Promise.resolve();

    expect(ack?.error).toBe('QUOTA_EXCEEDED');
    expect(allEvents(db).map((r) => ({ kind: r.kind, outcome: r.outcome }))).toEqual([
      { kind: 'llm', outcome: 'quota_refused' },
    ]);
    // 2026-08-17 — this leg has exactly ONE `ensureQuota` and exactly one
    // account (there is no PC-owner gate on compose:start), so the refuser is
    // the acting account and saying so is a measurement, not a filler. Pinned
    // here so that adding a second gate to this handler without revisiting the
    // refusal record turns this row red instead of shipping the STT leg's old
    // defect one file over.
    expect(db.raw.prepare('SELECT user_id, refused_user_id FROM usage_events').get())
      .toEqual({ user_id: USER, refused_user_id: USER });
  });

  it('🔴 the row carries the two REAL character counts, straight off the metering seam', () => {
    // 🔴 THIS IS THE ASSERTION THE CARD EXISTS FOR, and it is deliberately taken
    // at the HANDLER, not at the tracker: the tracker having a fourth parameter
    // and `audio.handler.ts` actually forwarding it are two different sentences,
    // and the second one is the one that was missing (the table was shipped with
    // the seam still carrying only ms and a billing flag).
    //
    // The factory seam is where a real `SttSessionBridge` sits in production; the
    // stand-in below plays the ONE part of it this test is about — calling
    // `onComplete` with what it transcribed.
    const { guard, usageTracker } = realWiring(db);
    const store = new RoomStore<FakeSocket>();
    const mobile = new FakeSocket('m');
    let seam: ((d: number, byok: boolean, chars: { transcript: number; delivered: number }) => void) | null = null;
    registerAudioHandlers(mobile as unknown as Socket, {
      io: {} as unknown as import('socket.io').Server,
      guard,
      usageTracker,
      store: store as unknown as RoomStore<Socket>,
      sttFactory: (args) => {
        seam = args.onComplete;
        return { pushChunk(): void {}, async finish(): Promise<void> {}, dispose(): void {} };
      },
    });
    mobile.fire('audio:start', AUDIO_START, () => {});
    expect(seam, 'the handler never built a session — the wiring, not the counts, is broken').not.toBeNull();

    seam!(60_000, false, CHARS);

    const rows = allEvents(db);
    expect(rows).toHaveLength(1);
    // 🔴 BOTH numbers, and both DISTINCT: an implementation that forwarded one
    // of them twice, or swapped them, passes any assertion that only checks
    // 「not zero」.
    expect(rows[0]).toMatchObject({
      kind: 'stt',
      stt_ms: 60_000,
      transcript_chars: CHARS.transcript,
      delivered_chars: CHARS.delivered,
    });
    // …and the month bucket is untouched by the new columns.
    expect(db.usage.get(USER, MONTH)?.stt_minutes).toBe(1);
  });

  it('🔴 the legs that do NOT measure text store NULL, never 0 — 「not measured」 is not 「zero」', () => {
    // The 「no permanently-zero column」 rule, as an assertion. If these two ever
    // read 0 instead of null, the columns have quietly become the pair of dead
    // zeros this card was told not to build — and a user's usage page would show
    // 「0 characters」 beside every AI turn as though we had counted.
    const t = tracker(db, true);
    t.recordLlmUsage(USER, { is_byok: false }, 12, 34);
    t.recordQuotaRefusal(USER, 'stt', USER);
    const rows = allEvents(db);
    expect(rows.map((r) => ({ k: r.kind, o: r.outcome, tc: r.transcript_chars, dc: r.delivered_chars }))).toEqual([
      { k: 'llm', o: 'ok', tc: null, dc: null },
      { k: 'stt', o: 'quota_refused', tc: null, dc: null },
    ]);
    // 🔴 The storage-face half: `null` and `0` are indistinguishable through a
    // JS falsy check, so the column's own type is what gets asserted. A NOT NULL
    // DEFAULT 0 column would answer 'integer' here.
    const raw = db.raw.prepare('SELECT typeof(transcript_chars) AS t FROM usage_events ORDER BY id').all();
    expect(raw).toEqual([{ t: 'null' }, { t: 'null' }]);
  });

  it('a measured ZERO is stored as 0 and stays distinguishable from 「not measured」', () => {
    // The positive control for the test above: an utterance that consumed audio
    // and produced no text is a REAL zero, and it must not be flattened to null.
    // Without this, 「always null」 would pass the previous test perfectly.
    const t = tracker(db, true);
    t.recordSttUsage(USER, { is_byok: false }, 30_000, { transcript: 0, delivered: 0 });
    expect(allEvents(db)[0]).toMatchObject({ transcript_chars: 0, delivered_chars: 0 });
    expect(db.raw.prepare('SELECT typeof(transcript_chars) AS t FROM usage_events').get()).toEqual({ t: 'integer' });
  });

  it('🔴 a NON-quota failure in the same catch writes NOTHING — the row must not name the wrong cause', () => {
    // `ensureQuota` also reaches `effectiveLimits`, which can fail for reasons
    // that are not a refusal. A row saying 「blocked by quota」 about a lookup that
    // exploded is worse than no row, so the write is gated on the CODE.
    const store = new RoomStore<FakeSocket>();
    const mobile = new FakeSocket('m');
    registerAudioHandlers(mobile as unknown as Socket, {
      io: {} as unknown as import('socket.io').Server,
      guard: { ensureQuota(): void { throw new Error('limits lookup exploded'); }, remainingSttMs: () => Infinity },
      usageTracker: tracker(db, true),
      store: store as unknown as RoomStore<Socket>,
    });
    mobile.fire('audio:start', AUDIO_START, () => {});
    expect(allEvents(db)).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ④ THE READ ROUTE — a real saas server, a real Bearer.
 * ═════════════════════════════════════════════════════════════════════════════ */

const SECRET = 'usage-events-route-secret-32-bytes-x';
/** A recognisable string that really is stored for this account, used as the
 *  POSITIVE CONTROL for 「the response body contains no transcript text」. */
const RECOGNISABLE = 'FLOWMIC-TRANSCRIPT-CANARY-9f3a';

describe('GET /api/cloud/usage/events', () => {
  let server: BootstrapHandle | null = null;
  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  async function saas(): Promise<{ url: string; handle: BootstrapHandle }> {
    // fix-010: an in-process server has no proxy in front of it — its direct
    // peer IS the client (config.ts §trustedProxies).
    //
    // 🔴 The switch is left at its DEFAULT (off). The read surface is mounted
    // regardless — 404-ing it when collection is off would make 「this deployment has no such
    // route」 and 「there are no records in this window」 the same answer — and every row below is
    // written through the repo, which is the mechanism the switch does not gate.
    const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [] });
    server = await startServer(config);
    return { url: `http://127.0.0.1:${server.port}`, handle: server };
  }

  async function account(url: string, handle: BootstrapHandle, email: string): Promise<{ id: string; headers: Record<string, string> }> {
    const res = await fetch(`${url}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'longenough1', display_name: 'N' }),
    });
    const json = (await res.json()) as { token: string; user: { id: string } };
    handle.db.emailVerification.markVerified(json.user.id, Date.now());
    return { id: json.user.id, headers: { authorization: `Bearer ${json.token}` } };
  }

  async function get(url: string, qs: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    const res = await fetch(`${url}/api/cloud/usage/events${qs}`, { headers });
    return { status: res.status, body: await res.text() };
  }

  it('an anonymous caller gets a NAMED 401, never an empty page', async () => {
    const { url } = await saas();
    const r = await get(url, '?from=0&to=1');
    expect(r.status).toBe(401);
    // An empty list is an ANSWER, and answering 「you have no usage」 to someone who
    // never proved who they are is both a lie and an oracle.
    expect(JSON.parse(r.body).error).toBe('AUTH_TOKEN_INVALID');
    expect(r.body).not.toContain('rows');
  });

  it('an UNVERIFIED account gets 403 EMAIL_NOT_VERIFIED (gated like every /api/cloud feature)', async () => {
    const { url, handle } = await saas();
    const res = await fetch(`${url}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'unverified@events.co', password: 'longenough1', display_name: 'U' }),
    });
    const json = (await res.json()) as { token: string; user: { id: string } };
    const bearer = { authorization: `Bearer ${json.token}` };
    const r = await get(url, '?from=0&to=1', bearer);
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe('EMAIL_NOT_VERIFIED');
    // 🔴 POSITIVE CONTROL: verify the SAME account and the SAME request is
    // admitted. Without it the 403 could equally mean 「the route was never mounted」 or 「the Bearer is
    // broken」 — three different problems that all look like one number.
    handle.db.emailVerification.markVerified(json.user.id, Date.now());
    expect((await get(url, '?from=0&to=1', bearer)).status).toBe(200);
  });

  it('refuses junk parameters BY NAME, and clamps nothing', async () => {
    const { url, handle } = await saas();
    const me = await account(url, handle, 'params@events.co');

    for (const qs of [
      '', // no window at all
      '?to=100', // half a window
      '?from=100', // the other half
      '?from=abc&to=100',
      '?from=-1&to=100',
      '?from=200&to=100', // inverted, refused rather than swapped
      '?from=0&to=100&limit=0',
      '?from=0&to=100&limit=abc',
      `?from=0&to=100&limit=${USAGE_EVENTS_PAGE_MAX + 1}`, // 🔴 REFUSED, not clamped
      '?from=0&to=100&after_id=0',
      '?from=0&to=100&after_id=-3',
    ]) {
      const r = await get(url, qs, me.headers);
      expect(r.status, `「${qs}」 should have been refused`).toBe(400);
      expect(JSON.parse(r.body).error).toBe('SETTINGS_SCHEMA_INVALID');
    }
    // 🔴 THE POSITIVE CONTROL for eleven 400s: the boundary values that ARE
    // legal really are accepted, so the refusals above are not 「this route
    // always 400s」.
    const ok = await get(url, `?from=0&to=100&limit=${USAGE_EVENTS_PAGE_MAX}`, me.headers);
    expect(ok.status).toBe(200);
    const okMin = await get(url, '?from=0&to=100&limit=1&after_id=1', me.headers);
    expect(okMin.status).toBe(200);
  });

  it('🔴 the scope is the Bearer: another account\'s rows are unreachable, and there is no user_id to forge', async () => {
    const { url, handle } = await saas();
    const me = await account(url, handle, 'mine@events.co');
    const them = await account(url, handle, 'theirs@events.co');
    handle.db.usageEvents.append({ user_id: them.id, occurred_at: 1_000, kind: 'stt', stt_ms: 4242, outcome: 'ok' });

    // Asking for THEIR id does not widen the scope — the parameter does not
    // exist, so it is ignored rather than refused, and the answer is still mine.
    const forged = await get(url, `?from=0&to=9999&user_id=${them.id}`, me.headers);
    expect(forged.status).toBe(200);
    expect(JSON.parse(forged.body).rows).toEqual([]);
    expect(forged.body).not.toContain('4242');
    expect(forged.body).not.toContain(them.id);

    // 🔴 POSITIVE CONTROL: the row really exists and is really reachable — by
    // its owner. Without this, the empty page above could mean 「the route is
    // broken」 rather than 「the scope held」.
    const theirs = await get(url, '?from=0&to=9999', them.headers);
    expect(JSON.parse(theirs.body).rows).toHaveLength(1);
    expect(theirs.body).toContain('4242');
  });

  it('pages by keyset, and next_after_id is the ONLY end-of-pages signal', async () => {
    const { url, handle } = await saas();
    const me = await account(url, handle, 'paging@events.co');
    for (let i = 0; i < 5; i += 1) {
      handle.db.usageEvents.append({ user_id: me.id, occurred_at: 1_000 + i, kind: 'stt', stt_ms: 10 + i, outcome: 'ok' });
    }

    const seen: number[] = [];
    let cursor: number | null = null;
    let guardRail = 0;
    do {
      const qs = `?from=0&to=9999&limit=2${cursor === null ? '' : `&after_id=${cursor}`}`;
      const page = JSON.parse((await get(url, qs, me.headers)).body) as {
        rows: { id: number }[]; next_after_id: number | null; retention_days: number; from: number; to: number;
      };
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.next_after_id;
      expect(page.retention_days).toBe(USAGE_EVENTS_RETENTION_DAYS);
      expect(page).toMatchObject({ from: 0, to: 9999 });
      guardRail += 1;
      expect(guardRail, 'the cursor never went null — an infinite page loop').toBeLessThan(10);
    } while (cursor !== null);

    expect(seen).toHaveLength(5);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen); // strictly ascending, no repeats
    expect(new Set(seen).size).toBe(5);
  });

  it('🔴 the response body carries NO transcript text — with a positive control that the string IS in the database', async () => {
    const { url, handle } = await saas();
    const me = await account(url, handle, 'canary@events.co');
    // Where this account's own text really lives, written through the repo: the
    // blind store.
    handle.db.timeline.push(me.id, [
      { id: `blob-${me.id}`, ciphertext: `e2e:v1:${RECOGNISABLE}`, created_at: Date.now(), schema_ver: 1 },
    ]);
    handle.db.usageEvents.append({ user_id: me.id, occurred_at: 1_000, kind: 'stt', stt_ms: 60_000, outcome: 'ok' });

    // POSITIVE CONTROL: the canary really is stored, so 「not in the body」 below
    // cannot mean 「the probe had nothing to find」.
    const stored = handle.db.raw
      .prepare("SELECT COUNT(*) AS n FROM timeline_blobs WHERE ciphertext LIKE '%' || ? || '%'")
      .get(RECOGNISABLE) as { n: number };
    expect(Number(stored.n)).toBe(1);

    const r = await get(url, '?from=0&to=9999', me.headers);
    expect(r.status).toBe(200);
    // Asserted on the WHOLE serialized body, not on a field name a nested echo
    // could slip past (the M2-7 shape).
    expect(r.body).not.toContain(RECOGNISABLE);
    // …and the row's shape is the whitelist, exactly. A future column that leaks
    // content has to get past this line first.
    const rows = (JSON.parse(r.body) as { rows: Record<string, unknown>[] }).rows;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'channel', 'delivered_chars', 'id', 'is_byok', 'kind', 'occurred_at', 'outcome',
      'stt_ms', 'tokens_in', 'tokens_out', 'transcript_chars', 'user_id',
    ]);
    // 🔴 A2-5 — the two character counts are on the wire, and they are COUNTS.
    // This assertion sits directly under the 「no transcript text」 one on
    // purpose: a count is a function OF the content, so the line between them is
    // the whole privacy argument (docs/legal/privacy-policy.md 「counts only —
    // not excerpts, keywords, or summaries」). If a future column ever carries a
    // prefix or a keyword list, it has to get past the assertion above first.
    // `channel` comes back as NULL here — and that is still correct AFTER the C5
    // ruling, because this row was appended THROUGH THE REPO, not through the
    // meter. The repo invents nothing; the meter is the layer that knows the
    // deployment is the cloud relay and stamps 'cloud' (see the C5 block in the
    // meter's own describe). Two different questions, and this assertion is
    // deliberately about the one that says 「unknown」 is still storable.
    expect(rows[0]!.channel).toBeNull();
  });

  it('an empty window says so WITH its horizon, so a blank is not readable as 「you have never used it」', async () => {
    const { url, handle } = await saas();
    const me = await account(url, handle, 'empty@events.co');
    const r = await get(url, '?from=0&to=1', me.headers);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ from: 0, to: 1, rows: [], next_after_id: null, retention_days: 90 });
  });

  it('standalone does not mount it at all (404) — the absence is the MODE, not a permission', async () => {
    server = await startServer(loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' }));
    const r = await get(`http://127.0.0.1:${server.port}`, '?from=0&to=1');
    expect(r.status).toBe(404);
  });

  /* ── ④b THE OPS-SIDE TWIN — the same table, the opposite trust model ────── */

  async function opsGet(url: string, qs: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    const res = await fetch(`${url}/api/ops/usage/events${qs}`, { headers });
    return { status: res.status, body: await res.text() };
  }

  /** A real admin. The flag is written through `UserRepo.insert` — the ONLY
   *  writer of that column — and the token is a real HS256 JWT this running
   *  server verifies for itself. */
  function adminBearer(handle: BootstrapHandle): { id: string; headers: Record<string, string> } {
    const user = handle.db.users.insert({ id: 'u-ops-admin', email: 'ops@events.co', display_name: 'A', is_admin: true });
    handle.db.emailVerification.markVerified(user.id, Date.now());
    const token = signJwt({ sub: user.id, plan: user.plan }, { secret: Buffer.from(SECRET, 'utf8') });
    return { id: user.id, headers: { authorization: `Bearer ${token}` } };
  }

  it('🔴 admin-gated: anonymous 401, a normal account 403 ADMIN_ONLY, and an ADMIN is let through', async () => {
    const { url, handle } = await saas();
    const normal = await account(url, handle, 'normal@ops-events.co');
    const admin = adminBearer(handle);
    const q = `?user_id=${normal.id}&from=0&to=9999`;

    const anon = await opsGet(url, q);
    expect(anon.status).toBe(401);
    expect(JSON.parse(anon.body).error).toBe('AUTH_TOKEN_INVALID');

    const asNormal = await opsGet(url, q, normal.headers);
    expect(asNormal.status).toBe(403);
    expect(JSON.parse(asNormal.body).error).toBe('ADMIN_ONLY');
    // 🔴 A refusal must not leak the answer it refused: no `rows` key at all.
    expect(asNormal.body).not.toContain('rows');

    // 🔴 THE POSITIVE HALF. Without it the 403 above could equally mean 「the route was never
    // mounted」 — one number, three different problems.
    const asAdmin = await opsGet(url, q, admin.headers);
    expect(asAdmin.status).toBe(200);
  });

  it('🔴 an admin really reads ANOTHER account\'s rows — the property the account-side route refuses to have', async () => {
    const { url, handle } = await saas();
    const target = await account(url, handle, 'target@ops-events.co');
    const admin = adminBearer(handle);
    handle.db.usageEvents.append({
      user_id: target.id, occurred_at: 1_000, kind: 'stt', stt_ms: 4242, outcome: 'ok',
      transcript_chars: 41, delivered_chars: 38,
    });
    // A row belonging to somebody ELSE, so 「it returned the caller's own rows」
    // cannot masquerade as success.
    handle.db.usageEvents.append({ user_id: admin.id, occurred_at: 1_000, kind: 'llm', tokens_in: 7, outcome: 'ok' });

    const r = await opsGet(url, `?user_id=${target.id}&from=0&to=9999`, admin.headers);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { user_id: string; rows: Record<string, unknown>[]; retention_days: number };
    expect(body.user_id).toBe(target.id);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ stt_ms: 4242, transcript_chars: 41, delivered_chars: 38 });
    expect(body.retention_days).toBe(USAGE_EVENTS_RETENTION_DAYS);
    // The admin's OWN row is not in this page — the scope is the parameter, not
    // the Bearer, and that is the whole difference from the twin above.
    expect(r.body).not.toContain('"tokens_in":7');
  });

  it('🔴 the audit trail records the ROUTE and never the caller-supplied account id', async () => {
    // The reason the path is `?user_id=` rather than `/:id`: ADMIN_GATED_ROUTES
    // is a fence of literals so a caller's byte CANNOT become `target_id`. This
    // asserts the property that fence exists to buy.
    const { url, handle } = await saas();
    const target = await account(url, handle, 'audited@ops-events.co');
    const admin = adminBearer(handle);
    await opsGet(url, `?user_id=${target.id}&from=0&to=9999`, admin.headers);

    const rows = handle.db.opsAudit.listRecent(10);
    const mine = rows.filter((r) => r.target_id === 'GET /api/ops/usage/events');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ actor_user_id: admin.id, action: 'ops.admin.granted', target_kind: 'route' });
    // 🔴 The account id reached the handler and NOT the trail.
    expect(rows.some((r) => (r.target_id ?? '').includes(target.id))).toBe(false);
  });

  it('refuses junk parameters BY NAME — including a MISSING user_id, which has no default', async () => {
    const { url, handle } = await saas();
    const admin = adminBearer(handle);
    for (const qs of [
      '?from=0&to=100', // 🔴 no user_id: there is no 「default to somebody」
      '?user_id=%20&from=0&to=100', // whitespace is not an account id
      `?user_id=${admin.id}`, // no window
      `?user_id=${admin.id}&from=200&to=100`, // inverted, refused not swapped
      `?user_id=${admin.id}&from=0&to=100&limit=${USAGE_EVENTS_PAGE_MAX + 1}`, // refused, not clamped
      `?user_id=${admin.id}&from=0&to=100&after_id=0`,
    ]) {
      const r = await opsGet(url, qs, admin.headers);
      expect(r.status, `「${qs}」 should have been refused`).toBe(400);
      expect(JSON.parse(r.body).error).toBe('SETTINGS_SCHEMA_INVALID');
    }
    // The positive control for six 400s.
    expect((await opsGet(url, `?user_id=${admin.id}&from=0&to=100`, admin.headers)).status).toBe(200);
  });

  it('an unknown user_id is an honest EMPTY page, not a 404 — this route cannot tell the two apart', async () => {
    // Deliberately different from POST /api/ops/users/restrict, which 404s a
    // typo'd id. There the answer reports an ACTION; here nothing is acted on,
    // and this module holds no `UserRepo` to ask 「does this account exist」 with. Inventing
    // a 404 from an empty page would be a guess.
    const { url, handle } = await saas();
    const admin = adminBearer(handle);
    const r = await opsGet(url, '?user_id=nobody-at-all&from=0&to=9999', admin.headers);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).rows).toEqual([]);
  });

  it('standalone does not mount the ops twin either (404)', async () => {
    server = await startServer(loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' }));
    const r = await opsGet(`http://127.0.0.1:${server.port}`, '?user_id=x&from=0&to=1');
    expect(r.status).toBe(404);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ⑤ THE CENSUS — every new symbol has a PRODUCTION caller.
 *
 * Anti-façade: 「a capability was defined and nobody calls it」 is this repo's number-one historical bug class,
 * and a whole card's worth of new symbols is exactly where it lands.
 * ═════════════════════════════════════════════════════════════════════════════ */

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
    expect(mentionsLiteral('db.usageEvents', ['billing/usage-tracker.ts']).sort())
      .toEqual(['bootstrap-http-deps.ts', 'bootstrap.ts']);
  });

  it('🔴 bootstrap really threads the SWITCH and the SINK into the meter', () => {
    // The 「not wired」 shape for this card would be a switch nobody reads: config
    // grows a field, the tracker grows a branch, and bootstrap never connects
    // them — every test in this file would still pass, because they all build
    // the tracker themselves.
    const boot = readFileSync(join(SRC, 'bootstrap.ts'), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    expect(boot).toContain('usageEventsEnabled: config.usageEventsEnabled');
    expect(boot).toContain('events: db.usageEvents');
    // …and the retention leg, which is deliberately NOT behind the switch.
    expect(boot).toContain('usageEvents: db.usageEvents');
  });

  it('recordQuotaRefusal is called from EXACTLY the two user-facing admission points', () => {
    // NOT from engine/stt-factory.ts, which is the THIRD `ensureQuota` site: that
    // one is a VALVE (this session gets no polish), not a refusal of anything the
    // user asked for, and recording it as 「was blocked」 would put a row on the user's
    // usage page for a turn that succeeded.
    expect(mentions('recordQuotaRefusal', ['billing/usage-tracker.ts']).sort()).toEqual([
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
    expect(mentions('tryHandleOpsUsageEventsRoutes', ['http/ops-usage-events-routes.ts'])).toEqual(['http/router.ts']);
    expect(mentions('OpsUsageEventsRoutesDeps', ['http/ops-usage-events-routes.ts']).sort()).toEqual(['http/router-deps.ts']);
    // 🔴 And bootstrap really builds it — the dep field, not just the type.
    const boot = readFileSync(join(SRC, 'bootstrap-http-deps.ts'), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    expect(boot).toContain('opsUsageEvents:');
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
