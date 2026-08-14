// Card F11 ② — A LATE VERDICT MUST NOT REWRITE A ROW WHOSE DELIVERY IS PROVEN.
//
// THE MEASURED DEFECT (lane G, docs/strategy/2026-08-05-f2-machine-merge-
// delivery-cn.md §10.1): the ONLY gate on the row layer read
// `entry.status == EntryStatus.injected && ok`, so it stopped a repeat of the
// SAME word and let the opposite one through. A second `inject:result` carrying
// `ok:false` dragged a row that the PC had already confirmed as delivered back
// to 未投递 / ✗ — red line R2's second direction (saying a done thing was not
// done), on a row whose sentence is on the user's screen right now.
//
// 🔴 WHAT THIS LAYER CANNOT DO, MEASURED FIRST (see the report §2). Nothing on
// the wire distinguishes "a repeat of the same answer" from "another answer to
// the same question":
// `InjectResultSchema` (protocol-schemas-inject.ts) carries ok / target_window /
// mode / error / inject_target / entry_id / request_id and NOT ONE monotonic
// sequence, timestamp or attempt counter. 15 册 §3.2 makes that worse on
// purpose — an INJ-3 dedup hit is specified to resend "the same receipt" with
// "exactly the same result as the first time". So the choice below is NOT
// "detect the duplicate";
// it is "pick the failure direction per status, and say so out loud".
//
// THE RULE: `EntryStatus.injected` is a ONE-WAY LATCH. Everything else keeps
// today's behaviour, and group ② is the fence that keeps a future "unify while
// we're here" from freezing it — those rows are NOT settled facts, they are the
// current reading of a delivery the queue still owes (owner: 「不管时间多久，全部都要
// 投递」), and freezing them re-creates RV-97 ②.
//
// R11 §2 (15 册 :997) — "must assert the terminal state, must not only assert
// one transition": group ① ends with three
// contradictory late verdicts in a row and asserts where it CONVERGES.
//
// SPEC-REF: docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §3.2 / §4
//   R11; lib/src/timeline/timeline_store_inject_writeback.dart (the gate);
//   lib/src/session/outbox_inject_authorship.dart (who said it — the only
//   authorship fact this layer has, and it answers "who" not "which attempt").

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// A row already proven delivered by the PC, built through the REAL write-back
/// rather than by handing `EntryStatus.injected` to a constructor — the status
/// under test must be one production can produce.
TimelineEntry _deliveredRow(TimelineStore store, {String clientId = 'u-1'}) {
  store.buildFromUtterance(
    clientId: clientId,
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    text: '这句话已经落在电脑上了',
  );
  final bool applied = store.applyInjectResult(
    correlationId: clientId,
    ok: true,
    pcName: 'dev-pc-a',
    target: const InjectTarget(
      windowTitle: 'Untitled - Notepad',
      processName: 'notepad.exe',
      injectedAt: '2026-08-05T01:02:03.000Z',
    ),
  );
  expect(applied, isTrue, reason: 'setup: the first verdict must land');
  final TimelineEntry e = store.findByClientId(clientId)!;
  expect(e.status, EntryStatus.injected, reason: 'setup');
  return e;
}

/// A row still waiting — the POSITIVE CONTROL for every 「the gate held」
/// assertion below. The same verdict, same fixture, one difference: this row
/// has no proven delivery yet. Without it, a write-back that did nothing at all
/// would satisfy every 「must not change」 expectation in this file.
TimelineEntry _waitingRow(TimelineStore store, {String clientId = 'u-wait'}) {
  final TimelineEntry e = store.buildFromUtterance(
    clientId: clientId,
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    text: '这句话还在等判决',
  );
  expect(e.awaitingDelivery, isTrue, reason: 'setup');
  return e;
}

