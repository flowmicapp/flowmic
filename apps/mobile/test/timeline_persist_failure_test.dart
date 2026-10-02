// A failed local write keeps the row visible and raises the shared notice.
// Reverse control: suppress the notice raise in TimelineWriteFailures.record.
// The rendered controller-to-screen path is pinned in
// timeline_persist_failure_screen_test.dart.

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/timeline/timeline_write_failures.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_purge.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';

/// A persistence whose writes fail while reads keep working — the disk-full /
/// I/O-error shape, not a dead database.
///
/// ⚠️ `async`, and that is the whole point of the double: sqflite reports a
/// failed write by COMPLETING THE FUTURE WITH AN ERROR, never by throwing
/// synchronously. A synchronous throw would escape `unawaited(...)` up the call
/// stack and make even the unfixed code look loud — the reverse control would
/// then be red for a reason production never produces, i.e. the test would be
/// measuring the double instead of the defect.
class _WriteFailsPersistence extends InMemoryTimelinePersistence {
  bool failWrites = true;
  int failedWrites = 0;

  @override
  Future<void> upsert(TimelineEntry entry) async {
    if (failWrites) {
      failedWrites++;
      throw StateError('disk write refused (test)');
    }
    return super.upsert(entry);
  }
}

/// Let the fire-and-forget persist future (and its error continuation) run.
Future<void> _pump() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
}

