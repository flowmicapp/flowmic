// Card GRANT-1 — the third AuthKind ('web') at the handshake middleware, and
// above all the REGRESSION PINS: the pc/mobile token paths and the marker-less
// jwt path must come out of authMiddleware BYTE-IDENTICAL to pre-GRANT-1.
//
// WHY THE MARKER EXISTS (the tree-contradiction this file pins): the design
// sketch said "JWT-only (no pairing/device token) ⇒ kind:'web'", and the tree
// contradicts it — a jwt-only handshake is the production PHONE's
// cloud-instance admission shape (mobile socket_core.dart attaches `jwt`
// exactly when admitting the cloud instance; test/saas-cloud-admission.test.ts
// drives it over a real server). So 'web' is DECLARED (`client: 'web'`), never
// inferred, and the marker-less jwt handshake stays `auth: null` exactly as
// before. The wire-level half of this pin (a marker-less jwt socket still
// completes mobile:pair {cloud_instance}) lives in web-grant-preview.test.ts.

import { describe, expect, it } from 'vitest';
import { authMiddleware, type TokenLookup } from '../src/auth/middleware';
import { signJwt } from '../src/auth/jwt';

const SECRET_BUF = Buffer.from('web-identity-mw-secret-32-bytes-xx', 'utf8');
const NOW = 1_754_900_000_000;

// Shape-valid opaque tokens (fm_ + 64 hex — isValidTokenShape gates the token
// path before any lookup runs, so a fake that flunks the shape would test the
// shape check instead of the lookup path).
const PC_TOKEN = 'fm_' + 'a'.repeat(64);
const MOB_TOKEN = 'fm_' + 'b'.repeat(64);
const UNKNOWN_TOKEN = 'fm_' + 'c'.repeat(64);

const lookup: TokenLookup = {
  findPcByToken: (t) => (t === PC_TOKEN ? { id: 'pc-1', user_id: 'u-pc' } : null),
  findMobileByToken: (t) => (t === MOB_TOKEN ? { id: 'pair-1', user_id: 'u-mob', pc_device_id: 'pc-1' } : null),
};

interface RunResult {
  err: string | null;
  data: Record<string, unknown>;
}

/** Drive the REAL middleware over a fake handshake, saas-shaped (jwt config
 *  present) unless `saas: false`. */
function run(auth: Record<string, unknown>, opts: { saas?: boolean } = {}): RunResult {
  const socket = { handshake: { auth }, data: {} as Record<string, unknown> };
  let err: Error | undefined;
  const mw = authMiddleware(lookup, opts.saas === false ? undefined : { secret: SECRET_BUF, nowMs: () => NOW });
  mw(socket, (e) => { err = e; });
  return { err: err ? err.message : null, data: socket.data };
}

function goodJwt(sub = 'u-web'): string {
  return signJwt({ sub, plan: 'free' }, { secret: SECRET_BUF, ttlMs: 3_600_000, now: () => NOW });
}

describe('kind:web is DECLARED + verified, never inferred', () => {
  it('jwt + client:"web" → AuthContext {userId, kind:"web"} and nothing else on it', () => {
    const r = run({ jwt: goodJwt(), client: 'web' });
    expect(r.err).toBeNull();
    // toEqual on the WHOLE context: no deviceId, no pairingId — a web session
    // has neither, and a phantom device id would leak into every 「which
    // device did this」 read downstream.
    expect(r.data.auth).toEqual({ userId: 'u-web', kind: 'web' });
    // The account context still rides along, as for any verified-jwt socket.
    expect(r.data.account).toMatchObject({ userId: 'u-web', plan: 'free' });
  });

  it('the marker with an INVALID jwt earns nothing: auth stays null, the failure is recorded', () => {
    const r = run({ jwt: 'not-a-jwt', client: 'web' });
    expect(r.err).toBeNull(); // handshake never rejects (04 §2)
    expect(r.data.auth).toBeNull();
    expect(r.data.account).toBeNull();
    expect(r.data.accountAuthError).toBe('AUTH_TOKEN_INVALID');
  });

  it('the marker with an EXPIRED jwt likewise: null auth, AUTH_TOKEN_EXPIRED recorded', () => {
    const expired = signJwt({ sub: 'u-web', plan: 'free' }, { secret: SECRET_BUF, ttlMs: -1000, now: () => NOW });
    const r = run({ jwt: expired, client: 'web' });
    expect(r.data.auth).toBeNull();
    expect(r.data.accountAuthError).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('the marker with NO jwt at all earns nothing', () => {
    const r = run({ client: 'web' });
    expect(r.data.auth).toBeNull();
    expect(r.data.account).toBeUndefined();
  });

  it('an UNKNOWN marker value is not web (closed vocabulary, not a truthiness test)', () => {
    const r = run({ jwt: goodJwt(), client: 'browser' });
    expect(r.data.auth).toBeNull();
  });

  it('standalone (no jwt handshake config): the marker changes nothing — auth null, account never resolved', () => {
    const r = run({ jwt: goodJwt(), client: 'web' }, { saas: false });
    expect(r.data.auth).toBeNull();
    expect(r.data.account).toBeUndefined();
  });
});

describe('🔴 regression pins: every pre-GRANT-1 path is byte-identical', () => {
  it('pc token → the exact pre-GRANT-1 context', () => {
    const r = run({ token: PC_TOKEN });
    expect(r.err).toBeNull();
    expect(r.data.auth).toEqual({ userId: 'u-pc', deviceId: 'pc-1', kind: 'pc' });
  });

  it('mobile token → the exact pre-GRANT-1 context', () => {
    const r = run({ token: MOB_TOKEN });
    expect(r.err).toBeNull();
    expect(r.data.auth).toEqual({ userId: 'u-mob', pairingId: 'pair-1', deviceId: 'pc-1', kind: 'mobile' });
  });

  it('jwt-only WITHOUT the marker (the cloud phone handshake) → auth null, account set — exactly as before', () => {
    const r = run({ jwt: goodJwt('u-phone') });
    expect(r.err).toBeNull();
    expect(r.data.auth).toBeNull(); // NOT 'web' — the tree-contradiction pin
    expect(r.data.account).toMatchObject({ userId: 'u-phone' });
  });

  it('a device token WINS over the marker: the token path is untouched, the declaration is ignored', () => {
    const withMarker = run({ token: MOB_TOKEN, jwt: goodJwt(), client: 'web' });
    const withoutMarker = run({ token: MOB_TOKEN, jwt: goodJwt() });
    // Byte-identical outcomes: same auth, same account, same negotiation.
    expect(withMarker.data).toEqual(withoutMarker.data);
    expect(withMarker.data.auth).toEqual({ userId: 'u-mob', pairingId: 'pair-1', deviceId: 'pc-1', kind: 'mobile' });
  });

  it('an unknown token still refuses the handshake, marker or not', () => {
    expect(run({ token: UNKNOWN_TOKEN }).err).toBe('AUTH_TOKEN_INVALID');
    expect(run({ token: UNKNOWN_TOKEN, client: 'web' }).err).toBe('AUTH_TOKEN_INVALID');
  });
});
