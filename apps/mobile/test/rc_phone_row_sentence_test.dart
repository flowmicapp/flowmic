// rc-phone-fixes (real device, 2026-11-07) — a row says why it failed in a
// sentence, never as an identifier. Contract: doc 15 `15-RECEIPT-STATES.md`
// §2.0.1-c, last block.
//
// The defect as reported: press Deliver with the link dropping before the frame
// leaves, and the row reads 「✗ Not delivered · not successful · Resend」 with the
// bare string WIRE_EMIT_FAILED under the time, on the chat page and on History.
//
// ⇒ The deliverable is two screens, so the first test mounts both and reaches the
// row through the real press (CLAUDE.md anti-façade ⑥). Assertions read what got
// painted: every string on the row's tile, and `didExceedMaxLines` for the note
// (D-15). The lone-tile groups below cover the other writers of these codes, which
// the screen test cannot reach (a cloud picture leg, a failed translate run).
//
// The bare-code tier itself is gone (same doc, same block's correction): the last
// groups pin that no code is painted on any row, and that 📥 stays silent.
//
// What this file does NOT claim: that the ✗ is right. Ruling ⑩ keeps it for a
// frame that never left; this only changes the words under it.
//
// Reverse controls (2026-11-07, this file only; each measured red, then restored
// and rerun green, same command):
//   · `_phoneCodeNoteFor` answering null for every code → both screen tests and
//     every lone-tile case red, first at 「Expected: contains 'Not connected to the
//     computer — nothing was sent'」: the code is back on the row;
//   · `code: kRowLinkDownCode` removed from the probe-failed arm of `deliverText`
//     → both screen tests red, 「Expected: 'LINK_DOWN' Actual: 'WIRE_EMIT_FAILED'」;
//   · the `entry.isImage` arm disabled → the picture rows red, 「Expected: 'Not
//     connected to the computer — the photo was not sent' Actual: '… nothing was
//     sent'」;
//   · `_lastResortNoteFor` answering the code itself (the old bare tier, as a sentence)
//     → the generic cases red, 「Expected: 'The exact reason is not available' Actual:
//     'SOME_CODE_NOBODY_NAMED'」;
//   · that fallback consulted before `_faceSpeaksReason` → the 📥 case red, 「Found 1
//     widget with key entry.reasonNote.row」: a face the queue is still working on
//     starts explaining itself.

import 'dart:async' show unawaited;
import 'dart:io';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/session/image_send_vocabulary.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/history_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _typed = 'the sentence that never left';

/// Every string painted inside the tile that shows [rowText].
List<String> _paintedOn(WidgetTester tester, String rowText) {
  final Finder tile = find.ancestor(
    of: find.text(rowText),
    matching: find.byType(ChatMessageTile),
  );
  expect(tile, findsOneWidget, reason: 'the row "$rowText" is on the screen');
  return tester
      .widgetList<Text>(find.descendant(of: tile, matching: find.byType(Text)))
      .map((Text t) => t.data ?? t.textSpan?.toPlainText() ?? '')
      .toList();
}

final RegExp _identifier = RegExp(r'[A-Z]{2,}(?:_[A-Z0-9]+)+');

void _expectNoIdentifier(List<String> painted) {
  for (final String t in painted) {
    expect(_identifier.hasMatch(t), isFalse, reason: 'identifier on the row: "$t"');
  }
}

class _Owner implements InstanceOwnerProbe {
  const _Owner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    timeline = newTestStore(owner: _Owner(session));
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController controller;

  Future<void> up(WidgetTester tester) async {
    await controller.outbox.load();
    transport.pushStatus(SocketStatus.connected);
    session.noteRoomJoined(atHomeNode: true);
    await _flush(tester);
  }

  /// Press Deliver on a link that answers nothing: every probe says no, so the
  /// real `deliverText` runs its real recovery and gives up.
  Future<void> deliverOnADeadLink(WidgetTester tester, String text) async {
    controller.setBuffer(text);
    transport.defaultAck = <String, Object?>{'ok': false};
    unawaited(controller.sendBuffer());
    await _elapse(tester, const Duration(seconds: 15));
    expect(controller.delivery.sendPending, isFalse, reason: 'premise: the press is over');
    // Not `delivery.failure`: the banner is event-shaped and has hidden itself by
    // now (`kBannerAutoHideAfter`), which is why the row is what a user reads.
    expect(timeline.entries.single.status, EntryStatus.failed,
        reason: 'premise: the row was settled by the press');
    expect(controller.outbox.owedEntryIds, contains(timeline.entries.single.id),
        reason: 'premise: the queue still owes this row');
  }

