// SPEC-REF:
//   apps/server-core/src/node/forward-sync-types.ts (the request/result shapes)
//   apps/server-core/src/node/writer-client.ts      (forwardSync — the client)
//   apps/server-core/src/http/node-routes.ts        (POST /api/node/forward-sync)
//   apps/server-core/src/socket/handlers/pc.handler.ts       (pc:release-mobile)
//   apps/server-core/src/socket/handlers/mobile.handler.ts   (mobile:unpair)
//   apps/server-core/src/socket/handlers/settings.handler.ts (settings:update)
//   docs/strategy/2026-09-02-full-implementation-audit-and-next-plan.md
//     §5-4 item 2 ("a generic sync handoff channel instead of per-event
//     mintCodeOnWriter/resolveTokenOnWriter")
//
// ── WHAT THIS FILE IS ────────────────────────────────────────────────────────
//
// `pc:refresh-code` and the handshake's token read-through each got their OWN
// route (`/api/node/mint-code`, `/api/node/resolve-token`) because each was the
// first of its kind. By the third writer-only event that needed the exact same
// shape — a replica cannot perform this write, but the write is small,
// synchronous, and the user is waiting on its ack — hand-rolling a fourth route
// would be the SAME defect `writer-client.ts`'s own header warns about: a
// second, third, fourth place the wire contract can drift.
//
// So this is ONE route (`/api/node/forward-sync`) carrying a `verb` and a
// `payload`, and this file is the writer-side dispatch table: one function per
// verb, each doing EXACTLY the DB mutation the writer's own direct-serving
// handler already performs for a non-replica caller (pc.handler.ts /
// mobile.handler.ts / settings.handler.ts, unchanged) — never the socket-level
// side effects (finding a room's live sockets, emitting, disconnecting), which
// stay on whichever node actually holds those sockets and are applied by the
// CALLING replica from the result this returns. A writer forwarding a
// `release_mobile` call has no sockets of its own for a PC connected to a
// replica; inventing socket effects here would be reaching into a room this
// process cannot see.
//
// ── WHY THE THREE MUTATIONS ARE DUPLICATED RATHER THAN SHARED WITH THE
//    HANDLERS' OWN INLINE CODE ─────────────────────────────────────────────
//
// This repeats the precedent `bootstrap-http-deps.ts`'s `mintShortCode` /
// `resolveToken` already set: the writer-only HTTP dep calls the SAME registry
// methods the socket handler's non-replica branch calls, written twice rather
// than factored into one shared function. The alternative — refactoring
// pc.handler.ts/mobile.handler.ts/settings.handler.ts's non-replica code path
// to call through this file — would touch code paths several other work
// packages are editing concurrently (WP-4, WP-7m, WP-7d, WP-8) for no behaviour
// change on the writer's own direct path. Duplication of a few registry calls
// is cheaper than that collision, and the shape is small enough that the two
// copies drifting apart would show up immediately in either file's own tests.
//
// ── VALIDATION POSTURE ───────────────────────────────────────────────────────
//
// The payload arrives over the node-to-node channel (shared secret, not user
// auth) from a replica that has ALREADY authenticated the original socket
// against its own (replicated, possibly-stale-by-seconds) copy of the
// database — the same trust boundary `mintShortCode`/`resolveToken` accept a
// bare `pc_id`/`token` across. Each function still re-checks ownership
// (`pc.user_id === req.user_id`, `pc.room_uuid === req.room_uuid`) against the
// WRITER's own authoritative rows before mutating, so a stale or malicious
// replica payload cannot widen what gets touched — this mirrors the direct
// handler's own ownership check, not a new invention.

import type { Registry } from '../room/registry';
import type { ReleaseSuppression } from '../room/release-suppression';
import type { SettingsRepo } from '../db/repos/settings.repo';
import { stampSettingProvenance } from '../settings/defaults';
import { PC_NAME_KEY, SETTINGS_STAMP_MAX_SKEW_MS, parsePcName, stampMs } from '../socket/handlers/settings.handler';
import type {
  ReleaseMobileOutcome,
  ReleaseMobileRequest,
  SettingsUpdateRequest,
  SettingsUpdateResult,
  UnpairMobileRequest,
  UnpairMobileResult,
} from './forward-sync-types';

/** THE SAME mutation pc.handler.ts's `pc:release-mobile` performs for a
 *  non-replica caller (registry.revokeMobile / suppression.suppress), minus the
 *  socket lookups — see file header. */
