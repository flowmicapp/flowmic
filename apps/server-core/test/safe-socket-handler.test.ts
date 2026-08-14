// D4 layer 2 — one throwing socket handler must fail THAT event, not the relay.
//
// socket.io 4.8.3 dispatches handlers inside a bare `process.nextTick` with
// no try/catch (node_modules/.pnpm/socket.io@4.8.3/…/dist/socket.js:689-702),
// so without the wrapper a sync throw is an uncaughtException and an async
// handler's rejection is an unhandledRejection — either takes the whole
// process (and every online user) down. bootstrap.ts patches each connection
// socket with wrapSocketHandlers BEFORE registering any handler.
//
// REVERSE CONTROL (run and watched red, then restored): comment out the
// `wrapSocketHandlers(socket);` line in bootstrap.ts's connection callback ⇒
// the integration cases below die red — vitest reports the poison handler's
// error as an unhandled exception/rejection instead of a survived round-trip.
//
// PRIVACY pin: the failure log line carries event name + socket id + error,
// and must NEVER contain the payload (payloads can carry user speech).

import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { RateGate, wrapSocketHandlers, type WrappableSocket } from '../src/error-handling';
import { log } from '../src/log';

// ─── unit half: the wrapper mechanism over an EventEmitter-backed socket ───

class FakeSock extends EventEmitter {
  constructor(readonly id: string) {
    super();
  }
}

interface LogLine {
  msg: string;
  fields: Record<string, unknown>;
}

function capture(): { logger: { error(msg: string, fields?: Record<string, unknown>): void }; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return { lines, logger: { error: (msg, fields): void => { lines.push({ msg, fields: fields ?? {} }); } } };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('wrapSocketHandlers (unit) — containment, identity, privacy, rate gate', () => {
  it('a SYNC throw is contained and logged with event + socket id + stack, NEVER the payload', () => {
    const sock = new FakeSock('sock-under-test');
    const { logger, lines } = capture();
    wrapSocketHandlers(sock as unknown as WrappableSocket, { logger, gateFor: () => new RateGate(0) });
    sock.on('inject:request', () => {
      throw new Error('SQLITE_FULL: disk I/O error');
    });

    // Without the wrapper this emit() would throw straight back at us.
    expect(() => sock.emit('inject:request', { text: 'PRIVATE-USER-UTTERANCE' })).not.toThrow();

    expect(lines).toHaveLength(1);
    const { msg, fields } = lines[0]!;
    expect(msg).toContain('event dropped, connection kept');
    expect(fields.event).toBe('inject:request');
    expect(fields.socketId).toBe('sock-under-test');
    expect(fields.error).toBe('SQLITE_FULL: disk I/O error');
    expect(String(fields.stack)).toContain('safe-socket-handler.test.ts');
    // The privacy pin: nothing in the line may echo payload contents.
    expect(JSON.stringify({ msg, fields })).not.toContain('PRIVATE-USER-UTTERANCE');
  });

  it('an ASYNC handler rejection is contained and logged too', async () => {
    const sock = new FakeSock('sock-async');
    const { logger, lines } = capture();
    wrapSocketHandlers(sock as unknown as WrappableSocket, { logger, gateFor: () => new RateGate(0) });
    sock.on('compose:start', async () => {
      throw new Error('async boom');
    });

    expect(() => sock.emit('compose:start', {})).not.toThrow();
    await flush();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.fields.event).toBe('compose:start');
    expect(lines[0]!.fields.error).toBe('async boom');
  });

  it('positive control: healthy handlers pass through untouched (args, ack, multiple listeners)', () => {
    const sock = new FakeSock('sock-healthy');
    const { logger, lines } = capture();
    wrapSocketHandlers(sock as unknown as WrappableSocket, { logger });
    const seen: unknown[] = [];
    let acked: unknown = null;
    sock.on('heartbeat', (payload: unknown, ack: unknown) => {
      seen.push(payload);
      (ack as (r: unknown) => void)({ ok: true });
    });
    sock.on('heartbeat', (payload: unknown) => seen.push(payload));

    sock.emit('heartbeat', { ts: 7 }, (r: unknown) => { acked = r; });

    expect(seen).toEqual([{ ts: 7 }, { ts: 7 }]);
    expect(acked).toEqual({ ok: true });
    expect(lines).toHaveLength(0);
  });

  it('one throwing listener does not stop the OTHER listeners on the same event', () => {
    const sock = new FakeSock('sock-multi');
    const { logger, lines } = capture();
    wrapSocketHandlers(sock as unknown as WrappableSocket, { logger, gateFor: () => new RateGate(0) });
    const ran: string[] = [];
    sock.on('focus:state', () => { throw new Error('first listener dies'); });
    sock.on('focus:state', () => ran.push('second'));

    expect(() => sock.emit('focus:state', {})).not.toThrow();
    expect(ran).toEqual(['second']);
    expect(lines).toHaveLength(1);
  });

  it('off()/removeListener() by ORIGINAL reference still works (room/liveness.ts contract)', () => {
    const sock = new FakeSock('sock-off');
    const { logger } = capture();
    wrapSocketHandlers(sock as unknown as WrappableSocket, { logger });
    let calls = 0;
    const onPong = (): void => { calls += 1; };
    sock.on('sys:pong', onPong);
    sock.emit('sys:pong', {});
    expect(calls).toBe(1);

    (sock as unknown as WrappableSocket).off('sys:pong', onPong); // by original identity, as liveness.ts does
    sock.emit('sys:pong', {});
    expect(calls).toBe(1); // removed — no leak, no stale probe listener
    expect(sock.listenerCount('sys:pong')).toBe(0);
  });

  it('the per-event rate gate reduces LINE volume, not EVENT volume (suppressed count rides out)', () => {
    const sock = new FakeSock('sock-flood');
    const { logger, lines } = capture();
    let t = 0;
    const gate = new RateGate(5_000, () => t);
    wrapSocketHandlers(sock as unknown as WrappableSocket, { logger, gateFor: () => gate });
    sock.on('audio:chunk', () => { throw new Error('dead disk'); });

    for (let i = 0; i < 25; i += 1) sock.emit('audio:chunk', {}); // an audio-rate flood
    expect(lines).toHaveLength(1);

    t += 5_000;
    sock.emit('audio:chunk', {});
    expect(lines).toHaveLength(2);
    expect(lines[1]!.fields.suppressedSinceLastLine).toBe(24); // nothing hidden
  });
});

