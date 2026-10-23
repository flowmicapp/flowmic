// NR-286 — the queue retries an unanswered item by itself while the link stays
// up. Contract: doc 15 `15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md` §2.6-a
// (rule numbers below refer to that list).
//
// Device evidence (0.3.116, 2026-10-20, `.local/device-evidence/0316-upgrade/
// report.md` A1): the computer froze 36 s, the row said 「Pending · no answer
// yet」, the 45 s watchdog put the item back to `queued` — and nothing drained
// it again for 6.5 minutes, because the only drain trigger was the link-up
// edge and the link never went down.
//
// This file pins the QUEUE half against a fake host, on the production backoff
// table and the production 45 s watchdog, under a fake clock. The production
// WIRING (ChatController passes the real link predicate, the frame really goes
// out again, the row really settles once) is pinned by
// test/chat_no_answer_retry_test.dart.
//
// ⚠️ About origins: `_attempt` reads the wall clock (`DateTime.now()`), which
// `fakeAsync` does not move. Age-dependent cases therefore set the item's
// `createdAt` in the past instead of waiting for it.

import 'dart:async';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show InjectOrigin;
import 'package:flutter_test/flutter_test.dart';

const LiveConnection _onA = LiveConnection(
  machineUid: 'machine-uid-AAAA',
  pairingIdentity: 'standalone|instance:inst-A-lan',
  pcId: 'pc-A-lan',
  channel: ServerChannel.lan,
);

class _Send {
  _Send(this.requestId, this.origin, this.at);
  final String requestId;
  final InjectOrigin origin;
  final Duration at;
}

class _Host implements OutboxDrainHost {
  _Host(this.clock);
  final FakeAsync clock;
  final List<_Send> sends = <_Send>[];

  /// Lets a case hold a drain inside its link gate (rule 6, the busy path).
  Future<bool> Function() ensure = () async => true;

  @override
  LiveConnection get liveConnection => _onA;

  @override
  Future<bool> ensureLink() => ensure();

  @override
  Future<void> reseedDestination() async {}

  @override
  Future<bool> send(
    OutboxItem item,
    String targetPcId, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  }) async {
    sends.add(_Send(item.requestId, origin, clock.elapsed));
    return true;
  }

  @override
  void onOutboxChanged() {}
}

class _Rig {
  _Rig(this.clock, {int capacity = kOutboxCapacity}) : host = _Host(clock) {
    box = DeliveryOutbox(
      store: store,
      blobs: InMemoryOutboxBlobStore(),
      host: host,
      retryLinkUp: () => linkUp,
      capacity: capacity,
    );
  }
  final FakeAsync clock;
  final _Host host;
  final InMemoryOutboxStore store = InMemoryOutboxStore();
  late final DeliveryOutbox box;
  bool linkUp = true;

  void enqueue(String id, {Duration age = Duration.zero}) {
    box.enqueueText(
      requestId: id,
      entryId: 'loc_$id',
      wireEntryId: 'loc_$id',
      source: 'stt',
      text: 'hello pc',
      mode: 'realtime',
      createdAt: DateTime.now().toUtc().subtract(age),
    );
    clock.flushMicrotasks();
  }

  void drain() {
    box.drain();
    clock.flushMicrotasks();
  }

  void settle(String id, {required bool ok, String? code}) {
    box.settle(correlationId: id, ok: ok, code: code);
    clock.flushMicrotasks();
  }

  OutboxItem item(String id) {
    OutboxItem? out;
    store.findByRequestId(id).then((OutboxItem? i) => out = i);
    clock.flushMicrotasks();
    return out!;
  }

  List<_Send> sendsOf(String id) =>
      host.sends.where((_Send s) => s.requestId == id).toList();
}

/// Attempt instants, in seconds after the first send, for a computer that
/// never answers — derived from the PRODUCTION table, not typed in, so a change
/// to either constant changes the expectation with it.
List<int> _scheduleWithin(int horizonS) {
  final int inflight = kOutboxInflightTimeout.inSeconds;
  final List<int> at = <int>[0];
  int k = 0;
  while (true) {
    final int wait = kOutboxNoAnswerRetryBackoff[
        k.clamp(0, kOutboxNoAnswerRetryBackoff.length - 1)].inSeconds;
    final int next = at.last + inflight + wait;
    if (next > horizonS) return at;
    at.add(next);
    k++;
  }
}