export function releaseMobileOnWriter(
  env: { registry: Registry; suppression?: ReleaseSuppression },
  req: ReleaseMobileRequest,
): ReleaseMobileOutcome {
  const pc = env.registry.findPc(req.pc_id);
  if (!pc || pc.user_id !== req.user_id || pc.room_uuid !== req.room_uuid) {
    return { ok: false, error: 'pc_mismatch' };
  }
  if (req.revoke && req.mobile_id === undefined) {
    return { ok: false, error: 'revoke_requires_mobile_id' };
  }
  const owned = env.registry.listMobilesForPc(pc.id).map((m) => m.id);
  const targets = req.mobile_id !== undefined ? owned.filter((id) => id === req.mobile_id) : owned;
  let suppressedMs = 0;
  let revokedCount = 0;
  for (const pairingId of targets) {
    if (req.revoke) {
      // Same idempotence as the direct path: revoking an already-gone row is
      // simply not counted, never an error — a retried ack must not look like
      // a failure.
      if (env.registry.revokeMobile(pc.id, pairingId)) revokedCount++;
      env.suppression?.clear(pairingId);
    } else {
      suppressedMs = env.suppression?.suppress(pairingId, req.reason) ?? 0;
    }
  }
  return {
    ok: true,
    result: { target_ids: targets, revoke: req.revoke, revoked_count: revokedCount, suppressed_ms: suppressedMs },
  };
}

/** THE SAME mutation mobile.handler.ts's `mobile:unpair` performs for a
 *  non-replica caller (registry.retireMobile), minus the room/socket notify. */
export function unpairMobileOnWriter(
  env: { registry: Registry },
  req: UnpairMobileRequest,
): UnpairMobileResult {
  const mobile = env.registry.retireMobile(req.pairing_id);
  if (!mobile) return { unpaired: false, mobile_id: null, pc_room_uuid: null };
  const pc = env.registry.findPc(mobile.pc_device_id);
  return { unpaired: true, mobile_id: mobile.id, pc_room_uuid: pc?.room_uuid ?? null };
}

/** THE SAME mutation settings.handler.ts's `settings:update` performs for a
 *  non-replica caller — provenance stamping, the G2 regress guard, the actual
 *  write, and the PC_NAME_KEY reserved-key branch — minus the socket fan-out
 *  (see `SettingsUpdateResult`'s doc, forward-sync-types.ts, for what the
 *  caller does with each variant). `now` returns an ISO instant, matching
 *  `SettingsHandlerDeps.now`. */
export function applySettingsUpdateOnWriter(
  env: { registry: Registry; repo: SettingsRepo; now: () => string },
  req: SettingsUpdateRequest,
): SettingsUpdateResult {
  const { registry, repo, now } = env;

  if (req.key === PC_NAME_KEY) {
    if (req.auth_kind !== 'pc' || !req.pc_device_id) return { kind: 'invalid', error: 'AUTH_TOKEN_INVALID' };
    const name = parsePcName(req.value);
    if (name === null) return { kind: 'invalid', error: 'SETTINGS_SCHEMA_INVALID' };
    const pc = registry.findPc(req.pc_device_id);
    // Row existence must not be an oracle — same rule pc.handler.ts states for
    // this exact check.
    if (!pc || pc.user_id !== req.user_id) return { kind: 'invalid', error: 'AUTH_TOKEN_INVALID' };
    registry.renamePc(pc.id, name);
    return { kind: 'pc_name', pc_id: pc.id, room_uuid: pc.room_uuid, name };
  }

  if (req.key === 'stt.routing') return { kind: 'invalid', error: 'SETTINGS_SCHEMA_INVALID' };

  let stamped: unknown;
  try {
    stamped = stampSettingProvenance(req.key, req.value);
  } catch {
    return { kind: 'invalid', error: 'SETTINGS_SYNC_FAIL' };
  }

  const wall = now();
  const incomingMs = stampMs(req.updated_at);
  const existing = repo.read(req.user_id, req.key);
  const existingMs = stampMs(existing?.updated_at);
  if (incomingMs !== null && existingMs !== null && existingMs > incomingMs) {
    return {
      kind: 'regressed',
      key: req.key,
      value: existing!.value,
      ...(existing!.updated_at !== undefined ? { updated_at: existing!.updated_at } : {}),
    };
  }

  const storedAt = incomingMs !== null && incomingMs <= Date.parse(wall) + SETTINGS_STAMP_MAX_SKEW_MS
    ? req.updated_at!
    : wall;
  try {
    repo.write(req.user_id, req.key, stamped, storedAt);
  } catch {
    return { kind: 'invalid', error: 'SETTINGS_SYNC_FAIL' };
  }
  return { kind: 'written', key: req.key, value: stamped, updated_at: storedAt };
}

