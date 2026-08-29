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
  const owe = (write: ForwardedWrite): void => {
    try {
      deps.outbox.enqueue({ id: deps.newId(), kind: 'usage', node: deps.nodeId, body: write });
    } catch (err) {
      deps.onEnqueueFailed?.(err, write);
    }
  };

  return {
    // ⚠️ NO FILTERING HERE, on purpose. `recordSttUsage` drops zero-length
    // utterances and BYOK sessions on the writer, and re-stating either rule
    // here would make the replica a second author of a billing predicate. The
    // records that will be dropped are cheap; a divergence is not.
    recordSttUsage(user_id: string, engine: EngineUsageMeta, duration_ms: number, chars: SttCharCounts): void {
      owe({ kind: 'usage.stt', user_id, engine, duration_ms, chars });
    },
    recordLlmUsage(user_id: string, engine: EngineUsageMeta, tokens_in: number, tokens_out: number): void {
      owe({ kind: 'usage.llm', user_id, engine, tokens_in, tokens_out });
    },
    recordQuotaRefusal(user_id: string, kind: UsageEventKind, refused_user_id: string): void {
      owe({ kind: 'usage.quota_refused', user_id, event_kind: kind, refused_user_id });
    },
  };
}
