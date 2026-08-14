// 🔴 owner 2026-08-03 ——「配对失败：未知错误，这里应根据情况，如果是 PC 端取消了配对，
// 要显示 PC 端已取消配对，请重新配对连接，如果是其它未知的再显示未知异常。」
//
// This is **not a copy problem**; it is a real defect: the server answered by
// name, and the resume path threw the answer away.
//
//   「撤销配对」 on the PC deletes that row from `mobile_pairings` (`pc.handler.ts`
//   calling `registry.revokeMobile(...)`)
//   ⇒ this phone's token is refused in the **handshake middleware**
//   (`auth/middleware.ts`, the `AUTH_TOKEN_INVALID` branch)
//   ⇒ the `mobile:reconnect` frame never gets a chance to go out ⇒ **no ack, no error field**
//   ⇒ `resumePairing`'s catch just `return false`, the UI reads null, and answers 「未知错误」
//
// And the answer has been sitting on `transport.lastConnectError` the whole time —
// `runMobileReconnect` itself reads it that way (its `invalid` predicate looks at
// both the ack and lastConnectError); the resume path just returned before it
// got there. **The fact arrived, was dropped, then a 「unknown」 was invented**
// (the L-② shape).
//
// ⚠️ The reverse control is the second test: transport-layer raw words
// (`xhr poll error` / `timeout`) **must not** be read as a server verdict.
// 「we never got an answer」 and 「the server said X」 reading the same is the
// entire reason the `ReconnectRefusal` class exists.

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/mobile_reconnect_flow.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketHandshakeException;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// Handshake-refused fake: `connect()` throws and leaves the server's original
/// words — that is exactly what the real `SocketCore` does (`socket_core.dart`
/// `onConnectError` records `_lastConnectError` then completeError).
class _RefusingTransport extends FakeSocketTransport {
  _RefusingTransport(this._err);
  final String _err;

  @override
  Future<void> connect({
    required String url,
    String? token,
    String? jwt,
    String? pinFingerprint,
  }) async {
    setLastConnectError(_err);
    throw SocketHandshakeException(_err);
  }
}

Future<String?> _codeAfterResume(String handshakeError) async {
  final _RefusingTransport transport = _RefusingTransport(handshakeError);
  final PttSession session = newTestSession(transport: transport);
  addTearDown(session.dispose);
  session.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;

  final bool ok = await session.resumePairing(
    MobileSession(token: 't' * 32, endpoint: 'http://192.0.2.5:55889'),
  );
  expect(ok, isFalse, reason: 'handshake was refused yet returned success');
  return session.lastReconnectRefusal?.code;
}

void main() {
  test('PC revoked the pairing ⇒ handshake refused ⇒ UI gets the server code, not null', () async {
    expect(
      await _codeAfterResume('AUTH_TOKEN_INVALID'),
      'AUTH_TOKEN_INVALID',
      reason: 'the answer was dropped at the handshake layer ⇒ the UI would again say 「未知错误」',
    );
  });

  test('reverse control: transport-layer raw words must not impersonate a server verdict', () async {
    // Both of these are 「we never got an answer」. Impersonating AUTH_TOKEN_INVALID
    // would send the user to re-pair a pairing that is actually fine — the
    // mirror of the error the L-② round already fixed.
    expect(await _codeAfterResume('xhr poll error'), isNull);
    expect(await _codeAfterResume('timeout'), isNull);
  });

  test('handshakeRefusal only recognises the one code it knows', () {
    final FakeSocketTransport t = FakeSocketTransport();
    expect(handshakeRefusal(t), isNull, reason: 'must not invent a code when nothing happened');
    t.setLastConnectError('Error: AUTH_TOKEN_INVALID');
    expect(handshakeRefusal(t)?.code, 'AUTH_TOKEN_INVALID');
    t.setLastConnectError('websocket error');
    expect(handshakeRefusal(t), isNull);
  });

  group('copy: say 「why」 and 「what to do」, in all four languages', () {
    for (final AppLocale locale in AppLocale.values) {
      test(locale.name, () {
        final AppStrings s = AppStrings(locale);
        final String shown = s.pairError('AUTH_TOKEN_INVALID');

        // ① Must not fall back into that generic catch-all sentence.
        expect(shown, isNot(equals(s.pairError(null))), reason: 'still the 「未知错误」 sentence');
        expect(shown, isNot(contains('AUTH_TOKEN_INVALID')), reason: 'dumped a wire identifier on the user');

        // ② This sentence must give both the reason and the action — owner's
        //    original words were exactly those two halves.
        //    Assert 「it differs from the other branches」, not a hardcoded
        //    full sentence: the copy will still be polished, and 「it has to be
        //    this code's own sentence」 will not change.
        expect(shown, isNot(equals(s.pairError('PAIR_RELEASED'))));
        expect(shown, isNot(equals(s.pairError('PC_BUSY'))));
        expect(shown.length, greaterThan(12), reason: 'too short to possibly say reason + action');

        // ③ 🔴 It answers that the **pairing** is gone, not that the **account**
        //    login expired. The old copy 「登录已失效」 sent people to check login,
        //    and this path has no account at all (the cloud path has its own
        //    branch in cloudError).
        for (final String wrong in <String>['登录', 'Session expired', 'ログイン', '로그인']) {
          expect(shown, isNot(contains(wrong)), reason: '$locale is still calling this a login problem');
        }
      });
    }
  });

  test('the cloud path must not be dragged off course by this change: it answers login, not pairing', () {
    // Positive control: `cloudError` has its own AUTH_TOKEN_INVALID branch, so
    // it **must not** equal the sentence above. Without this one, changing
    // pairError to pairing semantics could silently pollute the cloud-login hint.
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings(locale);
      expect(
        s.cloudError('AUTH_TOKEN_INVALID'),
        isNot(equals(s.pairError('AUTH_TOKEN_INVALID'))),
        reason: '$locale: cloud login expired and PC pairing revoked were said as the same thing',
      );
    }
  });
}
