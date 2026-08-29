// SPEC-REF:
//   apps/server-core/src/stt/quota-recheck.ts       (the rule this must not change)
//   apps/server-core/src/stt/audio/session.ts       (refreshQuotaBudget: the floor,
//                                                    the no-ceiling short-circuit)
//   apps/server-core/src/engine/stt-factory.ts      (withQuotaBudget: the ONE install site)
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §4-4
//
// 「How many minutes does this account have left」 — asked on a replica, answered
// by the writer.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS READ, AND ONLY THIS READ, LEAVES THE NODE
//
// The rule (design §4-4, sharpened in review) is not 「important data goes to the
// writer」 — importance is not a test anyone can apply. It is: A READ WHOSE
// PURPOSE IS TO DETECT SOMEONE ELSE'S RECENT WRITE MUST NOT BE SERVED FROM A
// REPLICA. This read's entire purpose is to find out whether the minutes were
// spent since we last looked — very possibly on the other node. A replica
// answers it confidently, in the same shape, and wrong.
//
// The failure direction matters and is worth naming precisely: a replica
// OVER-reports what remains, so it fails toward letting someone overspend, never
// toward cutting a recording off. That makes it a billing bug rather than an
// outage, which is why it is worth fixing carefully rather than urgently.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE THREE CONSTRAINTS THIS MUST NOT BREAK
//
// ① IT STAYS SYNCHRONOUS. `refreshQuotaBudget()` runs at engine-leg birth, on
//    the hot path, because the owner ruling was explicitly「这个过程要很短，提高
//    性能」. So the network call NEVER happens inside the read. The read returns
//    a cell; a refresh is kicked off beside it and lands for next time. Leg
//    birth costs a Map lookup, the same as today.
//
// ② THE FAILURE DIRECTION IS PRESERVED. An unreachable writer must degrade
//    exactly the way a database hiccup already does — keep the previously
//    declared budget, let the leg be born, say so once. So a failed refresh
//    never throws into the read and never zeroes the cell: the last known value
//    stands. A database hiccup must not cost somebody a thirty-minute meeting,
//    and neither must an ocean.
//
// ③ THE FLOOR STAYS. DEFAULT_QUOTA_REFRESH_FLOOR_MS exists to stop a read per
//    utterance. Over a network that matters MORE, not less, and the refresh
//    interval here is deliberately no tighter than that floor.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ THE GAP THIS DOES NOT CLOSE, STATED RATHER THAN GLOSSED
//
// The FIRST read for a user on a replica has no cell yet, so it answers from the
// local copy — stale by up to one replication cycle — and starts a refresh that
// lands before the next leg. Closing that would mean making the opening
// declaration await a cross-region round trip on `audio:start`, which is the
// async refactor constraint ① forbids.
//
// That residue belongs to the SAME open account as concurrent overspend, not a
// new one: docs/strategy/2026-08-29-continuous-recording-and-resumable-
// transcription-task-unit.md §8 (P13), whose bound is
// (concurrent − 1) × min(tier cap, remaining). Replica lag adds a term; it does
// not add a mechanism.

export interface QuotaReader {
  remainingSttMs(userId: string): number;
}

export interface AuthoritativeQuotaDeps {
  /** The local (replica) reader. Used for the first read of a user, and as the
   *  answer if the writer has never yet responded for them. */
  local: QuotaReader;
  /** Asks the writer. Rejects when the writer is unreachable — which this module
   *  treats as「keep what we had」, never as zero. */
  askWriter: (userId: string) => Promise<number>;
  /** How long a cached answer is trusted before a refresh is kicked off. No
   *  tighter than the session's own floor — see constraint ③. */
  staleAfterMs?: number;
  now?: () => number;
  log: { warn(msg: string, meta?: Record<string, unknown>): void };
}

/** Matches DEFAULT_QUOTA_REFRESH_FLOOR_MS by intent rather than by import: this
 *  is「how long an ANSWER is good for」, that is「how often we may ASK」, and
 *  binding them together would make one number answer two questions. They happen
 *  to be equal today and either may move without the other. */
export const QUOTA_CELL_STALE_AFTER_MS = 60_000;

export function makeAuthoritativeQuotaReader(deps: AuthoritativeQuotaDeps): QuotaReader {
  const now = deps.now ?? Date.now;
  const staleAfter = deps.staleAfterMs ?? QUOTA_CELL_STALE_AFTER_MS;
  const cells = new Map<string, { value: number; at: number }>();
  const inFlight = new Set<string>();
  let warned = false;

  const refresh = (userId: string): void => {
    if (inFlight.has(userId)) return;
    inFlight.add(userId);
    void deps.askWriter(userId).then(
      (value) => {
        inFlight.delete(userId);
        // A non-finite answer means「this account is not metered」, which is a
        // real state (owner exemption). Storing it verbatim keeps the ceiling
        // logic in AudioSession the single author of what that means.
        if (typeof value === 'number' && !Number.isNaN(value)) {
          cells.set(userId, { value, at: now() });
        }
        warned = false;
      },
      (err) => {
        inFlight.delete(userId);
        // 🔴 The cell is NOT cleared and NOT zeroed. Constraint ②: an
        // unreachable writer keeps the previously declared budget. Zeroing here
        // would end a recording because of someone else's network.
        if (!warned) {
          deps.log.warn('node.quota: the writer did not answer; serving the last known budget', {
            user_id: userId,
            reason: err instanceof Error ? err.message : String(err),
          });
          warned = true;
        }
      },
    );
  };

  return {
    remainingSttMs(userId: string): number {
      const cell = cells.get(userId);
      const t = now();
      if (!cell || t - cell.at >= staleAfter) refresh(userId);
      // See the gap note in the header: no cell yet ⇒ the local copy answers
      // this once, and the refresh above makes the next leg authoritative.
      return cell ? cell.value : deps.local.remainingSttMs(userId);
    },
  };
}
