// D-MKT-11 (2026-11-06). Measured on a device: a console with its system menu open
// (PC forensic `fg_thread=flags=0xc`) gave the phone row
//
//     🚫 Delivered · no focus, not injected · Resend
//
// and nothing under the text. The admin-window refusal and the clipboard failure
// each carry a reason line; this face was the exception, on the argument that its
// word says the whole fact (doc 15 `15-UI-STATE-COPY.md`, the note under the table).
//
// What is judged here, and why it is not just the table:
//   · the row as the chat SCREEN paints it, through a real ChatController, from a
//     real `inject:result` (CLAUDE.md anti-façade ⑥);
//   · the painted glyphs, not `Text.data`: `reasonNote` has `maxLines`, so
//     `expectLegible` reads a real `didExceedMaxLines` (0.2.53 law, D-15);
//   · the pill word is owner's verbatim and did not move;
//   · a row waiting for a fresh verdict after Resend does not speak from the old code;
//   · the sentence is not the web target's sentence: a leaf named
//     `injectVerdictNote_INJECT_NO_TEXT_TARGET` exists and speaks about 「this page」
//     (i18n/web/subset.json group `web-target`).
//
// NOT judged: whether the words are true for every case. That is why the sentence
// offers a menu as an example; see `target_probe.rs` `classify_focus_in` and the web
// repo's `NO_TEXT_TARGET_CODE` for the cases, and doc 15 for the rule.
//
// Ahem renders every glyph as a full square, so this only answers 「will it be cut」
// in the conservative direction (D-15). Nothing here was run on a device.

import 'dart:async' show unawaited;
import 'dart:convert' show jsonDecode;
import 'dart:io' show Directory, File;

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

const String kNoTextTarget = 'INJECT_NO_TEXT_TARGET';
const String kRowId = 'loc_no_focus';

TimelineEntry _entry({
  required EntryStatus status,
  bool cachedByVerdict = false,
}) {
  final DateTime now = DateTime.utc(2026, 11, 6, 12, 32);
  return TimelineEntry(
    id: kRowId,
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: null,
    outputText: 'a sentence spoken at the phone',
    status: status,
    origin: 'paired',
    entryType: TimelineEntry.kTranscript,
    failureReason: kNoTextTarget,
    cachedByVerdict: cachedByVerdict,
    pcName: 'dev-pc-a',
    createdAt: now,
    updatedAt: now,
  );
}

