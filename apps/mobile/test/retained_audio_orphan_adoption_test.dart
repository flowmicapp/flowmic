// Card CR-4 — MEASURING a hazard before designing against it.
//
// Question: segment files are named `seg-<idx>.pcm` with no session in the
// name, `open()` adopts whatever is already in the directory, and `append` uses
// `FileMode.append`. Segment indices restart per session. So what happens when
// a previous run died with retained audio still on disk and a new session
// reaches the same index?
//
// This file does not assert a fix. It records what the code does today, so the
// remaining half of CR-4 is designed on a measurement instead of on a reading.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory tmp;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('flowmic-orphan-');
  });

  tearDown(() {
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  test('🔴 MEASURED: a new session APPENDS ONTO the previous run\'s orphan',
      () async {
    // Run 1: an outage retains 300 bytes for segment 0, then the app dies —
    // nothing settles, so the file survives.
    final RetainedAudioStore run1 =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await run1.open();
    await run1.append(segmentIdx: 0, bytes: Uint8List(300));
    await run1.dispose();

    // Run 2: a brand-new session, minutes later. Its own segment counter starts
    // at 0 like every session's does.
    final RetainedAudioStore run2 =
        RetainedAudioStore(dir: tmp, clock: () => 60 * 1000);
    await run2.open();
    expect(run2.retainedBytes, 300,
        reason: 'open() adopts the orphan rather than starting clean');
    await run2.append(segmentIdx: 0, bytes: Uint8List(120));

    final Uint8List? seg0 = await run2.read(0);
    await run2.dispose();

    // 🔴 THE MEASUREMENT. Two different sessions' audio is now one file, and
    // nothing downstream can tell where one ends and the other begins: the
    // recovery feed hands `read(0)` to the transcription path as a single
    // stretch of speech.
    expect(seg0!.length, 420,
        reason: 'today the two runs concatenate — 300 orphaned bytes plus the '
            'new session\'s 120');

    // ── WHY THIS MATTERS MORE NOW THAN IT USED TO ─────────────────────────
    //
    // Before card CR-3 an orphan was at most the unsent tail of one utterance —
    // a second or two of audio, landing at the head of a later utterance.
    // Wrong, but small enough to look like a glitch.
    //
    // CR-3 keeps the microphone open through a link death for continuous
    // sessions, and owner's tier ceiling allows 30 minutes. So an orphan can
    // now be TENS OF MINUTES of somebody's meeting, and it does not merely
    // corrupt a segment: it lands inside a DIFFERENT article, attributed to a
    // session that was not running when those words were said.
    //
    // The TTL sweep does not cover this. It removes files older than 24 h
    // (`kDefaultTtl`); an app killed five minutes ago leaves an orphan the
    // sweep will correctly decline to touch.
    //
    // ⇒ the fix belongs in CR-4 and it is NOT the parallel state table the card
    // assumed. The filesystem is already the ledger — `pendingSegments()` is
    // 「segments whose audio no final has claimed」, `settle` is delete, and
    // both survive a restart by construction. What is missing is not STATE, it
    // is IDENTITY: these files do not say whose they are.
  });

  test('the TTL sweep does not save us — it is not supposed to', () async {
    final RetainedAudioStore run1 =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await run1.open();
    await run1.append(segmentIdx: 0, bytes: Uint8List(300));
    await run1.dispose();

    // Five minutes later, which is the realistic gap.
    final RetainedAudioStore run2 = RetainedAudioStore(
      dir: tmp,
      clock: () => 5 * 60 * 1000,
    );
    await run2.open();
    await run2.sweep();
    expect(run2.retainedBytes, 300,
        reason: 'the orphan is far younger than kDefaultTtl, so the sweep '
            'correctly leaves it alone — it is a 24 h backstop against audio '
            'nobody can ever claim, not a session boundary');
    await run2.dispose();
  });
}
