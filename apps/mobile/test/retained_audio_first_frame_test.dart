// Cards LS-2 and LS-3 — the first-frame storage face, and the policy that
// keeps what it writes.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     E7 (the spill predicate is the link, not the engine), A4 (uplinkUp
//     demoted to a diagnostic field), A5-1/A5-2 (TTL and cap may not eat
//     unrecovered audio), A9 stage 1, A10 cards LS-2 / LS-3
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md (owner ruling O-2)
//
// ⚠️ WHAT EACH SEAM IS AND WHY IT WAS CHOSEN. The store drives a REAL
// filesystem (a fresh systemTemp directory per case) because the judgment is
// "the bytes are on disk", and a fake store would only prove our bookkeeping
// agrees with itself. The CLOCK is injected everywhere, so a 30-day TTL is
// simulated instantly and no case sleeps. Two cases swap in an in-memory
// [JournalFileSystem]: one to COUNT operations (proving the OFF path performs
// none — an assertion a real directory cannot make, because "no file appeared"
// and "no call happened" are different facts), and one to make a write fail on
// demand.
//
// 🔴 THE FLAG IS OFF IN PRODUCTION. Every ON case below constructs it
// explicitly. `retained_audio_boot.dart` does not, and card RC-1 owns the day
// that changes — see that file for the five prerequisites.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

/// Counts every filesystem call and can be told to fail one of them. Used for
/// the two judgments a real directory cannot make: "nothing was called" and
/// "this append threw".
class _CountingFs implements JournalFileSystem {
  final Map<String, List<int>> files = <String, List<int>>{};
  final List<String> calls = <String>[];

  /// When true, every [JournalFileHandle.append] throws.
  bool failAppends = false;

  @override
  Future<void> ensureDirectory(String path) async => calls.add('mkdir');

  @override
  Future<bool> exists(String path) async {
    calls.add('exists');
    return files.containsKey(path);
  }

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
    calls.add('write');
    files[path] = List<int>.from(bytes);
  }

  @override
  Future<JournalFileHandle> openAppend(String path) async {
    calls.add('open');
    files.putIfAbsent(path, () => <int>[]);
    return _CountingHandle(this, path);
  }

  @override
  Future<void> rename(String from, String to) async {
    calls.add('rename');
    final List<int>? b = files.remove(from);
    if (b == null) throw const FileSystemException('missing');
    files[to] = b;
  }

  @override
  Future<void> deleteFile(String path) async => files.remove(path);

  @override
  Future<List<String>> listNames(String dirPath) async => const <String>[];
}

class _CountingHandle implements JournalFileHandle {
  _CountingHandle(this._fs, this._path);

  final _CountingFs _fs;
  final String _path;

  @override
  Future<void> append(Uint8List bytes) async {
    _fs.calls.add('append');
    if (_fs.failAppends) {
      throw const FileSystemException('injected append failure');
    }
    _fs.files[_path]!.addAll(bytes);
  }

  @override
  Future<void> flush() async => _fs.calls.add('flush');

  @override
  Future<int> length() async => _fs.files[_path]!.length;

  @override
  Future<void> close() async => _fs.calls.add('close');
}

