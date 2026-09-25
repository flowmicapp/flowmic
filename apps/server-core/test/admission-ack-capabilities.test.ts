// Card RC-C (2026-09-24) — EVERY way a phone is admitted to a room carries the
// recovery capability bits on its ack. Exhaustive by construction, not by list.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §1 (defect C), §7 RC-C
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (c) (the capabilities array)
//   src/socket/handlers/mobile-ack-fields.ts (RECOVERY_CAPABILITY_ACK)
//   src/socket/handlers/mobile.handler.ts `mobile:pair` (three arms)
//   src/socket/handlers/mobile-reconnect.ts (the reconnect ack)
//
// 🔴 WHY A TABLE AND TWO GUARDS, not one more `it`. PR-1 (2026-09-06) put the
// bits on the code-pair arm and on reconnect and its test covered exactly those
// two; the cloud-instance arm was the third member of a three-arm union and
// nothing enumerated the union, so it shipped without the bits for eighteen days
// and every freshly signed-in light record held its recovery audio as 「server
// too old」. The guards below make the NEXT arm fail here the day it is added:
//   ① the `mobile:pair` rows must be exactly the arms of `MobilePairSchema`
//      (read off the zod union, keyed by the required field only that arm has);
//   ② every `mobile:*` event in `EVENT_SCHEMAS` is classified as an admission
//      (and then has a row) or as not one, with the reason written down.
//
// 🔴 OVER A REAL SOCKET for the reason recovery-capability-ack.test.ts gives:
// the question is what the phone receives, not what a constant holds.
//
// Grep inventory of admissions (2026-09-24, `setAuth(… kind: 'mobile'`,
// `safeAck(ack, {` in socket/handlers, `mobile_token` producers in src/):
//   · mobile:pair {short_code}     — mobile.handler.ts, the code-pair ack   → row
//   · mobile:pair {qr_payload}     — same ack site, after resolvePcForPair  → row
//   · mobile:pair {cloud_instance} — mobile.handler.ts, cloud arm           → row (the one RC-C fixes)
//   · mobile:reconnect             — mobile-reconnect.ts, one success ack   → rows (LAN pairing, cloud pairing)
//   · handshake token auth         — auth/middleware.ts `resolveLocally` sets
//     the AuthContext with NO ack; the phone still sends mobile:reconnect,
//     which is the admission that answers it                                → no row
//   · replica read-through reconnect (`resolveTokenOnWriter`) — lands on the
//     SAME success ack as a local hit                                        → covered by the reconnect rows
//   · web / integrator rooms are TARGETS (ensureWebRoom, HTTP); a phone joins
//     one through the qr_payload arm                                        → covered by the qr row

import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { EVENT_SCHEMAS, MobilePairSchema, SERVER_RECOVERY_CAPABILITIES } from '@flowmic/protocol';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

const SECRET = 'admission-ack-capabilities-secret-32b';

let server: BootstrapHandle | null = null;
const sockets: ClientSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  if (server) await server.close();
  server = null;
});

