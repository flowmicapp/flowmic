// card K-2 — a RECORD-ONLY press on the cloud leg, against a real saas server
// with ZERO PCs, is admitted; and the quota gate that used to over-reach was
// NARROWED, not removed.
//
// ── WHY THIS FILE RUNS A REAL SOCKET (the compose-refusal-reaches-phone.ts
//    argument, one handler over) ────────────────────────────────────────────
// Every existing audio:start test — including the QTA-1/QTA-2 rows — drives a
// hand-built deps object through a `FakeSocket` whose ack callback is ALWAYS
// present, and every one of them sends a frame with NO `delivery` field, i.e.
// `delivery:'inject'`. Two consequences, and both are the reason this file
// exists rather than another row over there:
//
//   · there was no test anywhere in this repo where `delivery:'none'` met a
//     saas server, which is precisely the combination card K-1 is about;
//   · production emits `audio:start` with NO ack callback at all
//     (apps/mobile/lib/src/ptt/ptt_session.dart pttDown → `transport.emit`,
//     two arguments, not `emitWithAck`) — the fact that made the QTA-1 defect
//     invisible for as long as it was. Every emit below is that shape, so an
//     assertion here cannot be satisfied by an ack nobody reads.
//
// ── HOW THIS FILE REFUSES TO PASS ON "NOTHING HAPPENED" ─────────────────────
// "No refusal arrived" is satisfied just as well by a server that dropped the
// frame on the floor. So each admitted row also PROVES a live session exists,
// with the cheapest frame only a live session can produce: `stt:level`, which
// `SttSessionBridge.pushChunk` emits on the very first chunk. If `audio:start`
// had been refused, `audio:chunk` would find `state.orchestrator === null` and
// return, and nothing would arrive.
//
// ⚠️ The engine itself CANNOT connect from a test box, so `stt:engine-status`
// and eventually an engine-origin `stt:error` are EXPECTED here and are not
// failures. Assertions about refusal are therefore made on the CODE, never on
// "no stt:error at all" — which would be a test that measures the network.

import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { currentMonth } from '../src/db/repos/usage.repo';

const SECRET = 'record-only-cloud-leg-secret-32-bytes';

let server: BootstrapHandle | null = null;
const sockets: ClientSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  if (server) await server.close();
  server = null;
});

async function saas(): Promise<string> {
  // fix-010: an in-process server has no proxy in front of it — its direct peer
  // IS the client (config.ts §trustedProxies), same posture as
  // saas-cloud-admission.test.ts.
  server = await startServer(loadConfig({
    mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [],
  }));
  return `http://127.0.0.1:${server.port}`;
}

function connect(url: string, auth: Record<string, unknown> = {}): Promise<ClientSocket> {
  const s = ioClient(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
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
    s.emit(event, payload, (r: T) => { clearTimeout(t); resolve(r); });
  });
}

