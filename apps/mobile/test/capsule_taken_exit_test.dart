// 🔴 fix-001 / owner 2026-08-11 iron law — the capsule allows only one phone;
// a second phone is sent back to the connections list.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5d
//     ([retired 2026-08-11] original kept; the replacement rule is in the
//     retirement block of the same section)
//   session/pc_busy.dart ([PcBusyTracker] — the criterion and the bucketing
//     rule, neither of which changed)
//   ui/chat_flow_page.dart `_maybeLeaveOnCapsuleTaken`
//
// owner quote: 「出现胶囊窗口的时候，**有且只能有一个手机连上来**，这个是此前已经定下
// 的规则，这个是不允许再出现的……**一定要作为一个铁律生死线**。」
//
// ── This file replaces `pc_busy_banner_test.dart` (13 cases, deleted) ────────
// Those 13 pinned the owner's **2026-08-02** ruling: a second phone **may**
// stay on the transcription page and draw a standing `degraded` banner
// (「你只能先记录，等那台手机退出后再投递」). The 08-11 ruling overturned that
// shape entirely ⇒ the banner, its id, and its copy were deleted together,
// because **the screen they lived on is being exited**; a banner that cannot
// be drawn, left in place, is a façade.
//
// 🔴 What was **kept** from those 13 is the criterion itself, because the
// criterion did not change by a single word:
//   · The only entry is still the server's named `PC_BUSY` (the
//     `mobile:reconnect` ack); occupancy is never inferred from a delivery
//     failure (`INJECT_NOT_IN_ROOM` has half a dozen other causes);
//   · Still **bucketed by machine** (one `Admission` per process, across both
//     channels);
//   · A blocked row is still **not terminal**, and still must not be minted
//     as `noted`.
// Only one thing changed: **what to do after receiving it**.
//
// ⚠️ REVERSE CONTROLS (repo law: a reverse control only counts if it was
// actually seen red):
//   ① Unwire `_maybeLeaveOnCapsuleTaken` from `chat_flow_page.initState`
//      ⇒ 「② real path」 goes red on the spot (the page is still there).
//      Measured original is pasted in the delivery notes.
//   ② 「a refusal that is not occupancy must not eject anyone」 carries its
//      own positive control (same test: PC_BUSY ejects, PAIR_RELEASED does
//      not), so 「was not ejected」 cannot mean the probe is blind.
//   🔴 The direction of ② was chosen deliberately, and this file's predecessor
//      picked the opposite direction **in the same place** once
//      (`hold_out_recheck_wire_test.dart`'s header records that time: a
//      negative assertion wrote the defect into the acceptance criteria).
//      The negative assertion here asks 「**other codes must not trigger
//      exit**」 — if I am wrong, the positive test in ① will tell me, because
//      the two assert both directions of the same wire.

import 'dart:async';

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/pc_busy.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const AppStrings _zh = AppStringsZh();
const List<AppLocale> _locales = <AppLocale>[
  AppLocale.zh,
  AppLocale.en,
  AppLocale.ja,
  AppLocale.ko,
];

/// The instance-list screen the phone is sent BACK to. It only has to be a
/// distinct first route: `_maybeLeaveOnCapsuleTaken` pops until `isFirst`, so
/// 「left the transcription page」 is observable as 「this screen appeared again」.
class _ListScreen extends StatelessWidget {
  const _ListScreen();
  @override
  Widget build(BuildContext context) =>
      const Scaffold(body: Center(child: Text('CONNECTIONS-LIST')));
}

