// SPEC-REF:
//   docs/strategy/2026-08-08-design-d2lan-light-encryption.md §3-1 (who mints the
//     certificate), §3-3 (pin the SPKI, not the certificate), §4 (the four
//     narrowings), §6 (cryptography face ⇒ line-by-line human audit)
//   docs/decisions/2026-08-02-owner-b-batch-rulings.md item 3 (owner's direction:
//     self-signed TLS on the LAN leg, fingerprint rides the pairing QR)
//
// A self-signed X.509 v3 certificate minted with `node:crypto` alone.
//
// 🔴 WHY THIS FILE EXISTS AT ALL. Node has `generateKeyPairSync` and an X.509
// PARSER (`crypto.X509Certificate`) but NO certificate GENERATOR, and this repo
// takes zero npm dependencies on the server (see apps/server-core/package.json —
// `socket.io` and `ws` are the whole list). Design §3-1 called that the single
// unknown of the whole card and required a probe before implementation; the probe
// (D2LAN-B0) settled it: ~150 lines of DER assembly, cross-checked three ways
// (node's own parser, OpenSSL 3.2.4, an independent Dart DER walk — all three
// agreed on the SPKI SHA-256).
//
// 🔴 WHAT IS DELIBERATELY NOT HERE, and why each absence is load-bearing:
//   • NO SubjectAltName. The phone pins the PUBLIC KEY (SPKI hash), not the
//     certificate or the name in it — design §3-3. One QR can carry up to six
//     bare-IP candidates (`qrAltHosts` + the phone's `expandCandidates`, which
//     inherits scheme/port from the primary endpoint), so a name-bound cert would
//     need every one of those IPs in an IP SAN and would break the moment a NIC
//     changed. The probe verified by test that a cert with no SAN extension at
//     all is accepted over 127.0.0.1, localhost, 100.64.7.78 and 10.0.0.78
//     when the caller pins the key instead of trusting the name.
//     ⚠️ This is only sound BECAUSE the peer pins. A client that merely disables
//     hostname verification and trusts nothing else gets no authentication at
//     all — the pinning half lives on the phone (card D2LAN-B3) and is what makes
//     this certificate meaningful.
//   • NO CA / chain / client certificates (owner ruled them out explicitly).
//   • NO RSA. EC P-256 only: smaller keys, a smaller QR fingerprint to justify,
//     and one code path to audit instead of two. (The probe exercised RSA too and
//     it worked; it is dropped here for surface, not because it failed.)

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';

// ─────────────────────────────────────────────────────────────── ASN.1 DER ──
// A writer, not a parser: every length below is one we computed ourselves, so
// there is no attacker-controlled input on this path. The two readers at the
// bottom walk only our OWN freshly-built SPKI.

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256); // NOT >>> — a cert can exceed 2^31 in principle
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const SEQ = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const SET = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
/** Context-specific CONSTRUCTED tag [n] — the explicit wrappers in a TBS. */
const ctx = (n: number, ...parts: Buffer[]): Buffer => tlv(0xa0 | n, Buffer.concat(parts));
const NULL_VALUE = Buffer.from([0x05, 0x00]);
const BOOLEAN = (b: boolean): Buffer => Buffer.from([0x01, 0x01, b ? 0xff : 0x00]);
const UTF8_STRING = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
const OCTET_STRING = (b: Buffer): Buffer => tlv(0x04, b);

/** DER INTEGER. Leading zeros are stripped and one is re-added when the top bit
 *  is set, because DER integers are SIGNED and a serial number must not come
 *  back negative. */
function INTEGER(value: number | Buffer): Buffer {
  let b = typeof value === 'number' ? Buffer.from([value]) : Buffer.from(value);
  let i = 0;
  while (i < b.length - 1 && b.readUInt8(i) === 0) i++;
  b = b.subarray(i);
  if ((b.readUInt8(0) & 0x80) !== 0) b = Buffer.concat([Buffer.from([0x00]), b]);
  return tlv(0x02, b);
}

/** DER BIT STRING with an explicit unused-bit count (KeyUsage needs 5). */
function BIT_STRING(payload: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), payload]));
}

/** Dotted OID → DER. First two arcs pack into one byte (40*a+b), the rest are
 *  base-128 with the continuation bit set on every byte but the last. */
