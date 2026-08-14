// SPEC-REF:
//   docs/strategy/2026-08-08-design-d2lan-light-encryption.md §3-3 (pin the SPKI,
//     not the certificate), §4-1 (the QR key `fp=`)
//   apps/server-core/src/lan-tls/fingerprint.ts — THE OTHER IMPLEMENTATION
//   apps/server-core/src/lan-tls/x509.ts — the certificate this walks
//
// The phone's own answer to 「这把公钥的指纹是什么」("what is the fingerprint of
// this public key").
//
// 🔴 THIS IS A SECOND IMPLEMENTATION ON PURPOSE, AND THAT IS THE RISK. The
// producer runs in Node and hashes a SubjectPublicKeyInfo it was handed by
// `createPublicKey(...).export({type:'spki'})`. The phone is handed a
// CERTIFICATE by the TLS stack and has to find the SPKI inside it — `dart:io`'s
// `X509Certificate` exposes `der`, `pem` and `sha1`, and NOTHING about the public
// key. So the two implementations agree only if this file lands on byte-for-byte
// the same SubjectPublicKeyInfo the server exported. That is not an assumption
// here: `lan_tls_pin_test.dart` runs this over a certificate a real
// `mintLanTlsIdentity()` produced and compares the resulting string to the one
// `spkiFingerprint()` produced from the server's own SPKI buffer.
//
// 🔴 TRUNCATE THE DIGEST, NOT ITS TEXT — the producer's header says the same, and
// this side is the reason it says it. Take [kLanTlsFpBytes] BYTES of the digest
// and encode those; never encode the whole digest and cut the string.
//   ⚠️ MEASURED, and the measurement is the uncomfortable half: at the CURRENT
//   constant the two spellings cannot disagree. 18 bytes is 24 base64 characters
//   exactly, so character 0..23 of the full digest's base64 encode precisely
//   bytes 0..17 — every input, no exceptions. The divergence is LATENT, not
//   active. It becomes real the moment anyone changes FP_BYTES to something that
//   is not a multiple of 3 (16 bytes → the 22nd character carries two bits of the
//   17th byte, so a text slice and a byte slice differ on most inputs and agree
//   on some). `lan_tls_pin_test.dart` demonstrates that divergence at 16 bytes so
//   the rule is backed by a measurement rather than by this paragraph.
//
// ⚠️ NO `dart:io` HERE. This file is pure computation over bytes so it can be
// tested without a socket; the funnel that owns certificates is lan_pinning.dart.

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// Bytes of the SHA-256 digest that survive into the QR. Mirrors `FP_BYTES` in
/// apps/server-core/src/lan-tls/fingerprint.ts — the SAME number, arrived at
/// independently is not a thing that happens, so the pairing is asserted by
/// `lan_tls_pin_test.dart` against a value the server actually produced.
const int kLanTlsFpBytes = 18;

/// Base64url characters [kLanTlsFpBytes] bytes produce. Derived, not stated
/// twice (18 is divisible by 3 ⇒ no `=` padding).
const int kLanTlsFpChars = (kLanTlsFpBytes ~/ 3) * 4;

/// Does [value] LOOK like a fingerprint?
///
/// Deliberately not a trust decision — that is the pin comparison. This exists so
/// a malformed value is refused where it is READ (a scanned QR, a stored row)
/// instead of being compared forever and never matching, which on a phone looks
/// exactly like a broken network.
bool isWellFormedLanTlsFingerprint(String value) =>
    RegExp('^[A-Za-z0-9_-]{$kLanTlsFpChars}\$').hasMatch(value);

/// The published fingerprint of a DER SubjectPublicKeyInfo.
String lanTlsFingerprintOfSpki(List<int> spkiDer) => base64Url
    .encode(sha256.convert(spkiDer).bytes.sublist(0, kLanTlsFpBytes));

