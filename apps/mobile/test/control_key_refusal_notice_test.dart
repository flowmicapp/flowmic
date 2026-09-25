// Card MP-14 — the far end could not apply a control key, from the frame to the
// glyphs on the chat page.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 + F-3116 (`control:key-result`)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-e (the ⌨ segment)
//   packages/protocol/src/protocol-schemas-inject.ts `ControlKeyResultSchema`
//   apps/mobile/lib/src/ui/control_key_face.dart (the three sentences)
//
// ── WHAT WAS WRONG, STATED SO THE TEST'S SHAPE FOLLOWS FROM IT ───────────────
//
// `control:key` was one-way. The far end took the keypress and answered nothing,
// so a key it could not run — Tab or Undo on a web target page, a kind outside
// the desktop's six-key map, nothing focused to press into — left a forensic
// line on THAT machine and nothing at all here. The phone had already minted its
// row saying 「the frame left this device」, which was true, and the product said
// no more. Nobody ever said the key did nothing.
//
// So the subject of this file is a SEAM, and it is tested as one: a frame goes
// onto the fake socket and the assertions are made on what the real chat page
// laid out. Handing `buildChatBanners` a hand-built `ControlKeyRefusal` would
// test the half that was never in doubt — the same shape the anti-façade rule ⑥
// names (「the two ends of the wiring were each tested and nothing ran through
// the middle」), and the shape `autostop_reason_wire_test.dart`'s header records
// paying for.
//
// ⚠️ ASSERTIONS ON THE RENDERED RESULT, NOT ON `Text.data` WHERE IT MATTERS. The
// 0.2.53 lesson: a fully green suite next to three letters on a screen. The
// copy-visibility case below reads the `RenderParagraph` the framework actually
// laid out.
//
// ⚠️ THE FONT IS AHEM (every glyph a full em square), so "not clipped here"
// implies "not clipped on a device" and NOT the other way round. Nothing here
// may be read as "it happens to fit on a real phone".

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/control_key_face.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const AppStrings _zh = AppStringsZh();
const AppStrings _en = AppStringsEn();

class _FakeOwner implements InstanceOwnerProbe {
  _FakeOwner(this.instanceId, this.instanceName);
  @override
  String? instanceId;
  @override
  String? instanceName;
}

