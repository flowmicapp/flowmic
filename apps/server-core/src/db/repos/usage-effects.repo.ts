// SPEC-REF:
//   apps/server-core/src/db/schema-recovery.ts (table 16's DDL argues every column)
//   apps/server-core/src/node/forward-ledger.ts (the transaction shape this reuses,
//     verbatim in reasoning: `:84-88` claim + effect() + COMMIT)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft §A7-2
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//   apps/server-core/src/billing/usage-tracker.ts (its ONE caller)
//   *** HUMAN-AUDIT SENSITIVE (billing) ***
//
// Card PR-2's metering-effect ledger: an operation's STT metering — and,
// separately, its LLM metering — is applied to the account ONCE.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE CLAIM AND THE EFFECT ARE ONE TRANSACTION
//
// This is `node/forward-ledger.ts`'s argument and it is not restated because it
// sounded good there — it is the same three orderings and the same two wrong
// ones: claim-then-apply spends the id and loses the minutes when the apply
// throws; apply-then-claim double-charges when the process dies in between;
// both-inside-one-transaction is the only ordering whose failure mode is 「try
// again」 rather than 「money moved wrongly」. So this module owns the
// transaction, not the caller — a caller that could forget to open one is a
// caller that will.
//
// ⚠️ IT IS A SECOND LEDGER RATHER THAN A REUSE OF THAT ONE, deliberately.
// `node_forward_seen` is node plumbing keyed by an opaque record id and is
// created only on a writer that has replicas; this is a product-domain table
// keyed by `(account, operation, kind)` that a single-node deployment needs
// just as much. Sharing the table would have made 「a second machine exists」
// and 「this account was metered」 the same row.
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 NOT exactly-once, AND THE WORD IS BANNED FROM THIS SUBJECT (§A7-2). What is
// promised is that the ACCOUNT is metered once. The vendor may transcribe the
// same audio twice — under ruling O-9 (乙) a re-send is re-recognised — and that
// duplicated cost is ours.
//
// 🔴 `once` OPENS ITS OWN TRANSACTION, SO IT MUST NOT BE CALLED FROM INSIDE ONE.
// SQLite has no nested `BEGIN`, and a caller already holding one would take a
// hard throw. That caller exists: the writer replays a replica's forwarded
// record inside `forward-ledger.once`'s `BEGIN IMMEDIATE`. It uses
// {@link UsageEffectLedger.onceInCallerTransaction} instead — the same claim and
// the same effect, joined to the transaction the caller already owns.
//
// 🔴 WHY THAT PATH MUST TAKE THIS CLAIM AT ALL (audit F1, 2026-09-06). Until it
// did, the two ledgers were disjoint: an operation metered locally on the writer
// and then re-sent by the phone to a REPLICA arrived as a forward record whose
// id `node_forward_seen` had never seen, so the writer applied it — and charged
// the account a second time while advertising `recovery.idempotent_operation`.
// Deduping the forward record was never enough, because the two legs of one
// re-send do not share a forward id; they share `(user, operation, kind)`, which
// is this table's primary key. ONE claim now governs BOTH paths.

// *** billing *** NR-138 round 3 (MAIN decision B5, 2026-10-01; book 22 §4.11): THERE IS NO AGE PRUNE ANY MORE.
// A claim is kept for the life of the account and goes only with it (`ON DELETE CASCADE`, schema-recovery.ts).
// Until this change the daily recovery tick deleted claims older than RECOVERY_RETENTION_MS by their ORIGINAL
// `applied_at` (never refreshed), and that deletion — not the registry's own prune — is what let a re-send of the
// same operation be debited a second time after seven days. The phone keeps unrecovered audio with no time limit
// (owner ruling O-2), so no finite window could cover every re-send it may make.
// ⚠️ Correction (NR-138 round 5, MAIN decision, 2026-10-01; book 22 §4.11): the paragraph above is kept as
// written; its conclusion is superseded. Claims ARE pruned again, at RECOVERY_CLAIM_RETENTION_MS = 90 days by
// the original `applied_at` — the privacy policy's per-use window. What reaches the relay automatically is bounded
// by the phone's six-day window and its one-way `needsManual`, not by how long the audio stays on the phone.

import type { DatabaseSync } from 'node:sqlite';
import { RECOVERY_CLAIM_RETENTION_MS } from '../schema-recovery';