async function registerUser(url: string, email: string): Promise<{ id: string; token: string }> {
  const res = await fetch(`${url}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'longenough1' }),
  });
  const json = await res.json() as { token: string; user: { id: string } };
  return { id: json.user.id, token: json.token };
}

/** Collect EVERY stt:error for a window. Armed before the emit so the race
 *  cannot mask one, and it resolves rather than throws — 「none arrived」 is an
 *  answer under test here, so it must reach the assertion as a value. */
function collectSttErrors(s: ClientSocket, ms: number): Promise<Array<Record<string, unknown>>> {
  const seen: Array<Record<string, unknown>> = [];
  s.on('stt:error', (d: Record<string, unknown>) => seen.push(d));
  return new Promise((resolve) => setTimeout(() => resolve(seen), ms));
}

/** Resolves `true` when a frame only a LIVE session can produce arrives. */
function sawLevel(s: ClientSocket, ms = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    s.once('stt:level', () => { clearTimeout(t); resolve(true); });
  });
}

const SR = 16_000;
/** ~120 ms of loud PCM16-LE, so the VAD amplitude is a real number. */
function pcm(ms = 120): string {
  const n = (SR * ms) / 1000;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / SR)), i * 2);
  return b.toString('base64');
}

const RECORD_ONLY = {
  sample_rate: SR, channels: 1, encoding: 'pcm_s16le',
  mode: 'realtime', source_lang: 'zh', delivery: 'none',
} as const;

/**
 * Give this account an engine it can BUILD but never REACH.
 *
 * A stock saas account has `stt.byok_enabled=false` and only seed routings, and
 * on this box that resolves to `SttConfigMissingError` — a refusal, which would
 * make every row below indistinguishable from the defect. So the account is
 * given its own routing, exactly as a BYOK user's console would write it.
 *
 * ⚠️ The endpoint is DEAD on purpose. What must exist for these assertions is a
 * live SESSION (an orchestrator installed in the registry), not a working
 * transcription — the engine's own connect failure arrives later on
 * `stt:engine-status`/`stt:error` and is filtered out by code where it matters.
 */
function giveOwnEngine(userId: string): void {
  server!.db.settings.write(userId, 'stt.byok_enabled', true);
  server!.db.settings.write(userId, 'stt.routings', [{
    language: '*',
    engine_id: 'custom-openai-compatible',
    endpoint: 'http://127.0.0.1:1/v1',
    api_key: 'test-key-not-empty',
    model: 'whisper-1',
  }]);
}

/** A phone on a real socket, admitted to a cloud light-record instance. */
async function cloudPhone(url: string, token: string, userId: string): Promise<{ phone: ClientSocket; room: string }> {
  const phone = await connect(url, { jwt: token });
  giveOwnEngine(userId);
  const pair = await ack<{ room_uuid: string; pc_online: boolean; pc_instance_id: string }>(
    phone, 'mobile:pair', { cloud_instance: true },
  );
  // 🔴 ZERO PCs, stated by the server itself. `pc_online` is the room-presence
  // answer to "is a PC connected here", and `pc_instance_id` says the only
  // "PC" this room has is the VIRTUAL one mobile:pair mints for a light-record
  // instance — a DB row with no socket, which is the whole point of this leg.
  expect(pair.pc_online).toBe(false);
  expect(pair.pc_instance_id).toBe('flowmic-cloud-instance');
  return { phone, room: pair.room_uuid };
}

describe('K-2: record-only on the cloud leg, zero PCs', () => {
  it('🔴 admitted with no ack callback at all, and a session really exists', async () => {
    const url = await saas();
    const { id, token } = await registerUser(url, 'recordonly@b.co');
    const { phone } = await cloudPhone(url, token, id);

    // The only PC-shaped row in the DB is the virtual one, and it belongs to
    // the SAME account — the scope note K-1 rests on: on this leg the second
    // ensureQuota was skipped by id equality even before the fix, so what this
    // row proves is the ACCEPTANCE, not the narrowing (that is the unit rows in
    // audio-start-refusal-is-spoken.test.ts).
    const pcs = server!.db.pcs.listByUser(id);
    expect(pcs).toHaveLength(1);
    expect(pcs[0]!.user_id).toBe(id);

    const errors = collectSttErrors(phone, 1200);
    const level = sawLevel(phone);
    // 🔴 TWO arguments. Exactly how ptt_session.dart emits it.
    phone.emit('audio:start', RECORD_ONLY);
    phone.emit('audio:chunk', { seq: 0, data_b64: pcm(), ts_ms: 0 });

    // Non-vacuous: a refused start would leave `state.orchestrator` null and
    // audio:chunk would return without emitting anything.
    expect(await level, 'no stt:level — the session was never created').toBe(true);
    // Refusal-class codes only. Engine-origin frames are expected on a box with
    // no reachable STT endpoint and say nothing about admission.
    const refusals = (await errors).filter((e) => e['code'] === 'QUOTA_EXCEEDED');
    expect(refusals, 'a record-only press was refused on somebody else\'s ledger').toEqual([]);
  });

  it('positive control: the SAME frame with delivery:inject is admitted too', async () => {
    // Without this, the row above could be satisfied by a server that admits
    // nothing and a `stt:level` that came from somewhere else. It also pins
    // that K-1 changed the record-only case ONLY.
    const url = await saas();
    const { id, token } = await registerUser(url, 'injectctl@b.co');
    const { phone } = await cloudPhone(url, token, id);
    const level = sawLevel(phone);
    phone.emit('audio:start', { ...RECORD_ONLY, delivery: 'inject' });
    phone.emit('audio:chunk', { seq: 0, data_b64: pcm(), ts_ms: 0 });
    expect(await level).toBe(true);
  });

  it('🔴 the gate was NARROWED, not REMOVED: an over-quota account is still refused', async () => {
    const url = await saas();
    const { id, token } = await registerUser(url, 'overquota@b.co');
    // Spend the free tier's whole STT allowance on the ACTING account. This is
    // the same month bucket `QuotaGuard` reads (usage.repo `currentMonth`), so
    // the refusal below comes from the real solver, not from a stub.
    server!.db.usage.increment(id, currentMonth(), { stt_minutes: 100_000 });

    const { phone } = await cloudPhone(url, token, id);
    const errors = collectSttErrors(phone, 1200);
    const level = sawLevel(phone, 800);
    phone.emit('audio:start', RECORD_ONLY);
    phone.emit('audio:chunk', { seq: 0, data_b64: pcm(), ts_ms: 0 });

    const refusals = (await errors).filter((e) => e['code'] === 'QUOTA_EXCEEDED');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false });
    // …and the counterpart of the first row's probe: a refused start creates no
    // session, so the chunk lands nowhere.
    expect(await level, 'a refused audio:start still built a session').toBe(false);
  });
});
