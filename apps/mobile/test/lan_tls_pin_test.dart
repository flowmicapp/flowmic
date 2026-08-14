// Cards D2LAN-B3 + B4 — the phone side of LAN TLS pinning and TOFU disclosure.
//
// SPEC-REF:
//   docs/strategy/2026-08-08-design-d2lan-light-encryption.md §3-3 / §3-4a /
//     §3-5 / §4-3 / §4-4 / §6-4
//   apps/server-core/src/lan-tls/fingerprint.ts — the **other implementation**
//     of the fingerprint
//   apps/server-core/src/lan-tls/x509.ts — origin of the certificate below
//
// 🔴 The most important thing in this file is not an assertion, it is **which
// path the sample came from**.
//
// "Two independent implementations computed the same string" is only true when
// the value being compared **really was produced by the other implementation**.
// So the [kCertDerB64] / [kExpectedFingerprint] below are not handwritten, and
// not computed on this side and copied back: they are the **server's own
// reading**, printed by running on this machine
//
//     node --experimental-strip-types <scratch>.mts
//       → mintLanTlsIdentity(new Date('2026-08-09T00:00:00Z'))
//       → spkiFingerprint(m.spkiDer)
//
// and pasted character for character. 〔measured, machine＝dev-pc-a〕
// CLAUDE.md's rule: how hard a measurement is depends on whether the mechanism
// that produced it is the path the product will walk.

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/endpoint_candidates.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/http_endpoint.dart';
import 'package:flowmic/src/signaling/lan_tls_fingerprint.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/ui/connection_diagnostics_sheet.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/locale_terms.dart';

// ── Three values the server produced (see file header) ─────────────────────

/// DER of a whole self-signed certificate (the raw decoded from
/// `mintLanTlsIdentity`'s `certPem`).
const String kCertDerB64 =
    'MIIBjTCCATSgAwIBAgIQPiJI2GOnR3nnH3xgOJ57tjAKBggqhkjOPQQDAjAeMRwwGgYDVQQDD'
    'BNGbG93TWljIExBTiBzaWRlY2FyMB4XDTI2MDgwODIzMDAwMFoXDTM2MDgwNjAwMDAwMFowHj'
    'EcMBoGA1UEAwwTRmxvd01pYyBMQU4gc2lkZWNhcjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0I'
    'ABNBwgYi/Aw9Xg9FnQd4y3LUYhC3ClMjvPo/375higvwPtoDP34Betq4HU/6dmB2G/N9VvtHl'
    'aakuvEEZcl5VeHujVDBSMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMM'
    'AoGCCsGAQUFBwMBMB0GA1UdDgQWBBRy01eDp/I/w6OWBE+k5+DKjU+KzzAKBggqhkjOPQQDAg'
    'NHADBEAiArGvD5zoaR2gYRKFYMorborjYi+ZEu4YmqOpAMcOzKzwIgaa4mtib93H45DXVN5Te'
    'BoroDhzc4I0h/bfEZ1Mq25Nc=';

/// Output of the server's `createPublicKey(key).export({type:'spki',format:'der'})`,
/// i.e. **the exact bytes `spkiFingerprint()` actually hashes**.
const String kSpkiDerB64 =
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE0HCBiL8DD1eD0WdB3jLctRiELcKUyO8+j/fvm'
    'GKC/A+2gM/fgF62rgdT/p2YHYb831W+0eVpqS68QRlyXlV4ew==';

/// Output of `spkiFingerprint(m.spkiDer)` — i.e. the string `fp=` on the QR
/// will write.
const String kExpectedFingerprint = 'lyKv42hVFCt5iXthGDWFe4Tm';

/// Full SHA-256 (hex) of the same SPKI, used to measure the "take the first 18
/// bytes" step on its own.
const String kSpkiSha256Hex =
    '9722afe36855142b79897b611835857b84e65ac778a3777fca51a115a5fda42d';

/// Fingerprint of another computer (legal shape, different value) — for reverse
/// control.
const String kOtherFingerprint = 'AAAAAAAAAAAAAAAAAAAAAAAA';