/** The two metering kinds that can each happen once per operation. They are the
 *  two things `usage_records` counts in different columns (STT minutes / LLM
 *  tokens), which is why one operation owns up to two rows here. */
export type UsageEffectKind = 'stt' | 'llm';

// ─────────────────────────────────────────────────────────────────────────────
// *** billing *** NR-138 round 4 (MAIN decision, 2026-10-01; book 22 §4.11 「The bound on a free replay」).
//
// Once claims were kept for the life of the account (round 3), 「a re-send of a claimed operation is free」 had no
// limit: the registry binds no content hash, so a client could reuse one claimed `operation_id` and send any audio,
// free, forever. A claim now remembers what it paid (`billed_ms`) and how often it was replayed (`replays`), and a
// replay is free only inside that. The decision is ONE pure function ({@link replayCharge}) so the rule is read in
// one place and tested without a database.
// ─────────────────────────────────────────────────────────────────────────────

/** Free replays per claim: the phone's own automatic cap (`kRecoveryMaxAutoAttempts` in
 *  apps/mobile/lib/src/session/recovery_backoff.dart), pinned by test/claimed-operation-replay-bound.test.ts. */
export const REPLAY_FREE_LIMIT = 5;

/** How much longer than what it paid a replay may be and still be free: max(1 s, 2%). An honest re-send carries
 *  the same bytes, so its §4.9 basis repeats to within one Soniox processed-position step (120 ms) per engine leg
 *  and one 20 ms gate frame; 1 s covers eight legs, 2% scales with a long recording's extra reconnects. */
export function replayToleranceMs(billedMs: number): number {
  return Math.max(1_000, Math.round(billedMs * 0.02));
}

/** What one metering of an operation did. */
export type MeterVerdict =
  | 'applied' // the first metering: claim written, the full amount charged
  | 'replay_free' // a replay inside the bound: nothing charged
  | 'replay_excess' // a replay longer than what was paid: the excess charged
  | 'replay_billed' // past the free limit: charged in full
  | 'replay_unbound'; // round 6: the claim has no binding, or it differs from the operation's: charged in full, claim untouched

/** A claim as stored. `billed_ms` NULL ⇔ written before NR-138 round 4 (nobody recorded what it paid). */
export interface ClaimRow { applied_at: number; billed_ms: number | null; replays: number }

/**
 * THE RULE, for a replay of an existing claim at [at] whose basis is [amount] (ms for STT, tokens for LLM).
 * Returns what to charge and the claim's new `billed_ms`. Every replay also increments `replays` (the caller).
 */
export function replayCharge(
  row: ClaimRow, kind: UsageEffectKind, amount: number, _at: number,
): { charge: number; verdict: Exclude<MeterVerdict, 'applied'>; billed_ms: number | null } {
  const counted = row.replays < REPLAY_FREE_LIMIT;
  // LLM: tokens vary between runs, so the counter is the only bound.
  if (kind === 'llm') {
    return counted
      ? { charge: 0, verdict: 'replay_free', billed_ms: row.billed_ms }
      : { charge: amount, verdict: 'replay_billed', billed_ms: row.billed_ms };
  }
  // ⚠️ Round 6 (book 22 §4.11): the round-4 「pre-change claim keeps its seven-day promise」 branch is gone. A claim
  // written before round 4 has no binding, and step() bills its replays normally before this function is reached;
  // an STT claim with no `billed_ms` can only be one of those, so it is billed in full here too.
  if (row.billed_ms === null) return { charge: amount, verdict: 'replay_billed', billed_ms: null };
  if (!counted) return { charge: amount, verdict: 'replay_billed', billed_ms: row.billed_ms + amount };
  if (amount <= row.billed_ms + replayToleranceMs(row.billed_ms)) {
    return { charge: 0, verdict: 'replay_free', billed_ms: row.billed_ms };
  }
  return { charge: amount - row.billed_ms, verdict: 'replay_excess', billed_ms: amount };
}

/** NR-138 round 6 (book 22 §4.11, review B6 + B7) — what a claim is bound to: the recording, the job and the audio
 *  range of the frame that was metered. Stored on the claim row itself, so the two expire together. */
export interface ClaimBinding { recording_id: string; job_id: string; range_start_sample: number; range_end_sample: number }

