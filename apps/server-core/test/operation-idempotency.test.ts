// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A7-2 (the two keys, the assertion standard), §A9 stage 3, card PR-2
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//   apps/server-core/src/db/repos/usage-effects.repo.ts (the transaction)
//   apps/server-core/src/db/repos/recovery-operations.repo.ts (the registry)
//   apps/server-core/src/node/forwarding-usage-tracker.ts (the replica leg)
//
// Card PR-2's behaviour, asserted the way §A7-2 requires and NOT the way that is
// easier:
//
// 🔴 THE ASSERTION IS ON THE PERSISTED COUNTER, NEVER ON A CALL COUNT.
// 「recordSttUsage was called once」 is a statement about our own code reaching a
// line. What a user disputes is their bill, and the thing a bill is derived from
// is `usage_records` — so every metering assertion below reads the row back
// through `usage.repo`. A spy-based version of this file would stay green
// against a tracker that called through twice into a broken ledger.
//
// ⚠️ AND THE WORD 「exactly-once」 DOES NOT APPEAR, on purpose (§A7-2). What is
// proven here is that the ACCOUNT moves once. The vendor is a different question
// and under ruling O-9 (乙) it may well be asked twice — a re-send IS
// re-recognised, and that cost is ours.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeUsageTracker } from '../src/billing/usage-tracker';
import { makeForwardingUsageTracker, operationRecordId } from '../src/node/forwarding-usage-tracker';
import { makeForwardLedger } from '../src/node/forward-ledger';
import { makeForwardReceiver } from '../src/node/forward-receiver';
import { claimInCallerTransaction } from '../src/db/repos/usage-effects.repo';
import {
  admitOperation,
  OPERATION_CONFLICT_CODE,
  OPERATION_REGISTRY_UNWIRED_CODE,
} from '../src/socket/handlers/audio-start-operation';
import { ERROR_CODES, ERROR_CODE_LIST } from '@flowmic/protocol';
import { vendorNoAudioIsOurSilence } from '../src/stt/empty-final-verdicts';
import type { ForwardedWrite } from '../src/node/forwarded-write';
import type { OutboxRecord } from '../src/db/replica-outbox';

const MONTH = '2026-09';
const NO_TEXT_MEASURED = { transcript: 0, delivered: 0 } as const;
const KEY = deriveKey('test-secret-32-bytes-or-more-xx');

let db: DbConnection;

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: KEY });
  db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
  db.users.insert({ id: 'u2', display_name: 'V', plan: 'free' });
});
afterEach(() => { db.close(); });

function tracker(): ReturnType<typeof makeUsageTracker> {
  return makeUsageTracker(db.usage, {
    mode: 'saas',
    periodKeyFor: () => MONTH,
    operations: db.usageEffects,
  });
}

/**
 * The WRITER's tracker for a record forwarded by a replica — the one
 * node-runtime.ts builds as `replayUsage`. It differs from {@link tracker} in
 * exactly one way, and that way is audit F1's fix: the claim is taken inside the
 * caller's transaction (`forward-ledger.once`'s `BEGIN IMMEDIATE`) instead of
 * opening its own.
 */
function replayTracker(): ReturnType<typeof makeUsageTracker> {
  return makeUsageTracker(db.usage, {
    mode: 'saas',
    periodKeyFor: () => MONTH,
    operations: claimInCallerTransaction(db.usageEffects),
  });
}

/** The persisted counters, read back the way the quota guard and the console
 *  read them. This — not a call count — is what every assertion below is about. */
function meter(user = 'u1'): { minutes: number; tokensIn: number; tokensOut: number } {
  const row = db.usage.get(user, MONTH);
  return {
    minutes: row?.stt_minutes ?? 0,
    tokensIn: row?.llm_tokens_in ?? 0,
    tokensOut: row?.llm_tokens_out ?? 0,
  };
}

