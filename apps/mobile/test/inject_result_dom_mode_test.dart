// Card S2-03 (FLOWMIC-WEB stage two, 2026-09-07) — `inject:result.mode: 'dom'`
// on the PHONE side.
//
// SPEC-REF:
//   packages/protocol/src/protocol-schemas-inject.ts (InjectResultSchema.mode —
//     the fourth value, and why none of the other three could be borrowed)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0 (delivery and
//     injection are two segments; `dom` is an INJECTION-segment word)
//   docs/strategy/2026-09-05-web-client-subproject-design.md §5 item 3
//   owner's 2026-09-06 ruling 2 (the enum and this mirror land together)
//
// ── What a `dom` receipt is ───────────────────────────────────────────────────
//
// A web target — a page acting as a "virtual computer" — wrote the words into
// the input element it is bound to. `ok:true, mode:'dom'` is 「已注入」, both
// segments done. There is no new copy for it and there must not be: the row
// lands on the SAME `EntryStatus.injected` / `DeliveryFace.injected` face as a
// PC that typed the words with SendInput.
//
// ── 🔴 The planning document's premise for this card was FALSE, and that is the
//    most useful thing in this file ─────────────────────────────────────────────
//
// `docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md` §1.4 says
// the phone 「只认三个字面量，未知读成 null『没说』」 ("only recognises the three
// literals; an unknown one reads as null, 'not said'") and that the relay
// 「透传不校验」 ("forwards transparently, without validating"). Both were
// measured while writing this file, and BOTH ARE BACKWARDS:
//
//   · the phone's reader is OPEN — `InjectResult.tryFromJson` is
//     `j['mode'] is String ? … : null`, so `'dom'` crossed this door before the
//     enum existed (group ① below pins that it still does);
//   · the RELAY is the closed one — `relay.handler.ts` runs every
//     `inject:result` through `safeParseEvent` and `logDrop`s a frame whose
//     `mode` is outside the enum, forwarding `parsed.data` only.
//
// ⇒ the compatibility hazard is NOT an old phone, it is an OLD RELAY: it drops
// the whole receipt, the phone hears nothing, and the row sits at 「待投递」 for
// an utterance the page already typed. That half is a wire fact and is pinned
// where wire facts can be measured — `verify/golden/g23-dom-inject-mode.mjs`,
// against a real relay. It is NOT re-enacted here (a Dart harness that "proves"
// what a Node relay does would be proving its own fixture).
//
// ── REVERSE CONTROLS (each run RED before being restored; verbatim output in
//    the card report) ───────────────────────────────────────────────────────────
//
//   (a) close `InjectResult.tryFromJson`'s `mode` parse to a three-literal
//       whitelist — i.e. build the phone the addendum described. Group ① goes
//       red on the parse itself. This is what would have to be TRUE for the
//       "old phone" story to be the risk; it is not.
//   (b) add `'dom'` to the row's undelivered criterion (`wireMode ==
//       kWireModeCached || wireMode == 'dom'` in
//       timeline_store_inject_writeback.dart) — i.e. treat a page's successful
//       DOM write as 「没投递，可补投」. Group ② goes red: the row is repainted
//       `DeliveryFace.undelivered` 「待投递」 for a message that landed.
//
// ⚠️ Group ② is a ROW-face assertion, and the reason is measured, not stylistic:
// the QUEUE cannot be broken this way at all. `outboxSettle` deliberately does
// not take `mode` (see its doc: mode cannot name an author in either direction),
// so the only surface on which a `dom` receipt could be turned back into
// 「pending delivery」 is the timeline row.

import 'package:flowmic/src/signaling/inbound_payloads.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/di.dart';

/// One utterance already sent and waiting for its verdict — the state every
/// receipt below arrives into.
TimelineEntry _awaiting(TimelineStore store, String clientId) {
  final TimelineEntry e = store.buildFromUtterance(
    clientId: clientId,
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    text: 'the sentence the page is about to type',
  );
  expect(e.status, EntryStatus.cached, reason: 'precondition: still awaiting');
  return e;
}