void main() {
  late Directory tmp;
  late FakeAudioRecorder rec;
  int fakeNow = 0;
  int fakeMicros = 0;

  Uint8List chunkFor(int i) => makePcm(6400, amplitude: 1000 + i);

  setUp(() async {
    fakeNow = 0;
    fakeMicros = 0;
    tmp = await Directory.systemTemp.createTemp('flowmic-ff-');
    rec = FakeAudioRecorder();
  });

  tearDown(() async {
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  RetainedAudioStore openStore({int? capBytes, Duration? ttl}) =>
      RetainedAudioStore(
        dir: tmp,
        capBytes: capBytes ?? RetainedAudioStore.kUnrecoveredCapBytes,
        ttl: ttl ?? RetainedAudioStore.kDefaultTtl,
        clock: () => fakeNow,
      );

  RetainedAudioSpill openSpill(
    RetainedAudioStore store, {
    required bool retainFromFirstFrame,
    JournalFileSystem? fs,
  }) =>
      RetainedAudioSpill(
        store: store,
        retainFromFirstFrame: retainFromFirstFrame,
        journalFs: fs ?? const IoJournalFileSystem(),
        clock: () => ++fakeMicros,
      );

  AudioCapture captureOn(RetainedAudioSpill spill) =>
      AudioCapture(recorder: rec, spill: spill, clock: () => fakeNow);

  Future<void> feed(int count) async {
    for (int i = 0; i < count; i++) {
      fakeNow = i * 200;
      rec.feed(chunkFor(i));
      await pumpEventQueue();
    }
  }

  File pcmOf(String id) =>
      File('${tmp.path}${Platform.pathSeparator}'
          '$id${RetainedAudioJournal.pcmSuffix}');

  // ── LS-2: the flag, both ways ─────────────────────────────────────────────

  test('🔴 FLAG ON: a healthy uplink no longer decides whether the audio '
      'exists (E7)', () async {
    final RetainedAudioStore store = openStore();
    await store.open();
    final RetainedAudioSpill spill =
        openSpill(store, retainFromFirstFrame: true);
    addTearDown(store.dispose);
    addTearDown(spill.dispose);

    final AudioCapture cap = captureOn(spill);
    addTearDown(cap.dispose);
    await cap.start();
    // 🔴 POSITIVE CONTROL FOR THE SCENARIO ITSELF: the socket is fine. This is
    // the case E7 names — the engine is what died, and nothing tells this
    // layer about that — so a layer that still asked the uplink would write
    // nothing here.
    expect(spill.uplinkUp, isTrue);
    await feed(5);
    await spill.journalFlush();

    final String? id = spill.currentRecordingId;
    expect(id, isNotNull);
    expect(await pcmOf(id!).exists(), isTrue);
    expect(await pcmOf(id).length(), 5 * 6400,
        reason: 'every captured chunk, from the first frame, not just the '
            'ones that aged out of the ring');
    expect(store.retainedBytes, 0,
        reason: 'and NOT in the segment store as well — the same audio in two '
            'layouts would spend the O-2 budget twice');
  });

  test('🔴 FLAG OFF: zero journal I/O — not "no file appeared", no CALL '
      'happened', () async {
    final RetainedAudioStore store = openStore();
    await store.open();
    final _CountingFs fs = _CountingFs();
    final RetainedAudioSpill spill =
        openSpill(store, retainFromFirstFrame: false, fs: fs);
    addTearDown(store.dispose);
    addTearDown(spill.dispose);

    final AudioCapture cap = captureOn(spill);
    addTearDown(cap.dispose);
    await cap.start();
    await feed(5);
    cap.takeResidualChunk();
    await cap.stop();
    await spill.journalFlush();

    expect(fs.calls, isEmpty,
        reason: 'the default build must not create a directory, open a '
            'handle, or write a manifest. Asserting on an empty directory '
            'would not have caught a mkdir.');
    expect(spill.currentRecordingId, isNull);
    expect(spill.journalBytes, 0);
  });

  test('FLAG OFF: the legacy face still behaves exactly as it did', () async {
    final RetainedAudioStore store = openStore();
    await store.open();
    final RetainedAudioSpill spill =
        openSpill(store, retainFromFirstFrame: false);
    addTearDown(store.dispose);
    addTearDown(spill.dispose);

    // Healthy link ⇒ nothing retained; link down ⇒ the stop tail is retained.
    // (The whole legacy suite is the real proof; this is the one-line sanity
    // check that the flag did not change the OFF path under us.)
    final AudioCapture cap = captureOn(spill);
    addTearDown(cap.dispose);
    await cap.start();
    await feed(4);
    await cap.stop();
    await spill.flush();
    expect(store.retainedBytes, 0);

    spill.noteUplinkDown();
    final AudioCapture cap2 = captureOn(spill);
    addTearDown(cap2.dispose);
    await cap2.start();
    await feed(4);
    await cap2.stop();
    await spill.flush();
    expect(store.retainedBytes, 4 * 6400,
        reason: 'stop() still retains the ring tail when the uplink is down');
  });

  // ── LS-2: one recording, one journal ─────────────────────────────────────

  test('🔴 the recordingId rolls on every ordinary press', () async {
    final RetainedAudioStore store = openStore();
    await store.open();
    final RetainedAudioSpill spill =
        openSpill(store, retainFromFirstFrame: true);
    addTearDown(store.dispose);
    addTearDown(spill.dispose);

    final AudioCapture cap = captureOn(spill);
    addTearDown(cap.dispose);
    await cap.start();
    await feed(2);
    await spill.journalFlush();
    final String first = spill.currentRecordingId!;
    await cap.stop();
    await spill.journalFlush();

    // What `ptt_edges.dart` does between two ordinary presses.
    spill.endSession();
    await cap.start();
    await feed(2);
    await spill.journalFlush();
    final String second = spill.currentRecordingId!;

    expect(second, isNot(first),
        reason: 'two presses in one run once shared a session key and their '
            'offline tails appended into ONE file — 300 + 120 = 420 bytes '
            'nothing downstream could tell apart (CR-4). One recording is '
            'one journal, or that returns.');
    expect(await pcmOf(first).length(), 2 * 6400);
    expect(await pcmOf(second).length(), 2 * 6400,
        reason: 'and neither press appended into the other');
  });

  test('🔴 the recordingId is FIXED across one continuous recording',
      () async {
    final RetainedAudioStore store = openStore();
    await store.open();
    final RetainedAudioSpill spill =
        openSpill(store, retainFromFirstFrame: true);
    addTearDown(store.dispose);
    addTearDown(spill.dispose);

    // What `ptt_continuous.beginContinuous` does: file everything under the
    // article id, THEN start capture.
    spill.beginSession('article-42');
    final AudioCapture cap = captureOn(spill);
    addTearDown(cap.dispose);
    await cap.start();
    await feed(3);
    await spill.journalFlush();
    final String during = spill.currentRecordingId!;
    await feed(3);
    await spill.journalFlush();

    expect(spill.currentRecordingId, during,
        reason: 'a continuous recording is ONE recording; an id that rolled '
            'mid-article would split it across two journals and neither '
            'would be the whole thing');
    expect(during, contains('article-42'),
        reason: 'the id is minted from the CURRENT session key, so the bytes '
            'and the rows say the same string');
    expect(await pcmOf(during).length(), 6 * 6400);
  });

  // ── LS-2: the residual partial, and the three stop verbs ─────────────────

  test('the residual partial reaches the journal on stop', () async {
    final RetainedAudioStore store = openStore();
    await store.open();
    final RetainedAudioSpill spill =
        openSpill(store, retainFromFirstFrame: true);
    addTearDown(store.dispose);
    addTearDown(spill.dispose);

    final AudioCapture cap = captureOn(spill);
    addTearDown(cap.dispose);
    await cap.start();
    await feed(1);
    // A sub-chunk tail: less than one 200 ms slice, so _onPcm leaves it in the
    // accumulator. On the ordinary path pttUp takes it and emits it ahead of
    // audio:stop, which is why the hook is on the taker.
    rec.feed(makePcm(1000));
    await pumpEventQueue();
    expect(cap.takeResidualChunk(), isNotNull);
    await cap.stop();
    await spill.journalFlush();

    final String id = spill.journal?.recordingId ?? '';
    // The journal is closed by stop(), so read the file the id named.
    final List<FileSystemEntity> pcms = tmp
        .listSync()
        .where((FileSystemEntity e) =>
            e.path.endsWith(RetainedAudioJournal.pcmSuffix))
        .toList();
    expect(pcms, hasLength(1), reason: 'one recording, one journal $id');
    expect(await File(pcms.single.path).length(), 6400 + 1000,
        reason: 'the last fraction of a second is the part a user notices is '
            'missing');
  });

  test('pause() keeps the partial it has always discarded, and closes nothing',
      () async {
    final RetainedAudioStore store = openStore();
    await store.open();
    final RetainedAudioSpill spill =
        openSpill(store, retainFromFirstFrame: true);
    addTearDown(store.dispose);
    addTearDown(spill.dispose);

    final AudioCapture cap = captureOn(spill);
    addTearDown(cap.dispose);
    await cap.start();
    await feed(1);
    rec.feed(makePcm(800));
    await pumpEventQueue();
    final String id = spill.currentRecordingId ?? '';
    await cap.pause();
    await spill.journalFlush();

    expect(spill.currentRecordingId, id,
        reason: 'a paused recording is one recording — resume() continues it, '
            'so pause must not close the journal');
    expect(await pcmOf(id).length(), 6400 + 800);
    expect(cap.currentSeq, 1,
        reason: 'and it must NOT burn a seq: the wire never saw this partial, '
            'and a gap in a monotonic sequence the server tracks would be a '
            'real defect traded for a fake one');
  });

  test('each stop verb closes the journal with its own named reason',
      () async {
    Future<String> reasonAfter(
        Future<void> Function(AudioCapture c) end) async {
      final RetainedAudioStore store = openStore();
      await store.open();
      final RetainedAudioSpill spill =
          openSpill(store, retainFromFirstFrame: true);
      final AudioCapture cap = captureOn(spill);
      await cap.start();
      await feed(1);
      await spill.journalFlush();
      final String id = spill.currentRecordingId!;
      await end(cap);
      await spill.journalFlush();
      await pumpEventQueue();
      final File m = File('${tmp.path}${Platform.pathSeparator}'
          '$id${RetainedAudioJournal.manifestSuffix}');
      final Map<String, Object?> json =
          jsonDecode(await m.readAsString()) as Map<String, Object?>;
      await cap.dispose();
      await spill.dispose();
      await store.dispose();
      return json['interruptReason']! as String;
    }

    expect(await reasonAfter((AudioCapture c) => c.stop()),
        JournalInterrupt.none,
        reason: 'an ordinary end is not an interrupt');
    expect(
        await reasonAfter((AudioCapture c) async => c.stopForLinkLoss()),
        JournalInterrupt.linkLoss);
    // 🔴 CARD LS-4 SPLIT THIS ONE INTO FOUR. LS-2 recorded
    // `cancelled_or_fault` for all four `fenceAndStop` callers, which made the
    // cancel disposition (owner ruling O-5) unrepresentable. The bare call is
    // now `auto_stopped` — the default, which exists so ptt_inbound.dart's
    // untouched call site keeps the right reason.
    expect(await reasonAfter((AudioCapture c) async => c.fenceAndStop()),
        JournalInterrupt.autoStopped);
    expect(
        await reasonAfter((AudioCapture c) async =>
            c.fenceAndStop(reason: JournalInterrupt.captureFault)),
        JournalInterrupt.captureFault);
    expect(
        await reasonAfter((AudioCapture c) async =>
            c.fenceAndStop(reason: JournalInterrupt.authDrained)),
        JournalInterrupt.authDrained);
    expect(
        await reasonAfter((AudioCapture c) async =>
            c.fenceAndStop(reason: JournalInterrupt.cancelled)),
        JournalInterrupt.cancelled);
  });

  test('🔴 an interrupt reason is NOT a tombstone', () async {
    // ⚠️ CARD LS-4 HAS SINCE LANDED, AND THIS CASE STILL HOLDS — what it pins
    // has narrowed, not gone. A tombstone is written by ONE reason
    // (`JournalInterrupt.cancelled`, i.e. the swipe-up); the bare call below
    // is the `auto_stopped` default, and no stop verb may acquire a policy
    // just by ending a recording. If `cancelled` ever comes back true from
    // here, a caller that is not the user has started discarding their audio.
    // The positive side lives in retained_audio_cancel_tombstone_test.dart.
    final RetainedAudioStore store = openStore();
    await store.open();
    final RetainedAudioSpill spill =
        openSpill(store, retainFromFirstFrame: true);
    addTearDown(store.dispose);
    addTearDown(spill.dispose);
    final AudioCapture cap = captureOn(spill);
    addTearDown(cap.dispose);

    await cap.start();
    await feed(2);
    await spill.journalFlush();
    final String id = spill.currentRecordingId!;
    cap.fenceAndStop();
    await spill.journalFlush();
    await pumpEventQueue();

    final Map<String, Object?> json = jsonDecode(await File(
                '${tmp.path}${Platform.pathSeparator}'
                '$id${RetainedAudioJournal.manifestSuffix}')
            .readAsString()) as Map<String, Object?>;
    expect(json['cancelled'], isFalse);
    expect(await pcmOf(id).length(), 2 * 6400,
        reason: 'and the bytes are still there: this layer deletes nothing');
  });

  // ── LS-2: the notices reach the value a screen reads ─────────────────────

  test('🔴 a journal write failure reaches store.lastNotice, which is what '
      'the banner binds to', () async {
    final RetainedAudioStore store = openStore();
    await store.open();
    final _CountingFs fs = _CountingFs();
    final RetainedAudioSpill spill =
        openSpill(store, retainFromFirstFrame: true, fs: fs);
    addTearDown(store.dispose);
    addTearDown(spill.dispose);

    final AudioCapture cap = captureOn(spill);
    addTearDown(cap.dispose);
    await cap.start();
    await feed(1);
    await spill.journalFlush();
    expect(store.lastNotice.value, isNull, reason: 'positive control: quiet '
        'while the writes succeed — otherwise this case proves nothing');

    fs.failAppends = true;
    await feed(1);
    await spill.journalFlush();
    await pumpEventQueue();

    expect(store.lastNotice.value?.code, RetainedAudioNotice.codeWriteFailed,
        reason: 'before LS-2 this fact stopped at a broadcast stream with no '
            'subscriber, which is as gone as never raising it');
  });

  // ── LS-3: TTL, both directions ───────────────────────────────────────────

  test('🔴 TTL: a SETTLED recording is reclaimed (the positive control the '
      'LS-0 case needs)', () async {
    // Without this, "the sweep deletes nothing" would be satisfied by a sweep
    // that is simply broken. This is the one shape it is allowed to take.
    final RetainedAudioStore store =
        openStore(ttl: const Duration(hours: 1));
    await store.open();
    addTearDown(store.dispose);

    const String id = 'rec-settled';
    await File('${tmp.path}${Platform.pathSeparator}'
            '$id${RetainedAudioJournal.pcmSuffix}')
        .writeAsBytes(makePcm(4000), flush: true);
    await File('${tmp.path}${Platform.pathSeparator}'
            '$id${RetainedAudioJournal.manifestSuffix}')
        .writeAsString(
            jsonEncode(<String, Object?>{
              'recordingId': id,
              'formatVersion': 1,
              'format': const <String, Object?>{
                'codec': 'pcm_s16le',
                'sampleRate': 16000,
                'channels': 1,
                'bytesPerFrame': 2,
              },
              'committedClaimBytes': 4000,
              'settled': true,
            }),
            flush: true);

    fakeNow = DateTime.now().millisecondsSinceEpoch +
        const Duration(days: 2).inMilliseconds;
    await store.sweep();
    await pumpEventQueue();

    expect(
        await File('${tmp.path}${Platform.pathSeparator}'
                '$id${RetainedAudioJournal.pcmSuffix}')
            .exists(),
        isFalse);
    expect(store.lastNotice.value?.code, RetainedAudioNotice.codeExpired);
  });

  test('🔴 TTL: an UNSETTLED recording of the same age is left alone',
      () async {
    final RetainedAudioStore store =
        openStore(ttl: const Duration(hours: 1));
    await store.open();
    addTearDown(store.dispose);

    const String id = 'rec-unsettled';
    await File('${tmp.path}${Platform.pathSeparator}'
            '$id${RetainedAudioJournal.pcmSuffix}')
        .writeAsBytes(makePcm(4000), flush: true);
    await File('${tmp.path}${Platform.pathSeparator}'
            '$id${RetainedAudioJournal.manifestSuffix}')
        .writeAsString(
            jsonEncode(<String, Object?>{
              'recordingId': id,
              'formatVersion': 1,
              'format': const <String, Object?>{
                'codec': 'pcm_s16le',
                'sampleRate': 16000,
                'channels': 1,
                'bytesPerFrame': 2,
              },
              'committedClaimBytes': 4000,
              // No `settled` key at all: a manifest written before LS-3 must
              // decode to "never sweep this", not to "probably fine".
            }),
            flush: true);

    fakeNow = DateTime.now().millisecondsSinceEpoch +
        const Duration(days: 2).inMilliseconds;
    await store.sweep();
    await pumpEventQueue();

    expect(
        await File('${tmp.path}${Platform.pathSeparator}'
                '$id${RetainedAudioJournal.pcmSuffix}')
            .exists(),
        isTrue,
        reason: 'two days old and never transcribed is exactly the recording '
            'owner ruling O-2 protects');
    expect(store.lastNotice.value, isNull);
  });

  // ── LS-3: the cap, on the journal face ───────────────────────────────────

  test('🔴 the cap stops the journal retaining, and keeps what it has',
      () async {
    final RetainedAudioStore store = openStore(capBytes: 6400 * 2);
    await store.open();
    final RetainedAudioSpill spill =
        openSpill(store, retainFromFirstFrame: true);
    addTearDown(store.dispose);
    addTearDown(spill.dispose);

    final AudioCapture cap = captureOn(spill);
    addTearDown(cap.dispose);
    await cap.start();
    await feed(5); // three more than the budget holds
    await spill.journalFlush();
    await pumpEventQueue();

    final String id = spill.currentRecordingId!;
    expect(await pcmOf(id).length(), 6400 * 2,
        reason: 'it stopped at the ceiling — it did not wrap, truncate, or '
            'drop the beginning to fit the end');
    expect(store.lastNotice.value?.code, RetainedAudioNotice.codeCapReached,
        reason: 'stopping quietly is the one thing a full store may not do');
    expect(spill.journalBytes, 6400 * 2);
  });
}
