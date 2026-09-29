// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §3-4 (what a
//     replica must forward), §10 (the reconnect-leg writes that were 「accepted
//     and lost」)
//   apps/server-core/src/node/forwarded-write.ts (`pc.identity`, the wire shape)
//   card NR-131 (2026-09-29 diag-0100 failure 3)
//
// What a PC says about itself on `pc:reconnect` — its machine uid, and its
// client declaration (client / client_version / target_caps) — reaching the
// WRITER when the PC is connected through a replica.
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
// A desktop registers once and reconnects by token forever after. Both
// `stampMachineUid` and `notePcClientDeclaration` run on that reconnect leg,
// and on a replica they write THAT replica's database only — a copy the next
// replication pull replaces with the writer's. Nothing carried them to the
// writer, so for a row that needed a backfill (a Linux row minted by 0.3.95, which
// had no machine uid; any pre-0.2.4 row) the writer's copy stayed NULL forever:
//   · every phone ack (`pc_machine_uid`, mobile-reconnect.ts / mobile.handler.ts)
//     read NULL, and the phone refuses to group a NULL uid with anything;
//   · the writer kept the version and target_caps of whatever build last reached
//     it directly (measured: 0.3.95 on both nodes for a 0.3.100 desktop).
//
// ── THE RULES THE WRITER APPLIES, AND WHY EACH ONE ──────────────────────────
// ① The row must exist and belong to the account the record names. The replica
//   resolved this PC by the connection's device token and stamps `pc.id` /
//   `pc.user_id` from THAT row — never from a client field — so a mismatch means
//   a confused or misbehaving sender. It is skipped and logged, not retried.
// ② A present uid must look like a PC uid (forwarded-write.ts `PC_MACHINE_UID_RE`); a malformed one
//   is dropped to ABSENT, the same degradation `DeviceUid` gives on the socket.
// ③ An ABSENT uid never blanks a stored one — the same rule `stampMachineUid`
//   has on the direct path (`if (!machine_uid …) return`).
// ④ Last writer wins by `declared_at`. A forwarded record describes a moment
//   that has passed; one delivered late (a transient failure, then a retry) must
//   not overwrite a newer declaration — whether that newer one came through the
//   outbox or from the PC connecting to the writer directly, which the writer's
//   own handler notes on the same clock (`noteDirect`).
//
// ⚠️ THE CLOCK IS IN MEMORY, AND THAT IS A CHOICE. Persisting it would add a
// writer table every replica pull must be taught to skip (replica-puller.ts
// NEVER_REPLICATED) and an old replica would WARN about on every pull during a
// rolling deploy. What a restart loses is bounded: after a writer restart every
// PC that is on the writer reconnects and re-notes itself, and every value here
// is RE-ASSERTED on the PC's next connection anyway — a stale write is corrected
// by the next reconnect, not kept.

import { randomUUID } from 'node:crypto';
import type { TargetCaps } from '@flowmic/protocol';
import type { ReplicaOutbox } from '../db/replica-outbox';
import type { PcRecord, PcRepo } from '../db/repos/pc.repo';
import { serializeTargetCaps } from '../room/target-caps';
import type { ForwardedPcIdentity } from './forwarded-write';

/** What `pc:reconnect` / `pc:register` declared, in the omit-when-absent shape
 *  `clientDeclarationOf` produces. */
export interface PcIdentityDeclared {
  machine_uid?: string;
  client?: string;
  client_version?: string;
  target_caps?: TargetCaps;
}

/** The pc handler's seam. Replica: forward through the outbox. Writer: note the
 *  direct declaration's instant on the LWW clock. Single node: absent. */
export type NotePcIdentity = (pc: Pick<PcRecord, 'id' | 'user_id'>, declared: PcIdentityDeclared) => void;

/** Rule ④ — last writer wins per PC, by the instant the PC declared. */
export interface PcIdentityClock {
  /** A declaration performed on the writer itself, at `atMs`. */
  noteDirect(pcId: string, atMs: number): void;
  /** May a forwarded declaration made at `atMs` be applied? Advances the clock
   *  when it may. Equal instants are admitted: that is a redelivery of the same
   *  declaration, and applying it again writes the same values. */
  admit(pcId: string, atMs: number): boolean;
}

