// A PC socket that flaps — and the one thing about it that must never be
// "optimised" into something cheaper.
//
// WHY THIS FILE EXISTS. The desktop had a defect where a channel could sit
// CONNECTED but never re-join its room (the register watchdog gave up
// permanently — see socket/register_watchdog.rs). While chasing it the server
// half was audited and found clean: one join path (pc.handler `pc:register` /
// `pc:reconnect`, both through `store.joinPc`), one leave path (the `disconnect`
// handler in bootstrap.ts), no TTL, no heartbeat timeout, no PC-side grace
// window. That audit is a snapshot of a reading; this file is the part of it a
// machine can re-check.
//
// The load-bearing case is the LAST one, and it is here to be inconvenient:
//   🔴 a connected socket is NOT a joined room.
// Presence answers `store.getPc(room_uuid) !== null`, and the temptation the day
// someone finds this route "slow" or "wrong" will be to answer it from the
// connection instead — at which point every desktop stuck exactly where the
// register watchdog left it would be reported ONLINE to the phone, and the one
// artefact that told the truth about it would start lying. So the transport fact
// and the room fact are separated here as an executable statement, with a real
// server and a real socket.io client rather than a fake of either.
//
// The second describe covers the forensic line the same absence produces
// (`presence: PC is not in its room`). It is driven through the route function
// directly, because what it asserts is what the LINE carries — and a line whose
// fields you cannot read is a line you cannot test.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { RateGate } from '../src/error-handling';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { pcAbsenceReasons } from '../src/room/pc-absence';
import { PC_PRESENCE_PATH, tryHandlePresenceRoutes } from '../src/http/presence-routes';

let server: BootstrapHandle;
let url: string;
const sockets: ClientSocket[] = [];

