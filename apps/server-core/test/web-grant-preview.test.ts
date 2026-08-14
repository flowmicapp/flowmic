// Card GRANT-1 — the web-preview grant handshake, end-to-end over a REAL
// in-process saas server + socket.io-client (the same harness shape as
// saas-cloud-admission.test.ts): a declared web socket requests, a
// cloud-admitted phone grants, the server stores the AUTHORIZATION row and
// blindly forwards the wrap, and every gate (allowlist / rate limit / pending
// TTL / grant expiry / revocation / IDOR) is exercised through the wire.
// Design: docs/strategy/2026-08-11-design-e-grant-web-preview.md §2/§3.
//
// The server runs on an injected fake clock (overrides.now) so the 90 s
// pending TTL, the rolling-minute rate budget and the grant expiry are all
// DRIVEN, never slept for.
//
// 🔴 REVERSE CONTROL #1 (run red once, then reverted, 2026-08-10): the
// allowlist was deliberately loosened — 'history:create' appended to
// WEB_ALLOWED_EVENTS in socket/web-allowlist.ts, drill-marked. Red output
// verbatim (the vitest `❯ file:line` pointer lines elided per the
// coordinate-anchors discipline; failing assertions named by symbol):
//
//    ❯ test/web-grant-preview.test.ts (19 tests | 1 failed) 1272ms
//      × allowlist: default-deny for web sockets > frame-level probe:
//        history:create from web is refused AND never reaches its handler 42ms
//    FAIL  test/web-grant-preview.test.ts > allowlist: default-deny for web
//      sockets > frame-level probe: history:create from web is refused AND
//      never reaches its handler
//    AssertionError: expected 'HISTORY_SYNC_RETIRED' to be
//      'WEB_EVENT_NOT_ALLOWED' // Object.is equality
//    Expected: "WEB_EVENT_NOT_ALLOWED"
//    Received: "HISTORY_SYNC_RETIRED"
//    Tests  1 failed | 18 passed (19)
//
// (the `expect(refused.error).toBe('WEB_EVENT_NOT_ALLOWED')` assertion below
// — the handler HEARD the frame, which is exactly the loosening this test
// exists to catch.) Loosening removed, suite green again, residue grep for
// the drill marker = 0.
//
// 🔴 REVERSE CONTROL #2 (run red once, then reverted, 2026-08-10):
// liveGrantFor in db/repos/timeline-grants.repo.ts was deliberately blinded
// to expiry (the `AND expires_at>?` predicate dropped from liveStmt's SQL and
// the nowMs binding dropped from the call, drill-marked). BOTH altitudes bit
// — the e2e wire test AND the handler-level unit test. Red output verbatim
// (same elision):
//
//    FAIL  test/web-grant-preview.test.ts > grant expiry and revocation >
//      pull after expires_at → TIMELINE_GRANT_REQUIRED (expiry needs no sweeper)
//    AssertionError: expected undefined to be 'TIMELINE_GRANT_REQUIRED'
//      // Object.is equality
//    FAIL  test/web-readonly-gate.test.ts > timeline handler: kind-web is
//      READ-ONLY (the second gate, allowlist bypassed) > web pull: refused
//      with no grant, admitted under a live one, refused again past its expiry
//    AssertionError: expected undefined to be 'TIMELINE_GRANT_REQUIRED'
//      // Object.is equality
//    Tests  2 failed | 22 passed (24)
//
// (`expected undefined` IS the defect's face: the pull succeeded — no error
// key at all — i.e. a grant that never dies.) Predicate and binding restored,
// suite green again, residue grep = 0.
//
// *** HUMAN-AUDIT SENSITIVE (auth / admission) ***

import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { TIMELINE_E2E_PREFIX } from '@flowmic/protocol';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { GRANT_PENDING_TTL_MS } from '../src/socket/handlers/grant.handler';
import { TIMELINE_GRANTS_PATH, GRANT_NOT_FOUND } from '../src/http/timeline-grants-routes';

