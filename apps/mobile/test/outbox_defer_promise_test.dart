// NR-279 (A1) — once a row has told the user 「the computer will not type it in
// on its own」, no automatic re-delivery of that item may go out `live`.
//
// Contract: docs/rebuild/15-INJECTION-PERMISSION.md §2.5e-3, last bullet.
// Root cause: .local/device-evidence/0315-upgrade/rca-anomalies.md §1 — the
// note is selected by `INJECT_PC_OFFLINE`; the PC-back drain stamped every item
// younger than `kLiveDeliveryWindow` (60 s) as `live`, so a PC that came back
// 25 s later TYPED the text the row had just promised it would not.
//
// What these cases prove, and what they do not:
//  · (a)/(b)/(c) — the stamp the QUEUE puts on the frame, through the real
//    `DeliveryOutbox` (settle → drain → `_attempt` → `outboxInjectOrigin`).
//    That the PC then does not type a `deferred` frame is the desktop's own
//    Rust test (`inject/pipeline_tests.rs`, `deferred_outcome`); this file
//    cannot reach that layer.
//  · (d) — a row written by 0.3.107/0.3.115 (no `defer_promised_at` column) on
//    a REAL FILE: the open adds the column without touching the row, the row
//    reads null, and that item keeps the old (windowed) behaviour.
//  · It does NOT prove the row shows the note — that is
//    test/pc_offline_note_test.dart; the membership pin below ties the two.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_inject_origin.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show InjectOrigin;
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

const String _machine = 'machine-uid-AAAA';
const String _pairing = 'standalone|instance:inst-A-lan';
const String _pcId = 'pc-A-lan';
const LiveConnection _onA = LiveConnection(
  machineUid: _machine,
  pairingIdentity: _pairing,
  pcId: _pcId,
  channel: ServerChannel.lan,
);

class _Host implements OutboxDrainHost {
  final List<({String requestId, InjectOrigin origin})> sends =
      <({String requestId, InjectOrigin origin})>[];

  @override
  LiveConnection get liveConnection => _onA;

  @override
  Future<bool> ensureLink() async => true;

  @override
  Future<void> reseedDestination() async {}

  /// False ⇒ the next send 「never left」 (the wire-emit failure branch).
  bool emitSucceeds = true;

  @override
  Future<bool> send(
    OutboxItem item,
    String targetPcId, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  }) async {
    sends.add((requestId: item.requestId, origin: origin));
    return emitSucceeds;
  }

  @override
  void onOutboxChanged() {}
}

DeliveryOutbox _box(
  _Host host, {
  OutboxStore? store,
  Duration inflightTimeout = kOutboxInflightTimeout,
}) => DeliveryOutbox(
  store: store ?? InMemoryOutboxStore(),
  blobs: InMemoryOutboxBlobStore(),
  host: host,
  retryLinkUp: () => false,
  inflightTimeout: inflightTimeout,
);

/// Spoken JUST NOW — well inside `kLiveDeliveryWindow`, which is the whole
/// point: the defect only exists for a young item.
Future<void> _enqueueFresh(DeliveryOutbox box, String requestId) async {
  await box.enqueueText(
    requestId: requestId,
    entryId: 'loc_$requestId',
    wireEntryId: 'loc_$requestId',
    source: 'stt',
    text: 'hello pc',
    mode: 'realtime',
    createdAt: DateTime.now().toUtc(),
  );
}