/// Card IT-05 — a row settled `cached && cachedByVerdict` by a verdict the PC
/// gave AFTER actually running the injection stage (`isPcInjectionVerdictCode`
/// — the 「已投递 · 未注入」 / `DeliveryFace.deliveredNotInjected` family, 15 册
/// §2.0.1-a/-d). Built through the REAL write-back, same discipline as
/// [_deliveredRow]: the status under test must be one production can produce.
TimelineEntry _pcVerdictCachedRow(TimelineStore store, {String clientId = 'u-pcv'}) {
  store.buildFromUtterance(
    clientId: clientId,
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    text: '这句话到了电脑上，但没能自动打出来',
  );
  final bool applied = store.applyInjectResult(
    correlationId: clientId,
    ok: false,
    wireMode: TimelineStore.kWireModeCached,
    failureReason: 'INJECT_SELF_WINDOW_NO_INPUT',
  );
  expect(applied, isTrue, reason: 'setup: the PC verdict must land');
  final TimelineEntry e = store.findByClientId(clientId)!;
  expect(e.status, EntryStatus.cached, reason: 'setup');
  expect(e.cachedByVerdict, isTrue, reason: 'setup');
  expect(e.failureReason, 'INJECT_SELF_WINDOW_NO_INPUT', reason: 'setup');
  return e;
}

