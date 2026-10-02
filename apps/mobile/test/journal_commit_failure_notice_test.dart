// NR-146: reverse control makes a failed commit return true.
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_banner_sources.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/memory_journal_fs.dart';
import 'support/temp_teardown.dart';

class _FailsPublish extends MemoryJournalFs {
  bool fail = false;
  int failures = 0;
  @override
  Future<void> rename(String from, String to) async {
    if (fail) { failures++; throw StateError('manifest publish refused'); }
    await super.rename(from, to);
  }
}

void main() {
  for (final bool lossFirst in <bool>[true, false]) {
    test('audio loss outranks commit failure: lossFirst=$lossFirst', () async {
      final tmp = await Directory.systemTemp.createTemp('nr146-notices-');
      final store = RetainedAudioStore(dir: tmp);
      final spill = RetainedAudioSpill(store: store);
      try {
        const loss = JournalNotice(code: JournalNotice.codeAppendFailed, recordingId: "same-recording");
        const commit = JournalNotice(code: JournalNotice.codeCommitFailed, recordingId: "same-recording");
        spill.handleJournalNotice(lossFirst ? loss : commit);
        spill.handleJournalNotice(lossFirst ? commit : loss);
        expect(store.lastNotice.value?.code, RetainedAudioNotice.codeWriteFailed);
        expect(store.lastNotice.value?.secondaryCode, RetainedAudioNotice.codeCommitFailed);
        final strings = AppStrings.of(AppLocale.en);
        final banner = buildChatBanners(connection: ConnectionState.connected,
          autoStopped: false, strings: strings,
          retainedAudioNotice: store.lastNotice.value!.code,
          retainedAudioSecondaryNotice: store.lastNotice.value!.secondaryCode);
        expect(banner.all.single.message, strings.retainedAudioNoticeWriteFailed);
      } finally {
        await spill.dispose(); await store.dispose(); await removeTempDir(tmp);
      }
    });
  }

  test('failed settle commit keeps PCM and shows the truthful manifest notice', () async {
    final tmp = await Directory.systemTemp.createTemp('nr146-commit-');
    final store = RetainedAudioStore(dir: tmp);
    await store.open();
    final fs = _FailsPublish();
    final spill = RetainedAudioSpill(store: store, retainFromFirstFrame: true,
      journalFs: fs);
    final transport = FakeSocketTransport();
    final session = newTestSession(transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill));
    final timeline = newTestStore();
    final destination = DestinationController();
    final controller = ChatController(session: session, store: timeline,
      destination: destination, syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(), outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs());
    try {
      await spill.beginRecording();
      final attempt = spill.liveAttempt!;
      spill.appendCaptured(Uint8List(6400));
      spill.noteLiveFramesEmitted(1);
      await spill.endRecording(interruptReason: 'link_loss');
      final pcm = '${tmp.path}/${attempt.recordingId}${RetainedAudioJournal.pcmSuffix}';
      expect(await fs.lengthOf(pcm), 6400);
      fs.fail = true;
      await spill.publishLiveSettle(attempt: attempt, rowId: 'saved-row',
        reasonCode: 'settled', mayDelete: true, attemptKindWire: 'live',
        recoveryState: 'settled');
      expect(fs.failures, greaterThan(0));
      expect(await fs.lengthOf(pcm), 6400);
      expect(store.lastNotice.value?.code, RetainedAudioNotice.codeCommitFailed);
      final strings = AppStrings.of(AppLocale.en);
      expect(strings.retainedAudioNoticeMessage(store.lastNotice.value!.code),
        'Recording is on this phone, but its details could not be saved');
      expect(strings.retainedAudioNoticeMessage(store.lastNotice.value!.code),
        isNot(strings.retainedAudioNoticeWriteFailed));
      final banners = chatBannerSources(controller: controller, strings: strings,
        onRetrySendFailure: null);
      expect(banners.all.singleWhere((b) => b.id == BannerIds.retainedAudioNotice).message,
        'Recording is on this phone, but its details could not be saved');
      fs.fail = false;
      await spill.publishLiveSettle(attempt: attempt, rowId: 'saved-row',
        reasonCode: 'settled', mayDelete: true, attemptKindWire: 'live',
        recoveryState: 'settled');
      expect(await fs.exists(pcm), isFalse);
    } finally {
      fs.fail = false;
      await controller.dispose(); await session.dispose();
      timeline.dispose(); destination.dispose();
      await spill.dispose(); await store.dispose(); await removeTempDir(tmp);
    }
  });
}