void main() {
  group('🔴 NR-279 — a delivery the row reported as 「will not type it」 drains deferred', () {
    test('(a) INJECT_PC_OFFLINE, then the PC is back within the live window ⇒ deferred', () async {
      final _Host host = _Host();
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _box(host, store: store);
      await _enqueueFresh(box, 'off-1');
      await box.drain(); // first, live attempt
      expect(host.sends.single.origin, InjectOrigin.live);
      // The relay answers: no PC in the room (the verdict that selects the note).
      await box.settle(correlationId: 'off-1', ok: false, code: 'INJECT_PC_OFFLINE');
      final OutboxItem noted = (await store.findByRequestId('off-1'))!;
      expect(noted.state, OutboxDeliveryState.queued);
      expect(noted.deferPromisedAt, isNotNull,
          reason: 'the promise must be recorded on the item, not inferred');
      // The PC comes back seconds later: the automatic PC-back drain.
      await box.drain();
      expect(host.sends.length, 2);
      expect(host.sends.last.origin, InjectOrigin.deferred,
          reason: 'the row said the computer will not type it in on its own');
    });

    test('(a2) the fact survives an automatic attempt and a later non-promising verdict (write-once)', () async {
      final _Host host = _Host();
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _box(host, store: store);
      await _enqueueFresh(box, 'off-2');
      await box.drain();
      await box.settle(correlationId: 'off-2', ok: false, code: 'INJECT_PC_OFFLINE');
      final DateTime first = (await store.findByRequestId('off-2'))!.deferPromisedAt!;
      await box.drain(); // attempt clears lastRefusalNote — must not clear this
      // A second, different retryable verdict must not move or erase it.
      await box.settle(correlationId: 'off-2', ok: false, code: 'PC_UNREACHABLE');
      final OutboxItem after = (await store.findByRequestId('off-2'))!;
      expect(after.lastRefusalNote, 'PC_UNREACHABLE');
      expect(after.deferPromisedAt, first);
      await box.drain();
      expect(host.sends.map((s) => s.origin).toList(), <InjectOrigin>[
        InjectOrigin.live,
        InjectOrigin.deferred,
        InjectOrigin.deferred,
      ]);
    });

    test('(b) positive control — never noted, drained within the window ⇒ live', () async {
      // Same timing, a retryable failure that puts NO promise on the row (the
      // lost-emit case the window exists for). Without this, (a) could be
      // passing because everything young became deferred.
      final _Host host = _Host();
      final DeliveryOutbox box = _box(host);
      await _enqueueFresh(box, 'flap-1');
      await box.drain();
      await box.settle(correlationId: 'flap-1', ok: false, code: 'PC_UNREACHABLE');
      await box.drain();
      expect(host.sends.map((s) => s.origin).toList(),
          <InjectOrigin>[InjectOrigin.live, InjectOrigin.live]);
    });

    test('(c) the user presses Resend on a noted row ⇒ live (a press still types)', () async {
      final _Host host = _Host();
      final DeliveryOutbox box = _box(host);
      await _enqueueFresh(box, 'off-3');
      await box.drain();
      await box.settle(correlationId: 'off-3', ok: false, code: 'INJECT_PC_OFFLINE');
      await box.drain(userRequestedEntryIds: <String>{'loc_off-3'});
      expect(host.sends.last.origin, InjectOrigin.live);
    });

    test('(a3) the fact survives the item watchdog INJECT_NO_RESULT requeue', () async {
      // The review read this off `delivery_outbox_settle.dart` (the watchdog's
      // `copyWith` keeps the stamp) but no case ran it. A short watchdog
      // budget so the timer really fires.
      final _Host host = _Host();
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _box(
        host,
        store: store,
        inflightTimeout: const Duration(milliseconds: 20),
      );
      await _enqueueFresh(box, 'off-wd');
      await box.drain();
      await box.settle(correlationId: 'off-wd', ok: false, code: 'INJECT_PC_OFFLINE');
      final DateTime first = (await store.findByRequestId('off-wd'))!.deferPromisedAt!;
      await box.drain(); // automatic, deferred, now inflight with no answer
      await Future<void>.delayed(const Duration(milliseconds: 80));
      final OutboxItem after = (await store.findByRequestId('off-wd'))!;
      expect(after.state, OutboxDeliveryState.queued,
          reason: 'fixture: the watchdog really requeued it');
      expect(after.lastRefusalNote, 'INJECT_NO_RESULT');
      expect(after.deferPromisedAt, first);
      box.dispose();
    });

    // ── NR-279 review S4b — the user's own live send clears the fact ──────
    test('(S4b-1) Resend clears the fact; a later non-promising failure drains live again', () async {
      final _Host host = _Host();
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _box(host, store: store);
      await _enqueueFresh(box, 'rs-1');
      await box.drain();
      await box.settle(correlationId: 'rs-1', ok: false, code: 'INJECT_PC_OFFLINE');
      expect((await store.findByRequestId('rs-1'))!.deferPromisedAt, isNotNull);
      // The user presses Resend on the row (the row goes back to waiting: it
      // no longer makes the promise).
      await box.drain(userRequestedEntryIds: <String>{'loc_rs-1'});
      expect(host.sends.last.origin, InjectOrigin.live);
      final OutboxItem pressed = (await store.findByRequestId('rs-1'))!;
      expect(pressed.state, OutboxDeliveryState.inflight);
      expect(pressed.deferPromisedAt, isNull,
          reason: 'the fact means 「the row promises this now」; the press took the promise off the row');
      // That attempt fails in a way that promises nothing; the automatic
      // retry is judged by the window again (young ⇒ live), exactly as for an
      // item that was never noted.
      await box.settle(correlationId: 'rs-1', ok: false, code: 'PC_UNREACHABLE');
      await box.drain();
      expect(host.sends.map((s) => s.origin).toList(), <InjectOrigin>[
        InjectOrigin.live,
        InjectOrigin.live,
        InjectOrigin.live,
      ]);
    });

    test('(S4b-2) Resend, then INJECT_PC_OFFLINE again ⇒ the fact is set again, the next automatic drain is deferred', () async {
      final _Host host = _Host();
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _box(host, store: store);
      await _enqueueFresh(box, 'rs-2');
      await box.drain();
      await box.settle(correlationId: 'rs-2', ok: false, code: 'INJECT_PC_OFFLINE');
      final DateTime first = (await store.findByRequestId('rs-2'))!.deferPromisedAt!;
      await box.drain(userRequestedEntryIds: <String>{'loc_rs-2'});
      expect((await store.findByRequestId('rs-2'))!.deferPromisedAt, isNull);
      await Future<void>.delayed(const Duration(milliseconds: 2));
      await box.settle(correlationId: 'rs-2', ok: false, code: 'INJECT_PC_OFFLINE');
      final DateTime second = (await store.findByRequestId('rs-2'))!.deferPromisedAt!;
      expect(second.isAfter(first), isTrue,
          reason: 'stamped anew by the repeat verdict, not left over');
      await box.drain();
      expect(host.sends.last.origin, InjectOrigin.deferred);
    });

    test('(S4b-3) a Resend whose frame never left keeps the promise', () async {
      final _Host host = _Host();
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _box(host, store: store);
      await _enqueueFresh(box, 'rs-3');
      await box.drain();
      await box.settle(correlationId: 'rs-3', ok: false, code: 'INJECT_PC_OFFLINE');
      final DateTime first = (await store.findByRequestId('rs-3'))!.deferPromisedAt!;
      host.emitSucceeds = false;
      await box.drain(userRequestedEntryIds: <String>{'loc_rs-3'});
      final OutboxItem after = (await store.findByRequestId('rs-3'))!;
      expect(after.lastRefusalNote, 'WIRE_EMIT_FAILED',
          reason: 'fixture: the wire-failure branch ran');
      expect(after.deferPromisedAt, first,
          reason: 'no live send happened, so nothing withdrew the promise');
    });

    test('membership: exactly the codes whose row sentence makes the promise', () {
      expect(kDeferPromiseCodes, <String>{'INJECT_PC_OFFLINE'});
      // The sentence this fact backs must exist for every member; if a member
      // ever loses its note, the fact would be guarding a promise nobody makes.
      for (final String code in kDeferPromiseCodes) {
        for (final AppLocale locale in AppLocale.values) {
          expect(AppStrings.of(locale).deliveryRefusalNote(code), isNotNull,
              reason: '$code / $locale');
        }
      }
    });
  });

  group('(d) 🔴 rows written by 0.3.107 / 0.3.115 — no defer_promised_at column', () {
    late Directory tmp;
    setUpAll(sqfliteFfiInit);
    setUp(() async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      tmp = await Directory.systemTemp.createTemp('flowmic_nr279_');
    });
    tearDown(() async {
      try {
        await tmp.delete(recursive: true);
      } on FileSystemException {
        // Windows may hold a just-closed db file briefly.
      }
    });

    Future<TimelineStorageOpen> open(String path) async =>
        openTimelinePersistence(
          prefs: await SharedPreferences.getInstance(),
          factory: databaseFactoryFfi,
          path: path,
        );

    /// sqflite hands every opener of one path the SAME instance (singleInstance),
    /// so closing it through a raw handle is what makes the next `open` a real
    /// re-open that runs `onOpen` again — otherwise the idempotency case would
    /// be vacuous.
    Future<void> closeShared(String path) async =>
        (await databaseFactoryFfi.openDatabase(path)).close();

    /// [close] false when a store opened by `open` is still in use on the same
    /// shared instance (closing it here would close that store's database).
    Future<bool> hasColumn(String path, {bool close = true}) async {
      final Database raw = await databaseFactoryFfi.openDatabase(path);
      final List<Map<String, Object?>> cols =
          await raw.rawQuery('PRAGMA table_info($kOutboxTable)');
      if (close) await raw.close();
      return cols.any((Map<String, Object?> c) => c['name'] == 'defer_promised_at');
    }

    test('the open adds the column, keeps the old row, the row reads null and keeps the windowed behaviour', () async {
      final String path = '${tmp.path}/old.db';
      // Build the file as an older build left it: today's schema version, but
      // without the new column (the column did not exist before NR-279).
      final TimelineStorageOpen first = await open(path);
      expect(first.kind, TimelineStorageKind.sqlite);
      final Database raw = await databaseFactoryFfi.openDatabase(path);
      await raw.execute('ALTER TABLE $kOutboxTable DROP COLUMN defer_promised_at');
      // An old build's write: its own column list, mid-retry after an
      // INJECT_PC_OFFLINE (the very state the old build did not remember).
      final int now = DateTime.now().toUtc().millisecondsSinceEpoch;
      await raw.rawInsert(
        'INSERT INTO $kOutboxTable (request_id, entry_id, covered_entry_ids, '
        'wire_entry_id, kind, source, text, mode, created_at, enqueued_at, '
        'dest_machine_uid, dest_pairing_identity, enqueued_pc_id, '
        'delivery_state, attempts, last_refusal_note) '
        "VALUES ('old-1', 'loc_old-1', 'loc_old-1', 'loc_old-1', 'text', "
        "'stt', 'hello pc', 'realtime', ?, ?, ?, ?, ?, 'queued', 1, "
        "'INJECT_PC_OFFLINE')",
        <Object?>[now, now, _machine, _pairing, _pcId],
      );
      await raw.close();
      expect(await hasColumn(path), isFalse,
          reason: 'fixture: this must be the pre-NR-279 shape');

      // The new build opens it.
      final TimelineStorageOpen upgraded = await open(path);
      expect(upgraded.kind, TimelineStorageKind.sqlite,
          reason: 'the additive column must not drop the install to the fallback store');
      expect(await hasColumn(path, close: false), isTrue);
      final OutboxItem old = (await upgraded.outbox!.findByRequestId('old-1'))!;
      expect(old.lastRefusalNote, 'INJECT_PC_OFFLINE', reason: 'row untouched');
      expect(old.deferPromisedAt, isNull,
          reason: 'nothing is back-filled: no evidence on disk says the note was shown');

      // Old behaviour for the old row: young ⇒ live, exactly as 0.3.115 did.
      final _Host host = _Host();
      final DeliveryOutbox box = _box(host, store: upgraded.outbox);
      await box.drain();
      expect(host.sends.single.origin, InjectOrigin.live);

      // …and a new verdict on that same old row now records the promise.
      await box.settle(correlationId: 'old-1', ok: false, code: 'INJECT_PC_OFFLINE');
      await box.drain();
      expect(host.sends.last.origin, InjectOrigin.deferred);
      expect((await upgraded.outbox!.findByRequestId('old-1'))!.deferPromisedAt,
          isNotNull, reason: 'the column is written and read back on a real file');
    });

    test('idempotent: opening a file that already has the column is a no-op', () async {
      final String path = '${tmp.path}/twice.db';
      await open(path);
      await closeShared(path);
      final TimelineStorageOpen again = await open(path);
      expect(again.kind, TimelineStorageKind.sqlite,
          reason: 'a duplicate-column error would drop the install to the fallback store');
      expect(await hasColumn(path, close: false), isTrue);
    });
  });
}