/// The published fingerprint of the public key inside a DER **certificate**, or
/// `null` when [certDer] is not a certificate we can walk.
///
/// `null` is never treated as a match by any caller: an unreadable certificate is
/// a refusal, not a pass. It is returned rather than thrown because this runs
/// inside a TLS callback, where an exception would surface as an unrelated
/// handshake error.
String? lanTlsFingerprintOfCertificate(Uint8List certDer) {
  final Uint8List? spki = _spkiOfCertificate(certDer);
  return spki == null ? null : lanTlsFingerprintOfSpki(spki);
}

// ─────────────────────────────────────────────────────── minimal DER reader ──
//
// 🔴 THIS ONE READS ATTACKER-CONTROLLED BYTES, unlike the writer on the server.
// Whoever answers the socket chooses this certificate, so every read is bounds-
// checked and every malformed shape returns null instead of throwing or, worse,
// walking off into the next field. There is no allocation proportional to a
// length this input declares.

class _Tlv {
  const _Tlv(this.tag, this.start, this.end, this.contentStart);

  final int tag;

  /// Offset of the tag byte — the first byte of the TLV as a whole.
  final int start;

  /// One past the last content byte, i.e. where the NEXT TLV begins.
  final int end;
  final int contentStart;
}

/// Read one tag-length-value at [offset]. `null` on any truncation or on a length
/// this reader refuses (indefinite length, or more length bytes than an int can
/// hold — neither occurs in DER, and both are how a parser gets walked off a
/// buffer).
_Tlv? _readTlv(Uint8List buf, int offset) {
  if (offset < 0 || offset + 2 > buf.length) return null;
  final int tag = buf[offset];
  int i = offset + 1;
  int len = buf[i];
  i += 1;
  if ((len & 0x80) != 0) {
    final int lengthBytes = len & 0x7f;
    // 0x80 is BER's indefinite length: legal in BER, forbidden in DER, and the
    // classic way to make a reader run to the end of the buffer.
    if (lengthBytes == 0 || lengthBytes > 4) return null;
    if (i + lengthBytes > buf.length) return null;
    len = 0;
    for (int k = 0; k < lengthBytes; k++) {
      len = (len << 8) | buf[i];
      i += 1;
    }
  }
  if (len < 0 || i + len > buf.length) return null;
  return _Tlv(tag, offset, i + len, i);
}

const int _kDerSequence = 0x30;

/// The SubjectPublicKeyInfo bytes inside an X.509 certificate, VERBATIM (tag,
/// length and content), because that is exactly what the server hashed.
///
/// RFC 5280 §4.1:
///   Certificate  ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
///   TBSCertificate ::= SEQUENCE {
///     [0] version, serialNumber, signature, issuer, validity, subject,
///     subjectPublicKeyInfo, ... }
///
/// `version` is `[0] EXPLICIT` and OPTIONAL, so it is skipped by TAG rather than
/// by position — a v1 certificate has no such element and counting blind would
/// then land on `validity` and hash it as a public key. (Our sidecar always mints
/// v3, but this reader is fed by whoever answers the socket, not by us.)
Uint8List? _spkiOfCertificate(Uint8List certDer) {
  final _Tlv? certificate = _readTlv(certDer, 0);
  if (certificate == null || certificate.tag != _kDerSequence) return null;
  final _Tlv? tbs = _readTlv(certDer, certificate.contentStart);
  if (tbs == null || tbs.tag != _kDerSequence) return null;

  int at = tbs.contentStart;
  final _Tlv? first = _readTlv(certDer, at);
  if (first == null) return null;
  // [0] EXPLICIT version — context-specific, constructed, number 0.
  if (first.tag == 0xa0) at = first.end;

  // serialNumber, signature, issuer, validity, subject — five fields, then the
  // SPKI. Walked one at a time so a short/malformed field stops the walk instead
  // of being stepped over.
  for (int skipped = 0; skipped < 5; skipped++) {
    final _Tlv? field = _readTlv(certDer, at);
    if (field == null || field.end > tbs.end) return null;
    at = field.end;
  }

  final _Tlv? spki = _readTlv(certDer, at);
  if (spki == null || spki.tag != _kDerSequence || spki.end > tbs.end) {
    return null;
  }
  return Uint8List.sublistView(certDer, spki.start, spki.end);
}
