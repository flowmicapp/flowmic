// W6c — Socket Origin admission follows the server-minted room→key relation.
// CORS only grants transport access: WebSockets ignore it, and the key is not
// known on a polling preflight. Every room admission below asks its OWN key.
// Origin is browser-supplied, not an authentication factor outside browsers.
// HUMAN-AUDIT SENSITIVE: pairing and integration origin admission.
import type { Socket } from 'socket.io';
import type { PcRecord } from '../db/repos/pc.repo';
import type { IntegratorKeyRepo } from '../db/repos/integrator-key.repo';
import { normalizeOrigin, originAllowed } from '../billing/integrator-quota';
import { boundIntegratorKey } from '../room/integrator-room-key';
import { ServerError } from '../errors';
import { getAuth } from './wire';
import { logAuthRefusal } from '../auth/refusal-log';

type Pc = Pick<PcRecord, 'id' | 'user_id' | 'room_kind'>;
type Leg = 'pc' | 'mobile';
type Next = (error?: Error) => void;
type Middleware = (socket: unknown, next: Next) => void;
export type IntegratorOriginGuard = (pc: Pc, leg: Leg, origin: string | undefined) => void;

export function assertIntegratorOrigin(
  guard: IntegratorOriginGuard | undefined, pc: Pc | null, socket: Socket, leg: Leg,
): void {
  if (pc?.room_kind !== 'integrator') return;
  // An omitted DI seam cannot turn off an integrator admission gate.
  if (!guard) throw new ServerError('PC_HANDSHAKE_PENDING');
  guard(pc, leg, socket.handshake.headers.origin);
}

export function makeIntegratorOriginPolicy(deps: {
  keys: Pick<IntegratorKeyRepo, 'keyIdForRoom' | 'findById' | 'listActiveOrigins'>;
  findPc(id: string): PcRecord | null;
  firstPartyOrigins: readonly string[];
}) {
  const firstParty = (origin: string | undefined): boolean => {
    const normalized = normalizeOrigin(origin);
    return normalized !== null && deps.firstPartyOrigins.some((o) => normalizeOrigin(o) === normalized);
  };
  const assert: IntegratorOriginGuard = (pc, leg, origin) => {
    const key = boundIntegratorKey(deps.keys, pc);
    if (key === null) throw new ServerError('PC_HANDSHAKE_PENDING');
    if (key.revoked_at !== null) throw new ServerError('INTEGRATOR_QUOTA_EXCEEDED');
    // Native phones do not send Origin. The first-party /go page is the other
    // legitimate scanning microphone. Neither exception is a target-page grant.
    if (leg === 'mobile' && (origin === undefined || firstParty(origin))) return;
    if (!originAllowed(key, origin)) throw new ServerError('WEB_ROOM_ORIGIN_NOT_ALLOWED');
  };
  return {
    assert,
    // Only registered live key origins supplement the existing transport list.
    // This union is NOT a room permission; assert() above is the room decision.
    corsOrigin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void {
      try {
        const normalized = normalizeOrigin(origin);
        callback(null, origin === undefined || firstParty(origin) || (
          normalized !== null && deps.keys.listActiveOrigins().some((o) => normalizeOrigin(o) === normalized)
        ));
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    wrapHandshake(base: Middleware): Middleware {
      return (unknownSocket, next) => base(unknownSocket, (error) => {
        if (error) return next(error);
        const socket = unknownSocket as Socket;
        const auth = getAuth(socket);
        if (!auth?.deviceId || (auth.kind !== 'pc' && auth.kind !== 'mobile')) return next();
        try {
          const pc = deps.findPc(auth.deviceId);
          if (pc === null) throw new ServerError('PC_HANDSHAKE_PENDING');
          assertIntegratorOrigin(assert, pc, socket, auth.kind);
          next();
        } catch (failure) {
          const code = failure instanceof ServerError ? failure.code : 'PC_HANDSHAKE_PENDING';
          logAuthRefusal({ code, where: 'integrator-origin-handshake', kind: auth.kind, userId: auth.userId });
          next(new Error(code));
        }
      });
    },
  };
}