describe('metering_effect_once — the same operation, two full cycles, one charge', () => {
  it('🔴 STT: two start/stop cycles on one operation move the persisted minutes once', () => {
    const t = tracker();
    // Cycle one: the recording is transcribed and the account is metered.
    t.recordSttUsage('u1', { is_byok: false }, 120_000, NO_TEXT_MEASURED, 'op-A');
    expect(meter().minutes).toBeCloseTo(2, 6);

    // Cycle two: the SAME operation is re-sent. Under ruling O-9 (乙) the audio is
    // recognised again — this call really happens, the vendor really runs — and
    // the account must not move.
    t.recordSttUsage('u1', { is_byok: false }, 120_000, NO_TEXT_MEASURED, 'op-A');
    expect(meter().minutes).toBeCloseTo(2, 6);

    // The claim row is the mechanism, and there is exactly one of it.
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM usage_effects WHERE user_id='u1' AND operation_id='op-A'").get(),
    ).toEqual({ n: 1 });
  });

  it('🔴 LLM: the same, on the other counter — and the two do not swallow each other', () => {
    const t = tracker();
    t.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-B');
    t.recordLlmUsage('u1', { is_byok: false }, 300, 700, 'op-B');
    expect(meter()).toEqual({ minutes: 1, tokensIn: 300, tokensOut: 700 });

    // Re-send: both legs replay, neither counter moves. If `kind` were not part
    // of the key, the second of these two would have been discarded as a
    // duplicate of the FIRST on the first pass — i.e. the polish tokens would
    // never have been billed at all, and the row above would already be wrong.
    t.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-B');
    t.recordLlmUsage('u1', { is_byok: false }, 300, 700, 'op-B');
    expect(meter()).toEqual({ minutes: 1, tokensIn: 300, tokensOut: 700 });
  });

  it('the key is per ACCOUNT — the same operation id from another account bills that account', () => {
    // The positive control for the zeros above: the ledger is keyed on the pair,
    // so a matching operation id alone must not suppress anything. Without this,
    // a ledger that ignored `user_id` would pass every other test in this file.
    const t = tracker();
    t.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-shared');
    t.recordSttUsage('u2', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-shared');
    expect(meter('u1').minutes).toBeCloseTo(1, 6);
    expect(meter('u2').minutes).toBeCloseTo(1, 6);
  });

  it('🔴 a session with NO operation_id meters twice — today\'s behaviour, byte for byte', () => {
    // The other positive control, and the more important one: this card must not
    // quietly start deduplicating ordinary presses. Two separate recordings of
    // the same length are two charges, because they are two recordings.
    const t = tracker();
    t.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED);
    t.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED);
    expect(meter().minutes).toBeCloseTo(2, 6);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM usage_effects').get()).toEqual({ n: 0 });
  });

  it('an increment that throws leaves NO claim behind, so the next attempt is a retry', () => {
    // The whole reason the claim and the effect share a transaction. Claim-then-
    // apply would have spent the key here and lost the minutes forever, silently,
    // looking like success from both ends (node/forward-ledger.ts's argument).
    let boom = true;
    const failing = makeUsageTracker(
      {
        ...db.usage,
        increment: (u, m, d) => {
          if (boom) throw new Error('disk full');
          return db.usage.increment(u, m, d);
        },
      },
      { mode: 'saas', periodKeyFor: () => MONTH, operations: db.usageEffects },
    );
    expect(() => failing.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-C')).toThrow('disk full');
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM usage_effects').get()).toEqual({ n: 0 });
    expect(meter().minutes).toBe(0);

    boom = false;
    failing.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-C');
    expect(meter().minutes).toBeCloseTo(1, 6);
  });
});

