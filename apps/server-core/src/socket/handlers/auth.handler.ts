// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (mobile:login / mobile:logout ack
//     shapes)
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md — frozen wire contract:
//     mobile:login(saas) → {ok:true, token:<JWT>, user:{id,email,display_name,
//       plan}, mode:'saas'} | {error:'AUTH_LOGIN_FAILED'}
//     mobile:login(standalone) → {ok:true, mode:'standalone'} (legacy byte-compat,
//       NO token); mobile:logout → {ok:true, mode}
//   *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***
//
// In STANDALONE the app needs no credentials — these ack {ok:true,
// mode:'standalone'} byte-identical to the legacy stub (the deviation from the
// legacy AUTH_USE_REST_LOGIN saas rejection is a coordinator ruling: saas
// mobile:login now does REAL credential verification over the socket, marks the
// socket account-authenticated in-session, and returns a JWT). Passwords/hashes
// never appear in an ack or a log line here.

import type { Socket } from 'socket.io';
import { safeParseEvent, type ServerMode } from '@flowmic/protocol';
import type { AuthService } from '../../auth/auth-service';
import type { RegisterRateLimiter } from '../../auth/register-rate-limit';
import type { QrGrantStore } from '../../auth/qr-grant';
import { safeAck, setAccount } from '../wire';
import { armAuthExpiry, type AuthExpiryClock } from './auth-expiry';
import { clientIpFromHandshake } from '../../http/trusted-proxy';

export interface AuthHandlerDeps {
  mode: ServerMode;
  /** Credential service — required in saas; unused in standalone. */
  auth?: AuthService;
  /** Watchdog clock (saas) — arms auth:expired at the minted JWT's exp. */
  clock?: AuthExpiryClock;
  /** Per-IP credential-guess throttle (saas). SHARED with REST /api/login so the
   *  socket login channel cannot bypass the REST throttle — one per-IP budget
   *  across both credential channels. Absent → no socket-login throttle. */
  loginLimiter?: RegisterRateLimiter;
  /** GA-31 QR-code login — the same store the console mints into over REST. Absent ⇒ a
   *  `{qr_nonce}` login is REFUSED (AUTH_LOGIN_FAILED), never quietly ignored. */
  qrGrants?: QrGrantStore;
}

/** The client IP behind the socket — mirrors mobile.handler.socketIp and
 *  auth-routes.clientIp through the SAME derivation (http/trusted-proxy.ts,
 *  0.3.0 M3). This limiter SHARES the per-IP budget with REST /api/login, so the
 *  two channels must key identically: behind a trusted proxy both now use the
 *  proxy-appended X-Forwarded-For client; with FLOWMIC_TRUSTED_PROXIES unset
 *  both use the direct peer, unchanged. Empty string buckets deterministically
 *  when unavailable.
 *
 *  🔴 IT-39 — THE `''` BUCKET, PUT ON THE RECORD (not fixed; made known).
 *  "Buckets deterministically" above is true and says less than it sounds like.
 *  When no address can be derived — `clientIpFromHandshake` answers `''` for an
 *  absent handshake or an absent `handshake.address`, and the `|| ''` here folds
 *  a present-but-empty value onto the same key — the limiter key is the EMPTY
 *  STRING, and every such caller SHARES ONE BUDGET. On THIS handler that budget
 *  is the credential-guess one, and it is shared with REST /api/login (see the
 *  paragraph above), so the collapse is wider here than on the pairing side.
 *  Two consequences, pointing opposite ways:
 *    · fail-SAFE against an attacker — becoming unidentifiable buys no fresh
 *      budget; `''` is a bucket, not a bypass;
 *    · fail-HARSH toward bystanders — if addresses were ever unavailable in
 *      bulk, unrelated clients would throttle one another out of logging in.
 *  Left as-is on purpose: on every path we ship, engine.io populates
 *  `handshake.address`, so this bucket is empty in production. Pinned by
 *  test/pair-code-budget.test.ts ("socketIp() empty-value collapse bucket") so it is a tested
 *  property rather than an accident nobody has measured.
 *  ⚠️ This comment is duplicated VERBATIM in scope at mobile.handler.ts
 *  `socketIp` — the function is duplicated, so the record has to be too. */
function socketIp(socket: Socket): string {
  return clientIpFromHandshake(socket.handshake) || '';
}

