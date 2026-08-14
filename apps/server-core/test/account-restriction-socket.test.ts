// A2-3 F1 — "restrict use" on the PHONE: the two ADMISSIONS (mobile:pair /
// mobile:reconnect) that decide whether a phone gets to start or resume using a
// PC at all.
//
// SPEC-REF: docs/strategy/2026-08-12-a2-3-restricted-use-design.md §5 (the three
//             effect-moments; row ③ is the hole this file measures) and §9 #4/#5
//           docs/decisions/owner-web-rulings/latest.md:71 (owner, verbatim)
//           src/auth/account-restriction.ts (the ONE conversion site)
//           src/socket/handlers/mobile.handler.ts `refuseRestricted`
//           *** HUMAN-AUDIT SENSITIVE (auth/pairing) ***
//
// 🔴 WHY THIS FILE EXISTS AT ALL. The restriction shipped HTTP-side first, and
// the design predicted the exact way it would look finished and not be: "①②
// all green, the ops UI shows 'restricted', and that phone still works as usual" (§5-2). The pairing path never
// read `users`, so a restricted account's already-paired phone kept injecting
// into its PC with no upper bound. §9 #4 names the single assertion that can
// prove the new DB read was really added — "`mobile:reconnect` was blocked" — and it
// is the first test below.
//
// 🔴 AND THE ONE THAT KEEPS THE CURE FROM BEING WORSE (§9 #5): a restriction is
// REVERSIBLE. If the refusal used `AUTH_TOKEN_INVALID` — the code this handler
// already emits for a pairing that is genuinely gone — the phone would DELETE
// the pairing (`mobile_reconnect_flow.dart`: `if (invalid) await
// tokenStorage.removeByToken(token)`), leaving damage no operator can undo. So
// every refusal here is asserted for what it IS and for what it is NOT.
//
// Layers, on purpose:
//   · the handler suite drives the REAL handler over a real sqlite db + real
//     Registry + real RoomStore, fakes only at the socket seam (the
//     release-mobile.test.ts harness) — precise about WHAT the gate answers;
//   · the last suite drives the REAL bootstrap over a real socket.io port —
//     evidence about WIRING, because a gate bootstrap forgot to hand a reader to
//     would pass every test above and refuse nobody in production.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { Server, Socket } from 'socket.io';
import { registerMobileHandlers } from '../src/socket/handlers/mobile.handler';
import { CLOUD_INSTANCE_ID, Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { PairRateLimiter } from '../src/room/pair-rate-limit';
import { ReleaseSuppression } from '../src/room/release-suppression';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { planLimits } from '../src/billing/plans';
import { ACCOUNT_RESTRICTED } from '../src/auth/account-restriction';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

const PC_INSTANCE = 'desktop-instance-aaaa';
const USER = 'u-restricted-phone';

class FakeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  connected = true;
  disconnected = 0;
  readonly handshake = { address: '10.0.0.9' };
  private readonly handlers = new Map<string, ((payload: unknown, ack: unknown) => void)[]>();

  constructor(
    readonly id: string,
    public data: { auth: AuthContext | null; roomUuid?: string; account?: { userId: string } } = { auth: null },
  ) {}

  on(event: string, fn: (payload: unknown, ack: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  off(): this { return this; }
  emit(event: string, payload: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  disconnect(_close?: boolean): this {
    this.disconnected += 1;
    this.connected = false;
    return this;
  }
  invoke(event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const list = this.handlers.get(event) ?? [];
      if (list.length === 0) return resolve({ __no_handler: true });
      for (const fn of list) fn(payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
    });
  }
}

let db: Db;
let registry: Registry;
let store: RoomStore<Socket>;
let suppression: ReleaseSuppression;
let clock = 1_700_000_000_000;

/** The mobile handler with production's own dependency set. `restriction` is the
 *  REAL repo behind the `RestrictionReader` shape — the same one `AuthService`
 *  satisfies structurally in bootstrap, so the gate under test does a real row
 *  read and not a stub's opinion. */
function wireMobile(socket: FakeSocket, mode: 'standalone' | 'saas' = 'standalone', actingUserId = USER): FakeSocket {
  registerMobileHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry,
    store,
    pairLimiter: new PairRateLimiter({}),
    mode,
    resolveActingUser: () => ({ userId: actingUserId }),
    suppression,
    restriction: { getUser: (id) => db.users.findById(id) },
  });
  return socket;
}

