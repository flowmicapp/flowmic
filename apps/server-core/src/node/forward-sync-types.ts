// SPEC-REF: apps/server-core/src/node/forward-sync.ts (the writer-side dispatch
//   this describes) — read that file's header first.
//
// Pure types, zero imports, on purpose: `forward-sync.ts` (the writer-side
// dispatcher) needs VALUES from the socket handlers (`PC_NAME_KEY`,
// `parsePcName`, `stampMs`), and the socket handlers need these TYPES to talk
// to the dispatcher through `WriterClient.forwardSync`. Putting the types in
// the same file as the writer-side functions would make that a value-level
// import cycle (handler → forward-sync.ts → handler); putting them here, with
// nothing imported back, means every arrow in that graph point one way.

import type { SuppressReason } from '../room/release-suppression';

export type ForwardSyncVerb = 'release_mobile' | 'unpair_mobile' | 'settings_update';

// ── release_mobile ───────────────────────────────────────────────────────────

export interface ReleaseMobileRequest {
  pc_id: string;
  user_id: string;
  room_uuid: string;
  revoke: boolean;
  reason: SuppressReason;
  mobile_id?: string;
}

export interface ReleaseMobileResult {
  /** The FULL target set (mirrors `pc.handler.ts`'s own `targets`), not only
   *  the ones actually revoked — the direct path applies its local socket
   *  effect (emit + disconnect) to every target regardless of whether the DB
   *  row still existed to revoke, and the forwarded path must match that. */
  target_ids: string[];
  revoke: boolean;
  /** How many of `target_ids` the writer's `registry.revokeMobile` actually
   *  returned true for — the direct path's own `revoked` ack field, exposed as
   *  a DIAGNOSTIC count (some targets can already be gone). Meaningless when
   *  `revoke` is false (a suppress never "revokes" anything); always 0 then. */
  revoked_count: number;
  suppressed_ms: number;
}

export type ReleaseMobileOutcome =
  | { ok: true; result: ReleaseMobileResult }
  | { ok: false; error: 'pc_mismatch' | 'revoke_requires_mobile_id' };

// ── unpair_mobile ────────────────────────────────────────────────────────────

export interface UnpairMobileRequest {
  pairing_id: string;
}

export interface UnpairMobileResult {
  unpaired: boolean;
  mobile_id: string | null;
  pc_room_uuid: string | null;
}

// ── settings_update ──────────────────────────────────────────────────────────

export interface SettingsUpdateRequest {
  user_id: string;
  key: string;
  value: unknown;
  updated_at?: string;
  auth_kind: 'pc' | 'mobile';
  pc_device_id?: string;
}

export type SettingsUpdateResult =
  | { kind: 'invalid'; error: 'AUTH_TOKEN_INVALID' | 'SETTINGS_SCHEMA_INVALID' | 'SETTINGS_SYNC_FAIL' }
  | { kind: 'pc_name'; pc_id: string; room_uuid: string; name: string }
  | { kind: 'regressed'; key: string; value: unknown; updated_at?: string }
  | { kind: 'written'; key: string; value: unknown; updated_at: string };

// ── runtime shape guards ─────────────────────────────────────────────────────
//
// `node/node-runtime.ts` wraps the generic `WriterClient.forwardSync`'s
// `unknown` result into these typed per-verb functions, and each socket
// handler trusts the typed shape completely. These guards are that trust's
// only foundation: a rolling deploy can put a replica ahead of or behind the
// writer's result shape for however long the deploy takes, and a bad shape
// must degrade to the honest `refused` outcome (falls back to `NODE_IS_REPLICA`
// at the handler) rather than throw an unhandled exception into a socket ack.

export function isReleaseMobileResult(v: unknown): v is ReleaseMobileResult {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return Array.isArray(r.target_ids) && r.target_ids.every((x) => typeof x === 'string')
    && typeof r.revoke === 'boolean'
    && typeof r.revoked_count === 'number'
    && typeof r.suppressed_ms === 'number';
}

export function isUnpairMobileResult(v: unknown): v is UnpairMobileResult {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.unpaired === 'boolean'
    && (r.mobile_id === null || typeof r.mobile_id === 'string')
    && (r.pc_room_uuid === null || typeof r.pc_room_uuid === 'string');
}

export function isSettingsUpdateResult(v: unknown): v is SettingsUpdateResult {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  switch (r.kind) {
    case 'invalid':
      return r.error === 'AUTH_TOKEN_INVALID' || r.error === 'SETTINGS_SCHEMA_INVALID' || r.error === 'SETTINGS_SYNC_FAIL';
    case 'pc_name':
      return typeof r.pc_id === 'string' && typeof r.room_uuid === 'string' && typeof r.name === 'string';
    case 'regressed':
      return typeof r.key === 'string' && 'value' in r && (r.updated_at === undefined || typeof r.updated_at === 'string');
    case 'written':
      return typeof r.key === 'string' && 'value' in r && typeof r.updated_at === 'string';
    default:
      return false;
  }
}
