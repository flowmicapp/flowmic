// SPEC-REF:
//   apps/server-core/src/node/forwarded-write.ts (why the CALL travels, not the effect)
//   apps/server-core/src/db/replica-outbox.ts (durability at the moment of the call)
//   apps/server-core/src/billing/usage-tracker.ts (the seam being decorated)
//   CLAUDE.md red line: no silent failure, in BOTH directions
//
// The UsageTracker a REPLICA installs. Every call becomes a durable record owed
// to the writer; nothing is metered locally.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY DECORATE THE TRACKER AND NOT THE REPO
//
// `usage-tracker.ts` already carries the repo's exactly-once discipline: three
// methods, one production call site each. Decorating it means the forwarding
// layer inherits that discipline instead of restating it, and it means a fourth
// metering method added tomorrow does not compile here until someone decides
// what it does across a node boundary — which is the decision that matters.
//
// Decorating `usage.repo` instead would have put the split one layer below the
// place the product reasons about, and — the practical half — that file belongs
// to another workstream this week. A seam nobody else is editing is worth real
// money in a two-window sprint.
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 THIS TRACKER NEVER TOUCHES THE LOCAL DATABASE, AND THAT IS THE WHOLE POINT.
// A replica's sqlite file is a snapshot that the next replication pull REPLACES.
// A local `increment` there would succeed, log nothing, and be gone twenty
// seconds later. Not a failure — a success that was not true, which is the exact
// shape this repo keeps paying for.

import type { UsageTracker, EngineUsageMeta } from '../billing/usage-tracker';
import type { SttCharCounts } from '../engine/stt-session-deps';
import type { UsageEventKind } from '../db/repos/usage-events.repo';
import type { ReplicaOutbox } from '../db/replica-outbox';
import type { ForwardedWrite } from './forwarded-write';
import type { UsageEffectKind } from '../db/repos/usage-effects.repo';

/**
 * Card PR-2 — the outbox record id for a metering call that belongs to a
 * recovery operation.
 *
 * 🔴 THE POINT IS THAT IT IS NOT RANDOM. `forward-ledger.once` on the writer
 * dedupes by exactly this id, so while every record carried a fresh
 * `randomUUID()` (audit E50) the same operation forwarded twice produced two
 * ids, two claims and two charges — the ledger was working perfectly on a key
 * that could not repeat. Deriving the id from the facts that DO repeat is what
 * makes the writer's existing transaction do this card's job on the replica leg,
 * with no second dedupe mechanism and no schema on the replica at all.
 *
 * ⚠️ `kind` IS IN THE ID for the same reason it is in `usage_effects`'s primary
 * key: one operation meters STT minutes and LLM tokens separately, and an id
 * without it would let the writer discard the second as a duplicate of the first.
 *
 * 🔴 `is_byok` IS IN THE ID FOR EXACTLY THE SAME REASON, and leaving it out cost
 * a real charge. `usage-tracker.ts` (audit F2) declines the `usage_effects`
 * claim for an own-key call because that call moves no counter — so an own-key
 * metering of op-Q followed by a platform-key re-send of op-Q is billed once, on
 * the second. On the forwarded leg the two calls spelled the SAME record id, the
 * writer's `forward-ledger.once` answered 「duplicate」 for the second,
 * `applyForwardedWrite` never ran, and the recording was billed to nobody.
 *
 * ⚠️ THE BILLING PREDICATE STAYS ON THE WRITER — this is not the replica
 * re-authoring it. Compare the two things being keyed: `usage_effects` is a
 * CLAIM on a counter and must only be spent by a counter that moved, which is
 * why the writer passes `undefined` there for BYOK; this id is TRANSPORT dedupe
 * for one replica's queue, and its only job is to be injective over the calls
 * that must each reach `applyForwardedWrite`. Two calls that differ in
 * `is_byok` are two such calls. Declining an id here instead would put a
 * BYOK branch on the replica — the thing this file's `recordSttUsage` comment
 * refuses to do — and would also drop retry dedupe for own-key forwards.
 *
 * Components are percent-encoded so a `|` or a `:` inside an id cannot make two
 * different tuples spell the same string — the whole value of a deterministic
 * key is that it is injective.
 */
export function operationRecordId(
  user_id: string, operation_id: string, kind: UsageEffectKind, is_byok: boolean,
): string {
  return `op|${encodeURIComponent(user_id)}|${encodeURIComponent(operation_id)}|${kind}`
    + `|${is_byok ? 'byok' : 'platform'}`;
}

export interface ForwardingTrackerDeps {
  outbox: ReplicaOutbox;
  /** Node id, carried on every record so the writer's log can answer 「which node
   *  did this come from」 without correlating timestamps. */
  nodeId: string;
  /** Injected so a test can assert exact ids. Production passes randomUUID. */
  newId: () => string;
  /** Called when enqueue itself throws — a full disk, a permissions change.
   *  🔴 There is no recovery here and pretending otherwise would be the lie:
   *  the fact is already lost. What must NOT happen is losing it quietly, so
   *  this exists to make sure something says so. */
  onEnqueueFailed?: (err: unknown, write: ForwardedWrite) => void;
}

export function makeForwardingUsageTracker(deps: ForwardingTrackerDeps): UsageTracker {
  const owe = (write: ForwardedWrite, id?: string): void => {
    try {
      deps.outbox.enqueue({ id: id ?? deps.newId(), kind: 'usage', node: deps.nodeId, body: write });
    } catch (err) {
      deps.onEnqueueFailed?.(err, write);
    }
  };

  return {
    // ⚠️ NO FILTERING HERE, on purpose. `recordSttUsage` drops zero-length
    // utterances and BYOK sessions on the writer, and re-stating either rule
    // here would make the replica a second author of a billing predicate. The
    // records that will be dropped are cheap; a divergence is not.
    recordSttUsage(
      user_id: string, engine: EngineUsageMeta, duration_ms: number, chars: SttCharCounts,
      operation_id?: string,
    ): void {
      // PR-2 — a deterministic id ONLY when there is an operation to derive it
      // from. No operation ⇒ `newId()`, i.e. today's behaviour byte for byte:
      // an ordinary press has nothing that repeats, and inventing a stable key
      // for it would make two genuinely separate recordings look like one.
      owe(
        {
          kind: 'usage.stt', user_id, engine, duration_ms, chars,
          // Audit F1 — the operation travels in the BODY too, not only in the
          // record id. The id dedupes this LEG (one replica, one queue); the
          // body is what lets the writer take the `usage_effects` claim that
          // the same operation's LOCAL metering takes, which is the only thing
          // that makes 「metered here, re-sent there」 one charge.
          ...(operation_id === undefined ? {} : { operation_id }),
        },
        operation_id === undefined ? undefined
          : operationRecordId(user_id, operation_id, 'stt', engine.is_byok),
      );
    },
    recordLlmUsage(
      user_id: string, engine: EngineUsageMeta, tokens_in: number, tokens_out: number,
      operation_id?: string,
    ): void {
      owe(
        {
          kind: 'usage.llm', user_id, engine, tokens_in, tokens_out,
          ...(operation_id === undefined ? {} : { operation_id }),
        },
        operation_id === undefined ? undefined
          : operationRecordId(user_id, operation_id, 'llm', engine.is_byok),
      );
    },
    recordQuotaRefusal(user_id: string, kind: UsageEventKind, refused_user_id: string): void {
      owe({ kind: 'usage.quota_refused', user_id, event_kind: kind, refused_user_id });
    },
  };
}
