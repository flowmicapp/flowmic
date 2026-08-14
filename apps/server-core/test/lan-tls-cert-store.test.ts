// D2LAN-B1 — persistence. The single requirement this file exists for:
//
// 🔴 THE FINGERPRINT MUST SURVIVE A RESTART. It is printed into a QR and pinned
// by a phone. A key regenerated on boot would silently invalidate every QR ever
// scanned, and the phone's CORRECT response to that (refuse to connect) is
// indistinguishable from a broken network — a defect that would be reported as
// "phone cannot connect to the PC" and investigated everywhere except here.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CERT_FILENAME, KEY_FILENAME, loadOrMintLanTlsIdentity } from '../src/lan-tls/cert-store';
import { mintLanTlsIdentity, readPrivateKeyPem } from '../src/lan-tls/x509';

const dirs: string[] = [];
function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'flowmic-lan-tls-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('loadOrMintLanTlsIdentity', () => {
  it('mints on first boot and reports origin:minted', () => {
    const home = tempHome();
    const first = loadOrMintLanTlsIdentity(home);
    expect(first.origin).toBe('minted');
    expect(statSync(join(home, KEY_FILENAME)).isFile()).toBe(true);
    expect(statSync(join(home, CERT_FILENAME)).isFile()).toBe(true);
  });

  it('🔴 returns the SAME fingerprint on every subsequent boot', () => {
    const home = tempHome();
    const first = loadOrMintLanTlsIdentity(home);
    const second = loadOrMintLanTlsIdentity(home);
    const third = loadOrMintLanTlsIdentity(home);
    expect(second.origin).toBe('loaded');
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(third.fingerprint).toBe(first.fingerprint);
    // Same bytes too, not merely the same hash of them.
    expect(second.certPem).toBe(first.certPem);
    expect(second.keyPem).toBe(first.keyPem);
  });

  it('two different homes are two different machines', () => {
    expect(loadOrMintLanTlsIdentity(tempHome()).fingerprint)
      .not.toBe(loadOrMintLanTlsIdentity(tempHome()).fingerprint);
  });

  it('renews an EXPIRED certificate over the same key — fingerprint unmoved', () => {
    // The payoff of pinning the key (design §3-3). A phone that scanned a QR in
    // 2026 still trusts this server after the certificate is replaced.
    const home = tempHome();
    const first = loadOrMintLanTlsIdentity(home, new Date('2026-08-08T00:00:00Z'));
    const later = loadOrMintLanTlsIdentity(home, new Date('2040-01-01T00:00:00Z'));
    expect(later.origin).toBe('renewed');
    expect(later.fingerprint).toBe(first.fingerprint);
    expect(later.certPem).not.toBe(first.certPem);
    expect(later.keyPem).toBe(first.keyPem);
  });

  it('renews BEFORE expiry, not after it', () => {
    // A machine that is rarely restarted must not be able to cross the expiry
    // between two boots. 10-year lifetime, 30-day renewal window: a boot inside
    // that window renews rather than serving a certificate about to die.
    const home = tempHome();
    const first = loadOrMintLanTlsIdentity(home, new Date('2026-08-08T00:00:00Z'));
    const validTo = Date.parse(new X509Certificate(first.certPem).validTo);
    const justInsideWindow = new Date(validTo - 10 * 24 * 60 * 60 * 1000);
    expect(loadOrMintLanTlsIdentity(home, justInsideWindow).origin).toBe('renewed');
  });

  it('re-mints the certificate when it is missing but the key is not', () => {
    const home = tempHome();
    const first = loadOrMintLanTlsIdentity(home);
    rmSync(join(home, CERT_FILENAME));
    const after = loadOrMintLanTlsIdentity(home);
    expect(after.origin).toBe('renewed');
    expect(after.fingerprint).toBe(first.fingerprint);
  });

  it('re-mints the certificate when it does not belong to the stored key', () => {
    // A half-finished write, a restored backup, two installs racing. Serving a
    // mismatched pair fails at handshake time with an error nothing here explains.
    const home = tempHome();
    const first = loadOrMintLanTlsIdentity(home);
    writeFileSync(join(home, CERT_FILENAME), mintLanTlsIdentity().certPem, 'utf8'); // someone else's cert
    const after = loadOrMintLanTlsIdentity(home);
    expect(after.origin).toBe('renewed');
    expect(after.fingerprint).toBe(first.fingerprint); // the KEY still decides
    // …and the replacement really is a pair, which is the whole point of redoing it.
    expect(new X509Certificate(after.certPem).checkPrivateKey(readPrivateKeyPem(after.keyPem))).toBe(true);
  });

  it('mints a NEW identity when the stored key is corrupt, and says so', () => {
    // Corruption is not a reason to refuse to serve — but the fingerprint changes,
    // every existing pin becomes invalid, and `origin:'minted'` in the boot log is
    // the only trace anyone will have when a phone suddenly refuses to connect.
    const home = tempHome();
    const first = loadOrMintLanTlsIdentity(home);
    writeFileSync(join(home, KEY_FILENAME), 'not a pem at all', 'utf8');
    const after = loadOrMintLanTlsIdentity(home);
    expect(after.origin).toBe('minted');
    expect(after.fingerprint).not.toBe(first.fingerprint);
  });

  it('creates the home directory if it does not exist yet', () => {
    const nested = join(tempHome(), 'deep', 'er');
    expect(loadOrMintLanTlsIdentity(nested).origin).toBe('minted');
  });

  it('writes the key with an owner-only mode where the platform honours it', () => {
    const home = tempHome();
    loadOrMintLanTlsIdentity(home);
    const mode = statSync(join(home, KEY_FILENAME)).mode & 0o777;
    if (process.platform === 'win32') {
      // Windows does not implement POSIX modes; the file's protection there is
      // the per-user FLOWMIC_HOME it lives in, exactly as for standalone.secret
      // (src/identity.ts). Asserting 0600 here would be asserting a fiction.
      expect(mode).toBeGreaterThan(0);
    } else {
      expect(mode).toBe(0o600);
    }
  });

  it('the key file is a private key and the cert file is not', () => {
    // Cheap, but it is the assertion that catches the worst possible slip on this
    // path: writing the two files the other way round would publish the key to
    // every peer that handshakes.
    const home = tempHome();
    loadOrMintLanTlsIdentity(home);
    expect(readFileSync(join(home, KEY_FILENAME), 'utf8')).toContain('BEGIN PRIVATE KEY');
    expect(readFileSync(join(home, CERT_FILENAME), 'utf8')).toContain('BEGIN CERTIFICATE');
    expect(readFileSync(join(home, CERT_FILENAME), 'utf8')).not.toContain('PRIVATE KEY');
  });
});