function newRegistry(mode: 'standalone' | 'saas'): Registry {
  return new Registry({
    pcs: db.pcs,
    mobiles: db.mobiles,
    mode,
    now: () => clock,
    limitsOf: () => planLimits('pro'),
  });
}

/** A registered PC owned by [USER], plus one paired phone holding a real token. */
function pcWithPhone(): { pcId: string; roomUuid: string; shortCode: string; pairingId: string; token: string } {
  const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: USER, client_instance_id: PC_INSTANCE });
  // 0.2.66 — saas fixture, so the pairing names its PC (owner 2026-08-14; a bare
  // code is refused with PAIR_PCID_REQUIRED). This file is about the RESTRICTION
  // gate; pairing is only how it gets a phone with a real token.
  const paired = registry.pairMobile({
    short_code: pc.short_code,
    pcid: pc.pcid ?? undefined,
    mobile_name: 'Pixel-ab12',
  });
  return {
    pcId: pc.id,
    roomUuid: pc.room_uuid,
    shortCode: pc.short_code,
    pairingId: paired.mobile.id,
    token: paired.token,
  };
}

function restrict(userId = USER): void {
  db.users.setRestricted(userId, clock, 'terms_violation');
}
function release(userId = USER): void {
  db.users.setRestricted(userId, null, null);
}

beforeEach(() => {
  clock = 1_700_000_000_000;
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: USER, display_name: 'R', plan: 'pro' });
  registry = newRegistry('standalone');
  store = new RoomStore<Socket>();
  suppression = new ReleaseSuppression(() => clock);
});
afterEach(() => db.close());

