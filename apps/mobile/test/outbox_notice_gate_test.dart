// Card UX2-2 — 「还有 N 条待投递」 IS NOT SAID AFTER EVERY HEALTHY PRESS.
//
// THE OBSERVED DEFECT (owner, 0.3.75, tablet on the cloud relay): every
// ordinary press raised 「还有 1 条待投递，连接恢复后会自动投递」 and dropped it
// again when the delivery landed. Two claims, both false at that moment: the
// item was not waiting for anything, and the link it was said to be waiting for
// was up.
//
// WHAT IS MEASURED HERE, IN THREE LAYERS:
//   ① the rule itself (`outbox_notice_gate.dart`) as a pure function;
//   ② the rule fed by the REAL queue — the facts come out of `DeliveryOutbox`
//     after real enqueues and a real drain, not out of a literal, because the
//     whole defect was that production's first attempt looked exactly like a
//     backlog from where the banner stood;
//   ③ the sentence that reaches the screen (`buildChatBanners`), including
//     WHICH of the two sentences it is.
//
// REVERSE CONTROL, REALLY RUN 2026-09-07: with the gate removed from
// `banner_queue.dart` (restoring the pre-card condition `outboxPending.count >
// 0`), the first case in ③ fails — Expected: <false> Actual: <true> — while
// every case in ① stays green. That asymmetry is why all three layers are
// here: the rule can be right while nothing on screen obeys it.

import 'dart:async';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_notice_gate.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';

const AppStrings _zh = AppStringsZh();
const String kInstance = 'saas|instance:inst-A-cloud';

final DateTime _t0 = DateTime.utc(2026, 9, 7, 10, 0, 0);

/// A host whose send outcome the case chooses — the difference between 「the
/// frame went out and we are waiting for an answer」 and 「it never left, back to
/// the queue」 is exactly the difference the banner now turns on.
class _Host implements OutboxDrainHost {
  _Host({this.sendOk = true});

  bool sendOk;
  int sends = 0;

  @override
  LiveConnection get liveConnection => const LiveConnection(
        machineUid: 'machine-uid-AAAA',
        pairingIdentity: kInstance,
        pcId: 'pc-A',
        channel: ServerChannel.lan,
      );

  @override
  Future<bool> ensureLink() async => true;

  @override
  Future<void> reseedDestination() async {}

  @override
  Future<bool> send(
    OutboxItem i,
    String p, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  }) async {
    sends++;
    return sendOk;
  }

  @override
  void onOutboxChanged() {}
}

DeliveryOutbox _box(_Host host) => DeliveryOutbox(
      store: newTestOutboxStore(),
      blobs: newTestOutboxBlobs(),
      host: host,
    );

Future<OutboxItem?> _enqueue(DeliveryOutbox box, String id) => box.enqueueText(
      requestId: id,
      entryId: id,
      wireEntryId: id,
      source: 'ptt',
      text: 'hello',
      mode: 'realtime',
      createdAt: _t0,
    );

BannerQueue _banners({
  required OutboxPendingNotice notice,
  required ConnectionState connection,
  required DateTime now,
}) =>
    buildChatBanners(
      connection: connection,
      autoStopped: false,
      strings: _zh,
      outboxPending: notice,
      now: now,
    );