const SECRET = 'web-grant-preview-secret-32-bytes-xx';
const WRAP = `${TIMELINE_E2E_PREFIX}wrap-Zq7xK9mR2vT4-exact-bytes-under-test`;
const ORIGIN = 'https://app.flowmic.app';

// Injected server clock — advanced by tests, never slept on.
let NOW = 1_754_900_000_000;
const clock = (): number => NOW;

let server: BootstrapHandle | null = null;
const sockets: ClientSocket[] = [];

afterEach(async () => {
  NOW = 1_754_900_000_000;
  for (const s of sockets.splice(0)) s.disconnect();
  if (server) await server.close();
  server = null;
});

async function saas(): Promise<string> {
  // fix-010: an in-process server has no proxy in front of it — its direct peer
  // IS the client (config.ts §trustedProxies).
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
  server = await startServer(config, { now: clock });
  return `http://127.0.0.1:${server.port}`;
}

function connect(url: string, auth: Record<string, unknown> = {}): Promise<ClientSocket> {
  const socket = ioClient(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
}
function ack<T = any>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), 3000);
    socket.emit(event, payload, (r: T) => { clearTimeout(t); resolve(r); });
  });
}
function once(socket: ClientSocket, event: string, ms = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timeout`)), ms);
    socket.once(event, (d: unknown) => { clearTimeout(t); resolve(d); });
  });
}
/** Resolves true iff `event` did NOT arrive within `ms` — the negative half of
 *  a frame-level probe (its positive control lives beside each use). */
function never(socket: ClientSocket, event: string, ms = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { socket.off(event, hit); resolve(true); }, ms);
    const hit = (): void => { clearTimeout(t); resolve(false); };
    socket.once(event, hit);
  });
}
async function registerUser(url: string, email: string): Promise<{ id: string; token: string }> {
  const res = await fetch(`${url}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'longenough1' }),
  });
  const json = await res.json() as { token: string; user: { id: string } };
  // VERIFY-1 — the grant handshake is this suite's subject, and since VERIFY-1
  // every web-session surface sits BEHIND the verification gate; accounts are
  // verified through the same repo the confirm route writes. The unverified
  // web session's refusals (grant-request, pull, grants REST) are proven in
  // test/email-verification.test.ts.
  server!.db.emailVerification.markVerified(json.user.id, clock());
  return { id: json.user.id, token: json.token };
}
/** A DECLARED web socket: valid account jwt + the `client:'web'` marker. */
function connectWeb(url: string, token: string): Promise<ClientSocket> {
  return connect(url, { jwt: token, client: 'web' });
}
/** A cloud-admitted PHONE socket (kind:'mobile'): jwt-only handshake — NO
 *  marker, the production phone shape — then mobile:pair {cloud_instance}. */
async function connectPhone(url: string, token: string): Promise<ClientSocket> {
  const c = await connect(url, { jwt: token });
  const pair = await ack(c, 'mobile:pair', { cloud_instance: true });
  expect(pair.pairing_id, JSON.stringify(pair)).toBeDefined();
  return c;
}
function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
async function rest(method: string, url: string, token: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method, headers: bearer(token) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
let gidSeq = 0;
function freshGid(): string {
  gidSeq += 1;
  return `gid-${gidSeq}-${NOW}`;
}
function requestPayload(gid: string): Record<string, unknown> {
  return { web_pubkey: 'epk-x25519-b64', session_fingerprint: 'fp-6-words', gid, origin: ORIGIN };
}

describe('grant-request (web side)', () => {
  it('happy path: a declared web socket pends a request and gets the QR window back', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'req@g.co');
    const web = await connectWeb(url, token);
    const gid = freshGid();
    const r = await ack(web, 'timeline:grant-request', requestPayload(gid));
    expect(r).toEqual({ ok: true, gid, expires_in_ms: GRANT_PENDING_TTL_MS });
  });

  it('missing gid/origin = malformed AT THE HANDLER (zod stays additive)', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'malformed@g.co');
    const web = await connectWeb(url, token);
    const r = await ack(web, 'timeline:grant-request', { web_pubkey: 'pk', session_fingerprint: 'fp' });
    expect(r.error).toBe('TIMELINE_BLOB_REJECTED');
  });

  it('rate limit: the 6th request in a rolling minute → TIMELINE_RATE_LIMITED, and the window really slides', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'limit@g.co');
    const web = await connectWeb(url, token);
    for (let i = 0; i < 5; i++) {
      const r = await ack(web, 'timeline:grant-request', requestPayload(freshGid()));
      expect(r.ok, `request ${i + 1} should be admitted`).toBe(true);
    }
    const sixth = await ack(web, 'timeline:grant-request', requestPayload(freshGid()));
    expect(sixth.error).toBe('TIMELINE_RATE_LIMITED');
    // 61 s later the oldest hits have left the window — the budget returns.
    NOW += 61_000;
    const after = await ack(web, 'timeline:grant-request', requestPayload(freshGid()));
    expect(after.ok).toBe(true);
  });

  it('wrong-kind emitter: a PHONE emitting grant-request is refused by name', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'phone-req@g.co');
    const phone = await connectPhone(url, token);
    const r = await ack(phone, 'timeline:grant-request', requestPayload(freshGid()));
    expect(r.error).toBe('TIMELINE_BLOB_REJECTED'); // imperfect-fit reuse, argued in grant.handler.ts's header
  });
});

