// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §2 (handshake / schema_ver negotiation:
//     the negotiation result never causes a connection refusal; an old client
//     connecting to a new server degrades gracefully by capability)
//   docs/rebuild/05-DATA-MODEL.md §7 (device/mobile tokens)
//   Ported mechanism from legacy auth/middleware.ts + auth/schema-negotiation.ts;
//   schema_ver source is @flowmic/protocol PROTOCOL_SCHEMA_VERSION.
//
// Socket.io connection-time middleware. Reads the optional opaque token +
// optional schema_ver off socket.handshake.auth, resolves the token to an
// AuthContext, and ALWAYS stashes a schema negotiation. schema_ver NEVER gates
// the connection (a client that omits it folds to legacy=1). No token is
// permitted (register/pair flows connect first, get their token mid-session);
// a present-but-unknown token is rejected AUTH_TOKEN_INVALID.

import { PROTOCOL_SCHEMA_VERSION, type Plan } from '@flowmic/protocol';
import { isValidTokenShape } from './token';
import { verifyJwt, JwtError } from './jwt';

/** GRANT-1 (2026-08-11): 'web' is the THIRD kind — a browser session holding a
 *  valid account JWT and no device credential. It exists so the timeline grant
 *  gates can answer "what can this kind of client say" by kind instead of by
 *  guessing, and so a browser's refusals stop borrowing AUTH_TOKEN_INVALID
 *  (whose copy lies about a JWT that is in fact valid). Assigned ONLY in the
 *  declared-web branch below — the pc/mobile token paths never produce it. */
export type AuthKind = 'pc' | 'mobile' | 'web';

export interface AuthContext {
  userId: string;
  deviceId?: string;
  pairingId?: string;
  kind: AuthKind;
}

export interface SchemaNegotiation {
  clientSchemaVer: number;
  serverSchemaVer: number;
  compat: 'current' | 'client-legacy' | 'client-newer';
}

export interface PcLookupRow {
  id: string;
  user_id: string;
}
export interface MobileLookupRow {
  id: string;
  user_id: string;
  pc_device_id: string;
}
export interface TokenLookup {
  findPcByToken(token: string): PcLookupRow | null;
  findMobileByToken(token: string): MobileLookupRow | null;
}

/** Fold any non-positive-integer (incl. absent) client schema_ver to legacy=1;
 *  never rejects — pure capability metadata. */
export function negotiateSchemaVer(
  rawClientVer: unknown,
  serverSchemaVer: number = PROTOCOL_SCHEMA_VERSION,
): SchemaNegotiation {
  const clientSchemaVer =
    typeof rawClientVer === 'number' && Number.isInteger(rawClientVer) && rawClientVer > 0 ? rawClientVer : 1;
  const compat =
    clientSchemaVer === serverSchemaVer ? 'current' : clientSchemaVer < serverSchemaVer ? 'client-legacy' : 'client-newer';
  return { clientSchemaVer, serverSchemaVer, compat };
}

interface HandshakeShape {
  handshake?: { auth?: Record<string, unknown> };
  data?: Record<string, unknown>;
}
type Next = (err?: Error) => void;

/** saas-only handshake-JWT verification config (present ⇔ saas). Bootstrap
 *  injects the same explicit secret the REST routes sign with. Absent in
 *  standalone, so the whole account path is inert there (byte-identical). */
export interface JwtHandshakeConfig {
  secret: Buffer;
  /** ms-since-epoch clock; defaults to Date.now. Injectable for tests. */
  nowMs?: () => number;
}

interface AccountData {
  userId: string;
  plan: Plan;
  exp: number;
}

/** Resolve an optional handshake `jwt` (saas). NEVER rejects the connection
 *  (04 §2: the negotiation result never causes a connection refusal) — a
 *  bad/expired JWT leaves the socket unauthenticated and an identity-required op
 *  fails loud later with the recorded code (AUTH_TOKEN_INVALID / AUTH_TOKEN_EXPIRED
 *  per the frozen contract). */
