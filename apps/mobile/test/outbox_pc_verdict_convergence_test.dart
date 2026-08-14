// Card F2 — **convergence**: a PC-spoken injection-leg verdict must take the
// queue item to a terminal state, and to the success side of that terminal.
//
// owner iron rule 2026-08-02:「转录消息的状态一定要对。」owner real-device symptom:
// speak while focus is on FlowMic's own window ⇒ PC receives, mints a row,
// replies `ok:false, mode:'cached', INJECT_FOCUS_LOST` ⇒ **the phone still
// shows「待投递」**, and nothing ever turns it into anything else.
//
// 🔴 This file asserts the **terminal state**, not a single settle return
// value. 「the verdict was right the one time it arrived」 does not prove
// 「it will not be flipped back」 — the 0.2.48 deadlock was exactly
// 「every verdict pushed it back to queued」.
//
// ⚠️ Reverse control (strip the `isPcInjectionVerdictCode` branch out of
// settle ⇒ must go red) was run by hand; the red wording went into the
// delivery report. The **positive control** that corresponds to it in this
// file is the two cases 「a code not in the set still returns queued」 —
// without those, a bad implementation that judges everything delivered
// would also be all-green.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0.1 (three-state map) / §2.6 (transition table)
//   packages/protocol/src/inject-verdict-authorship.ts (single source of authorship)

import 'dart:typed_data';

import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';

const String _kMachine = 'machine-uid-AAAA';
const String _kPairing = 'standalone|instance:inst-A-lan';
const LiveConnection _kOnLan = LiveConnection(
  machineUid: _kMachine,
  pairingIdentity: _kPairing,
  pcId: 'pc-A-lan',
  channel: ServerChannel.lan,
);

class _Host implements OutboxDrainHost {
  int sends = 0;
  @override
  LiveConnection get liveConnection => _kOnLan;
  @override
  Future<bool> ensureLink() async => true;
  @override
  Future<void> reseedDestination() async {}
  @override
  Future<bool> send(
    OutboxItem item,
    String targetPcId, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  }) async {
    sends++;
    return true;
  }

  @override
  void onOutboxChanged() {}
}

DeliveryOutbox _box(_Host host, OutboxStore store) => DeliveryOutbox(
  store: store,
  blobs: InMemoryOutboxBlobStore(),
  host: host,
  capacity: kOutboxCapacity,
  inflightTimeout: kOutboxInflightTimeout,
);

Future<OutboxItem?> _enqueue(DeliveryOutbox box, {String requestId = 'r1'}) =>
    box.enqueueText(
      requestId: requestId,
      entryId: 'loc_$requestId',
      wireEntryId: 'loc_$requestId',
      source: 'stt',
      text: '你好电脑',
      mode: 'realtime',
      createdAt: DateTime.utc(2026, 8, 2, 10, 0),
    );

Future<OutboxItem?> _read(OutboxStore store, String requestId) =>
    store.findByRequestId(requestId);

