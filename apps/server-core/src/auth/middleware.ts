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
//
// 2026-08-31 — with ONE exception, and only where a `TokenReadThroughSeam` is
// wired (a multi-node replica): a token this node's database does not have is a
// MAYBE rather than a no, because replication makes rows arrive late. The miss
// path asks the writer once, lands the rows locally, and repeats the same local
// lookup. Every failure of that — no seam, unreachable writer, an authoritative
// 「never heard of it」 — falls back to exactly the refusal above.

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

/**
 * 2026-08-31 multi-node (P0-①) — the ONE thing a replica may do about a token
 * its own database has never seen: ask the writer, land the rows, look again.
 *
 * ⚠️ TWO CONSUMERS SINCE Z4, AND DELIBERATELY ONE TYPE. This seam is also the
 * `mobile:reconnect` handler's (socket/handlers/mobile.handler.ts): that event
 * resolves the same token against the same local database and, before Z4, could
 * ack AUTH_TOKEN_INVALID for a perfectly valid one. Both consumers are handed
 * the SAME `makeTokenReadThrough` instance by bootstrap, so the shape check, the
 * single-flight table and the writer-call budget are shared — two instances
 * would be two budgets, and a flood arriving on both paths would cost the writer
 * twice what either one promises.
 *
 * 🔴 PRESENT ONLY ON A REPLICA WITH A WRITER CLIENT. Absent on the writer and on
 * every single-node deployment, and that absence is the compatibility guarantee:
 * with no read-through the branch below is the same `next(new Error(...))` on the
 * same tick that shipped yesterday. It is not gated by a role check here —
 * nothing in this file knows what a role is, and adding that knowledge would put
 * a second author on 「may this node ask」 (node-runtime.ts is the first).
 *
 * `resolve` resolves `true` when the rows are now local. It NEVER rejects — see
 * node/token-read-through.ts, where every failure is turned into `false`
 * precisely so this file cannot grow a catch that decides what an outage means.
 */
export interface TokenReadThroughSeam {
  resolve(token: string): Promise<boolean>;
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

/**
 * Resolve `rawToken` out of THIS node's database and stash the AuthContext.
 * Returns whether it landed.
 *
 * 🔴 Extracted so the local hit and the post-read-through retry are LITERALLY
 * the same code. The rule this file exists to enforce — 「what this token means」
 * — must have one author; a second, remote-shaped branch that built an
 * AuthContext from a response body would agree with this one only until somebody
 * edited one of them.
 */
function resolveLocally(lookup: TokenLookup, rawToken: string, data: Record<string, unknown>): boolean {
  const pcRow = lookup.findPcByToken(rawToken);
  if (pcRow) {
    data.auth = { userId: pcRow.user_id, deviceId: pcRow.id, kind: 'pc' } satisfies AuthContext;
    return true;
  }
  const mobileRow = lookup.findMobileByToken(rawToken);
  if (mobileRow) {
    data.auth = {
      userId: mobileRow.user_id,
      pairingId: mobileRow.id,
      deviceId: mobileRow.pc_device_id,
      kind: 'mobile',
    } satisfies AuthContext;
    return true;
  }
  return false;
}

export function authMiddleware(
  lookup: TokenLookup,
  jwt?: JwtHandshakeConfig,
  readThrough?: TokenReadThroughSeam,
): (socket: unknown, next: Next) => void {
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
      if (resolveLocally(lookup, rawToken, data)) {
        next();
        return;
      }
      // ── LOCAL MISS ──────────────────────────────────────────────────────
      //
      // On a single node and on the writer, `readThrough` is undefined and this
      // is the line that has always been here: a token nobody has is invalid,
      // refused on this tick, with no I/O.
      //
      // 🔴 ON A REPLICA A LOCAL MISS IS A MAYBE, NOT A NO. Replication makes
      // rows arrive late; it never invents them. A pairing minted on the writer
      // seconds ago is genuinely valid and genuinely absent here — the same
      // asymmetry `/api/node/locate` already answers with 「ask the writer」
      // rather than with 「unknown」. So we ask, land the rows, and redo the
      // lookup above. If any part of that does not work, we land back on this
      // same refusal.
      if (!readThrough) {
        next(new Error('AUTH_TOKEN_INVALID'));
        return;
      }
      void readThrough.resolve(rawToken).then(
        (landed) => {
          if (landed && resolveLocally(lookup, rawToken, data)) {
            next();
            return;
          }
          next(new Error('AUTH_TOKEN_INVALID'));
        },
        // Unreachable by contract (the seam never rejects) and wired anyway: an
        // unhandled rejection here would leave `next` uncalled, and a handshake
        // that is never answered is the ONE failure this path must not have.
        () => next(new Error('AUTH_TOKEN_INVALID')),
      );
    } catch (err) {
      const wrapped = new Error('AUTH_TOKEN_INVALID');
      (wrapped as Error & { cause?: unknown }).cause = err;
      next(wrapped);
    }
  };
}