type Mode = 'standalone' | 'saas';
async function boot(mode: Mode): Promise<string> {
  // saas: mockBilling off and no proxy in front — the posture
  // saas-cloud-admission.test.ts states for itself.
  server = await startServer(loadConfig(mode === 'saas'
    ? { mode, secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [] }
    : { mode, secret: SECRET, port: 0, dbPath: ':memory:' }));
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
type Ack = Record<string, unknown> & { capabilities?: string[]; mobile_token?: string; error?: string };
function ack(s: ClientSocket, event: string, payload: unknown): Promise<Ack> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), 5000);
    s.emit(event, payload, (r: Ack) => { clearTimeout(t); resolve(r); });
  });
}
async function account(url: string, email: string): Promise<string> {
  const res = await fetch(`${url}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'longenough1' }),
  });
  return (await res.json() as { token: string }).token;
}
/** A registered PC: standalone needs nothing, saas needs an account and returns a PCID. */
async function pc(url: string, mode: Mode): Promise<{ short_code: string; pcid?: string }> {
  const s = await connect(url, mode === 'saas' ? { jwt: await account(url, 'pc-owner@b.co') } : {});
  const reg = await ack(s, 'pc:register', { device_name: 'Admission PC', client_instance_id: 'inst-admission0123' });
  expect(reg.error, `pc:register: ${JSON.stringify(reg)}`).toBeUndefined();
  return { short_code: reg.short_code as string, ...(typeof reg.pcid === 'string' ? { pcid: reg.pcid } : {}) };
}
async function mustAdmit(r: Ack, what: string): Promise<Ack> {
  expect(r.error, `${what}: ${JSON.stringify(r)}`).toBeUndefined();
  expect(typeof r.mobile_token === 'string' || typeof r.pairing_id === 'string', `${what} admitted`).toBe(true);
  return r;
}
async function reconnectWith(url: string, token: string): Promise<Ack> {
  const s = await connect(url, { auth: token, token });
  return ack(s, 'mobile:reconnect', { token });
}

interface Admission {
  /** `mobile:pair/<arm>` for a pair arm, else the event name plus a qualifier. */
  name: string;
  mode: Mode;
  admit(url: string): Promise<Ack>;
}

const ADMISSIONS: readonly Admission[] = [
  {
    name: 'mobile:pair/short_code', mode: 'standalone',
    async admit(url) {
      const { short_code } = await pc(url, 'standalone');
      return mustAdmit(await ack(await connect(url), 'mobile:pair', { short_code, mobile_name: 'Pixel-adm1' }), this.name);
    },
  },
  {
    // saas is production, and there the code arm also carries the PCID (0.2.66).
    name: 'mobile:pair/short_code', mode: 'saas',
    async admit(url) {
      const { short_code, pcid } = await pc(url, 'saas');
      expect(pcid, 'precondition: a saas PC has a PCID').toMatch(/^\d{9}$/);
      return mustAdmit(await ack(await connect(url), 'mobile:pair', { short_code, pcid, mobile_name: 'Pixel-adm2' }), this.name);
    },
  },
  {
    name: 'mobile:pair/qr_payload', mode: 'standalone',
    async admit(url) {
      const { short_code } = await pc(url, 'standalone');
      const qr_payload = `flowmic://pair?host=10.0.0.5&port=41879&code=${short_code}`;
      return mustAdmit(await ack(await connect(url), 'mobile:pair', { qr_payload, mobile_name: 'Pixel-adm3' }), this.name);
    },
  },
  {
    name: 'mobile:pair/cloud_instance', mode: 'saas',
    async admit(url) {
      const phone = await connect(url, { jwt: await account(url, 'cloud-adm@b.co') });
      const r = await mustAdmit(await ack(phone, 'mobile:pair', { cloud_instance: true, mobile_name: 'Pixel-adm4' }), this.name);
      expect(r.pc_instance_id, 'precondition: the cloud arm answered').toBe('flowmic-cloud-instance');
      return r;
    },
  },
  {
    name: 'mobile:reconnect/lan-pairing', mode: 'standalone',
    async admit(url) {
      const { short_code } = await pc(url, 'standalone');
      const first = await mustAdmit(await ack(await connect(url), 'mobile:pair', { short_code, mobile_name: 'Pixel-adm5' }), 'pair');
      return mustAdmit(await reconnectWith(url, first.mobile_token as string), this.name);
    },
  },
  {
    // The path a light record takes on every connection AFTER its first
    // admission (connections_controller.dart `enterCloud` → saved session).
    name: 'mobile:reconnect/cloud-pairing', mode: 'saas',
    async admit(url) {
      const phone = await connect(url, { jwt: await account(url, 'cloud-back@b.co') });
      const first = await mustAdmit(await ack(phone, 'mobile:pair', { cloud_instance: true, mobile_name: 'Pixel-adm6' }), 'pair');
      phone.disconnect();
      return mustAdmit(await reconnectWith(url, first.mobile_token as string), this.name);
    },
  },
];

/** `mobile:*` events that do NOT admit a phone to a room, and why. */
const NOT_ADMISSIONS: Readonly<Record<string, string>> = {
  'mobile:unpair': 'tears a pairing down; its ack is {ok} or an error',
  'mobile:list-pcs': 'a read; no relay socket handler admits on it',
  'mobile:login': 'account sign-in (JWT); joins no room — the cloud arm of mobile:pair is the admission',
  'mobile:logout': 'account sign-out; joins no room',
  'mobile:released': 'server → phone push, not a request',
};

/** The required field only this arm has — `short_code` / `qr_payload` / `cloud_instance` today. */
function pairArms(): string[] {
  const shapes = MobilePairSchema.options.map((o) => o.shape as Record<string, { isOptional(): boolean }>);
  return shapes.map((shape, i) => {
    const own = Object.keys(shape).filter((k) => !shape[k]!.isOptional()
      && shapes.every((other, j) => j === i || !(k in other)));
    expect(own, `arm ${i} of MobilePairSchema has exactly one discriminating required field`).toHaveLength(1);
    return own[0]!;
  });
}

describe('card RC-C — every admission ack carries the recovery capability bits', () => {
  it('the table covers every arm of mobile:pair (a new arm without a row is red here)', () => {
    const rows = new Set(ADMISSIONS.filter((a) => a.name.startsWith('mobile:pair/')).map((a) => a.name.slice('mobile:pair/'.length)));
    expect([...rows].sort()).toEqual(pairArms().sort());
  });

  it('every mobile:* event is classified, and every admission event has a row', () => {
    const mobileEvents = Object.keys(EVENT_SCHEMAS).filter((k) => k.startsWith('mobile:'));
    const admissionEvents = new Set(ADMISSIONS.map((a) => a.name.split('/')[0]!));
    const unclassified = mobileEvents.filter((e) => !admissionEvents.has(e) && !(e in NOT_ADMISSIONS));
    expect(unclassified, 'classify it: an admission gets a row in ADMISSIONS, anything else a reason in NOT_ADMISSIONS').toEqual([]);
    expect([...admissionEvents].filter((e) => e in NOT_ADMISSIONS), 'an event cannot be both').toEqual([]);
    expect([...admissionEvents].sort()).toEqual(['mobile:pair', 'mobile:reconnect']);
  });

  for (const a of ADMISSIONS) {
    it(`${a.name} (${a.mode})`, async () => {
      const url = await boot(a.mode);
      const r = await a.admit(url);
      expect(r.capabilities, `${a.name} ack carries capabilities[]`).toEqual([...SERVER_RECOVERY_CAPABILITIES]);
    });
  }
});
