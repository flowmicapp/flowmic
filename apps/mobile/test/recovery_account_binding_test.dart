// Card RC-S (2026-09-24) — a retained recording is fed back only under the
// account it was recorded under.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §2.3, §8 RC-S,
//     §11 ruling 4
//   apps/mobile/lib/src/audio/recording_account.dart (the one reader)
//
// MEASURED BEFORE THE CARD (CR-12-E re-run 3, S6 attempt 5): account h recorded,
// account g signed in, and the automatic recovery ran under g — g's quota paid
// for h's audio and the relay transcribed it for g's session.
//
// DRIVEN THROUGH PRODUCTION: the recording is made by the production spill
// (`beginRecording` / `appendCaptured` / `endRecording`, which is where the
// account is stamped), and the sweep is the production `BackfillRunner` over a
// real temp directory. The only fakes are the socket and the microphone.
//
// REVERSE CONTROL (seen red while writing this file): make
// `RecoveryJournalLeg._heldForAnotherAccount` return false ⇒ the g sweep sends
// an `audio:start` for h's recording and the first case fails on
// `rig.transport.starts, isEmpty`.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/recording_account.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/session/recovery_leg_policy.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/pending_recovery_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

const int kBytesPerSecond = 32000;

const List<String> kTierA = <String>[
  kCapabilityCoverageReceipt,
  kCapabilityDeliveryNoneSafe,
  kCapabilityIdempotentOperation,
];

void main() {
  group('RC-S — recovery runs only under the recording\'s own account', () {
    test(
        '🔴 h records, g signs in ⇒ the sweep sends no audio:start and spends '
        'nothing; h signs back in ⇒ it runs', () async {
      final AccountRig rig = await AccountRig.open();
      addTearDown(rig.dispose);

      rig.who = 'h@example.com';
      final String id = await rig.recordThroughSpill(kBytesPerSecond);
      // The stamp is the digest, never the address.
      final RecordingManifest m0 = await rig.readManifest(id);
      expect(m0.configSnapshot[kConfigSnapshotAccount],
          accountDigest('h@example.com'));
      expect('${m0.toJson()}', isNot(contains('h@example.com')));

      rig.who = 'g@example.com';
      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, isEmpty,
          reason: 'h\'s audio must not be transcribed or billed under g');

      // Held, not failed: no attempt recorded, no backoff written, still owed.
      final RecordingManifest m1 = await rig.readManifest(id);
      expect(m1.attempts, isEmpty);
      expect(m1.nextEligibleAtMs, isNull);
      expect(RecoveryQueueState.normalise(m1.recoveryState),
          RecoveryQueueState.pending);
      final RecoveryLegOutcome tally =
          await rig.runner.journalLeg!.run(fallbackSourceLang: 'zh');
      expect(tally.pendingBytes, kBytesPerSecond,
          reason: 'a held recording is still a debt on every tally');
      expect(rig.transport.starts, isEmpty);

      // Signed out entirely: still not h ⇒ still held.
      rig.who = null;
      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, isEmpty);

      // POSITIVE CONTROL: the same recording, the same rig, the right account.
      rig.who = 'H@Example.com ';
      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, hasLength(1),
          reason: 'back under h (case and space folded) it must run');
      expect(rig.transport.starts.single['recording_id'], id);
    });

    test(
        'an old manifest (no account recorded) runs under whoever is signed in '
        '(ruling 4)', () async {
      final AccountRig rig = await AccountRig.open();
      addTearDown(rig.dispose);
      await rig.writeLegacyJournal(
          id: 'run-legacy-r1757000000000000', bytes: kBytesPerSecond);

      rig.who = 'g@example.com';
      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, hasLength(1));
      expect(rig.transport.starts.single['recording_id'],
          'run-legacy-r1757000000000000');
    });

    test('a user press on another account\'s recording is refused too',
        () async {
      final AccountRig rig = await AccountRig.open();
      addTearDown(rig.dispose);
      rig.who = 'h@example.com';
      final String id = await rig.recordThroughSpill(kBytesPerSecond);
      rig.who = 'g@example.com';
      final Object outcome =
          await rig.runner.retranscribe(recordingId: id, sourceLang: 'zh');
      expect(rig.transport.starts, isEmpty);
      expect('$outcome', contains('unavailable'));
    });

    // Anti-façade ⑥: the deliverable is what the pending-recovery SCREEN says,
    // so the real page is mounted over the real store over the same rig.
    testWidgets(
        '🔴 the pending-recovery page shows the other-account sentence in place '
        'of the state sentence, with no retry; under h it shows neither',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      final AppStrings en = AppStrings(AppLocale.en);
      late AccountRig rig;
      late String id;
      await tester.runAsync(() async {
        rig = await AccountRig.open();
        rig.who = 'h@example.com';
        id = await rig.recordThroughSpill(kBytesPerSecond);
        rig.who = 'g@example.com';
      });

      // Mounted INSIDE `runAsync`: the page's `initState` starts the store's
      // real directory scan, and file I/O started in the fake-async zone never
      // completes there.
      Future<void> mount() async {
        await tester.runAsync(() async {
          await tester.pumpWidget(MaterialApp(
            home: PendingRecoveryPage(
              key: UniqueKey(),
              source: PendingRecoveryStore(
                  runner: rig.runner, sourceLang: () => 'zh'),
              strings: en,
            ),
          ));
          await Future<void>.delayed(const Duration(milliseconds: 300));
        });
        await tester.pump();
      }

      String sentence() => tester
          .widget<Text>(
              find.byKey(ValueKey<String>('pendingRecovery.sentence.$id')))
          .data!;
      final Finder retry =
          find.byKey(ValueKey<String>('pendingRecovery.retry.$id'));
      final Finder delete =
          find.byKey(ValueKey<String>('pendingRecovery.delete.$id'));

      await mount();
      expect(delete, findsOneWidget,
          reason: 'positive control: the card for the recording of h is on screen');
      expect(sentence(), en.pendingRecoveryOtherAccount);
      expect(retry, findsNothing,
          reason: 'a press would be refused under g; the button is withheld');

      // Back under h: the ordinary state sentence and the retry button return.
      rig.who = 'h@example.com';
      await mount();
      expect(delete, findsOneWidget);
      expect(sentence(), isNot(en.pendingRecoveryOtherAccount));
      expect(retry, findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(rig.dispose);
    });

    test('🔴 production binds the account source (main.dart)', () {
      // The binding is the only thing that makes the stamp happen; unbound, the
      // spill writes nothing and every recording reads as 「unknown」, i.e. the
      // pre-card behaviour. A source scan is the cheapest pin on that wiring.
      final String main = File('lib/main.dart').readAsStringSync();
      expect(main, contains('recordingAccount.bind(() => _login.email)'));
    });
  });
}

