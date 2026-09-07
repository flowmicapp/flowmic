// Card FX-1 — THE DISK FILLS DURING A RECORDING AND THE MANIFEST DENIES IT.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A3-6/7 (a write failure is recorded and announced, never silent),
//     §A3-3 (commit order), §A5-2 (space)
//   apps/mobile/lib/src/audio/retained_audio_manifest_retry.dart
//
// ── WHAT THE DEVICE MEASURED (drill D-5b, 2026-09-06, HA2F8D3H) ─────────────
//
// A 30.7 s press with `/data/user/0` driven to 0 KB at t=4.5 s. On disk
// afterwards: 122,880 B of PCM and a manifest reading
// `"committedClaimBytes":115200, "holes":[], "interruptReason":"none"`.
// 26.5 s of the user's speech never reached the phone and the file asserted
// that nothing was missing.
//
// 🔴 THE FACTS WERE NEVER LOST — PUBLISHING THEM WAS. `appendPcm`'s catch
// already recorded a [JournalHole] and stamped `io_error` on the IN-MEMORY
// manifest. `_commitLocked` then tried to publish it through a temp file, and
// a temp file is exactly what a full disk cannot create. Two consequences, and
// each one is a test below:
//   1. nothing re-armed the commit timer after a FAILED append (`_arm()` sat at
//      the end of the try), so the first ENOSPC ended every further attempt for
//      the rest of the press — even after space came back;
//   2. `close()` released the object with the facts still inside it.
//
// ⚠️ WHY A BUDGETED FAKE DISK AND NOT A FAULT COUNTER. The existing
// `_FaultFs` (retained_audio_journal_test.dart) dies at a chosen operation
// index. ENOSPC is not an operation index — it is a CONDITION that starts at a
// moment, applies to EVERY writer including the manifest's temp file, and then
// LIFTS. Only the third of those three is what makes the retry testable, and a
// counter cannot express it.

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_manifest_retry.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flutter_test/flutter_test.dart';

/// An in-memory filesystem with a byte budget, i.e. a disk that can fill up.
///
/// Every write — PCM append AND manifest temp file — is charged against
/// [freeBytes]. `flushThrows` models the other platform behaviour ENOSPC is
/// allowed to have: the write is accepted and the error surfaces at `flush()`.
class _BudgetFs implements JournalFileSystem {
  final Map<String, List<int>> files = <String, List<int>>{};
  final List<String> log = <String>[];

  /// Bytes still available. Set to 0 to fill the disk mid-recording.
  int freeBytes = 1 << 30;

  /// When true the next `flush()` throws AND the file is truncated to
  /// [truncateFlushTo] — the platform accepted the bytes into a buffer it then
  /// could not write out.
  bool flushThrows = false;
  int truncateFlushTo = 0;

  int _charge(String path, int want) {
    final int can = want <= freeBytes ? want : freeBytes;
    freeBytes -= can;
    return can;
  }

  @override
  Future<void> ensureDirectory(String path) async {}

  @override
  Future<bool> exists(String path) async => files.containsKey(path);

  @override
  Future<int> lengthOf(String path) async => files[path]?.length ?? 0;

  @override
  Future<Uint8List> readBytes(String path) async =>
      Uint8List.fromList(files[path] ?? const <int>[]);

  @override
  Future<Uint8List> readRange(String path, int start, int end) async {
    final List<int> all = files[path] ?? const <int>[];
    if (start >= all.length || end <= start) return Uint8List(0);
    return Uint8List.fromList(
        all.sublist(start, end > all.length ? all.length : end));
  }

  @override
  Future<void> writeBytes(String path, Uint8List bytes,
      {bool flush = true}) async {
    log.add('writeBytes:$path');
    // A whole-file write is all-or-nothing: the temp manifest either fits or
    // the create fails. This is the door the drill's manifest died at.
    if (bytes.length > freeBytes) {
      throw const FileSystemException('ENOSPC: no space left on device');
    }
    freeBytes -= bytes.length;
    if (files[path] != null) freeBytes += files[path]!.length;
    files[path] = List<int>.from(bytes);
  }

  @override
  Future<JournalFileHandle> openAppend(String path) async {
    files.putIfAbsent(path, () => <int>[]);
    return _BudgetHandle(this, path);
  }