// ─── integration half: the REAL server survives a poison handler ───

let server: BootstrapHandle;
let url: string;
const sockets: ClientSocket[] = [];

function connect(): Promise<ClientSocket> {
  const socket = ioClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
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

beforeAll(async () => {
  const config = loadConfig({ port: 0, dbPath: ':memory:', secret: 'd4-safe-handler-test-secret-32-bytes' });
  server = await startServer(config);
  url = `http://localhost:${server.port}`;
  // Poison handlers, registered through the SAME connection path production
  // uses: bootstrap's own connection callback runs first and patches
  // socket.on, so these registrations go through the wrapped seam exactly
  // like the register* handlers do. Events are protocol-whitelisted names
  // with no per-socket production listener at rest ('sys:pong' listeners only
  // exist during a liveness probe), so nothing else reacts to them here.
  server.io.on('connection', (socket) => {
    socket.on('sys:pong', () => {
      throw new Error('D4 poison: sync handler throw');
    });
    socket.on('auth:expired', async () => {
      throw new Error('D4 poison: async handler rejection');
    });
  });
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await server.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('integration — a poison handler cannot take the relay down', () => {
  it('sync throw: the event dies, the SAME socket still answers the next event, the failure is in the log', async () => {
    const errorSpy = vi.spyOn(log, 'error');
    const client = await connect();

    client.emit('sys:pong', { nonce: 'poison-nonce', ok: true }); // handler throws server-side
    // Survival proof on the SAME socket: heartbeat still round-trips (the
    // unauthenticated refusal code is still an ANSWER — a dead process/socket
    // answers nothing and the ack would time out).
    const res = await ack(client, 'heartbeat', { ts: 1 });
    expect(res).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    expect(client.connected).toBe(true);

    const line = errorSpy.mock.calls.find(([msg]) => msg.includes('event dropped, connection kept'));
    expect(line).toBeDefined();
    const fields = line![1] as Record<string, unknown>;
    expect(fields.event).toBe('sys:pong');
    expect(typeof fields.socketId).toBe('string');
    expect(fields.error).toBe('D4 poison: sync handler throw');
    // Privacy: the logged line never echoes the payload.
    expect(JSON.stringify(fields)).not.toContain('poison-nonce');
  });

  it('async rejection: same containment, and OTHER sockets are untouched', async () => {
    const errorSpy = vi.spyOn(log, 'error');
    const victim = await connect();
    const bystander = await connect();

    victim.emit('auth:expired', {}); // async poison rejects server-side
    const res = await ack(bystander, 'heartbeat', { ts: 2 });
    expect(res).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    expect(victim.connected).toBe(true);
    expect(bystander.connected).toBe(true);

    const line = errorSpy.mock.calls.find(
      ([msg, fields]) => msg.includes('event dropped') && (fields as Record<string, unknown>).event === 'auth:expired',
    );
    expect(line).toBeDefined();
    expect((line![1] as Record<string, unknown>).error).toBe('D4 poison: async handler rejection');
  });
});
