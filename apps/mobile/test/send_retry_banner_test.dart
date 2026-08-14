// RV-15 — the send-failure banner's resend must re-deliver EVERY row the failed
// send covered, not the newest one of them.
//
// The defect: `_sendRetryTarget()` walked the store for the NEWEST failed
// PC-bound row and re-sent that ONE row's text through sendFavorite. A single ➤
// covers N rows whenever the buffer holds several utterances (organize mode's
// normal shape), and ManualDelivery settles ALL N as ✗ — so resend delivered 1 of
// N while the other N-1 were gone from the retry AND from the composer. Worse,
// with a covered send the newest failed row is not even guaranteed to be one of
// the rows that just failed.
//
// The rows are no longer guessed: ManualDelivery records the batch it settled
// (`lastFailedCoveredIds`, unit-tested in inject_result_watchdog_test.dart) and
// the banner re-delivers each one through `ChatController.reInject` — the SAME
// catch-up path the failed row's inline resend and the long-press menu already used.
//
// Counted through the TRANSPORT (`history:inject` frames), never through an
// `extends`-based spy: this repo has been burned by spies that quietly stopped
// exercising the real path. The frames on the wire are the production truth.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_retry_targets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

const AppStrings _zh = AppStringsZh();

/// The banner's own resend. Scoped to [BannerSlot] on purpose: every failed row in
/// the list renders the SAME word inline (ChatMessageTile's M2 affordance), so
/// a bare `find.text('重发')` would match the rows too and prove nothing about
/// which path was tapped.
final Finder _bannerResend = find.descendant(
  of: find.byType(BannerSlot),
  matching: find.text(_zh.resendAction),
);

Finder _bannerText(String message) => find.descendant(
  of: find.byType(BannerSlot),
  matching: find.text(message),
);

class _FakeOwner implements InstanceOwnerProbe {
  _FakeOwner(this.instanceId, this.instanceName);
  @override
  String? instanceId;
  @override
  String? instanceName;
}

class _Rig {
  _Rig._();

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  /// A session paired for real against the fake transport — the narrowed chat
  /// (and therefore the retry resolution) reads `connectedInstanceId`, so an
  /// unpaired harness would exercise the empty state instead.
  static Future<_Rig> create() async {
    final _Rig r = _Rig._();
    r.transport = FakeSocketTransport()..connectSucceeds = true;
    r.session = newTestSession(
      transport: r.transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    r.transport.ackQueue.add(<String, Object?>{
      'token': 'tok-retry-00000000000000000000000',
      'pc_name': '书房电脑',
      'pc_instance_id': 'inst-study',
    });
    final PairResult pair = await r.session.pair(
      PairEntry.parse('1234'),
      endpoint: 'ws://192.0.2.7:41879',
    );
    expect(pair.ok, isTrue, reason: 'harness pair failed: ${pair.error}');

    r.store = newTestStore(
      deviceId: 'phone',
      owner: _FakeOwner(r.session.connectedInstanceId, '书房电脑'),
    );
    r.destination = DestinationController();
    final InMemoryLocalPrefs prefs = InMemoryLocalPrefs();
    r.controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: r.session,
      store: r.store,
      destination: r.destination,
      syncGate: TimelineSyncGate(transport: r.transport),
      localPrefs: prefs,
    );
    r.registerTeardown();
    return r;
  }

  int _seq = 0;

  /// One PC-bound row born under the connected instance — an utterance sitting
  /// in the buffer waiting for a ➤.
  String seed(String text) => store
      .buildFromUtterance(
        clientId: 'c${_seq++}',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: text,
      )
      .id;

  /// A row that failed on its OWN, outside any covered send. The retired
  /// implementation picked the newest failed row in the store, which is exactly
  /// this shape — so its absence from the retry is the regression guard.
  String seedUncoveredFailure(String text) {
    final String id = seed(text);
    store.applyInjectResult(
      correlationId: id,
      ok: false,
      failureReason: 'INJECT_FOCUS_LOST',
    );
    return id;
  }

