// D-MKT-15 (2026-11-07). Measured on a device: with an input-method composition open,
// Ctrl+V is swallowed and the phone row said
//
//     ⤓ Delivered · not injected · Resend
//     The clipboard step on the computer failed, so this did not land.
//
// The status is true and the reason is not: the clipboard was fine.
//
// What is judged here:
//   · the row as the chat SCREEN paints it, through a real ChatController, from a
//     real `inject:result` (CLAUDE.md anti-façade ⑥);
//   · the painted glyphs, not `Text.data`: `reasonNote` has `maxLines`, so
//     `expectLegible` reads a real `didExceedMaxLines` (0.2.53 law, D-15);
//   · the sentence names no action the row cannot honour. A picture row settling on
//     this code has no Resend (`canResendImage` false) and reads this same sentence,
//     because `imageInjectVerdictNote` does not take the code. The premise is asserted,
//     so the day the picture table takes it, this file says so;
//   · it stays on the injection stretch: it does not reuse the word the pill uses for
//     the delivery stretch (doc 15 §2.0).
//
// NOT judged: whether the words are true for every cause. No test can read that. The
// causes are listed in doc 15 `15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md` (D-MKT-8
// section, the 2026-11-07 addition), which is why the input method is an "if".
//
// Ahem renders every glyph as a full square, so this only answers 「will it be cut」 in
// the conservative direction (D-15). Nothing here was run on a device.
//
// REVERSE CONTROLS (seen red on this tree, 2026-11-07, `flutter test` on this file only):
// the old en and zh-CN sentences put back ⇒ the first two cases red; an en sentence naming
// the delivered word and Resend ⇒ the last two red; the Gemini sentences restored ⇒ green.

import 'dart:async' show unawaited;

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart' show DeliveryFace, deliveryFaceOf;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart' show ahemWidthAtLeast, expectLegible, intrinsicWidthOf;

const String kClipboardFail = 'INJECT_CLIPBOARD_FAIL';
const String kRowId = 'loc_clipboard_fail';

/// What each language used to say.
const Set<String> kBlamesTheClipboard = <String>{
  'The clipboard step on the computer failed, so this did not land.',
  '电脑端剪贴板写入失败，文本未能注入。',
  '電腦上的剪貼簿操作失敗了，這句沒有落地。',
  "L'étape presse-papiers sur l'ordinateur a échoué, donc ceci n'a pas abouti.",
  'El paso del portapapeles en el ordenador falló, así que esto no aterrizó.',
  'Der Zwischenablage-Schritt auf dem Computer ist fehlgeschlagen, daher nicht gelandet.',
  'パソコンのクリップボード操作が失敗したため、入力されていません。',
  '컴퓨터의 클립보드 작업이 실패하여 입력되지 않았습니다.',
  'Шаг буфера обмена на компьютере не удался, поэтому это не легло.',
};

TimelineEntry _entry({bool isImage = false}) {
  final DateTime now = DateTime.utc(2026, 11, 7, 12, 32);
  return TimelineEntry(
    id: kRowId,
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: null,
    outputText: isImage ? '' : 'a sentence spoken at the phone',
    status: EntryStatus.failed,
    origin: 'paired',
    entryType: isImage ? TimelineEntry.kImage : TimelineEntry.kTranscript,
    failureReason: kClipboardFail,
    pcName: 'dev-pc-a',
    createdAt: now,
    updatedAt: now,
  );
}

Widget _tile(TimelineEntry e, AppStrings s, {required bool canResendImage}) => MaterialApp(
  home: Scaffold(
    body: ChatMessageTile(
      entry: e,
      strings: s,
      queued: false,
      canResendImage: canResendImage,
      onRetry: (TimelineEntry _) {},
    ),
  ),
);

class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

Future<void> _flush(WidgetTester tester) async {
  for (int i = 0; i < 12; i++) {
    await tester.pump();
  }
}

Finder _noteOf(String entryId) => find.byKey(ValueKey<String>('entry.reasonNote.$entryId'));