/** The frame's binding, or undefined unless ALL FOUR are present — a partial binding binds nothing. */
export function claimBindingOf(f: {
  recording_id?: string | undefined; job_id?: string | undefined;
  range_start_sample?: number | undefined; range_end_sample?: number | undefined;
}): ClaimBinding | undefined {
  const { recording_id, job_id, range_start_sample, range_end_sample } = f;
  if (typeof recording_id !== 'string' || recording_id === '' || typeof job_id !== 'string' || job_id === '') return undefined;
  if (!Number.isFinite(range_start_sample) || !Number.isFinite(range_end_sample)) return undefined;
  return { recording_id, job_id, range_start_sample: range_start_sample as number, range_end_sample: range_end_sample as number };
}

function sameClaimBinding(a: ClaimBinding, b: ClaimBinding): boolean {
  return a.recording_id === b.recording_id && a.job_id === b.job_id
    && a.range_start_sample === b.range_start_sample && a.range_end_sample === b.range_end_sample;
}

type ClaimRef = {
  user_id: string; operation_id: string; kind: UsageEffectKind; at?: number;
  /** Round 6 — the metered frame's binding. Absent ⇒ the claim (if new) is unbound, and a replay is billed normally. */
  binding?: ClaimBinding | undefined;
};

/**
 * The one method a metering tracker needs: 「meter [amount] for this triple — in full the first time, inside the
 * bound on a replay」. [effect] receives what to charge, and is not called when that is nothing. Narrower than
 * {@link UsageEffectLedger} on purpose: it is what lets ONE tracker implementation serve both transaction shapes
 * (see {@link claimInCallerTransaction}).
 */
export interface UsageEffectClaim {
  meter(ref: ClaimRef, amount: number, effect: (charge: number) => void): MeterVerdict;
}

export interface UsageEffectLedger extends UsageEffectClaim {
  /**
   * The same metering, for a caller that ALREADY HOLDS A TRANSACTION.
   *
   * 🔴 IT OPENS NO TRANSACTION, AND THAT IS THE ONLY DIFFERENCE: the claim (or its replay count) and the effect are
   * still committed or rolled back together, because the caller's `BEGIN` encloses both. Calling this OUTSIDE a
   * transaction would degrade to write-then-apply, the ordering that loses minutes on a throw.
   *
   * ONE production caller: the writer's forwarded-record replay tracker (node/node-runtime.ts `replayUsage`,
   * reached from `forward-ledger.once`).
   */
  meterInCallerTransaction(ref: ClaimRef, amount: number, effect: (charge: number) => void): MeterVerdict;
  /** NR-138 round 5 — drop claims whose original `applied_at` is older than RECOVERY_CLAIM_RETENTION_MS (90 days).
   *  Returns how many went. An automatic re-send after that is metered again (book 22 §4.11, rule ⑧ consequence). */
  prune(now?: number): number;
  /** NR-138 round 5 — this account's claims, for the account export (http/account-lifecycle.ts). */
  listByUser(user_id: string): {
    operation_id: string; kind: string; applied_at: number; billed_ms: number | null; replays: number;
    recording_id: string | null; job_id: string | null; range_start_sample: number | null; range_end_sample: number | null;
  }[];
}