/** Same harness as golden-path.test.ts: a real client against a real server. */
function connect(auth: Record<string, unknown> = {}): Promise<ClientSocket> {
  const socket = ioClient(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
}

function ack<T = Record<string, unknown>>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), 3000);
    socket.emit(event, payload, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

interface PresenceAnswer {
  ok: boolean;
  pc_id: string;
  pc_online: boolean;
  pc_absent_reason?: string;
}

/** The phone's own question, asked the way the phone asks it. */
async function presence(mobileToken: string): Promise<PresenceAnswer> {
  const res = await fetch(`${url}${PC_PRESENCE_PATH}`, {
    headers: { authorization: `Bearer ${mobileToken}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PresenceAnswer;
}

/** A disconnect reaches the server's handler asynchronously, so 「still true」 and
 *  「not yet false」 look the same for a few milliseconds. Poll, then assert on the
 *  ANSWER — never on the poll having ended, which is how a timing test quietly
 *  becomes a test of nothing. */
async function presenceSettlesTo(mobileToken: string, expected: boolean): Promise<PresenceAnswer> {
  const deadline = Date.now() + 3000;
  let last = await presence(mobileToken);
  while (last.pc_online !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    last = await presence(mobileToken);
  }
  return last;
}

beforeAll(async () => {
  const config = loadConfig({ port: 0, dbPath: ':memory:', secret: 'integration-test-secret-32-bytes-long' });
  server = await startServer(config);
  url = `http://localhost:${server.port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await server.close();
});

describe('a PC socket that flaps', () => {
  it('leaves the room on a drop, is back on pc:reconnect, and a connected-but-silent socket is NOT in the room', async () => {
    // ── 1. register + pair, and the phone can see its PC ──────────────────────
    const pc = await connect();
    const reg = await ack<Record<string, string>>(pc, 'pc:register', {
      device_name: 'Flap PC',
      client_instance_id: 'inst-flap0123456789ab',
    });
    expect(reg.token).toMatch(/^fm_[0-9a-f]{64}$/);

    const mobile = await connect();
    mobile.on('sys:ping', (p: { nonce: string }) => mobile.emit('sys:pong', { nonce: p.nonce, ok: true }));
    const pair = await ack<Record<string, unknown>>(mobile, 'mobile:pair', { short_code: reg.short_code });
    const mobileToken = pair.mobile_token as string;
    expect(pair.pc_online).toBe(true);

    const online = await presence(mobileToken);
    expect(online.pc_online).toBe(true);
    expect(online.pc_id).toBe(reg.pc_id);

    // ── 2. the socket drops ───────────────────────────────────────────────────
    // An ORDINARY drop must stay byte-identical to what this route has always
    // answered: three keys, no reason. `pc_absent_reason` is reserved for an
    // absence the server actually recorded a cause for (today only
    // 'auth_expired'), and inventing one for every disconnect would turn "we do
    // not know why" into a claim.
    pc.disconnect();
    const offline = await presenceSettlesTo(mobileToken, false);
    expect(offline.pc_online).toBe(false);
    expect(Object.keys(offline).sort()).toEqual(['ok', 'pc_id', 'pc_online']);
    expect('pc_absent_reason' in offline).toBe(false);

    // ── 3. the same machine comes back on its token ───────────────────────────
    const pc2 = await connect({ token: reg.token });
    const recon = await ack<Record<string, unknown>>(pc2, 'pc:reconnect', { token: reg.token });
    expect(recon.room_uuid).toBe(reg.room_uuid);
    expect((await presenceSettlesTo(mobileToken, true)).pc_online).toBe(true);

    // ── 4. 🔴 connected is not joined ─────────────────────────────────────────
    // Clear the room first, so what the last assertion measures is the silent
    // socket and nothing else.
    pc2.disconnect();
    expect((await presenceSettlesTo(mobileToken, false)).pc_online).toBe(false);

    // A socket that carries the PC's real credential in its handshake — so the
    // server knows exactly who this is (`socket.data.auth`) — and then says
    // nothing. No `pc:register`, no `pc:reconnect`. This is the shape the desktop
    // was stuck in when its register watchdog gave up: transport healthy,
    // identity known, room empty.
    const silent = await connect({ token: reg.token });
    expect(silent.connected).toBe(true);

    const stillAbsent = await presence(mobileToken);
    expect(stillAbsent.pc_online).toBe(false);
    // …and it does not become true by waiting: nothing in the server promotes a
    // connection into a room membership over time.
    await new Promise((r) => setTimeout(r, 250));
    expect((await presence(mobileToken)).pc_online).toBe(false);

    // The positive control for that zero: the SAME socket joining properly flips
    // the answer. Without this, "false" could equally mean the route broke.
    await ack(silent, 'pc:reconnect', { token: reg.token });
    expect((await presenceSettlesTo(mobileToken, true)).pc_online).toBe(true);
  });
});

// ── the forensic line the absent answer produces ─────────────────────────────

function request(token: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = 'GET';
  req.url = PC_PRESENCE_PATH;
  (req as { headers: Record<string, string> }).headers = { authorization: `Bearer ${token}` };
  return req;
}

function response(): ServerResponse {
  const res = {
    writeHead: () => res,
    end: () => undefined,
  } as unknown as ServerResponse;
  return res;
}

/** A real Registry + RoomStore over a real in-memory DB, for the same reason
 *  http-pc-presence.test.ts uses one: a fake would let 「is it in the room」 have
 *  two answers, and this route exists because it must have one. */
function world() {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
  const registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  const store = new RoomStore<{ id: string }>();
  const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: 'u1', client_instance_id: 'inst-a-000000000000' });
  const pair = registry.pairMobile({ short_code: pc.short_code, mobile_name: 'phone', user_id: 'u1' });
  return { db, registry, store, pc: pair.pc, token: pair.token };
}

interface Line {
  msg: string;
  fields: Record<string, unknown>;
}

/** `lines[0]` under `noUncheckedIndexedAccess` is `Line | undefined`, and a `!`
 *  here would turn "the route logged nothing" into a null-deref instead of a
 *  readable failure. */
function first(lines: Line[]): Line {
  const line = lines[0];
  if (line === undefined) throw new Error('expected a log line, got none');
  return line;
}

afterEach(() => {
  // The absence table is a module singleton (its own header says why), so a
  // reason left behind here would answer somebody else's question.
  pcAbsenceReasons.drainForTests();
});

describe('the forensic line for an absent PC', () => {
  it('makes an auth_expired absence attributable from the log alone', () => {
    const w = world();
    // The state: this PC's account died, the watchdog filed the reason, the room
    // is empty. On the wire the phone gets `pc_absent_reason: 'auth_expired'` —
    // this case is about whether the SERVER can still answer "why was that PC
    // away last Tuesday" once the phone has moved on.
    pcAbsenceReasons.noteByRoom(w.pc.room_uuid, 'auth_expired');

    const lines: Line[] = [];
    const handled = tryHandlePresenceRoutes(request(w.token), response(), {
      registry: w.registry,
      store: w.store as unknown as RoomStore,
      pcs: w.db.pcs,
      logger: { info: (msg, fields) => lines.push({ msg, fields: fields ?? {} }) },
      absentLogGate: new RateGate(60_000),
    });

    expect(handled).toBe(true);
    expect(lines).toHaveLength(1);
    const line = first(lines);
    // The whole point of the line: WHICH pc, and WHY it was away. A line that
    // says only "a phone asked about an absent PC" tells the reader what they
    // already knew.
    expect(line.fields.absent_reason).toBe('auth_expired');
    expect(line.fields.pc_id).toBe(w.pc.id);
    // The room is correlatable but never written down in the clear.
    expect(line.fields.room).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(line)).not.toContain(w.pc.room_uuid);
    // …and never the caller's bearer token.
    expect(JSON.stringify(line)).not.toContain(w.token);
  });

  it('says none rather than nothing when no reason was recorded', () => {
    const w = world();
    const lines: Line[] = [];
    tryHandlePresenceRoutes(request(w.token), response(), {
      registry: w.registry,
      store: w.store as unknown as RoomStore,
      pcs: w.db.pcs,
      logger: { info: (msg, fields) => lines.push({ msg, fields: fields ?? {} }) },
      absentLogGate: new RateGate(60_000),
    });
    // An omitted key would read as 「this line predates the field」; 'none' is an
    // answer, and it is the ordinary-shutdown answer.
    expect(first(lines).fields.absent_reason).toBe('none');
  });

  it('logs nothing at all while the PC is present', () => {
    const w = world();
    w.store.joinPc(w.pc.room_uuid, { id: 'sock-1' });
    const lines: Line[] = [];
    tryHandlePresenceRoutes(request(w.token), response(), {
      registry: w.registry,
      store: w.store as unknown as RoomStore,
      pcs: w.db.pcs,
      logger: { info: (msg, fields) => lines.push({ msg, fields: fields ?? {} }) },
      absentLogGate: new RateGate(60_000),
    });
    // The online answer carries no information — it is the expected state and
    // the overwhelming majority of the traffic.
    expect(lines).toEqual([]);
  });

  it('reduces the volume of a 10-second poll without hiding it', () => {
    const w = world();
    let clock = 1_000_000;
    const gate = new RateGate(60_000, () => clock);
    const lines: Line[] = [];
    const logger = { info: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields: fields ?? {} }) };
    const askOnce = (): void => {
      tryHandlePresenceRoutes(request(w.token), response(), {
        registry: w.registry,
        store: w.store as unknown as RoomStore,
        pcs: w.db.pcs,
        logger,
        absentLogGate: gate,
      });
    };

    // Six polls a minute for five minutes against a PC that is not coming back.
    for (let i = 0; i < 30; i += 1) {
      askOnce();
      clock += 10_000;
    }
    // One line per window, not 30 — and every line carries how many answers it
    // stands for, so volume is reduced and never hidden.
    expect(lines.length).toBe(5);
    expect(first(lines).fields.suppressedSinceLastLine).toBe(0);

    // ⚠️ The accounting is DEFERRED, not complete: a window's suppressed count is
    // reported by the NEXT granted line, so after 30 polls the log accounts for
    // 25 of them and the last five are still sitting in the gate. Written out
    // because the obvious assertion (「every poll is accounted for right now」) is
    // false, and a test that asserted it would be pinning a mechanism this gate
    // does not have.
    const accounted = (): number =>
      lines.length + lines.reduce((n, l) => n + (l.fields.suppressedSinceLastLine as number), 0);
    expect(accounted()).toBe(25);

    // Nothing is LOST, though: the next granted line carries the tail.
    clock += 60_000;
    askOnce();
    expect(lines.length).toBe(6);
    expect(accounted()).toBe(31); // the 30 polls above + this one
  });
});
