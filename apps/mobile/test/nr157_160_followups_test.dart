// NR-157..NR-160 — THE FOUR FOLLOW-UPS OF THE NR-137 ROUND-10 FINAL REVIEW,
// AND THE SCAN THAT THREW OUT OF AN UNAWAITED SWEEP.
//
// SPEC-REF:
//   _dispatch/2026-10-02-nr137-r10-review.md §6 (F-1..F-4)
//   _dispatch/nr137-r10-final-review_test.dart (the reviewer's repros; R10F-4
//     and R10F-6 are carried here, adapted)
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md
//     (NR-157..NR-160)
//
// Real chain (`Rc3Rig` / `LegacyRig` → `PendingRecoveryStore.retryNow`) over
// the shipped opener's backends. Seams only: the journal file system's
// write/rename hooks the rigs expose, and `IOOverrides` around one press.
//
//   F-1 (NR-157)  a legacy seal's segment delete held past the 500 ms hold.
//                 Status and audio must agree: freed ⇔ `done`, kept ⇔
//                 `failed` (lib: backfill_legacy_kept.dart).
//   F-2 (NR-158)  a journal seal commit that lands after the hold, the process
//                 dying before the put-back: the file on disk at that instant
//                 must not license the boot sweep (lib: recovery_leg_rows.dart
//                 `_sealRelease`).
//   F-3 (NR-159)  one 400 ms writer started during the final proof: the
//                 release waits for it and proves again (lib:
//                 timeline_write_gate.dart).
//   F-4 (NR-160)  the legacy withdrawal record's write fails: a later release
//                 still re-proves the withdrawn rows (lib:
//                 retained_audio_withdrawn.dart).
//   SCAN          a PCM deleted between `exists` and `lengthOf` is absent,
//                 not an error (lib: retained_audio_journal_scan.dart).
//
// REVERSE CONTROL (2026-10-05, this file, lane/nr157-160): each fix reverted
// alone, the named cases go red — see _dispatch/2026-10-05-nr157-160.report.md.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/crypto/blind_store_keyring.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_state.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_sync.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_payload.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_verified_reads.dart';
import 'package:flowmic/src/timeline/timeline_write_gate.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'support/di.dart';
import 'support/legacy_backfill_rig.dart';
import 'support/memory_journal_fs.dart';
import 'support/nr137_rig.dart';
import 'support/rc3_rig.dart';

class _NoSqliteFactory implements DatabaseFactory {
  @override
  Future<Database> openDatabase(String path, {OpenDatabaseOptions? options}) =>
      Future<Database>.error(StateError('SQLite will not open this session'));
  @override
  Future<bool> databaseExists(String path) =>
      databaseFactoryFfi.databaseExists(path);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

enum _B { fallback, sqlite }

Future<TimelinePersistence> _backend(_B b, SharedPreferences prefs) async {
  final Directory dir = await Directory.systemTemp.createTemp('nr157-');
  addTearDown(() async {
    try {
      await dir.delete(recursive: true);
    } on Object {/* best effort */}
  });
  final TimelineStorageOpen open = await openTimelinePersistence(
      prefs: prefs,
      factory: b == _B.sqlite ? databaseFactoryFfi : _NoSqliteFactory(),
      path: '${dir.path}/timeline.db');
  if (open.persistence is SqfliteTimelinePersistence) {
    addTearDown((open.persistence as SqfliteTimelinePersistence).close);
  }
  return open.persistence;
}

/// Counts census reads; runs [censusHook] at read number [hookCensusAt];
/// remembers every row written.
class _Slot extends Nr137BackendSlot {
  _Slot(super.current);
  int census = 0;
  int? hookCensusAt;
  void Function()? censusHook;
  final List<TimelineEntry> written = <TimelineEntry>[];

  @override
  Future<TimelineInventory> loadInventory() async {
    if (++census == hookCensusAt) censusHook?.call();
    return super.loadInventory();
  }