Uint8List get _certDer => base64.decode(kCertDerB64);
Uint8List get _spkiDer => base64.decode(kSpkiDerB64);

const String kPort = '41879';
const String kLan = '100.64.7.68';
const String kAlt = '10.0.0.68';

String qr({String? fp, String? alt}) =>
    'flowmic://pair?endpoint=ws://$kLan:$kPort&code=1234&channel=standalone'
    '${alt == null ? '' : '&alt=$alt'}${fp == null ? '' : '&fp=$fp'}';

Map<String, Object?> ackWithToken() => <String, Object?>{
  'token': 'tok-abcdefghijklmnopqrstuvwxyz012345',
  'pairing_id': 'pair-1',
  'pc_instance_id': 'inst-1',
  'pc_id': 'pc-1',
  'pc_machine_uid': 'machine-1',
  'pc_name': 'Studio PC',
};

double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

bool _clipped(WidgetTester tester, Finder f) =>
    tester.renderObject<RenderParagraph>(f).didExceedMaxLines;

void main() {
  // ── ① Do the two implementations really compute the same string ──────────
  group('① fingerprint: Dart side and server-core side match byte for byte', () {
    test('the SPKI walked out of the whole certificate equals the server-exported bytes, byte for byte', () {
      // 🔴 This one is the foundation of the whole file. The server hashes the
      // SPKI it itself exported; the phone is handed the **whole certificate**
      // (`dart:io`'s X509Certificate only gives der/pem/sha1, not one public-
      // key field). The two sides can match if and only if this side's DER
      // walk **lands on exactly the same stretch of bytes**. Assert on the
      // bytes, not on the fingerprint: fingerprint equality can be two errors
      // cancelling each other; byte equality cannot.
      final Uint8List cert = _certDer;
      final Uint8List spki = _spkiDer;
      final int at = _indexOfBytes(cert, spki);
      expect(at, isNot(-1), reason: 'this certificate does not contain that SPKI at all, samples do not match');

      // The fingerprint computed on the same path as production
      // (`lanTlsFingerprintOfCertificate`) must equal the fingerprint the
      // server computed from its own bytes.
      expect(lanTlsFingerprintOfCertificate(cert), kExpectedFingerprint);
      expect(lanTlsFingerprintOfSpki(spki), kExpectedFingerprint);
    });

    test('"take 18 bytes then encode" measured on its own: equals the first 18 bytes of the server\'s sha256', () {
      final List<int> digest = sha256.convert(_spkiDer).bytes;
      expect(_hex(digest), kSpkiSha256Hex, reason: 'the hash itself already does not match, no need to look further');
      expect(
        base64Url.encode(digest.sublist(0, kLanTlsFpBytes)),
        kExpectedFingerprint,
      );
      expect(kLanTlsFpChars, 24);
      expect(kExpectedFingerprint.length, kLanTlsFpChars);
    });

    test('🔴 measurement: "slice the string" and "slice the bytes" cannot differ at 18 bytes, and will differ at 16 bytes', () {
      // fingerprint.ts's file header lists "truncate the digest, not the text"
      // as a red line. This case is that red line's **ruler**, and the first
      // thing it measures is the uncomfortable half:
      //
      //   18 bytes = 24 base64 characters, divides evenly ⇒ characters 0..23
      //   of the full-digest base64 encode exactly bytes 0..17. The two
      //   writings are **always equal** under the current constants.
      //
      // Which means this red line is **latent** today, not active. It becomes
      // true the moment FP_BYTES is not a multiple of 3 — below we actually
      // manufacture that divergence once with 16 bytes, proving "the two
      // writings will diverge" is not a deduction. This implementation slices
      // bytes, so it is on the same side as the server for any N.
      final List<int> digest = sha256.convert(_spkiDer).bytes;

      final String byteSliced18 =
          base64Url.encode(digest.sublist(0, 18));
      final String textSliced18 = base64Url.encode(digest).substring(0, 24);
      expect(
        byteSliced18,
        textSliced18,
        reason: 'at 18 bytes the two writings are necessarily equal — which is exactly why this red line is easy to dismiss as over-caution',
      );

      final String byteSliced16 = base64Url.encode(digest.sublist(0, 16));
      // 16 bytes encode to 22 characters (including 2 bits of padding), and
      // among the first 22 characters of the full digest, the last one
      // carries the high bits of byte 17 ⇒ generally not equal.
      final String textSliced16 = base64Url.encode(digest).substring(0, 22);
      expect(
        byteSliced16,
        isNot(textSliced16),
        reason: 'on this sample the two happen to be equal — re-take the sample from another certificate, do not delete this assertion',
      );
    });

    test('shape check: only 24 base64url characters are accepted', () {
      expect(isWellFormedLanTlsFingerprint(kExpectedFingerprint), isTrue);
      expect(isWellFormedLanTlsFingerprint(''), isFalse);
      expect(isWellFormedLanTlsFingerprint('$kExpectedFingerprint='), isFalse);
      expect(isWellFormedLanTlsFingerprint('short'), isFalse);
      // `+` and `/` are the standard base64 alphabet, not base64url's — a
      // producer that used the wrong encoding must be stopped here, not
      // become a pin that never matches on the phone.
      expect(isWellFormedLanTlsFingerprint('a+/${'A' * 21}'), isFalse);
    });

    test('an unparseable certificate is always null, never throws, and is never treated as a match', () {
      // This parser reads bytes **the other side chose**. Every case must
      // land on null.
      expect(lanTlsFingerprintOfCertificate(Uint8List(0)), isNull);
      expect(lanTlsFingerprintOfCertificate(Uint8List.fromList(<int>[0x30])), isNull);
      // Half a certificate: the length declaration is longer than the buffer.
      final Uint8List cert = _certDer;
      expect(
        lanTlsFingerprintOfCertificate(Uint8List.sublistView(cert, 0, 40)),
        isNull,
      );
      // Does not start with SEQUENCE.
      final Uint8List notSeq = Uint8List.fromList(cert)..[0] = 0x31;
      expect(lanTlsFingerprintOfCertificate(notSeq), isNull);
    });
  });

  // ── ② Both parsers recognize fp= ─────────────────────────────────────────
  group('② the two readers of the QR', () {
    test('PairEntry.parse reads fp=, and is null when it is absent', () {
      expect(PairEntry.parse(qr(fp: kExpectedFingerprint)).fingerprint,
          kExpectedFingerprint);
      expect(PairEntry.parse(qr()).fingerprint, isNull);
      // Old codes unchanged character for character: endpoint still reads.
      expect(PairEntry.parse(qr()).endpoint, 'ws://$kLan:$kPort');
    });

    test('fp= is present but the shape is wrong ⇒ loud refusal, not quietly treated as absent', () {
      // Quietly dropping it would let the phone pair in the clear, while the
      // PC thinks it published a pin — a wrong status word with no failure
      // at all (R11).
      expect(
        () => PairEntry.parse(qr(fp: 'not-a-fingerprint')),
        throwsA(isA<FormatException>()),
      );
    });

    test('second reader: with fp ⇒ the primary address and every alt are raised to wss://', () {
      final List<String> c = qrDialCandidates(
        qr(fp: kExpectedFingerprint, alt: kAlt),
      );
      expect(c, <String>['wss://$kLan:$kPort', 'wss://$kAlt:$kPort']);
      expect(qrFingerprint(qr(fp: kExpectedFingerprint)), kExpectedFingerprint);
    });

    test('reverse control: no fp ⇒ candidates are character-for-character the same as before this card', () {
      // Compatibility direction: the failure direction must be "fall back to
      // the status quo", not "cannot connect".
      expect(qrDialCandidates(qr(alt: kAlt)), <String>[
        'ws://$kLan:$kPort',
        'ws://$kAlt:$kPort',
      ]);
      expect(qrFingerprint(qr(alt: kAlt)), isNull);
      // A badly shaped fp does not count as a pin on this side either (it
      // was already refused on the PairEntry side).
      expect(qrFingerprint(qr(fp: 'nope')), isNull);
    });

    test('pairDialCandidates: when pinned, the leading address is upgraded too', () {
      // The leader is the endpoint `addByCode` resolved. Forget to upgrade
      // it and the first name in the whole queue is a `ws://`, and every
      // dial takes the first name ⇒ the pin is never checked.
      final List<String> c = pairDialCandidates(
        qrLink: qr(fp: kExpectedFingerprint, alt: kAlt),
        endpoint: 'ws://$kLan:$kPort',
        pinned: true,
      );
      expect(c.first, 'wss://$kLan:$kPort');
      expect(c.any((String e) => e.startsWith('ws://')), isFalse);
    });

    test('the scheme criterion recognizes both wss and https shapes', () {
      // What is stored is https (httpBaseOf's output); what is dialed is wss
      // (the QR's shape) — the same connection.
      expect(isSecureEndpoint('wss://$kLan:$kPort'), isTrue);
      expect(isSecureEndpoint('https://$kLan:$kPort'), isTrue);
      expect(isSecureEndpoint('ws://$kLan:$kPort'), isFalse);
      expect(isSecureEndpoint('$kLan:$kPort'), isFalse);
      expect(secureDialUrl('ws://$kLan:$kPort'), 'wss://$kLan:$kPort');
      expect(secureDialUrl('http://$kLan:$kPort'), 'https://$kLan:$kPort');
      expect(httpBaseOf('wss://$kLan:$kPort'), 'https://$kLan:$kPort');
    });
  });

  // ── ③ A stored pin is credential-grade ───────────────────────────────────
  group('③ MobileSession\'s pin', () {
    MobileSession pinned() => const MobileSession(
      token: 'tok-1',
      endpoint: 'https://$kLan:$kPort',
    ).pinLanTls(fingerprint: kExpectedFingerprint, source: LanPinSource.qr);

    test('copyWith carries the pin, and offers no entry that can change it', () {
      final MobileSession moved = pinned().copyWith(
        endpoint: 'https://$kAlt:$kPort',
        pcName: 'Renamed PC',
      );
      expect(moved.lanTlsFp, kExpectedFingerprint);
      expect(moved.lanTlsFpSource, LanPinSource.qr);
    });

    test('🔴 swapping in a different key ⇒ throw, never overwrite', () {
      // machine_map's "later write overwrites" is correct there; here it is
      // exactly the thing this card is catching.
      expect(
        () => pinned()
            .pinLanTls(fingerprint: kOtherFingerprint, source: LanPinSource.qr),
        throwsA(isA<StateError>()),
      );
      // Pinning the same key again is idempotent (re-scan the same code),
      // and will not weaken the source.
      final MobileSession again = pinned().pinLanTls(
        fingerprint: kExpectedFingerprint,
        source: LanPinSource.tofu,
      );
      expect(again.lanTlsFpSource, LanPinSource.qr);
    });

    test('alias_keeps_pin —— changing a note must not demote the pairing to unpinned', () async {
      final InMemoryTokenStorage store = InMemoryTokenStorage();
      await store.addOrUpdatePairing(pinned());
      await store.setPairingAlias(pinned(), '书房那台');
      final MobileSession back = (await store.readPairings()).single;
      expect(back.displayAlias, '书房那台');
      expect(back.lanTlsFp, kExpectedFingerprint);
      expect(back.lanTlsFpSource, LanPinSource.qr);
    });

    test('JSON round-trip; a broken pin reads back as "unpinned", not as a value that never matches', () {
      final Map<String, Object?> j = pinned().toJson();
      expect(j['lan_tls_fp'], kExpectedFingerprint);
      expect(j['lan_tls_fp_source'], 'qr');
      expect(MobileSession.fromJson(j)!.lanTlsFpSource, LanPinSource.qr);

      final MobileSession broken = MobileSession.fromJson(<String, Object?>{
        'token': 'tok-1',
        'endpoint': 'https://$kLan:$kPort',
        'lan_tls_fp': 'truncated',
        'lan_tls_fp_source': 'qr',
      })!;
      expect(broken.lanTlsFp, isNull);
      // Old rows (written before this card) naturally lack these two keys,
      // and read back as unpinned.
      final MobileSession old = MobileSession.fromJson(<String, Object?>{
        'token': 'tok-1',
        'endpoint': 'http://$kLan:$kPort',
      })!;
      expect(old.lanTlsFp, isNull);
      expect(old.lanTlsFpSource, isNull);
    });
  });

  // ── ④ With a pin ⇒ really dial wss, and carry the pin down ───────────────
  group('④ dialing', () {
    test('scan with fp ⇒ dial wss://, pin rides with the dial, the persisted row is pinned', () async {
      final FakeSocketTransport t = FakeSocketTransport()
        ..connectSucceeds = true
        ..defaultAck = ackWithToken();
      final InMemoryTokenStorage store = InMemoryTokenStorage();
      final PttSession session = newTestSession(
        transport: t,
        tokenStorage: store,
      )..candidateProbeTimeout = const Duration(milliseconds: 20);
      addTearDown(session.dispose);
      session.healthReader = (Uri url, Duration timeout) async =>
          const HealthReading(ok: true, channel: ServerChannel.lan);

      final PairResult r = await session.pair(
        PairEntry.parse(qr(fp: kExpectedFingerprint)),
        endpoint: 'ws://$kLan:$kPort',
      );
      expect(r.ok, isTrue);
      expect(t.lastConnectUrl, 'wss://$kLan:$kPort');
      expect(t.lastConnectPin, kExpectedFingerprint);

      final MobileSession stored = (await store.readPairings()).single;
      expect(stored.lanTlsFp, kExpectedFingerprint);
      expect(stored.lanTlsFpSource, LanPinSource.qr);
      expect(stored.endpoint, 'https://$kLan:$kPort');
      expect(session.lanPin, kExpectedFingerprint);
    });

    test('reverse control: the same code with fp stripped ⇒ dial ws://, no pin, the row is not pinned', () async {
      final FakeSocketTransport t = FakeSocketTransport()
        ..connectSucceeds = true
        ..defaultAck = ackWithToken();
      final InMemoryTokenStorage store = InMemoryTokenStorage();
      final PttSession session = newTestSession(
        transport: t,
        tokenStorage: store,
      )..candidateProbeTimeout = const Duration(milliseconds: 20);
      addTearDown(session.dispose);
      session.healthReader = (Uri url, Duration timeout) async =>
          const HealthReading(ok: true, channel: ServerChannel.lan);

      final PairResult r =
          await session.pair(PairEntry.parse(qr()), endpoint: 'ws://$kLan:$kPort');
      expect(r.ok, isTrue);
      expect(t.lastConnectUrl, 'ws://$kLan:$kPort');
      expect(t.lastConnectPin, isNull);
      expect((await store.readPairings()).single.lanTlsFp, isNull);
    });

    test('B4 typed-in ⇒ TOFU: record the key that was seen, source is tofu', () async {
      final FakeSocketTransport t = FakeSocketTransport()
        ..connectSucceeds = true
        ..defaultAck = ackWithToken();
      final InMemoryTokenStorage store = InMemoryTokenStorage();
      final List<Uri> looked = <Uri>[];
      final PttSession session = newTestSession(
        transport: t,
        tokenStorage: store,
        lanFingerprintLearner: (Uri url, Duration timeout) async {
          looked.add(url);
          return kExpectedFingerprint;
        },
      )..candidateProbeTimeout = const Duration(milliseconds: 20);
      addTearDown(session.dispose);
      session.healthReader = (Uri url, Duration timeout) async =>
          const HealthReading(ok: true, channel: ServerChannel.lan);

      // The typed-in path: 4-digit code + the address the user typed, no QR.
      final PairResult r =
          await session.pair(PairEntry.parse('1234'), endpoint: '$kLan:$kPort');
      expect(r.ok, isTrue);
      // The glance walks https, and happens before the dial.
      expect(looked.single.scheme, 'https');
      expect(t.lastConnectUrl, 'wss://$kLan:$kPort');
      final MobileSession stored = (await store.readPairings()).single;
      expect(stored.lanTlsFp, kExpectedFingerprint);
      expect(stored.lanTlsFpSource, LanPinSource.tofu);
      expect(session.lanPinSource, LanPinSource.tofu);
    });

    test('reverse control: typed-in and the other side has no TLS ⇒ plaintext, character-for-character the same as before this card', () async {
      final FakeSocketTransport t = FakeSocketTransport()
        ..connectSucceeds = true
        ..defaultAck = ackWithToken();
      final InMemoryTokenStorage store = InMemoryTokenStorage();
      final PttSession session = newTestSession(
        transport: t,
        tokenStorage: store,
        lanFingerprintLearner: (Uri url, Duration timeout) async => null,
      )..candidateProbeTimeout = const Duration(milliseconds: 20);
      addTearDown(session.dispose);
      session.healthReader = (Uri url, Duration timeout) async =>
          const HealthReading(ok: true, channel: ServerChannel.lan);

      final PairResult r =
          await session.pair(PairEntry.parse('1234'), endpoint: '$kLan:$kPort');
      expect(r.ok, isTrue);
      expect(t.lastConnectUrl, '$kLan:$kPort');
      expect(t.lastConnectPin, isNull);
      expect((await store.readPairings()).single.lanTlsFp, isNull);
    });

    test('a cloud instance is never TOFU —— the relay has a real CA chain; pinning it is a different (wrong) thing', () async {
      final FakeSocketTransport t = FakeSocketTransport()
        ..connectSucceeds = true
        ..defaultAck = ackWithToken();
      bool looked = false;
      final PttSession session = newTestSession(
        transport: t,
        lanFingerprintLearner: (Uri url, Duration timeout) async {
          looked = true;
          return kExpectedFingerprint;
        },
      )..candidateProbeTimeout = const Duration(milliseconds: 20);
      addTearDown(session.dispose);
      session.healthReader = (Uri url, Duration timeout) async =>
          const HealthReading(ok: true, channel: ServerChannel.cloudRelay);

      await session.pair(PairEntry.cloud(), endpoint: 'https://flowmic.app');
      expect(looked, isFalse);
      expect(t.lastConnectPin, isNull);
    });

    test('🔴 a pin that cannot possibly be checked ⇒ refuse on the spot, never quietly degrade to plaintext', () async {
      // Walk real SocketCore (not a stand-in): this criterion is its own.
      final SocketCore core = SocketCore();
      addTearDown(core.close);
      await expectLater(
        core.connect(url: 'ws://$kLan:$kPort', pinFingerprint: kExpectedFingerprint),
        throwsA(isA<SocketHandshakeException>()),
      );
      // The plaintext half is unchanged: without a pin it will not even try
      // to verify.
      expect(core.lastLinkEncryption, LinkEncryption.unknown);
    });
  });

  // ── ⑤ Fingerprint mismatch ≠ unreachable (design §3-5 / §6-4) ────────────
  group('⑤ loud, and distinguishable', () {
    test('codec: pin_mismatch is its own bucket, does not degrade to unreachable', () {
      final String code = encodeCandidateFailure(
        attempts: const <CandidateAttempt>[],
        dialed: 'wss://$kLan:$kPort',
        dialedPinMismatch: true,
      );
      final List<MapEntry<String, CandidateFailure>> back =
          decodeCandidateFailure(code)!;
      expect(back.single.value, CandidateFailure.pinMismatch);

      final String plain = encodeCandidateFailure(
        attempts: const <CandidateAttempt>[],
        dialed: 'ws://$kLan:$kPort',
      );
      expect(decodeCandidateFailure(plain)!.single.value,
          CandidateFailure.dialFailed);
    });

    test('🔴 measured in both directions: a wrong fingerprint and unreachable are two different sentences on the UI', () async {
      // This is the card's core acceptance. Both dials fail; the **reason**
      // for the failure is different; the three stretches the user reads
      // (opening / per-address / closing) must all differ — because the
      // remedies are opposite: one goes check the network, one goes re-pair.
      Future<String?> pairAndGetCode({required bool pinMismatch}) async {
        final _DeadTransport t = _DeadTransport()..pinMismatch = pinMismatch;
        final PttSession session = newTestSession(transport: t)
          ..candidateProbeTimeout = const Duration(milliseconds: 20);
        addTearDown(session.dispose);
        session.healthReader = (Uri url, Duration timeout) async =>
            const HealthReading(ok: true, channel: ServerChannel.lan);
        // With alt ⇒ two candidates, both walk the same "per-address report"
        // path: so the difference between the two stretches of copy can only
        // come from the failure **reason**, not from walking two different
        // code paths.
        final PairResult r = await session.pair(
          PairEntry.parse(qr(fp: kExpectedFingerprint, alt: kAlt)),
          endpoint: 'ws://$kLan:$kPort',
        );
        expect(r.ok, isFalse);
        return r.error;
      }

      final String mismatchCode = (await pairAndGetCode(pinMismatch: true))!;
      final String deadCode = (await pairAndGetCode(pinMismatch: false))!;
      expect(mismatchCode, isNot(deadCode));

      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String mismatchCopy = s.pairError(mismatchCode);
        final String deadCopy = s.pairError(deadCode);
        expect(mismatchCopy, isNot(deadCopy), reason: '$locale the two failures said the same sentence');
        expect(mismatchCopy, isNotEmpty);
        // The unreachable bucket still points the person at the network; the
        // identity-mismatch bucket **must not** still say that.
        expect(
          deadCopy.contains(_networkWord(locale)),
          isTrue,
          reason: '$locale: the unreachable bucket lost the "network" action',
        );
        expect(
          mismatchCopy.contains(_networkWord(locale)),
          isFalse,
          reason: '$locale: identity mismatch is still sending the user to check the network',
        );
      }
    });

    test('a single address must also be clear —— this used to fall back to a one-line exception raw text', () async {
      final _DeadTransport t = _DeadTransport()..pinMismatch = true;
      final PttSession session = newTestSession(transport: t)
        ..candidateProbeTimeout = const Duration(milliseconds: 20);
      addTearDown(session.dispose);
      session.healthReader = (Uri url, Duration timeout) async =>
          const HealthReading(ok: true, channel: ServerChannel.lan);
      // No alt ⇒ only one candidate ⇒ chooseDialEndpoint runs not one probe
      // ⇒ attempts is empty.
      final PairResult r = await session.pair(
        PairEntry.parse(qr(fp: kExpectedFingerprint)),
        endpoint: 'ws://$kLan:$kPort',
      );
      expect(r.error, startsWith(kCandidateFailurePrefix));
      expect(decodeCandidateFailure(r.error)!.single.value,
          CandidateFailure.pinMismatch);
    });
  });

  // ── ⑥ Disclosure: assertions land on the render result (0.2.53 rule) ─────
  group('⑥ TOFU disclosure in four locales', () {
    Widget host(Widget child, {double width = 360}) => MaterialApp(
      home: Scaffold(
        body: Center(child: SizedBox(width: width, child: child)),
      ),
    );

    testWidgets('the three buckets each say their own sentence, and they differ (four locales)', (WidgetTester tester) async {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(s.diagEncryptionVerified, isNot(s.diagEncryptionTofu));
        expect(s.diagEncryptionTofu, isNot(s.diagEncryptionPlain));
        expect(s.diagEncryptionTofuNote, isNotEmpty);
        expect(s.diagEncryptionScopeNote, isNotEmpty);
      }

      // Not measured ⇒ the whole stretch is not painted ("not measured" must
      // not be painted as "unencrypted").
      await tester.pumpWidget(host(DiagnosticsEncryptionSection(
        strings: AppStrings.of(AppLocale.zh),
        encryption: LinkEncryption.unknown,
        pinSource: null,
      )));
      expect(find.byType(Text), findsNothing);
    });

    testWidgets('🔴 the TOFU disclosure sentence renders in full in all four locales, not clipped', (WidgetTester tester) async {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(host(
          DiagnosticsEncryptionSection(
            strings: s,
            encryption: LinkEncryption.pinnedTls,
            pinSource: LanPinSource.tofu,
          ),
          // Ahem is a full-em square, much wider than a real font (measured
          // on the 0.2.53 card). Widening to 600 is **a product of the font,
          // not a product defect**; this direction is still conservative:
          // unclipped here ⇒ unclipped on a real device, the converse does
          // not hold.
          width: 600,
        ));
        final Finder note = find.text(s.diagEncryptionTofuNote);
        expect(note, findsOneWidget, reason: '$locale is missing the disclosure sentence');

        // Positive control: this sentence **really is** too long for one
        // line — otherwise "not clipped" proves nothing.
        final Text w = tester.widget<Text>(note);
        expect(
          _intrinsicWidth(w),
          greaterThan(tester.getSize(note).width),
          reason: '$locale sample too short, this test is blind to the regression',
        );
        // 🔴 Assert on the render result, not Text.data.
        expect(_clipped(tester, note), isFalse, reason: '$locale disclosure sentence was clipped');
      }
    });

    testWidgets('the scan bucket does not paint the TOFU sentence; both buckets paint "does not stop an active attacker"', (WidgetTester tester) async {
      final AppStrings s = AppStrings.of(AppLocale.zh);
      await tester.pumpWidget(host(
        DiagnosticsEncryptionSection(
          strings: s,
          encryption: LinkEncryption.pinnedTls,
          pinSource: LanPinSource.qr,
        ),
        width: 600,
      ));
      expect(find.text(s.diagEncryptionVerified), findsOneWidget);
      expect(find.text(s.diagEncryptionTofuNote), findsNothing);
      expect(find.text(s.diagEncryptionScopeNote), findsOneWidget);

      // The unencrypted bucket: do not paint capability talk (that sentence
      // is about encryption), only say unencrypted.
      await tester.pumpWidget(host(
        DiagnosticsEncryptionSection(
          strings: s,
          encryption: LinkEncryption.plain,
          pinSource: null,
        ),
        width: 600,
      ));
      expect(find.text(s.diagEncryptionPlain), findsOneWidget);
      expect(find.text(s.diagEncryptionScopeNote), findsNothing);
    });
  });
}