describe('grant (phone side) — the full handshake', () => {
  it('end-to-end: web requests → phone grants → web receives the EXACT wrap bytes → row exists → web pull works', async () => {
    const url = await saas();
    const { id, token } = await registerUser(url, 'e2e@g.co');
    const web = await connectWeb(url, token);
    const phone = await connectPhone(url, token);

    // The phone pushes one blob first, so the eventual web pull returns REAL
    // stored ciphertext rather than an empty page.
    const pushed = await ack(phone, 'timeline:push', {
      entries: [{ id: 'blob-1', seq: 0, ciphertext: `${TIMELINE_E2E_PREFIX}entry-1`, created_at: NOW, schema_ver: 1 }],
    });
    expect(pushed.ok).toBe(true);

    const gid = freshGid();
    const req = await ack(web, 'timeline:grant-request', requestPayload(gid));
    expect(req.ok).toBe(true);

    const expiresAt = NOW + 3_600_000; // the phone chose 1 h (the default preset)
    const wrapArrives = once(web, 'timeline:grant');
    const granted = await ack(phone, 'timeline:grant', { wrap: WRAP, gid, expires_at_ms: expiresAt });
    expect(granted).toEqual({ ok: true, gid, expires_at_ms: expiresAt });

    // The web socket got the wrap VERBATIM — byte-for-byte, plus the two
    // additive fields, and nothing else.
    expect(await wrapArrives).toEqual({ wrap: WRAP, gid, expires_at_ms: expiresAt });

    // The durable AUTHORIZATION row exists with the chosen expiry — and the
    // repo's row shape has no field that could carry the wrap.
    const rows = server!.db.timelineGrants.listFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gid, origin: ORIGIN, expires_at: expiresAt, revoked: false });

    // …and the gate opens: the web pull returns the stored ciphertext.
    const pull = await ack(web, 'timeline:pull', {});
    expect(pull.error).toBeUndefined();
    expect(pull.blobs.map((b: { ciphertext: string }) => b.ciphertext)).toEqual([`${TIMELINE_E2E_PREFIX}entry-1`]);

    // The wrap was never persisted anywhere: not in the grants table (no
    // column), and not in any other table — asserted on the whole database's
    // bytes, not on field names.
    const tables = (server!.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    for (const t of tables) {
      const rowsAll = server!.db.raw.prepare(`SELECT * FROM ${t}`).all();
      expect(JSON.stringify(rowsAll), `wrap bytes found persisted in table ${t}`).not.toContain('wrap-Zq7xK9mR2vT4');
    }
  });

  it('web pull WITHOUT any grant → TIMELINE_GRANT_REQUIRED (fail-closed from the first frame)', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'nogrant@g.co');
    const web = await connectWeb(url, token);
    const r = await ack(web, 'timeline:pull', {});
    expect(r.error).toBe('TIMELINE_GRANT_REQUIRED');
  });

  it('pending expires at 90 s: a grant against a stale QR → TIMELINE_GRANT_REQUIRED, no row', async () => {
    const url = await saas();
    const { id, token } = await registerUser(url, 'stale@g.co');
    const web = await connectWeb(url, token);
    const phone = await connectPhone(url, token);
    const gid = freshGid();
    await ack(web, 'timeline:grant-request', requestPayload(gid));
    NOW += GRANT_PENDING_TTL_MS + 1;
    const r = await ack(phone, 'timeline:grant', { wrap: WRAP, gid, expires_at_ms: NOW + 3_600_000 });
    expect(r.error).toBe('TIMELINE_GRANT_REQUIRED');
    expect(server!.db.timelineGrants.listFor(id)).toHaveLength(0);
  });

  it('gid/user mismatch: another account\'s phone cannot answer my pending — and no row lands anywhere', async () => {
    const url = await saas();
    const a = await registerUser(url, 'victim@g.co');
    const b = await registerUser(url, 'attacker@g.co');
    const webA = await connectWeb(url, a.token);
    const phoneB = await connectPhone(url, b.token);
    const gid = freshGid();
    await ack(webA, 'timeline:grant-request', requestPayload(gid));
    const r = await ack(phoneB, 'timeline:grant', { wrap: WRAP, gid, expires_at_ms: NOW + 3_600_000 });
    expect(r.error).toBe('TIMELINE_GRANT_REQUIRED');
    expect(server!.db.timelineGrants.listFor(a.id)).toHaveLength(0);
    expect(server!.db.timelineGrants.listFor(b.id)).toHaveLength(0);
  });

  it('expires_at_ms sanity: past, and beyond 7 days, are both refused as malformed', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'sanity@g.co');
    const web = await connectWeb(url, token);
    const phone = await connectPhone(url, token);
    const gid = freshGid();
    await ack(web, 'timeline:grant-request', requestPayload(gid));
    const past = await ack(phone, 'timeline:grant', { wrap: WRAP, gid, expires_at_ms: NOW - 1 });
    expect(past.error).toBe('TIMELINE_BLOB_REJECTED');
    const tooFar = await ack(phone, 'timeline:grant', { wrap: WRAP, gid, expires_at_ms: NOW + 8 * 24 * 3_600_000 });
    expect(tooFar.error).toBe('TIMELINE_BLOB_REJECTED');
    // The sanity refusals were checked BEFORE the pending was consumed, so a
    // corrected retry still lands.
    const ok = await ack(phone, 'timeline:grant', { wrap: WRAP, gid, expires_at_ms: NOW + 3_600_000 });
    expect(ok.ok).toBe(true);
  });
});

