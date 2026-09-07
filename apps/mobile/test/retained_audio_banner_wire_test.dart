// AUD-D F6 / P1-6 (card B2-O, 2026-09-02) — wires `RetainedAudioStore
// .lastNotice` into ChatController's banner surface.
//
// Before this card the store's `lastNotice` `ValueListenable` had NO
// controller-side listener at all — the store's own header already required
// callers to "surface these", and the sole production reader
// (retained_audio_boot.dart) wrote a diag line and nothing else. B2-C built
// `buildChatBanners`'s `retainedAudioNotice` parameter and `BannerIds
// .retainedAudioNotice`, but nothing fed it, so `banner_queue_test.dart`'s
// coverage of that id is a hand-typed String — exactly the half-test shape
// w83_autostop_banner_test.dart's own header warns about.
//
// This asserts the WHOLE join: a value change on the store's listenable
// reaches the queue through the SAME production adapter the page renders
// (`chatBannerSources`), not a bool/string a human typed into the test.

import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/chat_banner_sources.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

const AppStrings _zh = AppStringsZh();

void main() {
  late Directory tmp;
  late RetainedAudioStore store;
  late FakeSocketTransport transport;
  late PttSession session;
  late TimelineStore timeline;
  late DestinationController destination;
  late ChatController controller;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('retained_audio_banner_wire');
    store = RetainedAudioStore(dir: tmp, clock: () => 0);
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(
        recorder: FakeAudioRecorder(),
        spill: RetainedAudioSpill(store: store),
      ),
    );
    timeline = newTestStore();
    destination = DestinationController();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
  });

  tearDown(() async {
    await controller.dispose();
    destination.dispose();
    timeline.dispose();
    await removeTempDir(tmp);
  });

  BannerQueue banners() => chatBannerSources(
    controller: controller,
    strings: _zh,
    onRetrySendFailure: null,
  );

  test('a retention notice on the store reaches the production banner queue', () {
    expect(
      banners().contains(BannerIds.retainedAudioNotice),
      isFalse,
      reason: 'positive control: nothing is queued before the store fires — '
          'a hit below is the listener talking, not a fixture default',
    );

    // Deliberately NOT const: ValueNotifier only notifies on a changed
    // `value`, and two `const` instances with identical fields canonicalize
    // to the SAME object — a fresh, non-const instance is what production
    // actually assigns on every real announcement.
    // ignore: prefer_const_constructors
    store.lastNotice.value = RetainedAudioNotice(
      code: RetainedAudioNotice.codeExpired,
      bytes: 6400,
      segmentIdx: 3,
    );

    final BannerQueue q = banners();
    expect(
      q.contains(BannerIds.retainedAudioNotice),
      isTrue,
      reason: 'AUD-D F6/P1-6: the store\'s own header says callers MUST '
          'surface these — this is that surface',
    );
    final BannerItem item = q.all.firstWhere(
      (BannerItem b) => b.id == BannerIds.retainedAudioNotice,
    );
    expect(
      item.message,
      _zh.retainedAudioNoticeMessage(RetainedAudioNotice.codeExpired),
    );
    expect(item.severity, BannerSeverity.degraded);
    expect(item.dismissible, isTrue);
  });

  test('dismissing the banner clears the controller-held code', () {
    // ignore: prefer_const_constructors
    store.lastNotice.value = RetainedAudioNotice(
      code: RetainedAudioNotice.codeCapReached,
      bytes: 128,
    );
    expect(controller.retainedAudioNotice, RetainedAudioNotice.codeCapReached);

    controller.dismissRetainedAudioNotice();

    expect(controller.retainedAudioNotice, isNull);
    expect(banners().contains(BannerIds.retainedAudioNotice), isFalse);
  });

  test('a fresh occurrence after a dismiss is shown again ("hidden, not '
      'dropped")', () {
    // ignore: prefer_const_constructors
    store.lastNotice.value = RetainedAudioNotice(
      code: RetainedAudioNotice.codeExpired,
      bytes: 64,
    );
    controller.dismissRetainedAudioNotice();
    expect(controller.retainedAudioNotice, isNull);

    // A SECOND, distinct instance carrying the SAME code: production would
    // never re-announce with the exact prior const object, so a non-const
    // fresh instance is the honest shape here too.
    // ignore: prefer_const_constructors
    store.lastNotice.value = RetainedAudioNotice(
      code: RetainedAudioNotice.codeExpired,
      bytes: 64,
    );

    expect(controller.retainedAudioNotice, RetainedAudioNotice.codeExpired);
  });

  test('a phone whose retention layer never opened (no spill) is inert, not '
      'a crash', () {
    final PttSession bareSession = newTestSession(
      transport: FakeSocketTransport(),
      audio: AudioCapture(recorder: FakeAudioRecorder()), // spill: null
    );
    final DestinationController bareDestination = DestinationController();
    final TimelineStore bareStore = newTestStore();
    final ChatController bareController = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: bareSession,
      store: bareStore,
      destination: bareDestination,
      syncGate: TimelineSyncGate(transport: bareSession.transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    expect(bareController.retainedAudioNotice, isNull);
    bareController.dispose();
    bareDestination.dispose();
    bareStore.dispose();
  });
}