void main() {
  late _WriteFailsPersistence persistence;
  late TimelineStore store;

  setUp(() {
    DiagLog.instance.clear();
    persistence = _WriteFailsPersistence();
    store = newTestStore(persistence: persistence);
  });

  tearDown(() => store.dispose());

  test(
    '🔴 D9① — a failed row write says so in the diag trail, by row id',
    () async {
      final TimelineEntry entry = store.buildFromUtterance(
        clientId: 'u-1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'a sentence that will not reach disk',
      );
      await _pump();

      expect(
        persistence.failedWrites,
        greaterThan(0),
        reason: 'positive control — the write really was attempted and failed',
      );
      final String trail = DiagLog.instance.snapshot().join('\n');
      expect(
        trail,
        contains('timeline.persist_failed'),
        reason:
            'a write failure with no trail is a silent loss — the exact '
            'defect this card removes',
      );
      expect(
        trail,
        contains(entry.id),
        reason: 'the line must name WHICH row will not survive a restart',
      );
      expect(trail, contains('StateError'));
    },
  );

  test(
    'failed row stays visible and warns before a later reload loses it',
    () async {
      int notices = 0;
      store.writeFailures.addListener(() => notices++);
      final TimelineEntry entry = store.buildFromUtterance(
        clientId: 'u-2',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        text: 'still real on screen',
      );
      await _pump();

      expect(
        store.entries,
        hasLength(1),
        reason:
            'the user said it and can see it — dropping it from the list '
            'would be a second lie, not honesty',
      );
      expect(store.writeFailures.entryIds, contains(entry.id));
      expect(store.writeFailures.noticeTicket, isNotNull);
      expect(notices, 1);
      expect(await persistence.loadAll(), isEmpty);
      final int? ticket = store.writeFailures.noticeTicket;
      await store.load();
      expect(store.entries, isEmpty);
      expect(store.writeFailures.entryIds, isEmpty);
      expect(store.writeFailures.noticeTicket, ticket);
      expect(notices, 1, reason: 'the user was warned before reload');
    },
  );

  for (final bool batch in <bool>[false, true]) {
    test(
      '${batch ? 'batch' : 'single'} delete forgets only removed failed rows',
      () async {
        int notices = 0;
        store.writeFailures.addListener(() => notices++);
        final TimelineEntry removed = store.buildFromUtterance(
          clientId: 'removed',
          mode: FlowMode.realtime,
          delivery: Delivery.none,
          text: 'removed sentence',
        );
        final TimelineEntry kept = store.buildFromUtterance(
          clientId: 'kept',
          mode: FlowMode.realtime,
          delivery: Delivery.none,
          text: 'kept sentence',
        );
        await _pump();
        expect(
          store.writeFailures.entryIds,
          unorderedEquals(<String>[removed.id, kept.id]),
        );
        final int? ticket = store.writeFailures.noticeTicket;
        if (batch) {
          await store.deleteMany(<TimelineEntry>[removed]);
        } else {
          store.delete(removed.id);
        }
        await _pump();
        expect(store.findById(removed.id), isNull);
        expect(store.writeFailures.entryIds, <String>{kept.id});
        expect(store.writeFailures.noticeTicket, ticket);
        expect(
          notices,
          1,
          reason: 'deletion does not raise or dismiss a notice',
        );
      },
    );
  }

  test('range clear forgets a removed row whose last rewrite failed', () async {
    int notices = 0;
    store.writeFailures.addListener(() => notices++);
    persistence.failWrites = false;
    final TimelineEntry entry = store.buildFromUtterance(
      clientId: 'range',
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      text: 'stored sentence',
    );
    await _pump();
    persistence.failWrites = true;
    store.applyEdit(entry.id, 'unsaved edit');
    await _pump();
    expect(store.writeFailures.entryIds, <String>{entry.id});
    final int? ticket = store.writeFailures.noticeTicket;
    await store.clear(ClearKind.text, ClearWindow.all);
    expect(store.entries, isEmpty);
    expect(store.writeFailures.entryIds, isEmpty);
    expect(store.writeFailures.noticeTicket, ticket);
    expect(notices, 1);
  });

  test(
    'deleting the last article member also forgets its failed head',
    () async {
      int notices = 0;
      store.writeFailures.addListener(() => notices++);
      final TimelineEntry head = buildArticleHeadOf(
        store,
        articleId: 'article',
        startedAt: DateTime.now().toUtc(),
      );
      final TimelineEntry member = store.buildFromUtterance(
        clientId: 'member',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        text: 'article sentence',
        articleId: 'article',
      );
      await _pump();
      expect(
        store.writeFailures.entryIds,
        unorderedEquals(<String>[head.id, member.id]),
      );
      final int? ticket = store.writeFailures.noticeTicket;
      store.delete(member.id);
      await _pump();
      expect(store.entries, isEmpty);
      expect(store.writeFailures.entryIds, isEmpty);
      expect(store.writeFailures.noticeTicket, ticket);
      expect(notices, 1);
    },
  );

  test('three failed writes and a repeat of the same row raise one notice', () {
    fakeAsync((FakeAsync time) {
      int notices = 0;
      store.writeFailures.addListener(() => notices++);
      for (int i = 0; i < 3; i++) {
        store.buildFromUtterance(
          clientId: 'burst-$i',
          mode: FlowMode.realtime,
          delivery: Delivery.none,
          text: 'burst sentence $i',
        );
      }
      time.flushMicrotasks();
      expect(notices, 1, reason: 'three failed writes form one burst');
      final String id = store.entries.first.id;
      store.applyEdit(id, 'edited sentence');
      time.flushMicrotasks();
      expect(persistence.failedWrites, 4);
      expect(store.entries, hasLength(3));
      expect(store.writeFailures.entryIds, hasLength(3));
      expect(notices, 1);
    });
  });

  test('leading notice is immediate; only two quiet seconds end a burst', () {
    fakeAsync((FakeAsync time) {
      int notices = 0;
      store.writeFailures.addListener(() => notices++);
      final TimelineEntry entry = store.buildFromUtterance(
        clientId: 'quiet',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        text: 'repeated failed write',
      );
      time.flushMicrotasks();
      expect(notices, 1, reason: 'no debounce delay before the first warning');
      final int? firstTicket = store.writeFailures.noticeTicket;
      for (int i = 0; i < 5; i++) {
        time.elapse(const Duration(milliseconds: 1900));
        store.applyEdit(entry.id, 'edited sentence');
        time.flushMicrotasks();
        expect(notices, 1);
      }
      time.elapse(TimelineWriteFailures.burstQuietPeriod);
      store.applyEdit(entry.id, 'edited sentence');
      time.flushMicrotasks();
      expect(notices, 2);
      expect(store.writeFailures.noticeTicket, isNot(firstTicket));
    });
  });

  test('D9① — a later successful write is NOT reported as failed (no crying '
      'wolf)', () async {
    persistence.failWrites = false;
    int notices = 0;
    store.writeFailures.addListener(() => notices++);
    store.buildFromUtterance(
      clientId: 'u-3',
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      text: 'this one lands',
    );
    await _pump();

    expect(await persistence.loadAll(), hasLength(1));
    expect(notices, 0);
    expect(store.writeFailures.entryIds, isEmpty);
    expect(store.writeFailures.noticeTicket, isNull);
    expect(
      DiagLog.instance.snapshot().join('\n'),
      isNot(contains('timeline.persist_failed')),
    );
  });

  test(
    'a later successful rewrite clears the in-memory failure for that row',
    () async {
      final TimelineEntry entry = store.buildFromUtterance(
        clientId: 'retry',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        text: 'eventually written',
      );
      await _pump();
      expect(store.writeFailures.entryIds, contains(entry.id));
      persistence.failWrites = false;
      store.applyEdit(entry.id, 'edited sentence');
      await _pump();
      expect(store.writeFailures.entryIds, isEmpty);
      expect(await persistence.loadAll(), hasLength(1));
    },
  );

  test('D9 — a failed single-row reap is loud too (the delete direction of the '
      'same lie)', () async {
    persistence.failWrites = false;
    final TimelineEntry entry = store.buildFromUtterance(
      clientId: 'u-4',
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      text: 'row whose delete will fail',
    );
    await _pump();
    expect(await persistence.loadAll(), hasLength(1)); // positive control

    persistence.failWrites = true; // InMemory delete() does not throw…
    // …so fail the reap through the vault-less path: deleting from a persistence
    // whose delete throws. InMemoryTimelinePersistence.delete never throws, so
    // subclass behaviour is simulated by a persistence-level override:
    store.dispose();
    final _DeleteFailsPersistence deleteFails = _DeleteFailsPersistence();
    await deleteFails.upsert(entry);
    store = newTestStore(persistence: deleteFails);
    await store.load();
    DiagLog.instance.clear();

    store.delete(entry.id);
    await _pump();

    final String trail = DiagLog.instance.snapshot().join('\n');
    expect(trail, contains('timeline.reap_failed'));
    expect(trail, contains(entry.id));
  });
}

class _DeleteFailsPersistence extends InMemoryTimelinePersistence {
  @override
  Future<void> delete(String id) async {
    throw StateError('disk delete refused (test)');
  }
}