  @override
  Future<void> rename(String from, String to) async {
    log.add('rename:$from');
    final List<int>? b = files.remove(from);
    if (b == null) throw FileSystemException('missing $from');
    if (files[to] != null) freeBytes += files[to]!.length;
    files[to] = b;
  }

  @override
  Future<void> deleteFile(String path) async {
    final List<int>? b = files.remove(path);
    if (b != null) freeBytes += b.length;
  }

  @override
  Future<List<String>> listNames(String dirPath) async => const <String>[];
}

class _BudgetHandle implements JournalFileHandle {
  _BudgetHandle(this._fs, this._path);

  final _BudgetFs _fs;
  final String _path;

  @override
  Future<void> append(Uint8List bytes) async {
    _fs.log.add('append');
    final int took = _fs._charge(_path, bytes.length);
    if (took > 0) _fs.files[_path]!.addAll(bytes.sublist(0, took));
    if (took < bytes.length) {
      // ENOSPC caught mid-write: part of the buffer landed, then the platform
      // said no. This is the shape the device produced.
      throw const FileSystemException('ENOSPC: no space left on device');
    }
  }

  @override
  Future<void> flush() async {
    _fs.log.add('flush');
    if (_fs.flushThrows) {
      _fs.flushThrows = false;
      final List<int> f = _fs.files[_path]!;
      if (f.length > _fs.truncateFlushTo) {
        _fs.freeBytes += f.length - _fs.truncateFlushTo;
        _fs.files[_path] = f.sublist(0, _fs.truncateFlushTo);
      }
      throw const FileSystemException('ENOSPC on flush');
    }
  }

  @override
  Future<int> length() async => _fs.files[_path]!.length;

  @override
  Future<void> close() async {}
}

Uint8List pcm(int n) => Uint8List.fromList(List<int>.filled(n, 7));

/// A timer factory that hands the callbacks back instead of scheduling them,
/// so a test can decide when the group-commit tick happens.
class _ManualTimers {
  final List<void Function()> pending = <void Function()>[];

  Timer make(Duration d, void Function() cb) {
    pending.add(cb);
    return Timer(const Duration(days: 1), () {});
  }

  /// Fire every armed callback once. Returns how many fired.
  int fireAll() {
    final List<void Function()> now = List<void Function()>.from(pending);
    pending.clear();
    for (final void Function() cb in now) {
      cb();
    }
    return now.length;
  }
}

RecordingManifest _onDisk(_BudgetFs fs, String id) => RecordingManifest.decode(
    String.fromCharCodes(fs.files['/d/$id${RetainedAudioJournal.manifestSuffix}']!));

