// D11 — pc_devices self-service: measuring what `/devices/revoke` ACTUALLY
// deletes, and proving the new `PcRepo.remove()` is a REAL escape route off
// the PC device ceiling (a free-tier user who reinstalls Windows twice must
// not be permanently stuck at 2/2).
//
// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §1 (pc_devices);
//   docs/decisions/2026-08-02-pc-instance-limit-2-3-10.md (GA-16 ceiling);
//   room/registry.ts `ensurePcSlot`/`realPcs` (the counting logic this file
//   measures against); CLAUDE.md red line: anti-façade / no silent failure
//
// WHY THIS FILE DRIVES `tryHandleConsoleRoutes` DIRECTLY instead of booting a
// server (same argument as test/billing-events-route.test.ts): the deps here
// are real repos off a real connection and a real AuthService, so what is
// proven is THIS route's behaviour, not bootstrap's wiring. `Registry` is
// likewise the real production class (test/device-limits.test.ts's own
// pattern) wired to the SAME `db`, so "can register again" is measured
// through the exact entry point `ensurePcSlot` guards, not a re-implementation
// of the count.
//
// 🔴 THE MEASURED DEFECT (D11 card, report point 3): `POST
// /api/cloud/devices/revoke` (console-routes.ts) calls
// `deps.mobiles.remove(pairingId)` — it operates EXCLUSIVELY on
// `mobile_pairings` and never touches `pc_devices`. The first block below
// proves that in the one way that matters: fill a free account's PC ceiling,
// revoke a mobile pairing hanging off one of those PCs, and show the PC row
// count and the NEXT registration are both unaffected.
//
// The second block proves `PcRepo.remove` (new in D11) is what actually frees
// the slot, end to end, through the SAME production entry point
// (`Registry.registerPc`) the first block's negative result is measured
// against — a fix proven against the identical yardstick as the defect.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService, type AuthService } from '../src/auth/auth-service';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { BillingService } from '../src/billing/billing-service';
import { tryHandleConsoleRoutes, type ConsoleRoutesDeps } from '../src/http/console-routes';
import { unconfiguredPasswordResetMailer } from '../src/mail';
import { Registry } from '../src/room/registry';
import { planLimits } from '../src/billing/plans';
import { ServerError } from '../src/errors';

const SECRET = 'pc-self-service-secret-32-bytes-min-xx';
const NOW = Date.parse('2026-08-04T00:00:00.000Z');

let db: DbConnection;
let auth: AuthService;
let server: Server;
let url: string;
let registry: Registry;

function makeDeps(): ConsoleRoutesDeps {
  auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET, 'utf8'), now: () => NOW });
  return {
    auth,
    billing: new BillingService({
      settings: db.settings,
      users: db.users,
      usage: db.usage,
      billing: db.billing,
      unlockAll: false,
      now: () => NOW,
    }),
    billingLedger: db.billing,
    opsAudit: db.opsAudit,
    pcs: db.pcs,
    mobiles: db.mobiles,
    settings: db.settings,
    users: db.users,
    usage: db.usage,
    passwordLimiter: new RegisterRateLimiter(),
    // VERIFY-1 — this suite's subject is not the verification gate, so its
    // accounts are held verified by a stub reader (the gate itself — refusal,
    // admit, grandfather, real bootstrap wiring — is proven end-to-end in
    // test/email-verification.test.ts against db.emailVerification).
    verifiedEmail: { emailVerifiedAt: () => NOW },
    // MAIL-1 — required by ConsoleRoutesDeps since the password-reset surface got
    // a delivery leg. This suite never drives /api/password/*, so it takes the
    // loudly-failing mailer rather than a fake that would suggest it does: if a
    // case here ever reaches that route, it fails BY NAME instead of quietly
    // passing (src/mail/unconfigured.ts).
    mail: unconfiguredPasswordResetMailer(),
    now: () => NOW,
  };
}