/// Records every `audio:start`; answers nothing, so an attempt that does go out
/// ends on its own (short) clocks. The subject here is WHETHER it goes out.
class StartRecordingTransport extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      starts.add(payload);
    }
  }
}

class AccountRig {
  AccountRig._(this.tmp, this.store, this.spill);

  static Future<AccountRig> open() async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-rc-s-');
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    int micros = 1757000000000000;
    final AccountRig r = AccountRig._(
      tmp,
      store,
      RetainedAudioSpill(
        store: store,
        retainFromFirstFrame: true,
        clock: () => micros += 1000000,
      ),
    );
    // The production seam, bound the way main.dart binds it.
    r.spill.recordingAccount.bind(() => r.who);
    r._build();
    while (r.runner.isBusy) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final RetainedAudioSpill spill;

  /// Who is signed in right now (`LoginController.email`).
  String? who;

  late final StartRecordingTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final BackfillRunner runner;

  void _build() {
    transport = StartRecordingTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect
        .noteServerCapabilities(<String, Object?>{'capabilities': kTierA});
    timeline = newTestStore();
    runner = BackfillRunner(
      session: session,
      store: timeline,
      sleep: (Duration _) async {},
      recoveryTimeouts: const RecoveryTimeouts(
        uploadProgress: Duration(milliseconds: 200),
        engineProgress: Duration(milliseconds: 200),
        noProgress: Duration(milliseconds: 200),
        totalBudgetBase: Duration(milliseconds: 400),
        totalBudgetPerAudioMinute: Duration.zero,
      ),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  /// One recording made the way a press makes it: snapshot noted, journal
  /// opened (this is where the account is stamped), PCM appended, closed by a
  /// link loss so nothing is settling it.
  Future<String> recordThroughSpill(int bytes) async {
    spill.noteConfigSnapshot(
        recordingConfigSnapshot(mode: 'realtime', sourceLang: 'zh'));
    await spill.beginRecording();
    final String id = spill.currentRecordingId!;
    spill.appendCaptured(Uint8List(bytes));
    await spill.endRecording(interruptReason: JournalInterrupt.linkLoss);
    return id;
  }

  /// A manifest written by a build before card RC-S: no account key.
  Future<void> writeLegacyJournal(
      {required String id, required int bytes}) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      configSnapshot: recordingConfigSnapshot(mode: 'realtime', sourceLang: 'zh'),
      commitInterval: const Duration(days: 1),
    );
    await j.appendPcm(Uint8List(bytes));
    await j.close(interruptReason: JournalInterrupt.linkLoss);
  }

  Future<RecordingManifest> readManifest(String id) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      commitInterval: const Duration(days: 1),
    );
    final RecordingManifest m = j.manifest;
    await j.close();
    return m;
  }

  Future<void> dispose() async {
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 10));
    while (runner.isBusy && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    runner.dispose();
    timeline.dispose();
    await session.dispose();
    await spill.dispose();
    await store.dispose();
    await removeTempDir(tmp);
  }
}