Widget _tile(TimelineEntry e, AppStrings s) => MaterialApp(
  home: Scaffold(
    body: ChatMessageTile(
      entry: e,
      strings: s,
      queued: false,
      canResendImage: true,
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
    '🔴 the chat screen, from a real inject:result: the row says why, and the pill did not move',
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

      // The shape the desktop really sends for this code: `inject/pipeline.rs`
      // Stage 1b, `mode: SendInput`, never `Cached`.
      transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
        'ok': false,
        'mode': 'sendinput',
        'error': kNoTextTarget,
        'request_id': frame['request_id'],
        'entry_id': frame['entry_id'],
      });
      await _flush(tester);

      final TimelineEntry row = timeline.entries.single;
      expect(row.failureReason, kNoTextTarget, reason: 'premise: the verdict reached the row');
      expect(deliveryFaceOf(row, queued: false, owed: false), DeliveryFace.noFocus);

      await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: controller)));
      await _flush(tester);

      final AppStrings zh = AppStrings.of(AppLocale.zh);
      final Finder note = _noteOf(row.id);
      expect(note, findsOneWidget, reason: 'the row on the chat screen must say why');
      expect(tester.widget<Text>(note).data, zh.injectVerdictNote(kNoTextTarget));
      expectLegible(tester, note, reason: 'the reason line on the chat screen');
      expect(find.text('🚫 ${zh.statusNoFocus}'), findsOneWidget, reason: 'owner verbatim, not one word changed');
      expect(find.textContaining(kNoTextTarget), findsNothing, reason: 'the raw code stays off the screen');

      await tester.pumpWidget(const SizedBox());
      await _flush(tester);
      session.debugStopIdlePresencePoll();
      // Teardown waits on both clocks, same as chat_no_answer_retry_test.dart:
      // the in-memory stores settle on the real one, the session's capture
      // shutdown on the fake one that started it. A plain `await` here hangs.
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
    'every language, on the production shape: the whole sentence is painted, with Resend beside it',
    (WidgetTester tester) async {
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      for (final AppLocale locale in AppLocale.values) {
        // Same width rule as inject_verdict_note_test.dart: Ahem makes the meta
        // row far wider than a real font does, and the floor keeps it from being
        // the row's six chips that overflow instead of this sentence.
        tester.view.physicalSize = Size(ahemWidthAtLeast(600, 411, locale) * 3, 890 * 3);
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(_tile(_entry(status: EntryStatus.failed), s));

        final Finder note = _noteOf(kRowId);
        expect(note, findsOneWidget, reason: '$locale: the row must say why');
        final Text painted = tester.widget<Text>(note);
        expect(painted.data, s.injectVerdictNote(kNoTextTarget), reason: '$locale');
        // Positive control: this wraps, so 「not cut」 is not free.
        expect(
          intrinsicWidthOf(painted),
          greaterThan(tester.getSize(note).width),
          reason: '$locale: sample too short, this assertion is blind',
        );
        expectLegible(tester, note, reason: '$locale: the reason line');
        expect(find.textContaining(kNoTextTarget), findsNothing, reason: '$locale: raw code');
        expect(
          find.byKey(const ValueKey<String>('entry.resend.$kRowId')),
          findsOneWidget,
          reason: '$locale: the sentence ends in a resend, so the button must be on the row (R8)',
        );
      }
    },
  );

  testWidgets(
    'the cached shape speaks the same sentence (the web target answers this code with mode:cached)',
    (WidgetTester tester) async {
      tester.view.physicalSize = const Size(800 * 3, 890 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      final AppStrings en = AppStrings.of(AppLocale.en);
      await tester.pumpWidget(_tile(_entry(status: EntryStatus.cached, cachedByVerdict: true), en));
      expect(_noteOf(kRowId), findsOneWidget);
      expect(tester.widget<Text>(_noteOf(kRowId)).data, en.injectVerdictNote(kNoTextTarget));
    },
  );

  testWidgets(
    '🔴 stale code: a row waiting for a fresh verdict after Resend says nothing from the old one',
    (WidgetTester tester) async {
      tester.view.physicalSize = const Size(800 * 3, 890 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      final AppStrings en = AppStrings.of(AppLocale.en);
      // The code survives a resend (`markReinjecting`); `cachedByVerdict` is what
      // says no verdict has come back yet.
      final TimelineEntry waiting = _entry(status: EntryStatus.cached);
      expect(deliveryFaceOf(waiting, queued: false, owed: false), isNot(DeliveryFace.noFocus));
      await tester.pumpWidget(_tile(waiting, en));
      expect(
        _noteOf(kRowId),
        findsNothing,
        reason: 'the row would explain a refusal that is no longer what is happening',
      );
    },
  );

  test('🔴 not the web target\'s sentence, and not the sentence of its sibling code, in any language', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      final String? note = s.injectVerdictNote(kNoTextTarget);
      expect(note, isNotNull, reason: '$locale');
      expect(note, isNot(s.injectVerdictNote('INJECT_FOCUS_LOST')), reason: '$locale');
      expect(note, isNot(s.injectVerdictNote('INJECT_SELF_WINDOW_NO_INPUT')), reason: '$locale');
    }
    // Read from the catalogue because the leaf is private; `flutter test` runs in
    // apps/mobile. A missing file fails here rather than passing silently.
    int catalogues = 0;
    for (final File file in Directory('../../i18n/mobile').listSync().whereType<File>()) {
      if (!file.path.endsWith('.json')) continue;
      final Map<String, dynamic> json = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
      // leaves.json and coverage.json share the directory and carry no sentences.
      if (json['locale'] == null) continue;
      catalogues++;
      final Map<String, dynamic> strings = json['strings'] as Map<String, dynamic>;
      expect(strings['noFocusRowNote'], isNotNull, reason: file.path);
      expect(strings['injectVerdictNote_INJECT_NO_TEXT_TARGET'], isNotNull, reason: 'premise: ${file.path}');
      expect(strings['noFocusRowNote'], isNot(strings['injectVerdictNote_INJECT_NO_TEXT_TARGET']), reason: file.path);
    }
    expect(catalogues, AppLocale.values.length, reason: 'premise: the loop above saw every language');
    final AppStrings en = AppStrings.of(AppLocale.en);
    final Map<String, dynamic> enStrings =
        (jsonDecode(File('../../i18n/mobile/en.json').readAsStringSync()) as Map<String, dynamic>)['strings']
            as Map<String, dynamic>;
    expect(
      "'${en.injectVerdictNote(kNoTextTarget)}'",
      enStrings['noFocusRowNote'],
      reason: 'the table must read the phone row\'s leaf, not the page leaf of the same code',
    );
  });
}
