// N2 (RV-42 phone half) — 「ok:false」 is not one fact.
//
// The defect, verbatim from timeline_store.dart before this card:
//
//     status: ok ? EntryStatus.injected : EntryStatus.failed,
//
// unconditional — so EVERY unsuccessful verdict became 「✗ 注入失败」, including the
// ones whose own wire field said `mode:'cached'` = 「not delivered, kept so it can be catch-up-delivered (补投)」
// (INJECT_FOCUS_LOST, no PC in the room, held out). One injection event, three
// interfaces, three different answers: the phone said failed, the PC capsule said
// something else. The distinction was on the wire the whole time — the phone's
// haptics observer even read it (chat_flow_page._onInjectReceipt) — and the row
// write-back threw it away.
//
// SPEC-REF:
//   docs/strategy/2026-07-30-inject-state-narrowing-design.md §1 (what each word
//     now means) + §4 (the three-end display table, and the ⚠ about not creating
//     a NEW one-value-two-questions while splitting this one)
//   docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md
//
// The trap this file exists to guard: the phone ALREADY used EntryStatus.cached
// for 「row built, waiting for inject:result」 (投递中). Mapping the wire's cached
// onto it without more would make 「still in flight」 and 「did not happen」 render
// identically — trading one one-value-two-questions for another. Hence [TimelineEntry
// .cachedByVerdict] (device-local, never on the wire) and the display assertions
// below.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/di.dart';

/// One PC-bound row, born ⏳ 投递中 (awaiting a verdict).
TimelineEntry _row(TimelineStore store, {String clientId = 'u1'}) =>
    store.buildFromUtterance(
      clientId: clientId,
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: '一句话',
    );