function resolveHandshakeJwt(rawJwt: unknown, jwt: JwtHandshakeConfig, data: Record<string, unknown>): void {
  if (typeof rawJwt !== 'string' || rawJwt.length === 0) return; // no JWT → not an account socket
  try {
    const claims = verifyJwt(rawJwt, { secret: jwt.secret, now: jwt.nowMs ?? Date.now });
    data.account = { userId: claims.sub, plan: claims.plan, exp: claims.exp } satisfies AccountData;
  } catch (err) {
    data.account = null;
    data.accountAuthError = err instanceof JwtError && err.code === 'JWT_EXPIRED' ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID';
  }
}

export function authMiddleware(lookup: TokenLookup, jwt?: JwtHandshakeConfig): (socket: unknown, next: Next) => void {
  return (socketUnknown: unknown, next: Next): void => {
    const socket = socketUnknown as HandshakeShape;
    const data = (socket.data ??= {});
    data.schemaNegotiation = negotiateSchemaVer(socket.handshake?.auth?.schema_ver);
    // saas: resolve the optional account JWT first (sets data.account or records
    // the failure). The opaque device/mobile token path below is independent and
    // owns the next() call — a standalone reconnect is entirely unaffected.
    if (jwt) resolveHandshakeJwt(socket.handshake?.auth?.jwt, jwt, data);
    const rawToken = socket.handshake?.auth?.token;

    // No token → register / pair flows connect first (auth stays null)…
    if (rawToken === undefined || rawToken === null || rawToken === '') {
      // …EXCEPT a browser session that DECLARES itself (GRANT-1, design
      // §3.3): handshake `client: 'web'` + a jwt that verified above ⇒ a
      // third-kind AuthContext {kind:'web'} (userId = the verified sub, no
      // device, no pairing).
      //
      // 🔴 WHY DECLARED, NOT INFERRED FROM "jwt-only". The design sketch said
      // "JWT-only (no pairing/device token) ⇒ web", and the tree contradicts
      // it: a jwt-only handshake is ALSO the phone's cloud-instance admission path
      // (mobile socket_core.dart sends `jwt` exactly when admitting the cloud
      // instance, then emits mobile:pair {cloud_instance:true} — pinned by
      // test/saas-cloud-admission.test.ts over a real server). Inferring 'web'
      // from jwt-only would put every cloud phone behind the web default-deny
      // allowlist and kill its admission — so the browser (card GRANT-3, code
      // we own) must SAY what it is. The marker is an additive handshake field
      // like schema_ver; an absent/unknown value lands in the unchanged
      // `auth = null` line below, byte-identical to pre-GRANT-1 (pinned by
      // test/web-identity-middleware.test.ts).
      //
      // Declaring web with an INVALID/absent jwt earns nothing: account is
      // null, so the socket stays unauthenticated exactly as today
      // (fail-closed — a declaration is a request for LESS capability, never a
      // credential). Declaring web WITH a device token never reaches here (the
      // token path below owns that branch, byte-identical) — a device
      // credential makes it a device socket, and the marker is ignored.
      const account = data.account as { userId?: unknown } | null | undefined;
      if (
        socket.handshake?.auth?.client === 'web' &&
        account !== null && account !== undefined &&
        typeof account.userId === 'string'
      ) {
        data.auth = { userId: account.userId, kind: 'web' } satisfies AuthContext;
        next();
        return;
      }
      data.auth = null;
      next();
      return;
    }
    if (!isValidTokenShape(rawToken)) {
      next(new Error('AUTH_TOKEN_INVALID'));
      return;
    }
    try {
      const pcRow = lookup.findPcByToken(rawToken);
      if (pcRow) {
        data.auth = { userId: pcRow.user_id, deviceId: pcRow.id, kind: 'pc' } satisfies AuthContext;
        next();
        return;
      }
      const mobileRow = lookup.findMobileByToken(rawToken);
      if (mobileRow) {
        data.auth = {
          userId: mobileRow.user_id,
          pairingId: mobileRow.id,
          deviceId: mobileRow.pc_device_id,
          kind: 'mobile',
        } satisfies AuthContext;
        next();
        return;
      }
      next(new Error('AUTH_TOKEN_INVALID'));
    } catch (err) {
      const wrapped = new Error('AUTH_TOKEN_INVALID');
      (wrapped as Error & { cause?: unknown }).cause = err;
      next(wrapped);
    }
  };
}
