// card S2-01 — the relay half: it must ACCEPT the new fields, STORE them, and
// PROJECT them back out. Against the REAL handlers over a REAL sqlite db + REAL
// Registry + REAL RoomStore (fakes only at the socket seam), because the failure
// this card exists to prevent lives exactly at the layers a unit test replaces.
//
// 🔴 WHY "THE SCHEMA HAS THE FIELD" IS NOT THE TEST. Zod strips unknown keys at
// the relay boundary, so a field the relay does not declare never reaches the
// other side — no error, no log, both ends convinced they agreed. This repo has
// paid for that twice (`duration_ms` was stripped by an old relay; a stale
// protocol `dist` stripped a new field and made a test that should have failed
// pass). Every assertion here therefore reads the value off an ACK or a
// PROJECTION, never off a schema.
//
// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §1.1/§1.2/§5
//   docs/strategy/2026-09-06-web-client-parity-privacy-image-and-ux-addendum.md §3

import { NODE_CAN_WRITE } from '../src/node/writer-only';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerMobileHandlers } from '../src/socket/handlers/mobile.handler';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { PairRateLimiter } from '../src/room/pair-rate-limit';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

class FakeSocket {
  connected = true;
  readonly handshake = { address: '10.0.0.9' };
  private readonly handlers = new Map<string, ((payload: unknown, ack: unknown) => void)[]>();
  data: { auth?: AuthContext | null; roomUuid?: string } = { auth: null };
  constructor(readonly id: string) {}
  on(event: string, fn: (payload: unknown, ack: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  off(event: string, fn: (payload: unknown, ack: unknown) => void): this {
    // The zombie-room liveness probe pairs every `on` with an `off`. A fake
    // without it makes the probe throw AFTER the test body has returned, which
    // surfaces as an unrelated timeout three tests later — so it is here.
    const list = (this.handlers.get(event) ?? []).filter((f) => f !== fn);
    this.handlers.set(event, list);
    return this;
  }
  emit(): boolean { return true; }
  disconnect(): this { this.connected = false; return this; }
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

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  store = new RoomStore<Socket>();
});
afterEach(() => db.close());

function wirePc(socket: FakeSocket): FakeSocket {
  registerPcHandlers(socket as unknown as Socket, {
    writerOnly: NODE_CAN_WRITE,
    io: {} as Server,
    registry,
    store,
    resolveActingUser: () => ({ userId: 'default' }),
    // The GA-07 zombie probe runs on the reconnect leg. Fire its deadline
    // immediately rather than sleeping 1.5 s per reconnect: nothing here is
    // about liveness, and a real timer would make these assertions wait on an
    // answer no fake phone is going to send.
    liveness: { setTimer: (fn) => { fn(); return 0; }, clearTimer: () => {} },
  });
  return socket;
}

function wireMobile(socket: FakeSocket): FakeSocket {
  registerMobileHandlers(socket as unknown as Socket, {
    writerOnly: NODE_CAN_WRITE,
    io: {} as Server,
    registry,
    store,
    pairLimiter: new PairRateLimiter({}),
    mode: 'standalone',
    resolveActingUser: () => ({ userId: 'default' }),
    restriction: { getUser: (id) => db.users.findById(id) },
  });
  return socket;
}

/** Register a PC over the REAL `pc:register` handler and hand back its ack. */
async function registerPc(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const sock = wirePc(new FakeSocket(`pc-${Math.random().toString(16).slice(2)}`));
  return sock.invoke('pc:register', {
    device_name: 'dev-pc-a',
    client_instance_id: 'inst-0123456789abcdef',
    machine_uid: 'pc-00112233445566aa',
    ...extra,
  });
}

/** The desktop's own paired-phone table, read over the REAL handler. */
async function listMobiles(pcDeviceId: string): Promise<Record<string, unknown>[]> {
  const sock = wirePc(new FakeSocket('pc-list'));
  sock.data.auth = { userId: 'default', deviceId: pcDeviceId, kind: 'pc' } as AuthContext;
  const ack = await sock.invoke('pc:list-mobiles', {});
  return ack.mobiles as Record<string, unknown>[];
}

describe('client origin round-trips from the phone leg to the desktop table', () => {
  it('a WEB pair is visible as web in the PC-side projection', async () => {
    const reg = await registerPc();
    const phone = wireMobile(new FakeSocket('mob-web'));
    const pair = await phone.invoke('mobile:pair', {
      short_code: reg.short_code,
      mobile_name: 'Chrome on Android',
      device_uid: 'mb-00112233445566aa',
      client: 'web',
      client_version: '1.0.0',
    });
    expect(pair.pairing_id).toBeTruthy(); // positive control: it really paired

    const rows = await listMobiles(reg.pc_id as string);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.client).toBe('web');
    expect(rows[0]!.client_version).toBe('1.0.0');
  });

  it('an old client that sends no field still pairs, and its row says NULL', async () => {
    const reg = await registerPc();
    const phone = wireMobile(new FakeSocket('mob-old'));
    const pair = await phone.invoke('mobile:pair', { short_code: reg.short_code, mobile_name: 'Pixel 9' });
    expect(pair.error).toBeUndefined();   // it is not refused…
    expect(pair.mobile_token).toBeTruthy(); // …and it gets everything it used to

    const rows = await listMobiles(reg.pc_id as string);
    // 🔴 NULL, not 'app'. The relay states what it was told; the RENDERER applies
    // the default. Writing 'app' here would erase the difference between「the app
    // said so」and「nobody said anything」, and only one of those was observed.
    expect(rows[0]!.client).toBeNull();
    expect(rows[0]!.client_version).toBeNull();
  });

  it('the SAME handset coming back as a browser overwrites its old kind', async () => {
    // The reuse key is the device uid, not the kind — so one row can legitimately
    // change ends. A write that only filled NULLs would leave the table labelling
    // a browser as a phone forever.
    const reg = await registerPc();
    const asApp = wireMobile(new FakeSocket('mob-1'));
    await asApp.invoke('mobile:pair', {
      short_code: reg.short_code, mobile_name: 'Pixel 9', device_uid: 'mb-00112233445566aa',
      client: 'app', client_version: '0.3.78',
    });
    let rows = await listMobiles(reg.pc_id as string);
    expect(rows[0]!.client).toBe('app');
    const rowId = rows[0]!.pairing_id;

    const asWeb = wireMobile(new FakeSocket('mob-2'));
    await asWeb.invoke('mobile:pair', {
      short_code: reg.short_code, mobile_name: 'Pixel 9', device_uid: 'mb-00112233445566aa',
      client: 'web', client_version: '1.0.0',
    });
    rows = await listMobiles(reg.pc_id as string);
    expect(rows).toHaveLength(1);          // same row, not a second one
    expect(rows[0]!.pairing_id).toBe(rowId);
    expect(rows[0]!.client).toBe('web');
    expect(rows[0]!.client_version).toBe('1.0.0');
  });

  it('is not a refusal surface — an unknown kind is rejected at the boundary, and a valid pair is untouched', async () => {
    const reg = await registerPc();
    const bad = wireMobile(new FakeSocket('mob-bad'));
    const refused = await bad.invoke('mobile:pair', { short_code: reg.short_code, client: 'android' });
    expect(refused.error).toBe('PAIR_INVALID_PAYLOAD');
    // Positive control for the negative above: the SAME frame minus the bad
    // field pairs, so the refusal is about the value and not about the fixture.
    const good = wireMobile(new FakeSocket('mob-good'));
    expect((await good.invoke('mobile:pair', { short_code: reg.short_code })).mobile_token).toBeTruthy();
  });
});

