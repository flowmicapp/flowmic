// Card F3 defect ③ — both compose:start refusals must reach the phone, not only the ack.
//
// WHY THIS FILE RUNS A REAL SOCKET. The two early returns in compose.handler.ts
// used to be `safeAck(...)` and nothing else, and a unit test on the handler
// would have shown a perfectly good refusal object being produced. It never
// arrived, because of a fact that lives in the OTHER repo half: the phone emits
// compose:start with NO ack callback — `apps/mobile/lib/src/session/
// compose_gate.dart` `_emit(event, payload)` calls `_transport.emit(event,
// payload)`, two arguments, no third. Every compose terminal is an EVENT
// (chunk/done/error), so the ack has no receiver at all. A refusal delivered
// only through the ack was therefore addressed to nobody, and the phone's only
// remaining terminal was its 45 s watchdog reporting `timeout` — the wrong wall
// named for a run the server refused in under a millisecond.
//
// So every assertion below is made on what a REAL client socket RECEIVED, and
// every compose:start here is emitted the way the phone emits it: WITHOUT an ack
// callback. Asserting on the ack would re-create the exact blind spot the defect
// lived in.

import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { safeParseEvent } from '@flowmic/protocol';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

let server: BootstrapHandle | null = null;
const sockets: ClientSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  if (server) await server.close();
  server = null;
});

async function standalone(): Promise<string> {
  server = await startServer(
    loadConfig({ mode: 'standalone', secret: 'compose-refusal-secret-32-bytes-ok', port: 0, dbPath: ':memory:' }),
  );
  return `http://127.0.0.1:${server.port}`;
}

function connect(url: string): Promise<ClientSocket> {
  const s = ioClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function ack<T = Record<string, unknown>>(s: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), 5000);
    s.emit(event, payload, (r: T) => {
      clearTimeout(t);
      resolve(r);
    });
  });
}

/** Arm the listener BEFORE the emit, so the race cannot mask a missing frame.
 *  Resolves `null` when nothing arrives — 「never received」 is the answer under test, so
 *  it has to reach the assertion as a value rather than blow up the run. */
function nextComposeError(s: ClientSocket, ms = 3000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.once('compose:error', (d: Record<string, unknown>) => {
      clearTimeout(t);
      resolve(d);
    });
  });
}

/** The one sentence every assertion below is really making. */
const NEVER_ARRIVED = 'compose:error never reached the phone (only the ack was answered)';

/** A paired phone on a REAL socket — mobile:pair is what sets auth on it. */
async function pairedPhone(url: string): Promise<ClientSocket> {
  const pc = await connect(url);
  const reg = await ack<{ short_code: string }>(pc, 'pc:register', {
    device_name: 'Refusal PC',
    client_instance_id: 'inst-refusal012345678',
  });
  const phone = await connect(url);
  await ack(phone, 'mobile:pair', { short_code: reg.short_code, mobile_name: 'Refusal Phone-0001' });
  return phone;
}

describe('Card F3 defect ③ — the phone RECEIVES both compose:start refusals', () => {
  it('unauthenticated → AUTH_TOKEN_INVALID arrives as a compose:error event', async () => {
    const url = await standalone();
    // Connected but never paired: getAuth(socket) is null. This is a real state —
    // a phone whose token was revoked keeps its socket and keeps pressing compose.
    const phone = await connect(url);
    const arrived = nextComposeError(phone);

    // NO ack callback — exactly two arguments, exactly like compose_gate._emit.
    phone.emit('compose:start', {
      task: 'translate',
      source_text: 'the words the user actually said',
      target_lang: 'en',
      request_id: 'u42-1754300000000000',
      entry_id: 'u42-1754300000000000',
    });

    const err = await arrived;
    expect(err?.['code'], NEVER_ARRIVED).toBe('AUTH_TOKEN_INVALID');
    // The echo is what lets the phone attribute it: both mobile consumers open
    // with `e.requestId == null || e.requestId != _requestId → return`
    // (ai_compose_controller.dart, utterance_compose.dart), so a refusal with no
    // usable request_id is received and then dropped, and the row would still die
    // on the 45 s watchdog.
    expect(err?.['request_id']).toBe('u42-1754300000000000');
    expect(err?.['entry_id']).toBe('u42-1754300000000000');
    // …and it is on-contract, so the phone's own parser keeps it
    // (AiComposeError.tryFromJson requires a NonEmpty `code`).
    expect(safeParseEvent('compose:error', err).success).toBe(true);
  });

  it('off-contract payload → LLM_INVALID_MODEL arrives as a compose:error event', async () => {
    const url = await standalone();
    const phone = await pairedPhone(url);
    const arrived = nextComposeError(phone);

    // `task` is not one of the three literals ⇒ the schema refuses it, so this
    // turn has no `parsed.data` and the echo can only come off the raw frame.
    phone.emit('compose:start', {
      task: 'summarise',
      source_text: 'the words the user actually said',
      request_id: 'u43-1754300000000001',
      entry_id: 'u43-1754300000000001',
    });

    const err = await arrived;
    expect(err?.['code'], NEVER_ARRIVED).toBe('LLM_INVALID_MODEL');
    expect(err?.['message']).toBe('invalid compose:start payload');
    expect(err?.['request_id']).toBe('u43-1754300000000001');
    expect(err?.['entry_id']).toBe('u43-1754300000000001');
    expect(safeParseEvent('compose:error', err).success).toBe(true);
  });

  it('the raw echo is CHECKED, not forwarded: a non-string id is dropped, the refusal still lands', async () => {
    const url = await standalone();
    const phone = await pairedPhone(url);
    const arrived = nextComposeError(phone);

    // A frame we refused to parse is a frame we do not trust. ComposeErrorSchema
    // types both ids as NonEmpty; forwarding `123` / '' verbatim would make the
    // phone drop the whole refusal at AiComposeError.tryFromJson — i.e. checking
    // here is what makes it arrive, not decoration.
    phone.emit('compose:start', { task: 'summarise', source_text: 'x', request_id: 123, entry_id: '' });

    const err = await arrived;
    expect(err?.['code'], NEVER_ARRIVED).toBe('LLM_INVALID_MODEL');
    expect(err).not.toHaveProperty('request_id');
    expect(err).not.toHaveProperty('entry_id');
    expect(safeParseEvent('compose:error', err).success).toBe(true);
  });

  it('positive control: a WELL-FORMED compose:start from a paired phone is not refused by either branch', async () => {
    // Without this, the two assertions above could both be satisfied by a server
    // that refuses every compose:start it ever sees.
    const url = await standalone();
    const phone = await pairedPhone(url);
    const settled = new Promise<Record<string, unknown> | null>((resolve) => {
      phone.once('compose:error', (d: Record<string, unknown>) => resolve(d));
      phone.once('compose:done', () => resolve(null));
      setTimeout(() => resolve(null), 2000);
    });

    phone.emit('compose:start', {
      task: 'translate',
      source_text: 'the words the user actually said',
      target_lang: 'en',
      request_id: 'u44-1754300000000002',
      entry_id: 'u44-1754300000000002',
    });

    const outcome = await settled;
    // It may well still fail (no LLM is configured in this harness) — what must
    // NOT happen is failing as 「unauthenticated」 or 「off-contract」, because this
    // frame is neither.
    expect(outcome?.['code']).not.toBe('AUTH_TOKEN_INVALID');
    expect(outcome?.['message']).not.toBe('invalid compose:start payload');
  });
});