  @override
  Future<void> upsert(TimelineEntry row) async {
    await super.upsert(row);
    written.add(row);
  }
}

/// Refuses the write of every row whose text is [refusedText]; remembers them.
class _RefuseText extends Nr137BackendSlot {
  _RefuseText(super.current, this.refusedText);
  final String refusedText;
  final List<TimelineEntry> refused = <TimelineEntry>[];
  @override
  Future<void> upsert(TimelineEntry row) async {
    if (row.displayText == refusedText) {
      refused.add(row);
      throw StateError('row write refused');
    }
    await super.upsert(row);
  }
}

bool _tempIn(String path, List<int> bytes, String state) =>
    path.endsWith(RetainedAudioJournal.manifestTempSuffix) &&
    RecordingManifest.decode(String.fromCharCodes(bytes)).recoveryState == state;

List<String> _trail(String needle) => DiagLog.instance
    .snapshot()
    .where((String l) => l.contains(needle))
    .toList();

/// The census read that is the final proof's: the last one before the seal's
/// settled manifest is written (an undisturbed calibration press).
Future<int> _finalCensus(_B b) async {
  final _Slot slot = _Slot(await _backend(b, await nr137EmptyPrefs()));
  final Rc3Rig r = await nr137Article(slot);
  slot.census = 0;
  int? c;
  r.fs.onWrite = (String path, Uint8List bytes) {
    if (c == null && _tempIn(path, bytes, RecoveryQueueState.settled)) {
      c = slot.census;
    }
  };
  expect(await nr137Press(r), PendingRetryOutcome.done,
      reason: 'calibration: an undisturbed press releases');
  expect(c, isNotNull, reason: 'calibration: the seal was written');
  return c!;
}

// ── F-1: one native segment delete held until resumed (reviewer's seam) ────
base class _SlowDeleteIo extends IOOverrides {
  _SlowDeleteIo(this.target, {this.fail = false});
  final String target;
  final bool fail;
  final Completer<void> entered = Completer<void>();
  final Completer<void> resume = Completer<void>();
  @override
  File createFile(String path) {
    final File native = super.createFile(path);
    return path.replaceAll('\\', '/') == target.replaceAll('\\', '/')
        ? _SlowDeleteFile(native, this)
        : native;
  }
}

class _SlowDeleteFile implements File {
  _SlowDeleteFile(this.native, this.owner);
  final File native;
  final _SlowDeleteIo owner;
  @override
  String get path => native.path;
  @override
  Future<bool> exists() => native.exists();
  @override
  Future<int> length() => native.length();
  @override
  Future<Uint8List> readAsBytes() => native.readAsBytes();
  @override
  Future<FileSystemEntity> delete({bool recursive = false}) async {
    if (!owner.entered.isCompleted) owner.entered.complete();
    await owner.resume.future;
    if (owner.fail) {
      throw FileSystemException('held delete refused', path);
    }
    return native.delete(recursive: recursive);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

// ── F-4: the withdrawal record's temp write fails ──────────────────────────
base class _FailWriteIo extends IOOverrides {
  _FailWriteIo(this.target);
  final String target;
  int refused = 0;
  @override
  File createFile(String path) {
    final File native = super.createFile(path);
    return path.replaceAll('\\', '/') == target.replaceAll('\\', '/')
        ? _FailWriteFile(native, this)
        : native;
  }
}

class _FailWriteFile implements File {
  _FailWriteFile(this.native, this.owner);
  final File native;
  final _FailWriteIo owner;
  @override
  String get path => native.path;
  @override
  Future<bool> exists() => native.exists();
  @override
  Future<FileSystemEntity> delete({bool recursive = false}) =>
      native.delete(recursive: recursive);
  @override
  Future<File> writeAsString(String contents,
      {FileMode mode = FileMode.write,
      Encoding encoding = systemEncoding,
      bool flush = false}) async {
    owner.refused++;
    throw FileSystemException('no space left on device', path);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// A PCM deleted between the scan's `exists` and its `lengthOf` (a live
/// settle's delete, or a teardown, running beside the scan).
class _VanishingPcmFs extends MemoryJournalFs {
  bool armed = false;
  int vanished = 0;
  @override
  Future<int> lengthOf(String path) async {
    if (armed &&
        path.endsWith(RetainedAudioJournal.pcmSuffix) &&
        await exists(path)) {
      vanished++;
      await deleteFile(path);
    }
    return super.lengthOf(path);
  }
}

/// The shipped pull and merge bring back a copy of the row [slot] refused
/// first, stating another article; its local write is refused too, so the
/// merge keeps it waiting as a retry (nr137_release_window_test.dart).
Future<void> _copyOfWithdrawnWaits(_RefuseText slot, TimelineStore store,
    SharedPreferences prefs, String account) async {
  final TimelineEntry cloud = TimelineEntry.fromJson(
      Map<String, Object?>.from(slot.refused.first.toJson())
        ..['client_id'] = 'cloud-copy'
        ..['article_id'] = 'another-article')!;
  final BlindStoreKeyring keyring = await nr137Keyring();
  final Nr137CloudRelay relay = Nr137CloudRelay(<Map<String, Object?>>[
    nr137Blob(cloud,
        keyring.seal(entryId: cloud.id, plaintext: encodeBlindStorePayload(cloud))!,
        seq: 1, schemaVer: kBlindStoreBlobSchemaVer),
  ]);
  addTearDown(relay.close);
  final SharedPrefsBlindStoreCursorStore cursor =
      SharedPrefsBlindStoreCursorStore(prefs);
  await BlindStoreCloudSync(
          keyring: keyring,
          client: BlindStoreCloudClient(transport: relay),
          state: InMemoryBlindStoreCloudStateStore(),
          bridge: BlindStoreTimelineBridge(
              persistence: slot,
              store: store,
              reaper: newTestReaper(persistence: slot),
              reload: store.load),
          cursor: cursor,
          isCloudRelay: () => true,
          accountKey: () => account,
          keymetaConfirmed: () async => true)
      .syncNow();
  expect(await cursor.loadRetries(account), hasLength(1),
      reason: 'control: the copy waits as a retry');
}

String _items(List<PendingRecoveryItem> items) => items
    .map((PendingRecoveryItem i) => '${i.state.name}'
        ' awaiting=${i.awaitingTranscription}'
        ' actions=${i.actions.map((PendingRecoveryAction a) => a.name).toList()}'
        ' retranscribable=${i.retranscribable}')
    .join(' | ');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  for (final _B b in _B.values) {
    for (final bool fail in <bool>[false, true]) {
      // = the round-10 reviewer's R10F-6, in the NR-158 review's
      // 「status and audio agree」 form (R10F-6-AGREE,
      // `_dispatch/nr157-review-probes_test.dart`): same seams, same controls.
      test('F-1 NR-157 / R10F-6-AGREE ${b.name} heldDelete${fail ? 'Fails' : 'Lands'}: '
          'a legacy seal past its hold — status and audio agree', () async {
        final SharedPreferences prefs = await nr137EmptyPrefs();
        final _Slot slot = _Slot(await _backend(b, prefs));
        final LegacyRig r = await LegacyRig.open(persistence: slot);
        addTearDown(r.dispose);
        final String session = 'nr157-f1-${fail ? 'fails' : 'lands'}';
        await r.seed(session);
        await r.store.markUnverified(0, session: session);
        r.relay.replyWords('Whole supported legacy answer');
        final _SlowDeleteIo io = _SlowDeleteIo(
            '${r.tmp.path}${Platform.pathSeparator}${session}__seg-0.pcm',
            fail: fail);
        addTearDown(() {
          if (!io.resume.isCompleted) io.resume.complete();
        });
        DiagLog.instance.clear();
        final entry = (await r.pending.list()).single;
        bool pressEnded = false;
        final Future<PendingRetryOutcome> press = IOOverrides.runWithIOOverrides(
            () => r.pending.retryNow(entry), io);
        unawaited(press.whenComplete(() => pressEnded = true));
        await io.entered.future.timeout(const Duration(seconds: 15));
        final TimelineEntry folded = slot.written.firstWhere((TimelineEntry e) =>
            e.retranscribedFrom == null &&
            e.displayText == 'Whole supported legacy answer');
        await Future<void>.delayed(const Duration(milliseconds: 650));
        final bool sealTimedOut =
            _trail('timeline.release_aborted phase=seal reason=timeout').isNotEmpty;
        // The reviewer's writer: the shipped cloud sync merges the folded row
        // back while the hold is over and the delete still in flight.
        final BlindStoreKeyring keyring = await nr137Keyring();
        final BlindStoreCloudSync sync = BlindStoreCloudSync(
            keyring: keyring,
            client: BlindStoreCloudClient(
                transport: Nr137CloudRelay(<Map<String, Object?>>[
              nr137Blob(
                  folded,
                  keyring.seal(
                      entryId: folded.id,
                      plaintext: encodeBlindStorePayload(folded))!,
                  seq: 1,
                  schemaVer: kBlindStoreBlobSchemaVer)
            ])),
            state: InMemoryBlindStoreCloudStateStore(),
            bridge: BlindStoreTimelineBridge(
                persistence: slot,
                store: r.timeline,
                reaper: newTestReaper(persistence: slot),
                reload: r.timeline.load),
            cursor: SharedPrefsBlindStoreCursorStore(prefs),
            isCloudRelay: () => true,
            accountKey: () => 'nr157-f1-account',
            keymetaConfirmed: () async => true);
        final report = await sync.syncNow().timeout(const Duration(seconds: 5));
        final bool endedBeforeDelete = pressEnded;
        final int bytesBefore = await r.store.bytesForSession(session);
        io.resume.complete();
        final PendingRetryOutcome out = await press;
        await r.idle();
        final int bytesAfter = await r.store.bytesForSession(session);
        final List<PendingRecoveryItem> after = await r.pending.list();
        final bool noteKept = r.timeline.entries
            .any((TimelineEntry e) => e.retranscribedFrom != null);

        // ignore: avoid_print
        print('NR157 F-1 ${b.name} fail=$fail: sealTimedOut=$sealTimedOut '
            'merged=${report.merged} endedBeforeDelete=$endedBeforeDelete '
            'outcome=$out bytesBefore=$bytesBefore bytesAfter=$bytesAfter '
            'noteKept=$noteKept listAfter=[${_items(after)}] '
            'late=${_trail('kept_words_release_late')}');
        expect(sealTimedOut, isTrue, reason: 'control: the hold was abandoned');
        expect(report.merged, 1, reason: 'control: the folded row came back');
        expect(bytesBefore, 6400, reason: 'control: the delete was still held');
        expect(endedBeforeDelete, isFalse,
            reason: 'the press reports only once the issued delete has ended');
        // 🔴 The card's criterion: never a mismatch.
        expect(out == PendingRetryOutcome.done, bytesAfter == 0,
            reason: 'freed ⇔ done, kept ⇔ failed');
        expect(after.isEmpty, bytesAfter == 0,
            reason: 'the list offers the recording again exactly when its '
                'audio is still there');
        expect(noteKept, isTrue, reason: 'the note holds the words either way');
        if (fail) {
          expect(out, PendingRetryOutcome.failed);
          expect(bytesAfter, 6400);
        } else {
          expect(out, PendingRetryOutcome.done);
          expect(bytesAfter, 0);
          expect(_trail('audio.recovery.kept_words_release_late'), isNotEmpty);
        }
      });
    }

    test('F-2 NR-158 ${b.name}: a seal commit landing after the hold leaves no '
        'sweep license on disk before the put-back', () async {
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final Nr137BackendSlot slot = Nr137BackendSlot(await _backend(b, prefs));
      final Rc3Rig r = await nr137Article(slot);
      final TimelineEntry old = r.rows.first;
      final bool markedBefore = (await r.manifest())!.settled;
      final Completer<void> unstick = Completer<void>();
      addTearDown(() {
        if (!unstick.isCompleted) unstick.complete();
      });
      final SharedPrefsBlindStoreCursorStore cursor =
          SharedPrefsBlindStoreCursorStore(prefs);
      Future<void>? write;
      bool sealStarted = false;
      Future<Uint8List>? atDeath;
      r.fs.onWrite = (String path, Uint8List bytes) {
        if (!sealStarted && _tempIn(path, bytes, RecoveryQueueState.settled)) {
          sealStarted = true;
          // A cloud merge saving a pulled copy of a replaced member: it waits
          // for the hold, then lands while the seal's commit is still held.
          write = cursor.saveRetry('nr157-f2', BlindStoreRemoteBlob(
              id: old.id, seq: 1, ciphertext: 'opaque-envelope', createdAtMs: 0,
              schemaVer: kBlindStoreBlobSchemaVer + 1, deleted: false));
          return;
        }
        if (unstick.isCompleted && atDeath == null &&
            _tempIn(path, bytes, RecoveryQueueState.settledUnverified)) {
          // The put-back is being written: a death now leaves THIS on disk.
          final String manifest = r.fs.paths.firstWhere(
              (String p) => p.endsWith(RetainedAudioJournal.manifestSuffix));
          atDeath = r.fs.readBytes(manifest);
        }
      };
      r.fs.onRename = (String from, String to) async {
        if (sealStarted && !unstick.isCompleted &&
            from.endsWith(RetainedAudioJournal.manifestTempSuffix)) {
          await unstick.future;
        }
      };
      DiagLog.instance.clear();
      final Future<PendingRetryOutcome> press = nr137Press(r);
      await Future.doWhile(() async {
        await Future<void>.delayed(const Duration(milliseconds: 10));
        return write == null;
      }).timeout(const Duration(seconds: 20));
      await write!.timeout(const Duration(seconds: 3));
      unstick.complete();
      final PendingRetryOutcome out =
          await press.timeout(const Duration(seconds: 20));
      expect(atDeath, isNotNull, reason: 'control: the put-back was written');
      final RecordingManifest dead =
          RecordingManifest.decode(String.fromCharCodes(await atDeath!));
      final RecordingManifest m = (await r.manifest())!;

      // Next boot from that instant: the same files on a real disk, the
      // shipped store's sweep, the clock past the TTL.
      final Directory dir = await Directory.systemTemp.createTemp('nr157-f2-');
      addTearDown(() async {
        try {
          await dir.delete(recursive: true);
        } on Object {/* best effort */}
      });
      for (final String p in r.fs.paths.toList()) {
        final String name = p.replaceAll('\\', '/').split('/').last;
        final bool manifest = name.endsWith(RetainedAudioJournal.manifestSuffix);
        await File('${dir.path}${Platform.pathSeparator}$name')
            .writeAsBytes(manifest ? await atDeath! : await r.fs.readBytes(p));
      }
      final File pcm = File('${dir.path}${Platform.pathSeparator}'
          '${dead.recordingId}${RetainedAudioJournal.pcmSuffix}');
      final bool pcmBefore = await pcm.exists();
      final RetainedAudioStore store = RetainedAudioStore(
          dir: dir,
          ttl: RetainedAudioStore.kDefaultTtl,
          clock: () => DateTime.now()
              .add(RetainedAudioStore.kDefaultTtl + const Duration(minutes: 1))
              .millisecondsSinceEpoch);
      await store.open();
      await store.sweep();
      final bool pcmAfter = await pcm.exists();
      await store.dispose();

      // ignore: avoid_print
      print('NR158 F-2 ${b.name}: outcome=$out atDeath=${dead.recoveryState}/'
          'mark=${dead.settled} (before=$markedBefore) final=${m.recoveryState}/'
          'mark=${m.settled} pcmBeforeSweep=$pcmBefore pcmAfterSweep=$pcmAfter '
          'aborted=${_trail('release_aborted')}');
      expect(_trail('timeline.release_aborted phase=seal reason=timeout'),
          isNotEmpty, reason: 'control: the seal outlived its hold');
      expect(dead.recoveryState, RecoveryQueueState.settled,
          reason: 'control: the late seal commit was on disk');
      expect(out, PendingRetryOutcome.failed);
      expect(m.recoveryState, RecoveryQueueState.settledUnverified);
      expect(m.settled, markedBefore);
      expect(r.pcmPresent, isTrue);
      expect(pcmBefore, isTrue);
      expect(dead.settled, markedBefore,
          reason: 'a seal the gate did not confirm carries no cleanup mark');
      expect(pcmAfter, isTrue,
          reason: 'the boot sweep must not delete under a stale proof');
    });

    // = the NR-158 review's PROBE-C (`_dispatch/nr157-review-probes_test.dart`),
    // with assertions. A death between the gated seal commit and the mark
    // commit (an OS kill, a flat battery — no injected fault) leaves `settled`
    // without the mark on disk.
    test('F-2b NR-158 / PROBE-C ${b.name}: death between the seal commit and '
        'the mark commit — next launch: kept, honest row, no duplicate words',
        () async {
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final _Slot slot = _Slot(await _backend(b, prefs));
      final Rc3Rig r = await nr137Article(slot);
      String? manifestPath;
      String? pcmPath;
      Future<Uint8List>? manifestAtDeath;
      Future<Uint8List>? pcmAtDeath;
      r.fs.onWrite = (String path, Uint8List bytes) {
        if (manifestAtDeath != null ||
            !path.endsWith(RetainedAudioJournal.manifestTempSuffix)) {
          return;
        }
        final RecordingManifest next =
            RecordingManifest.decode(String.fromCharCodes(bytes));
        if (next.recoveryState == RecoveryQueueState.settled && next.settled) {
          // The mark commit's temp file is being written: a death now leaves
          // the previous commit (the gated seal) as the manifest on disk.
          manifestPath = r.fs.paths.firstWhere(
              (String p) => p.endsWith(RetainedAudioJournal.manifestSuffix));
          pcmPath = r.fs.paths
              .firstWhere((String p) => p.endsWith(RetainedAudioJournal.pcmSuffix));
          manifestAtDeath = r.fs.readBytes(manifestPath!);
          pcmAtDeath = r.fs.readBytes(pcmPath!);
        }
      };
      DiagLog.instance.clear();
      final PendingRetryOutcome out = await nr137Press(r);
      r.fs.onWrite = null;
      expect(out, PendingRetryOutcome.done, reason: 'control: a normal press');
      expect(manifestAtDeath, isNotNull, reason: 'control: the mark commit ran');
      final RecordingManifest dead =
          RecordingManifest.decode(String.fromCharCodes(await manifestAtDeath!));
      final List<String> rowsAfterPress =
          r.rows.map((TimelineEntry e) => e.displayText).toList();

      // Next boot, part 1: the shipped boot sweep, clock past the TTL.
      final Directory dir = await Directory.systemTemp.createTemp('nr158-c-');
      addTearDown(() async {
        try {
          await dir.delete(recursive: true);
        } on Object {/* best effort */}
      });
      final String mName = manifestPath!.replaceAll('\\', '/').split('/').last;
      final String pName = pcmPath!.replaceAll('\\', '/').split('/').last;
      await File('${dir.path}${Platform.pathSeparator}$mName')
          .writeAsBytes(await manifestAtDeath!);
      await File('${dir.path}${Platform.pathSeparator}$pName')
          .writeAsBytes(await pcmAtDeath!);
      final RetainedAudioStore store = RetainedAudioStore(
          dir: dir,
          ttl: RetainedAudioStore.kDefaultTtl,
          clock: () => DateTime.now()
              .add(RetainedAudioStore.kDefaultTtl + const Duration(days: 30))
              .millisecondsSinceEpoch);
      await store.open();
      await store.sweep();
      final bool pcmAfterSweep =
          await File('${dir.path}${Platform.pathSeparator}$pName').exists();
      await store.dispose();

      // Next boot, part 2: the same files back, the shipped list, the press.
      await r.fs.writeBytes(manifestPath!, await manifestAtDeath!);
      await r.fs.writeBytes(pcmPath!, await pcmAtDeath!);
      final PendingRecoveryStore pending = PendingRecoveryStore(
          runner: r.controller.backfill, sourceLang: () => 'zh');
      final List<PendingRecoveryItem> listed = await pending.list();
      final int startsBefore = r.relay.recoveryStarts.length;
      PendingRetryOutcome? retry;
      if (listed.isNotEmpty &&
          listed.single.actions.contains(PendingRecoveryAction.retryNow)) {
        retry = await pending.retryNow(listed.single);
        await r.recoveries(startsBefore + 1, max: const Duration(seconds: 20));
      }
      final List<String> rowsEnd =
          r.rows.map((TimelineEntry e) => e.displayText).toList();
      final List<PendingRecoveryItem> listedEnd = await pending.list();

      // ignore: avoid_print
      print('NR158 F-2b ${b.name}: atDeath=${dead.recoveryState}/mark=${dead.settled} '
          'pcmAfterSweep=$pcmAfterSweep listed=[${_items(listed)}] retry=$retry '
          'recoveryStarts=$startsBefore->${r.relay.recoveryStarts.length} '
          'rowsAfterPress=$rowsAfterPress rowsEnd=$rowsEnd '
          'pcmEnd=${r.pcmPresent} listedEnd=[${_items(listedEnd)}]');
      expect(dead.recoveryState, RecoveryQueueState.settled,
          reason: 'control: the gated seal commit is what is on disk');
      expect(dead.settled, isFalse, reason: 'control: no mark yet');
      expect(pcmAfterSweep, isTrue,
          reason: 'an unconfirmed release is never swept');
      // 🔴 The finding: not 「waiting to be transcribed」.
      expect(listed, hasLength(1), reason: 'the kept audio is offered');
      expect(listed.single.state, PendingRecoveryState.settledUnverified,
          reason: 'what the put-back would have written: kept, not confirmed');
      expect(listed.single.awaitingTranscription, isFalse,
          reason: 'its words are in the timeline already');
      // 🔴 Whatever is offered never duplicates the words.
      for (final String t in rowsEnd.toSet()) {
        expect(rowsEnd.where((String x) => x == t), hasLength(1),
            reason: 'no words twice: $rowsEnd');
      }
      if (retry != null) {
        expect(retry == PendingRetryOutcome.done, !r.pcmPresent,
            reason: 'the press status and the audio agree');
        expect(listedEnd.isEmpty, !r.pcmPresent);
      }
    });

    test('F-3 NR-159 ${b.name}: a 400 ms writer started during the final '
        'proof — the release waits for it, proves again, releases', () async {
      final int last = await _finalCensus(b);
      final _Slot slot = _Slot(await _backend(b, await nr137EmptyPrefs()));
      final Rc3Rig r = await nr137Article(slot);
      slot.census = 0;
      slot.hookCensusAt = last;
      Future<void>? slowWrite;
      slot.censusHook = () {
        slowWrite = TimelineWriteGate.timeline.run(
            () => Future<void>.delayed(const Duration(milliseconds: 400)));
      };
      DiagLog.instance.clear();
      final Stopwatch took = Stopwatch()..start();
      final PendingRetryOutcome out = await nr137Press(r);
      final int ms = took.elapsedMilliseconds;
      await slowWrite;
      final RecordingManifest m = (await r.manifest())!;
      // ignore: avoid_print
      print('NR159 F-3 ${b.name}: finalCensus=$last hooked=${slowWrite != null} '
          'outcome=$out pressMs=$ms audioPresent=${r.pcmPresent} '
          'state=${m.recoveryState} aborted=${_trail('release_aborted')}');
      expect(slowWrite, isNotNull, reason: 'control: the writer started');
      expect(out, PendingRetryOutcome.done,
          reason: 'one slow writer is waited out, not counted as three tries');
      expect(r.pcmPresent, isFalse);
      expect(m.recoveryState, RecoveryQueueState.settled);
      expect(_trail('release_aborted'), isEmpty);
    });

    for (final bool copyWaits in <bool>[true, false]) {
      test('F-4 NR-160 ${b.name} copyWaits=$copyWaits: a withdrawal record '
          'that did not reach disk is still re-proven', () async {
        const String first = 'First answer that never lands.';
        final SharedPreferences prefs = await nr137EmptyPrefs();
        final _RefuseText slot = _RefuseText(await _backend(b, prefs), first);
        final LegacyRig r = await LegacyRig.open(persistence: slot);
        addTearDown(r.dispose);
        final String session = 'nr160-f4-${copyWaits ? 'copy' : 'plain'}';
        await r.seed(session);
        await r.store.markUnverified(0, session: session);
        r.relay.replyWords(first);
        final String record =
            '${r.tmp.path}${Platform.pathSeparator}${session}__withdrawn-rows.json';
        final _FailWriteIo io = _FailWriteIo('$record.tmp');
        DiagLog.instance.clear();
        final entry = (await r.pending.list()).single;
        PendingRetryOutcome out = await IOOverrides.runWithIOOverrides(
            () => r.pending.retryNow(entry), io);
        await r.idle();
        expect(out, PendingRetryOutcome.failed,
            reason: 'control: the first answer could not be stored');
        expect(slot.refused, isNotEmpty);
        expect(io.refused, greaterThan(0), reason: 'control: the write failed');
        expect(File(record).existsSync(), isFalse,
            reason: 'control: no record on disk after press 1');
        if (copyWaits) {
          await _copyOfWithdrawnWaits(slot, r.timeline, prefs, 'nr160-f4');
        }
        r.relay.replyWords('Second answer.');
        out = await r.pending.retryNow((await r.pending.list()).single);
        await r.idle();
        final int bytes = await r.store.bytesForSession(session);

        // ignore: avoid_print
        print('NR160 F-4 ${b.name} copyWaits=$copyWaits: outcome=$out '
            'audioBytes=$bytes writeFailed=${_trail('withdrawn_rows_write_failed').length}');
        if (copyWaits) {
          expect(out, PendingRetryOutcome.failed,
              reason: 'the withdrawn row may come back: the release is not proven');
          expect(bytes, 6400);
        } else {
          // Positive control: the remembered ids do not hold the session
          // forever — written on the next read, proven gone, released.
          expect(out, PendingRetryOutcome.done);
          expect(bytes, 0);
        }
      });
    }
  }

  test('SCAN: a PCM deleted between exists and lengthOf is absent, not an error',
      () async {
    final _VanishingPcmFs fs = _VanishingPcmFs();
    const String dir = '/nr157-scan';
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: dir,
        recordingId: 'run-1757000000000000-r1757000000000',
        fs: fs,
        commitInterval: const Duration(days: 1));
    await j.appendPcm(Uint8List(3200));
    await j.close();
    fs.armed = true;
    final List<RecordingScan> scans =
        await RetainedAudioJournalScan.scan(dirPath: dir, fs: fs);
    // ignore: avoid_print
    print('SCAN: vanished=${fs.vanished} scans=${scans.length} '
        'observed=${scans.map((RecordingScan s) => s.observedLength).toList()}');
    expect(fs.vanished, 1, reason: 'control: the PCM went mid-scan');
    expect(scans, hasLength(1));
    expect(scans.single.observedLength, 0);
  });
}
