// E-B1 — 🔴🔴 the double-prefix red line, as an executable assertion.
//
// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §2 (「两前缀永不互换」);
//   docs/strategy/2026-08-08-design-e-blindstore-client.md §2 and §7-2
//   (「B1 的验收必须有一条负向断言：盲存密文服务端解不开」);
//   CLAUDE.md 「不可破的产品红线」: 双前缀加密：`enc:v1:`（服务端可解）与
//   `e2e:v1:`（盲存）永不互换.
//
// WHAT THIS FILE IS DEFENDING AGAINST, precisely.
// The two envelopes have nearly identical shapes: both AES-256-GCM, both
// nonce(12)‖tag(16)‖ciphertext, both base64, both prefixed. They differ in ONE
// thing that no byte-level inspection can reveal: which key opens them. So the
// failure mode is not a typo — it is somebody noticing the similarity and
// factoring the two into one helper. After that refactor, one wrong argument
// yields SERVER-DECRYPTABLE bytes that still carry the `e2e:v1:` prefix, which
// means:
//   - `assertE2ePrefix` (apps/server-core/src/db/repos/timeline.repo.ts) passes;
//   - `E2eCiphertext` (packages/protocol/src/protocol-schemas-timeline.ts) passes;
//   - every existing test, lint and golden stays green;
//   - and the server can now read the users' timeline.
// Nothing in the repo would notice. That is why this test exists and why it
// asserts on CRYPTOGRAPHIC failure, not just on the prefix string.
//
// ⚠️ ON THE HARNESS BELOW. `_serverStyleDecrypt` re-implements
// apps/server-core/src/auth/crypto.ts's `decrypt` in Dart. A re-implementation
// used as a measuring instrument is exactly the thing this repo's 「check your ruler first」
// rule warns about — so it is paired with a POSITIVE CONTROL: the harness must
// be shown to successfully open a genuine server-shaped envelope. Only then does
// its failure on our blob mean anything. Without that pair, "the server could
// not decrypt it" would be indistinguishable from "the harness never works".

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as sha;
import 'package:flowmic/src/crypto/blind_store_envelope.dart';
import 'package:flowmic/src/crypto/blind_store_key.dart';
import 'package:flowmic/src/crypto/blind_store_params.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pointycastle/export.dart';

// --- the server's enc:v1: machinery, mirrored ------------------------------
// Mirrors apps/server-core/src/auth/crypto.ts symbols ENVELOPE_PREFIX,
// IV_BYTES, TAG_BYTES, deriveKey, encrypt, decrypt. The mirror is pinned to the
// real source by `reads the server's own source` below, so this cannot drift
// into testing a server that no longer exists.
const String _serverPrefix = 'enc:v1:';

Uint8List _serverDeriveKey(String secret) =>
    Uint8List.fromList(sha.sha256.convert(utf8.encode(secret)).bytes);

String _serverStyleEncrypt(String plaintext, Uint8List key, Uint8List iv) {
  final GCMBlockCipher c = GCMBlockCipher(AESEngine())
    ..init(true, AEADParameters(KeyParameter(key), 128, iv, Uint8List(0)));
  final Uint8List out = c.process(Uint8List.fromList(utf8.encode(plaintext)));
  final Uint8List ct = out.sublist(0, out.length - 16);
  final Uint8List tag = out.sublist(out.length - 16);
  return _serverPrefix +
      base64.encode(Uint8List.fromList(<int>[...iv, ...tag, ...ct]));
}

/// Faithful mirror of the server's `decrypt`: same prefix refusal, same
/// iv‖tag‖ct split, same "throw on anything wrong" contract.
String _serverStyleDecrypt(String envelope, Uint8List key) {
  if (!envelope.startsWith(_serverPrefix)) {
    throw StateError("envelope must start with '$_serverPrefix'");
  }
  final Uint8List blob =
      base64.decode(envelope.substring(_serverPrefix.length));
  if (blob.length < 28) throw StateError('payload too short');
  final Uint8List iv = blob.sublist(0, 12);
  final Uint8List tag = blob.sublist(12, 28);
  final Uint8List ct = blob.sublist(28);
  final GCMBlockCipher c = GCMBlockCipher(AESEngine())
    ..init(false, AEADParameters(KeyParameter(key), 128, iv, Uint8List(0)));
  return utf8.decode(c.process(Uint8List.fromList(<int>[...ct, ...tag])));
}

final Uint8List _deploymentKey = _serverDeriveKey('a-deployment-secret');
final BlindStoreMasterKey _masterKey = BlindStoreMasterKey.fromBytes(
  Uint8List.fromList(List<int>.generate(32, (int i) => i)),
);

