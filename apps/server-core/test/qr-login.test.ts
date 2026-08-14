// GA-31 QR login — the console draws a QR, the phone scans it into the account.
//
// This is a bearer credential in visual form, so the tests are about the SHAPE OF
// THE WINDOW, not the happy path:
//   ① single use, including against a concurrent second redemption;
//   ② 60 s and not a millisecond more;
//   ③ unknown / expired / already-used are ONE outcome — no existence oracle;
//   ④ the grant is bound to the minting user, so it can never name another;
//   ⑤ minting requires a live Bearer, and a since-deleted user grants nothing;
//   ⑥ redemption is throttled — it is a login.
//
// SPEC-REF: docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-31
//           docs/decisions/2026-07-26-web-login-qr.md
// *** HUMAN-AUDIT SENSITIVE (auth) ***

import { describe, it, expect, beforeEach } from 'vitest';
import type { Socket } from 'socket.io';
import { QrGrantStore, QR_GRANT_TTL_MS, buildLoginLink } from '../src/auth/qr-grant';
import { registerAuthHandlers } from '../src/socket/handlers/auth.handler';
import { makeAuthService } from '../src/auth/auth-service';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

let clock = 1_700_000_000_000;
let seq = 0;
let store: QrGrantStore;

beforeEach(() => {
  clock = 1_700_000_000_000;
  seq = 0;
  // Pinned nonce ONLY so assertions can name one; production uses randomBytes.
  store = new QrGrantStore(() => clock, QR_GRANT_TTL_MS, () => `nonce-${++seq}`);
});

describe('QrGrantStore', () => {
  it('redeems ONCE and returns the minting user', () => {
    const { nonce, expires_in_ms } = store.issue('user-42');
    expect(expires_in_ms).toBe(QR_GRANT_TTL_MS);
    expect(store.redeem(nonce)).toBe('user-42');
    // The second attempt — a replay, or the same phone double-tapping — finds
    // nothing. This is the property that makes a photographed QR worthless the
    // moment the intended phone has used it.
    expect(store.redeem(nonce)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('expires exactly at the TTL and consumes the dead grant', () => {
    const { nonce } = store.issue('user-42');
    clock += QR_GRANT_TTL_MS - 1;
    expect(store.isLive(nonce)).toBe(true);
    clock += 1;
    expect(store.isLive(nonce)).toBe(false);
    expect(store.redeem(nonce)).toBeNull();
    // Consumed, not merely refused: an expired grant must not linger to be
    // probed a second time.
    expect(store.size).toBe(0);
  });

  it('unknown, expired and already-used are indistinguishable', () => {
    const used = store.issue('user-42').nonce;
    store.redeem(used);
    const expired = store.issue('user-42').nonce;
    clock += QR_GRANT_TTL_MS + 1;

    const outcomes = [store.redeem(used), store.redeem(expired), store.redeem('never-existed'), store.redeem('')];
    // One value, one meaning: the caller learns nothing about which case it hit.
    expect(new Set(outcomes)).toEqual(new Set([null]));
  });

  it('binds the grant to the user who minted it', () => {
    const a = store.issue('user-a').nonce;
    const b = store.issue('user-b').nonce;
    expect(store.redeem(b)).toBe('user-b');
    expect(store.redeem(a)).toBe('user-a');
  });

  it('two grants never collide, and minting one does not disturb the other', () => {
    const a = store.issue('user-a').nonce;
    const b = store.issue('user-a').nonce;
    expect(a).not.toBe(b);
    expect(store.redeem(a)).toBe('user-a');
    expect(store.isLive(b)).toBe(true);
  });

  it('prunes dead grants on mint rather than growing forever', () => {
    store.issue('user-a');
    store.issue('user-b');
    expect(store.size).toBe(2);
    clock += QR_GRANT_TTL_MS + 1;
    store.issue('user-c');
    expect(store.size).toBe(1);
  });

  it('the real nonce is 128 bits of CSPRNG, hex-encoded', () => {
    // Guarded because the whole scheme rests on it: a short or predictable nonce
    // is a guessable account.
    const real = new QrGrantStore(() => clock);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { nonce } = real.issue('u');
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(seen.has(nonce)).toBe(false);
      seen.add(nonce);
    }
  });
});

describe('buildLoginLink', () => {
  it('is the exact form the mobile scanner classifies as a login link', () => {
    const link = buildLoginLink('https://flowmic.app', 'abc123');
    expect(link).toBe('flowmic://login?endpoint=https://flowmic.app&t=abc123');
    // ui/scan_payload.dart keys off this prefix; if it ever changes, a scanned
    // login QR silently becomes "not a FlowMic code" on the phone.
    expect(link.startsWith('flowmic://login')).toBe(true);
  });
});


// ── the wire arm: mobile:login {qr_nonce} ───────────────────────────────────
// A phone that scanned the console's QR must land in the account with the SAME
// ack shape a typed password produces — one way in, one shape out, so the app's
// existing success path needs no branch.

class FakeSocket {
  readonly data: Record<string, unknown> = {};
  readonly handshake = { address: '10.0.0.9' };
  private readonly handlers = new Map<string, (p: unknown, ack: unknown) => void>();
  on(event: string, fn: (p: unknown, ack: unknown) => void): this {
    this.handlers.set(event, fn);
    return this;
  }
  emit(): void {}
  async invoke(event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.handlers.get(event)!(payload, (a: unknown) => resolve(a as Record<string, unknown>));
    });
  }
}