export function makePcIdentityClock(): PcIdentityClock {
  const last = new Map<string, number>();
  return {
    noteDirect(pcId, atMs) {
      last.set(pcId, Math.max(last.get(pcId) ?? 0, atMs));
    },
    admit(pcId, atMs) {
      const prev = last.get(pcId);
      if (prev !== undefined && atMs < prev) return false;
      last.set(pcId, atMs);
      return true;
    },
  };
}

interface Log {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** REPLICA — enqueue one `pc.identity` record per PC declaration. Every
 *  reconnect, not only when something changed: this node's copy of the row is
 *  a snapshot of the writer's plus whatever it stamped locally since the last
 *  pull, so 「unchanged here」 does not mean 「the writer has it」 — which is the
 *  exact reasoning that kept this fact from ever leaving the replica. One small
 *  record per reconnect is noise next to the presence record every heartbeat. */
export function makePcIdentityForwarder(deps: {
  outbox: Pick<ReplicaOutbox, 'enqueue'>;
  nodeId: string;
  log: Log;
  now?: () => number;
  newId?: () => string;
}): NotePcIdentity {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  return (pc, declared) => {
    const body: ForwardedPcIdentity = {
      kind: 'pc.identity',
      pc_id: pc.id,
      user_id: pc.user_id,
      declared_at: now(),
      ...(declared.machine_uid ? { machine_uid: declared.machine_uid } : {}),
      // Null, not omitted: the direct path overwrites all three with whatever
      // this connection declared, including nothing (registry.ts
      // stampClientDeclaration — 「absence has to be able to travel」).
      client: declared.client ?? null,
      client_version: declared.client_version ?? null,
      target_caps: declared.target_caps ?? null,
    };
    try {
      deps.outbox.enqueue({ id: newId(), kind: 'pc_identity', node: deps.nodeId, body });
    } catch (err) {
      // Not fatal to the session. What is lost is the writer's copy of this
      // PC's uid and version until its next reconnect, so the message says that.
      deps.log.error('node.outbox could not record pc identity — the writer keeps the old uid/version', {
        pc_id: pc.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export type PcIdentityOutcome = 'applied' | 'stale' | 'no_such_pc' | 'wrong_account';

/** WRITER — perform one forwarded `pc.identity`, under rules ①–④ above. Returns
 *  what it did; every non-`applied` outcome is logged here, so the record is
 *  consumed (it is not a fact this writer will ever be able to perform) rather
 *  than retried until it parks. */
export function makePcIdentityApplier(deps: {
  pcs: Pick<PcRepo, 'findById' | 'setMachineUid' | 'setClientDeclaration'>;
  clock: PcIdentityClock;
  log: Log;
}): (w: ForwardedPcIdentity) => PcIdentityOutcome {
  return (w) => {
    const pc = deps.pcs.findById(w.pc_id);
    if (!pc) {
      deps.log.warn('node.forward pc.identity for a PC this writer does not have — skipped', { pc_id: w.pc_id });
      return 'no_such_pc';
    }
    if (pc.user_id !== w.user_id) {
      deps.log.warn('node.forward pc.identity names another account — skipped', { pc_id: w.pc_id });
      return 'wrong_account';
    }
    if (!deps.clock.admit(w.pc_id, w.declared_at)) {
      deps.log.info('node.forward pc.identity older than the last declaration — skipped', { pc_id: w.pc_id });
      return 'stale';
    }
    if (w.machine_uid && pc.machine_uid !== w.machine_uid) deps.pcs.setMachineUid(pc.id, w.machine_uid);
    deps.pcs.setClientDeclaration(pc.id, {
      client: w.client,
      client_version: w.client_version,
      target_caps: serializeTargetCaps(w.target_caps ?? undefined),
    });
    return 'applied';
  };
}
