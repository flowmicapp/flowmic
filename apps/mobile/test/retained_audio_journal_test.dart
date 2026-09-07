// Card LS-1 — the per-recording journal + manifest, and the A3-8 startup scan.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     A3-2a (sample time base), A3-3 (commit order), A3-8 (three quantities,
//     zero deletes), A10 P0-1 reverse cases: `tail_beyond_committed_test`,
//     `claim_ahead_of_file_test`, `odd_tail_byte_test`,
//     `corrupt_manifest_quarantine_test`
//
// ⚠️ TWO KINDS OF TEST HERE, ON PURPOSE.
//   · The scan cases drive a REAL temp directory. The judgment is 「the bytes
//     are still on the disk」 and 「the file is exactly this long」; an in-memory
//     double would only prove our bookkeeping agrees with itself.
//   · The commit-order case drives a fault-injecting fake filesystem, because
//     the property under test is a property of the ORDER of four calls, and
//     the only way to test an order is to be able to die between any two of
//     them. A real filesystem will not do that on request.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/temp_teardown.dart';

/// An in-memory [JournalFileSystem] that can be made to die on a chosen
/// operation. `_ops` counts every operation the journal performs, so
/// `dieAtOp = n` reproduces "the process stopped after n filesystem calls".
class _FaultFs implements JournalFileSystem {
  final Map<String, List<int>> files = <String, List<int>>{};
  final List<String> log = <String>[];

  /// 1-based index of the operation that should throw. -1 = never.
  int dieAtOp = -1;

  /// When set, the NEXT append writes this many bytes and THEN throws - the
  /// ENOSPC-caught-mid-write shape, which is the one an all-or-nothing fault
  /// injector cannot produce and the one the append catch got wrong.
  int? nextAppendPartialBytes;
  int _ops = 0;

  void _op(String name) {
    _ops += 1;
    log.add(name);
    if (_ops == dieAtOp) {
      throw FileSystemException('injected death at op $_ops ($name)');
    }
  }

  int get opCount => _ops;

  void resetCounter() {
    _ops = 0;
    log.clear();
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
    _op('writeBytes:$path');
    files[path] = List<int>.from(bytes);
  }

  @override
  Future<JournalFileHandle> openAppend(String path) async {
    files.putIfAbsent(path, () => <int>[]);
    return _FaultHandle(this, path);
  }

  @override
  Future<void> rename(String from, String to) async {
    _op('rename:$from');
    final List<int>? b = files.remove(from);
    if (b == null) throw FileSystemException('missing $from');
    files[to] = b;
  }

  @override
  Future<void> deleteFile(String path) async => files.remove(path);

  @override
  Future<List<String>> listNames(String dirPath) async {
    final String prefix = '$dirPath/';
    return files.keys
        .where((String k) => k.startsWith(prefix))
        .map((String k) => k.substring(prefix.length))
        .toList()
      ..sort();
  }
}

class _FaultHandle implements JournalFileHandle {
  final _FaultFs _fs;
  final String _path;

  _FaultHandle(this._fs, this._path);

  @override
  Future<void> append(Uint8List bytes) async {
    final int? partial = _fs.nextAppendPartialBytes;
    if (partial != null) {
      _fs.nextAppendPartialBytes = null;
      _fs.files[_path]!.addAll(bytes.sublist(0, partial));
      throw const FileSystemException('injected ENOSPC mid-write');
    }
    _fs._op('append:$_path');
    _fs.files[_path]!.addAll(bytes);
  }

  @override
  Future<void> flush() async => _fs._op('flush:$_path');

  @override
  Future<int> length() async => _fs.files[_path]!.length;

  @override
  Future<void> close() async {}
}

Uint8List pcm(int n, {int fill = 7}) =>
    Uint8List.fromList(List<int>.filled(n, fill));