void main() {
  testWidgets(
    '🔴 the chat screen, from a real inject:result: the row reads the new sentence under the same pill',
    (WidgetTester tester) async {
      tester.view.physicalSize = const Size(900 * 3, 1200 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final FakeSocketTransport transport = FakeSocketTransport();
      final PttSession session = newTestSession(
        transport: transport,
        audio: AudioCapture(recorder: FakeAudioRecorder()),
        stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
      );
      giveSessionAPairedIdentity(session);
      final TimelineStore timeline = newTestStore(owner: _SessionOwner(session));
      final ChatController controller = ChatController(
        outboxStore: newTestOutboxStore(),
        outboxBlobs: newTestOutboxBlobs(),
        session: session,
        store: timeline,
        destination: DestinationController(),
        syncGate: TimelineSyncGate(transport: transport),
        localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.direct),
      );
      await controller.outbox.load();
      transport.pushStatus(SocketStatus.connected);
      session.noteRoomJoined(atHomeNode: true);
      await _flush(tester);

      unawaited(controller.sendFavorite('a sentence spoken at the phone'));
      await _flush(tester);
      final Map<Object?, Object?> frame = transport.emitted
          .lastWhere((EventEnvelope e) => e.name == FlowMicEvents.injectRequest)
          .data! as Map<Object?, Object?>;

      // The shape the desktop really sends for this code:
      // `inject/clipboard_outcome.rs` `never_fetched`, `mode: Clipboard`.
      transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
        'ok': false,
        'mode': 'clipboard',
        'error': kClipboardFail,
        'request_id': frame['request_id'],
        'entry_id': frame['entry_id'],
      });
      await _flush(tester);

      final TimelineEntry row = timeline.entries.single;
      expect(row.failureReason, kClipboardFail, reason: 'premise: the verdict reached the row');
      expect(deliveryFaceOf(row, queued: false, owed: false), DeliveryFace.deliveredNotInjected);

      await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: controller)));
      await _flush(tester);

      final AppStrings zh = AppStrings.of(AppLocale.zh);
      final Finder note = _noteOf(row.id);
      expect(note, findsOneWidget, reason: 'the row on the chat screen must say why');
      expect(tester.widget<Text>(note).data, zh.injectVerdictNote(kClipboardFail));
      expect(kBlamesTheClipboard, isNot(contains(tester.widget<Text>(note).data)),
          reason: 'the old sentence blames a clipboard that was fine');
      expectLegible(tester, note, reason: 'the reason line on the chat screen');
      expect(find.textContaining(zh.statusDeliveredNotInjected), findsOneWidget,
          reason: 'the status word did not move');
      expect(find.textContaining(kClipboardFail), findsNothing, reason: 'the raw code stays off the screen');

      await tester.pumpWidget(const SizedBox());
      await _flush(tester);
      session.debugStopIdlePresencePoll();
      // Teardown waits on both clocks, same as no_focus_note_test.dart: the in-memory
      // stores settle on the real one, the session's capture shutdown on the fake one
      // that started it. A plain `await` here hangs.
      Future<void> teardown() async {
        await controller.dispose();
        await session.dispose();
        timeline.dispose();
        await transport.close();
      }

      bool disposed = false;
      unawaited(teardown().then((_) => disposed = true));
      for (int i = 0; i < 200 && !disposed; i++) {
        await tester.pump(const Duration(seconds: 1));
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
      }
      expect(disposed, isTrue, reason: 'fixture: teardown finished');
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );

  testWidgets(
    'every language, text row: the whole sentence is painted, and it is not the old one',
    (WidgetTester tester) async {
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      int wrapped = 0;
      for (final AppLocale locale in AppLocale.values) {
        // Same width rule as inject_verdict_note_test.dart: Ahem makes the meta row far
        // wider than a real font does, and the floor keeps it from being the row's six
        // chips that overflow instead of this sentence.
        tester.view.physicalSize = Size(ahemWidthAtLeast(600, 411, locale) * 3, 890 * 3);
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(_tile(_entry(), s, canResendImage: false));

        final Finder note = _noteOf(kRowId);
        expect(note, findsOneWidget, reason: '$locale: the row must say why');
        final Text painted = tester.widget<Text>(note);
        expect(painted.data, s.injectVerdictNote(kClipboardFail), reason: '$locale');
        expect(kBlamesTheClipboard, isNot(contains(painted.data)), reason: '$locale still blames the clipboard');
        if (intrinsicWidthOf(painted) > tester.getSize(note).width) wrapped++;
        expectLegible(tester, note, reason: '$locale: the reason line');
        expect(find.byKey(const ValueKey<String>('entry.resend.$kRowId')), findsOneWidget,
            reason: '$locale: a text row keeps its Resend');
      }
      // Positive control over the whole loop: 「not cut」 is not free. CJK fits one line
      // on this canvas (its floor is 600dp, wider than a phone), the Latin scripts do not.
      expect(wrapped, greaterThan(AppLocale.values.length ~/ 2), reason: 'samples too short, this assertion is blind');
    },
  );

  testWidgets(
    '🔴 every language, picture row with no Resend: the same sentence is painted and names no resend',
    (WidgetTester tester) async {
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      for (final AppLocale locale in AppLocale.values) {
        tester.view.physicalSize = Size(ahemWidthAtLeast(600, 411, locale) * 3, 890 * 3);
        final AppStrings s = AppStrings.of(locale);
        expect(s.imageInjectVerdictNote(kClipboardFail), isNull,
            reason: '$locale, premise: a picture row reads the generic sentence for this code');
        await tester.pumpWidget(_tile(_entry(isImage: true), s, canResendImage: false));

        final Finder note = _noteOf(kRowId);
        expect(note, findsOneWidget, reason: '$locale: a picture row must say why too');
        final Text painted = tester.widget<Text>(note);
        expect(painted.data, s.injectVerdictNote(kClipboardFail), reason: '$locale');
        expectLegible(tester, note, reason: '$locale: the reason line on a picture row');
        expect(find.byKey(const ValueKey<String>('entry.resend.$kRowId')), findsNothing,
            reason: '$locale, premise: this row has no Resend');
        expect(painted.data!.toLowerCase(), isNot(contains(s.resendAction.toLowerCase())),
            reason: '$locale: the sentence would point at a button this row does not have');
      }
    },
  );

  test('🔴 every language: the line stays on the injection stretch and does not repeat the pill', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      final String note = s.injectVerdictNote(kClipboardFail)!;
      // The pill reads 「<delivered> · <not injected>」; the separator is the one the
      // Japanese catalogue writes as a middle dot with no spaces.
      final List<String> pill = s.statusDeliveredNotInjected.split(RegExp(r'\s*[·・]\s*'));
      expect(pill, hasLength(2), reason: '$locale, premise: the pill has two stretches');
      for (final String word in pill) {
        expect(note.toLowerCase(), isNot(contains(word.toLowerCase())),
            reason: '$locale: 「$word」 is the pill\'s word, and the line explains it rather than repeats it');
      }
    }
  });
}