void main() {
  group('① the rule (outbox_notice_gate.dart)', () {
    test('🔴 one item, first attempt, young, link up ⇒ SILENT (the defect)', () {
      final OutboxPendingNotice n =
          OutboxPendingNotice(count: 1, oldestPendingAt: _t0);
      expect(
        n.visible(
            now: _t0.add(const Duration(milliseconds: 400)), linkDown: false),
        isFalse,
      );
      // Positive control on the SAME value: the gate is capable of saying yes,
      // so the `false` above is a verdict and not a function that always hides.
      expect(n.visible(now: _t0, linkDown: true), isTrue);
    });

    test('(a) something already spent an attempt ⇒ visible, however young', () {
      expect(
        OutboxPendingNotice(count: 1, anyRetried: true, oldestPendingAt: _t0)
            .visible(now: _t0, linkDown: false),
        isTrue,
      );
    });

    test('(b) more than one pending ⇒ visible', () {
      expect(
        OutboxPendingNotice(count: 2, oldestPendingAt: _t0)
            .visible(now: _t0, linkDown: false),
        isTrue,
      );
    });

    test('(c) past the grace ⇒ visible, and not one tick before', () {
      final OutboxPendingNotice n =
          OutboxPendingNotice(count: 1, oldestPendingAt: _t0);
      expect(
        n.visible(
          now: _t0.add(kOutboxNoticeGrace - const Duration(milliseconds: 1)),
          linkDown: false,
        ),
        isFalse,
      );
      expect(
          n.visible(now: _t0.add(kOutboxNoticeGrace), linkDown: false), isTrue);
      // The wake-up the grace needs, because nothing else repaints at that
      // instant (`armOutboxNoticeTimer`'s whole reason for existing).
      expect(n.dueAt(now: _t0, linkDown: false), _t0.add(kOutboxNoticeGrace));
      expect(n.dueAt(now: _t0, linkDown: true), isNull,
          reason: 'already visible ⇒ nothing to wait for');
    });

    test('nothing pending ⇒ never visible, whatever the link is doing', () {
      expect(
          OutboxPendingNotice.none.visible(now: _t0, linkDown: true), isFalse);
    });

    test('an unknown age reads as old enough (a count with no history)', () {
      expect(
        const OutboxPendingNotice.count(1).visible(now: _t0, linkDown: false),
        isTrue,
      );
    });
  });

  group('② the facts come off the real queue', () {
    test('🔴 one healthy first attempt ⇒ count 1, nothing retried ⇒ silent',
        () async {
      final _Host host = _Host();
      final DeliveryOutbox box = _box(host);
      await box.load();
      await _enqueue(box, 'r-1');
      await box.drain();

      expect(host.sends, 1, reason: 'positive control: a frame really went out');
      final OutboxPendingNotice n = box.noticeFor(kInstance);
      expect(n.count, 1);
      expect(n.anyRetried, isFalse);
      expect(n.oldestPendingAt, isNotNull);
      expect(n.visible(now: n.oldestPendingAt!, linkDown: false), isFalse);
      box.dispose();
    });

    test('a send that did not leave ⇒ requeued ⇒ the same item now speaks up',
        () async {
      final _Host host = _Host(sendOk: false);
      final DeliveryOutbox box = _box(host);
      await box.load();
      await _enqueue(box, 'r-1');
      await box.drain();

      final OutboxPendingNotice n = box.noticeFor(kInstance);
      expect(n.count, 1);
      expect(n.anyRetried, isTrue,
          reason: 'attempts >= 1 and back in `queued` is the requeue shape');
      expect(n.visible(now: n.oldestPendingAt!, linkDown: false), isTrue);
      box.dispose();
    });

    test('two utterances waiting ⇒ visible immediately', () async {
      final _Host host = _Host();
      final DeliveryOutbox box = _box(host);
      await box.load();
      await _enqueue(box, 'r-1');
      await _enqueue(box, 'r-2');

      final OutboxPendingNotice n = box.noticeFor(kInstance);
      expect(n.count, 2);
      expect(n.visible(now: n.oldestPendingAt!, linkDown: false), isTrue);
      box.dispose();
    });

    test('another screen is unaffected (RV-91 is not weakened)', () async {
      final _Host host = _Host(sendOk: false);
      final DeliveryOutbox box = _box(host);
      await box.load();
      await _enqueue(box, 'r-1');
      await box.drain();

      final OutboxPendingNotice other =
          box.noticeFor('saas|instance:someone-else');
      expect(other.count, 0);
      expect(other.anyRetried, isFalse);
      expect(other.visible(now: _t0, linkDown: true), isFalse);
      box.dispose();
    });
  });

  group('③ what reaches the screen', () {
    test('🔴 healthy first attempt ⇒ no banner at all', () {
      final BannerQueue q = _banners(
        notice: OutboxPendingNotice(count: 1, oldestPendingAt: _t0),
        connection: ConnectionState.connected,
        now: _t0.add(const Duration(milliseconds: 400)),
      );
      expect(q.contains(BannerIds.outboxPending), isFalse);
    });

    test('link down ⇒ the banner names the network, and only then', () {
      final BannerItem down = _banners(
        notice: OutboxPendingNotice(count: 1, oldestPendingAt: _t0),
        connection: ConnectionState.disconnected,
        now: _t0,
      ).all.singleWhere((BannerItem i) => i.id == BannerIds.outboxPending);
      expect(down.message, contains('1'));
      expect(down.message, contains('连接恢复'));

      // The same count, the same age — the only difference is that the link is
      // up, and the sentence must stop making a claim about the network.
      final BannerItem up = _banners(
        notice:
            OutboxPendingNotice(count: 2, anyRetried: true, oldestPendingAt: _t0),
        connection: ConnectionState.connected,
        now: _t0,
      ).all.singleWhere((BannerItem i) => i.id == BannerIds.outboxPending);
      expect(up.message, contains('2'));
      expect(up.message.contains('连接恢复'), isFalse);
      expect(up.message.contains('网络'), isFalse);
      expect(up.severity, BannerSeverity.info);
      expect(up.dismissible, isFalse,
          reason: 'owner ruling unchanged: a live condition carries no ✕');
    });

    test('the neutral sentence exists in every locale and promises nothing',
        () {
      for (final AppLocale locale in AppLocale.values) {
        final String s = AppStrings.of(locale).outboxPendingNoticeLinkUp(3);
        expect(s.trim(), isNotEmpty, reason: '$locale');
        expect(s, contains('3'), reason: '$locale');
        // 15 册 §2.0-b: the word may only be used because a persistent queue
        // really backs it — and it must never be dressed up as 「已发送」.
        expect(s.contains('已发送'), isFalse, reason: '$locale');
      }
    });
  });

  // ── ④ the wake-up the grace needs has an OWNER ────────────────────────────
  //
  // 🔴 THE LEAK, AND WHY IT IS NOT A TEST-HARNESS COMPLAINT. The grace is the
  // one condition that turns true with no mutation behind it, so `DeliveryOutbox`
  // arms a real 5 s `Timer` to repaint at that instant. A screen the user leaves
  // before it fires must not leave that timer running: it would wake a torn-down
  // host (`onOutboxChanged` into a disposed `ChatController`).
  // `rerun_copy_render_test.dart` is where this surfaced - `testWidgets` fails
  // any test whose tree is torn down with a `Timer` still pending, and the stack
  // it printed named `armOutboxNoticeTimer` under `_admit`.
  //
  // Two cases, and only the second needs the latch: dispose AFTER the recompute
  // settled is closed by the cancel alone, dispose DURING it is not - the
  // recompute is async, so it resumes past its `await` and arms a REPLACEMENT
  // that the cancel already ran past. That handle is then reachable by nothing.
  //
  // REVERSE CONTROLS, REALLY RUN 2026-09-07, one per case:
  //   · drop `_noticeGrace?.cancel()` from `dispose()` ⇒ the FIRST case fails,
  //     「Expected: empty / Actual: [Instance of 'FakeTimer']」;
  //   · drop `if (_disposed) return;` from `_refreshDerived` ⇒ the SECOND case
  //     fails with the same pair plus its reason, 「a recompute that resumed
  //     after dispose armed a fresh timer」, while the first stays green.
  // Neither reverse control reddens the other case - which is the point: the
  // cancel and the latch close different windows.
  group('④ the grace wake-up is released with the queue', () {
    test('🔴 dispose after a healthy first attempt cancels the wake-up', () {
      FakeAsync().run((FakeAsync async) {
        final DeliveryOutbox box = _box(_Host());
        unawaited(box.load());
        async.flushMicrotasks();
        // Nothing pending yet ⇒ nothing to wake up for. This is the negative
        // control for the count below: it proves the timer that appears next
        // was armed BY the enqueue and not by construction.
        expect(async.pendingTimers, isEmpty);

        unawaited(_enqueue(box, 'r-1'));
        async.flushMicrotasks();
        expect(
          async.pendingTimers,
          hasLength(1),
          reason: 'positive control: the grace wake-up really was armed',
        );

        box.dispose();
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('🔴 dispose DURING the recompute does not arm a replacement', () {
      FakeAsync().run((FakeAsync async) {
        final DeliveryOutbox box = _box(_Host());
        unawaited(box.load());
        async.flushMicrotasks();

        // The page exit lands INSIDE the enqueue's `await`: the recompute has
        // started and has not reached its arming line yet.
        unawaited(_enqueue(box, 'r-1'));
        box.dispose();
        async.flushMicrotasks();

        expect(
          async.pendingTimers,
          isEmpty,
          reason: 'a recompute that resumed after dispose armed a fresh timer',
        );
      });
    });
  });
}