  Future<void> pumpPage(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: controller)));
    await tester.pump();
  }

  /// The row ids that actually left the device as a catch-up, in emission order.
  ///
  /// 0.2.27: read off `inject:request{source:'history'}.entry_id` instead of
  /// `history:inject.id`. Catch-up carries its own text now (the server no longer
  /// holds the row to look it up), and `entry_id` is the same correlation key.
  List<String> get injectedIds => transport.emitted
      .where((EventEnvelope e) =>
          e.name == FlowMicEvents.injectRequest &&
          (e.data! as Map)['source'] == 'history')
      .map((EventEnvelope e) =>
          Map<String, Object?>.from(e.data! as Map)['entry_id']! as String)
      .toList();

  /// RV-02: a retry is a DELIVERY now, so each re-injected row arms a 20 s
  /// inject:result watchdog (a catch-up the PC never answers has to settle ✗ instead
  /// of sitting at ⏳ forever). Call this after the assertions of any test that
  /// actually taps resend: FakeAsync checks for pending timers when the test BODY
  /// ends, which is BEFORE [registerTeardown]'s dispose runs — the same scar
  /// conn_dot_widget_test records ('no pending timer leaks past the test body').
  /// Letting them FIRE instead is not an option here: that would raise a fresh
  /// noResult banner and rewrite the very rows the assertions just read.
  ///
  /// Window C-5: also cancels any still-armed banner auto-hide timer (see
  /// `debugCancelBannerAutoHideTimers`'s doc) — the IDENTICAL problem, now on a
  /// SECOND timer family. Call this after the assertions of any test that
  /// leaves a composeSend-failure banner showing (never dismissed, never
  /// elapsed) at its own end, not only the ones that tap resend.
  /// G-15①: `create()` runs a REAL `pair()`, which — now that it is genuinely
  /// paired — arms the idle presence-poll `Timer` (ptt_presence_poll.dart).
  /// IDENTICAL problem, THIRD timer family: `AutomatedTestWidgetsFlutterBinding`
  /// checks for pending timers the instant the widget tree is torn down, which
  /// is before [registerTeardown]'s `addTearDown` runs. Uses the dedicated
  /// escape hatch (not a simulated disconnect): a real `pushStatus(disconnected)`
  /// was tried first and rejected — it also reaches `ChatController`'s OWN
  /// session-loss watchdog off the same FSM edge, trading this leak for a
  /// different one this file has no business reaching into.
  void releaseWatchdogs() {
    controller.delivery.dispose();
    debugCancelBannerAutoHideTimers(controller);
    session.debugStopIdlePresencePoll();
  }

  /// Teardown must run through [addTearDown], NEVER as an `await` at the end of
  /// a testWidgets body: `PttSession.dispose` awaits `reconnect.stop()` and five
  /// broadcast-controller closes, and inside the FakeAsync zone those never
  /// complete — the binding then spins waiting for a body future that cannot
  /// resolve, which hangs the whole run past `--timeout` (measured: 20 min, 3 s
  /// of CPU). addTearDown runs after the widget tree is disposed and outside
  /// that zone. This is the same scar typed_send_row_test.dart records at the
  /// top of the file.
  void registerTeardown() {
    addTearDown(() async {
      await controller.dispose();
      destination.dispose();
      store.dispose();
      await session.dispose();
      await transport.close();
    });
  }
}

