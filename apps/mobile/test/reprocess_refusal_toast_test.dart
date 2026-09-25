// NR-89 copy landing (2026-09-24): which sentence a re-translate / re-organize
// press shows when the run could not start.
//
// Before this card the dispatcher (`chat_flow_entry_actions.dart`) said
// `reprocessBusy` for a busy slot and `reprocessUnavailable` for EVERYTHING
// else. The landed `reprocessUnavailable` now says 「this row has no original
// words」, which is true for `AiComposeFailure.emptyBuffer` only. The common
// real failure is a socket that is down: `utterance_compose.dart` `start`
// returns `wireFailed`, and the old dispatcher then told the user their row had
// no words.
//
// What each case reaches:
//   · (a) the whole mapping, every locale × every `AiComposeFailure` value, as a
//     pure table through `reprocessRefusalCopy` (the function the dispatcher
//     calls). This is the only place `emptyBuffer` and `notConnected` can be
//     asserted: the sheet offers the rows only when the row has original words
//     (`entry_context_menu.dart` `_canReprocess` shares `_reprocessEntry`'s
//     trim check), the page never passes a mode without a model stage, and
//     `reprocessEntry` never returns `notConnected`. Those two branches are
//     therefore unreachable through the page today, and this file says so
//     instead of mounting a widget that pretends to reach them.
//   · (b) `wireFailed` through the REAL page: long-press → tap re-translate with
//     the transport refusing emits. The toast is looked up on screen.
//   · `busy` through the real page is `rerun_copy_render_test.dart` case ②
//     (double press); it also asserts `reprocessUnavailable` is absent.
//
// Reverse control (kept in the card report): collapsing `reprocessRefusalCopy`
// back to `busy ? reprocessBusy : reprocessUnavailable` turns (a) and (b) red.

import 'dart:async';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const Size kPhone = Size(411 * 3, 890 * 3);

/// The page narrows history to the instance this phone is talking to, so the
/// seeded row must be OWNED by the paired session or it renders nowhere.
class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

Future<ChatController> _controller(FakeSocketTransport transport) async {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  transport.connectSucceeds = true;
  transport.ackQueue.add(<String, Object?>{
    'token': 'tok-nr89-refusal-000000000000000000',
    'pc_id': 'pc-nr89-refusal',
    'pc_name': 'Widget PC',
    'pc_instance_id': 'inst-nr89-refusal',
  });
  final PairResult pair = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://192.0.2.5:41879',
  );
  expect(pair.ok, isTrue, reason: 'harness pair failed: ${pair.error}');
  return ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(owner: _SessionOwner(session)),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.direct),
  );
}

void main() {
  // ── (a) the whole mapping ───────────────────────────────────────────────────
  test('(a) each start failure gets its own sentence, in every locale', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      // Positive control: the sentences under comparison really differ in this
      // locale, or every inequality below would be vacuous.
      expect(s.reprocessUnavailable, isNot(s.reprocessBusy), reason: '$locale control');
      for (final AiComposeFailure f in AiComposeFailure.values) {
        final String got = reprocessRefusalCopy(s, f);
        switch (f) {
          case AiComposeFailure.busy:
            expect(got, s.reprocessBusy, reason: '$locale $f');
          case AiComposeFailure.emptyBuffer:
            expect(got, s.reprocessUnavailable, reason: '$locale $f');
          case AiComposeFailure.notConnected:
          case AiComposeFailure.wireFailed:
          case AiComposeFailure.serverError:
          case AiComposeFailure.timeout:
          case AiComposeFailure.aborted:
            expect(got, s.aiComposeError(AiComposeOutcome(reason: f)), reason: '$locale $f');
            // 🔴 the defect: a run that never left the phone must not be told
            // its row has no original words.
            expect(got, isNot(s.reprocessUnavailable), reason: '$locale $f said 「no original words」');
        }
      }
    }
  });

  // ── (b) wireFailed through the real page ────────────────────────────────────
  testWidgets('(b) re-translate with the emit refused shows the 「never left the phone」 '
      'sentence, not 「no original words」', (WidgetTester tester) async {
    tester.view.physicalSize = kPhone;
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = await _controller(transport);
    bool disposed = false;
    addTearDown(() async {
      if (!disposed) await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
      await controller.session.dispose();
      await transport.close();
    });
    transport.pushStatus(SocketStatus.connected);
    controller.setMode(FlowMode.translate);
    final TimelineEntry seeded = controller.store.buildFromUtterance(
      clientId: 'c-nr89-refusal',
      mode: FlowMode.translate,
      delivery: Delivery.inject,
      text: '你好世界',
    );
    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: controller)));
    await tester.pumpAndSettle();

    final AppStrings s = AppStrings.of(AppLocale.zh);
    // The socket still reports connected, but the emit throws: `ComposeGate._emit`
    // returns false and `start` answers `wireFailed`.
    transport.failEmits = true;
    await tester.longPress(find.text(seeded.displayText).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text(s.entryRetranslate));
    await tester.pumpAndSettle();

    expect(controller.isProcessingUtterance, isFalse, reason: 'setup: the run must not have started');
    final String want = s.aiComposeError(const AiComposeOutcome(reason: AiComposeFailure.wireFailed));
    expect(find.text(want), findsOneWidget, reason: 'refused yet did not tell the user = silent failure');
    expect(find.text(s.reprocessUnavailable), findsNothing, reason: 'told a row with words it has none');
    expect(find.text(s.reprocessBusy), findsNothing);
    expect(controller.store.entries, hasLength(1), reason: 'a refused start must not mint a row');

    transport.failEmits = false;
    controller.session.debugStopIdlePresencePoll();
    disposed = true;
    unawaited(controller.dispose());
    await tester.pump();
  });
}
