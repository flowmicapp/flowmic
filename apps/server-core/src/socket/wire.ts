// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3 (every event payload validated by the
//     @flowmic/protocol zod schema; unknown events rejected — whitelist)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D1 (no silent failure)
//
// Thin per-socket helpers shared by every handler. Inbound payloads are parsed
// with the protocol package's safeParseEvent (the event-name generic is
// constrained to EventName, so a non-whitelisted name is a compile error);
// combined with the protocol-whitelist lint on the .on()/.emit() literals, no
// event name can be used that is not in @flowmic/protocol. Errors always carry
// a whitelisted code (errorPayload) — never a bare throw across the wire.

import type { Socket } from 'socket.io';
import type { Plan } from '@flowmic/protocol';
import type { AuthContext } from '../auth/middleware';

export type Ack = (payload: unknown) => void;

/** The saas ACCOUNT identity a socket carries — from a verified handshake JWT
 *  (auth/middleware) OR an in-session mobile:login. Distinct from `auth` (the
 *  device/pairing identity): a socket can be account-authenticated before it
 *  has any pairing (that is exactly the cloud-instance admission precondition). */
export interface AccountContext {
  userId: string;
  plan: Plan;
  /** JWT expiry, seconds-since-epoch — arms the auth:expired watchdog (F-2093). */
  exp: number;
}

/** Why a handshake JWT failed to authenticate — lets an identity-required op
 *  answer AUTH_TOKEN_EXPIRED vs AUTH_TOKEN_INVALID truthfully (frozen contract). */
export type AccountAuthError = 'AUTH_TOKEN_INVALID' | 'AUTH_TOKEN_EXPIRED';

/** The acting user for an identity-required op: a resolved userId, or the
 *  fail-loud error code to ack when no truthful identity exists. */
export type ActingIdentity = { userId: string } | { error: AccountAuthError };

export function safeAck(ack: unknown, payload: unknown): void {
  if (typeof ack === 'function') (ack as Ack)(payload);
}

export function getAuth(socket: Socket): AuthContext | null {
  return (socket.data as { auth?: AuthContext | null }).auth ?? null;
}

export function getAccount(socket: Socket): AccountContext | null {
  return (socket.data as { account?: AccountContext | null }).account ?? null;
}

export function setAccount(socket: Socket, account: AccountContext | null): void {
  (socket.data as { account?: AccountContext | null }).account = account;
}

export function getAccountAuthError(socket: Socket): AccountAuthError | null {
  return (socket.data as { accountAuthError?: AccountAuthError | null }).accountAuthError ?? null;
}

export function setAccountAuthError(socket: Socket, err: AccountAuthError | null): void {
  (socket.data as { accountAuthError?: AccountAuthError | null }).accountAuthError = err;
}

/** Mark this socket as a cloud-instance solo session (F-3140).
 *
 *  ⚠️ 0.2.27 — READ THIS BEFORE TRUSTING THE OLD COMMENT. It used to say 「the
 *  plaintext history:create path reads this to refuse server-side history」, and
 *  that consumer is GONE: history:create now refuses EVERY session
 *  (HISTORY_SYNC_RETIRED), cloud or not, so it no longer asks. `grep isCloudSession`
 *  today returns this file only ⇒ **the flag is written (mobile.handler, on
 *  cloud-instance admission) and read by nobody.**
 *
 *  Left in place rather than deleted by the retirement worker for two stated
 *  reasons, neither of which is 「it might be useful」: ① the write site is inside
 *  the pairing/admission path, which CLAUDE.md puts behind line-by-line human
 *  audit; ② window E (lightweight-record e2e:v1: + grants) is the next card and a
 *  cloud-instance solo session is a real distinction there. **It is the lead's call:
 *  give it a reader in window E, or delete both halves.** Until one of those
 *  happens this is a known write-only flag, named here so it cannot pass as
 *  load-bearing. */
export function setCloudSession(socket: Socket): void {
  (socket.data as { cloudSession?: boolean }).cloudSession = true;
}

export function isCloudSession(socket: Socket): boolean {
  return (socket.data as { cloudSession?: boolean }).cloudSession === true;
}

export function getRoomUuid(socket: Socket): string | null {
  return (socket.data as { roomUuid?: string }).roomUuid ?? null;
}

export function setRoomUuid(socket: Socket, roomUuid: string): void {
  (socket.data as { roomUuid?: string }).roomUuid = roomUuid;
}

export function setAuth(socket: Socket, auth: AuthContext): void {
  (socket.data as { auth?: AuthContext | null }).auth = auth;
}
