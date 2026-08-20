// owner 2026-08-20 — a PC-initiated disconnect is TERMINAL for the phone:
// leave the transcription page, say the owner's sentence, and do not dial.
// docs/decisions/2026-08-20-owner-pc-initiated-disconnect-is-terminal.md
//
// ── WHAT THIS FILE PINS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────
// The trigger here is the NAMED EVENT (`mobile:released`), pushed through the
// fake transport's inbound stream — the same shape the relay produces
// (pc.handler.ts emits it immediately before disconnect(true)). The OLD-relay
// fallback (bare drop → dial → PAIR_RELEASED refusal → hold-out) is pinned by
// hold_out_recheck_wire_test.dart and stays untouched: that behaviour is the
// documented degradation, not a defect.
//
// ⚠️ REVERSE CONTROLS (repo law: a reverse control only counts if it was seen
// red):
//   ① Unwire the `mobile:released` case in ptt_inbound.dart (comment the
//     `releaseCooldown.note` call) ⇒ test ① goes red on the spot — the page
//     stays, because nothing latched. Run and observed during delivery; the
//     measured output is in the delivery notes.
//   ② 「the ladder must be STOPPED, not merely slow」 is asserted positively
//     (`reconnect.isRunning == false`) right next to the eject assertion, so a
//     future edit that keeps the eject but forgets the ladder cannot stay
//     green — that half IS the 49-3 regression (the phone that came back at
//     release + 60.04 s and took the capsule from its owner).
//
// The rig is capsule_taken_exit_test.dart's, verbatim where possible — same
// list screen, same synchronous teardown scar, same rendered-SnackBar
// assertions (0.2.53: `Text.data` proves nothing about what a user could read).

import 'dart:async';

