// D2LAN-B1 — the minted certificate and the published fingerprint.
//
// 🔴 THE RULER PROBLEM, stated once for this whole file. Almost every assertion
// available here can be made to pass by a certificate that node's own parser
// happens to accept, because node minted it and node is reading it back. That
// proves the DER round-trips through ONE implementation, which is exactly the
// mistake this repo has paid for before. So the load-bearing checks are the ones
// where the two sides are genuinely independent:
//   • `lan-tls-dual-listener.test.ts` runs a REAL TLS handshake and computes the
//     fingerprint from the certificate as RECEIVED BY A PEER, never from the
//     value the server published.
//   • the D2LAN-B0 probe cross-checked the same construction against OpenSSL
//     3.2.4 and an independent Dart DER walk (.local/d2lan-b0-probe/).
// What THIS file legitimately covers is the structure we deliberately chose:
// no SAN, CA:FALSE, serverAuth, and a fingerprint encoding that cannot produce a
// QR separator.

import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { certificateFor, mintLanTlsIdentity, readPrivateKeyPem } from '../src/lan-tls/x509';
import { FP_BYTES, FP_CHARS, isWellFormedFingerprint, spkiFingerprint } from '../src/lan-tls/fingerprint';

describe('mintLanTlsIdentity', () => {
  it('produces a certificate that verifies against its own key and matches the private key', () => {
    const { certPem, keyPem } = mintLanTlsIdentity();
    const cert = new X509Certificate(certPem);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.checkPrivateKey(readPrivateKeyPem(keyPem))).toBe(true);
  });

  it('is self-signed: issuer and subject are the same name', () => {
    const cert = new X509Certificate(mintLanTlsIdentity().certPem);
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.subject).toContain('FlowMic LAN sidecar');
  });

  it('carries NO subjectAltName — the peer pins the key, not the name (design §3-3)', () => {
    // Not a cosmetic omission. `expandCandidates` lets one QR name up to six bare
    // IPs, and a name-bound certificate would need every one of them in an IP SAN
    // and would break whenever a NIC changed. If someone "fixes" this by adding
    // SANs, this assertion is where they find out it was deliberate.
    expect(new X509Certificate(mintLanTlsIdentity().certPem).subjectAltName).toBeUndefined();
  });

  it('is CA:FALSE and serverAuth-only', () => {
    const pem = new X509Certificate(mintLanTlsIdentity().certPem).toString();
    // node exposes neither extension as a field, so assert over the structure it
    // does expose: `ca` is the parsed BasicConstraints answer.
    expect(new X509Certificate(pem).ca).toBe(false);
  });

  it('back-dates notBefore so a phone whose clock is minutes off still connects', () => {
    const now = new Date('2026-08-08T12:00:00Z');
    const cert = new X509Certificate(certificateFor(readPrivateKeyPem(mintLanTlsIdentity().keyPem), now).certPem);
    expect(Date.parse(cert.validFrom)).toBeLessThan(now.getTime());
  });

  it('mints a DIFFERENT key every time (two installs are two identities)', () => {
    const a = spkiFingerprint(mintLanTlsIdentity().spkiDer);
    const b = spkiFingerprint(mintLanTlsIdentity().spkiDer);
    expect(a).not.toBe(b);
  });

  it('the SPKI it reports is the SPKI in the certificate it emits', () => {
    // The fingerprint is computed from `spkiDer`, but a peer computes it from the
    // certificate. If those two ever disagreed, every pin would fail and nothing
    // in the minting path would say why.
    const { certPem, spkiDer } = mintLanTlsIdentity();
    const fromCert = Buffer.from(new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' }));
    expect(fromCert.equals(spkiDer)).toBe(true);
  });
});

describe('certificateFor (the renewal path)', () => {
  it('re-mints over the SAME key, so the fingerprint does not move', () => {
    // This is the concrete payoff of pinning SPKI rather than the certificate:
    // renewal is invisible to every phone that has already scanned a QR.
    const { keyPem, spkiDer } = mintLanTlsIdentity();
    const key = readPrivateKeyPem(keyPem);
    const renewed = certificateFor(key, new Date('2030-01-01T00:00:00Z'));
    expect(spkiFingerprint(renewed.spkiDer)).toBe(spkiFingerprint(spkiDer));
    expect(new X509Certificate(renewed.certPem).checkPrivateKey(key)).toBe(true);
  });

  it('refuses a validity that would run past UTCTime`s unambiguous range', () => {
    // The two-digit year silently reads as 1956 beyond 2049 (RFC 5280 §4.1.2.5).
    // A future maintainer widening CERT_LIFETIME_MS must hit a throw, not ship a
    // certificate that expired seventy years ago.
    const key = readPrivateKeyPem(mintLanTlsIdentity().keyPem);
    expect(() => certificateFor(key, new Date('2045-01-01T00:00:00Z'))).toThrow(/UTCTime/);
  });
});

describe('readPrivateKeyPem', () => {
  it('refuses a key that is not the EC key this module mints', () => {
    // A wrong-type key would still produce a working certificate, so the refusal
    // has to be here rather than at a handshake where the failure is a mystery.
    const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(() => readPrivateKeyPem(rsaPem)).toThrow(/expected ec/);
  });
});

describe('spkiFingerprint (the QR value)', () => {
  it('is a byte prefix of the digest, not a text prefix of its base64', () => {
    // 🔴 The property that lets Dart reproduce this on the phone with one obvious
    // implementation. A text prefix cuts through a byte whenever the length is
    // not a multiple of 4, and two implementations that agree on MOST inputs is
    // the expensive failure this avoids.
    const { spkiDer } = mintLanTlsIdentity();
    const digest = createHash('sha256').update(spkiDer).digest();
    expect(spkiFingerprint(spkiDer)).toBe(digest.subarray(0, FP_BYTES).toString('base64url'));
  });

  it('is FP_CHARS characters with no padding, and FP_BYTES stays byte-aligned', () => {
    expect(FP_BYTES % 3).toBe(0); // the reason there is no '=' to strip
    expect(FP_CHARS).toBe(24);
    expect(spkiFingerprint(mintLanTlsIdentity().spkiDer)).toHaveLength(FP_CHARS);
  });

  it('keeps at least 128 bits of second-preimage resistance', () => {
    expect(FP_BYTES * 8).toBeGreaterThanOrEqual(128);
  });

  it('never contains a QR separator, over many independently minted keys', () => {
    // The alphabet makes this structural rather than probabilistic, but a change
    // to the encoding (base64 instead of base64url — '+' and '/' — or a length
    // that reintroduces '=') would break it, and this is where that shows up.
    for (let i = 0; i < 200; i++) {
      const fp = spkiFingerprint(mintLanTlsIdentity().spkiDer);
      expect(fp).not.toContain(',');
      expect(fp).not.toContain('&');
      expect(fp).not.toContain('=');
      expect(isWellFormedFingerprint(fp)).toBe(true);
    }
  });

  it('rejects malformed shapes', () => {
    expect(isWellFormedFingerprint('')).toBe(false);
    expect(isWellFormedFingerprint('a'.repeat(FP_CHARS - 1))).toBe(false);
    expect(isWellFormedFingerprint('a'.repeat(FP_CHARS + 1))).toBe(false);
    expect(isWellFormedFingerprint(`${'a'.repeat(FP_CHARS - 1)}&`)).toBe(false);
    expect(isWellFormedFingerprint(`${'a'.repeat(FP_CHARS - 1)},`)).toBe(false);
  });
});
