// 🔴 CARD RC-I — A ROW THAT IS NEVER SENT DOES NOT TALK ABOUT A PC.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §5.3 / §6 I / §7 RC-I
//   lib/src/timeline/entry_never_sent.dart (the one question both halves ask)
//
// ── WHAT THE DEVICE SHOWED (CR-12-E re-run, 2026-09-24) ─────────────────────
//
// In the light record (no PC anywhere), long-pressing a row offered
// 「用原话重新翻译 → … · 作为新的一条发到电脑」, and an AI failure raised
// 「电脑端尚未配置 AI 模型 · 这句未发送，也没有发原文 · 可长按补投」.
//
// Both halves are asserted on the MOUNTED chat page, driven through the
// production chain (speak → compose:done / compose:error), and every sentence is
// read from its catalogue getter — never quoted — so the cases hold for whatever
// wording the copy lane lands (D-47).
//
// 🔴 THE ROW DECIDES, NOT THE DESTINATION SWITCH. A re-run inherits the row's
// delivery (`_deliverRerun`: `delivery: origin.delivery`), so the paired case
// below flips the switch AFTER speaking and checks that each row keeps its own
// sentence.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/compose_gate.dart'
    show AiComposeFailure, AiComposeOutcome;
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart' show SessionOwnerProbe;
import 'support/di.dart';
import 'support/fakes.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

class _Rig {
  _Rig({required bool lightRecord}) {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: recorder),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    store = newTestStore(owner: SessionOwnerProbe(session));
    destination = DestinationController(fixedRecordOnly: lightRecord);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    transport.pushStatus(SocketStatus.connected);
    controller.setMode(FlowMode.translate);
  }

  final FakeAudioRecorder recorder = FakeAudioRecorder();
  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;
  bool _disposed = false;

  Future<void> press() async {
    await controller.pttDown();
    await controller.pttUp();
  }

  /// The terminal final of one translate utterance.
  Future<void> finalOf(String said) async {
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': said,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 1200,
    });
    await pumpEventQueue();
  }

  TimelineEntry rowOf(String said) =>
      store.entries.firstWhere((TimelineEntry e) => e.sourceText == said);

  Future<void> composeDone(TimelineEntry row, String output) async {
    transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
      'output_text': output,
      'request_id': row.clientId,
    });
    await pumpEventQueue();
  }

  Future<void> composeError(TimelineEntry row, String code) async {
    transport.pushIncoming(FlowMicEvents.composeError, <String, Object?>{
      'code': code,
      'message': 'no model',
      'request_id': row.clientId,
    });
    await pumpEventQueue();
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    debugCancelAsrHealthTicker(controller);
    await controller.dispose();
    store.dispose();
    destination.dispose();
    await session.dispose();
  }
}