describe('operation_binding_immutable — a re-send that changed is refused, not honoured', () => {
  const BINDING = {
    operation_id: 'op-1',
    recording_id: 'rec-1',
    range_start_sample: 0,
    range_end_sample: 16_000,
    attempt_kind: 'live',
    mode: 'realtime',
  } as const;

  it('registers once, then counts an identical re-send', () => {
    const first = admitOperation(db.recoveryOps, 'u1', BINDING, 1_000);
    expect(first).toMatchObject({ ok: true, operation_id: 'op-1', registered: 'registered' });
    const second = admitOperation(db.recoveryOps, 'u1', BINDING, 2_000);
    expect(second).toMatchObject({ ok: true, registered: 'resend' });
    expect(db.recoveryOps.get('u1', 'op-1')?.resend_count).toBe(1);
  });

  it('🔴 a different binding is REFUSED and the stored row is untouched', () => {
    admitOperation(db.recoveryOps, 'u1', BINDING, 1_000);
    const changed = admitOperation(
      db.recoveryOps, 'u1', { ...BINDING, range_end_sample: 32_000 }, 2_000,
    );
    expect(changed.ok).toBe(false);
    if (changed.ok) throw new Error('unreachable');
    expect(changed.error.error).toBe(OPERATION_CONFLICT_CODE);

    // 「Untouched」 is the assertion, not 「refused」. An implementation that
    // refused the frame AND overwrote the row would pass a check on the verdict
    // alone, and the registry would then agree with whichever request arrived
    // last — which is the opposite of what a registry is for (§A7-2).
    expect(db.recoveryOps.get('u1', 'op-1')).toMatchObject({
      recording_id: 'rec-1', range_start_sample: 0, range_end_sample: 16_000,
      attempt_kind: 'live', mode: 'realtime', resend_count: 0,
    });
  });

  // ── lane EC (2026-09-06): the code this refusal carries ────────────────────
  it('🔴 the refusal carries the REGISTERED AUDIO_OP_BINDING_CONFLICT', () => {
    admitOperation(db.recoveryOps, 'u1', BINDING, 1_000);
    const changed = admitOperation(
      db.recoveryOps, 'u1', { ...BINDING, recording_id: 'rec-9' }, 2_000,
    );
    if (changed.ok) throw new Error('unreachable');
    // The literal, not the constant, on purpose: the constant would follow a
    // rename that broke the phone's mirror table and the wire together.
    expect(changed.error.error).toBe('AUDIO_OP_BINDING_CONFLICT');
    expect(ERROR_CODE_LIST).toContain('AUDIO_OP_BINDING_CONFLICT');
    // And it is no longer the code the STT layer speaks. Before the grant these
    // two were the same string, which is what made `vendorNoAudioIsOurSilence`
    // below ambiguous.
    expect(changed.error.error).not.toBe('STT_NO_ENGINE_REACHED');
  });

  // 🔴 The registry-unwired arm is a DIFFERENT question and keeps a different
  // code — see the constant's own doc. Pinned so a later 「tidy-up」 that
  // collapses the two arms onto one code goes red here.
  it('🔴 the registry-unwired arm does NOT borrow the granted code', () => {
    const unwired = admitOperation(undefined, 'u1', BINDING, 1_000);
    expect(unwired.ok).toBe(false);
    if (unwired.ok) throw new Error('unreachable');
    expect(unwired.error.error).toBe(OPERATION_REGISTRY_UNWIRED_CODE);
    expect(unwired.error.error).not.toBe(OPERATION_CONFLICT_CODE);
  });

  // 🔴 THE CROSS-TALK THE GRANT WAS PARTLY FOR, asserted rather than reasoned
  // about in a comment: `vendorNoAudioIsOurSilence` branches on the code string,
  // and the binding conflict must be invisible to it in BOTH directions —
  // positive control included, or a predicate that returned false for
  // everything would pass this.
  it('🔴 empty-final-verdicts cannot mistake the new code for a vendor no-audio', () => {
    expect(vendorNoAudioIsOurSilence('AUDIO_OP_BINDING_CONFLICT', 0)).toBe(false);
    expect(vendorNoAudioIsOurSilence('AUDIO_OP_BINDING_CONFLICT', 4_096)).toBe(false);
    // positive control — the one code it IS about still trips it
    expect(vendorNoAudioIsOurSilence('STT_NO_ENGINE_REACHED', 0)).toBe(true);
  });

  it('🔴 the granted copy asks the user to do nothing', () => {
    // The borrowed code said 「say it again」, which is what produces this
    // refusal. If the copy ever grows an imperative again, this goes red where
    // the refusal is produced, not only in the protocol package.
    const en = ERROR_CODES.AUDIO_OP_BINDING_CONFLICT.en;
    expect(en).not.toMatch(/Say it again/i);
    expect(en).not.toMatch(/check the engine/i);
  });

  it('every bound field is compared — including "named nothing" vs "named something"', () => {
    // Field by field, because a comparison that quietly skipped one would be
    // green on every other case in this file.
    for (const [label, changed] of Object.entries({
      recording_id: { ...BINDING, recording_id: 'rec-2' },
      range_start_sample: { ...BINDING, range_start_sample: 8_000 },
      range_end_sample: { ...BINDING, range_end_sample: 1 },
      attempt_kind: { ...BINDING, attempt_kind: 'user_retranscribe' },
      mode: { ...BINDING, mode: 'translate' },
      // 🔴 NULL IS A VALUE HERE. A frame that names no recording is not a frame
      // that matches any recording; collapsing the two would let an old client's
      // bare re-send silently adopt a binding it never sent.
      absent_recording_id: { ...BINDING, recording_id: undefined },
    })) {
      const id = `op-${label}`;
      admitOperation(db.recoveryOps, 'u1', { ...BINDING, operation_id: id }, 1_000);
      const verdict = admitOperation(db.recoveryOps, 'u1', { ...changed, operation_id: id }, 2_000);
      expect(verdict.ok, `${label} was not compared`).toBe(false);
    }
  });

  it('a frame with no operation_id is admitted and registers nothing', () => {
    const v = admitOperation(db.recoveryOps, 'u1', { mode: 'realtime' }, 1_000);
    expect(v).toEqual({ ok: true });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM recovery_operations').get()).toEqual({ n: 0 });
  });

  it('🔴 fails CLOSED when an operation arrives and no registry is wired', () => {
    // The server advertises `recovery.idempotent_operation` unconditionally, so
    // the only honest answer a build without a registry can give is "no". Passing
    // it through would make the advertisement a lie for that deployment, and the
    // phone reads the bit as permission to stop protecting its own audio (§A7-3).
    const v = admitOperation(undefined, 'u1', { ...BINDING }, 1_000);
    expect(v.ok).toBe(false);
  });
});