export function registerAuthHandlers(socket: Socket, deps: AuthHandlerDeps): void {
  const { mode } = deps;

  socket.on('mobile:login', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('mobile:login', payload);
    if (!parsed.success) return safeAck(ack, { error: 'SETTINGS_SCHEMA_INVALID' });
    if (mode !== 'saas' || !deps.auth) {
      // Standalone: byte-identical to the legacy auto-login stub. No token.
      return safeAck(ack, { ok: true, mode: 'standalone' });
    }
    // Throttle BEFORE the scrypt verify (defense-in-depth + don't spend hashing
    // CPU on a throttled attacker). Same honest code + shared per-IP budget as
    // REST /api/login — the socket channel is not an unthrottled password oracle.
    if (deps.loginLimiter) {
      const ip = socketIp(socket);
      if (!deps.loginLimiter.check(ip).allowed) return safeAck(ack, { error: 'REGISTER_RATE_LIMITED', retryable: true });
      deps.loginLimiter.record(ip);
    }
    const service = deps.auth;
    // ── GA-31: the QR arm of the union. Redeemed BEFORE any password work,
    // because it carries no password at all. The grant is single-use and bound
    // to the user it was minted for, so this cannot name another account; an
    // unknown / expired / already-used nonce is AUTH_LOGIN_FAILED — the SAME
    // answer a wrong password gets, so the wire is not an existence oracle.
    // Narrowed by hand rather than by `in`: safeParseEvent widens the union's
    // output, and an auth branch is the last place to lean on inference.
    const nonce = (parsed.data as { qr_nonce?: unknown }).qr_nonce;
    if (typeof nonce === 'string') {
      const userId = deps.qrGrants?.redeem(nonce) ?? null;
      if (userId === null) return safeAck(ack, { error: 'AUTH_LOGIN_FAILED' });
      const user = service.getUser(userId);
      if (!user) return safeAck(ack, { error: 'AUTH_LOGIN_FAILED' });
      const issued = service.issueToken(user);
      setAccount(socket, { userId: user.id, plan: issued.plan, exp: issued.exp });
      armAuthExpiry(socket, issued.exp, deps.clock ?? {});
      // Byte-identical to the password ack, so the phone's existing success path
      // needs no branch at all — one way in, one shape out.
      return safeAck(ack, { ok: true, token: issued.token, user: service.publicUser(user), mode: 'saas' });
    }
    const credential = parsed.data as { email: string; password: string };
    void (async (): Promise<void> => {
      const user = await service.verifyCredentials(credential.email, credential.password);
      if (!user) return safeAck(ack, { error: 'AUTH_LOGIN_FAILED' });
      const issued = service.issueToken(user);
      // Mark the socket account-authenticated in-session (so a same-socket
      // cloud-instance pair needs no separate handshake JWT), and arm the
      // expiry watchdog at the minted token's exp (identity rests on a JWT).
      setAccount(socket, { userId: user.id, plan: issued.plan, exp: issued.exp });
      armAuthExpiry(socket, issued.exp, deps.clock ?? {});
      safeAck(ack, { ok: true, token: issued.token, user: service.publicUser(user), mode: 'saas' });
    })();
  });

  // What this handler CAN honestly promise, and what the phone is allowed to
  // read out of its ack (owner ruling A5-4 / E4):
  //   {ok:true, mode:'saas'}  = "the account server received your sign-out and
  //                              dropped this socket's in-session identity".
  //   {ok:true, mode:'standalone'} = "some LAN box received it" — it has no
  //                              account authority at all, which is why the
  //                              phone must NOT count it as a cloud sign-out.
  // What it does NOT do: revoke the JWT. setAccount(socket, null) clears an
  // in-memory marker that dies with the socket anyway; the minted token stays
  // valid until its exp (7 days — auth/jwt.ts DEFAULT_TTL_MS) because there is
  // no jti denylist. Real revocation is W4-4, deferred until the H5 security
  // assessment reports. Nothing here may be worded as revoke/invalidate.
  socket.on('mobile:logout', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('mobile:logout', payload);
    if (!parsed.success) return safeAck(ack, { error: 'SETTINGS_SCHEMA_INVALID' });
    if (mode !== 'saas') return safeAck(ack, { ok: true, mode: 'standalone' });
    // Drop any in-session account identity (the pairing identity, if any, is
    // independent and untouched — logout is an account-scope operation).
    setAccount(socket, null);
    safeAck(ack, { ok: true, mode: 'saas' });
  });
}
