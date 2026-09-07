// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §3-4
//   apps/server-core/src/db/replica-outbox.ts (the durable queue these travel in)
//   CLAUDE.md red lines: no silent failure; one value answers one question only
//
// What a replica is allowed to ask the writer to do, and how the writer does it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE REPLICA FORWARDS THE CALL, NOT THE EFFECT
//
// A forwarded metering record carries the ARGUMENTS of the seam that produced
// it, and the writer replays that seam through its own UsageTracker. It does
// NOT carry 「add 4.3 minutes to this row」.
//
// The alternative was considered and rejected: `recordSttUsage` is not a setter.
// It early-returns on standalone mode, early-returns on a zero-length utterance,
// skips the meter for BYOK while still writing an event row, rounds ms in one
// place on purpose, and appends a usage_event whose failure must not disturb the
// meter. Reimplementing that on the receiving side would make the replica a
// SECOND AUTHOR of every billing number — and the two authors would agree right
// up until someone edited one of them.
//
// So the writer owns billing, exactly as it does today, and this module is a
// transport. The cost is real and accepted: records the writer will drop (BYOK,
// zero duration) still cross the wire. That waste is worth less than one
// divergence, and the alternative would put a billing predicate on the replica,
// which is a policy decision the replica has no business making.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ THE SET IS CLOSED, AND THE CLOSURE IS CHECKED BY THE COMPILER. A new
// forwardable write is a deliberate decision about what may cross a node
// boundary. `applyForwardedWrite` switches exhaustively over this union, so
// adding a member without teaching the writer to perform it does not compile.
//
// 🔴 A CORRECTION TO THE DESIGN DOC, MADE HERE BECAUSE THE CODE IS WHERE IT
// BITES: §3-4 says a replica owes 「three writes」 and names metering as one of
// them. Metering is not one write, it is a three-method interface — the LLM leg
// is reached by compose (translate/organize), which runs on whichever node the
// PC is connected to, and quota refusals are a third. Counting an interface as
// one write is how a forwarding layer ends up silently dropping two thirds of a
// billing surface.

import type { UsageTracker, EngineUsageMeta } from '../billing/usage-tracker';
import type { SttCharCounts } from '../engine/stt-session-deps';
import type { UsageEventKind } from '../db/repos/usage-events.repo';

export interface ForwardedStt {
  kind: 'usage.stt';
  user_id: string;
  engine: EngineUsageMeta;
  duration_ms: number;
  chars: SttCharCounts;
  /**
   * Audit F1 — the recovery operation this metering call belongs to, when there
   * is one. Carried so the WRITER can take the `usage_effects` claim for it, the
   * same claim its own local metering takes: without it the two dedupe ledgers
   * were disjoint and an operation metered locally, then re-sent to a replica,
   * was charged twice (usage-effects.repo.ts's header carries the whole account).
   *
   * ⚠️ OPTIONAL, and it must stay optional: an ordinary press carries no
   * operation, and a replica running a build that predates this field is the
   * expected case during a rolling deploy — the writer then meters exactly as it
   * did before, which is at-least-once on that leg alone and is what the forward
   * ledger's own deterministic id already guards.
   */
  operation_id?: string;
}

export interface ForwardedLlm {
  kind: 'usage.llm';
  user_id: string;
  engine: EngineUsageMeta;
  tokens_in: number;
  tokens_out: number;
  /**
   * Audit F1 — the recovery operation this metering call belongs to, when there
   * is one. Carried so the WRITER can take the `usage_effects` claim for it, the
   * same claim its own local metering takes: without it the two dedupe ledgers
   * were disjoint and an operation metered locally, then re-sent to a replica,
   * was charged twice (usage-effects.repo.ts's header carries the whole account).
   *
   * ⚠️ OPTIONAL, and it must stay optional: an ordinary press carries no
   * operation, and a replica running a build that predates this field is the
   * expected case during a rolling deploy — the writer then meters exactly as it
   * did before, which is at-least-once on that leg alone and is what the forward
   * ledger's own deterministic id already guards.
   */
  operation_id?: string;
}

export interface ForwardedQuotaRefusal {
  kind: 'usage.quota_refused';
  user_id: string;
  event_kind: UsageEventKind;
  refused_user_id: string;
}

/** Which relay node a PC is registered on — the whole of the cross-node
 *  directory (see db/schema.ts `home_node`). Idempotent: it is a set, not an
 *  increment, so a duplicate delivery changes nothing. */
export interface ForwardedHomeNode {
  kind: 'pc.home_node';
  pc_id: string;
  home_node: string;
}

/** Online / last-seen. Idempotent for the same reason, and the least valuable of
 *  the five: losing one costs a stale dot in the UI until the next heartbeat. */
export interface ForwardedPresence {
  kind: 'pc.presence';
  pc_id: string;
  is_online: boolean;
  last_seen_at: number;
}