import 'package:flowmic/src/auth/account_store.dart' show InMemoryAccountStore;
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart' show MobileSession;
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/session/machine_key.dart' show scopeKeyFor;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show PairEntry;
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const AppStrings _zh = AppStringsZh();

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
    return r;
  }

  /// A REAL successful pairing, so `SessionScope.key` is set — the released
  /// event is bucketed under it, and an unpaired rig would exercise the
  /// 「note(scopeKey: null) records nothing」 arm instead of the eject.
  Future<void> pairUp() async {
    transport.ackQueue.add(<String, Object?>{
      'token': 'tok-released-0000000000000000000',
      'pc_name': '书房电脑',
      'pc_instance_id': 'inst-study',
    });
    await session.pair(PairEntry.parse('1234'), endpoint: 'ws://192.0.2.5:41879');
    transport.pushStatus(SocketStatus.connected);
  }

  Future<void> enterChat(WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: _ListScreen(), routes: <String, WidgetBuilder>{}),
    );
    final NavigatorState nav =
        tester.state<NavigatorState>(find.byType(Navigator));
    unawaited(
      nav.push<void>(
        MaterialPageRoute<void>(
          builder: (_) => ChatFlowPage(controller: controller),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  /// Same synchronous teardown scar as capsule_taken_exit_test.dart — see its
  /// doc for why nothing here is awaited and why it runs from the body too.
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
  // ── ① The ruling itself: released ⇒ leave, say the sentence, and DO NOT dial ──
  testWidgets(
      '🔴 mobile:released (disconnect) leaves for the list, says the sentence '
      'with the server\'s seconds, and the ladder is STOPPED',
      (WidgetTester tester) async {
    final _Rig r = _Rig.create();
    addTearDown(r.teardownSync);
    await r.pairUp();
    await r.enterChat(tester);
    expect(_chatPage, findsOneWidget, reason: 'positive control: on the screen');
    expect(r.session.reconnect.isRunning, isTrue,
        reason: 'positive control: the ladder was armed by the pairing');

    r.transport.pushIncoming('mobile:released',
        <String, Object?>{'retry_after_ms': 60000, 'revoked': false});
    // The server closes the socket right after saying it (pc.handler.ts) — the
    // drop is part of the production sequence, and it is also what releases the
    // presence poll's periodic timer (the same pending-timer scar the capsule
    // rig documents; its rig never pairs, this one must).
    r.transport.pushStatus(SocketStatus.disconnected);
    await tester.pump(); // the tick edge
    await tester.pump(); // the post-frame callback
    await tester.pumpAndSettle(); // the pop animation

    expect(_chatPage, findsNothing,
        reason: '🔴 the ruling: a PC-initiated disconnect is terminal');
    expect(_list, findsOneWidget);

    // 🔴 THE 49-3 HALF — no machine may dial on this phone's behalf now.
    // Measured on the owner's device: the auto-redial is what let this phone
    // reclaim the capsule at release + 60.04 s over the person who wanted it.
    expect(r.session.reconnect.isRunning, isFalse,
        reason: 'the ladder must be stopped, not merely backing off');

    // The owner's sentence, rendered, with the server's own budget in it.
    final String said = _zh.pcReleasedNotice(60);
    expect(
      find.descendant(of: find.byType(SnackBar), matching: find.text(said)),
      findsOneWidget,
      reason: 'an unexplained ejection reads as the app losing its place',
    );
    final RenderParagraph p = tester.renderObject<RenderParagraph>(
      find.descendant(of: find.byType(SnackBar), matching: find.text(said)),
    );
    expect(p.didExceedMaxLines, isFalse);

    r.teardownSync();
  });

  // ── ② A live REVOKE says the re-pair sentence, and promises no countdown ──
  testWidgets(
      'mobile:released (revoked) leaves with the re-pair sentence — never '
      '「retry in N seconds」 for a row whose token is gone',
      (WidgetTester tester) async {
    final _Rig r = _Rig.create();
    addTearDown(r.teardownSync);
    await r.pairUp();
    await r.enterChat(tester);

    r.transport.pushIncoming('mobile:released',
        <String, Object?>{'retry_after_ms': 0, 'revoked': true});
    r.transport.pushStatus(SocketStatus.disconnected); // see test ① — the real sequence, and the timer scar
    await tester.pump();
    await tester.pump();
    await tester.pumpAndSettle();

    expect(_chatPage, findsNothing);
    expect(
      find.descendant(
        of: find.byType(SnackBar),
        matching: find.text(_zh.pcReleasedRevokedNotice),
      ),
      findsOneWidget,
      reason: 'a revoke can only be re-paired; a countdown would point at a '
          'button that cannot work no matter how long the user waits',
    );
    // …and no deadline was recorded: the row is about to leave the list.
    expect(r.session.releaseCooldown.trackedCount, 0);

    r.teardownSync();
  });

  // ── ③ The cooldown blocks the connect button locally, with the SAME sentence
  //      a server refusal would earn ──
  test('connectTo during the cooldown refuses locally — zero frames leave', () async {
    final FakeSocketTransport transport = FakeSocketTransport()
      ..connectSucceeds = true;
    final PttSession session = newTestSession(transport: transport);
    // Note the cooldown exactly as the inbound case would, under the key the
    // guard re-derives: no machine uid on this pairing, so scopeKeyFor falls
    // back to instance:<identity>, and keyFor(pairing) IS that identity.
    const MobileSession pairing = MobileSession(
      token: 'tok-guard-00000000000000000000',
      endpoint: 'http://192.0.2.5:55889',
    );
    // Written under the SAME key the guard re-derives — through the same two
    // public functions, from the same pairing — so this test breaks the day
    // the write side and the read side stop agreeing on the keyspace.
    session.releaseCooldown.note(
      scopeKey: scopeKeyFor(
        machineUid: pairing.pcMachineUid,
        pairingIdentity: ConnectionsController.keyFor(pairing),
      ),
      retryAfterMs: 60000,
      revoked: false,
    );
    // The guard reads through the pairing row: this rig's session is not
    // paired, so the only way this test passes is the LOCAL refusal — a dial
    // would fail differently (and visibly, via emit bookkeeping below).
    final int emitsBefore = transport.emitted.length;
    final ConnectionsController connections = ConnectionsController(
      session: session,
      login: LoginController(
        transport: transport,
        accountStore: InMemoryAccountStore(),
        saasEndpoint: 'https://relay.invalid',
      ),
      saasEndpoint: 'https://relay.invalid',
    );
    final outcome = await connections.connectTo(pairing);
    expect(outcome.success, isFalse);
    expect(transport.emitted.length, emitsBefore,
        reason: 'the whole point of the local guard: the ask that hands the '
            'evicted phone its head start must never leave this device');
  });
}
