// D9 ① (0.3.0) — a timeline row write that fails must not be silent.
//
// THE DEFECT THIS PINS: `TimelineStore._persistOne` was
// `unawaited(_persistence.upsert(entry))`, so a row that never reached disk
// produced NOTHING a phone can show anyone — on screen this session, gone after
// restart, no trail. That is red-line F2's second direction (saying done what was
// not done) executed by omission.
//
// ⚠️ NOT the store's doing: `SqfliteTimelinePersistence._serialize`
// (timeline_sqlite.dart:574) returns the write future UNCAUGHT — its
// `catchError` is on the chain copy and only stops one failed write wedging the
// next. `unawaited` is what discarded the error, which then became an unhandled
// async error in the app's zone: invisible on a device, and (see the double
// below) trivially mistakable for「loud」 in a test.
//
// THE HONEST MINIMUM UNDER TEST: the failure lands in DiagLog with the row id;
// the in-memory row stays (it is true for this session, and no per-row UI
// surface claims durability — the only durability claim is the per-store
// 全部历史 footnote). A per-row user-visible marker needs new copy — follow-up,
// not this wave.
//
// REVERSE CONTROL (D9①): revert `_persistOne` to the bare
// `unawaited(_persistence.upsert(entry))` — the first test goes red (no
// `timeline.persist_failed` line). Executed for real during the card, then
// restored; marker grep REVERSE-CONTROL-D9 = 0 in lib/.

import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
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

  test('🔴 D9① — a failed row write says so in the diag trail, by row id', () async {
    final TimelineEntry entry = store.buildFromUtterance(
      clientId: 'u-1',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: 'a sentence that will not reach disk',
    );
    await _pump();

    expect(persistence.failedWrites, greaterThan(0),
        reason: 'positive control — the write really was attempted and failed');
    final String trail = DiagLog.instance.snapshot().join('\n');
    expect(trail, contains('timeline.persist_failed'),
        reason: 'a write failure with no trail is a silent loss — the exact '
            'defect this card removes');
    expect(trail, contains(entry.id),
        reason: 'the line must name WHICH row will not survive a restart');
  });

  test('D9① — the in-memory row stays: true for this session, and nothing '
      'per-row claims durability', () async {
    store.buildFromUtterance(
      clientId: 'u-2',
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      text: 'still real on screen',
    );
    await _pump();

    expect(store.entries, hasLength(1),
        reason: 'the user said it and can see it — dropping it from the list '
            'would be a second lie, not honesty');
    // …but storage honestly has nothing.
    expect(await persistence.loadAll(), isEmpty);
  });

  test('D9① — a later successful write is NOT reported as failed (no crying '
      'wolf)', () async {
    persistence.failWrites = false;
    store.buildFromUtterance(
      clientId: 'u-3',
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      text: 'this one lands',
    );
    await _pump();

    expect(await persistence.loadAll(), hasLength(1));
    expect(
      DiagLog.instance.snapshot().join('\n'),
      isNot(contains('timeline.persist_failed')),
    );
  });

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