// ── §9 #4 · the assertion that proves the DB read was really added ──────────
describe('A2-3 F1 · mobile:reconnect is refused for a restricted account', () => {
  it('🔴 criterion #4 — refused BY NAME, and never with the code that wipes the pairing', async () => {
    const fx = pcWithPhone();

    // POSITIVE CONTROL FIRST. Without it a green below could mean "the gate
    // works" or "this fixture cannot reconnect at all", and those are opposite
    // facts. This one also measures the pre-card behaviour: unrestricted, the
    // same token is admitted.
    const before = await wireMobile(new FakeSocket('m-ok')).invoke('mobile:reconnect', { token: fx.token });
    expect(before.error, 'control: an unrestricted account must be admitted').toBeUndefined();
    expect(before.pairing_id).toBe(fx.pairingId);

    restrict();
    const ack = await wireMobile(new FakeSocket('m-restricted')).invoke('mobile:reconnect', { token: fx.token });

    expect(ack.error, '§9 #4 — the phone must be refused, by name').toBe(ACCOUNT_RESTRICTED);
    expect(ack.pairing_id, 'a refusal must not also hand over a session').toBeUndefined();

    // 🔴 What it must NOT be. `AUTH_TOKEN_INVALID` makes the phone delete the
    // pairing (mobile_reconnect_flow.dart) — a reversible state leaving
    // irreversible damage. Asserted explicitly because 「some error came back」
    // is exactly the assertion that would have let that through.
    expect(ack.error).not.toBe('AUTH_TOKEN_INVALID');

    // 🔴 NO BUDGET, and this is behaviour rather than tidiness: the phone's
    // hold-out timer arms on 「did the server hand over a budget」 and nothing
    // else (ptt_reconnect_ack.dart `_noteHoldOut` → HoldOutRetry.note; an
    // answered code WITHOUT one is documented there as 「not one dial」). Only an
    // operator can lift a restriction, so any number here would be invented AND
    // would buy an unbounded re-ask against a fact that cannot change.
    expect(Object.prototype.hasOwnProperty.call(ack, 'retry_after_ms'), 'no fabricated window').toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ack, 'retryable'), 'no field this ack has no reader for').toBe(false);
    // Q2 (owner 2026-08-12) — the ack now carries the ENUMERATED reason beside
    // the code, and this exact-shape assertion is where that is pinned: it is
    // still an EXACT match, so a future field arriving on this ack (a budget, a
    // `retryable`, an operator's note) fails here rather than reaching a phone.
    // 🔴 'terms_violation' is what `restrict()` wrote — a real round trip
    // through `users.restriction_reason`, not a constant echoed back.
    expect(ack).toEqual({ error: ACCOUNT_RESTRICTED, reason: 'terms_violation' });

    // The row and its token are untouched — nothing was revoked, expired or
    // rotated on the way out.
    const row = db.mobiles.findById(fx.pairingId);
    expect(row?.mobile_token).toBe(fx.token);
  });

  it('the refused phone never enters the room, so the PC is told nothing', async () => {
    // Same position as the GA-08 hold-out refusal: refused BEFORE joinAndNotify.
    // A phone that is present-but-refused would raise pc:mobile-joined, take the
    // capsule slot and displace a legitimate socket — a refusal that costs the
    // user their session is not a refusal.
    const fx = pcWithPhone();
    const pcSocket = new FakeSocket('pc-1');
    store.joinPc(fx.roomUuid, pcSocket as unknown as Socket);
    restrict();

    const ack = await wireMobile(new FakeSocket('m-restricted')).invoke('mobile:reconnect', { token: fx.token });
    expect(ack.error).toBe(ACCOUNT_RESTRICTED);
    expect(pcSocket.emitted.filter((e) => e.event === 'pc:mobile-joined')).toEqual([]);
  });

  it('🔴 outranks the hold-out window — a released AND restricted phone hears the restriction', async () => {
    // Both are true and only one can be the answer. PAIR_RELEASED / PC_BUSY say
    // "come back in N ms", which for a restricted account promises a recovery
    // that will not arrive AND (being the two codes that carry a budget) arms
    // the phone's timer to go be refused again. Same ordering argument
    // console-routes.ts makes for restriction-before-verification.
    const fx = pcWithPhone();
    // 'manual' is GA-08's disconnect window — the one that answers PAIR_RELEASED
    // (`reasonFor(...) === 'busy'` picks PC_BUSY instead).
    suppression.suppress(fx.pairingId, 'manual');
    restrict();

    const ack = await wireMobile(new FakeSocket('m-both')).invoke('mobile:reconnect', { token: fx.token });
    expect(ack).toEqual({ error: ACCOUNT_RESTRICTED, reason: 'terms_violation' });

    // Reverse direction: the hold-out is still exactly itself for an account
    // nobody restricted, so this ordering removed no behaviour.
    release();
    const held = await wireMobile(new FakeSocket('m-held')).invoke('mobile:reconnect', { token: fx.token });
    expect(held.error).toBe('PAIR_RELEASED');
    expect(held.retry_after_ms).toBeGreaterThan(0);
  });
});

// ── §9 #5 · the restriction is reversible, and nothing was destroyed ────────
describe('A2-3 F1 · lifting the restriction leaves the pairing intact', () => {
  it('🔴 criterion #5 — the SAME token is admitted again, on the SAME row, with no re-pairing', async () => {
    const fx = pcWithPhone();
    restrict();
    expect((await wireMobile(new FakeSocket('m-1')).invoke('mobile:reconnect', { token: fx.token })).error)
      .toBe(ACCOUNT_RESTRICTED);

    release();
    const ack = await wireMobile(new FakeSocket('m-2')).invoke('mobile:reconnect', { token: fx.token });

    expect(ack.error, 'a lifted restriction must take effect on the very next attempt').toBeUndefined();
    expect(ack.pairing_id).toBe(fx.pairingId);
    expect(ack.pc_id).toBe(fx.pcId);
    // The row is the one that existed before the restriction — same id, same
    // token. This is the assertion that would fail if the refusal had been
    // AUTH_TOKEN_INVALID and the phone had dropped its token: there would be no
    // token left to reconnect with at all.
    expect(db.mobiles.findById(fx.pairingId)?.mobile_token).toBe(fx.token);
    expect(db.mobiles.listByPc(fx.pcId)).toHaveLength(1);
  });
});