void main() {
  group('① the verdict\'s own `mode` decides the state', () {
    test('ok:false + mode:cached → 📥 cached/未投递, NOT ✗ failed', () {
      // THE CORE ASSERTION OF THIS CARD.
      final TimelineStore store = newTestStore();
      final TimelineEntry born = _row(store);
      final bool applied = store.applyInjectResult(
        correlationId: born.id,
        ok: false,
        wireMode: 'cached',
        failureReason: 'INJECT_FOCUS_LOST',
      );
      expect(applied, isTrue);
      final TimelineEntry e = store.findById(born.id)!;
      expect(e.status, isNot(EntryStatus.failed), reason: 'RV-42 #1 mismatch');
      expect(e.status, EntryStatus.cached);
      expect(e.cachedByVerdict, isTrue);
      expect(e.undelivered, isTrue);
      expect(e.awaitingDelivery, isFalse, reason: 'a verdict already spoke');
    });

    test('ok:false + mode:sendinput → ✗ failed, with its named reason', () {
      // The reverse assertion. Without it the split could drift into 「every
      // ok:false is cached」, which would be the same bug pointing the other way
      // — and that one lies in the direction of claiming recoverability.
      final TimelineStore store = newTestStore();
      final TimelineEntry born = _row(store);
      store.applyInjectResult(
        correlationId: born.id,
        ok: false,
        wireMode: 'sendinput',
        failureReason: 'INJECT_SENDINPUT_FAIL',
      );
      final TimelineEntry e = store.findById(born.id)!;
      expect(e.status, EntryStatus.failed);
      expect(e.failureReason, 'INJECT_SENDINPUT_FAIL');
      expect(e.cachedByVerdict, isFalse);
      expect(e.undelivered, isFalse);
    });

    test('ok:false with NO wireMode → ✗ failed (the local settle paths)', () {
      // ManualDelivery.failSettled / the 20 s watchdog / the image controller's
      // LINK_DOWN all settle rows WITHOUT any PC having answered. Null must stay
      // a failure: those rows have no verdict to be generous about.
      final TimelineStore store = newTestStore();
      final TimelineEntry born = _row(store);
      store.applyInjectResult(
        correlationId: born.id,
        ok: false,
        failureReason: 'INJECT_NO_RESULT',
      );
      expect(store.findById(born.id)!.status, EntryStatus.failed);
    });

    test('ok:true → ✓ injected (regression guard)', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry born = _row(store);
      store.applyInjectResult(
        correlationId: born.id,
        ok: true,
        wireMode: 'clipboard',
        pcName: '书房台式机',
      );
      final TimelineEntry e = store.findById(born.id)!;
      expect(e.status, EntryStatus.injected);
      expect(e.cachedByVerdict, isFalse);
      expect(e.pcName, '书房台式机');
    });

    test('the bit is CLEARED, not merely set — a catch-up delivery (补投) goes back to 投递中', () {
      // copyWith lets `false` through on purpose (only null means 「unchanged」). If it
      // did not, a re-injected row would keep claiming a verdict it no longer
      // has and show 未投递 + 重发 while its delivery was in flight.
      final TimelineStore store = newTestStore();
      final TimelineEntry born = _row(store);
      store.applyInjectResult(
        correlationId: born.id,
        ok: false,
        wireMode: 'cached',
      );
      expect(store.findById(born.id)!.undelivered, isTrue);

      store.markReinjecting(born.id);
      final TimelineEntry again = store.findById(born.id)!;
      expect(again.status, EntryStatus.cached);
      expect(again.cachedByVerdict, isFalse);
      expect(again.awaitingDelivery, isTrue);
      expect(again.undelivered, isFalse);
    });

    test('a settled 未投递 row is no longer 「awaiting」 anything', () {
      // lastAwaitingInject is where an uncorrelated verdict lands (the live STT
      // path echoes no id). A row a verdict already settled must drop out of it,
      // or the NEXT delivery's truth would be written onto it.
      final TimelineStore store = newTestStore();
      final TimelineEntry born = _row(store);
      store.applyInjectResult(
        correlationId: born.id,
        ok: false,
        wireMode: 'cached',
      );
      expect(store.lastAwaitingInject, isNull);

      // …and it is not rewritten by ✕清空缓冲 either: 未投递 is a settled truth,
      // and turning it into noted would erase the verdict AND take away the one
      // affordance (重发) the state exists to offer.
      expect(store.markNoted(born.id), isNull);
      expect(store.findById(born.id)!.undelivered, isTrue);
    });
  });

  group('② cachedByVerdict is DEVICE-LOCAL', () {
    test('round-trips through toJson/fromJson; legacy JSON reads false', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry born = _row(store);
      store.applyInjectResult(
        correlationId: born.id,
        ok: false,
        wireMode: 'cached',
      );
      final Map<String, Object?> json = store.findById(born.id)!.toJson();
      expect(json['cached_by_verdict'], isTrue);
      final TimelineEntry back = TimelineEntry.fromJson(json)!;
      expect(back.cachedByVerdict, isTrue);
      expect(back.undelivered, isTrue, reason: 'the face survives a reload');

      // A row written before N2 has no such key, and false is the honest read:
      // that build's only meaning for cached was 投递中.
      final Map<String, Object?> legacy = Map<String, Object?>.from(json)
        ..remove('cached_by_verdict');
      final TimelineEntry old = TimelineEntry.fromJson(legacy)!;
      expect(old.cachedByVerdict, isFalse);
      expect(old.awaitingDelivery, isTrue);
    });

    test('it never rides the history wire (this card is zero protocol change)', () {
      // Same assertion shape as pcName's in row_provenance_test.dart. RV-43 §4.2
      // rules out a protocol field for this card, and emitting a key the wire zod
      // would strip is worse than not having it: it looks synced and is not.
      final TimelineStore store = newTestStore();
      final TimelineEntry born = _row(store);
      store.applyInjectResult(
        correlationId: born.id,
        ok: false,
        wireMode: 'cached',
        failureReason: 'INJECT_FOCUS_LOST',
      );
      final Map<String, Object?> wire = store
          .findById(born.id)!
          .toHistoryItem(pcDeviceId: 'pc1', userId: 'u1');
      expect(wire.containsKey('cached_by_verdict'), isFalse);
      expect(wire.containsKey('failure_reason'), isFalse);
      // What DOES cross is the status word the protocol already had.
      expect(wire['status'], 'cached');
    });
  });

  group('③ 投递中 and 未投递 are not the same thing on screen', () {
    test('the two cached rows resolve to DIFFERENT faces', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry waiting = _row(store, clientId: 'w');
      final TimelineEntry settled = _row(store, clientId: 's');
      store.applyInjectResult(
        correlationId: settled.id,
        ok: false,
        wireMode: 'cached',
      );

      expect(deliveryFaceOf(store.findById(waiting.id)!, queued: false), DeliveryFace.delivering);
      expect(
        deliveryFaceOf(store.findById(settled.id)!, queued: false),
        DeliveryFace.undelivered,
      );
    });

    test('…and to different glyphs AND different words, in all four locales', () {
      // Two channels, both of which the user actually reads. Colour is
      // deliberately NOT the distinguishing channel (both are amber, matching the
      // PC), so if the words ever coincided the states would be indistinguishable.
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings(locale);
        final StatusMeta delivering = deliveryFaceMeta(
          DeliveryFace.delivering,
          s,
        );
        final StatusMeta undelivered = deliveryFaceMeta(
          DeliveryFace.undelivered,
          s,
        );
        expect(delivering.glyph, isNot(undelivered.glyph), reason: '$locale');
        expect(delivering.label, isNot(undelivered.label), reason: '$locale');
        expect(delivering.label, isNotEmpty, reason: '$locale');
        expect(undelivered.label, isNotEmpty, reason: '$locale');
      }
    });

    test('all five faces have copy in all four locales', () {
      // The catalogue's `_t` makes a MISSING language a compile error; this
      // catches the other half — a face wired to an empty or duplicated word.
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings(locale);
        final Set<String> labels = <String>{
          for (final DeliveryFace f in DeliveryFace.values)
            deliveryFaceMeta(f, s).label,
        };
        expect(
          labels,
          hasLength(DeliveryFace.values.length),
          reason: '$locale: two faces say the same word',
        );
      }
    });

    test('noted is untouched — 「留在手机」 still reads exactly as before', () {
      // Red line: the user said keep it on the phone, so neither the word nor the
      // behaviour moves. Pinned here because N2 rewrote its neighbours.
      final StatusMeta noted = deliveryFaceMeta(
        DeliveryFace.noted,
        AppStrings(AppLocale.zh),
      );
      expect(noted.label, '仅记录');
      expect(noted.glyph, isEmpty);

      final TimelineStore store = newTestStore();
      final TimelineEntry n = store.buildFromUtterance(
        clientId: 'n1',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        text: '留在手机',
      );
      expect(n.status, EntryStatus.noted);
      expect(deliveryFaceOf(n, queued: false), DeliveryFace.noted);
      // A stray verdict — of EITHER kind — never touches it.
      store.applyInjectResult(ok: false, wireMode: 'cached');
      expect(store.findById(n.id)!.status, EntryStatus.noted);
    });
  });
}
