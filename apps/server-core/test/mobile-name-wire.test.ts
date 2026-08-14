// owner 2026-07-27: "take the phone model plus a unique code as the name, so the
// name itself tells which phone it is".
//
// THIS FILE EXISTS BECAUSE OF HOW THE BUG SURVIVED. registry.pairMobile has
// always preferred a caller-supplied `mobile_name`, and device-limits.test.ts
// has always proven it does — by calling the registry DIRECTLY. Meanwhile the
// socket handler only ever passed `{short_code}` / `{qr_payload}`, so on the
// wire the branch was dead and every phone paired as an interchangeable
// `Phone-<4>`. A unit test on a capability nobody reaches is the anti-façade
// lesson CLAUDE.md calls this project's #1 historical bug.
//
// So these assertions go through a REAL socket, which is the only place the
// question 「does a phone's name actually arrive?」 can be answered.

import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
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
    loadConfig({ mode: 'standalone', secret: 'mobile-name-wire-secret-32-bytes', port: 0, dbPath: ':memory:' }),
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
async function pcWithCode(url: string): Promise<{ pc: ClientSocket; code: string }> {
  const pc = await connect(url);
  const reg = await ack<{ short_code: string }>(pc, 'pc:register', {
    device_name: 'Name PC',
    client_instance_id: 'inst-namewire01234567',
  });
  return { pc, code: reg.short_code };
}

describe('mobile:pair carries the phone\'s own name (over the wire)', () => {
  it('the supplied name is what the PC is told and what is stored', async () => {
    const url = await standalone();
    const { pc, code } = await pcWithCode(url);
    const joined = new Promise<{ mobile_name: string }>((resolve, reject) => {
      pc.once('pc:mobile-joined', resolve);
      setTimeout(() => reject(new Error('pc:mobile-joined timeout')), 5000);
    });

    const mobile = await connect(url);
    const pair = await ack<{ pairing_id: string }>(mobile, 'mobile:pair', {
      short_code: code,
      mobile_name: 'Google Pixel 8-3f2a',
    });

    // ① the PC's live notification carries it…
    expect((await joined).mobile_name).toBe('Google Pixel 8-3f2a');
    // ② …and so does the row, which is what every device list reads.
    expect(server!.db.mobiles.findById(pair.pairing_id)!.mobile_name).toBe('Google Pixel 8-3f2a');
  });

  it('two handsets stay distinguishable — the whole point', async () => {
    const url = await standalone();
    const { code } = await pcWithCode(url);
    const a = await ack<{ pairing_id: string }>(await connect(url), 'mobile:pair', {
      short_code: code, mobile_name: 'Google Pixel 8-3f2a',
    });
    const b = await ack<{ pairing_id: string }>(await connect(url), 'mobile:pair', {
      short_code: code, mobile_name: 'Lenovo TB335ZC-91c4',
    });
    const names = [a.pairing_id, b.pairing_id].map((id) => server!.db.mobiles.findById(id)!.mobile_name);
    expect(names).toEqual(['Google Pixel 8-3f2a', 'Lenovo TB335ZC-91c4']);
  });

  it('an UNNAMED phone still pairs and still gets the server fallback', async () => {
    // Backward compatibility is the reason the field is optional: an older APK
    // sends nothing and must behave exactly as it did before this change.
    const url = await standalone();
    const { code } = await pcWithCode(url);
    const pair = await ack<{ pairing_id: string }>(await connect(url), 'mobile:pair', { short_code: code });
    expect(server!.db.mobiles.findById(pair.pairing_id)!.mobile_name).toMatch(/^Phone-[0-9a-f]{4}$/);
  });

  it('a blank or over-long name is REFUSED at the boundary, not silently trimmed', async () => {
    const url = await standalone();
    const { code } = await pcWithCode(url);
    for (const bad of ['', 'M'.repeat(49)]) {
      const r = await ack<Record<string, string>>(await connect(url), 'mobile:pair', {
        short_code: code, mobile_name: bad,
      });
      // The zod boundary rejects the frame outright; a truncated name would be
      // the server quietly inventing something the phone did not say.
      expect(r.error, JSON.stringify(bad).slice(0, 20)).toBeTruthy();
    }
  });
});
