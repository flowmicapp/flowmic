// Card CR-4 — the hazard, and the fix that closed it.
//
// 🔴 THIS FILE WAS RE-JUDGED, NOT DELETED (2026-08-30, CR-4's second half).
// It was written to MEASURE a defect, so its central assertion asserted the
// DEFECT: two runs' audio concatenating into one 420-byte file. The fix turns
// that assertion red, which is the correct outcome and the exact moment a
// pinning test is most often quietly removed. It is kept, pointed at the new
// contract, and its measurement is preserved verbatim below the assertion — the
// same rule C11 sets for its sibling guard, and the same reason: a test that
// recorded WHY something was built is the only place that reason survives.
//
// The original question: segment files were named `seg-<idx>.pcm` with no session in the
// name, `open()` adopts whatever is already in the directory, and `append` uses
// `FileMode.append`. Segment indices restart per session. So what happens when
// a previous run died with retained audio still on disk and a new session
// reaches the same index?
//
// The answer was: they concatenate. The remaining half of CR-4 gave the files
// the dimension their key was missing — the SESSION — and this file now holds
// that door shut.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/temp_teardown.dart';

void main() {
  late Directory tmp;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('flowmic-orphan-');
  });

  tearDown(() async {
    await removeTempDir(tmp);
  });

  test('🔴 CR-4: a new session CANNOT reach the previous run\'s orphan', () async {
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

    // 🔴 THE FIX, ASSERTED AT THE POINT THE DEFECT USED TO SHOW.
    //
    // Both runs wrote 「segment 0」, and each run reads back ONLY its own audio.
    // Before CR-4's second half this was 420 — 300 orphaned bytes and the new
    // session's 120 in one file, handed to the recovery feed as a single
    // stretch of speech that two different sittings had produced.
    expect(seg0!.length, 120,
        reason: 'run 2 must read its own 120 bytes, never the orphan behind them');

    // POSITIVE CONTROL — the orphan is still THERE, untouched. Without this the
    // assertion above would also pass on an implementation that simply deleted
    // whatever it found, which loses the audio instead of mis-attributing it.
    expect(run2.retainedBytes, 420,
        reason: 'the directory still holds both — they are two files now, not one');
    final List<String> sessions = await run2.pendingSessions();
    expect(sessions, hasLength(2),
        reason: 'two runs, two session keys — that IS the fix');
    await run2.dispose();

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
    //
    // ✅ AND THAT IS WHAT WAS BUILT. Every retained file is now named
    // `<session>__seg-<idx>.pcm`, the session defaulting to a PER-RUN key, so
    // two runs cannot collide — not 「are unlikely to」, cannot. A continuous
    // recording overrides that key with its ARTICLE ID, so the same string names
    // 「which recording」 for the rows and for the bytes, which is what lets the
    // re-transcription channel file recovered audio without a second table.
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
    // ⚠️ STILL TRUE AFTER THE FIX, and it still matters. Identity stops the
    // orphan being MIS-ATTRIBUTED; it does not make it disappear, and the sweep
    // is still the only thing that eventually reclaims it. Two mechanisms, two
    // jobs — reading this test as 「CR-4 handles orphans」 would be wrong.
    expect(run2.retainedBytes, 300,
        reason: 'the orphan is far younger than kDefaultTtl, so the sweep '
            'correctly leaves it alone — it is a 24 h backstop against audio '
            'nobody can ever claim, not a session boundary');
    await run2.dispose();
  });
}