describe('allowlist: default-deny for web sockets', () => {
  it('frame-level probe: history:create from web is refused AND never reaches its handler', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'probe@g.co');
    const web = await connectWeb(url, token);
    // history:create's handler answers HISTORY_SYNC_RETIRED to EVERY frame it
    // hears, unconditionally (history.handler.ts) — so the ack VALUE is a
    // frame-level discriminator: WEB_EVENT_NOT_ALLOWED can only come from the
    // allowlist, HISTORY_SYNC_RETIRED can only come from the handler.
    const refused = await ack(web, 'history:create', { item: {} });
    expect(refused.error).toBe('WEB_EVENT_NOT_ALLOWED');
    expect(refused.error).not.toBe('HISTORY_SYNC_RETIRED');
    // POSITIVE CONTROL: the same frame from a plain (non-web) socket reaches
    // the handler and gets its unconditional answer — so the negative above
    // cannot be a dead probe.
    const plain = await connect(url);
    const heard = await ack(plain, 'history:create', { item: {} });
    expect(heard.error).toBe('HISTORY_SYNC_RETIRED');
  });

  it('frame-level probe: inject:request from web is refused and NO inject:result is ever emitted', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'inject-probe@g.co');
    const web = await connectWeb(url, token);
    const noResult = never(web, 'inject:result');
    const refused = await ack(web, 'inject:request', { text: 'hi', source: 'stt' });
    expect(refused.error).toBe('WEB_EVENT_NOT_ALLOWED');
    expect(await noResult, 'inject:result reached the web socket — the relay handler heard the frame').toBe(true);
    // POSITIVE CONTROL: a plain socket's inject:request DOES reach the relay
    // handler, whose no-room refusal arrives as an emitted inject:result.
    const plain = await connect(url);
    const result = once(plain, 'inject:result');
    plain.emit('inject:request', { text: 'hi', source: 'stt' });
    expect((await result as { error: string }).error).toBe('INJECT_NOT_IN_ROOM');
  });

  it('gate ORDER: web push/tombstone hit the allowlist first (WEB_EVENT_NOT_ALLOWED, not the read-only code)', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'order@g.co');
    const web = await connectWeb(url, token);
    const push = await ack(web, 'timeline:push', { entries: [] });
    expect(push.error).toBe('WEB_EVENT_NOT_ALLOWED'); // TIMELINE_WEB_READ_ONLY is the INNER gate — test/web-readonly-gate.test.ts
    const tomb = await ack(web, 'timeline:tombstone', { ids: ['x'] });
    expect(tomb.error).toBe('WEB_EVENT_NOT_ALLOWED');
    const grant = await ack(web, 'timeline:grant', { wrap: WRAP, gid: 'g', expires_at_ms: NOW + 1000 });
    expect(grant.error).toBe('WEB_EVENT_NOT_ALLOWED'); // web may REQUEST, never GRANT
  });

  it('the two allowed verbs really are allowed (the deny is not a blanket)', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'allowed@g.co');
    const web = await connectWeb(url, token);
    const req = await ack(web, 'timeline:grant-request', requestPayload(freshGid()));
    expect(req.ok).toBe(true); // passed the allowlist AND the handler
    const pull = await ack(web, 'timeline:pull', {});
    expect(pull.error).toBe('TIMELINE_GRANT_REQUIRED'); // passed the allowlist, refused by the GRANT gate — not by the allowlist
  });
});