void main() {
  testWidgets('a ➤ that covered 3 rows and failed re-delivers ALL 3 — one '
      'history:inject per row, in the order they were spoken', (
    WidgetTester tester,
  ) async {
    final _Rig r = await _Rig.create();
    final List<String> ids = <String>[
      r.seed('第一段'),
      r.seed('第二段'),
      r.seed('第三段'),
    ];
    await r.pumpPage(tester);

    // The production settlement path: one send, three rows, all marked ✗.
    r.controller.delivery.failSettled(ids, ComposeSendFailure.wireFailed);
    await tester.pump();
    expect(_bannerResend, findsOneWidget);

    await tester.tap(_bannerResend);
    await tester.pump();

    expect(
      r.injectedIds,
      ids,
      reason: 'the retry re-delivered 1 of 3 before RV-15; all three rows '
          'failed, so all three must go back out — and in spoken order, not the '
          "store's newest-first",
    );
    // Dismiss-before-send is load-bearing: a retry that fails again raises a
    // FRESH banner, which dismissing afterwards would swallow.
    expect(_bannerResend, findsNothing);
    r.releaseWatchdogs();
  });

  testWidgets('a covered row deleted since the failure is skipped — the retry '
      'never falls back to the newest failed row', (WidgetTester tester) async {
    final _Rig r = await _Rig.create();
    final List<String> ids = <String>[r.seed('甲'), r.seed('乙'), r.seed('丙')];
    final String uncovered = r.seedUncoveredFailure('不该被重发的旧行');
    await r.pumpPage(tester);

    r.controller.delivery.failSettled(ids, ComposeSendFailure.wireFailed);
    r.store.delete(ids[1]);
    await tester.pump();

    await tester.tap(_bannerResend);
    await tester.pump();

    expect(r.injectedIds, <String>[ids[0], ids[2]]);
    expect(
      r.injectedIds,
      isNot(contains(uncovered)),
      reason: 'a row this send never covered must never be pushed to the PC — '
          'guessing a target delivers the WRONG words',
    );
    r.releaseWatchdogs();
  });

  testWidgets('every covered row gone ⇒ the banner becomes a plain notice, not '
      'a guess', (WidgetTester tester) async {
    final _Rig r = await _Rig.create();
    final List<String> ids = <String>[r.seed('甲'), r.seed('乙')];
    r.seedUncoveredFailure('旧的失败行还在');
    await r.pumpPage(tester);

    r.controller.delivery.failSettled(ids, ComposeSendFailure.wireFailed);
    for (final String id in ids) {
      r.store.delete(id);
    }
    await tester.pump();

    expect(
      _bannerResend,
      findsNothing,
      reason: 'no resolvable target ⇒ withhold the button; re-sending some '
          'other failed row would be worse than offering nothing',
    );
    // …but the failure itself is still said out loud (no silent failure).
    expect(
      _bannerText(_zh.composeSendError(ComposeSendFailure.wireFailed)),
      findsOneWidget,
    );
    // Window C-5: this banner is left showing on purpose (nothing to tap) — its
    // auto-hide Timer is still armed when the test ends.
    r.releaseWatchdogs();
  });

  testWidgets('notConnected / emptyBuffer / noPcTarget still offer no resend — '
      'their text never left the composer', (WidgetTester tester) async {
    final _Rig r = await _Rig.create();
    r.seedUncoveredFailure('一条早先失败的行');
    await r.pumpPage(tester);

    for (final ComposeSendFailure f in <ComposeSendFailure>[
      ComposeSendFailure.notConnected,
      ComposeSendFailure.emptyBuffer,
      ComposeSendFailure.noPcTarget,
    ]) {
      r.controller.delivery.raise(f);
      await tester.pump();
      expect(_bannerText(_zh.composeSendError(f)), findsOneWidget,
          reason: '$f must still be said out loud');
      expect(_bannerResend, findsNothing,
          reason: '$f built no row — the words are still in the buffer, so '
              'resending a row would deliver the wrong text');
    }
    // Window C-5: the last iteration's banner is left showing — see the note on
    // the previous test.
    r.releaseWatchdogs();
  });

  testWidgets('linkDown settles rows AND records them, yet still offers no resend '
      '— the reason gate does its own work', (WidgetTester tester) async {
    // Without this case the reason gate could be passing only because the
    // recorded batch happens to be empty for the other reasons.
    final _Rig r = await _Rig.create();
    final List<String> ids = <String>[r.seed('甲'), r.seed('乙')];
    await r.pumpPage(tester);

    r.controller.delivery.failSettled(ids, ComposeSendFailure.linkDown);
    await tester.pump();

    expect(r.controller.delivery.lastFailedCoveredIds, ids);
    expect(_bannerResend, findsNothing);
    expect(
      _bannerText(_zh.composeSendError(ComposeSendFailure.linkDown)),
      findsOneWidget,
    );
    expect(r.injectedIds, isEmpty);
    // Window C-5: this banner is left showing on purpose (nothing to tap) — its
    // auto-hide Timer is still armed when the test ends.
    r.releaseWatchdogs();
  });

  // The row filters, exercised on the pure function (chat_retry_targets.dart)
  // rather than through a pumped page — each one is a 「why this row must not be resent」
  // judgement, and none of them needs a widget to be true.
  group('sendRetryTargets: which covered rows are genuinely re-deliverable', () {
    const String iid = 'inst-study';
    late _FakeOwner owner;
    late TimelineStore store;
    int seq = 0;

    setUp(() {
      owner = _FakeOwner(iid, '书房电脑');
      store = newTestStore(deviceId: 'phone', owner: owner);
      seq = 0;
    });
    tearDown(() => store.dispose());

    String row(
      String text, {
      String entryType = TimelineEntry.kTranscript,
      String origin = 'paired',
      bool fail = true,
    }) {
      final String id = store
          .buildFromUtterance(
            clientId: 'p${seq++}',
            mode: FlowMode.realtime,
            delivery: Delivery.inject,
            text: text,
            origin: origin,
            entryType: entryType,
          )
          .id;
      if (fail) {
        store.applyInjectResult(
          correlationId: id,
          ok: false,
          failureReason: 'WIRE_EMIT_FAILED',
        );
      }
      return id;
    }

    List<String> targetsFor(List<String> covered, {String? instance = iid}) =>
        sendRetryTargets(
          failure: ComposeSendFailure.wireFailed,
          coveredIds: covered,
          store: store,
          instanceId: instance,
        ).map((TimelineEntry e) => e.id).toList();

    test('a picture row is never re-sent — the bytes are not retained, so its '
        'text is only a descriptor', () {
      final String text = row('会重发的一句');
      final String image = row('[图片] PNG 12 KB', entryType: TimelineEntry.kImage);
      expect(targetsFor(<String>[text, image]), <String>[text]);
    });

    test('a cloud row is never re-sent — there is no PC focus window', () {
      final String text = row('会重发的一句');
      final String cloud = row('云端随手记', origin: 'cloud');
      expect(targetsFor(<String>[text, cloud]), <String>[text]);
    });

    test('a row that is no longer ✗ is left alone (a late inject:result may '
        'have settled it after the banner went up)', () {
      final String failed = row('确实失败了');
      final String pending = row('还在等结果', fail: false);
      expect(targetsFor(<String>[failed, pending]), <String>[failed]);
    });

    test('a blank row has nothing to deliver', () {
      final String text = row('有内容');
      final String blank = row('   ');
      expect(targetsFor(<String>[text, blank]), <String>[text]);
    });

    test('a row born talking to ANOTHER PC is not re-delivered here, and a null '
        'instance yields nothing at all', () {
      final String mine = row('对书房说的');
      owner.instanceId = 'inst-living';
      final String theirs = row('对客厅说的');
      expect(targetsFor(<String>[mine, theirs]), <String>[mine]);
      expect(targetsFor(<String>[mine], instance: null), isEmpty);
    });
  });
}
