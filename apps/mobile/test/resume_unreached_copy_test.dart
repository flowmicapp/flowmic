// NR-279 (A3) — tapping an offline, ALREADY-PAIRED computer must not say
// 「Pairing failed」: no pairing is attempted on that path.
//
// Root cause: .local/device-evidence/0315-upgrade/rca-anomalies.md §3 —
// `resumePairing` reported null for every dial failure that was not one of
// `handshakeRefusal`'s named codes, so the row toast was `pairError(null)` =
// 「Pairing failed — check the network and try again」, although the phone had
// just measured which addresses it could not reach.
//
// What this pins: the code `resumePairing` leaves on `lastReconnectRefusal`
// (which `ConnectionsController.connectTo` passes, unchanged, to the row's
// `pairError`), and the sentence `pairError` picks for it. All sentences are
// EXISTING keys (pairError__15, pairCandidatesFailed__*, and for
// AUTH_TOKEN_UNVERIFIABLE cloudError_AUTH_TOKEN_UNVERIFIABLE); no new copy.

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/endpoint_candidates.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/socket_core.dart'
    show SocketHandshakeException;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// Nothing is listening: the dial throws with transport words (or, when
/// [err] is a registry-shaped code, the other side refused by name).
class _DeadTransport extends FakeSocketTransport {
  _DeadTransport(this._err);
  final String? _err;

  @override
  Future<void> connect({
    required String url,
    String? token,
    String? jwt,
    String? pinFingerprint,
  }) async {
    final String? e = _err;
    if (e != null) setLastConnectError(e);
    throw SocketHandshakeException(e ?? 'connection refused');
  }
}

Future<String?> _resume(
  MobileSession pairing, {
  String? err = 'websocket error',
}) async {
  final PttSession session = newTestSession(transport: _DeadTransport(err));
  addTearDown(session.dispose);
  session.healthReader =
      (Uri url, Duration timeout) async => HealthReading.offline;
  expect(await session.resumePairing(pairing), isFalse);
  return session.lastReconnectRefusal?.code;
}

const String _lanA = 'http://100.64.7.68:41879';
const String _lanB = 'http://10.0.0.68:41879';