/// The real data layer + the real orchestration hub + the real banner adapter.
/// Only the socket and the recorder are doubles, so every hop between the frame
/// and the sentence is production code — that seam is the whole subject.
class _Rig {
  _Rig._();

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  static _Rig create({TimelinePersistence? persistence}) {
    final _Rig r = _Rig._();
    r.transport = FakeSocketTransport();
    r.session = newTestSession(
      transport: r.transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    giveSessionAPairedIdentity(r.session);
    r.store = newTestStore(
      persistence: persistence,
      owner: _FakeOwner(r.session.connectedInstanceId, '书房电脑'),
    );
    r.destination = DestinationController();
    r.controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: r.session,
      store: r.store,
      destination: r.destination,
      syncGate: TimelineSyncGate(transport: r.transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    r.transport.pushStatus(SocketStatus.connected);
    return r;
  }

  /// The far end's receipt, byte-shaped as `ControlKeyResultSchema` puts it on
  /// the wire (the desktop's `build_key_receipt`, or a web target's own emit).
  void receipt(
    String kind, {
    required bool ok,
    String? reason,
    String? errorCode,
    String? requestId,
  }) =>
      transport.pushIncoming(FlowMicEvents.controlKeyResult, <String, Object?>{
        'kind': kind,
        'ok': ok,
        if (errorCode != null) 'error_code': errorCode,
        'reason': ?reason,
        'request_id': ?requestId,
      });
}

_Rig _rig({TimelinePersistence? persistence}) {
  final _Rig r = _Rig.create(persistence: persistence);
  addTearDown(() async {
    await r.controller.dispose();
    r.destination.dispose();
    r.store.dispose();
    await r.session.dispose();
    await r.transport.close();
  });
  return r;
}

/// Deliver the frame's consequences AND repaint. Two pumps, not one — the frame
/// crosses a broadcast stream before the controller notifies.
Future<void> _deliverAndPaint(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
}

/// The binding asserts no Timer is pending the instant the tree is torn down,
/// which is BEFORE `addTearDown` runs. A test that leaves this notice up has the
/// 4 s auto-hide timer armed — exactly what `debugCancelBannerAutoHideTimers`
/// exists for.
void _releaseTimers(_Rig r) {
  debugCancelBannerAutoHideTimers(r.controller);
  r.session.debugStopIdlePresencePoll();
}

Finder _bannerCopy(String sentence) =>
    find.descendant(of: find.byType(BannerSlot), matching: find.text(sentence));

void main() {
  for (final code in [
    'INJECT_WAYLAND_UNSUPPORTED',
    'INJECT_DISPLAY_UNAVAILABLE',
  ]) {
    testWidgets('$code refusal reaches the rendered phone banner', (
      tester,
    ) async {
      final r = _rig();
      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: r.controller)),
      );
      await tester.pump();
      r.receipt(
        'enter',
        ok: false,
        reason: 'failed',
        errorCode: code,
        requestId: 'display-key',
      );
      await _deliverAndPaint(tester);
      expect(find.text(_zh.injectVerdictNote(code)!), findsOneWidget);
      _releaseTimers(r);
    });
  }
  setUp(DiagLog.instance.clear);

  // ── ① the seam: a refusal reaches the REAL page ───────────────────────────
  testWidgets('a refused key is named on the chat page, in the key\'s own words', (
    WidgetTester tester,
  ) async {
    final _Rig r = _rig();
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: r.controller)),
    );
    await tester.pump();

    final String expected = _zh.controlKeyRefusedUnsupported(
      controlKeyLabel(_zh, 'undo'),
    );
    // Positive control: the page is silent BEFORE the frame, so a hit after it
    // is the frame talking and not some other banner that was always there.
    expect(_bannerCopy(expected), findsNothing);

    r.receipt('undo', ok: false, reason: 'unsupported_here', requestId: 'k-1');
    await _deliverAndPaint(tester);

    expect(
      _bannerCopy(expected),
      findsOneWidget,
      reason:
          'the page builds its queue through chatBannerSources — if the '
          'receipt stops anywhere between the socket and that adapter, the key '
          'that did nothing goes on looking like a key that worked',
    );
    _releaseTimers(r);
  });

  // ── ② `ok:true` draws nothing ─────────────────────────────────────────────
  //
  // 🔴 THE HALF THAT IS EASIEST TO GET WRONG IN THE OTHER DIRECTION. The success
  // receipt is on the wire so that silence cannot mean two things to the
  // PROTOCOL; it must not become a sentence, or the product narrates every
  // keypress back at the person who just pressed it.
  testWidgets('a receipt that says the key WORKED puts nothing on screen', (
    WidgetTester tester,
  ) async {
    final _Rig r = _rig();
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: r.controller)),
    );
    await tester.pump();

    r.receipt('enter', ok: true, requestId: 'k-2');
    await _deliverAndPaint(tester);

    expect(r.controller.controlKeyRefusal, isNull);
    for (final String sentence in <String>[
      _zh.controlKeyRefusedUnsupported(controlKeyLabel(_zh, 'enter')),
      _zh.controlKeyRefusedNoTarget(controlKeyLabel(_zh, 'enter')),
      _zh.controlKeyRefusedFailed(controlKeyLabel(_zh, 'enter')),
    ]) {
      expect(_bannerCopy(sentence), findsNothing);
    }
    _releaseTimers(r);
  });

  testWidgets(
    'an uncertain receipt persists on the exact control row and never renders as failed',
    (WidgetTester tester) async {
      final _Rig r = _rig();
      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: r.controller)),
      );
      await tester.pump();
      await tester.pump();

      expect(r.controller.sendControlKey(ControlKeyKind.enter), isTrue);
      await tester.pump();
      final Map<dynamic, dynamic> press =
          r.transport.emittedWhere(FlowMicEvents.controlKey).last.data
              as Map<dynamic, dynamic>;
      final String requestId = press['request_id'] as String;
      expect(requestId, isNotEmpty);
      expect(r.store.findByClientId(requestId)?.status, EntryStatus.noted);
      expect(
        r.session.scope.ownerIds,
        contains(r.session.connectedInstanceId),
      );

      r.receipt('enter', ok: false, reason: 'uncertain', requestId: requestId);
      await _deliverAndPaint(tester);

      final TimelineEntry row = r.store.findByClientId(requestId)!;
      expect(row.status, EntryStatus.cached);
      expect(row.failureReason, 'submission_uncertain');
      expect(r.controller.controlKeyRefusal, isNull);
      expect(find.text(_zh.injectionUncertain), findsOneWidget);
      expect(
        find.text(_zh.injectVerdictNote('INJECT_SUBMISSION_UNCERTAIN')!),
        findsOneWidget,
      );
      expect(find.text(_zh.statusFailed), findsNothing);
      expect(find.text(_zh.statusDeliveredNotInjected), findsNothing);
      _releaseTimers(r);
    },
  );

  test('uncertain control receipts only use recency when the id is absent', () {
    final TimelineStore store = newTestStore();
    final TimelineEntry older = store.buildControlRow(
      clientId: 'k-old',
      kind: 'clear',
    );
    final TimelineEntry newer = store.buildControlRow(
      clientId: 'k-new',
      kind: 'clear',
    );

    expect(
      store.applyControlSubmissionUncertain(
        requestId: 'k-missing',
        kind: 'clear',
      ),
      isFalse,
    );
    expect(store.findById(newer.id)!.status, EntryStatus.noted);
    expect(store.applyControlSubmissionUncertain(kind: 'clear'), isTrue);
    expect(store.findById(newer.id)!.status, EntryStatus.cached);
    expect(store.findById(older.id)!.status, EntryStatus.noted);
    store.dispose();
  });

  testWidgets(
    'the real chat page renders a transcript uncertainty as its own label and reason',
    (WidgetTester tester) async {
      final _Rig r = _rig();
      final TimelineEntry row = r.store.buildFromUtterance(
        clientId: 'u-page-uncertain',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'possibly already inserted',
      );
      r.store.applyInjectResult(
        correlationId: row.id,
        ok: false,
        pcName: 'Test PC',
        failureReason: 'INJECT_SUBMISSION_UNCERTAIN',
        wireMode: 'cached',
      );
      expect(
        r.session.scope.ownerIds,
        contains(r.session.connectedInstanceId),
      );
      expect(
        r.store.entriesForOwners(r.session.scope.ownerIds),
        contains(isA<TimelineEntry>().having((e) => e.id, 'id', row.id)),
      );

      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: r.controller)),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(find.text('? ${_zh.injectionUncertain}'), findsOneWidget);
      expect(
        find.text(_zh.injectVerdictNote('INJECT_SUBMISSION_UNCERTAIN')!),
        findsOneWidget,
      );
      expect(find.text(_zh.statusFailed), findsNothing);
      expect(find.text(_zh.statusDeliveredNotInjected), findsNothing);

      // Restart against the same durable table and mount the production page
      // again. The independent state must survive the codec/readback boundary.
      await tester.pumpWidget(const SizedBox.shrink());
      final TimelinePersistence persistence = InMemoryTimelinePersistence();
      final _Rig writer = _rig(persistence: persistence);
      final TimelineEntry persisted = writer.store.buildFromUtterance(
        clientId: 'u-reload-uncertain',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'persisted uncertainty',
      );
      writer.store.applyInjectResult(
        correlationId: persisted.id,
        ok: false,
        pcName: 'Test PC',
        failureReason: 'INJECT_SUBMISSION_UNCERTAIN',
        wireMode: 'cached',
      );
      await tester.pump();
      final _Rig reader = _rig(persistence: persistence);
      await reader.store.load();
      expect(reader.store.findById(persisted.id)!.status, EntryStatus.cached);
      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: reader.controller)),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(find.text('? ${_zh.injectionUncertain}'), findsOneWidget);
      expect(
        find.text(_zh.injectVerdictNote('INJECT_SUBMISSION_UNCERTAIN')!),
        findsOneWidget,
      );
      _releaseTimers(writer);
      _releaseTimers(reader);
      _releaseTimers(r);
    },
  );

  // ── ③ the ROW keeps its own, narrower claim ───────────────────────────────
  //
  // 🔴 15 §2.0-e: each side mints its own row and states only the half it can
  // prove. This phone's row says 「the frame left this device」 and that stays
  // true whatever the far end answers — the receipt is a second fact with a
  // different lifetime, and writing it onto the row would give one value two
  // questions to answer (this repo's #1 shape). What the card forbids is the
  // row CLAIMING the key was applied; it never did and must not start.
  testWidgets('the refusal does not rewrite the keypress row', (
    WidgetTester tester,
  ) async {
    final _Rig r = _rig();
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: r.controller)),
    );
    await tester.pump();

    final int before = r.store.entries.length;
    r.receipt('clear', ok: false, reason: 'no_target', requestId: 'k-3');
    await _deliverAndPaint(tester);

    // No row is minted by a receipt, and none is rewritten: the press already
    // has whatever row it earned at send time.
    expect(r.store.entries.length, before);
    // And the word the row wears is still the weak, provable one.
    expect(_zh.controlRowSent, isNotEmpty);
    _releaseTimers(r);
  });

  // ── ④ the sentence is READABLE, not merely present ────────────────────────
  testWidgets('the sentence is laid out in full, not clipped to an ellipsis', (
    WidgetTester tester,
  ) async {
    final _Rig r = _rig();
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: r.controller)),
    );
    await tester.pump();

    r.receipt('backspace', ok: false, reason: 'failed', requestId: 'k-4');
    await _deliverAndPaint(tester);

    final Finder copy = _bannerCopy(
      _zh.controlKeyRefusedFailed(controlKeyLabel(_zh, 'backspace')),
    );
    expect(copy, findsOneWidget);
    // 🔴 The assertion lands on the RENDERED paragraph, which is the step 0.2.53
    // was lost on: `Text.data` is whole even when the glyphs are three letters
    // and an ellipsis.
    final RenderParagraph p = tester.renderObject<RenderParagraph>(copy);
    expect(
      p.didExceedMaxLines,
      isFalse,
      reason:
          'the notice is one sentence in a banner that may wrap; if it is '
          'being clipped here (under Ahem, which is the pessimistic font) it is '
          'unreadable, and an unreadable notice is the 0.2.53 defect again',
    );
    _releaseTimers(r);
  });

  // ── ⑤ the three reasons are three sentences, in every language ────────────
  group('the selector, nine languages', () {
    test('each reason says something DIFFERENT, and names the key', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String key = controlKeyLabel(s, 'clear');
        final List<String> sentences = <String>[
          controlKeyRefusalText(
            s,
            const ControlKeyRefusal(
              ticket: 1,
              kind: 'clear',
              reason: 'unsupported_here',
            ),
          ),
          controlKeyRefusalText(
            s,
            const ControlKeyRefusal(
              ticket: 2,
              kind: 'clear',
              reason: 'no_target',
            ),
          ),
          controlKeyRefusalText(
            s,
            const ControlKeyRefusal(ticket: 3, kind: 'clear', reason: 'failed'),
          ),
        ];
        // Three moves, three sentences. Collapsing any two would throw away the
        // only thing the wire enum was built to carry.
        expect(sentences.toSet().length, 3, reason: '$locale');
        for (final String sentence in sentences) {
          expect(sentence, contains(key), reason: '$locale / $sentence');
          // 🔴 NO DIGIT ANYWHERE. A number in this copy could only be a count, a
          // limit or a code — none of which this frame carries — and the repo
          // has paid twice for a figure that outlived the rule it described
          // (plan-limit copy, the five-minute auto-stop sentence).
          expect(
            RegExp(r'[0-9]').hasMatch(sentence),
            isFalse,
            reason: '$locale / $sentence',
          );
        }
      }
    });

    // 🔴 An unknown reason must land on the COARSEST sentence, never on a
    // specific one. It is the only branch that is true of every refusal there
    // is, so a far end that grows a fourth reason degrades to something honest
    // instead of being told a cause nobody sent.
    test('a reason this build has never heard of falls to the general sentence', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String key = controlKeyLabel(s, 'enter');
        for (final String? unknown in <String?>[null, '', 'secure_input_active']) {
          expect(
            controlKeyRefusalText(s, ControlKeyRefusal(ticket: 1, kind: 'enter', reason: unknown)),
            s.controlKeyRefusedFailed(key),
            reason: '$locale / $unknown',
          );
        }
      }
    });

    // The key's name comes from the ONE table the toolbar and the history row
    // already read. A second mapping would let the same key be called two
    // things one screen apart.
    test('an unknown KIND prints its identifier rather than an invented name', () {
      expect(controlKeyLabel(_en, 'tab'), 'tab');
      expect(
        _en.controlKeyRefusedUnsupported('tab'),
        contains('tab'),
      );
    });
  });

  // ── ⑥ two refusals of the same key are two pieces of news ─────────────────
  testWidgets('a second refusal of the same key gets its own ticket',
      (WidgetTester tester) async {
    final _Rig r = _rig();
    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
    await tester.pump();

    r.receipt('undo', ok: false, reason: 'failed', requestId: 'k-5');
    await _deliverAndPaint(tester);
    final int? first = r.controller.controlKeyRefusal?.ticket;
    expect(first, isNotNull);

    r.receipt('undo', ok: false, reason: 'failed', requestId: 'k-6');
    await _deliverAndPaint(tester);
    // 🔴 Without a moving ticket the auto-hide reconciler reads an unchanged
    // face value and leaves the FIRST press's window running, so the second
    // refusal inherits whatever is left of it. Same reason `pairingSuccess` and
    // the continuous-cap warning are tickets rather than flags.
    expect(r.controller.controlKeyRefusal?.ticket, isNot(first));
    _releaseTimers(r);
  });
}