void main() {
  group('🔴 NR-286 — while the link stays up, an unanswered item is re-sent by the queue', () {
    test('rules 1+4: the 45 s requeue leads to an automatic re-send of the SAME delivery, no navigation', () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        rig.enqueue('r1');
        rig.drain();
        expect(rig.sendsOf('r1'), hasLength(1), reason: 'premise: the first attempt went out');
        // The computer says nothing. 45 s: the item is back in the queue …
        async.elapse(kOutboxInflightTimeout);
        expect(rig.item('r1').state, OutboxDeliveryState.queued);
        expect(rig.item('r1').lastRefusalNote, 'INJECT_NO_RESULT');
        // … and with no link edge and no user action, the queue tries again.
        async.elapse(kOutboxNoAnswerRetryBackoff.first);
        expect(
          rig.sendsOf('r1'),
          hasLength(2),
          reason: 'the computer stayed connected and the queue never tried again — '
              'the 「Pending」 word on the row has no mechanism behind it (report.md A1)',
        );
        expect(rig.item('r1').state, OutboxDeliveryState.inflight);
        expect(rig.item('r1').requestId, 'r1', reason: 'gate 1: the retry is the same delivery');
        // The computer recovers and answers this attempt: delivered, once.
        rig.settle('r1', ok: true);
        expect(rig.item('r1').state, OutboxDeliveryState.delivered);
        async.elapse(const Duration(hours: 1));
        expect(rig.sendsOf('r1'), hasLength(2), reason: 'rule 7: an answered item is never re-sent');
        rig.box.dispose();
      });
    });

    test('rule 1, second half: a first frame sent BESIDE the queue (speech, resend, picture) is retried too', () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        // `_deliverDirect` / `runReInject` / the picture path: enqueue, then emit
        // the frame themselves. The item never goes inflight, so the queue's
        // own watchdog never runs for it.
        rig.enqueue('beside');
        async.elapse(kOutboxInflightTimeout);
        expect(rig.sendsOf('beside'), isEmpty, reason: 'nothing before the 45 s budget is up');
        async.elapse(kOutboxNoAnswerRetryBackoff.first);
        expect(rig.sendsOf('beside'), hasLength(1),
            reason: 'a live emit the computer swallowed was never retried while the link stayed up');
        // From here it is an ordinary queued attempt: the next silence waits
        // the SECOND step, exactly like an item the queue sent itself.
        async.elapse(kOutboxInflightTimeout + kOutboxNoAnswerRetryBackoff[1]);
        expect(rig.sendsOf('beside'), hasLength(2));
        rig.box.dispose();
      });
    });

    test('rule 7, beside the queue: an answered live emit is never retried', () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        rig.enqueue('answered');
        async.elapse(const Duration(seconds: 3));
        rig.settle('answered', ok: true); // the computer answered the live emit
        async.elapse(const Duration(hours: 1));
        expect(rig.sendsOf('answered'), isEmpty);
        rig.box.dispose();
      });
    });

    test('rule 2: a computer that never answers gets a capped backoff, not a flood, and the item stays owed', () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        rig.enqueue('silent');
        rig.drain();
        async.elapse(const Duration(hours: 1));
        final List<int> got = rig.sendsOf('silent').map((_Send s) => s.at.inSeconds).toList();
        expect(got, _scheduleWithin(3600),
            reason: 'attempt instants must follow 45 s in flight + the production backoff table');
        // Sanity on the shape the contract promises (doc 15 §2.6-a rule 2).
        expect(got.length, lessThanOrEqualTo(16), reason: 'about ten frames an hour, not a flood');
        final List<int> gaps = <int>[for (int i = 1; i < got.length; i++) got[i] - got[i - 1]];
        for (int i = 1; i < gaps.length; i++) {
          expect(gaps[i], greaterThanOrEqualTo(gaps[i - 1]), reason: 'the backoff never speeds up');
        }
        expect(gaps.last, kOutboxInflightTimeout.inSeconds + kOutboxNoAnswerRetryBackoff.last.inSeconds,
            reason: 'capped at the last table entry');
        // Never given up on, never claimed: the banner keeps counting it.
        expect(rig.item('silent').isTerminal, isFalse);
        expect(rig.box.pendingCountTotal, 1);
        rig.box.dispose();
      });
    });

    test('rule 3: retry due while the link is down ⇒ nothing sent and nothing re-armed; the link-up drain takes over', () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        rig.enqueue('down');
        rig.drain();
        rig.linkUp = false;
        async.elapse(const Duration(hours: 1));
        expect(rig.sendsOf('down'), hasLength(1),
            reason: 'a retry must not fire into a link that is not up (and must not loop)');
        expect(rig.item('down').state, OutboxDeliveryState.queued);
        // The link-up edge (chat_outbox_host.dart) is the owner of this case.
        rig.linkUp = true;
        rig.drain();
        expect(rig.sendsOf('down'), hasLength(2));
        rig.box.dispose();
      });
    });

    test('rule 5: retries keep the origin rules — promise ⇒ deferred, past 60 s ⇒ deferred, young ⇒ live', () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        // young: spoken 10 s ago (wall clock), never promised anything.
        rig.enqueue('young', age: const Duration(seconds: 10));
        // old: spoken 2 minutes ago, never promised anything.
        rig.enqueue('old', age: const Duration(minutes: 2));
        // promised: young, but the row already said 「will not type it in」.
        rig.enqueue('promised', age: const Duration(seconds: 10));
        rig.drain();
        rig.settle('promised', ok: false, code: 'INJECT_PC_OFFLINE');
        expect(rig.item('promised').deferPromisedAt, isNotNull, reason: 'premise');
        rig.drain(); // the PC-back drain: `promised` goes out again, unanswered
        // Nobody answers anything: every one of the three is requeued by the
        // watchdog and re-sent by the retry.
        async.elapse(kOutboxInflightTimeout + kOutboxNoAnswerRetryBackoff.first);
        final InjectOrigin youngRetry = rig.sendsOf('young').last.origin;
        final InjectOrigin oldRetry = rig.sendsOf('old').last.origin;
        final InjectOrigin promisedRetry = rig.sendsOf('promised').last.origin;
        expect(rig.sendsOf('young'), hasLength(2));
        expect(rig.sendsOf('old'), hasLength(2));
        expect(rig.sendsOf('promised'), hasLength(3));
        expect(promisedRetry, InjectOrigin.deferred,
            reason: 'an automatic retry must never type what the row said it would not type');
        expect(oldRetry, InjectOrigin.deferred, reason: 'past kLiveDeliveryWindow ⇒ deferred');
        // Positive control: without it, 「everything the timer sends is deferred」
        // would pass the two lines above.
        expect(youngRetry, InjectOrigin.live, reason: 'inside the window and never promised ⇒ live');
        rig.box.dispose();
      });
    });

    test('rule 6: one item, one frame in flight — a due retry during another drain neither duplicates nor drops', () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        rig.enqueue('d1');
        rig.drain();
        async.elapse(kOutboxInflightTimeout); // d1 back to queued, retry armed for +5 s
        // Another drain starts at +2 s and is held inside its link gate past
        // the retry's due time.
        async.elapse(const Duration(seconds: 2));
        final Completer<bool> gate = Completer<bool>();
        rig.host.ensure = () => gate.future;
        rig.enqueue('d2');
        rig.box.drain();
        async.elapse(const Duration(seconds: 4)); // the retry comes due mid-pass
        expect(rig.sendsOf('d1'), hasLength(1), reason: 'premise: the held pass has not sent yet');
        gate.complete(true);
        rig.host.ensure = () async => true;
        async.flushMicrotasks();
        // The held pass carried d1 (it was queued when the pass loaded) …
        expect(rig.sendsOf('d1'), hasLength(2));
        expect(rig.item('d1').state, OutboxDeliveryState.inflight);
        // … and the busy re-check must not put out a second copy while it flies.
        async.elapse(const Duration(seconds: 30));
        expect(rig.sendsOf('d1'), hasLength(2),
            reason: 'two frames of one delivery in flight at once');
        rig.box.dispose();
      });
    });

    test('rule 6: a retry due while a pass that did NOT load the item is running is not dropped', () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        rig.enqueue('late');
        rig.drain();
        // A pass that loads the queue while `late` is still IN FLIGHT (so it
        // does not carry it) and is then held past both the watchdog and the
        // retry's due time.
        async.elapse(const Duration(seconds: 44));
        final Completer<bool> gate = Completer<bool>();
        rig.host.ensure = () => gate.future;
        rig.enqueue('other');
        rig.box.drain();
        async.elapse(const Duration(seconds: 7)); // watchdog at 45 s, retry due at 50 s
        expect(rig.item('late').state, OutboxDeliveryState.queued, reason: 'premise');
        gate.complete(true);
        rig.host.ensure = () async => true;
        async.flushMicrotasks();
        expect(rig.sendsOf('late'), hasLength(1),
            reason: 'premise: the held pass loaded its list before `late` was requeued');
        async.elapse(kOutboxNoAnswerRetryBusyRecheck);
        expect(rig.sendsOf('late'), hasLength(2),
            reason: 'the retry came due during a busy drain and was dropped — '
                'the item would wait for a link edge again');
        rig.box.dispose();
      });
    });

    test('rule 7: a terminal refusal or any answer stops the retries', () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        rig.enqueue('term');
        rig.drain();
        async.elapse(kOutboxInflightTimeout + kOutboxNoAnswerRetryBackoff.first);
        expect(rig.sendsOf('term'), hasLength(2), reason: 'premise: retrying');
        rig.settle('term', ok: false, code: 'INJECT_FRAME_INVALID');
        expect(rig.item('term').state, OutboxDeliveryState.refused);
        async.elapse(const Duration(hours: 1));
        expect(rig.sendsOf('term'), hasLength(2));
        rig.box.dispose();
      });
    });

    test('rule 7: an answer resets the streak — the next silence starts from the first step again', () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        rig.enqueue('reset');
        rig.drain();
        // Two silences: the streak reaches 2.
        async.elapse(kOutboxInflightTimeout + kOutboxNoAnswerRetryBackoff[0]);
        async.elapse(kOutboxInflightTimeout + kOutboxNoAnswerRetryBackoff[1]);
        expect(rig.sendsOf('reset'), hasLength(3), reason: 'premise');
        // A retryable answer (not a delivery): back to queued, streak cleared.
        rig.settle('reset', ok: false, code: 'PC_UNREACHABLE');
        rig.drain();
        final Duration t0 = async.elapsed;
        async.elapse(kOutboxInflightTimeout + kOutboxNoAnswerRetryBackoff[0]);
        expect(rig.sendsOf('reset').last.at - t0,
            kOutboxInflightTimeout + kOutboxNoAnswerRetryBackoff[0],
            reason: 'after an answer, the first silence waits the FIRST step, not the third');
        rig.box.dispose();
      });
    });
  });

  // ── Acceptance review 2026-10-20 (S1 / N2 / N3 / N4) ──────────────────────
  group('🔴 NR-286 review — a retry re-sends ONLY the item that came due', () {
    test("S1: old's retry re-sends neither `fresh` (live frame still out) nor a requeued item without a timer", () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        // `old`: sent by the queue at 0 s, never answered ⇒ retry due at 50 s.
        rig.enqueue('old');
        rig.drain();
        // `requeued` (1 s later, so `old` is in flight and not carried again):
        // answered with a retryable code ⇒ back to `queued` by a requeue that
        // arms NO timer (doc 15 §2.6-a, 「仍开着」).
        async.elapse(const Duration(seconds: 1));
        rig.enqueue('requeued');
        rig.drain();
        rig.settle('requeued', ok: false, code: 'PC_UNREACHABLE');
        expect(rig.item('requeued').state, OutboxDeliveryState.queued, reason: 'premise');
        expect(rig.sendsOf('old'), hasLength(1), reason: 'premise');
        final int requeuedSends = rig.sendsOf('requeued').length;
        async.elapse(const Duration(seconds: 48));
        // 49 s: the user speaks. `_deliverDirect` enqueues and emits the live
        // frame itself — `fresh` is `queued` while that frame is on the wire.
        rig.enqueue('fresh');
        async.elapse(const Duration(seconds: 2)); // `old`'s retry fires at 50 s
        // Positive control: the retry DID run — otherwise 「fresh not re-sent」
        // would pass with a dead timer.
        expect(rig.sendsOf('old'), hasLength(2), reason: 'premise: `old` was retried at 50 s');
        expect(rig.sendsOf('fresh'), isEmpty,
            reason: "one item's retry re-sent a spoken sentence whose live frame was still out");
        expect(rig.sendsOf('requeued'), hasLength(requeuedSends),
            reason: "one item's retry carried out an item that has no timer of its own");
        // `fresh` is not forgotten: its own 45 s guard + first step (≈ 99 s).
        async.elapse(const Duration(seconds: 48));
        expect(rig.sendsOf('fresh'), hasLength(1),
            reason: 'its own first-attempt guard still re-sends it');
        rig.box.dispose();
      });
    });

    test('N2: a defer promise that lands while the retry waits on the link is honoured (control: none ⇒ live)', () {
      for (final bool promise in <bool>[true, false]) {
        fakeAsync((FakeAsync async) {
          final _Rig rig = _Rig(async);
          rig.enqueue('p', age: const Duration(seconds: 10));
          rig.drain();
          async.elapse(kOutboxInflightTimeout); // requeued, retry due in 5 s
          final Completer<bool> gate = Completer<bool>();
          rig.host.ensure = () => gate.future;
          async.elapse(kOutboxNoAnswerRetryBackoff.first); // the pass loads `p`, waits
          expect(rig.sendsOf('p'), hasLength(1), reason: 'premise: held in the link gate');
          if (promise) {
            // The original frame's late answer: the PC is away ⇒ the row now
            // promises 「will not type it in」 and the item carries the fact.
            rig.settle('p', ok: false, code: 'INJECT_PC_OFFLINE');
            expect(rig.item('p').deferPromisedAt, isNotNull, reason: 'premise');
          }
          gate.complete(true);
          rig.host.ensure = () async => true;
          async.flushMicrotasks();
          expect(rig.sendsOf('p'), hasLength(2), reason: 'premise: the retry went out');
          expect(
            rig.sendsOf('p').last.origin,
            promise ? InjectOrigin.deferred : InjectOrigin.live,
            reason: promise
                ? 'the retry used the copy it loaded BEFORE the promise landed and typed '
                    'what the row said it would not'
                : 'positive control: young and never promised ⇒ live',
          );
          if (promise) {
            expect(rig.item('p').deferPromisedAt, isNotNull,
                reason: 'the stale copy overwrote the promise on disk');
          }
          rig.box.dispose();
        });
      }
    });

    test('N2: an item answered while the retry waits on the link is neither re-sent nor dragged back to inflight', () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        rig.enqueue('a');
        rig.drain();
        async.elapse(kOutboxInflightTimeout);
        final Completer<bool> gate = Completer<bool>();
        rig.host.ensure = () => gate.future;
        async.elapse(kOutboxNoAnswerRetryBackoff.first);
        rig.settle('a', ok: true); // the late answer to the first frame
        gate.complete(true);
        async.flushMicrotasks();
        expect(rig.sendsOf('a'), hasLength(1));
        expect(rig.item('a').state, OutboxDeliveryState.delivered);
        rig.box.dispose();
      });
    });

    test('N3: an item that leaves the queue terminally (overflow) takes its retry timer with it', () {
      fakeAsync((FakeAsync async) {
        bool isGuard(FakeTimer t) =>
            t.duration == kOutboxInflightTimeout + kOutboxNoAnswerRetryBackoff.first;
        final _Rig rig = _Rig(async, capacity: 1);
        rig.enqueue('first');
        expect(async.pendingTimers.where(isGuard), hasLength(1),
            reason: 'positive control: the first-attempt guard is armed at enqueue');
        rig.enqueue('second'); // over capacity ⇒ `first` is OUTBOX_OVERFLOW
        expect(rig.item('first').state, OutboxDeliveryState.refused, reason: 'premise');
        expect(async.pendingTimers.where(isGuard), hasLength(1),
            reason: 'the overflowed item still holds a retry timer (only `second` should)');
        rig.box.dispose();
      });
    });

    test('N4: a long drain logs ONE drain_busy line per pass, not one per due item every 2 s', () {
      fakeAsync((FakeAsync async) {
        final _Rig rig = _Rig(async);
        rig.enqueue('b1');
        rig.enqueue('b2');
        rig.drain();
        async.elapse(const Duration(seconds: 47)); // both requeued at 45 s
        final Completer<bool> gate = Completer<bool>();
        rig.host.ensure = () => gate.future;
        rig.box.drain(); // held across both retries' due time (50 s) …
        DiagLog.instance.clear();
        async.elapse(const Duration(seconds: 12)); // … and several 2 s re-checks each
        final int busyLines = DiagLog.instance
            .snapshot()
            .where((String l) =>
                l.contains('outbox.no_answer_retry_skipped') && l.contains('reason=drain_busy'))
            .length;
        expect(busyLines, 1);
        gate.complete(true);
        rig.host.ensure = () async => true;
        async.flushMicrotasks();
        rig.box.dispose();
      });
    });
  });
}