void main() {
  group('🔴 NR-279 A3 — an unreachable remembered computer', () {
    test('single LAN address ⇒ 「None of these addresses reached the computer」 naming it, not 「Pairing failed」', () async {
      final String? code = await _resume(
        MobileSession(token: 't' * 32, endpoint: _lanA),
      );
      final List<MapEntry<String, CandidateFailure>>? tried =
          decodeCandidateFailure(code);
      expect(tried, isNotNull, reason: 'the dial outcome was dropped again');
      expect(tried!.single.key, _lanA);
      expect(tried.single.value, CandidateFailure.dialFailed);
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings(locale);
        final String shown = s.pairError(code);
        expect(shown, s.pairCandidatesFailed(tried),
            reason: '$locale: the existing per-address sentence');
        expect(shown, contains(_lanA), reason: '$locale');
        expect(shown, isNot(s.pairError(null)),
            reason: '$locale: still the generic 「Pairing failed」 sentence');
      }
    });

    test('relay row (TLS, unpinned, one address) ⇒ 「Could not reach the computer」, no same-network advice', () async {
      final String? code = await _resume(
        MobileSession(token: 't' * 32, endpoint: 'https://relay.example'),
      );
      expect(code, kConnectFailedCode);
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings(locale);
        expect(s.pairError(code), s.pairError('CONNECT_FAILED: x'),
            reason: '$locale: the sentence pair() uses for the same fact');
        expect(s.pairError(code), isNot(s.pairError(null)), reason: '$locale');
      }
    });

    test('several remembered addresses ⇒ each one is named with what it answered', () async {
      final String? code = await _resume(
        MobileSession(
          token: 't' * 32,
          endpoint: _lanA,
          endpointCandidates: const <String>[_lanB],
        ),
      );
      final List<MapEntry<String, CandidateFailure>>? tried =
          decodeCandidateFailure(code);
      expect(tried, isNotNull, reason: 'the probe outcome was dropped again');
      expect(
        tried!.map((MapEntry<String, CandidateFailure> e) => e.key).toList(),
        <String>[_lanA, _lanB],
      );
      expect(tried.first.value, CandidateFailure.dialFailed,
          reason: 'the dialled one failed to connect');
      expect(tried.last.value, CandidateFailure.unreachable);
      expect(tried.any((MapEntry<String, CandidateFailure> e) =>
          e.value == CandidateFailure.pinMismatch), isFalse,
          reason: 'a dead address must not be painted as a key change');
      final AppStrings en = AppStrings(AppLocale.en);
      final String shown = en.pairError(code);
      expect(shown, contains(_lanA));
      expect(shown, contains(_lanB));
      expect(shown, isNot(en.pairError(null)));
    });

    test('reverse control: the other side answered BY NAME ⇒ unchanged (generic), never 「could not reach」', () async {
      // A registry-shaped code we do not recognise means something DID answer;
      // 「could not reach」 would be false. handshakeRefusal's rule.
      expect(
        await _resume(MobileSession(token: 't' * 32, endpoint: _lanA),
            err: 'Error: SOME_NEW_SERVER_CODE'),
        isNull,
      );
      // …while the two codes it knows still win over the measurement.
      expect(
        await _resume(MobileSession(token: 't' * 32, endpoint: _lanA),
            err: 'Error: AUTH_TOKEN_INVALID'),
        'AUTH_TOKEN_INVALID',
      );
    });

    test('the light-record (cloud instance) row is untouched — it has no computer', () async {
      expect(
        await _resume(MobileSession(
          token: 't' * 32,
          endpoint: 'https://relay.example/ws',
          channel: 'saas',
        )),
        isNull,
      );
    });
  });

  group('🔴 NR-279 A3 — AUTH_TOKEN_UNVERIFIABLE on a computer row', () {
    test('the resume path surfaces the code (positive control for the copy below)', () async {
      expect(
        await _resume(MobileSession(token: 't' * 32, endpoint: _lanA),
            err: 'Error: AUTH_TOKEN_UNVERIFIABLE'),
        'AUTH_TOKEN_UNVERIFIABLE',
      );
    });

    test('「try again shortly」 (the existing NR-17 sentence), not 「Pairing failed · diagnostic code」', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings(locale);
        final String shown = s.pairError('AUTH_TOKEN_UNVERIFIABLE');
        expect(shown, s.cloudError('AUTH_TOKEN_UNVERIFIABLE'),
            reason: '$locale: one fact, one sentence, on both rows');
        expect(shown, isNot(contains('AUTH_TOKEN_UNVERIFIABLE')),
            reason: '$locale: an identifier was printed at the user');
        expect(shown, isNot(s.pairError('AUTH_TOKEN_INVALID')),
            reason: '$locale: 「could not confirm」 must not read as 「revoked」');
      }
    });
  });

  test('unreachedDialCode — pure rule', () {
    const List<CandidateAttempt> none = <CandidateAttempt>[];
    expect(
        unreachedDialCode(
            lastConnectError: null, attempts: none, dialed: _lanA, lanRow: false),
        kConnectFailedCode);
    expect(
        decodeCandidateFailure(unreachedDialCode(
                lastConnectError: 'timeout',
                attempts: none,
                dialed: _lanA,
                lanRow: true))!
            .single
            .key,
        _lanA);
    expect(
        unreachedDialCode(
            lastConnectError: 'Error: NODE_IS_REPLICA',
            attempts: none,
            dialed: _lanA,
            lanRow: true),
        isNull);
  });

  test('rememberedRowIsLan — what the stored row says', () {
    expect(rememberedRowIsLan(endpoint: _lanA, lanTlsFp: null, endpointCandidates: const <String>[]), isTrue,
        reason: 'plain http is a LAN pairing');
    expect(rememberedRowIsLan(endpoint: 'https://192.168.1.9:41879', lanTlsFp: 'fp', endpointCandidates: const <String>[]), isTrue,
        reason: 'pinned is LAN');
    expect(rememberedRowIsLan(endpoint: 'https://192.168.1.9:41879', lanTlsFp: null, endpointCandidates: const <String>[_lanB]), isTrue,
        reason: 'alternate addresses come only from a LAN QR');
    expect(rememberedRowIsLan(endpoint: 'https://relay.example', lanTlsFp: null, endpointCandidates: const <String>[]), isFalse,
        reason: 'TLS, unpinned, one address ⇒ relay');
  });
}