describe('grant expiry and revocation', () => {
  async function grantedWorld(): Promise<{ url: string; id: string; token: string; web: ClientSocket; gid: string; expiresAt: number }> {
    const url = await saas();
    const { id, token } = await registerUser(url, 'expiry@g.co');
    const web = await connectWeb(url, token);
    const phone = await connectPhone(url, token);
    const gid = freshGid();
    await ack(web, 'timeline:grant-request', requestPayload(gid));
    const expiresAt = NOW + 3_600_000;
    const g = await ack(phone, 'timeline:grant', { wrap: WRAP, gid, expires_at_ms: expiresAt });
    expect(g.ok).toBe(true);
    return { url, id, token, web, gid, expiresAt };
  }

  it('pull after expires_at → TIMELINE_GRANT_REQUIRED (expiry needs no sweeper)', async () => {
    const w = await grantedWorld();
    expect((await ack(w.web, 'timeline:pull', {})).error).toBeUndefined();
    NOW = w.expiresAt + 1;
    const expired = await ack(w.web, 'timeline:pull', {});
    expect(expired.error).toBe('TIMELINE_GRANT_REQUIRED');
  });

  it('REST revoke → the NEXT pull is refused; a repeat DELETE is idempotent', async () => {
    const w = await grantedWorld();
    expect((await ack(w.web, 'timeline:pull', {})).error).toBeUndefined();
    const del = await rest('DELETE', `${w.url}${TIMELINE_GRANTS_PATH}/${w.gid}`, w.token);
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true, gid: w.gid, revoked: true });
    const refused = await ack(w.web, 'timeline:pull', {});
    expect(refused.error).toBe('TIMELINE_GRANT_REQUIRED');
    const again = await rest('DELETE', `${w.url}${TIMELINE_GRANTS_PATH}/${w.gid}`, w.token);
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ok: true, gid: w.gid, revoked: true, already_revoked: true });
  });

  it('a NEW grant supersedes the old one: the old row is marked revoked in place', async () => {
    const w = await grantedWorld();
    const phone = await connectPhone(w.url, w.token);
    const gid2 = freshGid();
    await ack(w.web, 'timeline:grant-request', requestPayload(gid2));
    const g2 = await ack(phone, 'timeline:grant', { wrap: WRAP, gid: gid2, expires_at_ms: NOW + 7_200_000 });
    expect(g2.ok).toBe(true);
    const rows = server!.db.timelineGrants.listFor(w.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.gid === w.gid)?.revoked).toBe(true); // superseded
    expect(rows.find((r) => r.gid === gid2)?.revoked).toBe(false);
  });
});

