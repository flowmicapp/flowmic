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

import type { DatabaseSync } from 'node:sqlite';
import { RECOVERY_RETENTION_MS } from '../schema-recovery';

/** The two metering kinds that can each happen once per operation. They are the
 *  two things `usage_records` counts in different columns (STT minutes / LLM
 *  tokens), which is why one operation owns up to two rows here. */
export type UsageEffectKind = 'stt' | 'llm';

/**
 * The one method a metering tracker needs: 「run this effect at most once for
 * this triple」. Narrower than {@link UsageEffectLedger} on purpose — the tracker
 * must not be able to prune the ledger it writes, and the narrowing is also what
 * lets ONE tracker implementation serve both transaction shapes (see
 * {@link claimInCallerTransaction}).
 */
export interface UsageEffectClaim {
  once(
    ref: { user_id: string; operation_id: string; kind: UsageEffectKind; at?: number },
    effect: () => void,
  ): 'applied' | 'duplicate';
}

export interface UsageEffectLedger extends UsageEffectClaim {
  /**
   * Apply `effect` for this `(user, operation, kind)` at most once.
   *
   * Returns `'applied'` when the effect ran, `'duplicate'` when this triple was
   * already applied. Throws only when `effect` throws — and then NOTHING was
   * written, so the caller must not treat the operation as metered.
   */
  /**
   * The same claim, for a caller that ALREADY HOLDS A TRANSACTION.
   *
   * 🔴 IT OPENS NO TRANSACTION, AND THAT IS THE ONLY DIFFERENCE. The three
   * orderings argued above still hold — they hold because the caller's `BEGIN`
   * encloses both the claim and the effect, so a throw anywhere rolls back both
   * and the failure mode stays 「try again」. Calling this OUTSIDE a transaction
   * would silently degrade to claim-then-apply, i.e. the ordering that loses
   * minutes on a throw, which is why the name says whose transaction it needs.
   *
   * ONE production caller: the writer's forwarded-record replay tracker
   * (node/node-runtime.ts `replayUsage`, reached from `forward-ledger.once`).
   */
  onceInCallerTransaction(
    ref: { user_id: string; operation_id: string; kind: UsageEffectKind; at?: number },
    effect: () => void,
  ): 'applied' | 'duplicate';
  /** Drop markers older than the retention window. Returns how many went.
   *  A re-send after that is metered again — the accepted residual, argued in
   *  schema-recovery.ts. */
  prune(now?: number): number;
}

export function makeUsageEffectLedger(db: DatabaseSync): UsageEffectLedger {
  const claim = db.prepare(
    'INSERT INTO usage_effects (user_id, operation_id, kind, applied_at) VALUES (?, ?, ?, ?)',
  );
  const seen = db.prepare(
    'SELECT 1 AS hit FROM usage_effects WHERE user_id = ? AND operation_id = ? AND kind = ?',
  );
  const sweep = db.prepare('DELETE FROM usage_effects WHERE applied_at < ?');

  return {
    once(ref, effect): 'applied' | 'duplicate' {
      // Checked before opening the transaction so the common duplicate costs one
      // indexed lookup rather than a rollback. The INSERT below is still the
      // authority — this is a fast path, not the guard.
      if (seen.get(ref.user_id, ref.operation_id, ref.kind)) return 'duplicate';
      db.exec('BEGIN IMMEDIATE');
      try {
        claim.run(ref.user_id, ref.operation_id, ref.kind, ref.at ?? Date.now());
        effect();
        db.exec('COMMIT');
        return 'applied';
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* the transaction is already gone; the original error is the one that
             matters and rethrowing this one would hide it */
        }
        // A UNIQUE violation here means a concurrent start claimed the same
        // triple between the fast path above and this INSERT. That is a
        // duplicate, not a failure — reporting it as a failure would make the
        // caller believe an account was NOT metered when it was.
        const msg = err instanceof Error ? err.message : String(err);
        if (/UNIQUE constraint failed: usage_effects\./.test(msg)) return 'duplicate';
        throw err;
      }
    },
    onceInCallerTransaction(ref, effect): 'applied' | 'duplicate' {
      if (seen.get(ref.user_id, ref.operation_id, ref.kind)) return 'duplicate';
      try {
        claim.run(ref.user_id, ref.operation_id, ref.kind, ref.at ?? Date.now());
      } catch (err) {
        // A constraint violation aborts the STATEMENT, not the caller's
        // transaction, so returning 「duplicate」 here leaves that transaction
        // intact and its other work committable. Anything else is the caller's
        // problem and is rethrown — their `BEGIN` is what rolls it back.
        const msg = err instanceof Error ? err.message : String(err);
        if (/UNIQUE constraint failed: usage_effects\./.test(msg)) return 'duplicate';
        throw err;
      }
      // NOT wrapped: a throw must reach the caller so THEIR rollback undoes the
      // claim above with it. Swallowing it here would spend the key and lose the
      // minutes — the exact ordering this module refuses to have.
      effect();
      return 'applied';
    },
    prune(now = Date.now()): number {
      const r = sweep.run(now - RECOVERY_RETENTION_MS);
      return Number(r.changes ?? 0);
    },
  };
}

/**
 * The same ledger, seen by a caller that already holds a transaction.
 *
 * 🔴 THIS ADAPTER IS THE JOIN BETWEEN THE TWO DEDUPE PATHS (audit F1). The
 * writer's local metering takes `once`; the writer's replay of a replica's
 * forwarded record takes `onceInCallerTransaction` through this wrapper. Both
 * land on the SAME `(user, operation, kind)` row, so a re-send that reaches the
 * account by the other path finds the claim already spent.
 *
 * ⚠️ Only ever hand the result to a tracker whose calls are made inside a
 * transaction. Given to an ordinary tracker it would meter correctly and
 * degrade the failure ordering, which is precisely the kind of quiet wrongness
 * this module's header refuses.
 */
export function claimInCallerTransaction(ledger: UsageEffectLedger): UsageEffectClaim {
  return { once: (ref, effect) => ledger.onceInCallerTransaction(ref, effect) };
}
