// Card LK-1 — THE OTHER HALF OF THE NEW STATE: WHEN DO THESE BYTES LEAVE.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md §Chose 4 (O-2: UNRECOVERED audio is exempt from the TTL)
//   apps/mobile/lib/src/audio/retained_audio_policy.dart — the sweep
//   apps/mobile/lib/src/session/live_settle.dart — who writes the state
//
// 🔴 WHY THIS IS NOT IN `live_settle_test.dart`. That file drives real presses
// and asserts on the settle; this one asserts on a CLOCK, which needs manifests
// written straight to disk and a store whose `now` can be moved. Both halves
// are needed and neither proves the other: a state nothing sweeps is a slow
// leak, and a sweep for a state nothing writes is dead code.
//
// ⚠️ THE MANIFESTS BELOW ARE HAND-WRITTEN JSON, ON PURPOSE. The sweep reads
// what a PREVIOUS build left on disk, so a fixture built through today's writer
// would only ever prove the round trip. `live_settle_test.dart`'s LK-1 cases
// are what pin the writer to this same spelling.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/temp_teardown.dart';

void main() {
  late Directory tmp;
  late int fakeNow;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('flowmic-lk1-sweep-');
    fakeNow = DateTime.now().millisecondsSinceEpoch;
  });

  tearDown(() async {
    await removeTempDir(tmp);
  });

  String pcmPath(String id) =>
      '${tmp.path}${Platform.pathSeparator}$id${RetainedAudioJournal.pcmSuffix}';
  String manifestPath(String id) => '${tmp.path}${Platform.pathSeparator}'
      '$id${RetainedAudioJournal.manifestSuffix}';

  /// One recording on disk, in the given queue state.
  Future<void> write(String id, {required String recoveryState}) async {
    await File(pcmPath(id)).writeAsBytes(makePcm(4000), flush: true);
    await File(manifestPath(id)).writeAsString(
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
          // 🔴 `settled` is FALSE on every fixture here. The point of the card
          // is that these bytes become sweepable WITHOUT the A5-3 flag, which
          // is reserved for a proof this server cannot give.
          'settled': false,
          'recoveryState': recoveryState,
          'resultRef': 'row-1',
        }),
        flush: true);
  }

  Future<void> sweepAt(Duration age) async {
    final RetainedAudioStore store = RetainedAudioStore(
      dir: tmp,
      ttl: RetainedAudioStore.kDefaultTtl,
      clock: () => fakeNow,
    );
    await store.open();
    addTearDown(store.dispose);
    // The sweep compares its injected clock against the file's REAL mtime, so
    // the age is made by moving `now`, never by back-dating the file.
    fakeNow = DateTime.now().millisecondsSinceEpoch + age.inMilliseconds;
    await store.sweep();
    await pumpEventQueue();
  }

  test('transcribed_unverified audio is NOT swept at 23 hours', () async {
    await write('rec-tu-young',
        recoveryState: RecordingManifest.recoveryStateTranscribedUnverified);

    await sweepAt(const Duration(hours: 23));

    expect(File(pcmPath('rec-tu-young')).existsSync(), isTrue,
        reason: 'the TTL is 24 h and it is measured, not approximated');
    expect(File(manifestPath('rec-tu-young')).existsSync(), isTrue);
  });

  test('and IS swept one second past 24 hours', () async {
    await write('rec-tu-old',
        recoveryState: RecordingManifest.recoveryStateTranscribedUnverified);

    await sweepAt(const Duration(hours: 24, seconds: 1));

    expect(File(pcmPath('rec-tu-old')).existsSync(), isFalse,
        reason: 'the words are in the timeline; these bytes are ballast');
    expect(File(manifestPath('rec-tu-old')).existsSync(), isFalse);
  });

  test('🔴 settled_unverified audio of the same age is left alone', () async {
    // THE CONTROL THAT KEEPS THE CHANGE HONEST. `settled_unverified` means
    // something about THIS recording could not be confirmed, which is owner
    // ruling O-2's exempt case. If this ever goes green the new state has
    // stopped being a narrowing and become a hole.
    await write('rec-su', recoveryState: 'settled_unverified');

    await sweepAt(const Duration(days: 30));

    expect(File(pcmPath('rec-su')).existsSync(), isTrue);
    expect(File(manifestPath('rec-su')).existsSync(), isTrue);
  });

  test('🔴 an unrecovered (pending) recording is left alone forever', () async {
    await write('rec-pending', recoveryState: 'pending');

    await sweepAt(const Duration(days: 30));

    expect(File(pcmPath('rec-pending')).existsSync(), isTrue,
        reason: 'nobody has these words - O-2 exempts exactly this');
  });
}