void main() {
  group('S2-03 (1) — a `dom` receipt reaches this phone and reads as INJECTED', () {
    test('the wire word survives the reader verbatim (it is not read as 没说)', () {
      // The exact frame FLOWMIC-WEB's target end will send (design §5 item 3):
      // ok + the new mode + the read-back it may substantiate it with.
      final InjectResult? r = InjectResult.tryFromJson(<String, Object?>{
        'ok': true,
        'mode': 'dom',
        'request_id': 'req-dom-1',
        'focus_evidence': 'editable',
      });
      expect(r, isNotNull);
      expect(
        r!.mode,
        'dom',
        reason: 'null here would be 「没说」 for a frame that did say — card F11 (3)',
      );
      expect(r.ok, isTrue);
      expect(r.correlationId, 'req-dom-1');
    });

    test('the row lands on the EXISTING injected face — no new wording', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry row = _awaiting(store, 'u-dom-ok');
      final InjectResult r = InjectResult.tryFromJson(<String, Object?>{
        'ok': true,
        'mode': 'dom',
        'request_id': 'u-dom-ok',
      })!;

      final bool applied = store.applyInjectResult(
        correlationId: r.correlationId,
        ok: r.ok,
        wireMode: r.mode,
        pcName: 'Chrome — flowmic web target',
        failureReason: r.error,
      );

      expect(applied, isTrue);
      final TimelineEntry after = store.findById(row.id)!;
      expect(after.status, EntryStatus.injected);
      expect(
        deliveryFaceOf(after, queued: false),
        DeliveryFace.injected,
        reason: 'a page writing into its own input box IS an injection (15 §2.0)',
      );
      expect(
        after.cachedByVerdict,
        isFalse,
        reason: 'nothing about this verdict says 「没投递，可补投」',
      );
      expect(after.pcName, 'Chrome — flowmic web target');
    });
  });

  group('S2-03 (2) — `dom` is NOT the backfill word', () {
    // The criterion `kWireModeCached` answers 「did this attempt not get through,
    // and does the queue still owe it」. `dom` answers the opposite question, and
    // reverse control (b) is the edit that conflates the two.
    test('a dom receipt is never repainted 「待投递」, ok or not', () {
      final TimelineStore store = newTestStore();

      // (1) the success case, stated as a FACE rather than a status so the edit
      //     under test cannot hide behind an equal-looking bucket.
      final TimelineEntry ok = _awaiting(store, 'u-dom-face-ok');
      store.applyInjectResult(
        correlationId: 'u-dom-face-ok',
        ok: true,
        wireMode: 'dom',
      );
      expect(
        deliveryFaceOf(store.findById(ok.id)!, queued: false),
        isNot(DeliveryFace.undelivered),
      );

      // (2) a page that received the frame and then could not type it (its bound
      //     element went away). The CODE is what says the target authored this —
      //     `mode` never does (inject-verdict-authorship.ts) — so this row is
      //     「已投递 · 未注入」, and it must not fall back to 「待投递」 either.
      final TimelineEntry bad = _awaiting(store, 'u-dom-face-fail');
      store.applyInjectResult(
        correlationId: 'u-dom-face-fail',
        ok: false,
        wireMode: 'dom',
        failureReason: 'INJECT_TARGET_INVALID',
      );
      final TimelineEntry afterBad = store.findById(bad.id)!;
      expect(
        afterBad.cachedByVerdict,
        isFalse,
        reason: '`dom` must not be read as 「没投递，可补投」',
      );
      expect(
        deliveryFaceOf(afterBad, queued: false),
        isNot(DeliveryFace.undelivered),
      );
    });

    test('the criterion still recognises the one word that IS the backfill word',
        () {
      // A positive control for the assertions above: if `kWireModeCached` were
      // broken outright, every `isNot(undelivered)` here would pass for the
      // wrong reason.
      final TimelineStore store = newTestStore();
      final TimelineEntry row = _awaiting(store, 'u-cached-control');
      store.applyInjectResult(
        correlationId: 'u-cached-control',
        ok: false,
        wireMode: TimelineStore.kWireModeCached,
        failureReason: 'INJECT_NOT_IN_ROOM',
      );
      final TimelineEntry after = store.findById(row.id)!;
      expect(after.status, EntryStatus.cached);
      expect(after.cachedByVerdict, isTrue);
    });
  });
}