describe('REST: list and revoke are IDOR-scoped by the Bearer subject', () => {
  it('list shows OWN rows only; a foreign DELETE 404s and the row is untouched', async () => {
    const url = await saas();
    const a = await registerUser(url, 'owner@g.co');
    const b = await registerUser(url, 'stranger@g.co');
    const webA = await connectWeb(url, a.token);
    const phoneA = await connectPhone(url, a.token);
    const gid = freshGid();
    await ack(webA, 'timeline:grant-request', requestPayload(gid));
    const expiresAt = NOW + 3_600_000;
    await ack(phoneA, 'timeline:grant', { wrap: WRAP, gid, expires_at_ms: expiresAt });

    // A sees the row, with the public projection and nothing else.
    const mine = await rest('GET', `${url}${TIMELINE_GRANTS_PATH}`, a.token);
    expect(mine.status).toBe(200);
    expect(mine.json.grants).toHaveLength(1);
    expect(Object.keys(mine.json.grants[0]).sort()).toEqual(['created_at', 'expires_at', 'gid', 'origin', 'revoked']);
    expect(mine.json.grants[0]).toMatchObject({ gid, origin: ORIGIN, expires_at: expiresAt, revoked: false });

    // B sees nothing — not an error, an empty list (B truly has no grants).
    const theirs = await rest('GET', `${url}${TIMELINE_GRANTS_PATH}`, b.token);
    expect(theirs.status).toBe(200);
    expect(theirs.json.grants).toEqual([]);

    // B cannot revoke A's gid: 404 (indistinguishable from nonexistent), and
    // A's row is untouched — A's web still pulls.
    const foreign = await rest('DELETE', `${url}${TIMELINE_GRANTS_PATH}/${gid}`, b.token);
    expect(foreign.status).toBe(404);
    expect(foreign.json.error).toBe(GRANT_NOT_FOUND);
    expect(server!.db.timelineGrants.listFor(a.id)[0]?.revoked).toBe(false);
    expect((await ack(webA, 'timeline:pull', {})).error).toBeUndefined();

    // Anonymous → the account surface's named 401.
    const anon = await fetch(`${url}${TIMELINE_GRANTS_PATH}`);
    expect(anon.status).toBe(401);
  });
});

describe('identity: the pc/mobile paths are untouched (regression pins over the wire)', () => {
  it('a jwt-only handshake WITHOUT the web marker is NOT a web socket: cloud admission still works', async () => {
    // THE tree-contradiction pin: the design sketch said 「jwt-only ⇒ web」, and
    // this exact flow is why the middleware requires the DECLARED marker
    // instead (auth/middleware.ts, the declared-web branch's comment).
    const url = await saas();
    const { token } = await registerUser(url, 'cloudphone@g.co');
    const phone = await connect(url, { jwt: token }); // no marker — production phone bytes
    const pair = await ack(phone, 'mobile:pair', { cloud_instance: true });
    expect(pair.pc_instance_id).toBe('flowmic-cloud-instance');
    expect(pair.role).toBe('active');
  });

  it('a phone pushes and pulls with NO grant anywhere — the grant gate is web-only', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'phonepull@g.co');
    const phone = await connectPhone(url, token);
    const push = await ack(phone, 'timeline:push', {
      entries: [{ id: 'p1', seq: 0, ciphertext: `${TIMELINE_E2E_PREFIX}phone-own`, created_at: NOW, schema_ver: 1 }],
    });
    expect(push.ok).toBe(true);
    const pull = await ack(phone, 'timeline:pull', {});
    expect(pull.error).toBeUndefined();
    expect(pull.blobs).toHaveLength(1);
  });
});
