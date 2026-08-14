// SPEC-REF:
//   docs/strategy/2026-08-08-design-d2lan-light-encryption.md §3-3, §4-1
//   apps/server-core/src/identity.ts (the mint-once-and-persist precedent this
//     follows: symbol `resolveStandaloneSecret`)
//
// Where the LAN TLS key lives, and why it must be the SAME key next boot.
//
// 🔴 THE STABILITY REQUIREMENT IS THE WHOLE POINT. The fingerprint is printed
// into a pairing QR and then pinned by a phone for as long as that pairing lasts.
// A key regenerated on restart would silently invalidate every QR ever scanned —
// and the phone's correct behaviour in that situation (refuse to connect) would
// look exactly like a broken network. So the key is minted once and persisted,
// beside `standalone.secret` and the database, sharing their directory AND their
// lifecycle: `FLOWMIC_HOME` (apps/desktop/src-tauri/src/sidecar/io.rs passes it
// when it spawns us — symbol `spawn_sidecar`). Wiping that directory resets the
// machine's whole local identity at once, which is the honest granularity; the
// alternative, a key that outlives the database it belongs to, is worse.
//
// The CERTIFICATE by contrast is disposable: it is re-minted from the stored key
// whenever it is missing or expired, and because the pin is over the KEY (§3-3)
// that renewal is invisible to every phone. This is the concrete payoff of that
// design choice, not a hypothetical one.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { spkiFingerprint, isWellFormedFingerprint } from './fingerprint';
import { certificateFor, mintLanTlsIdentity, readPrivateKeyPem } from './x509';

/** 🔴 Secret. 0600, never logged, never leaves this machine. */
export const KEY_FILENAME = 'lan-tls.key.pem';
/** Public by nature — it is handed to every peer during the handshake. */
export const CERT_FILENAME = 'lan-tls.cert.pem';

/** Renew this far before expiry. A certificate that expires between two boots of
 *  a machine that is rarely restarted would break the LAN leg with no warning;
 *  renewing early costs one keyless re-mint. */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

export interface LanTlsIdentity {
  certPem: string;
  /** 🔴 Secret. Held in memory for `tls.createSecureContext` and nothing else. */
  keyPem: string;
  /** The value the pairing QR publishes as `fp=`. */
  fingerprint: string;
  /** How this identity came to be — for the boot log, so an operator can tell
   *  "generated for the first time" from "read back the previous one" from "the
   *  certificate expired and was re-signed". Three different
   *  facts that all look like a working server. */
  origin: 'minted' | 'loaded' | 'renewed';
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // ENOENT on first boot is the normal path; anything else (permissions, a
    // directory where a file should be) is handled identically on purpose —
    // an unreadable key is indistinguishable from an absent one for our
    // purposes, and both are answered by minting a fresh one.
    return null;
  }
}

function writeSecret(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some network filesystems do not honour POSIX modes. The file
    // is still inside the per-user FLOWMIC_HOME, which is the same protection
    // `standalone.secret` has relied on since 0.1.x — see identity.ts.
  }
}

/**
 * Load this machine's LAN TLS identity, minting or renewing as needed.
 *
 * Order, and the reason for each step:
 *   1. A stored key + a stored certificate that still parses, still matches that
 *      key, and is not near expiry → use them unchanged (the common path; this is
 *      what makes the fingerprint stable).
 *   2. A stored key whose certificate is missing / unparseable / expired → re-mint
 *      the certificate over the SAME key. The fingerprint does not move.
 *   3. No usable key → mint both. The fingerprint changes, which is correct: this
 *      IS a new identity, and any phone still holding the old pin should refuse.
 *
 * Throws if the directory cannot be written. The caller decides what that means —
 * see bootstrap.ts, where it degrades to plain LAN and says so out loud rather
 * than taking a working product down over an optional hardening.
 */
export function loadOrMintLanTlsIdentity(dir: string, now: Date = new Date()): LanTlsIdentity {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, KEY_FILENAME);
  const certPath = join(dir, CERT_FILENAME);

  const storedKeyPem = readIfPresent(keyPath);
  if (storedKeyPem !== null) {
    try {
      const privateKey = readPrivateKeyPem(storedKeyPem);
      const storedCertPem = readIfPresent(certPath);
      if (storedCertPem !== null && certificateIsUsable(storedCertPem, storedKeyPem, now)) {
        const spkiDer = Buffer.from(new X509Certificate(storedCertPem).publicKey.export({ type: 'spki', format: 'der' }));
        return finish({ certPem: storedCertPem, keyPem: storedKeyPem, spkiDer, origin: 'loaded' });
      }
      const renewed = certificateFor(privateKey, now);
      writeFileSync(certPath, renewed.certPem, 'utf8');
      return finish({ certPem: renewed.certPem, keyPem: storedKeyPem, spkiDer: renewed.spkiDer, origin: 'renewed' });
    } catch {
      // A stored key we cannot parse is corruption, not a reason to refuse to
      // serve. Fall through and mint a new identity — the fingerprint changes and
      // the boot log says `origin: 'minted'`, which is the visible trace an
      // operator needs when a phone suddenly refuses to connect.
    }
  }

  const minted = mintLanTlsIdentity(now);
  writeSecret(keyPath, minted.keyPem);
  writeFileSync(certPath, minted.certPem, 'utf8');
  return finish({ certPem: minted.certPem, keyPem: minted.keyPem, spkiDer: minted.spkiDer, origin: 'minted' });
}

function finish(input: { certPem: string; keyPem: string; spkiDer: Buffer; origin: LanTlsIdentity['origin'] }): LanTlsIdentity {
  const fingerprint = spkiFingerprint(input.spkiDer);
  // The fingerprint is about to be printed into a QR that phones pin for months.
  // This asserts the ENCODING invariant (§3-3: no ',' no '&' no padding) at the
  // one place the value is produced, so a future change to FP_BYTES that
  // reintroduced base64 padding fails here rather than on a phone.
  if (!isWellFormedFingerprint(fingerprint)) {
    throw new Error(`lan-tls: refusing to publish a malformed fingerprint (${fingerprint.length} chars)`);
  }
  return { certPem: input.certPem, keyPem: input.keyPem, fingerprint, origin: input.origin };
}

/** Does this stored certificate still belong to this stored key, and is it far
 *  enough from expiry to keep serving? */
function certificateIsUsable(certPem: string, keyPem: string, now: Date): boolean {
  try {
    const cert = new X509Certificate(certPem);
    // 🔴 The pairing is verified, not assumed: a cert and a key that happen to
    // share a directory are not necessarily a pair (a half-finished write, a
    // restored backup, two installs racing). Serving a mismatched pair fails at
    // handshake time with an error no log here would explain.
    if (!cert.checkPrivateKey(readPrivateKeyPem(keyPem))) return false;
    const validTo = Date.parse(cert.validTo);
    if (Number.isNaN(validTo)) return false;
    return validTo - now.getTime() > RENEW_BEFORE_MS;
  } catch {
    return false;
  }
}