// ── the other admission: nothing may be MINTED for a restricted account ─────
describe('A2-3 F1 · mobile:pair is refused for a restricted account', () => {
  it('🔴 short_code and qr_payload both refuse, and NO pairing row is written', async () => {
    const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: USER, client_instance_id: PC_INSTANCE });
    restrict();

    for (const payload of [
      { short_code: pc.short_code, mobile_name: 'Pixel-ab12' },
      { qr_payload: `flowmic://pair?host=10.0.0.5&port=41879&code=${pc.short_code}`, mobile_name: 'Pixel-ab12' },
    ]) {
      const ack = await wireMobile(new FakeSocket(`m-${Object.keys(payload)[0]}`)).invoke('mobile:pair', payload);
      expect(ack, `${Object.keys(payload)[0]} refusal`).toEqual({ error: ACCOUNT_RESTRICTED, reason: 'terms_violation' });
    }
    // The gate runs BEFORE pairMobile mints anything: a restricted account must
    // not end up with rows written by a path it is not allowed to complete.
    expect(db.mobiles.listByPc(pc.id), 'no pairing row may exist for a refused pair').toEqual([]);

    // Control: released, the very same code pairs. Proves the refusal was about
    // the restriction and not about a code this fixture could never resolve.
    release();
    const ok = await wireMobile(new FakeSocket('m-after')).invoke('mobile:pair', { short_code: pc.short_code, mobile_name: 'Pixel-ab12' });
    expect(ok.error).toBeUndefined();
    expect(typeof ok.mobile_token).toBe('string');
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(1);
  });

  it('🔴 the cloud-instance variant refuses too, and mints no virtual PC', async () => {
    // saas-only path, and the one admission where the account is known before
    // any resolve — but also the one that INSERTS a PC row plus its pairing on
    // first use, so a late gate would leave both behind.
    registry = newRegistry('saas');
    restrict();
    const ack = await wireMobile(new FakeSocket('m-cloud'), 'saas').invoke('mobile:pair', { cloud_instance: true });
    expect(ack).toEqual({ error: ACCOUNT_RESTRICTED, reason: 'terms_violation' });
    expect(db.pcs.listByUser(USER).filter((p) => p.client_instance_id === CLOUD_INSTANCE_ID)).toEqual([]);

    release();
    const ok = await wireMobile(new FakeSocket('m-cloud-2'), 'saas').invoke('mobile:pair', { cloud_instance: true });
    expect(ok.error).toBeUndefined();
    expect(db.pcs.listByUser(USER).filter((p) => p.client_instance_id === CLOUD_INSTANCE_ID)).toHaveLength(1);
  });

  it('an account nobody restricted is unaffected on both admissions', async () => {
    // The blast-radius control. `isRestrictedAccount` answers false for a
    // VANISHED row too (account-restriction.ts argues that direction), so a
    // standalone box — whose 'default' user is never restricted — must behave
    // byte-identically to before this card.
    db.users.insert({ id: 'u-other', display_name: 'O', plan: 'pro' });
    const { pc } = registry.registerPc({ device_name: 'PC-B', user_id: 'u-other', client_instance_id: 'desktop-instance-bbbb' });
    restrict(); // USER is restricted; u-other is not, and owns this PC.

    const paired = await wireMobile(new FakeSocket('m-other'), 'standalone', 'u-other')
      .invoke('mobile:pair', { short_code: pc.short_code, mobile_name: 'Other-99aa' });
    expect(paired.error, 'one restricted account must not close anyone else\'s door').toBeUndefined();
    const reconnected = await wireMobile(new FakeSocket('m-other-2'), 'standalone', 'u-other')
      .invoke('mobile:reconnect', { token: paired.mobile_token });
    expect(reconnected.error).toBeUndefined();
  });
});