describe('the replica leg — a deterministic key the authority can dedupe', () => {
  it('🔴 the same operation forwards under the SAME outbox id, and the writer applies it once', () => {
    const records: OutboxRecord[] = [];
    const replica = makeForwardingUsageTracker({
      outbox: { enqueue: (r: Omit<OutboxRecord, 'at'>) => { records.push({ at: 0, ...r }); } } as never,
      nodeId: 'node-b',
      // Deliberately a counter, not randomUUID: if the production code fell back
      // to `newId()` for an operation-bearing call, the ids below would differ
      // and this test would say so instead of silently passing on two UUIDs that
      // happen to look equally opaque.
      newId: (() => { let n = 0; return (): string => `random-${++n}`; })(),
    });

    replica.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-R');
    replica.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-R');
    expect(records.map((r) => r.id)).toEqual([
      operationRecordId('u1', 'op-R', 'stt', false),
      operationRecordId('u1', 'op-R', 'stt', false),
    ]);

    // Now the writer's side, with its OWN ledger — the one that was already
    // there. Nothing about `forward-ledger.ts` changed for this card; what
    // changed is that the key it dedupes on can now repeat (audit E50).
    const ledger = makeForwardLedger(db.raw);
    const authority = replayTracker();
    const apply = (rec: OutboxRecord): string => ledger.once(rec, () => {
      const body = rec.body as Extract<ForwardedWrite, { kind: 'usage.stt' }>;
      // The replay site passes the operation THROUGH (audit F1): it runs inside
      // the ledger's transaction, so its `usage_effects` claim is taken without a
      // nested BEGIN — see `claimInCallerTransaction`. Two dedupes, and only the
      // second of them is true across paths.
      authority.recordSttUsage(body.user_id, body.engine, body.duration_ms, body.chars, body.operation_id);
    });
    expect(records.map(apply)).toEqual(['accepted', 'duplicate']);
    expect(meter().minutes).toBeCloseTo(1, 6);
  });

  it('the LLM leg gets its own id, so one operation still forwards two effects', () => {
    expect(operationRecordId('u1', 'op-R', 'stt', false))
      .not.toBe(operationRecordId('u1', 'op-R', 'llm', false));
  });

  it('a call with no operation keeps its random id — two presses stay two records', () => {
    const records: OutboxRecord[] = [];
    const replica = makeForwardingUsageTracker({
      outbox: { enqueue: (r: Omit<OutboxRecord, 'at'>) => { records.push({ at: 0, ...r }); } } as never,
      nodeId: 'node-b',
      newId: (() => { let n = 0; return (): string => `random-${++n}`; })(),
    });
    replica.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED);
    replica.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED);
    expect(records.map((r) => r.id)).toEqual(['random-1', 'random-2']);
  });

  it('the id is injective — a separator inside an id cannot forge a collision', () => {
    // Percent-encoding, asserted rather than assumed: the whole value of a
    // deterministic key is that two different triples cannot spell one string.
    expect(operationRecordId('a|b', 'c', 'stt', false))
      .not.toBe(operationRecordId('a', 'b|c', 'stt', false));
  });
});

describe('retention — a re-send after the window is a new operation', () => {
  it('prune drops both tables past the window, and the residual is what the docs say', () => {
    const t = tracker();
    t.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-old');
    admitOperation(db.recoveryOps, 'u1', { operation_id: 'op-old', mode: 'realtime' }, 1_000);

    const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000;
    expect(db.usageEffects.prune(Date.now() + EIGHT_DAYS)).toBe(1);
    expect(db.recoveryOps.prune(Date.now() + EIGHT_DAYS)).toBe(1);

    // And the consequence, stated as behaviour rather than left in a comment:
    // the same operation is now unknown, so it registers again AND meters again.
    // That is the accepted residual (audit A7-2 / db/schema-recovery.ts), not a
    // defect — and a test that only asserted the row count would not have said so.
    t.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-old');
    expect(meter().minutes).toBeCloseTo(2, 6);
  });
});