void main() {
  group('F2 · a PC-spoken injection-leg verdict ⇒ queue terminal state delivered', () {
    test('🔴 INJECT_FOCUS_LOST (this card\'s symptom) is delivered after settle, not queued', () async {
      final _Host host = _Host();
      final OutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _box(host, store);
      await _enqueue(box);
      await box.drain();
      expect((await _read(store, 'r1'))!.state, OutboxDeliveryState.inflight);

      // The PC's own words: the frame arrived, the row was minted, injection did not land.
      await box.settle(correlationId: 'r1', ok: false, code: 'INJECT_FOCUS_LOST');

      final OutboxItem after = (await _read(store, 'r1'))!;
      expect(after.state, OutboxDeliveryState.delivered);
      expect(after.isTerminal, isTrue);
      // 「还有 N 条待投递」 must no longer count it — that banner counts loadPending().
      expect(box.pendingCountFor(_kPairing), 0);
      expect(await store.loadPending(), isEmpty);
      box.dispose();
    });

    test('🔴 the terminal state is stable: the same verdict three more times is still delivered (never flipped back to queued)', () async {
      // This case IS 「convergence」 itself. The 0.2.48 deadlock was not
      // 「the first verdict was wrong」, it was 「every verdict pushed it
      // back to queued」 — an implementation that only asserts the first
      // time is green on that defect.
      final _Host host = _Host();
      final OutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _box(host, store);
      await _enqueue(box);
      await box.drain();
      for (int i = 0; i < 4; i++) {
        await box.settle(correlationId: 'r1', ok: false, code: 'INJECT_FOCUS_LOST');
      }
      expect((await _read(store, 'r1'))!.state, OutboxDeliveryState.delivered);
      // Drain must not pick it back up either (a terminal item is not in
      // loadPending ⇒ it will not go on the wire again).
      final int before = host.sends;
      await box.drain();
      expect(host.sends, before);
      box.dispose();
    });

    test('🔴 self-heal: an old item stuck in queued flips to delivered the next time a verdict arrives', () async {
      // Items left behind by an upgrade look like this: they once received a
      // cached verdict, were pushed back to queued, and have been lying there
      // ever since. They need no migration — the next drain's verdict settles
      // them.
      final _Host host = _Host();
      final OutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _box(host, store);
      await _enqueue(box);
      final OutboxItem stuck = (await _read(store, 'r1'))!.copyWith(
        state: OutboxDeliveryState.queued,
        lastRefusalNote: 'INJECT_FOCUS_LOST',
      );
      await store.upsert(stuck);
      expect(box.pendingCountFor(_kPairing), greaterThanOrEqualTo(0));

      await box.settle(correlationId: 'r1', ok: false, code: 'INJECT_FOCUS_LOST');
      expect((await _read(store, 'r1'))!.state, OutboxDeliveryState.delivered);
      box.dispose();
    });

    test('every code in the family converges (we did not only fix FOCUS_LOST)', () async {
      for (final String code in <String>[
        'INJECT_FOCUS_LOST',
        'INJECT_CLIPBOARD_FAIL',
        'INJECT_IMAGE_UNSUPPORTED',
        'INJECT_TARGET_INVALID',
        'INJECT_SENDINPUT_FAIL',
        'INJECT_NO_TEXT_TARGET',
        'INJECT_DEFERRED_NOT_AUTOINJECTED',
        // MAC-05 (owner 2026-08-07 approved 63/64).
        'INJECT_SECURE_INPUT_ACTIVE',
        'INJECT_NO_ACCESSIBILITY',
      ]) {
        final _Host host = _Host();
        final OutboxStore store = InMemoryOutboxStore();
        final DeliveryOutbox box = _box(host, store);
        await _enqueue(box);
        await box.drain();
        await box.settle(correlationId: 'r1', ok: false, code: code);
        expect(
          (await _read(store, 'r1'))!.state,
          OutboxDeliveryState.delivered,
          reason: code,
        );
        box.dispose();
      }
    });
  });

  // ── MAC-05 · queue semantics of error codes 63/64, one case per code ──────
  //
  // 🔴 The failure shape this group guards against is **not 「the status looks
  // bad」**, it is a verbatim remake of the 0.2.48 P0: [kPcInjectionVerdictCodes]
  // is a **closed set**, an unregistered code falls into the retryable `else`
  // of `outboxSettle` ⇒ the item returns to `queued` ⇒ the row **forever
  // shows「待投递」**, the banner forever counts it, and the message is on the
  // user's PC screen right now. Both codes were **already shipping** in W3's
  // mac artifact, they just were not in the registry ⇒ that is the entire
  // content of the 「mac must not enter a distribution channel」 hard block.
  //
  // ⚠️ **Why one case per code instead of folding them into the loop above**
  // (they are also in the loop; both places are required): the loop goes red
  // as soon as **any** code regresses and you cannot tell which; owner issued
  // a different ruling for each of these two, so each needs a piece of
  // evidence that can name it by itself.
  group('MAC-05 · 63/64 queue semantics (owner 2026-08-07 approved)', () {
    Future<OutboxDeliveryState> settledWith(String code) async {
      final _Host host = _Host();
      final OutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _box(host, store);
      await _enqueue(box);
      await box.drain();
      await box.settle(correlationId: 'r1', ok: false, code: code);
      final OutboxDeliveryState s = (await _read(store, 'r1'))!.state;
      box.dispose();
      return s;
    }

    test('🔴 63 INJECT_SECURE_INPUT_ACTIVE ⇒ queue converges (not forever「待投递」)', () async {
      expect(
        await settledWith('INJECT_SECURE_INPUT_ACTIVE'),
        OutboxDeliveryState.delivered,
        reason: 'secure input is an injection-leg verdict the PC made in its own process ⇒ the delivery leg is finished',
      );
    });

    test('🔴 64 INJECT_NO_ACCESSIBILITY ⇒ queue converges (not forever「待投递」)', () async {
      expect(
        await settledWith('INJECT_NO_ACCESSIBILITY'),
        OutboxDeliveryState.delivered,
        reason: 'missing accessibility permission is likewise a PC-spoken injection-leg verdict ⇒ the delivery leg is finished',
      );
    });

    test('🔴 neither may land as refused — refused means 「未投递」, which is false here', () async {
      // Positive control, pinning a bad fix that is easy to write: stuffing 64
      // into `isTerminalRefusalCode` would also stop the queue, at the cost of
      // the phone saying 「未投递」 about a message that is **already on the PC
      // timeline** (R11 + delivery≠injection, both broken at once).
      for (final String code in <String>[
        'INJECT_SECURE_INPUT_ACTIVE',
        'INJECT_NO_ACCESSIBILITY',
      ]) {
        expect(isTerminalRefusalCode(code), isFalse, reason: code);
        expect(await settledWith(code), isNot(OutboxDeliveryState.refused));
      }
    });

    test('🔴 reverse control: an implementation that does not know these two codes cannot stop the queue', () async {
      // This pins the 「closed set」 mechanism itself: a code that is
      // **structurally equivalent to a missed registration** (same ok:false,
      // same not-in-the-set) must return queued. It proves the green on the
      // two cases above is not bought by 「everything is delivered」 — strip
      // 63/64 out of the set and those two cases instantly become this one.
      expect(
        await settledWith('INJECT_SECURE_INPUT_NOT_REGISTERED'),
        OutboxDeliveryState.queued,
        reason: 'an unregistered code must stay owed — that is how 63/64 behaved before the fix',
      );
    });
  });

  group('F2 · positive control — nothing that is not a PC injection-leg verdict may be judged delivered', () {
    test('🔴 a retryable code the relay answered for still returns queued', () async {
      // Without this case, a bad implementation that judges everything
      // delivered would also be all-green in the group above.
      for (final String code in <String>[
        'INJECT_NOT_IN_ROOM',
        'INJECT_PC_OFFLINE',
        'INJECT_SERVER_BUSY',
        'INJECT_CLOUD_IMAGE_TOO_LARGE',
      ]) {
        final _Host host = _Host();
        final OutboxStore store = InMemoryOutboxStore();
        final DeliveryOutbox box = _box(host, store);
        await _enqueue(box);
        await box.drain();
        await box.settle(correlationId: 'r1', ok: false, code: code);
        expect(
          (await _read(store, 'r1'))!.state,
          OutboxDeliveryState.queued,
          reason: code,
        );
        box.dispose();
      }
    });

    test('🔴 INJECT_NOT_PRIMARY (an admission refusal the PC spoke) still returns queued', () async {
      // owner 2026-08-02:「被占用时……只能先记录等它退出」— the PC said it, but what it
      // said is the admission layer. Authorship is three values, not two;
      // this case is the entire reason.
      final _Host host = _Host();
      final OutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _box(host, store);
      await _enqueue(box);
      await box.drain();
      await box.settle(correlationId: 'r1', ok: false, code: 'INJECT_NOT_PRIMARY');
      expect((await _read(store, 'r1'))!.state, OutboxDeliveryState.queued);
      box.dispose();
    });

    test('a terminal refusal code is still refused (a red-line code must not be read as delivered)', () async {
      final _Host host = _Host();
      final OutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _box(host, store);
      await _enqueue(box);
      await box.drain();
      await box.settle(correlationId: 'r1', ok: false, code: 'INJECT_PC_MISMATCH');
      final OutboxItem after = (await _read(store, 'r1'))!;
      expect(after.state, OutboxDeliveryState.refused);
      expect(after.refusedCode, 'INJECT_PC_MISMATCH');
      box.dispose();
    });
  });

  group('F2 · the word on the row — badge and queue must say the same thing', () {
    TimelineEntry entry({
      required EntryStatus status,
      bool cachedByVerdict = false,
      String? failureReason,
    }) {
      final DateTime t = DateTime.utc(2026, 8, 2, 10, 0);
      return TimelineEntry(
        id: 'loc_r1',
        clientId: 'r1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        sourceText: '你好电脑',
        outputText: '你好电脑',
        status: status,
        origin: 'paired',
        entryType: TimelineEntry.kTranscript,
        failureReason: failureReason,
        cachedByVerdict: cachedByVerdict,
        createdAt: t,
        updatedAt: t,
      );
    }

    test('🔴 an INJECT_FOCUS_LOST row says 「已投递」, never again 「待投递」', () {
      final DeliveryFace face = deliveryFaceOf(
        entry(
          status: EntryStatus.cached,
          cachedByVerdict: true,
          failureReason: 'INJECT_FOCUS_LOST',
        ),
        queued: false,
      );
      expect(face, DeliveryFace.deliveredNotInjected);
      expect(face, isNot(DeliveryFace.undelivered));
      for (final AppLocale loc in AppLocale.values) {
        final String word =
            deliveryFaceMeta(face, AppStrings(loc)).label;
        expect(word.isNotEmpty, isTrue, reason: '$loc');
      }
      // 🔴 the queue item is already terminal ⇒ this row must never show the
      // word 「待投递」 (red line: do not promise a wait no mechanism honours).
      expect(deliveryFaceMeta(face, AppStrings(AppLocale.zh)).label,
          isNot(contains('待投递')));
      expect(deliveryFaceMeta(face, AppStrings(AppLocale.zh)).label,
          startsWith('已投递'));
    });

    test('🔴 the two named faces we already paid tuition for were not swallowed by this new rule (order is the contract)', () {
      // Their codes also belong to the pc-injection family, so the criterion
      // order inside deliveryFaceOf is the contract.
      expect(
        deliveryFaceOf(
          entry(
            status: EntryStatus.cached,
            cachedByVerdict: true,
            failureReason: 'INJECT_DEFERRED_NOT_AUTOINJECTED',
          ),
          queued: false,
        ),
        DeliveryFace.deferredNotInjected,
      );
      expect(
        deliveryFaceOf(
          entry(status: EntryStatus.failed, failureReason: 'INJECT_NO_TEXT_TARGET'),
          queued: false,
        ),
        DeliveryFace.noFocus,
      );
    });

    test('a PC injection-leg verdict on the failed side also says 「已投递」', () {
      expect(
        deliveryFaceOf(
          entry(status: EntryStatus.failed, failureReason: 'INJECT_CLIPBOARD_FAIL'),
          queued: false,
        ),
        DeliveryFace.deliveredNotInjected,
      );
    });

    test('🔴 positive control: if it is not a PC injection-leg verdict, the word did not change by a single character', () {
      // The two codes the relay answered for still land on their original faces.
      // ⚠️ `INJECT_NOT_PRIMARY` is not here — this round it moved from `failed`
      // to 「待投递」, see the group below (owner 2026-08-02 ruling, walked through
      // the real applyInjectResult path).
      expect(
        deliveryFaceOf(
          entry(
            status: EntryStatus.cached,
            cachedByVerdict: true,
            failureReason: 'INJECT_NOT_IN_ROOM',
          ),
          queued: false,
        ),
        DeliveryFace.undelivered,
      );
      expect(
        deliveryFaceOf(
          entry(
            status: EntryStatus.cached,
            cachedByVerdict: true,
            failureReason: 'INJECT_PC_MISMATCH',
          ),
          queued: false,
        ),
        DeliveryFace.refused,
      );
      expect(
        deliveryFaceOf(entry(status: EntryStatus.cached), queued: true),
        DeliveryFace.queued,
      );
    });
  });

  // ── Card F2 addendum: occupied by another phone ⇒ 「待投递」, never 「未投递」 ──
  //
  // owner 2026-08-02 ruling (15 册 §3.2 「PC 忙」 row). This group walks the
  // **real applyInjectResult path** rather than hand-building a TimelineEntry
  // — because the defect lives in that function's criterion: the
  // `mode:'sendinput'` the desktop stamps on `INJECT_NOT_PRIMARY` is
  // **fabricated**, and that value used to decide 「未投递 vs 待投递」. A
  // hand-built entry would walk around the defect and measure nothing.
  group('F2 · an occupied row says 「待投递」 (the criterion is no longer the fabricated mode)', () {
    TimelineEntry settleWith(String code, String wireMode) {
      final TimelineStore s = newTestStore();
      final TimelineEntry born = s.buildFromUtterance(
        clientId: 'c1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: '你好电脑',
      );
      s.applyInjectResult(
        correlationId: born.id,
        ok: false,
        failureReason: code,
        wireMode: wireMode,
      );
      return s.findById(born.id)!;
    }

    test('🔴 INJECT_NOT_PRIMARY on the real path ⇒ row = 「待投递」, none of the four languages contain 「未投递」', () {
      // The desktop stamps exactly 'sendinput' (`client.rs`
      // `build_inject_result(false, "sendinput", Some(error_codes::INJECT_NOT_PRIMARY), …)`);
      // feed that in as-is.
      final TimelineEntry row = settleWith('INJECT_NOT_PRIMARY', 'sendinput');
      expect(row.status, EntryStatus.cached, reason: 'not failed — the queue still owes it');
      expect(row.cachedByVerdict, isTrue);
      final DeliveryFace face = deliveryFaceOf(row, queued: false);
      expect(face, DeliveryFace.undelivered);

      // Nine-locale expansion (2026-08-14): four Maps + `[loc]!` ⇒ exhaustive
      // switch (the five new locales used to crash on a null assertion). Each
      // locale's banned word is that locale's wording for the 「未投递」 state,
      // the same set as `_triad.notDelivered` in `delivery_terminology_test.dart`.
      String banned(AppLocale loc) => switch (loc) {
        AppLocale.zh => '未投递',
        AppLocale.zhTw => '未投遞',
        AppLocale.en => 'Not delivered',
        AppLocale.fr => 'Non livré',
        AppLocale.es => 'No entregado',
        AppLocale.de => 'Nicht zugestellt',
        AppLocale.ja => '未送信',
        AppLocale.ko => '미전송',
        AppLocale.ru => 'Не доставлено',
      };
      for (final AppLocale loc in AppLocale.values) {
        final String word = deliveryFaceMeta(face, AppStrings(loc)).label;
        expect(word.isNotEmpty, isTrue, reason: '$loc');
        expect(
          word.contains(banned(loc)),
          isFalse,
          reason: '$loc said 「${banned(loc)}」: $word — owner forbade this explicitly',
        );
        expect(word, AppStrings(loc).statusUndelivered, reason: '$loc');
      }
    });

    test('🔴 positive control: a real failure is still failed (the criterion was not loosened wholesale)', () {
      // Without this case, a bad implementation that treats every ok:false as
      // 「待投递」 would also be green.
      final TimelineEntry row = settleWith('LINK_DOWN', 'sendinput');
      expect(row.status, EntryStatus.failed);
      expect(deliveryFaceOf(row, queued: false), DeliveryFace.failed);
    });

    test('the old mode:cached path did not change by a single character', () {
      final TimelineEntry row = settleWith('INJECT_NOT_IN_ROOM', 'cached');
      expect(row.status, EntryStatus.cached);
      expect(deliveryFaceOf(row, queued: false), DeliveryFace.undelivered);
    });
  });
}