Future<void> _mount(WidgetTester tester, _Rig r) async {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

/// One production-chain step, then a real widget pump: the settle chain does
/// not drain on `pumpEventQueue()` alone under the test binding (measured in
/// article_wp2_screen_test.dart; the same order `search_article_screen_test`
/// uses).
Future<void> _step(WidgetTester tester, Future<void> Function() f) async {
  await tester.runAsync(f);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

/// One translate utterance through the production chain; returns its row.
Future<TimelineEntry> _speak(WidgetTester tester, _Rig r, String said) async {
  await _step(tester, r.press);
  await _step(tester, () => r.finalOf(said));
  return r.rowOf(said);
}

/// Unmounts the page and disposes the chain INSIDE the test body, then lets
/// fake time run out: a PC-bound send and a raised banner both arm timers that
/// the test binding would otherwise report as pending.
Future<void> _finish(WidgetTester tester, _Rig r) async {
  await tester.pumpWidget(const SizedBox());
  await tester.runAsync(r.dispose);
  await tester.pump(const Duration(minutes: 2));
}

/// Long-press the row showing [face]; returns once the sheet is up.
Future<void> _openMenu(WidgetTester tester, String face) async {
  final Finder row = find.text(face);
  expect(row, findsOneWidget, reason: 'positive control: the row is on screen');
  await tester.longPress(row);
  await tester.pumpAndSettle();
  expect(find.text(_zh.entryReorganize), findsOneWidget,
      reason: 'positive control: the re-run rows are offered');
}

Future<void> _closeMenu(WidgetTester tester) async {
  await tester.tapAt(const Offset(10, 10));
  await tester.pumpAndSettle();
}

/// Which pair of sub-lines the open sheet shows: `true` the record pair,
/// `false` the PC pair. Fails when it shows neither, or both.
bool _menuSaysRecord(WidgetTester tester, String target) {
  final String label = _zh.translateTargetLabel(target);
  final bool record = find.text(_zh.entryRetranslateSubRecord(label)).evaluate().isNotEmpty &&
      find.text(_zh.entryReorganizeSubRecord).evaluate().isNotEmpty;
  final bool pc = find.text(_zh.entryRetranslateSub(label)).evaluate().isNotEmpty &&
      find.text(_zh.entryReorganizeSub).evaluate().isNotEmpty;
  expect(record != pc, isTrue,
      reason: 'exactly one pair of sub-lines (record=$record, pc=$pc)');
  return record;
}

void main() {
  // The two frames must differ, or every assertion below is vacuous.
  test('control: the record sentences are not the PC sentences', () {
    expect(_zh.entryReorganizeSubRecord, isNot(_zh.entryReorganizeSub));
    expect(_zh.entryRetranslateSubRecord('x'), isNot(_zh.entryRetranslateSub('x')));
    const AiComposeOutcome o =
        AiComposeOutcome(reason: AiComposeFailure.serverError, code: 'LLM_INVALID_MODEL');
    expect(_zh.utteranceComposeError(o, neverSent: true),
        isNot(_zh.utteranceComposeError(o, neverSent: false)));
    expect(_zh.aiErrorCodeFor('LLM_INVALID_MODEL', neverSent: true),
        isNot(_zh.aiErrorCode('LLM_INVALID_MODEL')));
    expect(_zh.aiErrorCodeFor('LLM_AUTH_FAIL', neverSent: true),
        _zh.aiErrorCode('LLM_AUTH_FAIL'),
        reason: 'only the one code that names a PC gets a second sentence');
  });

  testWidgets('🔴 RC-I: the light record\'s long-press menu offers re-runs '
      'that are KEPT, not sent to a PC', (WidgetTester tester) async {
    final _Rig r = _Rig(lightRecord: true);
    await _mount(tester, r);
    final TimelineEntry row = await _speak(tester, r, '留在手机上的一句');
    await _step(tester, () => r.composeDone(row, 'Kept on the phone.'));
    await _openMenu(tester, 'Kept on the phone.');
    expect(_menuSaysRecord(tester, r.controller.aiTranslateTarget), isTrue);
    await _finish(tester, r);
  });

  testWidgets('🔴 RC-I: on a paired phone each row keeps its own sentence '
      'whichever way the destination switch now points', (WidgetTester tester) async {
    final _Rig r = _Rig(lightRecord: false);
    await _mount(tester, r);
    final TimelineEntry sent = await _speak(tester, r, '发到电脑的一句');
    await _step(tester, () => r.composeDone(sent, 'Sent to the PC.'));
    r.destination.toggle(); // → record only
    await tester.pump();
    final TimelineEntry kept = await _speak(tester, r, '只记下的一句');
    await _step(tester, () => r.composeDone(kept, 'Only noted.'));
    expect(r.store.findById(sent.id)!.delivery, isNot(Delivery.none),
        reason: 'positive control: the first row is PC-bound');
    expect(r.store.findById(kept.id)!.delivery, Delivery.none,
        reason: 'positive control: the second row is record-only');
    expect(r.destination.isRecordOnly, isTrue);
    final String target = r.controller.aiTranslateTarget;

    // Switch on record-only, PC-bound row: its re-run still goes to the PC.
    await _openMenu(tester, 'Sent to the PC.');
    expect(_menuSaysRecord(tester, target), isFalse);
    await _closeMenu(tester);

    // Switch flipped back to the PC, record-only row: its re-run stays here.
    r.destination.toggle();
    await tester.pump();
    expect(r.destination.isRecordOnly, isFalse);
    await _openMenu(tester, 'Only noted.');
    expect(_menuSaysRecord(tester, target), isTrue);
    await _finish(tester, r);
  });

  testWidgets('🔴 RC-I: an AI failure in the light record is not framed as '
      '「not sent · long-press to send」 and names no PC', (WidgetTester tester) async {
    final _Rig r = _Rig(lightRecord: true);
    await _mount(tester, r);
    final TimelineEntry row = await _speak(tester, r, '这句要翻译');
    await _step(tester, () => r.composeError(row, 'LLM_INVALID_MODEL'));
    const AiComposeOutcome o =
        AiComposeOutcome(reason: AiComposeFailure.serverError, code: 'LLM_INVALID_MODEL');
    expect(r.controller.utteranceFailure?.code, 'LLM_INVALID_MODEL',
        reason: 'positive control: the failure was raised');
    expect(find.text(_zh.utteranceComposeError(o, neverSent: true)), findsOneWidget);
    expect(find.text(_zh.utteranceComposeError(o, neverSent: false)), findsNothing);
    await _finish(tester, r);
  });

  testWidgets('RC-I: the same failure on a PC-bound utterance keeps the PC '
      'sentence (the other direction)', (WidgetTester tester) async {
    final _Rig r = _Rig(lightRecord: false);
    await _mount(tester, r);
    final TimelineEntry row = await _speak(tester, r, '这句要翻译');
    await _step(tester, () => r.composeError(row, 'LLM_INVALID_MODEL'));
    const AiComposeOutcome o =
        AiComposeOutcome(reason: AiComposeFailure.serverError, code: 'LLM_INVALID_MODEL');
    expect(r.controller.utteranceFailure?.code, 'LLM_INVALID_MODEL');
    expect(find.text(_zh.utteranceComposeError(o, neverSent: false)), findsOneWidget);
    await _finish(tester, r);
  });
}
