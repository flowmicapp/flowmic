// Card PR-1 — the recovery capability bits on the pair / reconnect acks.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (c) (the SSOT)
//           packages/protocol/src/recovery-protocol.ts (the bit names)
//           src/socket/handlers/mobile.handler.ts (RECOVERY_CAPABILITY_ACK)
//
// 🔴 OVER A REAL SOCKET, for the reason mobile-name-wire.test.ts states in its
// own header: the question is "does the phone actually receive this", and a unit
// test on the constant answers a different one. The advertisement is the whole
// deliverable — a bit that never leaves the process protects nobody, and a bit
// that leaves without an implementation behind it is worse than silence.

import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import {
  CAPABILITY_RECOVERY_COVERAGE_RECEIPT,
  CAPABILITY_RECOVERY_DELIVERY_NONE_SAFE,
  CAPABILITY_RECOVERY_IDEMPOTENT_OPERATION,
} from '@flowmic/protocol';
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
    loadConfig({ mode: 'standalone', secret: 'recovery-capability-secret-32-byt', port: 0, dbPath: ':memory:' }),
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
    s.emit(event, payload, (r: T) => { clearTimeout(t); resolve(r); });
  });
}
async function pcWithCode(url: string): Promise<{ pc: ClientSocket; code: string }> {
  const pc = await connect(url);
  const reg = await ack<{ short_code: string }>(pc, 'pc:register', {
    device_name: 'Capability PC',
    client_instance_id: 'inst-capability01234',
  });
  return { pc, code: reg.short_code };
}

type CapAck = { capabilities?: string[]; pairing_id: string; mobile_token?: string };

describe('recovery capability bits reach the phone', () => {
  it('the mobile:pair ack advertises all three implemented bits', async () => {
    const url = await standalone();
    const { code } = await pcWithCode(url);
    const phone = await connect(url);
    const paired = await ack<CapAck>(phone, 'mobile:pair', { short_code: code, mobile_name: 'Pixel-cap1' });

    expect(paired.capabilities).toEqual([
      CAPABILITY_RECOVERY_COVERAGE_RECEIPT,
      CAPABILITY_RECOVERY_DELIVERY_NONE_SAFE,
      CAPABILITY_RECOVERY_IDEMPOTENT_OPERATION,
    ]);
  });

  it('the mobile:reconnect ack advertises them too — a phone that comes back must not read as older', async () => {
    // The asymmetry this pins was a real defect once already, one card over: the
    // pair leg got node fields and the reconnect leg did not. A phone spends
    // almost all of its life on the reconnect leg, so a capability that only
    // rides the pair ack is one the phone forgets on every restart.
    const url = await standalone();
    const { code } = await pcWithCode(url);
    const phone = await connect(url);
    const paired = await ack<CapAck>(phone, 'mobile:pair', { short_code: code, mobile_name: 'Pixel-cap2' });
    phone.disconnect();

    const again = await connect(url);
    const back = await ack<CapAck>(again, 'mobile:reconnect', { token: paired.mobile_token });
    expect(back.capabilities).toEqual([
      CAPABILITY_RECOVERY_COVERAGE_RECEIPT,
      CAPABILITY_RECOVERY_DELIVERY_NONE_SAFE,
      CAPABILITY_RECOVERY_IDEMPOTENT_OPERATION,
    ]);
  });

  it('🔴 advertises the idempotency bit, now that the server honours it', async () => {
    // The one assertion here that guards a PROMISE, and it flipped on 2026-09-06
    // when card PR-2 landed. The phone reads a missing bit fail-closed (hold the
    // audio, say so); it reads a present one as permission. Until the registry,
    // the metering ledger and the replica's deterministic key existed, this
    // asserted ABSENCE — advertising early would have converted a safe hold into
    // a silent, unprotected success.
    //
    // ⚠️ WHAT THIS TEST DOES NOT PROVE, said out loud because an ack assertion
    // reads like more than it is: that the promise is KEPT. It proves the server
    // says the words. The behaviour behind them is
    // test/operation-idempotency.test.ts, and the two must be read together —
    // this one alone would stay green against a server that advertised and did
    // nothing, which is precisely the failure it used to be written to prevent.
    const url = await standalone();
    const { code } = await pcWithCode(url);
    const phone = await connect(url);
    const paired = await ack<CapAck>(phone, 'mobile:pair', { short_code: code, mobile_name: 'Pixel-cap3' });
    expect(paired.capabilities).toContain(CAPABILITY_RECOVERY_IDEMPOTENT_OPERATION);
  });
});