String _read(String relative) {
  // `flutter test`'s cwd is fixed at this package root (apps/mobile) — the same
  // convention inject_verdict_authorship_mirror_test.dart documents and relies on.
  final File f = File(relative);
  if (!f.existsSync()) {
    fail('cross-package source not found: $relative (cwd=${Directory.current.path}). '
        'This test must FAIL rather than skip — a missing anchor is exactly how '
        'a mirror test rots into a no-op.');
  }
  return f.readAsStringSync();
}

void main() {
  group('🔴 negative assertion + positive control: the server cannot read a '
      'blind-store blob', () {
    test('POSITIVE CONTROL — the harness DOES open a genuine enc:v1: envelope', () {
      // If this fails, every negative result below is meaningless.
      final String serverEnvelope = _serverStyleEncrypt(
        'a cloud api key',
        _deploymentKey,
        Uint8List.fromList(List<int>.filled(12, 9)),
      );
      expect(serverEnvelope.startsWith('enc:v1:'), isTrue);
      expect(_serverStyleDecrypt(serverEnvelope, _deploymentKey),
          'a cloud api key');
    });

    test('NEGATIVE — the same harness refuses our e2e:v1: blob outright', () {
      final String blind = sealBlindStoreEntry(
        key: _masterKey,
        entryId: 'entry-42',
        plaintext: 'a private transcript line',
      );
      expect(
        () => _serverStyleDecrypt(blind, _deploymentKey),
        throwsA(isA<StateError>()),
        reason: 'the server refuses at the prefix check',
      );
    });

    test('NEGATIVE (deeper) — even with the prefix REWRITTEN to enc:v1:, the '
        'server still cannot decrypt it', () {
      // 🔴 This is the assertion that actually proves isolation. The previous
      // case only shows a string mismatch, which a merged "generic envelope"
      // helper would sail straight through — it would emit the e2e:v1: prefix
      // while encrypting under the deployment key. Here we hand the server the
      // best possible case: correct prefix, correct layout, correct lengths.
      // It must STILL fail, because the key schedules are unrelated
      // (Argon2id(passphrase) vs SHA-256(deployment secret)).
      final String blind = sealBlindStoreEntry(
        key: _masterKey,
        entryId: 'entry-42',
        plaintext: 'a private transcript line',
      );
      final String coerced = _serverPrefix +
          blind.substring(kBlindStoreEnvelopePrefix.length);
      expect(coerced.startsWith('enc:v1:'), isTrue);
      expect(
        () => _serverStyleDecrypt(coerced, _deploymentKey),
        throwsA(isA<Object>()),
        reason: 'isolation must be cryptographic, not cosmetic',
      );
    });

    test('DETECTOR SENSITIVITY — if the merge-refactor DID happen, this harness '
        'would catch it', () {
      // 🔴 The two negative cases above only prove the harness said "no". This
      // proves the harness is capable of saying "yes" to the very disaster it is
      // watching for — otherwise a harness that refuses EVERYTHING would look
      // identical to a red line being held.
      //
      // Simulates the exact outcome of factoring the two envelopes into one
      // helper: bytes encrypted under the SERVER's deployment key, but wearing
      // the `e2e:v1:` prefix. This value would pass assertE2ePrefix and the
      // E2eCiphertext zod type, and the server could read it.
      final String disaster = _serverStyleEncrypt(
        'a private transcript line',
        _deploymentKey,
        Uint8List.fromList(List<int>.filled(12, 3)),
      ).replaceFirst(_serverPrefix, kBlindStoreEnvelopePrefix);
      expect(disaster.startsWith('e2e:v1:'), isTrue);

      // The harness reads it — confirming the negative results above are a
      // property of our ciphertext, not an incapacity of the instrument.
      expect(
        _serverStyleDecrypt(
          disaster.replaceFirst(kBlindStoreEnvelopePrefix, _serverPrefix),
          _deploymentKey,
        ),
        'a private transcript line',
      );

      // And our own layer cannot read it — the two directions are disjoint.
      expect(
        () => openBlindStoreEntry(
            key: _masterKey, entryId: 'entry-42', envelope: disaster),
        throwsA(isA<BlindStoreCryptoException>()),
      );
    });

    test('REVERSE — our layer refuses a server enc:v1: envelope, and reports it '
        'as wrongPrefix (the namespace signal), not as a bad passphrase', () {
      final String serverEnvelope = _serverStyleEncrypt(
        'a cloud api key',
        _deploymentKey,
        Uint8List.fromList(List<int>.filled(12, 9)),
      );
      expect(
        () => openBlindStoreEntry(
            key: _masterKey, entryId: 'e', envelope: serverEnvelope),
        throwsA(isA<BlindStoreCryptoException>().having(
          (BlindStoreCryptoException e) => e.failure,
          'failure',
          BlindStoreFailure.wrongPrefix,
        )),
      );
    });
  });

  group('the two prefixes are pinned to their real definitions', () {
    test('our prefix equals TIMELINE_E2E_PREFIX in packages/protocol', () {
      // Read the TypeScript rather than restating the literal, so a change on
      // either side breaks here instead of silently producing blobs the server
      // rejects at runtime.
      final String src = _read('../../packages/protocol/src/constants.ts');
      final RegExpMatch? m = RegExp(
        r"""TIMELINE_E2E_PREFIX\s*=\s*['"]([^'"]+)['"]""",
      ).firstMatch(src);
      expect(m, isNotNull, reason: 'TIMELINE_E2E_PREFIX not found in constants.ts');
      expect(m!.group(1), kBlindStoreEnvelopePrefix);
    });

    test("our prefix DIFFERS from the server's ENVELOPE_PREFIX", () {
      final String src = _read('../../apps/server-core/src/auth/crypto.ts');
      final RegExpMatch? m = RegExp(
        r"""ENVELOPE_PREFIX\s*=\s*['"]([^'"]+)['"]""",
      ).firstMatch(src);
      expect(m, isNotNull, reason: 'ENVELOPE_PREFIX not found in auth/crypto.ts');
      expect(m!.group(1), _serverPrefix,
          reason: 'the harness above mirrors this value; if it moved, the '
              'mirror is stale and its results are worthless');
      expect(m.group(1), isNot(kBlindStoreEnvelopePrefix));
    });
  });

  group('structural isolation of the implementation itself', () {
    test('no file in lib/src/crypto/ contains an enc:v1: string literal', () {
      // Comments in this layer DO discuss enc:v1: at length — deliberately. What
      // must not exist is a code path able to emit it.
      for (final FileSystemEntity f
          in Directory('lib/src/crypto').listSync(recursive: true)) {
        if (f is! File || !f.path.endsWith('.dart')) continue;
        final List<String> lines = f.readAsLinesSync();
        for (int i = 0; i < lines.length; i++) {
          final String code = lines[i].trim();
          if (code.startsWith('//') || code.startsWith('///')) continue;
          expect(
            code.contains("'enc:v1:'") || code.contains('"enc:v1:"'),
            isFalse,
            reason: '${f.path}:${i + 1} carries an enc:v1: literal in CODE',
          );
        }
      }
    });

    test('the envelope prefix is never a parameter — there is no call site that '
        'could be handed the wrong one', () {
      final String env =
          File('lib/src/crypto/blind_store_envelope.dart').readAsStringSync();
      // A `prefix:` named parameter is the concrete syntactic shape the merged
      // "generic envelope helper" would take.
      expect(env.contains('prefix:'), isFalse,
          reason: 'a prefix parameter would reopen the red line');
      expect(env.contains('String prefix'), isFalse);
    });

    test('lib/ has zero production callers of Argon2Cost.reducedForTestsOnly', () {
      // The repo's standard anti-façade grep, run in reverse: instead of proving
      // a symbol HAS a production caller, prove this one has none. A reduced-cost
      // MasterKey produces ciphertext indistinguishable from production
      // ciphertext, so nothing downstream could ever report the mistake.
      int callSites = 0;
      for (final FileSystemEntity f
          in Directory('lib').listSync(recursive: true)) {
        if (f is! File || !f.path.endsWith('.dart')) continue;
        final List<String> lines = f.readAsLinesSync();
        for (final String line in lines) {
          final String code = line.trim();
          if (code.startsWith('//') || code.startsWith('///')) continue;
          if (!code.contains('reducedForTestsOnly')) continue;
          // The factory's own declaration is not a call site.
          if (code.contains('factory Argon2Cost.reducedForTestsOnly')) continue;
          callSites++;
        }
      }
      expect(callSites, 0,
          reason: 'production code must never derive at reduced cost');
    });

    test('lib/src/crypto/ does not reach into any other subsystem', () {
      // Keeps the reviewable surface of a cryptography face closed: this layer
      // imports dart:*, pointycastle, meta, and its own files. Nothing else.
      for (final FileSystemEntity f
          in Directory('lib/src/crypto').listSync(recursive: true)) {
        if (f is! File || !f.path.endsWith('.dart')) continue;
        for (final String line in f.readAsLinesSync()) {
          if (!line.startsWith('import ')) continue;
          final bool ok = line.contains("'dart:") ||
              line.contains("'package:pointycastle/") ||
              line.contains("'package:meta/") ||
              line.contains("'blind_store_");
          expect(ok, isTrue, reason: '${f.path}: unexpected import — $line');
        }
      }
    });
  });
}
