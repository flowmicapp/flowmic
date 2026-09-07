// RetainedAudioSpill.dispose() — WHAT IT PROMISES WHEN IT RETURNS.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A3-3 (commit order), §A3-6/7 (a write failure is recorded), card FX-1
//
// ── THE MEASUREMENT THAT PUT THIS FILE HERE ─────────────────────────────────
//
// 2026-09-07, dev-pc-a, gate 0 of the 0.3.75 relay deploy:
// `live_settle_test.dart` failed in tearDown with
//   PathAccessException: Deletion failed, path = '…\flowmic-ls1b-…'
//   (OS Error: another program is using this file, errno = 32)
// on a different test each run — 7 of 8 oversubscribed runs of that one file
// reproduced it. The rig had awaited everything it could reach; the handle
// belonged to the spill, which nothing disposed and whose `dispose()` would
// not have been enough anyway.
//
// 🔴 THIS OBJECT OWNS THREE QUEUES AND `dispose()` USED TO AWAIT ONE.
//   · `_journalOps` — awaited, via `endRecording`;
//   · `_writes`, the legacy-face append chain — NOT awaited;
//   · `ManifestRepublishQueue`, fired UNAWAITED by `_closeJournalLocked` on
//     its way out — NOT awaited, and not even awaitABLE: a second
//     `republish()` used to start a concurrent run rather than join the one
//     already going.
// Both cases below are the second and third of those. Each has a reverse
// control, and each really went red.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/retained_audio_journal_fs.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/audio/ring_buffer.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/temp_teardown.dart';

/// A journal filesystem with a disk that can be filled, and whose whole-file
/// write takes a real turn of the event loop.
///
/// 🔴 THE DELAY IS THE POINT, NOT DECORATION. What is under test is whether
/// `dispose()` waits for a write it did not start; a write that completes
/// synchronously cannot tell a waiting dispose from a lucky one.
class _SlowFs implements JournalFileSystem {
  final Map<String, List<int>> files = <String, List<int>>{};

  /// 0 ⇒ the next whole-file write (the temp manifest) fails with ENOSPC,
  /// which is what puts the manifest into the republish queue.
  int freeBytes = 1 << 30;

  int writeBytesCalls = 0;

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
    writeBytesCalls += 1;
    await Future<void>.delayed(const Duration(milliseconds: 20));
    if (bytes.length > freeBytes) {
      throw const FileSystemException('ENOSPC: no space left on device');
    }
    files[path] = List<int>.from(bytes);
  }

  @override
  Future<JournalFileHandle> openAppend(String path) async {
    files.putIfAbsent(path, () => <int>[]);
    return _SlowHandle(this, path);
  }

  @override
  Future<void> rename(String from, String to) async {
    final List<int>? b = files.remove(from);
    if (b == null) throw FileSystemException('missing $from');
    files[to] = b;
  }

  @override
  Future<void> deleteFile(String path) async => files.remove(path);

  @override
  Future<List<String>> listNames(String dirPath) async => const <String>[];
}

class _SlowHandle implements JournalFileHandle {
  _SlowHandle(this._fs, this._path);

  final _SlowFs _fs;
  final String _path;

  @override
  Future<void> append(Uint8List bytes) async => _fs.files[_path]!.addAll(bytes);

  @override
  Future<void> flush() async {}

  @override
  Future<int> length() async => _fs.files[_path]!.length;

  @override
  Future<void> close() async {}
}

/// A store whose append takes a real 20 ms, so 「did dispose wait?」 has an
/// answer that does not depend on how many event-loop turns the other awaits
/// in `dispose()` happen to yield. Without a slow write, a queued append can
/// land during an unrelated `await` and the test passes for the wrong reason
/// (MEASURED: it did, on the first draft of the reverse control below).
class _SlowStore extends RetainedAudioStore {
  _SlowStore({required super.dir, required super.clock});

  @override
  Future<bool> append({required int segmentIdx, required Uint8List bytes}) async {
    await Future<void>.delayed(const Duration(milliseconds: 20));
    return super.append(segmentIdx: segmentIdx, bytes: bytes);
  }
}

void main() {
  late Directory tmp;
  late RetainedAudioStore store;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('flowmic-dispose-drain-');
    store = _SlowStore(dir: tmp, clock: () => 0);
    await store.open();
  });

  tearDown(() async {
    await store.dispose();
    await removeTempDir(tmp);
  });

  test('dispose awaits the manifest republish it did not start', () async {
    final _SlowFs fs = _SlowFs();
    final RetainedAudioSpill spill = RetainedAudioSpill(
      store: store,
      retainFromFirstFrame: true,
      journalDirPath: 'j',
      journalFs: fs,
      clock: () => 1,
    );
    await spill.beginRecording();
    // The disk fills mid-recording: the closing commit cannot create its temp
    // manifest, so `close()` hands the facts to the republish queue.
    fs.freeBytes = 0;
    await spill.endRecording();
    expect(spill.unpublishedManifestIds, hasLength(1),
        reason: 'positive control: the ENOSPC commit really did queue one');

    // Space comes back. `_closeJournalLocked` inside dispose fires
    // `republish()` UNAWAITED; the only thing that can wait for it is dispose
    // itself, and only because the queue now serialises its runs.
    fs.freeBytes = 1 << 30;
    await spill.dispose();

    // REVERSE CONTROL, REALLY RUN 2026-09-07: deleting the
    // `await republishPendingManifests();` line from
    // `RetainedAudioSpill.dispose` turns this red with
    // `Expected: empty  Actual: ['run-<micros>-r1']` — the manifest is still
    // 20 ms from the disk when dispose returns. Reverted; green again.
    expect(spill.unpublishedManifestIds, isEmpty,
        reason: 'dispose must not return while a manifest write is still out');
    expect(fs.files.keys.where((String k) => k.endsWith('.manifest.json')),
        isNotEmpty);
  });

  test('dispose awaits the legacy append chain', () async {
    final RetainedAudioSpill spill = RetainedAudioSpill(store: store);
    spill.noteUplinkDown();
    // Queued, not awaited — `onEvicted` is synchronous by necessity (its
    // caller is `AudioRingBuffer.prune`).
    spill.onEvicted(
        BufferedChunk(seq: 0, tsMs: 0, payload: makePcm(6400)));

    await spill.dispose();

    // Read the directory SYNCHRONOUSLY: an `await` here would itself give the
    // pending write the turn it needs, and the test would pass for the wrong
    // reason.
    //
    // REVERSE CONTROL, REALLY RUN 2026-09-07: deleting the `await flush();`
    // line from `RetainedAudioSpill.dispose` turns this red with
    // `Expected: a value greater than <0>  Actual: <0>` — dispose returned
    // with the PCM still on its way down. Reverted; green again.
    expect(tmp.listSync().length, greaterThan(0),
        reason: 'the queued append must have landed before dispose returned');
  });
}
