// XC-1-FIX — the relay extracts code= / pcid= from qr_payload with first-match
// regexes (room/registry-pair-resolve.ts). Existing tests only built
// flowmic:// strings; the desktop now also emits
// https://flowmic.app/go/pair?...&v=1 with a percent-encoded endpoint.
// This file runs the real resolve path against that shape.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (QR payload + first-match rule)
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §3

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from '../src/room/registry';
import { planLimits } from '../src/billing/plans';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

type Db = ReturnType<typeof createDbConnection>;
let db: Db;

function registry(mode: 'standalone' | 'saas'): Registry {
  return new Registry({
    pcs: db.pcs,
    mobiles: db.mobiles,
    mode,
    limitsOf: () => planLimits('max'),
  });
}

function newPc(reg: Registry, tag: string) {
  return reg.registerPc({
    device_name: `PC-${tag}`,
    user_id: 'u1',
    client_instance_id: `inst-${tag}`,
  }).pc;
}

beforeEach(() => {
  db = createDbConnection({
    dbPath: ':memory:',
    encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx'),
  });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'max' });
});
afterEach(() => db.close());

describe('https QR payload · real resolve path (XC-1-FIX)', () => {
  it('extracts the 4-digit code and 9-digit PCID from a realistic https payload', () => {
    const reg = registry('saas');
    const pc = newPc(reg, 'https');
    // Desktop `buildHttpsQrPayload` shape: encoded endpoint, fp=, pcid=, trailing v=1.
    // Endpoint digits (192 / 168 / 41 / 87 / 41879) must not steal the first
    // `code=` / `pcid=` match. Encoded `code%3D0000` in the endpoint value is
    // the hostile form — a decoded-then-regex parser would take 0000.
    const https =
      `https://flowmic.app/go/pair?endpoint=ws%3A%2F%2F192.168.41.87%3A41879%2Fcode%3D0000` +
      `&code=${pc.short_code}&channel=saas&fp=aabbccddeeff001122334455` +
      `&pcid=${pc.pcid}&v=1`;
    expect(https.indexOf('code=')).toBeLessThan(https.indexOf('v=1'));
    const resolved = reg.resolvePcForPair({ qr_payload: https });
    expect(resolved.id).toBe(pc.id);
    expect(resolved.short_code).toBe(pc.short_code);
    expect(resolved.pcid).toBe(pc.pcid);
    expect(resolved.short_code).toMatch(/^\d{4}$/);
    expect(resolved.pcid).toMatch(/^\d{9}$/);
  });

  it('the legacy flowmic:// shape still resolves the same PC', () => {
    const reg = registry('saas');
    const pc = newPc(reg, 'legacy');
    const legacy =
      `flowmic://pair?endpoint=ws://192.168.41.87:41879` +
      `&code=${pc.short_code}&channel=saas&fp=aabbccddeeff001122334455` +
      `&pcid=${pc.pcid}`;
    const resolved = reg.resolvePcForPair({ qr_payload: legacy });
    expect(resolved.id).toBe(pc.id);
    expect(resolved.short_code).toBe(pc.short_code);
    expect(resolved.pcid).toBe(pc.pcid);
  });

  it('hostile: endpoint digits do not become the first-match code', () => {
    const reg = registry('standalone');
    const pc = newPc(reg, 'digits');
    // Raw endpoint with 4-digit-looking runs (1921 / 1684 / 4187). The regex
    // is `/code=(\d{4})/` — first match must still be the real code.
    const hostile =
      `https://flowmic.app/go/pair?endpoint=ws://192.168.41.87:41879` +
      `&code=${pc.short_code}&channel=standalone&v=1`;
    const resolved = reg.resolvePcForPair({ qr_payload: hostile });
    expect(resolved.id).toBe(pc.id);
    expect(resolved.short_code).toBe(pc.short_code);
    expect(resolved.short_code).not.toBe('1921');
    expect(resolved.short_code).not.toBe('1684');
    expect(resolved.short_code).not.toBe('4187');
  });
});
