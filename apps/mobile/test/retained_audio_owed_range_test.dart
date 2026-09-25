// Card RC-3b — THE OWED RANGE OF ONE RECORDING, AS THE RECOVERY SCAN READS IT.
//
// RC-3 gave the manifest one fact, 「bytes before this are already words」
// (`transcribedPrefixBytes`), and the owed range ran from there to the end. An
// engine that COMES BACK mid-recording leaves a stretch in the middle that no
// engine heard (the relay's ring had evicted it), so the range needs an end:
// `owedRangeEndBytes`. These cases pin how the two combine, on the scan the
// recovery queue actually runs (no session, no rig), including the rule for a
// second owed stretch in the same recording: the range WIDENS — nothing owed
// is ever left outside it, at the price of re-feeding what lies between.
//
// SPEC-REF: docs/strategy/2026-09-24-cr12e-defects-root-cause.md §5 RC-3;
//   the RC-3b card (the engine-back half RC-3 left open).

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/temp_teardown.dart';

/// 200 ms at 16 kHz mono s16le.
const int _frame = 6400;

void main() {
  late Directory dir;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('flowmic-rc3b-range-');
  });
  tearDown(() async => removeTempDir(dir));

  Future<RecordingScan> write(void Function(RetainedAudioJournal j) mark,
      {int frames = 50}) async {
    final RetainedAudioJournal j =
        await RetainedAudioJournal.open(dirPath: dir.path, recordingId: 'rec');
    await j.appendPcm(makePcm(_frame * frames));
    mark(j);
    await j.close();
    return (await RetainedAudioJournalScan.scan(dirPath: dir.path)).single;
  }

  test('no owed stretch: the whole recording, as before RC-3', () async {
    final RecordingScan s = await write((_) {});
    expect(s.verifiedRecoverableRange.start, 0);
    expect(s.verifiedRecoverableRange.end, _frame * 50);
  });

  test('a tail (RC-3): from the prefix to the end', () async {
    final RecordingScan s = await write((j) => j.setTranscribedPrefix(_frame * 20));
    expect(s.verifiedRecoverableRange.start, _frame * 20);
    expect(s.verifiedRecoverableRange.end, _frame * 50);
    expect(s.manifest!.owedRangeEndBytes, isNull);
  });

  test('🔴 a middle stretch (RC-3b): only that stretch, not the live words after it',
      () async {
    final RecordingScan s = await write((j) => j.setOwedRange(_frame * 10, _frame * 25));
    expect(s.verifiedRecoverableRange.start, _frame * 10);
    expect(s.verifiedRecoverableRange.end, _frame * 25,
        reason: 'without the end, the recovery re-feeds every live row after '
            'the stretch and they come back twice');
  });

  test('a middle stretch starting at byte 0 is still a middle stretch', () async {
    final RecordingScan s = await write((j) => j.setOwedRange(0, _frame * 5));
    expect(s.verifiedRecoverableRange.start, 0);
    expect(s.verifiedRecoverableRange.end, _frame * 5);
  });

  test('an end past what is on disk is capped at what is on disk', () async {
    final RecordingScan s = await write((j) => j.setOwedRange(_frame * 10, _frame * 90));
    expect(s.verifiedRecoverableRange.end, _frame * 50);
  });

  // ⚠️ 更正（RC-K，2026-09-24）：the three cases below were 「two middle
  // stretches WIDEN to cover both」, 「a tail after a middle stretch takes the
  // range to the end」 and 「a middle stretch after a tail does not shorten it」
  // — the RC-3b rule, whose price (the live words between two stretches fed
  // again and returned twice, the head long by the gap) is NR-100. Each stretch
  // is now its own range; the scan feeds the first still owed and counts all.
  test('🔴 RC-K: two middle stretches stay two — the next is the earlier one, '
      'and the audio between them is owed by neither', () async {
    final RecordingScan s = await write((j) {
      j.setOwedRange(_frame * 30, _frame * 35);
      j.setOwedRange(_frame * 10, _frame * 15);
    });
    expect(s.manifest!.owedRanges.map((OwedRange r) => (r.start, r.end)),
        <(int, int?)>[(_frame * 10, _frame * 15), (_frame * 30, _frame * 35)]);
    expect(s.verifiedRecoverableRange.start, _frame * 10);
    expect(s.verifiedRecoverableRange.end, _frame * 15);
    expect(s.owedStretches, 2);
    expect(s.recoverableBytes, _frame * 10, reason: '5 + 5 frames, not 25');
  });

  test('RC-K: a tail after a middle stretch is a second stretch to the end',
      () async {
    final RecordingScan s = await write((j) {
      j.setOwedRange(_frame * 10, _frame * 15);
      j.setTranscribedPrefix(_frame * 40);
    });
    expect(s.verifiedRecoverableRange.end, _frame * 15);
    expect(s.owedStretches, 2);
    expect(s.recoverableBytes, _frame * 5 + _frame * 10);
    // The envelope an older app reads: the RC-3b answer, never less.
    expect(s.manifest!.transcribedPrefixBytes, _frame * 10);
    expect(s.manifest!.owedRangeEndBytes, isNull);
  });

  test('RC-K: overlapping stretches merge (never fed twice); touching ones do not',
      () async {
    final RecordingScan s = await write((j) {
      j.setOwedRange(_frame * 10, _frame * 20, atMs: 1000);
      j.setOwedRange(_frame * 18, _frame * 25, atMs: 9000);
      j.setOwedRange(_frame * 25, _frame * 30, atMs: 20000);
    });
    expect(
        s.manifest!.owedRanges.map((OwedRange r) => (r.start, r.end, r.atMs)),
        <(int, int?, int?)>[
          (_frame * 10, _frame * 25, 1000),
          (_frame * 25, _frame * 30, 20000),
        ]);
  });

  test('RC-K: a stretch marked done is skipped; the next one is fed', () async {
    final RecordingScan s = await write((j) {
      j.setOwedRange(_frame * 10, _frame * 15);
      j.setOwedRange(_frame * 30, _frame * 35);
      j.markOwedRangeDone(_frame * 10, OwedRange.doneSettled);
    });
    expect(s.verifiedRecoverableRange.start, _frame * 30);
    expect(s.verifiedRecoverableRange.end, _frame * 35);
    expect(s.owedStretches, 1, reason: 'the last one: settles as a single range');
    expect(s.owedRange!.start, _frame * 30);
  });

  group('🔴 RC-K migration: a manifest written before the list', () {
    Future<RecordingScan> legacy(Map<String, Object?> extra) async {
      // The shape RC-3 / RC-3b wrote, byte for byte: the pair, no list.
      await File('${dir.path}/rec${RetainedAudioJournal.pcmSuffix}')
          .writeAsBytes(makePcm(_frame * 50));
      await File('${dir.path}/rec${RetainedAudioJournal.manifestSuffix}')
          .writeAsString(jsonEncode(<String, Object?>{
        'recordingId': 'rec',
        'format': const AudioJournalFormat().toJson(),
        'formatVersion': 1,
        'committedClaimBytes': _frame * 50,
        'interruptReason': 'none',
        'holes': <Object?>[],
        'attempts': <Object?>[],
        'resultRef': null,
        'cancelled': false,
        'settled': false,
        'configSnapshot': <String, Object?>{},
        'recoveryState': 'pending',
        ...extra,
      }));
      return (await RetainedAudioJournalScan.scan(dirPath: dir.path)).single;
    }

    test('an RC-3b middle range loads as ONE stretch, fed as before', () async {
      final RecordingScan s = await legacy(<String, Object?>{
        'transcribedPrefixBytes': _frame * 10,
        'owedRangeEndBytes': _frame * 25,
      });
      expect(s.formatMismatch, isFalse);
      expect(s.manifest!.owedRanges, hasLength(1));
      expect(s.verifiedRecoverableRange.start, _frame * 10);
      expect(s.verifiedRecoverableRange.end, _frame * 25);
      expect(s.owedStretches, 1);
      expect(s.owedRange!.atMs, isNull, reason: 'placement falls back as before');
    });

    test('an RC-3 tail loads as one stretch to the end', () async {
      final RecordingScan s =
          await legacy(<String, Object?>{'transcribedPrefixBytes': _frame * 20});
      expect(s.manifest!.owedRanges.single.end, isNull);
      expect(s.verifiedRecoverableRange.start, _frame * 20);
      expect(s.verifiedRecoverableRange.end, _frame * 50);
    });

    test('neither key: nothing owed on record ⇒ the whole recording', () async {
      final RecordingScan s = await legacy(<String, Object?>{});
      expect(s.manifest!.owedRanges, isEmpty);
      expect(s.verifiedRecoverableRange.start, 0);
      expect(s.verifiedRecoverableRange.end, _frame * 50);
    });

    test('re-encoded, it keeps the old pair for an older app', () async {
      final RecordingScan s = await legacy(<String, Object?>{
        'transcribedPrefixBytes': _frame * 10,
        'owedRangeEndBytes': _frame * 25,
      });
      final Map<String, Object?> j = s.manifest!.toJson();
      expect(j['transcribedPrefixBytes'], _frame * 10);
      expect(j['owedRangeEndBytes'], _frame * 25);
      expect(j['owedRanges'], isA<List<Object?>>());
    });
  });
}
