// Lane EC — the phone's two halves of `AUDIO_OP_BINDING_CONFLICT`.
//
// Owner granted the code on 2026-09-06
// (docs/decisions/2026-09-06-owner-grants-error-code-audio-op-binding-conflict.md).
// The server refuses a recovery `audio:start` whose `operation_id` was already
// bound to different audio; until the grant it borrowed `STT_NO_ENGINE_REACHED`,
// so the phone read out 「say it again; if it keeps happening, check the engine
// settings」 — the first half is the action that PRODUCES the refusal, the second
// points at engines that are working.
//
// Two questions, and they need two kinds of test:
//   1. does the user READ the sentence — asserted on the RENDER RESULT at 360 dp,
//      never on `Text.data`. That rule is 0.2.53's, and
//      `inject_verdict_note_test.dart`'s header carries the whole argument: a
//      suite that asserts a widget's own string is green while the screen shows
//      three letters;
//   2. does the recovery leg do the right thing — record the code and mint a NEW
//      operation next pass rather than re-send the refused one. That one is
//      driven through the production `BackfillRunner` over a real temp directory,
//      because anti-façade ③ says a green unit test proves nothing about wiring.
//
// ⚠️ THE AHEM CAVEAT, inherited verbatim from `inject_verdict_note_test.dart`:
// `flutter_test` paints in Ahem, where every glyph is a full-em square, so a
// 360 dp line holds far fewer characters than a real font would. That makes the
// 「not clipped」 direction CONSERVATIVE (unclipped here ⇒ unclipped on a device)
// and the converse worthless. Nothing below may be read as 「it fits exactly」.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/session/recovery_leg_policy.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
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

// ─── part 1: what the user reads ────────────────────────────────────────────

/// Mount one stall banner on a 360 dp-wide surface — the narrow phone this
/// repo's layout defects keep landing on (`chat_header` was measured there).
Future<RenderParagraph> _pumpBanner(
  WidgetTester tester,
  AppLocale locale,
  String code,
) async {
  await tester.binding.setSurfaceSize(const Size(360, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final AppStrings s = AppStrings.of(locale);
  final BannerQueue q = buildChatBanners(
    connection: ConnectionState.connected,
    autoStopped: false,
    strings: s,
    sttStalled: SttStall(
      SttStallReason.engineError,
      code: code,
      message: 'operation id already bound to different audio',
    ),
  );
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: Align(
        alignment: Alignment.topCenter,
        child: BannerSlot(queue: q, strings: s),
      ),
    ),
  ));
  // The banner's own Text is the only paragraph in the slot that carries the
  // message; the action/dismiss affordances are icons.
  final Finder f = find.byWidgetPredicate(
    (Widget w) => w is Text && w.data == q.top!.message,
  );
  expect(f, findsOneWidget, reason: '$locale/$code');
  return tester.renderObject<RenderParagraph>(f);
}