void main() {
  late Directory tmp;

  String at(String name) => '${tmp.path}${Platform.pathSeparator}$name';

  Future<void> putPcm(String id, int bytes) =>
      File(at('$id${RetainedAudioJournal.pcmSuffix}'))
          .writeAsBytes(pcm(bytes), flush: true);

  Future<void> putManifest(String id, Map<String, Object?> json) =>
      File(at('$id${RetainedAudioJournal.manifestSuffix}'))
          .writeAsString(jsonEncode(json), flush: true);

  Map<String, Object?> manifestJson(String id, int claim) => <String, Object?>{
        'recordingId': id,
        'format': AudioJournalFormat.current.toJson(),
        'formatVersion': RecordingManifest.currentFormatVersion,
        'committedClaimBytes': claim,
        'interruptReason': JournalInterrupt.none,
        'holes': <Object?>[],
        'attempts': <Object?>[],
        'resultRef': null,
        'cancelled': false,
        'configSnapshot': <String, Object?>{},
      };

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('flowmic-journal-');
  });

  tearDown(() async {
    await removeTempDir(tmp);
  });

  group('the journal writes and commits', () {
    test('a committed claim is even and never exceeds the file', () async {
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: tmp.path,
        recordingId: 'rec-1',
        commitInterval: const Duration(days: 1), // no timer in this case
      );
      await j.appendPcm(pcm(6400));
      await j.appendPcm(pcm(6400));
      await j.commit();
      expect(j.observedBytes, 12800);
      expect(j.committedClaimBytes, 12800);
      expect(j.committedClaimBytes.isEven, isTrue);
      await j.close();

      final List<RecordingScan> scans =
          await RetainedAudioJournalScan.scan(dirPath: tmp.path);
      expect(scans, hasLength(1));
      expect(scans.single.committedClaim, 12800);
      expect(scans.single.observedLength, 12800);
      expect(scans.single.verifiedRecoverableRange.end, 12800);
      expect(scans.single.claimAheadOfObserved, isFalse);
      expect(scans.single.unverifiedTail, isFalse);
    });

    test('reopening appends and never truncates', () async {
      final RetainedAudioJournal a = await RetainedAudioJournal.open(
          dirPath: tmp.path, recordingId: 'rec-2');
      await a.appendPcm(pcm(400));
      await a.close();
      final RetainedAudioJournal b = await RetainedAudioJournal.open(
          dirPath: tmp.path, recordingId: 'rec-2');
      expect(b.observedBytes, 400, reason: 'reopen must not truncate');
      await b.appendPcm(pcm(200));
      await b.commit();
      expect(b.observedBytes, 600);
      await b.close();
    });

    test('the group-commit interval is a parameter, and it fires', () async {
      final List<void Function()> pendingCallbacks = <void Function()>[];
      Duration? asked;
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: tmp.path,
        recordingId: 'rec-3',
        commitInterval: const Duration(milliseconds: 250),
        timerFactory: (Duration d, void Function() cb) {
          asked = d;
          pendingCallbacks.add(cb);
          return Timer(Duration.zero, () {});
        },
      );
      await j.appendPcm(pcm(64));
      expect(asked, const Duration(milliseconds: 250),
          reason: 'the interval must come from the caller, not a constant '
              'baked into the module');
      expect(j.committedClaimBytes, 0,
          reason: 'nothing is claimed until the group commit runs');
      pendingCallbacks.single();
      // The commit rides the journal's serial queue, so give the event loop a
      // turn rather than a single microtask.
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(j.committedClaimBytes, 64);
      await j.close();
    });

    test('a failed append records a hole and the next one still lands',
        () async {
      final _FaultFs fs = _FaultFs();
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: '/j',
        recordingId: 'rec-4',
        fs: fs,
        commitInterval: const Duration(days: 1),
      );
      fs.resetCounter();
      fs.dieAtOp = 1; // the first append throws
      expect(await j.appendPcm(pcm(100)), isFalse);
      fs.dieAtOp = -1;
      expect(await j.appendPcm(pcm(100)), isTrue);
      expect(j.failedAppendCount, 1);
      expect(j.holes, hasLength(1));
      expect(j.holes.single.start, 0);
      expect(j.holes.single.length, 100);
      expect(j.observedBytes, 100);
      await j.close();
    });
  });

  group('tail_beyond_committed_test', () {
    test('bytes past the claim are kept, and folded in as a recovered tail',
        () async {
      await putPcm('rec-tail', 300);
      await putManifest('rec-tail', manifestJson('rec-tail', 100));

      final List<RecordingScan> scans =
          await RetainedAudioJournalScan.scan(dirPath: tmp.path);
      final RecordingScan s = scans.single;

      expect(s.committedClaim, 100, reason: 'the claim is what it always was');
      expect(s.observedLength, 300);
      expect(s.unverifiedTail, isTrue);
      expect(s.tailRecovered, isTrue);
      expect(s.verifiedRecoverableRange.end, 300);
      // 🔴 THE POINT OF THE CASE: zero truncation.
      expect(
        await File(at('rec-tail${RetainedAudioJournal.pcmSuffix}')).length(),
        300,
        reason: 'A3-8 forbids in-place truncation; the scan may only narrow a '
            'READ VIEW',
      );
    });
  });

  group('claim_ahead_of_file_test', () {
    test('a manifest ahead of the file keeps its high-water mark', () async {
      await putPcm('rec-ahead', 100);
      await putManifest('rec-ahead', manifestJson('rec-ahead', 200));

      final List<JournalNotice> heard = <JournalNotice>[];
      final List<RecordingScan> scans = await RetainedAudioJournalScan.scan(
        dirPath: tmp.path,
        clock: () => 1234,
        onNotice: heard.add,
      );
      final RecordingScan s = scans.single;

      expect(s.claimAheadOfObserved, isTrue);
      expect(s.committedClaim, 200);
      expect(s.observedLength, 100);
      expect(s.verifiedRecoverableRange.end, 100,
          reason: 'recover the minimum of the two, not the claim');
      expect(
        heard.map((JournalNotice n) => n.code),
        contains(JournalNotice.codeClaimAheadOfObserved),
      );

      // 🔴 The marker is added; the claim is NOT rewritten down to 100. Losing
      // the high-water mark would erase the only evidence that the commit
      // order was ever violated.
      final RecordingManifest reread = RecordingManifest.decode(
          await File(at('rec-ahead${RetainedAudioJournal.manifestSuffix}'))
              .readAsString());
      expect(reread.committedClaimBytes, 200);
      expect(reread.claimAheadOfObservedAt, 1234);
      expect(await File(at('rec-ahead${RetainedAudioJournal.pcmSuffix}'))
          .length(), 100);
    });
  });

  group('odd_tail_byte_test', () {
    test('an odd byte narrows the read view and nothing else', () async {
      await putPcm('rec-odd', 301);
      await putManifest('rec-odd', manifestJson('rec-odd', 100));

      final RecordingScan s =
          (await RetainedAudioJournalScan.scan(dirPath: tmp.path)).single;

      expect(s.oddTrailingByte, isTrue);
      expect(s.observedLength, 301);
      expect(s.verifiedRecoverableRange.end, 300,
          reason: 'A3-2a: an odd byte offset is not a sample coordinate');
      expect(s.quarantined, isFalse,
          reason: 'one stray byte is not a ruined recording');
      expect(
        await File(at('rec-odd${RetainedAudioJournal.pcmSuffix}')).length(),
        301,
        reason: 'the byte is excluded from the view, not from the file',
      );
    });

    test('a one-byte tail is not foldable and the claim stands', () async {
      await putPcm('rec-odd2', 101);
      await putManifest('rec-odd2', manifestJson('rec-odd2', 100));

      final RecordingScan s =
          (await RetainedAudioJournalScan.scan(dirPath: tmp.path)).single;

      expect(s.unverifiedTail, isTrue);
      expect(s.tailRecovered, isFalse);
      expect(s.verifiedRecoverableRange.end, 100);
      expect(await File(at('rec-odd2${RetainedAudioJournal.pcmSuffix}'))
          .length(), 101);
    });
  });

  group('corrupt_manifest_quarantine_test', () {
    test('an unreadable manifest is parked and nothing is deleted', () async {
      await putPcm('rec-bad', 64);
      await File(at('rec-bad${RetainedAudioJournal.manifestSuffix}'))
          .writeAsString('{ this is not json', flush: true);

      final List<JournalNotice> heard = <JournalNotice>[];
      final RecordingScan s = (await RetainedAudioJournalScan.scan(
        dirPath: tmp.path,
        onNotice: heard.add,
      ))
          .single;

      expect(s.quarantined, isTrue);
      expect(s.verifiedRecoverableRange.isEmpty, isTrue,
          reason: 'quarantined audio enters neither the recovery queue nor '
              'any eviction candidate list');
      expect(heard.map((JournalNotice n) => n.code),
          contains(JournalNotice.codeQuarantined));
      // Zero deletes: the PCM is untouched and the bad manifest was RENAMED.
      expect(
          await File(at('rec-bad${RetainedAudioJournal.pcmSuffix}')).length(),
          64);
      expect(
          File(at('rec-bad${RetainedAudioJournal.quarantineSuffix}'))
              .existsSync(),
          isTrue);
      expect(
          File(at('rec-bad${RetainedAudioJournal.manifestSuffix}'))
              .existsSync(),
          isFalse);
    });

    test('a manifest from a newer format version is quarantined, not guessed',
        () async {
      await putPcm('rec-future', 64);
      await putManifest('rec-future', <String, Object?>{
        ...manifestJson('rec-future', 64),
        'formatVersion': RecordingManifest.currentFormatVersion + 1,
      });

      final RecordingScan s =
          (await RetainedAudioJournalScan.scan(dirPath: tmp.path)).single;
      expect(s.quarantined, isTrue);
      expect(await File(at('rec-future${RetainedAudioJournal.pcmSuffix}'))
          .length(), 64);
    });
  });

  group('commit_order_test (fault injection on a fake clock)', () {
    test(
        'dying between any two commit steps never claims more than the PCM '
        'has without the marker', () async {
      // The journal performs a bounded number of filesystem ops per commit;
      // kill it at each one in turn and re-scan the wreckage.
      for (int deathOp = 1; deathOp <= 8; deathOp++) {
        final _FaultFs fs = _FaultFs();
        final RetainedAudioJournal j = await RetainedAudioJournal.open(
          dirPath: '/j',
          recordingId: 'rec-crash',
          fs: fs,
          commitInterval: const Duration(days: 1),
        );
        // A clean first commit, so there is a previous manifest to fall back
        // to — the interesting failures are the ones that must not corrupt it.
        await j.appendPcm(pcm(200));
        await j.commit();
        expect(j.committedClaimBytes, 200);

        fs.resetCounter();
        fs.dieAtOp = deathOp;
        await j.appendPcm(pcm(200));
        await j.commit();
        // The process is "gone": no close, no further commits.

        fs.dieAtOp = -1;
        final List<RecordingScan> scans =
            await RetainedAudioJournalScan.scan(dirPath: '/j', fs: fs);
        expect(scans, hasLength(1),
            reason: 'death at op $deathOp lost the recording entirely');
        final RecordingScan s = scans.single;

        // 🔴 THE INVARIANT. A claim above the observed length is only ever
        // acceptable when the scan has SAID SO — otherwise the manifest is a
        // lie a downstream reader would treat as a coordinate.
        if (s.committedClaim > s.observedLength) {
          expect(s.claimAheadOfObserved, isTrue,
              reason: 'death at op $deathOp produced claim ${s.committedClaim} '
                  '> observed ${s.observedLength} with no marker; ops were '
                  '${fs.log}');
        }
        expect(s.verifiedRecoverableRange.end,
            lessThanOrEqualTo(s.observedLength),
            reason: 'death at op $deathOp offered bytes that are not there');
        expect(s.quarantined, isFalse,
            reason: 'death at op $deathOp left an unparsable manifest — the '
                'temp-file + rename publish is supposed to make that '
                'impossible');
      }
    });

    test('a commit that dies leaves the PREVIOUS manifest standing', () async {
      final _FaultFs fs = _FaultFs();
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: '/j',
        recordingId: 'rec-prev',
        fs: fs,
        commitInterval: const Duration(days: 1),
      );
      await j.appendPcm(pcm(200));
      await j.commit();
      await j.appendPcm(pcm(200));
      fs.resetCounter();
      fs.dieAtOp = 2; // inside the manifest publish
      await j.commit();

      // Under-claiming is the safe direction (A3-3): the file has 400 bytes,
      // the manifest still says 200, and the tail is offered as unverified.
      fs.dieAtOp = -1;
      final RecordingScan s =
          (await RetainedAudioJournalScan.scan(dirPath: '/j', fs: fs)).single;
      expect(s.observedLength, 400);
      expect(s.committedClaim, lessThanOrEqualTo(400));
      expect(s.claimAheadOfObserved, isFalse);
    });
  });

  group('partial_append_measured_test (an append that threw HALF WAY)', () {
    test(
        'the hole starts where the file really ends, and the claim never '
        'covers a byte the same manifest calls missing', () async {
      final _FaultFs fs = _FaultFs();
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: '/j',
        recordingId: 'rec-partial',
        fs: fs,
        commitInterval: const Duration(days: 1),
      );
      await j.appendPcm(pcm(100, fill: 1));
      // 40 of the next 100 land, then the write throws.
      fs.nextAppendPartialBytes = 40;
      expect(await j.appendPcm(pcm(100, fill: 2)), isFalse);
      await j.commit();

      final int onDisk = fs.files['/j/rec-partial.pcm']!.length;
      expect(onDisk, 140, reason: 'the platform kept the 40 bytes it took');

      // The claim is measured from the file, so it moves to 140 either way.
      expect(j.committedClaimBytes, lessThanOrEqualTo(onDisk));

      final JournalHole hole = j.holes.single;
      // 🔴 THE DISCRIMINATING ASSERTION. Before the fix the catch recorded the
      // hole from the STALE offset (start 100, length 100) while the commit
      // claimed 140 - so the manifest simultaneously claimed bytes 100..140
      // and listed them as missing. Two answers to 「is this byte here」, which
      // is the coordinate version of this repo's headline defect shape.
      expect(hole.start, 140);
      expect(hole.length, 60);
      expect(j.committedClaimBytes, lessThanOrEqualTo(hole.start));

      // And the baseline is honest again: a clean append after the failure is
      // measured against the real length, so a LATER short write is still
      // detectable rather than swallowed by an inflated delta.
      expect(await j.appendPcm(pcm(20, fill: 3)), isTrue);
      await j.commit();
      expect(j.observedBytes, 160);
      expect(j.committedClaimBytes, 160);
      expect(j.holes.length, 1);
      await j.close();
    });
  });
}
