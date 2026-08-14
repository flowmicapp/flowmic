// card F11 ② / ③ — two fabrications the write-back layer used to commit, both of
// them "on what grounds do you say that" with no answer.
//
// ② THE CORRELATION FALLBACK ANSWERED TWO QUESTIONS. `applyInjectResult` fell
//   back to [TimelineStore.lastAwaitingInject] whenever `findById ??
//   findByClientId` came up empty — including when the frame NAMED a row. Those
//   are different facts: "the other side did not name a row" (the live STT path echoes no id, the
//   documented and legitimate case) versus "the other side named one, and this phone does not have that row". The
//   second one is a verdict this layer cannot place, and guessing writes one
//   message's delivery truth onto another message's row.
//
//   THE PRODUCER IS ORDINARY: deleting a row does NOT cancel its queue item
//   (`TimelineStore.delete` reaps the row; nothing tells the outbox), so a drain
//   later delivers it and the PC answers under an id that resolves to nothing.
//
//   📌 The re-inject path already refuses to emit for a row deleted underfoot
//   and names THIS fallback as the reason (manual_delivery_reinject.dart). The
//   queue's own resolution has never had a fallback either (`_find` in
//   delivery_outbox_settle.dart returns null and the settle does nothing). This
//   makes the row layer the third one to agree.
//
// ③ A MISSING `mode` WAS FABRICATED AS `'sendinput'`. `InjectResult.tryFromJson`
//   substituted a real enum value for an absent field, and the one consumer asks
//   `wireMode == 'cached'` — so absence was silently answered as "the peer said,
//   and what it said was not cached". The desktop documents the same sin from the other side and
//   refuses to commit it (`socket/client.rs`, the `build_inject_result(false,
//   "sendinput", Some(error_codes::INJECT_NOT_PRIMARY), …)` admission refusal:
//   its placeholder mode 「must not be used as a judgement basis」), which is why
//   authorship is decided by the error CODE.
//
// ⚠️ REVERSE CONTROL — both groups were run RED against the pre-card code
// (restoring `entry ??= lastAwaitingInject` unconditionally, and restoring the
// `: 'sendinput'` default); output pasted in the worker's report.

import 'package:flowmic/src/signaling/inbound_payloads.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/di.dart';

void main() {
  group('card F11 ② — a verdict for a row we do not have settles NOTHING', () {
    test('a named correlation that resolves nothing never lands on another row',
        () {
      final TimelineStore store = newTestStore();
      // The row this verdict is really about: built, delivered, then deleted by
      // the user while its queue item was still owed.
      final TimelineEntry deleted = store.buildFromUtterance(
        clientId: 'u-deleted',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'the sentence the user deleted',
      );
      // An unrelated row, spoken after it, still waiting for its own verdict —
      // i.e. exactly what `lastAwaitingInject` would hand back.
      final TimelineEntry bystander = store.buildFromUtterance(
        clientId: 'u-bystander',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'somebody else',
      );
      expect(bystander.status, EntryStatus.cached);
      store.delete(deleted.id);
      expect(store.findById(deleted.id), isNull);

      final bool applied = store.applyInjectResult(
        correlationId: 'u-deleted',
        ok: true,
        pcName: 'dev-pc-a',
      );

      expect(
        applied,
        isFalse,
        reason: 'nothing was settled — the row this verdict names is gone',
      );
      final TimelineEntry after = store.findById(bystander.id)!;
      expect(
        after.status,
        EntryStatus.cached,
        reason: "another delivery's verdict must not settle this row",
      );
      expect(after.pcName, isNull);
    });

    test('a failure verdict for a vanished row does not fail somebody else', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry gone = store.buildFromUtterance(
        clientId: 'u-gone',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'deleted while queued',
      );
      final TimelineEntry bystander = store.buildFromUtterance(
        clientId: 'u-live',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'still waiting',
      );
      store.delete(gone.id);

      store.applyInjectResult(
        correlationId: 'u-gone',
        ok: false,
        failureReason: 'INJECT_SENDINPUT_FAIL',
      );

      final TimelineEntry after = store.findById(bystander.id)!;
      expect(after.status, EntryStatus.cached);
      expect(
        after.failureReason,
        isNull,
        reason: "a code earned by another delivery must not be shown here",
      );
    });

    test(
        'the DOCUMENTED fallback is untouched: no correlation id at all still '
        'settles the one utterance in flight', () {
      // The live STT path echoes no id, and the FSM allows one utterance in
      // flight — this is the case the fallback exists for, and card F11 ② must not
      // have narrowed it. A negative control for the two tests above: without
      // this, 「we fixed it by deleting the feature」 would look identical.
      final TimelineStore store = newTestStore();
      final TimelineEntry waiting = store.buildFromUtterance(
        clientId: 'u-live-stt',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'spoken now',
      );

      final bool applied = store.applyInjectResult(ok: true, pcName: 'PC-1');

      expect(applied, isTrue);
      expect(store.findById(waiting.id)!.status, EntryStatus.injected);
    });
  });

  group('card F11 ③ — an absent `mode` stays absent', () {
    test('tryFromJson does not invent a mode for a frame that omitted it', () {
      final InjectResult? r = InjectResult.tryFromJson(<String, Object?>{
        'ok': false,
        'error': 'INJECT_PC_OFFLINE',
        'request_id': 'm0-1',
      });
      expect(r, isNotNull);
      expect(
        r!.mode,
        isNull,
        reason: '"did not say" must not be reported as "said sendinput"',
      );
    });

    test('a mode that IS on the frame is carried verbatim', () {
      // Positive control: the fix must not have turned the field off.
      final InjectResult? r = InjectResult.tryFromJson(<String, Object?>{
        'ok': false,
        'mode': 'cached',
        'error': 'INJECT_FOCUS_LOST',
      });
      expect(r!.mode, 'cached');
    });

    test('a non-string mode is absence, not a substitute value', () {
      final InjectResult? r = InjectResult.tryFromJson(<String, Object?>{
        'ok': true,
        'mode': 7,
      });
      expect(r!.mode, isNull);
    });
  });
}