/** Register a real account and mint a real Bearer for it. */
async function account(email: string): Promise<{ id: string; bearer: Record<string, string> }> {
  const user = await auth.register({ email, password: 'longenough1', display_name: 'T' });
  return { id: user.id, bearer: { authorization: `Bearer ${auth.issueToken(user).token}` } };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeEach(async () => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  const deps = makeDeps();
  // Free plan's REAL ceiling (2 PCs), read from the same single source
  // (billing/plans.ts) the production Registry reads — not a hand-picked
  // number that could quietly drift from what GA-16 actually enforces.
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles, mode: 'saas', limitsOf: () => planLimits('free') });
  server = createServer((req, res) => {
    if (tryHandleConsoleRoutes(req, res, deps)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe('🔴 MEASURED — POST /api/cloud/devices/revoke never touches pc_devices', () => {
  it('revoking a mobile pairing on a PC at the ceiling does NOT free the PC slot', async () => {
    const a = await account('ceiling@d11.co');
    const pc1 = registry.registerPc({ device_name: 'PC-1', user_id: a.id, client_instance_id: 'inst-1' }).pc;
    registry.registerPc({ device_name: 'PC-2', user_id: a.id, client_instance_id: 'inst-2' });
    expect(db.pcs.listByUser(a.id)).toHaveLength(2); // free ceiling reached

    // Something REAL to revoke: a mobile paired to pc1.
    const pairing = registry.pairMobile({ short_code: pc1.short_code, pcid: pc1.pcid ?? undefined, mobile_name: 'Phone', user_id: a.id });

    const r = await post('/api/cloud/devices/revoke', { pairing_id: pairing.mobile.id }, a.bearer);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, revoked: true });

    // The mobile pairing is gone (the route DID do its own job)...
    expect(db.mobiles.findById(pairing.mobile.id)).toBeNull();
    // ...but pc1 is COMPLETELY untouched, and the PC count is still 2/2.
    expect(db.pcs.findById(pc1.id)).not.toBeNull();
    expect(db.pcs.listByUser(a.id)).toHaveLength(2);

    // 🔴 THE MEASURED DEFECT: the next PC registration STILL throws. A user
    // who "revoked a device" from the console has NOT gained a PC slot —
    // there is no code path from this route to a freed slot.
    expect(() =>
      registry.registerPc({ device_name: 'PC-3', user_id: a.id, client_instance_id: 'inst-3' }),
    ).toThrow(ServerError);
    expect(db.pcs.listByUser(a.id)).toHaveLength(2); // unchanged by the throw
  });

  it('revoking ALL mobiles on ALL of a full account\'s PCs still leaves it at the ceiling', async () => {
    // The strongest form of the measurement: not "one revoke, unlucky pairing
    // choice", but "revoke everything revocable" — and the PC count does not
    // move by even one, because nothing in this route can ever reach it.
    const a = await account('revoke-all@d11.co');
    const pc1 = registry.registerPc({ device_name: 'PC-1', user_id: a.id, client_instance_id: 'inst-1' }).pc;
    const pc2 = registry.registerPc({ device_name: 'PC-2', user_id: a.id, client_instance_id: 'inst-2' }).pc;
    const m1 = registry.pairMobile({ short_code: pc1.short_code, pcid: pc1.pcid ?? undefined, mobile_name: 'P1', user_id: a.id });
    const m2 = registry.pairMobile({ short_code: pc2.short_code, pcid: pc2.pcid ?? undefined, mobile_name: 'P2', user_id: a.id });

    await post('/api/cloud/devices/revoke', { pairing_id: m1.mobile.id }, a.bearer);
    await post('/api/cloud/devices/revoke', { pairing_id: m2.mobile.id }, a.bearer);

    expect(db.mobiles.findById(m1.mobile.id)).toBeNull();
    expect(db.mobiles.findById(m2.mobile.id)).toBeNull();
    expect(db.pcs.listByUser(a.id)).toHaveLength(2); // still 2/2
    expect(() =>
      registry.registerPc({ device_name: 'PC-3', user_id: a.id, client_instance_id: 'inst-3' }),
    ).toThrow(ServerError);
  });
});

describe('D11 fix — PcRepo.remove() is a REAL escape route off the device ceiling', () => {
  beforeEach(() => {
    db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
    db.users.insert({ id: 'u2', display_name: 'U2', plan: 'free' });
  });

  // ── 🔴 THE END-TO-END CASE THE CARD ASKS FOR ────────────────────────────
  it('limit reached -> user removes ONE device -> can pair (register) again', () => {
    const pc1 = registry.registerPc({ device_name: 'PC-1', user_id: 'u1', client_instance_id: 'inst-1' }).pc;
    registry.registerPc({ device_name: 'PC-2', user_id: 'u1', client_instance_id: 'inst-2' });
    expect(db.pcs.listByUser('u1')).toHaveLength(2);
    expect(() =>
      registry.registerPc({ device_name: 'PC-3', user_id: 'u1', client_instance_id: 'inst-3' }),
    ).toThrow(ServerError);

    // The self-service action itself: the user removes ONE of their own
    // devices (the reinstalled-Windows machine's stale row, in the card's
    // scenario).
    db.pcs.remove(pc1.id);
    expect(db.pcs.listByUser('u1')).toHaveLength(1);

    // The freed slot is IMMEDIATELY usable — `ensurePcSlot` recomputes
    // `realPcs(user_id).length` fresh on every call, so there is no cache to
    // invalidate and no second step required.
    expect(() =>
      registry.registerPc({ device_name: 'PC-3', user_id: 'u1', client_instance_id: 'inst-3' }),
    ).not.toThrow();
    expect(db.pcs.listByUser('u1')).toHaveLength(2);
  });

  it('remove() cascades the removed device\'s mobile_pairings (schema.ts ON DELETE CASCADE)', () => {
    const pc1 = registry.registerPc({ device_name: 'PC-1', user_id: 'u1', client_instance_id: 'inst-1' }).pc;
    const pairing = registry.pairMobile({ short_code: pc1.short_code, pcid: pc1.pcid ?? undefined, mobile_name: 'Phone', user_id: 'u1' });
    expect(db.mobiles.findById(pairing.mobile.id)).not.toBeNull();

    db.pcs.remove(pc1.id);

    expect(db.mobiles.findById(pairing.mobile.id)).toBeNull();
  });

  // ── 🔴 REVERSE CONTROL ────────────────────────────────────────────────────
  it("remove() only removes the row asked for — another user's device survives, and u1's OTHER pc survives too", () => {
    const pc1 = registry.registerPc({ device_name: 'PC-1', user_id: 'u1', client_instance_id: 'inst-1' }).pc;
    const pc2 = registry.registerPc({ device_name: 'PC-2', user_id: 'u1', client_instance_id: 'inst-2' }).pc;
    registry.registerPc({ device_name: 'PC-A', user_id: 'u2', client_instance_id: 'inst-A' });

    db.pcs.remove(pc1.id);

    // The negative half: pc1 is gone.
    expect(db.pcs.findById(pc1.id)).toBeNull();
    // The positive half, in the SAME test: u1's OTHER device and u2's device
    // both survive untouched — a probe that removed everything would pass a
    // lone negative assertion just as easily.
    expect(db.pcs.findById(pc2.id)).not.toBeNull();
    expect(db.pcs.listByUser('u2')).toHaveLength(1);
  });
});