  Future<void> dispose(WidgetTester tester) async {
    controller.session.debugStopIdlePresencePoll();
    controller.outbox.debugCancelNoAnswerRetries();
    await tester.pumpWidget(const SizedBox());
    bool disposed = false;
    unawaited(() async {
      await controller.dispose();
      await session.dispose();
      timeline.dispose();
      await transport.close();
      disposed = true;
    }());
    for (int i = 0; i < 200 && !disposed; i++) {
      await tester.pump(const Duration(seconds: 1));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    }
    expect(disposed, isTrue, reason: 'fixture: teardown finished');
  }
}

Future<void> _flush(WidgetTester tester) async {
  for (int i = 0; i < 12; i++) {
    await tester.pump();
  }
}

Future<void> _elapse(WidgetTester tester, Duration span) async {
  for (Duration t = Duration.zero; t < span; t += const Duration(seconds: 1)) {
    await tester.pump(const Duration(seconds: 1));
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  }
  await _flush(tester);
}

void _tallCanvas(WidgetTester tester) {
  tester.view.physicalSize = const Size(420 * 3, 1800 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

TimelineEntry _row(
  String code, {
  String entryType = TimelineEntry.kTranscript,
}) {
  final DateTime at = DateTime.utc(2026, 11, 7, 9);
  return TimelineEntry(
    id: 'row',
    clientId: 'row',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: null,
    outputText: _typed,
    status: EntryStatus.failed,
    origin: 'paired',
    entryType: entryType,
    failureReason: code,
    createdAt: at,
    updatedAt: at,
  );
}

/// [width]: Ahem glyphs are about twice as wide as a real Latin font, so the long
/// picture sentence is measured at the width that stands for a 360 dp phone. Ahem
/// not clipping proves the phone does not; the reverse does not hold (D-15).
Widget _tile(TimelineEntry e, AppStrings s, {double width = 360}) => MaterialApp(
  home: Scaffold(
    body: SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: SizedBox(
        width: width,
        child: ChatMessageTile(
          entry: e,
          strings: s,
          queued: false,
          canResendImage: true,
          onRetry: (TimelineEntry _) {},
        ),
      ),
    ),
  ),
);

Finder get _note => find.byKey(const ValueKey<String>('entry.reasonNote.row'));

Future<void> _expectSentence(
  WidgetTester tester,
  TimelineEntry e,
  AppStrings s,
  String sentence, {
  double width = 360,
}) async {
  tester.view.physicalSize = Size(width * 3, 2400);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(_tile(e, s, width: width));
  expect(tester.widget<Text>(_note).data, sentence, reason: '${e.failureReason}');
  expect(
    tester.renderObject<RenderParagraph>(_note).didExceedMaxLines,
    isFalse,
    reason: 'the user reads what is left after layout (D-15)',
  );
  final Iterable<String> painted = tester
      .widgetList<Text>(find.byType(Text))
      .map((Text t) => t.data ?? t.textSpan?.toPlainText() ?? '');
  expect(painted.where((String t) => t.contains(e.failureReason!)), isEmpty,
      reason: 'the code itself is not on the row');
}

void main() {
  testWidgets(
    '🔴 the real press on a dropped link: chat page and History both say the sentence, '
    'neither says the code, and the ✗ stays',
    (WidgetTester tester) async {
      _tallCanvas(tester);
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final AppSettingsController settings =
          AppSettingsController(prefs: await SharedPreferences.getInstance());
      final AppStrings s = AppStrings.of(settings.locale);
      final _Rig rig = _Rig();
      await rig.up(tester);

      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: rig.controller, appSettings: settings)),
      );
      await rig.deliverOnADeadLink(tester, _typed);
      await tester.pump();

      final String sentence = s.composeSendError(ComposeSendFailure.notConnected);
      expect(sentence, 'Not connected to the computer — nothing was sent',
          reason: 'the verbatim English this card reports');
      final TimelineEntry row = rig.timeline.entries.single;
      expect(row.failureReason, kRowLinkDownCode,
          reason: 'the fact on record is the link, not a refused emit');

      void expectRow() {
        final List<String> painted = _paintedOn(tester, _typed);
        expect(painted, contains(sentence));
        expect(painted, contains('✗ ${s.statusFailed}'),
            reason: 'ruling ⑩: a frame that never left says not delivered');
        _expectNoIdentifier(painted);
      }

      expectRow();
      expect(
        tester
            .renderObject<RenderParagraph>(
              find.byKey(ValueKey<String>('entry.reasonNote.${row.id}')),
            )
            .didExceedMaxLines,
        isFalse,
      );

      await tester.pumpWidget(
        MaterialApp(
          home: HistoryPage(
            store: rig.timeline,
            storageKind: TimelineStorageKind.sqlite,
            queue: rig.controller.outboxRowFacts,
            appSettings: settings,
          ),
        ),
      );
      await _flush(tester);
      expectRow();

      await rig.dispose(tester);
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );

  testWidgets(
    '🔴 「nothing was sent」 is about that attempt: when the queue delivers the row '
    'later, the sentence goes with the ✗',
    (WidgetTester tester) async {
      _tallCanvas(tester);
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final AppSettingsController settings =
          AppSettingsController(prefs: await SharedPreferences.getInstance());
      final AppStrings s = AppStrings.of(settings.locale);
      final _Rig rig = _Rig();
      await rig.up(tester);

      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: rig.controller, appSettings: settings)),
      );
      await rig.deliverOnADeadLink(tester, _typed);
      final String sentence = s.composeSendError(ComposeSendFailure.notConnected);
      expect(_paintedOn(tester, _typed), contains(sentence), reason: 'positive control');

      // The link comes back, the queue drains on its own.
      rig.transport.defaultAck = <String, Object?>{'ok': true};
      rig.transport.pushStatus(SocketStatus.connected);
      rig.session.noteRoomJoined(atHomeNode: true);
      await _elapse(tester, const Duration(seconds: 3));

      final List<EventEnvelope> frames = rig.transport.emitted
          .where((EventEnvelope e) => e.name == FlowMicEvents.injectRequest)
          .toList();
      expect(frames, hasLength(1), reason: 'premise: the queue sent its one copy');
      final Map<Object?, Object?> frame = frames.single.data! as Map<Object?, Object?>;
      rig.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
        'ok': true,
        'mode': 'sendinput',
        'request_id': frame['request_id'],
        'entry_id': frame['entry_id'],
        'inject_target': <String, Object?>{
          'window_title': 'Untitled - gedit',
          'process_name': 'gedit',
          'injected_at': 'now',
        },
      });
      await _flush(tester);

      final List<String> painted = _paintedOn(tester, _typed);
      expect(painted, contains('✓ ${s.statusInjected}'));
      expect(painted, isNot(contains(sentence)),
          reason: 'a delivered row must not keep saying nothing was sent');

      await rig.dispose(tester);
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );

  group('the other writers of these codes, in every language', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings(locale);

      testWidgets('${locale.name} · text rows', (WidgetTester tester) async {
        await _expectSentence(
          tester,
          _row(kRowLinkDownCode),
          s,
          s.composeSendError(ComposeSendFailure.notConnected),
        );
        // Also what an older row carrying this code for a dropped link reads:
        // true of both facts, so no migration.
        await _expectSentence(
          tester,
          _row(kRowWireEmitFailedCode),
          s,
          s.composeSendError(ComposeSendFailure.wireFailed),
        );
      });

      testWidgets('${locale.name} · picture rows never say 「your text」', (
        WidgetTester tester,
      ) async {
        await _expectSentence(
          tester,
          _row(kRowLinkDownCode, entryType: TimelineEntry.kImage),
          s,
          s.imageSendError(const ImageSendOutcome(reason: ImageSendFailure.notConnected)),
        );
        await _expectSentence(
          tester,
          _row(kRowWireEmitFailedCode, entryType: TimelineEntry.kImage),
          s,
          s.imageSendError(const ImageSendOutcome(reason: ImageSendFailure.wireFailed)),
        );
        await _expectSentence(
          tester,
          _row('PC_UNREACHABLE', entryType: TimelineEntry.kImage),
          s,
          s.imageSendError(const ImageSendOutcome(reason: ImageSendFailure.pcUnreachable)),
          width: 720,
        );
        for (final String held in <String>['PC_BUSY', 'PAIR_RELEASED']) {
          await _expectSentence(
            tester,
            _row(held, entryType: TimelineEntry.kImage),
            s,
            s.imageSendError(
              ImageSendOutcome(reason: ImageSendFailure.serverRefused, detail: held),
            ),
          );
        }
      });

      testWidgets('${locale.name} · a failed translate/organize run says the banner\'s '
          'sentence, not `timeout` or LLM_TIMEOUT', (WidgetTester tester) async {
        await _expectSentence(
          tester,
          _row(AiComposeFailure.timeout.name),
          s,
          s.utteranceComposeError(
            const AiComposeOutcome(reason: AiComposeFailure.timeout),
            neverSent: false,
          ),
        );
        await _expectSentence(
          tester,
          _row('LLM_TIMEOUT'),
          s,
          s.utteranceComposeError(
            const AiComposeOutcome(reason: AiComposeFailure.serverError, code: 'LLM_TIMEOUT'),
            neverSent: false,
          ),
        );
      });
    }
  });

  test('none of these is a protocol code (adding one needs the owner: D-31, D-32)', () {
    const List<String> files = <String>[
      '../../packages/protocol/src/error-codes.ts',
      '../../packages/protocol/src/error-codes-auth-and-pairing.ts',
      '../../packages/protocol/src/error-codes-inject.ts',
    ];
    expect(files.map((String p) => File(p).existsSync()), everyElement(isTrue));
    final String registry = files.map((String p) => File(p).readAsStringSync()).join();
    expect(registry, contains('INJECT_PC_MISMATCH'), reason: 'positive control');
    for (final String code in <String>[
      kRowLinkDownCode,
      kRowWireEmitFailedCode,
      'PC_UNREACHABLE',
    ]) {
      expect(registry, isNot(contains(code)), reason: code);
    }
  });

  group('🔴 no code reaches a user: the codes with no table sentence', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings(locale);

      testWidgets('${locale.name} · the named ones reuse a true sentence', (
        WidgetTester tester,
      ) async {
        await _expectSentence(
          tester,
          _row('INJECT_NOT_IN_ROOM'),
          s,
          s.composeSendError(ComposeSendFailure.notConnected),
        );
        await _expectSentence(
          tester,
          _row('INJECT_NOT_IN_ROOM', entryType: TimelineEntry.kImage),
          s,
          s.imageSendError(const ImageSendOutcome(reason: ImageSendFailure.notConnected)),
        );
        await _expectSentence(
          tester,
          _row('INJECT_NOT_PRIMARY'),
          s,
          s.pairError('PC_BUSY'),
          width: 720,
        );
        await _expectSentence(
          tester,
          _row('INJECT_NOT_PRIMARY', entryType: TimelineEntry.kImage),
          s,
          s.imageSendError(
            const ImageSendOutcome(reason: ImageSendFailure.serverRefused, detail: 'PC_BUSY'),
          ),
        );
        await _expectSentence(
          tester,
          _row('AUTH_TOKEN_INVALID', entryType: TimelineEntry.kImage),
          s,
          s.pairError('AUTH_TOKEN_INVALID'),
        );
      });

      testWidgets('${locale.name} · everything else says the generic sentence', (
        WidgetTester tester,
      ) async {
        for (final String code in <String>['SOME_CODE_NOBODY_NAMED', 'METHOD_NOT_ALLOWED']) {
          for (final String kind in <String>[TimelineEntry.kTranscript, TimelineEntry.kImage]) {
            await _expectSentence(
              tester,
              _row(code, entryType: kind),
              s,
              s.rowFailureReasonUnknown,
            );
          }
        }
        // A text row carrying this one came from a failed compose run.
        await _expectSentence(
          tester,
          _row('SETTINGS_SYNC_FAIL', entryType: TimelineEntry.kImage),
          s,
          s.rowFailureReasonUnknown,
        );
      });
    }
  });

  testWidgets('📥 stays silent: the fallback does not make the undelivered face speak', (
    WidgetTester tester,
  ) async {
    // `kCopyGapAllowlist` (error_code_copy_binding_test.dart) relies on this: the
    // queue still owes these rows and the pill's word is the whole story.
    final DateTime at = DateTime.utc(2026, 11, 7, 9);
    for (final String code in <String>['INJECT_NOT_IN_ROOM', 'INJECT_NOT_PRIMARY', 'SOME_CODE_NOBODY_NAMED']) {
      await tester.pumpWidget(
        _tile(
          TimelineEntry(
            id: 'row',
            clientId: 'row',
            mode: FlowMode.realtime,
            delivery: Delivery.inject,
            sourceText: null,
            outputText: _typed,
            status: EntryStatus.cached,
            cachedByVerdict: true,
            origin: 'paired',
            entryType: TimelineEntry.kTranscript,
            failureReason: code,
            createdAt: at,
            updatedAt: at,
          ),
          const AppStringsZh(),
        ),
      );
      expect(find.text(const AppStringsZh().statusUndelivered, findRichText: true), findsNothing,
          reason: 'the pill is drawn with its glyph');
      expect(find.textContaining(const AppStringsZh().statusUndelivered), findsOneWidget,
          reason: 'positive control: this is the undelivered face');
      expect(_note, findsNothing, reason: code);
      expect(find.textContaining(code), findsNothing, reason: code);
    }
  });

  test('the code stays on the record for diagnostics and export', () {
    expect(_row('SOME_CODE_NOBODY_NAMED').toJson()['failure_reason'], 'SOME_CODE_NOBODY_NAMED');
  });

  testWidgets('🔴 the sweep: every code that can land on a row, on both kinds of row, '
      'paints no identifier', (WidgetTester tester) async {
    final String authorship = File(
      '../../packages/protocol/src/inject-verdict-authorship.ts',
    ).readAsStringSync();
    final Set<String> wire = RegExp(
      r"^\s*([A-Z][A-Z0-9_]*)\s*:\s*'(pc-injection|pc-admission|relay)'\s*,",
      multiLine: true,
    ).allMatches(authorship).map((RegExpMatch m) => m.group(1)!).toSet();
    expect(wire.length, greaterThan(5), reason: 'parser drifted');

    // The picture HTTP route answers with its own codes too (image_send_http.dart,
    // `result.error`); `INJECT_RESULT_TIMEOUT` is mapped away by image_upload.dart.
    final Set<String> route = RegExp(r"error:[^,\n]*")
        .allMatches(File('../server-core/src/http/inject-routes.ts').readAsStringSync())
        .expand((RegExpMatch m) => RegExp(r"'([A-Z][A-Z0-9_]{4,})'").allMatches(m.group(0)!))
        .map((RegExpMatch m) => m.group(1)!)
        .where((String c) => c != 'INJECT_RESULT_TIMEOUT')
        .toSet();
    expect(route, contains('PC_BUSY'), reason: 'parser drifted');

    const AppStrings s = AppStringsZh();
    final Set<String> raw = <String>{};
    Future<void> probe(String code, String entryType) async {
      await tester.pumpWidget(_tile(_row(code, entryType: entryType), s));
      final Iterable<String> painted = tester
          .widgetList<Text>(find.byType(Text))
          .map((Text t) => t.data ?? t.textSpan?.toPlainText() ?? '');
      if (painted.any((String t) => t.contains(code) || _identifier.hasMatch(t))) {
        raw.add('$code/${entryType == TimelineEntry.kImage ? 'picture' : 'text'}');
      }
    }

    final Set<String> everything = <String>{
      ...wire,
      ...route,
      ...kComposePathFailureCodes,
      kRowLinkDownCode,
      kRowWireEmitFailedCode,
      'PC_UNREACHABLE',
      'OUTBOX_OVERFLOW',
      'OUTBOX_IMAGE_BYTES_GONE',
      'SOME_CODE_NOBODY_NAMED',
      'submission_uncertain',
      ...AiComposeFailure.values.map((AiComposeFailure r) => r.name),
    };
    for (final String code in everything) {
      await probe(code, TimelineEntry.kTranscript);
      await probe(code, TimelineEntry.kImage);
    }
    expect(raw, isEmpty, reason: 'an identifier on a row');

    // Positive control for the detector: a row whose own words are a code is caught.
    await tester.pumpWidget(
      _tile(_row('SOME_CODE_NOBODY_NAMED').copyWith(outputText: 'SOME_CODE_NOBODY_NAMED'), s),
    );
    expect(find.textContaining('SOME_CODE_NOBODY_NAMED'), findsOneWidget);
  });
}