/// The word in each "unreachable" copy that points the user at the network.
/// The identity-mismatch bucket must not contain it.
///
/// Nine-locale expansion (2026-08-14): the table itself moved to
/// `support/locale_terms.dart`, sharing the same symbol with
/// `pin_mismatch_surface_test.dart` — that file originally declared "same
/// origin as this file" in a comment, and **a comment asserting other code's
/// behavior** (anti-façade ④) does not change when the other place changes.
String _networkWord(AppLocale locale) => networkWord(locale);

/// A connection that can never be dialed, and can say **why** it cannot.
class _DeadTransport extends FakeSocketTransport {
  bool pinMismatch = false;

  @override
  Future<void> connect({
    required String url,
    String? token,
    String? jwt,
    String? pinFingerprint,
  }) async {
    lastConnectUrl = url;
    lastConnectPin = pinFingerprint;
    lastDialPinMismatch = pinMismatch;
    throw SocketHandshakeException(
      pinMismatch ? 'HandshakeException: certificate refused' : 'timed out',
    );
  }
}

String _hex(List<int> bytes) =>
    bytes.map((int b) => b.toRadixString(16).padLeft(2, '0')).join();

/// Start of [needle] in [hay], -1 = not in.
int _indexOfBytes(Uint8List hay, Uint8List needle) {
  for (int i = 0; i + needle.length <= hay.length; i++) {
    bool ok = true;
    for (int j = 0; j < needle.length; j++) {
      if (hay[i + j] != needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}