export type ForwardedWrite =
  | ForwardedStt
  | ForwardedLlm
  | ForwardedQuotaRefusal
  | ForwardedHomeNode
  | ForwardedPresence;

export interface ForwardTargets {
  usage: UsageTracker;
  setHomeNode(pc_id: string, home_node: string): void;
  setPresence(pc_id: string, is_online: boolean, last_seen_at: number): void;
}

/** Thrown when a body does not describe any forwardable write. The writer turns
 *  this into a per-record rejection rather than a 500: one malformed record must
 *  not stop the queue behind it. */
export class UnknownForwardedWrite extends Error {
  constructor(kind: unknown) {
    super(`unknown forwarded write kind: ${JSON.stringify(kind)}`);
    this.name = 'UnknownForwardedWrite';
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Validate an untrusted body into a ForwardedWrite, or throw.
 *
 * 🔴 This runs on the WRITER, on bytes that arrived over the network. The shared
 * secret says the sender is a node of ours; it says nothing about the sender
 * being a node of ours that is working correctly. A replica running an older
 * build is the expected case during a rolling deploy, not an exotic one.
 */
export function parseForwardedWrite(body: unknown): ForwardedWrite {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') throw new UnknownForwardedWrite(body);
  switch (b.kind) {
    case 'usage.stt': {
      const engine = b.engine as EngineUsageMeta | undefined;
      const chars = b.chars as SttCharCounts | undefined;
      if (!isNonEmpty(b.user_id) || !engine || typeof engine.is_byok !== 'boolean'
        || !isFiniteNumber(b.duration_ms) || !chars) throw new UnknownForwardedWrite(b.kind);
      return {
        kind: 'usage.stt', user_id: b.user_id, engine, duration_ms: b.duration_ms, chars,
        // Spread-or-nothing: a body without the field must produce an object
        // without it, so 「an older replica sent none」 and 「it sent an empty
        // string」 cannot become the same thing one layer down.
        ...(isNonEmpty(b.operation_id) ? { operation_id: b.operation_id } : {}),
      };
    }
    case 'usage.llm': {
      const engine = b.engine as EngineUsageMeta | undefined;
      if (!isNonEmpty(b.user_id) || !engine || typeof engine.is_byok !== 'boolean'
        || !isFiniteNumber(b.tokens_in) || !isFiniteNumber(b.tokens_out)) {
        throw new UnknownForwardedWrite(b.kind);
      }
      return {
        kind: 'usage.llm', user_id: b.user_id, engine,
        tokens_in: b.tokens_in, tokens_out: b.tokens_out,
        ...(isNonEmpty(b.operation_id) ? { operation_id: b.operation_id } : {}),
      };
    }
    case 'usage.quota_refused': {
      if (!isNonEmpty(b.user_id) || !isNonEmpty(b.event_kind) || !isNonEmpty(b.refused_user_id)) {
        throw new UnknownForwardedWrite(b.kind);
      }
      return {
        kind: 'usage.quota_refused', user_id: b.user_id,
        event_kind: b.event_kind as UsageEventKind, refused_user_id: b.refused_user_id,
      };
    }
    case 'pc.home_node': {
      if (!isNonEmpty(b.pc_id) || !isNonEmpty(b.home_node)) throw new UnknownForwardedWrite(b.kind);
      return { kind: 'pc.home_node', pc_id: b.pc_id, home_node: b.home_node };
    }
    case 'pc.presence': {
      if (!isNonEmpty(b.pc_id) || typeof b.is_online !== 'boolean'
        || !isFiniteNumber(b.last_seen_at)) throw new UnknownForwardedWrite(b.kind);
      return {
        kind: 'pc.presence', pc_id: b.pc_id,
        is_online: b.is_online, last_seen_at: b.last_seen_at,
      };
    }
    default:
      throw new UnknownForwardedWrite(b.kind);
  }
}

/** Perform a forwarded write on the writer, through the same seams a local
 *  session would use. Exhaustive by construction — see the header. */
export function applyForwardedWrite(w: ForwardedWrite, t: ForwardTargets): void {
  switch (w.kind) {
    case 'usage.stt':
      t.usage.recordSttUsage(w.user_id, w.engine, w.duration_ms, w.chars, w.operation_id);
      return;
    case 'usage.llm':
      t.usage.recordLlmUsage(w.user_id, w.engine, w.tokens_in, w.tokens_out, w.operation_id);
      return;
    case 'usage.quota_refused':
      t.usage.recordQuotaRefusal(w.user_id, w.event_kind, w.refused_user_id);
      return;
    case 'pc.home_node':
      t.setHomeNode(w.pc_id, w.home_node);
      return;
    case 'pc.presence':
      t.setPresence(w.pc_id, w.is_online, w.last_seen_at);
      return;
    default: {
      const never: never = w;
      throw new UnknownForwardedWrite((never as { kind: unknown }).kind);
    }
  }
}
