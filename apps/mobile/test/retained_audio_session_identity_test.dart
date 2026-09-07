// Card CR-4 — the retained layer's session handling: the measurement, and the
// fix that answered it.
//
// 🔴 ONE CASE HERE WAS RE-JUDGED, NOT DELETED (2026-08-30). It measured two
// recordings' offline audio landing in ONE file and asserted 420 bytes; the fix
// makes that red, which is the correct outcome and the moment such a test is
// usually quietly removed. It now guards the new contract with its measurement
// kept beside it. Same rule C11 sets for the copy guard.
//
// Companion to `retained_audio_orphan_adoption_test.dart`, which measured what
// happens ACROSS app runs. This one measures what happens across SESSIONS
// inside one run, and what happens to the settle path.
//
// The other cases still record what the code does today and assert no fix —
// nothing here is a bug report until it is a passing measurement.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/audio/ring_buffer.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/temp_teardown.dart';

BufferedChunk _chunk(int seq, int bytes) => BufferedChunk(
      seq: seq,
      tsMs: seq * 200,
      payload: Uint8List(bytes),
    );

void main() {
  late Directory tmp;
  late RetainedAudioStore store;
  late RetainedAudioSpill spill;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('flowmic-sessid-');
    store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    spill = RetainedAudioSpill(store: store);
  });

  tearDown(() async {
    await spill.dispose();
    await store.dispose();
    await removeTempDir(tmp);
  });

  test('🔴 MEASURED: the segment key never returns to 0, but the server\'s does',
      () async {
    // The server resets `currentSegmentIdx = 0` in `start()` — once per audio
    // session (apps/server-core/src/stt/orchestrator-core.ts:216, and
    // text-merge.ts says start() and the rollover are the only two writers).
    //
    // The phone's copy is MONOTONIC. Its guard exists for a good reason, stated
    // at `noteSegmentObserved`: a late or replayed frame carrying an older
    // index must not walk the key backwards onto a segment that already closed.
    //
    // But a new session's segment 0 is not a late frame. It is the same value
    // arriving for a different reason, and the guard cannot tell them apart.
    spill.noteSegmentObserved(0);
    spill.noteSegmentObserved(1);
    spill.noteSegmentObserved(2);
    expect(spill.currentSegmentIdx, 2);

    // A second session starts. The server is now emitting segment 0 again.
    spill.noteSegmentObserved(0);

    expect(spill.currentSegmentIdx, 2,
        reason: 'the phone stays on the PREVIOUS session\'s last index, so '
            'this session\'s retained audio is filed under a segment number '
            'that belongs to a session that has ended');
  });

  test('🔴 CR-4: two recordings in one run no longer share a file', () async {
    // The cross-run version of this needs the app to die. This one does not:
    // it is just two recordings in a row, both with the link down.
    spill.noteUplinkDown();
    spill.noteSegmentObserved(0);
    spill.onEvicted(_chunk(1, 300)); // recording one
    await spill.flush();
    final String first = spill.sessionKey;

    // Recording two. In production this boundary is drawn by `pttDown`, which
    // rolls the key on every press that is not continuing a recording; here it
    // is drawn directly, because this file is about the STORE's behaviour.
    spill.endSession();
    spill.noteSegmentObserved(0);
    spill.onEvicted(_chunk(1, 120)); // recording two
    await spill.flush();

    // 🔴 THE FIX, AT THE POINT THE DEFECT USED TO SHOW. Both recordings wrote
    // 「segment 0」; each reads back only its own. Before CR-4's second half this
    // was ONE file of 420 bytes — two separate recordings concatenated, and
    // indistinguishable to anything downstream.
    expect((await spill.readSegment(0))!.length, 120,
        reason: 'this recording reads its own 120 bytes');
    expect((await store.read(0, session: first))!.length, 300,
        reason: 'positive control: the first recording is still there, whole');
    expect(await store.pendingSessions(), hasLength(2));
    // And the segment INDEX is still the server's own, unchanged: identity was
    // the missing dimension, not a replacement for the one that was there.
    expect(await spill.pendingSegments(), <int>[0]);
  });

  test('MEASURED: the verb that used to sit here is GONE, and the reasoning '
      'that kept it waiting is what deleted it', () async {
    //   grep -rn 'settleSegment' apps/mobile --include=*.dart
    //     → nothing                                    [measured 2026-09-06]
    //
    // 🔴 WHAT THIS TEST USED TO SAY, AND WHY IT WAS RIGHT. `RetainedAudioSpill
    // .settleSegment(int)` had no production caller. The obvious one would be
    // 「a final arrived for segment N ⇒ settle N」, and it WOULD DELETE AUDIO
    // THAT WAS NEVER TRANSCRIBED: on the legacy face, retained bytes are by
    // construction the bytes the server did NOT receive (chunks that aged out
    // during an outage, plus the tail `retainUnsentTail` sweeps up), while a
    // `stt:final` describes what it DID receive. Disjoint by definition. So the
    // verdict was 「waiting, not forgotten」 — waiting for the re-transcription
    // channel to produce its OWN final.
    //
    // 🔴 WHAT CHANGED IS WHICH FACE OWNS THE ANSWER, NOT THAT ARGUMENT. Card
    // LS-1b wired the live settle on the JOURNAL face, where the unit is the
    // whole recording and the trigger is a three-condition predicate
    // (`session/recovery_settle.dart`), not a final on its own. That left the
    // per-segment verb with no caller it could ever correctly have, so audit
    // item E25 is closed by DELETING it rather than by wiring it.
    //
    // ⇒ 「no production caller」 was a QUESTION here, and this is the answer it
    // eventually got. The store's own `settle(idx, session:)` is untouched and
    // still has its caller (`backfill_runner.dart`, after re-feeding).
    spill.noteUplinkDown();
    spill.noteSegmentObserved(0);
    spill.onEvicted(_chunk(1, 300));
    await spill.flush();
    expect(await spill.pendingSegments(), <int>[0]);

    // The store's verb still does exactly what it promises; what went away is
    // the spill-level wrapper that nothing could correctly call.
    await store.settle(0);
    expect(await spill.pendingSegments(), isEmpty);
    expect(store.retainedBytes, 0);
  });

  test('⇒ therefore `pendingSegments()` does not today mean what its doc says',
      () async {
    // Its doc: 「segments whose audio no final has claimed」. With nothing
    // calling settle, a segment whose final DID arrive stays in this list, so
    // the list today means 「segments whose audio has not aged out yet」.
    //
    // 🔴 THIS IS THE CORRECTION TO MY OWN §11-d, which read the mechanism and
    // reported its intended meaning as its behaviour. The conclusion there
    // survives — the filesystem is the right ledger and a parallel state table
    // would be a second answer — but 「both survive a restart by construction」
    // was describing a transition production does not perform.
    //
    // ⇒ and it is the same law it cites, applied to me: a contract being
    // written correctly is not evidence that the implementation does it.
    spill.noteUplinkDown();
    spill.noteSegmentObserved(0);
    spill.onEvicted(_chunk(1, 300));
    await spill.flush();

    // A final arrives for segment 0 — the real inbound path calls
    // `noteSegmentObserved`, and that is ALL it calls.
    spill.noteSegmentObserved(0);

    expect(await spill.pendingSegments(), <int>[0],
        reason: 'the final has been observed and the audio is still listed as '
            'unclaimed');
  });
}