describe('audit F1 — one operation, two paths to the writer, one charge', () => {
  /**
   * The production receive path, assembled the way `node-runtime.ts` assembles
   * it: the forward ledger owns the transaction, the replay tracker takes the
   * `usage_effects` claim inside it, and `applyForwardedWrite` is reached through
   * `parseForwardedWrite` so a field that does not survive the wire cannot be
   * smuggled past this test by the harness.
   */
  function writerReceive(): (rec: OutboxRecord) => Record<string, string> {
    const receive = makeForwardReceiver({
      ledger: makeForwardLedger(db.raw),
      targets: {
        usage: replayTracker(),
        setHomeNode: () => {},
        setPresence: () => {},
      },
    });
    return (rec) => receive([rec], 'node-b');
  }

  /** One replica, one call, one durable record — the bytes the writer will see. */
  function forwarded(user: string, operation: string, ms: number, is_byok = false): OutboxRecord {
    const records: OutboxRecord[] = [];
    const replica = makeForwardingUsageTracker({
      outbox: { enqueue: (r: Omit<OutboxRecord, 'at'>) => { records.push({ at: 0, ...r }); } } as never,
      nodeId: 'node-b',
      newId: () => 'never-used-for-an-operation',
    });
    replica.recordSttUsage(user, { is_byok }, ms, NO_TEXT_MEASURED, operation);
    return records[0]!;
  }

  it('🔴 metered on the WRITER, then re-sent to a REPLICA: the account moves once', () => {
    // The shape audit F1 names. Nothing here is exotic: the phone's first attempt
    // reached the writer directly, the re-send happened to land on a replica, and
    // the replica forwards it under an id `node_forward_seen` has never seen. The
    // forward ledger therefore says 「accepted」 — correctly, it IS a new record —
    // and until this fix the account was charged a second time while the pairing
    // ack advertised `recovery.idempotent_operation`.
    tracker().recordSttUsage('u1', { is_byok: false }, 120_000, NO_TEXT_MEASURED, 'op-X');
    expect(meter().minutes).toBeCloseTo(2, 6);

    const outcome = writerReceive()(forwarded('u1', 'op-X', 120_000));

    // The record IS accepted — the replica must stop owing it, or it retries for
    // seven days. 「Accepted」 and 「charged」 are two statements and only the
    // first is true here.
    expect(Object.values(outcome)).toEqual(['accepted']);
    expect(meter().minutes).toBeCloseTo(2, 6);
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM usage_effects WHERE user_id='u1' AND operation_id='op-X'").get(),
    ).toEqual({ n: 1 });
  });

  it('🔴 the other order — forwarded first, then re-sent to the writer', () => {
    // Same defect, mirrored. It is a separate test because the two orders take
    // different code paths through the claim: one takes it inside the forward
    // ledger's transaction, the other opens its own, and a fix that only joined
    // them in one direction would pass the test above.
    writerReceive()(forwarded('u1', 'op-Y', 60_000));
    expect(meter().minutes).toBeCloseTo(1, 6);

    tracker().recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-Y');
    expect(meter().minutes).toBeCloseTo(1, 6);
  });

  it('the positive control: a forwarded operation the writer never saw IS charged', () => {
    // Without this, both tests above would pass on a writer that had simply
    // stopped applying forwarded metering at all — 「never charged twice」 and
    // 「never charged」 read identically off a counter that did not move.
    writerReceive()(forwarded('u2', 'op-Z', 180_000));
    expect(meter('u2').minutes).toBeCloseTo(3, 6);
  });

  it('🔴 audit F2 on the FORWARDED leg: own-key first, then platform key — the account is charged', () => {
    // The same defect audit F2 closed on the local leg, in the one place the fix
    // did not reach. `usage-tracker.ts` declines the `usage_effects` claim for a
    // BYOK call because that call moves no counter; but the replica's OUTBOX
    // record id was keyed on (user, operation, kind) alone, so the own-key
    // forward spent the FORWARD ledger's key instead. The re-send under a
    // platform key then arrived as record `op|u1|op-Q|stt` — already seen —
    // `applyForwardedWrite` never ran, and the recording was billed to nobody.
    const receive = writerReceive();

    const byokOutcome = receive(forwarded('u1', 'op-Q', 120_000, true));
    expect(Object.values(byokOutcome)).toEqual(['accepted']);
    expect(meter().minutes).toBe(0);

    // The user switched off their own key and re-sent. This is the first time the
    // account is metered for op-Q, and it must reach the writer's tracker.
    const paidOutcome = receive(forwarded('u1', 'op-Q', 120_000, false));
    expect(Object.values(paidOutcome)).toEqual(['accepted']);
    expect(meter().minutes).toBeCloseTo(2, 6);
  });

  it('the control: a platform-key operation forwarded twice is still deduped', () => {
    // Without this, the test above would pass on a replica that had simply
    // stopped deriving a deterministic id at all — which is the defect card PR-2
    // was written to close (two ids, two claims, two charges).
    const receive = writerReceive();
    expect(Object.values(receive(forwarded('u1', 'op-P', 60_000)))).toEqual(['accepted']);
    expect(Object.values(receive(forwarded('u1', 'op-P', 60_000)))).toEqual(['duplicate']);
    expect(meter().minutes).toBeCloseTo(1, 6);
  });

  it('a forwarded record from a replica that names no operation still meters', () => {
    // The rolling-deploy case: a replica on an older build sends no
    // `operation_id`, and the honest answer is at-least-once on that leg alone —
    // today's behaviour, not a new refusal. The receiving code must not require
    // the field it just learned to read.
    const records: OutboxRecord[] = [];
    const replica = makeForwardingUsageTracker({
      outbox: { enqueue: (r: Omit<OutboxRecord, 'at'>) => { records.push({ at: 0, ...r }); } } as never,
      nodeId: 'node-b',
      newId: () => 'rec-plain',
    });
    replica.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED);
    expect(records[0]!.body).not.toHaveProperty('operation_id');
    writerReceive()(records[0]!);
    expect(meter().minutes).toBeCloseTo(1, 6);
  });
});