describe('target_caps — declared by the target, read off the pairing ack', () => {
  it('a PC that declares image:true puts it on the pair ack', async () => {
    const reg = await registerPc({ client: 'app', client_version: '0.3.78', target_caps: { image: true } });
    const phone = wireMobile(new FakeSocket('mob-a'));
    const pair = await phone.invoke('mobile:pair', { short_code: reg.short_code });
    expect(pair.pairing_id).toBeTruthy();
    expect(pair.target_caps).toEqual({ image: true });
  });

  it('an UNDECLARED target has NO key on the ack — asserted on the key, never on undefined', async () => {
    const reg = await registerPc(); // exactly what a pre-S2-01 desktop sends
    const phone = wireMobile(new FakeSocket('mob-b'));
    const pair = await phone.invoke('mobile:pair', { short_code: reg.short_code });
    // Positive control first, so a zero here can never be a blind probe (G13 ②).
    expect(pair.pairing_id).toBeTruthy();
    expect('target_caps' in pair).toBe(false);
    expect(JSON.stringify(pair)).not.toContain('target_caps');
    // 🔴 And it must not have been helpfully turned into a refusal on the way.
    expect(pair.target_caps).not.toEqual({ image: false });
  });

  it('a declared NO travels as a declared no, with the target\'s own note', async () => {
    const reg = await registerPc({ client: 'web', target_caps: { image: false, image_note: 'text only' } });
    const phone = wireMobile(new FakeSocket('mob-c'));
    const pair = await phone.invoke('mobile:pair', { short_code: reg.short_code });
    expect(pair.target_caps).toEqual({ image: false, image_note: 'text only' });
  });

  it('rides the RECONNECT ack too, re-read at that instant', async () => {
    const reg = await registerPc({ target_caps: { image: true } });
    const phone = wireMobile(new FakeSocket('mob-d'));
    const pair = await phone.invoke('mobile:pair', { short_code: reg.short_code });
    const back = wireMobile(new FakeSocket('mob-d2'));
    const again = await back.invoke('mobile:reconnect', { token: pair.mobile_token });
    expect(again.pairing_id).toBe(pair.pairing_id); // accepted
    expect(again.target_caps).toEqual({ image: true });
  });

  it('a target that STOPS declaring stops being advertised — absence travels', async () => {
    // The row describes its CURRENT occupant. A desktop replaced by a build that
    // cannot take images must not keep the old claim, or the phone is holding a
    // capability nobody currently present has declared.
    const reg = await registerPc({ target_caps: { image: true } });
    const phone = wireMobile(new FakeSocket('mob-e'));
    const pair = await phone.invoke('mobile:pair', { short_code: reg.short_code });
    expect(pair.target_caps).toEqual({ image: true });

    await registerPc(); // same machine_uid / instance ⇒ same row, no declaration
    const back = wireMobile(new FakeSocket('mob-e2'));
    const again = await back.invoke('mobile:reconnect', { token: pair.mobile_token });
    expect(again.pairing_id).toBe(pair.pairing_id);
    expect('target_caps' in again).toBe(false);
  });

  it('🔴 the pc:reconnect leg declares too — the leg an INSTALLED desktop actually uses', async () => {
    // A desktop registers when it first pairs and reconnects by token forever
    // after. `pcid` shipped with register-only stamping and the backfill was
    // unreachable for established desktops until 0.3.1 added this same leg. This
    // test is the reason the field is on both.
    const reg = await registerPc(); // registered by a build that declared nothing
    const phone = wireMobile(new FakeSocket('mob-f'));
    const pair = await phone.invoke('mobile:pair', { short_code: reg.short_code });
    expect('target_caps' in pair).toBe(false); // nothing declared yet

    const back = wirePc(new FakeSocket('pc-again'));
    const rec = await back.invoke('pc:reconnect', {
      token: reg.token,
      client_instance_id: 'inst-0123456789abcdef',
      machine_uid: 'pc-00112233445566aa',
      client: 'app',
      client_version: '0.3.78',
      target_caps: { image: true },
    });
    expect(rec.error).toBeUndefined(); // positive control: the reconnect landed

    const phone2 = wireMobile(new FakeSocket('mob-f2'));
    const again = await phone2.invoke('mobile:reconnect', { token: pair.mobile_token });
    expect(again.target_caps).toEqual({ image: true });
  });

  it('a stored value this build cannot read means UNDECLARED, never a refusal', async () => {
    // A write from some future or broken build. Three inputs (NULL, unparseable,
    // unknown shape) must reach the SAME answer — otherwise a corrupt column
    // silently becomes a product refusal nobody can act on.
    const reg = await registerPc({ target_caps: { image: true } });
    db.pcs.setClientDeclaration(reg.pc_id as string, {
      client: 'app', client_version: null, target_caps: 'not json at all',
    });
    const phone = wireMobile(new FakeSocket('mob-g'));
    const pair = await phone.invoke('mobile:pair', { short_code: reg.short_code });
    expect(pair.pairing_id).toBeTruthy();
    expect('target_caps' in pair).toBe(false);
  });

  it('does not disturb the capabilities[] array beside it — two questions, two fields', async () => {
    const reg = await registerPc({ target_caps: { image: true } });
    const phone = wireMobile(new FakeSocket('mob-h'));
    const pair = await phone.invoke('mobile:pair', { short_code: reg.short_code });
    expect(Array.isArray(pair.capabilities)).toBe(true);
    // The server's own capabilities are per-node and identical for every pairing;
    // target_caps is per row. Folding one into the other would be a value
    // answering two questions.
    expect((pair.capabilities as string[]).some((c) => c.includes('image'))).toBe(false);
  });
});

describe('the columns themselves', () => {
  it('a legacy database gains all five columns idempotently, with nothing backfilled', () => {
    // The migration mechanism is the shared guarded ADD COLUMN loop; what this
    // pins is that the five columns are actually IN it and that a pre-existing
    // row comes out NULL rather than invented.
    const cols = (table: string): string[] =>
      (db.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('pc_devices')).toEqual(expect.arrayContaining(['client', 'client_version', 'target_caps']));
    expect(cols('mobile_pairings')).toEqual(expect.arrayContaining(['client', 'client_version']));

    const { pc } = registry.registerPc({ device_name: 'dev-pc-a', user_id: 'default', client_instance_id: 'inst-x' });
    const row = db.pcs.findById(pc.id)!;
    expect(row.client).toBeNull();
    expect(row.client_version).toBeNull();
    expect(row.target_caps).toBeNull();
  });
});
