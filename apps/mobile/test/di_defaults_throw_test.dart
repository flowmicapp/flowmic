// RV-20 / D5 — DI seams are required (compile-time), not friendly empty defaults
// (13 册 §7 F1 ②). AudioCapture.recorder / TimelineStore.persistence /
// PttSession.tokenStorage / LoginController.accountStore: omitting any of them
// is a compile error. These tests prove the required seams still accept an
// explicit test double (via newTest* helpers or direct InMemory*).

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

void main() {
  test('AudioCapture requires a recorder — constructing with one succeeds '
      '(omitting recorder is a compile error; no friendly NOOP default)', () {
    final AudioCapture cap = AudioCapture(recorder: FakeAudioRecorder());
    expect(cap.currentState, RecorderState.idle);
    cap.dispose();
  });

  test('PttSession requires TokenStorage — newTestSession injects InMemory '
      '(omitting tokenStorage on PttSession is a compile error)', () {
    final PttSession session = newTestSession(
      transport: FakeSocketTransport(),
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    expect(session.tokenStorage, isA<InMemoryTokenStorage>());
    session.dispose();
  });

  test('LoginController requires AccountStore — newTestLogin injects InMemory '
      '(omitting accountStore on LoginController is a compile error)', () {
    final LoginController login = newTestLogin(
      transport: FakeSocketTransport(),
    );
    expect(login, isA<LoginController>());
    // Direct required-arg construction also works with an explicit double.
    final LoginController direct = LoginController(
      transport: FakeSocketTransport(),
      accountStore: InMemoryAccountStore(),
    );
    expect(direct, isA<LoginController>());
  });

  test('TimelineStore requires TimelinePersistence — newTestStore injects '
      'InMemory (_NoOwner remains the only compliant optional default)', () {
    final TimelineStore store = newTestStore();
    expect(store.entries, isEmpty);
    store.dispose();
    // Direct required-arg construction.
    final TimelineStore direct = TimelineStore(
      persistence: InMemoryTimelinePersistence(),
      // Window C2: the ONE DELETER is required too, and for the same reason this
      // test exists — a deletion path that does not know about the row's bytes
      // leaves no new symbol to grep (15 册 G-21).
      reaper: newTestReaper(),
    );
    expect(direct.entries, isEmpty);
    direct.dispose();
  });
}
