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
    await spill.flush();
    await store.dispose();
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  test('🔴 MEASURED: the segment key never returns to 0, but the server\'s does',
      () async {
    // The server resets `currentSegmentIdx = 0` in `start()` — once per audio
    // session (apps/server-core/src/stt/orchestrator-core.ts:193, and
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

  test('MEASURED: `settleSegment` has no production caller — and that is '
      'CORRECT today, which is the opposite of what it looks like', () async {
    //   grep -rn 'settleSegment' apps/mobile --include=*.dart
    //     → lib/src/audio/retained_audio_spill.dart   (the definition)
    //     → test/retained_audio_test.dart                (two tests)
    //     → and nothing else                             [measured 2026-08-29]
    //
    // 🔴 THE LINE NUMBERS WERE DROPPED, DELIBERATELY. They were re-measured once
    // on 2026-08-30 and were already stale again by the end of the same round —
    // both files changed twice. The GREP is the evidence; a coordinate is only
    // a way to find it, and a stale one is worse than none because it reads as
    // precision. Same rule this repo applies to a number written into a
    // contract document: go and run it.
    //
    // 🔴 I NEARLY FILED THIS AS A FAÇADE. An unwired mechanism that the store's
    // own header calls 「SETTLE ⇒ DELETE IS THE ENFORCEMENT OF THAT BOUNDARY,
    // NOT AN OPTIMIZATION」 is this repo's most familiar defect shape, and the
    // grep above is exactly the evidence that shape is usually reported on.
    //
    // The obvious caller would be 「a final arrived for segment N ⇒ settle N」.
    // IT WOULD DELETE AUDIO THAT WAS NEVER TRANSCRIBED. Retained bytes are, by
    // construction, the bytes the server did NOT receive — chunks that aged out
    // of the ring during an outage plus the tail `retainUnsentTail` sweeps up.
    // A `stt:final` describes what the server DID receive. The two are disjoint
    // by definition, so settling on a final would destroy precisely the audio
    // this layer exists to keep.
    //
    // ⇒ the legitimate producer is the re-transcription channel (card CR-5):
    // retained bytes get re-fed, produce their OWN final, and settle then means
    // what it says. The mechanism is not forgotten, it is waiting.
    //
    // ⚠️ WHAT IS STILL TRUE AND SHOULD BE SAID OUT LOUD: until CR-5 lands, the
    // only two ways out of this directory are cap eviction and the 24 h TTL, so
    // the header's 「the instant the segment has been transcribed」 describes an
    // intent rather than today's behaviour. With CR-3 raising the ceiling to
    // 30 minutes, that is now tens of MB living on the phone for a day.
    //
    // ⇒ 「no production caller」 is a QUESTION, not a verdict. The verdict
    // depends on what the caller would have to be, and here it would be wrong.
    spill.noteUplinkDown();
    spill.noteSegmentObserved(0);
    spill.onEvicted(_chunk(1, 300));
    await spill.flush();
    expect(await spill.pendingSegments(), <int>[0]);

    // The mechanism itself is fine — when it IS called it does exactly what it
    // promises. The gap is the wiring, not the code.
    await spill.settleSegment(0);
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