function OID(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const first = arcs[0];
  const second = arcs[1];
  if (first === undefined || second === undefined) throw new Error(`lan-tls: malformed OID ${dotted}`);
  const out: number[] = [40 * first + second];
  for (const arc of arcs.slice(2)) {
    const stack: number[] = [];
    let v = arc;
    do {
      stack.unshift(v & 0x7f);
      v >>>= 7;
    } while (v > 0);
    for (let i = 0; i < stack.length - 1; i++) stack[i] = (stack[i] ?? 0) | 0x80;
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

/** DER UTCTime (YYMMDDHHMMSSZ).
 *
 *  🔴 UTCTime's two-digit year is only unambiguous for 1950–2049 (RFC 5280 §4.1.2.5:
 *  a notAfter at or beyond 2050 MUST be a GeneralizedTime instead). CERT_LIFETIME_MS
 *  below is 10 years, so this is unreachable today — the throw exists so that a
 *  future maintainer who widens the lifetime gets a loud boot failure instead of a
 *  certificate whose expiry silently reads as 1956. */
function UTC_TIME(d: Date): Buffer {
  const year = d.getUTCFullYear();
  if (year < 1950 || year >= 2050) {
    throw new Error(`lan-tls: ${year} is outside UTCTime's unambiguous range — use GeneralizedTime`);
  }
  const p = (n: number): string => String(n).padStart(2, '0');
  const s =
    `${p(year % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

// ─────────────────────────────────────────────────────────────────── OIDs ──
const OID_COMMON_NAME = '2.5.4.3';
const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const OID_EXT_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_EXT_KEY_USAGE = '2.5.29.15';
const OID_EXT_EXT_KEY_USAGE = '2.5.29.37';
const OID_EKU_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const OID_EXT_SUBJECT_KEY_ID = '2.5.29.14';

// ───────────────────────────────────────────────── minimal DER readers ──
// Used ONLY on the SPKI we just produced ourselves (to lift the raw public-key
// bits out for the Subject Key Identifier). `readUInt8` throws on a short read,
// which is the behaviour we want if this ever meets something malformed.

interface Tlv {
  tag: number;
  content: Buffer;
  end: number;
}

function readTlv(buf: Buffer, offset: number): Tlv {
  const tag = buf.readUInt8(offset);
  let i = offset + 1;
  let len = buf.readUInt8(i);
  i += 1;
  if ((len & 0x80) !== 0) {
    const lengthBytes = len & 0x7f;
    len = 0;
    for (let k = 0; k < lengthBytes; k++) {
      len = len * 256 + buf.readUInt8(i);
      i += 1;
    }
  }
  return { tag, content: buf.subarray(i, i + len), end: i + len };
}

/** The raw public-key bits inside a SubjectPublicKeyInfo: SEQUENCE { AlgorithmIdentifier,
 *  BIT STRING }, minus the BIT STRING's leading unused-bits octet. */
function publicKeyBits(spkiDer: Buffer): Buffer {
  const outer = readTlv(spkiDer, 0);
  if (outer.tag !== 0x30) throw new Error('lan-tls: SPKI is not a SEQUENCE');
  const algorithmId = readTlv(outer.content, 0);
  const bitString = readTlv(outer.content, algorithmId.end);
  if (bitString.tag !== 0x03) throw new Error('lan-tls: SPKI has no public-key BIT STRING');
  return bitString.content.subarray(1);
}

// ──────────────────────────────────────────────────────────────── minting ──

/** 10 years. The certificate is NOT the pinned object — the KEY is (§3-3) — so
 *  renewing it never invalidates a QR that has already been scanned, and
 *  `loadOrMintLanTlsIdentity` re-mints from the SAME stored key when this runs
 *  out. A long life simply means that renewal is rare rather than routine. */
export const CERT_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** Clock skew allowance on notBefore. Two devices on a LAN routinely disagree by
 *  minutes, and a certificate that is "not yet valid" for the first hour of its
 *  life is a support call nobody can diagnose. */
const NOT_BEFORE_BACKDATE_MS = 60 * 60 * 1000;

/** What this machine calls itself in the certificate subject. Cosmetic: nothing
 *  verifies it (the peer pins the key), it exists so an operator inspecting the
 *  cert with openssl sees what minted it. */
const SUBJECT_COMMON_NAME = 'FlowMic LAN sidecar';

export interface LanTlsMaterial {
  /** PEM certificate, for `tls.createSecureContext({ cert })`. */
  certPem: string;
  /** PKCS#8 PEM private key. 🔴 Secret: never logged, persisted 0600. */
  keyPem: string;
  /** DER SubjectPublicKeyInfo — the object the phone's fingerprint is over. */
  spkiDer: Buffer;
}

const PEM_LINE = 64;

function toPem(der: Buffer, label: string): string {
  const b64 = der.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += PEM_LINE) lines.push(b64.slice(i, i + PEM_LINE));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** Mint a fresh EC P-256 key pair AND a self-signed certificate over it. */
export function mintLanTlsIdentity(now: Date = new Date()): LanTlsMaterial {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { ...certificateFor(privateKey, now), keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/** Mint a certificate over an EXISTING key — the renewal path. The SPKI (and so
 *  the published fingerprint) is unchanged by construction, which is the whole
 *  reason §3-3 pins the key rather than the certificate. */
export function certificateFor(privateKey: KeyObject, now: Date = new Date()): { certPem: string; spkiDer: Buffer } {
  // `createPublicKey` DERIVES the public half from the private key, so the SPKI
  // we publish a fingerprint for and the key we sign with cannot drift apart.
  const spkiDer = Buffer.from(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }));

  // ECDSA-with-SHA256 takes NO parameters. RFC 5758 §3.2 is explicit that the
  // parameters field MUST be absent — an `ASN.1 NULL` here (which is what RSA
  // requires, and what a copy-paste from an RSA example produces) makes some
  // stacks reject the certificate.
  const signatureAlgorithm = SEQ(OID(OID_ECDSA_WITH_SHA256));

  // Issuer == subject: that IS what "self-signed" means on the wire.
  const distinguishedName = SEQ(SET(SEQ(OID(OID_COMMON_NAME), UTF8_STRING(SUBJECT_COMMON_NAME))));

  const validity = SEQ(
    UTC_TIME(new Date(now.getTime() - NOT_BEFORE_BACKDATE_MS)),
    UTC_TIME(new Date(now.getTime() + CERT_LIFETIME_MS)),
  );

  const extension = (oid: string, critical: boolean, value: Buffer): Buffer =>
    SEQ(OID(oid), ...(critical ? [BOOLEAN(true)] : []), OCTET_STRING(value));

  const extensions: Buffer[] = [
    // CA:FALSE (an empty BasicConstraints SEQUENCE means exactly that). Critical:
    // this certificate must never be usable to vouch for another one.
    extension(OID_EXT_BASIC_CONSTRAINTS, true, SEQ()),
    // KeyUsage: digitalSignature(0) | keyEncipherment(2) = 0b1010_0000, of which
    // 3 bits are significant ⇒ 5 unused.
    extension(OID_EXT_KEY_USAGE, true, BIT_STRING(Buffer.from([0xa0]), 5)),
    // serverAuth only. This key terminates TLS for the sidecar and does nothing else.
    extension(OID_EXT_EXT_KEY_USAGE, false, SEQ(OID(OID_EKU_SERVER_AUTH))),
    // SubjectKeyIdentifier = SHA-1 of the public-key bits (RFC 5280 §4.2.1.2
    // method 1). SHA-1 is the specified construction for this identifier and is
    // NOT a security property here — it names a key, it does not authenticate
    // one. The authentication is the SHA-256 SPKI pin.
    extension(OID_EXT_SUBJECT_KEY_ID, false, OCTET_STRING(createHash('sha1').update(publicKeyBits(spkiDer)).digest())),
  ];

  const tbsCertificate = SEQ(
    ctx(0, INTEGER(2)), // version: v3
    INTEGER(randomBytes(16)),
    signatureAlgorithm,
    distinguishedName, // issuer
    validity,
    distinguishedName, // subject
    spkiDer, // verbatim SubjectPublicKeyInfo — node produced it, we do not re-encode
    ctx(3, SEQ(...extensions)),
  );

  // For EC keys node emits a DER-encoded ECDSA-Sig-Value, which is precisely what
  // X.509 wants in the signature BIT STRING.
  const signature = sign('sha256', tbsCertificate, privateKey);
  const certDer = SEQ(tbsCertificate, signatureAlgorithm, BIT_STRING(signature));

  return { certPem: toPem(certDer, 'CERTIFICATE'), spkiDer };
}

/** Read a PKCS#8 PEM private key back into a KeyObject, refusing anything that is
 *  not the EC key this module mints. A key of the wrong type would still produce
 *  a working certificate, so the check is here rather than at the TLS handshake
 *  where the failure would be a mystery. */
export function readPrivateKeyPem(keyPem: string): KeyObject {
  const key = createPrivateKey(keyPem);
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(`lan-tls: stored key is ${String(key.asymmetricKeyType)}, expected ec`);
  }
  return key;
}