void main() {
  group('AUDIO_OP_BINDING_CONFLICT — the sentence the user reads', () {
    testWidgets('🔴 all nine locales render the sentence, not the identifier',
        (WidgetTester tester) async {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final RenderParagraph p =
            await _pumpBanner(tester, locale, kAudioOpBindingConflictCode);

        // 🔴 THE ASSERTION IS ON THE RENDER RESULT. `p.text.toPlainText()` is
        // what the paragraph was actually given to lay out, `didExceedMaxLines`
        // is what layout did with it, and `p.size` is the box it ended up in.
        // None of the three is `Text.data`.
        final String painted = p.text.toPlainText();
        expect(painted, s.sttStallOpBindingConflict, reason: '$locale');
        expect(painted, isNot(contains('AUDIO_OP_BINDING_CONFLICT')),
            reason: '$locale — a raw identifier on screen is the 0.2.53 defect');
        expect(p.didExceedMaxLines, isFalse,
            reason: '$locale — clipped away is the same as never written');
        expect(p.size.width, lessThanOrEqualTo(360),
            reason: '$locale — the paragraph must not overflow the phone');

        // POSITIVE CONTROL: the sentence really is long enough to have had to
        // wrap. Without this, 「not clipped」 could just mean 「short」, and this
        // test would be blind to the regression it exists for.
        expect(p.getMaxIntrinsicWidth(double.infinity),
            greaterThan(p.size.width),
            reason: '$locale — a one-liner proves nothing about clipping');

        // …and it must not read like the code it replaced.
        expect(painted, isNot(s.sttStallNoEngineReached), reason: '$locale');
      }
    });

    testWidgets(
        'CONTROL: an unmirrored code still prints its raw identifier, so the '
        'finder above is not simply blind', (WidgetTester tester) async {
      final RenderParagraph p =
          await _pumpBanner(tester, AppLocale.en, 'AUDIO_NO_SUCH_CODE_XYZ');
      expect(p.text.toPlainText(), contains('AUDIO_NO_SUCH_CODE_XYZ'));
    });

    test('🔴 the copy asks the user to do nothing, in every locale', () {
      // There is nothing to ask for: the leg mints a fresh operation by itself.
      // The banned phrases are the ones the borrowed code actually used.
      const Map<AppLocale, List<String>> banned = <AppLocale, List<String>>{
        AppLocale.en: <String>['Say it again', 'check the engine', 'try again'],
        AppLocale.zh: <String>['请重', '请检查', '请稍后'],
        AppLocale.zhTw: <String>['請重', '請檢查', '請稍後'],
      };
      for (final MapEntry<AppLocale, List<String>> e in banned.entries) {
        final String copy = AppStrings.of(e.key).sttStallOpBindingConflict;
        for (final String phrase in e.value) {
          expect(copy, isNot(contains(phrase)), reason: '${e.key}: $phrase');
        }
      }
      // And it does answer the question the user cannot answer themselves.
      expect(AppStrings.of(AppLocale.en).sttStallOpBindingConflict,
          contains('charge'));
      expect(AppStrings.of(AppLocale.zh).sttStallOpBindingConflict,
          contains('计费'));
    });
  });

  // ─── part 2: what the recovery leg does ──────────────────────────────────

  group('AUDIO_OP_BINDING_CONFLICT — the recovery leg', () {
    test(
        '🔴 records the code and mints a NEW operation next pass — it never '
        're-sends the refused one', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-bc', bytes: kBytesPerSecond);

      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, hasLength(1),
          reason: 'the first attempt must actually have gone out');
      final Object? firstOperation = rig.transport.starts.single['operation_id'];
      expect(firstOperation, isA<String>());

      // The attempt closed on the SERVER'S OWN WORD, not on a clock label.
      // Before this card every one of these read `stall_engineError`, which is
      // what four unrelated refusals looked like in the manifest.
      final RecordingManifest m1 = await rig.readManifest('rec-bc');
      expect(m1.attempts, hasLength(1));
      expect(m1.attempts.single.outcome, JournalAttempt.outcomeFailed);
      expect(m1.attempts.single.failureCode, kAudioOpBindingConflictCode);

      // 🔴 THE BYTES STAY. A refusal about the REQUEST says nothing about the
      // audio, and ruling O-9 (乙) leaves the earlier registration standing.
      expect(File(rig.pathOf('rec-bc.pcm')).lengthSync(), kBytesPerSecond);

      // Next eligible pass: a whole new attempt, and — the point of this test —
      // a DIFFERENT operation id. Re-sending the refused one would be refused
      // again for ever, which is the 「never converges」 shape 0.2.48 recorded.
      await rig.releaseBackoff('rec-bc');
      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, hasLength(2));
      expect(rig.transport.starts[1]['operation_id'], isNot(firstOperation));
      expect(rig.transport.starts[1]['recording_id'], 'rec-bc');

      // …and the five-attempt automatic budget still governs, so this cannot
      // loop for ever either.
      final RecordingManifest m2 = await rig.readManifest('rec-bc');
      expect(m2.attempts, hasLength(2));
      expect(m2.attempts.length, lessThan(kRecoveryMaxAutoAttempts + 1));
    });
  });
}

// ─── the rig ────────────────────────────────────────────────────────────────

/// Answers every recovery `audio:start` with the binding-conflict refusal, the
/// way the server does once the operation id is already bound
/// (apps/server-core/src/socket/handlers/audio-start-operation.ts).
class _ConflictTransport extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      starts.add(payload);
    }
    // The refusal arrives after the upload, when the session is PROCESSING —
    // `audio:stop` is the phone's own last frame of the attempt, so pushing on
    // it puts the error exactly where the server would.
    if (event == FlowMicEvents.audioStop) {
      pushIncoming(FlowMicEvents.sttError, <String, Object?>{
        'code': kAudioOpBindingConflictCode,
        'message': 'operation id already bound to different audio',
        'retryable': false,
      });
    }
  }
}

class _Rig {
  _Rig._(this.tmp, this.store, this.spill);

  static Future<_Rig> open() async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-lane-ec-');
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final _Rig r = _Rig._(
      tmp,
      store,
      RetainedAudioSpill(store: store, retainFromFirstFrame: true),
    );
    r._build();
    while (r.runner.isBusy) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final RetainedAudioSpill spill;

  late final _ConflictTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final BackfillRunner runner;

  void _build() {
    transport = _ConflictTransport();
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
      // Milliseconds, not minutes: the subject is WHICH CODE was recorded and
      // WHICH operation went out, not how long the product waits. The
      // production values are pinned by recovery_queue_core_test.dart.
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

  Future<void> writeJournal({required String id, required int bytes}) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      configSnapshot: <String, Object?>{
        kConfigSnapshotMode: 'realtime',
        kConfigSnapshotSourceLang: 'zh',
        kConfigSnapshotPrefsDigest: '',
      },
      commitInterval: const Duration(days: 1),
    );
    await j.appendPcm(Uint8List(bytes));
    await j.close();
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

  /// Clear the backoff the failed attempt just set, so the next sweep is
  /// eligible. Wall-clock waiting here would be dead time and would make the
  /// test's subject 「the clock」 rather than 「the operation id」.
  Future<void> releaseBackoff(String id) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      commitInterval: const Duration(days: 1),
    );
    j.setRecoveryState(RecoveryQueueState.pending,
        clearNextEligibleAt: true);
    await j.commit();
    await j.close();
  }

  String pathOf(String name) => '${tmp.path}${Platform.pathSeparator}$name';

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