class _Rig {
  _Rig._();

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  static _Rig create() {
    final _Rig r = _Rig._();
    r.transport = FakeSocketTransport()..connectSucceeds = true;
    r.session = newTestSession(transport: r.transport);
    // Endpoint probing must never touch a real network: these tests are about
    // what happens AFTER a named refusal, not about address selection.
    r.session.healthReader = (Uri url, Duration timeout) async =>
        HealthReading.offline;
    r.store = newTestStore();
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

  /// Push the transcription screen on top of the list, as the app does.
  Future<void> enterChat(WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: _ListScreen(),
        routes: <String, WidgetBuilder>{},
      ),
    );
    final NavigatorState nav = tester.state<NavigatorState>(find.byType(Navigator));
    unawaited(
      nav.push<void>(
        MaterialPageRoute<void>(
          builder: (_) => ChatFlowPage(controller: controller),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  /// The production path a refusal really travels: `resumePairing` →
  /// `mobile:reconnect` → the server's named ack. Nothing here reaches past the
  /// transport, so the verdict is produced by shipping code.
  ///
  /// 🔴 `retry_after_ms` is deliberately OMITTED, and that is a load-bearing
  /// choice rather than a shortcut. The two facts on this ack have two owners
  /// (ptt_reconnect_ack.dart states it in as many words): the CODE decides the
  /// occupancy latch, the BUDGET decides whether [HoldOutRetry] arms a timer.
  /// Sending no budget therefore isolates the thing under test — the exit must
  /// follow `PC_BUSY` ALONE. It also keeps the rig honest: a budget would arm a
  /// real timer that `PttSession.dispose()` only cancels AFTER eight awaits, so
  /// the binding's 「timersPending」 check (which runs before `addTearDown`)
  /// would fail every one of these tests for a reason that has nothing to do
  /// with the red line. Measured, not guessed — that is how this rig first went
  /// red.
  Future<void> refuseWith(String code) async {
    transport.ackQueue.add(<String, Object?>{'error': code, 'retryable': true});
    await session.resumePairing(
      MobileSession(token: 't' * 32, endpoint: 'http://192.0.2.5:55889'),
    );
  }

  /// 🔴 SYNCHRONOUS, and `session.dispose()` is NOT awaited — the measured scar
  /// link_loss_banner_test.dart's header records: inside `testWidgets`' FakeAsync
  /// zone the session's own awaits never complete.
  ///
  /// ⚠️ Do NOT lean on `session.dispose()` to release timers here. Its
  /// `_holdOut.cancel()` sits BEHIND eight awaits (ptt_session_dispose.dart), so
  /// an un-awaited call never reaches it — measured, after that was the first
  /// thing tried. What actually keeps this rig timer-free is [refuseWith]
  /// sending no budget at all; see its doc.
  ///
  /// ⚠️ Idempotent, and called from BOTH inside the test body and `addTearDown`.
  /// The binding's 「timersPending」 check runs at the end of `_runTestBody`,
  /// i.e. BEFORE `addTearDown` callbacks — so a tear-down registered only there
  /// is measurably too late to release the hold-out timer. The in-body call is
  /// the one that satisfies the binding; the registered one is the safety net
  /// for a body that throws before reaching it (otherwise a real assertion
  /// failure gets buried under a timer complaint, which is exactly how this rig
  /// first presented).
  bool _torn = false;
  void teardownSync() {
    if (_torn) return;
    _torn = true;
    debugCancelBannerAutoHideTimers(controller);
    unawaited(controller.dispose());
    unawaited(session.dispose());
    destination.dispose();
    store.dispose();
  }
}

Finder get _chatPage => find.byType(ChatFlowPage);
Finder get _list => find.text('CONNECTIONS-LIST');

void main() {
  // ── ① Real path: PC_BUSY ⇒ leave the transcription page, and say why ──────
  testWidgets(
      '🔴 THE RED LINE — a second phone told PC_BUSY leaves the transcription '
      'screen for the connections list, and is told why', (WidgetTester tester) async {
    final _Rig r = _Rig.create();
    addTearDown(r.teardownSync);
    await r.enterChat(tester);

    // Positive control: it is **really** on the transcription page. Without
    // this, the findsNothing below could just mean 「this finder never found
    // anything」.
    expect(_chatPage, findsOneWidget, reason: 'positive control: we are on the screen');
    expect(_list, findsNothing);

    await r.refuseWith('PC_BUSY');
    await tester.pump();            // the notify
    await tester.pump();            // the post-frame callback
    await tester.pumpAndSettle();   // the pop animation

    // 🔴 The owner's symptom itself: a second phone **must not** stay on the
    // transcription UI.
    expect(_chatPage, findsNothing, reason: '🔴 THE CARD: 有且只能有一个手机连上来');
    expect(_list, findsOneWidget, reason: 'sent back to the connections list, not left on a blank');

    // …and it said why. The assertion lands on the **rendered** SnackBar
    // (0.2.53's lesson: asserting `Text.data` has zero proof of 「what the
    // user actually read」).
    expect(
      find.descendant(of: find.byType(SnackBar), matching: find.text(_zh.capsuleTakenNotice)),
      findsOneWidget,
      reason: 'a jump with no explanation reads as the app losing its own place',
    );

    // 🔴 And that sentence was not clipped — 「can the user read this sentence」
    // can only be asked of the result after layout.
    final RenderParagraph p = tester.renderObject<RenderParagraph>(
      find.descendant(of: find.byType(SnackBar), matching: find.text(_zh.capsuleTakenNotice)),
    );
    expect(p.didExceedMaxLines, isFalse, reason: 'this sentence was clipped by the SnackBar');

    r.teardownSync();
  });

  // ── ② Reverse control: a refusal that is not occupancy must not eject anyone ──
  testWidgets(
      'REVERSE CONTROL — a refusal that is NOT occupancy must not eject anyone',
      (WidgetTester tester) async {
    final _Rig r = _Rig.create();
    addTearDown(r.teardownSync);
    await r.enterChat(tester);
    expect(_chatPage, findsOneWidget);

    // `PAIR_RELEASED` is also 「blocked at the door」 and also carries a budget,
    // but it answers 「someone on the PC pressed disconnect」. That path has
    // its own handling (HoldOutRetry asks again when the budget expires); it
    // is **not** 「this PC is being used by someone else」.
    await r.refuseWith('PAIR_RELEASED');
    await tester.pump();
    await tester.pump();
    await tester.pumpAndSettle();

    expect(_chatPage, findsOneWidget,
        reason: 'reading any refusal as occupancy = one value answering two questions (this repo\'s #1 bug shape)');
    expect(
      find.descendant(of: find.byType(SnackBar), matching: find.text(_zh.capsuleTakenNotice)),
      findsNothing,
    );

    r.teardownSync();
  });

  // ── ③ Four locales + R11: the sentence must answer 「凭什么这么说」, and must not leak a bare code ──
  group('③ four-locale copy', () {
    test('all four sentences are non-empty and pairwise distinct', () {
      final Set<String> said = <String>{};
      for (final AppLocale loc in _locales) {
        final String s = AppStrings(loc).capsuleTakenNotice;
        expect(s.trim(), isNotEmpty, reason: '$loc missing translation');
        said.add(s);
      }
      expect(said.length, _locales.length, reason: 'a locale copied someone else\'s sentence');
    });

    test('🔴 not one bare error code may appear (the 0.2.53 shape)', () {
      for (final AppLocale loc in _locales) {
        final String s = AppStrings(loc).capsuleTakenNotice;
        expect(s.contains('PC_BUSY'), isFalse, reason: '$loc');
        expect(s.contains('_'), isFalse,
            reason: '$loc: an underscore is the first symptom of a leaked bare identifier');
      }
    });

    test('🔴 the copy must not call these rows 「仅记录」', () {
      // Kept from pc_busy_banner_test: `noted` is R9 「unconditionally do not
      // sync to the PC」. A second phone is no longer on the transcription
      // page at all, so it even less should be told its words were stored as
      // something that will never go out.
      for (final AppLocale loc in _locales) {
        final AppStrings s = AppStrings(loc);
        expect(s.capsuleTakenNotice.contains(s.recordOnly), isFalse, reason: '$loc');
      }
    });

    test('Chinese says 「这台电脑」 not 「这条通道」 (occupancy is judged per machine)', () {
      // The criterion did not change: desktop Admission is one per process,
      // shared by both channels
      // (admission.rs: a second phone on EITHER channel is REFUSED).
      expect(_zh.capsuleTakenNotice, contains('这台电脑'));
      expect(_zh.capsuleTakenNotice.contains('通道'), isFalse);
    });
  });

  // ── ④ Criterion and bucketing: not one word changed, so pin them as before ──
  group('④ criterion and bucketing (kept from §2.5d; the rule did not change)', () {
    test('occupancy on A does not appear on B\'s screen; back on A it is still there', () {
      final PcBusyTracker t = PcBusyTracker();
      t.note(busy: true, instanceId: 'inst-A');
      expect(t.isOnScreen('inst-A'), isTrue, reason: 'positive control: A can see its own');
      expect(t.isOnScreen('inst-B'), isFalse,
          reason: '🔴 otherwise being blocked on A would eject the user from B\'s transcription page');
      expect(t.isOnScreen('inst-A'), isTrue, reason: 'it is hidden, not discarded');
    });

    test('clearing also drops the bucket key (do not leave an unused old id)', () {
      final PcBusyTracker t = PcBusyTracker();
      t.note(busy: true, instanceId: 'inst-A');
      t.note(busy: false);
      expect(t.raw, isFalse);
      expect(t.isOnScreen('inst-A'), isFalse);
    });

    test('🔴 PC_BUSY / INJECT_NOT_IN_ROOM are both not terminal codes — the queue will still redeliver', () {
      expect(isTerminalRefusalCode('PC_BUSY'), isFalse);
      expect(isTerminalRefusalCode('INJECT_NOT_IN_ROOM'), isFalse);
      // Positive control: a real terminal code is true under the same
      // predicate, so the false above is not a blind probe.
      expect(isTerminalRefusalCode('INJECT_PC_MISMATCH'), isTrue);
    });

    test('🔴 a row blocked by occupancy must never be minted as noted', () {
      final DateTime t = DateTime.utc(2026, 8, 11, 10);
      TimelineEntry row(String code) => TimelineEntry(
            id: 'loc_a_1',
            clientId: 'c1',
            mode: FlowMode.realtime,
            delivery: Delivery.inject,
            sourceText: '你好',
            outputText: '你好',
            status: EntryStatus.cached,
            origin: 'paired',
            entryType: TimelineEntry.kTranscript,
            failureReason: code,
            cachedByVerdict: true,
            createdAt: t,
            updatedAt: t,
          );
      for (final String code in <String>['PC_BUSY', 'INJECT_NOT_IN_ROOM']) {
        expect(deliveryFaceOf(row(code), queued: false), isNot(DeliveryFace.noted),
            reason: code);
      }
    });
  });
}