// ── the dispatcher itself ────────────────────────────────────────────────────

/** What the HTTP route (`http/node-routes.ts` `NodeRoutesDeps.forwardSync`)
 *  actually calls: one function taking the verb as a string (it arrives off the
 *  wire, so it is not typed until this narrows it) plus an unvalidated
 *  payload, shape-checking BOTH here — the route does not know each verb's
 *  fields, the same division `resolve-token`'s body check draws between the
 *  route (token shape) and the writer dep (token lookup). */
export type ForwardSyncDispatcher = (
  verb: string,
  payload: unknown,
) => { ok: true; result: unknown } | { ok: false; error: string };

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function makeForwardSyncDispatcher(env: {
  registry: Registry;
  repo: SettingsRepo;
  suppression?: ReleaseSuppression;
  /** ISO-instant clock, matching `SettingsHandlerDeps.now`. Optional so tests
   *  need not inject one; production always passes the process's real clock. */
  now?: () => string;
}): ForwardSyncDispatcher {
  const now = env.now ?? ((): string => new Date().toISOString());

  return (verb, payload) => {
    if (!isPlainRecord(payload)) return { ok: false, error: 'malformed' };

    if (verb === 'release_mobile') {
      const p = payload;
      if (
        typeof p.pc_id !== 'string' || !p.pc_id
        || typeof p.user_id !== 'string' || !p.user_id
        || typeof p.room_uuid !== 'string' || !p.room_uuid
        || typeof p.revoke !== 'boolean'
        || (p.reason !== 'manual' && p.reason !== 'busy')
        || (p.mobile_id !== undefined && typeof p.mobile_id !== 'string')
      ) {
        return { ok: false, error: 'malformed' };
      }
      const req: ReleaseMobileRequest = {
        pc_id: p.pc_id, user_id: p.user_id, room_uuid: p.room_uuid,
        revoke: p.revoke, reason: p.reason,
        ...(typeof p.mobile_id === 'string' ? { mobile_id: p.mobile_id } : {}),
      };
      const outcome = releaseMobileOnWriter(
        { registry: env.registry, ...(env.suppression ? { suppression: env.suppression } : {}) },
        req,
      );
      return outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error };
    }

    if (verb === 'unpair_mobile') {
      const p = payload;
      if (typeof p.pairing_id !== 'string' || !p.pairing_id) return { ok: false, error: 'malformed' };
      const result = unpairMobileOnWriter({ registry: env.registry }, { pairing_id: p.pairing_id });
      return { ok: true, result };
    }

    if (verb === 'settings_update') {
      const p = payload;
      if (
        typeof p.user_id !== 'string' || !p.user_id
        || typeof p.key !== 'string' || !p.key
        || !('value' in p)
        || (p.auth_kind !== 'pc' && p.auth_kind !== 'mobile')
        || (p.updated_at !== undefined && typeof p.updated_at !== 'string')
        || (p.pc_device_id !== undefined && typeof p.pc_device_id !== 'string')
      ) {
        return { ok: false, error: 'malformed' };
      }
      const req: SettingsUpdateRequest = {
        user_id: p.user_id, key: p.key, value: p.value, auth_kind: p.auth_kind,
        ...(typeof p.updated_at === 'string' ? { updated_at: p.updated_at } : {}),
        ...(typeof p.pc_device_id === 'string' ? { pc_device_id: p.pc_device_id } : {}),
      };
      // 🔴 `kind: 'invalid'` is NOT a dispatch-level refusal (that would surface
      // as 409/`NODE_IS_REPLICA` at the calling handler, hiding which specific
      // rule the write broke). It is a well-formed answer from the writer —
      // exactly the same posture `mint-code`'s 404 draws between "I don't have
      // this" (a fact, passed through) and "I could not ask" (a refusal) — so it
      // travels as an ordinary `ok:true` result and settings.handler.ts unpacks
      // it into the specific ack error (AUTH_TOKEN_INVALID / etc).
      const result = applySettingsUpdateOnWriter({ registry: env.registry, repo: env.repo, now }, req);
      return { ok: true, result };
    }

    return { ok: false, error: 'unknown_verb' };
  };
}