// ── the wiring, over a real bootstrap and a real socket ─────────────────────
describe('A2-3 F1 · the gate is WIRED (real bootstrap, real socket.io)', () => {
  const SECRET = 'restricted-socket-secret-32-bytes-xx';
  let server: BootstrapHandle | null = null;
  const sockets: ClientSocket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.disconnect();
    if (server) await server.close();
    server = null;
  });

  function connect(url: string, auth: Record<string, unknown> = {}): Promise<ClientSocket> {
    const socket = ioClient(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('connect timeout')), 3000);
    });
  }
  function ackOf(socket: ClientSocket, event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), 3000);
      socket.emit(event, payload, (r: Record<string, unknown>) => { clearTimeout(t); resolve(r ?? {}); });
    });
  }

  it('🔴 a real phone socket is refused, while mobile:login still succeeds and CARRIES the state', async () => {
    // fix-010: an in-process server has no proxy in front of it — its direct
    // peer IS the client (config.ts §trustedProxies).
    const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [] });
    server = await startServer(config);
    const url = `http://127.0.0.1:${server.port}`;

    const registered = await fetch(`${url}/api/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'phone@restrict.co', password: 'longenough1' }),
    });
    const account = await registered.json() as { token: string; user: { id: string } };

    const pcSocket = await connect(url, { jwt: account.token });
    const pcAck = await ackOf(pcSocket, 'pc:register', { device_name: 'PC-A', client_instance_id: PC_INSTANCE });
    expect(pcAck.error, `pc:register: ${JSON.stringify(pcAck)}`).toBeUndefined();

    // 0.2.66 — a REAL saas relay mints a PCID and puts it in the register ack.
    // Asserted here rather than assumed: this is the only test in the repo where
    // a PCID crosses an actual socket, so it is the only place that can prove the
    // mint and the ack projection are wired to each other rather than each being
    // green in isolation (the pcid-pairing unit tests exercise the registry, not
    // the wire).
    expect(pcAck.pcid, `pc:register ack must carry a pcid in saas: ${JSON.stringify(pcAck)}`).toMatch(/^\d{9}$/);

    const phone = await connect(url);
    const pairAck = await ackOf(phone, 'mobile:pair', {
      short_code: pcAck.short_code,
      pcid: pcAck.pcid,
      mobile_name: 'Pixel-ab12',
    });
    expect(pairAck.error, `mobile:pair: ${JSON.stringify(pairAck)}`).toBeUndefined();
    const mobileToken = pairAck.mobile_token as string;

    server.db.users.setRestricted(account.user.id, Date.now(), 'terms_violation');

    // ① The refusal reaches a REAL phone socket over a real relay. A gate the
    //   bootstrap forgot to hand a reader to would answer undefined here and
    //   still pass every handler test above.
    const returning = await connect(url, { auth: mobileToken, token: mobileToken });
    const reconnect = await ackOf(returning, 'mobile:reconnect', { token: mobileToken });
    expect(reconnect).toEqual({ error: ACCOUNT_RESTRICTED, reason: 'terms_violation' });

    // ② 🔴 owner's dividing line, on the SOCKET surface this time: "the user can still
    //   log in". mobile:login must still succeed and must carry `restricted: true`
    //   so the phone can paint a notice instead of guessing from a refusal. If
    //   this ever becomes an error, the superseded ban design came back.
    const login = await ackOf(phone, 'mobile:login', { email: 'phone@restrict.co', password: 'longenough1' });
    expect(login.ok, `mobile:login: ${JSON.stringify(login)}`).toBe(true);
    expect(typeof login.token).toBe('string');
    expect((login.user as { restricted?: boolean }).restricted).toBe(true);

    // ③ Lifted → the same token is admitted on the next attempt. The pairing was
    //   never wiped, over the real wire and not only in the repo.
    server.db.users.setRestricted(account.user.id, null, null);
    const again = await connect(url, { auth: mobileToken, token: mobileToken });
    const admitted = await ackOf(again, 'mobile:reconnect', { token: mobileToken });
    expect(admitted.error).toBeUndefined();
    expect(admitted.pairing_id).toBe(pairAck.pairing_id);
  });
});