void main() {
  group('FX-1 the journal under ENOSPC', () {
    test('a failed append records a hole and stamps io_error in memory', () async {
      final _BudgetFs fs = _BudgetFs()..freeBytes = 1000;
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: '/d',
        recordingId: 'r1',
        fs: fs,
      );
      final List<JournalNotice> heard = <JournalNotice>[];
      j.notices.listen(heard.add);

      expect(await j.appendPcm(pcm(400)), isTrue);
      fs.freeBytes = 100; // the disk fills, mid-recording
      expect(await j.appendPcm(pcm(400)), isFalse);
      await pumpEventQueue();

      expect(j.holes, hasLength(1));
      // 100 of the 400 landed; the hole covers the 300 that did not.
      expect(j.holes.single.length, 300);
      expect(j.holes.single.reason, JournalInterrupt.ioError);
      expect(j.manifest.interruptReason, JournalInterrupt.ioError);
      expect(
        heard.map((JournalNotice n) => n.code),
        contains(JournalNotice.codeAppendFailed),
      );
      await j.close();
    });

    test(
        'REGRESSION D-5b: the commit timer is re-armed by a FAILED append, not '
        'only by a successful one', () async {
      final _BudgetFs fs = _BudgetFs()..freeBytes = 1000;
      final _ManualTimers timers = _ManualTimers();
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: '/d',
        recordingId: 'r1',
        fs: fs,
        timerFactory: timers.make,
      );
      expect(await j.appendPcm(pcm(400)), isTrue);
      expect(timers.pending, hasLength(1), reason: 'success arms it');
      timers.fireAll();
      await pumpEventQueue();

      fs.freeBytes = 0;
      expect(await j.appendPcm(pcm(400)), isFalse);
      await pumpEventQueue();
      // Before this card the failure path returned without arming, so this was
      // 0 and NOTHING would ever try to commit again for the rest of the press.
      expect(timers.pending, isNotEmpty,
          reason: 'a failed append is when the manifest most needs publishing');
      await j.close();
    });

    test('a flush() that fails is a hole too, not just a failed commit',
        () async {
      final _BudgetFs fs = _BudgetFs()..freeBytes = 1 << 20;
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: '/d',
        recordingId: 'r1',
        fs: fs,
      );
      final List<JournalNotice> heard = <JournalNotice>[];
      j.notices.listen(heard.add);
      expect(await j.appendPcm(pcm(400)), isTrue);

      // The platform took the bytes and then could not write 100 of them out.
      fs.flushThrows = true;
      fs.truncateFlushTo = 300;
      await j.commit();
      await pumpEventQueue();

      expect(j.holes, hasLength(1));
      expect(j.holes.single.length, 100);
      expect(j.manifest.interruptReason, JournalInterrupt.ioError);
      expect(
        heard.map((JournalNotice n) => n.code),
        contains(JournalNotice.codeAppendFailed),
        reason: 'the user-facing fact is the same one an append failure raises',
      );
      // And the claim that DID get published is the smaller, true one.
      expect(_onDisk(fs, 'r1').committedClaimBytes, 300);
      await j.close();
    });

    test(
        'REGRESSION D-5b: the manifest that ENOSPC blocked is republished once '
        'space returns, and it carries the holes', () async {
      final ManifestRepublishQueue queue = ManifestRepublishQueue();
      final _BudgetFs fs = _BudgetFs()..freeBytes = 1000;
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: '/d',
        recordingId: 'r1',
        fs: fs,
        republishQueue: queue,
      );
      expect(await j.appendPcm(pcm(400)), isTrue);
      await j.commit();
      expect(_onDisk(fs, 'r1').committedClaimBytes, 400);

      // The disk fills while the finger is still down.
      fs.freeBytes = 0;
      expect(await j.appendPcm(pcm(400)), isFalse);
      await j.commit();

      // THE DEVICE'S READING: the file on disk still denies the hole, because
      // the temp manifest could not be created.
      final RecordingManifest denied = _onDisk(fs, 'r1');
      expect(denied.holes, isEmpty);
      expect(denied.interruptReason, JournalInterrupt.none);
      expect(j.unpublishedManifest, isNotNull);

      // Release, still full: close() cannot publish either.
      await j.close(interruptReason: JournalInterrupt.ioError);
      expect(queue.pendingIds, <String>['r1']);
      expect(_onDisk(fs, 'r1').holes, isEmpty);

      // The filler is removed (this is the drill's own `finally` block).
      fs.freeBytes = 1 << 20;
      expect(await queue.republish(), 1);
      expect(queue.pendingIds, isEmpty);

      final RecordingManifest told = _onDisk(fs, 'r1');
      expect(told.holes, hasLength(1));
      expect(told.holes.single.length, 400);
      expect(told.interruptReason, JournalInterrupt.ioError);
    });

    test('a healthy recording never queues a manifest', () async {
      final ManifestRepublishQueue queue = ManifestRepublishQueue();
      final _BudgetFs fs = _BudgetFs();
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: '/d',
        recordingId: 'r1',
        fs: fs,
        republishQueue: queue,
      );
      expect(await j.appendPcm(pcm(400)), isTrue);
      await j.close();
      expect(queue.pendingIds, isEmpty);
      expect(j.unpublishedManifest, isNull);
      expect(_onDisk(fs, 'r1').holes, isEmpty);
    });

    test('the two path constants have exactly one value each', () {
      // The retry helper cannot import the journal (the journal imports it), so
      // it re-declares the suffixes. Two literals that must agree get a test,
      // not a comment.
      expect(RetainedAudioJournalPaths.manifestSuffix,
          RetainedAudioJournal.manifestSuffix);
      expect(RetainedAudioJournalPaths.manifestTempSuffix,
          RetainedAudioJournal.manifestTempSuffix);
      expect(RetainedAudioJournalPaths.pcmSuffix, RetainedAudioJournal.pcmSuffix);
    });
  });

  // ── R3F-1: HOLE COORDINATES ────────────────────────────────────────────────
  //
  // Drill D-5b (2026-09-06, HA2F8D3H) read 132 holes carrying 2 distinct
  // `start` values, sum 835,584 B. `sum(length)` was the honest number and the
  // product uses it — but anybody who MERGES the ranges (the natural reading of
  // a list of intervals) gets 6,400 B and under-reports the loss by ~130x.
  // Cause: with the disk full nothing lands, so the file length never moves,
  // so every catch minted its hole at the same file offset.
  //
  // A hole's `start` is therefore a position in the CAPTURED STREAM, which
  // advances past bytes that were lost as well as bytes that were kept. The two
  // assertions that discriminate are `union == sum` and `starts are distinct`.
  group('R3F-1 hole ranges are stream coordinates, not file offsets', () {
    int unionOf(List<JournalHole> holes) {
      final List<JournalHole> sorted = List<JournalHole>.from(holes)
        ..sort((JournalHole a, JournalHole b) => a.start.compareTo(b.start));
      int covered = 0;
      int reach = 0;
      for (final JournalHole h in sorted) {
        final int from = h.start > reach ? h.start : reach;
        final int to = h.start + h.length;
        if (to > from) covered += to - from;
        if (to > reach) reach = to;
      }
      return covered;
    }

    test('five consecutive failed appends cover the whole missing range',
        () async {
      final _BudgetFs fs = _BudgetFs()..freeBytes = 400;
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: '/d',
        recordingId: 'r1',
        fs: fs,
        commitInterval: const Duration(days: 1),
      );
      expect(await j.appendPcm(pcm(400)), isTrue); // the disk is now full
      for (int i = 0; i < 5; i++) {
        expect(await j.appendPcm(pcm(100)), isFalse);
      }

      final List<JournalHole> holes = j.holes;
      final int sum =
          holes.fold<int>(0, (int a, JournalHole h) => a + h.length);
      expect(sum, 500, reason: 'five 100-byte chunks were captured and lost');
      // 🔴 THE DISCRIMINATING ASSERTION. Before the fix this was 100: five
      // holes all starting at 400, each one covering the last one.
      expect(unionOf(holes), 500);
      expect(holes.first.start, 400, reason: 'the loss begins where the file ends');
      // Adjacent same-reason holes coalesce, so one continuous gap is one row.
      expect(holes, hasLength(1));
      expect(holes.single.start + holes.single.length, 900);
      await j.close();
    });

    test('a gap, then bytes that land, then a second gap: no overlap', () async {
      final _BudgetFs fs = _BudgetFs()..freeBytes = 0;
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: '/d',
        recordingId: 'r2',
        fs: fs,
        commitInterval: const Duration(days: 1),
      );
      expect(await j.appendPcm(pcm(100)), isFalse); // lost: stream 0..100
      fs.freeBytes = 60;
      expect(await j.appendPcm(pcm(60)), isTrue); // kept: stream 100..160
      expect(await j.appendPcm(pcm(40)), isFalse); // lost: stream 160..200

      final List<JournalHole> holes = j.holes;
      expect(holes.map((JournalHole h) => h.start).toList(), <int>[0, 160]);
      expect(holes.map((JournalHole h) => h.length).toList(), <int>[100, 40]);
      expect(unionOf(holes), 140);
      // The kept bytes are NOT inside any hole — the coordinate has to make
      // room for them, which a file offset would not have done.
      expect(j.observedBytes, 60);
      await j.close();
    });

    test('a resumed manifest continues past the holes it already carries',
        () async {
      final _BudgetFs fs = _BudgetFs()..freeBytes = 0;
      final RetainedAudioJournal first = await RetainedAudioJournal.open(
        dirPath: '/d',
        recordingId: 'r3',
        fs: fs,
        commitInterval: const Duration(days: 1),
      );
      expect(await first.appendPcm(pcm(100)), isFalse);
      fs.freeBytes = 1 << 20;
      await first.commit();
      await first.close();

      final RetainedAudioJournal again = await RetainedAudioJournal.open(
        dirPath: '/d',
        recordingId: 'r3',
        fs: fs,
        commitInterval: const Duration(days: 1),
      );
      expect(again.holes, hasLength(1));
      fs.freeBytes = 0;
      expect(await again.appendPcm(pcm(50)), isFalse);
      // Two separate losses with no bytes between them still coalesce, but the
      // second one must not be filed back at stream 0.
      expect(unionOf(again.holes), 150);
      expect(again.holes.last.start + again.holes.last.length, 150);
      await again.close();
    });
  });

  group('FX-1 the spill tells the two refusals apart', () {
    late Directory tmp;

    setUp(() async {
      tmp = await Directory.systemTemp.createTemp('flowmic-enospc-');
    });
    tearDown(() async {
      if (await tmp.exists()) await tmp.delete(recursive: true);
    });

    test(
        'our own ceiling says cap-reached; the disk saying no says '
        'write-failed', () async {
      // (a) the cap. Nothing is wrong with the disk — we decided to stop.
      final RetainedAudioStore capped =
          RetainedAudioStore(dir: tmp, capBytes: 300, clock: () => 0);
      final _BudgetFs okFs = _BudgetFs();
      final RetainedAudioSpill capSpill = RetainedAudioSpill(
        store: capped,
        retainFromFirstFrame: true,
        journalDirPath: '/d',
        journalFs: okFs,
      );
      await capSpill.beginRecording();
      capSpill.appendCaptured(pcm(200));
      capSpill.appendCaptured(pcm(200));
      await capSpill.journalFlush();
      expect(capped.lastNotice.value?.code, RetainedAudioNotice.codeCapReached);
      await capSpill.endRecording();

      // (b) the disk. The ceiling is nowhere near; the platform refused.
      final RetainedAudioStore roomy =
          RetainedAudioStore(dir: tmp, capBytes: 1 << 20, clock: () => 0);
      final _BudgetFs fullFs = _BudgetFs()..freeBytes = 200;
      final RetainedAudioSpill diskSpill = RetainedAudioSpill(
        store: roomy,
        retainFromFirstFrame: true,
        journalDirPath: '/d',
        journalFs: fullFs,
      );
      await diskSpill.beginRecording();
      diskSpill.appendCaptured(pcm(200));
      diskSpill.appendCaptured(pcm(200));
      await diskSpill.journalFlush();
      await pumpEventQueue();
      expect(roomy.lastNotice.value?.code, RetainedAudioNotice.codeWriteFailed);

      // The two codes are what routes the two sentences; they must not be one.
      expect(RetainedAudioNotice.codeCapReached,
          isNot(RetainedAudioNotice.codeWriteFailed));
      await diskSpill.endRecording();
    });

    test('the spill retries the blocked manifest at the next recording',
        () async {
      final RetainedAudioStore store =
          RetainedAudioStore(dir: tmp, capBytes: 1 << 20, clock: () => 0);
      final _BudgetFs fs = _BudgetFs()..freeBytes = 3000;
      final RetainedAudioSpill spill = RetainedAudioSpill(
        store: store,
        retainFromFirstFrame: true,
        journalDirPath: '/d',
        journalFs: fs,
      );
      await spill.beginRecording();
      final String r1 = spill.currentRecordingId!;
      spill.appendCaptured(pcm(400));
      await spill.journalFlush();
      expect(_onDisk(fs, r1).committedClaimBytes, 400,
          reason: 'the healthy commit must land, or the test proves nothing');
      fs.freeBytes = 0;
      spill.appendCaptured(pcm(400));
      await spill.journalFlush();
      await spill.endRecording(interruptReason: JournalInterrupt.ioError);
      await pumpEventQueue();

      expect(spill.unpublishedManifestIds, <String>[r1]);
      expect(_onDisk(fs, r1).holes, isEmpty, reason: 'still full');

      fs.freeBytes = 1 << 20;
      await spill.beginRecording();
      await pumpEventQueue();
      expect(spill.unpublishedManifestIds, isEmpty);
      expect(_onDisk(fs, r1).holes, isNotEmpty);
      expect(_onDisk(fs, r1).interruptReason, JournalInterrupt.ioError);
      await spill.endRecording();
    });
  });
}