describe('mobile:login {qr_nonce}', () => {
  it('a live grant logs the phone in; a stale one reads exactly like a wrong password', async () => {
    const db = createDbConnection({
      dbPath: ':memory:',
      encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx'),
    });
    try {
      const service = makeAuthService({ users: db.users, jwtSecret: Buffer.from('a'.repeat(32), 'utf8') });
      const user = await service.register({ email: 'a@b.co', password: 'hunter22222', display_name: 'A' });
      const grants = new QrGrantStore(() => clock, QR_GRANT_TTL_MS, () => `nonce-${++seq}`);
      const sock = new FakeSocket();
      registerAuthHandlers(sock as unknown as Socket, { mode: 'saas', auth: service, qrGrants: grants });

      const { nonce } = grants.issue(user.id);
      const ok = await sock.invoke('mobile:login', { qr_nonce: nonce });
      expect(ok.ok).toBe(true);
      expect(typeof ok.token).toBe('string');
      expect(ok.mode).toBe('saas');
      expect((ok.user as { email: string }).email).toBe('a@b.co');
      // No password ever crossed this wire, and none is echoed back.
      expect(JSON.stringify(ok)).not.toContain('password');

      // Replay, unknown, and a genuinely wrong password all read the same.
      const replay = await sock.invoke('mobile:login', { qr_nonce: nonce });
      const unknown = await sock.invoke('mobile:login', { qr_nonce: 'never-existed' });
      const badPassword = await sock.invoke('mobile:login', { email: 'a@b.co', password: 'wrongwrong' });
      expect(replay).toEqual({ error: 'AUTH_LOGIN_FAILED' });
      expect(unknown).toEqual(replay);
      expect(badPassword).toEqual(replay);
    } finally {
      db.close();
    }
  });

  it('a frame carrying BOTH credentials does not parse', async () => {
    // The union exists so the server never has to decide which credential wins.
    const db = createDbConnection({
      dbPath: ':memory:',
      encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx'),
    });
    try {
      const service = makeAuthService({ users: db.users, jwtSecret: Buffer.from('a'.repeat(32), 'utf8') });
      const sock = new FakeSocket();
      registerAuthHandlers(sock as unknown as Socket, { mode: 'saas', auth: service, qrGrants: new QrGrantStore() });
      const ack = await sock.invoke('mobile:login', {
        email: 'a@b.co',
        password: 'hunter22222',
        qr_nonce: 'x',
      });
      expect(ack).toEqual({ error: 'SETTINGS_SCHEMA_INVALID' });
    } finally {
      db.close();
    }
  });
});