describe('audit F2 — an own-key session spends no claim', () => {
  // BYOK moves no counter (the increment sits behind `if (!engine.is_byok)`), so
  // a claim taken for it is a key spent on nothing. Both orders are tested
  // because they fail differently: BYOK-first suppressed a real charge outright,
  // and the reverse order is the control that says the fix did not simply stop
  // claiming altogether.

  it('🔴 BYOK first, then the SAME operation on a platform key: the account is charged', () => {
    const t = tracker();
    t.recordSttUsage('u1', { is_byok: true }, 120_000, NO_TEXT_MEASURED, 'op-K');
    expect(meter().minutes).toBe(0);

    // The user switched off their own key and the operation was re-sent. This is
    // the first time the account is metered for it, and it must go through.
    // 🔴 THIS assertion is the money one and it is deliberately first: a claim
    // spent on a metering that never happened reads as 「already metered」 here,
    // and the whole recording is billed to nobody.
    t.recordSttUsage('u1', { is_byok: false }, 120_000, NO_TEXT_MEASURED, 'op-K');
    expect(meter().minutes).toBeCloseTo(2, 6);
    // …and the mechanism behind it: the own-key call left no claim to spend.
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM usage_effects WHERE operation_id='op-K'").get(),
    ).toEqual({ n: 1 });
  });

  it('platform key first, then BYOK on the same operation: still exactly one charge', () => {
    const t = tracker();
    t.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-L');
    t.recordSttUsage('u1', { is_byok: true }, 60_000, NO_TEXT_MEASURED, 'op-L');
    expect(meter().minutes).toBeCloseTo(1, 6);
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM usage_effects WHERE operation_id='op-L'").get(),
    ).toEqual({ n: 1 });
  });

  it('the LLM leg behaves the same', () => {
    const t = tracker();
    t.recordLlmUsage('u1', { is_byok: true }, 100, 200, 'op-M');
    expect(meter()).toEqual({ minutes: 0, tokensIn: 0, tokensOut: 0 });
    t.recordLlmUsage('u1', { is_byok: false }, 100, 200, 'op-M');
    expect(meter()).toEqual({ minutes: 0, tokensIn: 100, tokensOut: 200 });
  });

  it('a platform-key operation is still deduped — the fix did not stop claiming', () => {
    const t = tracker();
    t.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-N');
    t.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED, 'op-N');
    expect(meter().minutes).toBeCloseTo(1, 6);
  });
});