void main() {
  group('① `injected` is a one-way latch: a proven delivery must not be taken away by a late receipt', () {
    test('a late `ok:false` + `mode:cached` (PC itself answered INJECT_FOCUS_LOST) cannot move it, '
        'while the same verdict applied to a waiting row still takes effect', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry delivered = _deliveredRow(store);
      final TimelineEntry waiting = _waitingRow(store);

      // The worst direction in lane G's table: the PC replayed a cached verdict
      // for a repeated request_id (15 册 §3.2 INJ-3) and the row said 未投递.
      final bool appliedToDelivered = store.applyInjectResult(
        correlationId: 'u-1',
        ok: false,
        wireMode: TimelineStore.kWireModeCached,
        failureReason: 'INJECT_FOCUS_LOST',
      );

      expect(
        appliedToDelivered,
        isFalse,
        reason: 'the gate must return false when it blocks — the caller must not think a write-back happened',
      );
      final TimelineEntry after = store.findById(delivered.id)!;
      expect(after.status, EntryStatus.injected);
      expect(
        after.cachedByVerdict,
        isFalse,
        reason: 'the "verdict said undelivered" bit must never land on a delivered row',
      );
      expect(after.pcName, 'dev-pc-a', reason: 'where it went is still answerable');
      expect(after.failureReason, isNull);
      expect(after.injectTarget, isNotNull);

      // 🔴 Positive control (same fixture, same code): this verdict itself is live.
      final bool appliedToWaiting = store.applyInjectResult(
        correlationId: 'u-wait',
        ok: false,
        wireMode: TimelineStore.kWireModeCached,
        failureReason: 'INJECT_FOCUS_LOST',
      );
      expect(appliedToWaiting, isTrue);
      final TimelineEntry w = store.findById(waiting.id)!;
      expect(w.status, EntryStatus.cached);
      expect(
        w.undelivered,
        isTrue,
        reason: 'positive control: the same verdict on an unproven row must land as 📥未投递',
      );

      store.dispose();
    });

    test('a late `ok:false` + PC itself answered INJECT_SENDINPUT_FAIL also cannot move it, '
        'while the same verdict on a waiting row lands ✗', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry delivered = _deliveredRow(store);
      final TimelineEntry waiting = _waitingRow(store);

      final bool appliedToDelivered = store.applyInjectResult(
        correlationId: 'u-1',
        ok: false,
        wireMode: 'sendinput',
        failureReason: 'INJECT_SENDINPUT_FAIL',
      );

      expect(appliedToDelivered, isFalse);
      final TimelineEntry after = store.findById(delivered.id)!;
      expect(after.status, EntryStatus.injected);
      expect(after.failureReason, isNull);
      expect(after.pcName, 'dev-pc-a');

      // 🔴 Positive control.
      expect(
        store.applyInjectResult(
          correlationId: 'u-wait',
          ok: false,
          wireMode: 'sendinput',
          failureReason: 'INJECT_SENDINPUT_FAIL',
        ),
        isTrue,
      );
      final TimelineEntry w = store.findById(waiting.id)!;
      expect(w.status, EntryStatus.failed);
      expect(w.failureReason, 'INJECT_SENDINPUT_FAIL');

      store.dispose();
    });

    test('R11 §2 asserts the terminal state: after three contradictory late verdicts, the row still converges on `injected`', () {
      // "what it is after settle" and "whether it is still that after one more
      // replay verdict" are two questions (15 册 §4 R11 executable form ②). A
      // single transition asserting green does not mean it can converge — so
      // this sequence **deliberately ends on an `ok:false`**: a sequence that
      // ends on `ok:true` was also green on the old code and would assert
      // nothing (that is how I wrote the first edition; see the delivery doc §8).
      final TimelineStore store = newTestStore();
      final TimelineEntry delivered = _deliveredRow(store);

      store.applyInjectResult(
        correlationId: 'u-1',
        ok: false,
        wireMode: TimelineStore.kWireModeCached,
        failureReason: 'INJECT_FOCUS_LOST',
      );
      // A cross-restart disk-ledger hit: `ok:true`, and 15 册 §3.2 writes in
      // stone that it **omits target**. The old gate (`&& ok`) blocked exactly
      // this shot; this card must not lose that block.
      store.applyInjectResult(correlationId: 'u-1', ok: true);
      store.applyInjectResult(
        correlationId: 'u-1',
        ok: false,
        failureReason: 'INJECT_NOT_IN_ROOM',
        wireMode: TimelineStore.kWireModeCached,
      );

      final TimelineEntry after = store.findById(delivered.id)!;
      expect(after.status, EntryStatus.injected, reason: 'terminal state: converged, not flipping back and forth');
      expect(after.cachedByVerdict, isFalse);
      expect(after.pcName, 'dev-pc-a');
      expect(
        after.injectTarget,
        isNotNull,
        reason: 'a replay receipt that omits target must not wipe "which window it landed in"',
      );

      store.dispose();
    });

    test('a blocked verdict must be readable in diag (same shape as F11① settle_ignored_terminal)',
        () {
      // Self-disclosure: "why this row did not follow the last receipt" must
      // be answerable, otherwise the next investigation of "why it still says
      // delivered" has no trail.
      final TimelineStore store = newTestStore();
      _deliveredRow(store);
      DiagLog.instance.clear();

      store.applyInjectResult(
        correlationId: 'u-1',
        ok: false,
        wireMode: TimelineStore.kWireModeCached,
        failureReason: 'INJECT_FOCUS_LOST',
      );

      final List<String> trail = DiagLog.instance.snapshot();
      expect(
        trail.where((String l) =>
            l.contains('timeline.inject_result_ignored_terminal')),
        hasLength(1),
      );
      final String line = trail.firstWhere((String l) =>
          l.contains('timeline.inject_result_ignored_terminal'));
      expect(line, contains('late_ok=false'));
      expect(line, contains('late_code=INJECT_FOCUS_LOST'));

      store.dispose();
    });
  });

  group('② where the gate deliberately does **not** cover: a still-owed delivery must still be able to converge to success', () {
    // 🔴 This group is not "today's behaviour written as an acceptance spec";
    // it asserts what owner's ruling (「不管时间多久，全部都要投递」) looks like
    // on the row side. Copying the row's terminal state from
    // `OutboxItem.isTerminal` (delivered ∪ refused) would freeze both of these
    // cases, and that is exactly the shape RV-97 ② already paid tuition for
    // (image_send_http.dart:186-196).
    test('✗ INJECT_PC_OFFLINE then the queue re-delivers successfully ⇒ the row must become ✓, must not stay at ✗', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry row = _waitingRow(store, clientId: 'u-offline');

      // Production coordinates: image_send_http.dart:129 (row lands ✗) +
      // settleQueued(ok:false) ⇒ the item returns to queued, the queue still owes it.
      store.applyInjectResult(
        correlationId: 'u-offline',
        ok: false,
        failureReason: 'INJECT_PC_OFFLINE',
      );
      expect(store.findById(row.id)!.status, EntryStatus.failed);

      // Next drain: the same request_id, the PC caught it this time.
      final bool applied = store.applyInjectResult(
        correlationId: 'u-offline',
        ok: true,
        pcName: 'dev-pc-a',
      );

      expect(applied, isTrue);
      final TimelineEntry after = store.findById(row.id)!;
      expect(after.status, EntryStatus.injected);
      // ⚠️ Deliberately **not** asserting `failureReason == null` here.
      // `copyWith`'s `failureReason ?? this.failureReason`
      // (timeline_entry.dart:415) writes in stone "Null cannot clear", and the
      // field comment (:272-274) also writes in stone "a landed row may keep
      // a stale reason; the UI only reads it while status is failed" — that is
      // an **existing convention with a source**, not a defect of this card. My
      // first edition asserted null and went red; see the delivery doc §8.
      // This comment stays to block the next person from "fixing it while
      // they're here".
      expect(after.cachedByVerdict, isFalse, reason: 'what it reads as is ✓, not 📥');

      store.dispose();
    });

    test('📥未投递 (server INJECT_NOT_IN_ROOM) then a successful in-room drain ⇒ the row must converge to ✓',
        () {
      // The second half of the F-1 fix. The sentence in server
      // `relay.handler.ts`
      // `socket.emit('inject:result', { ok:false, mode:'cached',
      //  error:'INJECT_NOT_IN_ROOM', … })` emits exactly
      // `{ok:false, mode:'cached', error:'INJECT_NOT_IN_ROOM'}`.
      final TimelineStore store = newTestStore();
      final TimelineEntry row = _waitingRow(store, clientId: 'u-notinroom');

      store.applyInjectResult(
        correlationId: 'u-notinroom',
        ok: false,
        wireMode: TimelineStore.kWireModeCached,
        failureReason: 'INJECT_NOT_IN_ROOM',
      );
      expect(store.findById(row.id)!.undelivered, isTrue,
          reason: '📥未投递, not ✗ — 15 册 §3.2 "PC busy" row');

      final bool applied = store.applyInjectResult(
        correlationId: 'u-notinroom',
        ok: true,
        pcName: 'dev-pc-a',
      );

      expect(applied, isTrue);
      final TimelineEntry after = store.findById(row.id)!;
      expect(after.status, EntryStatus.injected);
      expect(after.cachedByVerdict, isFalse);

      store.dispose();
    });
  });

  group('③ real chain: the gate blocks "a late receipt", not "the user asked again"', () {
    test('press 重发 on a delivered row ⇒ PC answers ✗ ⇒ the row must land ✗ (the gate must not block a new question)',
        () async {
      final _Harness h = _Harness();
      final TimelineEntry delivered = await h.seedDelivered();

      h.controller.reInject(delivered);
      await pumpEventQueue();

      // Positive control: this trip really reached the wire. Without it,
      // "the row changed" might have been something else.
      expect(
        h.transport.emittedWhere(FlowMicEvents.injectRequest),
        hasLength(1),
        reason: 'positive control: the re-delivery really reached the wire',
      );
      // 🔴 This is the "where the fact came from": the real re-delivery path
      // takes the row out of the terminal state via markReinjecting, so when
      // the answer comes back the gate does not apply at all. Cut that step
      // and this case goes red on the spot (see the delivery doc §5 RC-2).
      expect(
        h.store.findById(kSeedId)!.awaitingDelivery,
        isTrue,
        reason: 'a new question must first leave a mark on the row',
      );

      h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
        'ok': false,
        'mode': 'sendinput',
        'error': 'INJECT_SENDINPUT_FAIL',
        'entry_id': kSeedId,
      });
      await pumpEventQueue();

      final TimelineEntry after = h.store.findById(kSeedId)!;
      expect(after.status, EntryStatus.failed);
      expect(after.failureReason, 'INJECT_SENDINPUT_FAIL');

      await h.dispose();
    });

    test('when no one asked again, the same ✗ walking the full route still cannot move that row', () async {
      // Walk the real onInjectResultRouted route (the **unconditional**
      // write-back at chat_outbox_host.dart:286), not a direct store call —
      // the gate must be installed on that path.
      final _Harness h = _Harness();
      await h.seedDelivered();

      h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
        'ok': false,
        'mode': 'cached',
        'error': 'INJECT_FOCUS_LOST',
        'entry_id': kSeedId,
      });
      await pumpEventQueue();

      final TimelineEntry after = h.store.findById(kSeedId)!;
      expect(after.status, EntryStatus.injected);
      expect(after.cachedByVerdict, isFalse);
      expect(after.pcName, 'dev-pc-a');

      await h.dispose();
    });
  });

  group('④ Card IT-05 — 「已投递 · 未注入」 (pc-injection verdict) is also a one-way latch', () {
    test('a late contradictory receipt (neither a pc-injection nor a pc-admission code) cannot move it, '
        'while the same verdict on a waiting row still lands ✗ (positive control)', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry settled = _pcVerdictCachedRow(store);
      final TimelineEntry waiting = _waitingRow(store, clientId: 'u-pcv-wait');

      // Pre-IT-05 this fell through to the `undelivered` recompute
      // (`wireMode == kWireModeCached || isPcAdmissionRefusalCode(code)`,
      // both false here) and rewrote the row to `failed`.
      final bool appliedToSettled = store.applyInjectResult(
        correlationId: 'u-pcv',
        ok: false,
        wireMode: 'sendinput',
        failureReason: 'INJECT_SENDINPUT_FAIL',
      );

      expect(
        appliedToSettled,
        isFalse,
        reason: 'the gate must return false when it blocks — the caller must not think a write-back happened',
      );
      final TimelineEntry after = store.findById(settled.id)!;
      expect(after.status, EntryStatus.cached);
      expect(
        after.cachedByVerdict,
        isTrue,
        reason: 'a delivery the PC itself proved successful must not be wiped',
      );
      expect(
        after.failureReason,
        'INJECT_SELF_WINDOW_NO_INPUT',
        reason: 'after the gate blocks, the row still holds the original verdict, not the late one',
      );

      // 🔴 Positive control (same fixture, same code): this verdict itself is live.
      final bool appliedToWaiting = store.applyInjectResult(
        correlationId: 'u-pcv-wait',
        ok: false,
        wireMode: 'sendinput',
        failureReason: 'INJECT_SENDINPUT_FAIL',
      );
      expect(appliedToWaiting, isTrue);
      final TimelineEntry w = store.findById(waiting.id)!;
      expect(w.status, EntryStatus.failed);
      expect(w.failureReason, 'INJECT_SENDINPUT_FAIL');

      store.dispose();
    });

    test('a blocked verdict must be readable in diag (same shape as F11① ignored_terminal)',
        () {
      final TimelineStore store = newTestStore();
      _pcVerdictCachedRow(store);
      DiagLog.instance.clear();

      store.applyInjectResult(
        correlationId: 'u-pcv',
        ok: false,
        wireMode: 'sendinput',
        failureReason: 'INJECT_SENDINPUT_FAIL',
      );

      final List<String> trail = DiagLog.instance.snapshot();
      expect(
        trail.where((String l) =>
            l.contains('timeline.inject_result_ignored_terminal')),
        hasLength(1),
      );
      final String line = trail.firstWhere((String l) =>
          l.contains('timeline.inject_result_ignored_terminal'));
      expect(line, contains('entry_status=cached'));
      expect(line, contains('late_code=INJECT_SENDINPUT_FAIL'));

      store.dispose();
    });

    test('⚠️ the gate must not expand to the whole cachedByVerdict face: a pc-admission code (occupied) still converges to success',
        () {
      // Negative control, placed right next to the new gate: INJECT_NOT_PRIMARY
      // is the PC speaking, but it is speaking about the admission layer —
      // owner 2026-08-02 ruled it is not terminal, the queue still owes it
      // (15 册 §2.0.1-a table, second row). This case pins "the criterion is
      // isPcInjectionVerdictCode, not cachedByVerdict", so no one later
      // widens it while they're here.
      final TimelineStore store = newTestStore();
      final TimelineEntry row = _waitingRow(store, clientId: 'u-busy');

      store.applyInjectResult(
        correlationId: 'u-busy',
        ok: false,
        failureReason: 'INJECT_NOT_PRIMARY',
      );
      final TimelineEntry busy = store.findById(row.id)!;
      expect(busy.status, EntryStatus.cached);
      expect(busy.cachedByVerdict, isTrue);
      expect(busy.undelivered, isTrue, reason: '待投递, not 已投递·未注入');

      final bool applied = store.applyInjectResult(
        correlationId: 'u-busy',
        ok: true,
        pcName: 'dev-pc-a',
      );
      expect(
        applied,
        isTrue,
        reason: 'the pc-admission face must not be frozen by the new gate — it is still owed and must be able to converge to success',
      );
      expect(store.findById(row.id)!.status, EntryStatus.injected);

      store.dispose();
    });

    test(
        'after markReinjecting, a row that already had a pc-injection verdict can still receive a new verdict'
        ' (the 重发 button must not be blocked by the gate)', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry settled = _pcVerdictCachedRow(store);

      // Production path: the `deliveredNotInjected` face is in
      // `chat_message_tile.dart`'s `retryableFace` list; pressing 「重发」 first
      // calls markReinjecting to move the row back to delivering, then sends
      // a new frame — the gate should only block "an answer no one is waiting
      // for", not this one.
      final TimelineEntry? reinjecting = store.markReinjecting(settled.id);
      expect(reinjecting, isNotNull);
      expect(reinjecting!.status, EntryStatus.cached);
      expect(
        reinjecting.cachedByVerdict,
        isFalse,
        reason: '重发 must first clear the old-verdict bit, otherwise the gate will mistake the new question for a late receipt and block it',
      );

      final bool applied = store.applyInjectResult(
        correlationId: 'u-pcv',
        ok: true,
        pcName: 'dev-pc-a',
      );
      expect(applied, isTrue, reason: 'the new verdict after 重发 must be able to land, must not be blocked by the gate');
      final TimelineEntry after = store.findById(settled.id)!;
      expect(after.status, EntryStatus.injected);
      expect(after.cachedByVerdict, isFalse);

      store.dispose();
    });
  });
}

const String kSeedId = 'loc_mobile_seed-1';

class _Harness {
  _Harness() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    persistence = InMemoryTimelinePersistence();
    store = newTestStore(persistence: persistence);
    destination = DestinationController();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final InMemoryTimelinePersistence persistence;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  /// Seeded through STORAGE so the row is a real ✓ 已投递 row this device
  /// loaded, not one a test poked into the store after the fact.
  Future<TimelineEntry> seedDelivered() async {
    final DateTime t = DateTime.now().toUtc().subtract(const Duration(hours: 3));
    await persistence.saveAll(<TimelineEntry>[
      TimelineEntry(
        id: kSeedId,
        clientId: 'seed-1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        sourceText: '三小时前落在电脑上的那一句',
        outputText: '三小时前落在电脑上的那一句',
        status: EntryStatus.injected,
        pcName: 'dev-pc-a',
        createdAt: t,
        updatedAt: t,
      ),
    ]);
    await store.load();
    transport.pushStatus(SocketStatus.connected);
    await pumpEventQueue();
    final TimelineEntry? e = store.findById(kSeedId);
    expect(e, isNotNull, reason: 'setup: the seeded row must load');
    expect(e!.status, EntryStatus.injected, reason: 'setup');
    return e;
  }

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}