export function makeUsageEffectLedger(db: DatabaseSync): UsageEffectLedger {
  // *** billing *** Round 6 (book 22 §4.11, review B6 + B7): the claim stores the binding of the frame it metered, in
  // the same row — so claim and binding expire together. No binding ⇒ an unbound claim, whose replays bill normally.
  const insert = db.prepare(
    `INSERT INTO usage_effects
       (user_id, operation_id, kind, applied_at, billed_ms, replays, recording_id, job_id, range_start_sample, range_end_sample)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  );
  const select = db.prepare(
    `SELECT applied_at, billed_ms, replays, recording_id, job_id, range_start_sample, range_end_sample
       FROM usage_effects WHERE user_id = ? AND operation_id = ? AND kind = ?`,
  );
  const replayed = db.prepare(
    'UPDATE usage_effects SET replays = replays + 1, billed_ms = ? WHERE user_id = ? AND operation_id = ? AND kind = ?',
  );
  const sweep = db.prepare('DELETE FROM usage_effects WHERE applied_at < ?');
  const byUser = db.prepare(
    `SELECT operation_id, kind, applied_at, billed_ms, replays, recording_id, job_id, range_start_sample, range_end_sample
       FROM usage_effects WHERE user_id = ? ORDER BY applied_at DESC`,
  );

  /** Read, decide, write, apply — inside whatever transaction the caller of this function holds. A throw from
   *  [effect] must reach that transaction's rollback, so nothing here catches it. */
  function step(ref: ClaimRef, amount: number, effect: (charge: number) => void): MeterVerdict {
    const at = ref.at ?? Date.now();
    type Bound = { recording_id: string | null; job_id: string | null; range_start_sample: number | null; range_end_sample: number | null };
    const r = select.get(ref.user_id, ref.operation_id, ref.kind) as
      ({ applied_at: number; billed_ms: number | null; replays: number } & Bound) | undefined;
    if (r === undefined) {
      const b = ref.binding;
      insert.run(ref.user_id, ref.operation_id, ref.kind, at, ref.kind === 'stt' ? Math.round(amount) : null,
        b?.recording_id ?? null, b?.job_id ?? null, b?.range_start_sample ?? null, b?.range_end_sample ?? null);
      effect(amount);
      return 'applied';
    }
    // Round 6: a replay may use the claim only if the claim is bound AND the metered frame carries the same binding.
    // Admission already refuses a different binding while the claim lives (recovery-operations.repo.ts `admit`); this
    // is the second lock, for a path that reached here without that check. Untouched claim, full charge.
    const stored = claimBindingOf({
      recording_id: r.recording_id ?? undefined, job_id: r.job_id ?? undefined,
      range_start_sample: r.range_start_sample === null ? undefined : Number(r.range_start_sample),
      range_end_sample: r.range_end_sample === null ? undefined : Number(r.range_end_sample),
    });
    if (stored === undefined || ref.binding === undefined || !sameClaimBinding(stored, ref.binding)) {
      effect(amount);
      return 'replay_unbound';
    }
    const d = replayCharge(
      { applied_at: Number(r.applied_at), billed_ms: r.billed_ms === null ? null : Number(r.billed_ms), replays: Number(r.replays) },
      ref.kind, amount, at,
    );
    replayed.run(d.billed_ms === null ? null : Math.round(d.billed_ms), ref.user_id, ref.operation_id, ref.kind);
    if (d.charge > 0) effect(d.charge);
    return d.verdict;
  }

  return {
    meter(ref, amount, effect): MeterVerdict {
      // The read is INSIDE `BEGIN IMMEDIATE`: every replay now writes its count, so there is no read-only fast path
      // left to take, and reading under the write lock is what keeps two concurrent replays from both seeing
      // 「replays = 4」.
      db.exec('BEGIN IMMEDIATE');
      try {
        const v = step(ref, amount, effect);
        db.exec('COMMIT');
        return v;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* the transaction is already gone; the original error is the one that matters */
        }
        throw err;
      }
    },
    meterInCallerTransaction(ref, amount, effect): MeterVerdict {
      return step(ref, amount, effect);
    },
    prune(now = Date.now()): number {
      return Number(sweep.run(now - RECOVERY_CLAIM_RETENTION_MS).changes ?? 0);
    },
    listByUser(user_id) {
      return (byUser.all(user_id) as Record<string, unknown>[]).map((r) => ({
        operation_id: String(r['operation_id']),
        kind: String(r['kind']),
        applied_at: Number(r['applied_at']),
        billed_ms: r['billed_ms'] === null ? null : Number(r['billed_ms']),
        replays: Number(r['replays']),
        recording_id: r['recording_id'] === null ? null : String(r['recording_id']),
        job_id: r['job_id'] === null ? null : String(r['job_id']),
        range_start_sample: r['range_start_sample'] === null ? null : Number(r['range_start_sample']),
        range_end_sample: r['range_end_sample'] === null ? null : Number(r['range_end_sample']),
      }));
    },
  };
}

/**
 * The same ledger, seen by a caller that already holds a transaction.
 *
 * 🔴 THIS ADAPTER IS THE JOIN BETWEEN THE TWO DEDUPE PATHS (audit F1). The writer's local metering takes `meter`;
 * the writer's replay of a replica's forwarded record takes `meterInCallerTransaction` through this wrapper. Both
 * land on the SAME `(user, operation, kind)` row, so a re-send that reaches the account by the other path is a
 * replay of that claim, inside the same bound.
 *
 * ⚠️ Only ever hand the result to a tracker whose calls are made inside a transaction.
 */
export function claimInCallerTransaction(ledger: UsageEffectLedger): UsageEffectClaim {
  return { meter: (ref, amount, effect) => ledger.meterInCallerTransaction(ref, amount, effect) };
}
