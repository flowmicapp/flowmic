// Card LS-0 — the three gaps the audio-durability plan exists to close,
// written as tests BEFORE the code that closes them.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     E7 (spill predicate is the link, not the engine), E13 (TTL sweeps by
//     mtime and ignores whether the audio was ever recovered), E12 (cap
//     eviction deletes the oldest unrecovered audio), A10 card LS-0
//
// 🔴 EVERY TEST IN THIS FILE WAS `skip:`-ed AND EACH ONE QUOTES ITS OWN RED
// OUTPUT. They are not aspirations: each was run un-skipped on this branch,
// against the production code of the day, and the exact failure text is copied
// into the comment above it. Cards LS-2/LS-3 (E12/E13) and RC-1 (E7) turned
// them green; each `skip:` was deleted, never the assertion. NOTHING IN THIS
// FILE IS SKIPPED ANY MORE.
//
// ── STATUS AFTER CARDS LS-2 / LS-3 (2026-09-06) ─────────────────────────────
//   (b) E13 — GREEN. The sweep now reads a manifest and takes only what
//       settled; a legacy segment file has none, so it is never swept.
//   (c) E12 — GREEN. The cap refuses new bytes and announces; the eviction
//       path is gone from the source, not merely unreached.
//   (a) E7  — GREEN SINCE CARD RC-1 (2026-09-06), AND UN-SKIPPED. What blocked
//       it was never the assertion, it was the CONSTRUCTION: this case built
//       the default spill, the default was the legacy segment face, and on
//       that face a healthy uplink really does mean zero bytes. RC-1 made
//       first-frame retention the shipped default
//       (`kRetainFromFirstFrameDefault`, audio/retained_audio_boot.dart), so
//       the default construction now writes the journal and the sentence E7
//       always made — "the engine died, the socket was fine, the audio must
//       be on disk" — is finally true of what ships.
//
//       🔴 IT IS KEPT EVEN THOUGH `retained_audio_first_frame_test.dart` MAKES
//       THE SAME MEASUREMENT. That file asserts the ON face by passing `true`
//       explicitly; this one asserts THE DEFAULT, and those are two different
//       claims — the first stays green if somebody flips the default back.
//       Keeping it is also the LS-0 record: a case that was written red,
//       quoted its own failure, and is now green against production.
//
// ⚠️ WHY SKIPPED RATHER THAN LEFT RED. A red test nobody has authority to fix
// this round becomes background noise, and this repo has already paid for a
// gate that was red on the day it was added (verify:clippy, CLAUDE.md). The
// `skip:` reason names the card that owes the fix, so the debt has an address.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_boot.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/temp_teardown.dart';

void main() {
  late Directory tmp;
  late FakeAudioRecorder rec;
  int fakeNow = 0;
  int fakeMicros = 0;

  Uint8List chunkFor(int i) => makePcm(6400, amplitude: 1000 + i);

  setUp(() async {
    fakeNow = 0;
    fakeMicros = 0;
    rec = FakeAudioRecorder();
    tmp = await Directory.systemTemp.createTemp('flowmic-ls0-');
  });

  tearDown(() async {
    await removeTempDir(tmp);
  });

  // ── (a) E7 ────────────────────────────────────────────────────────────────
  //
  // The single largest hole in the original design: the ONLY predicate for
  // writing audio to disk was `uplinkUp == false`, and `uplinkUp` is written
  // exclusively by the socket status edge. When the socket is healthy and the
  // recognition provider is the thing that died, not one byte was retained —
  // the user's words existed only in a 30 s ring that then evicted them.
  //
  // RED OUTPUT (run un-skipped on this branch, 2026-09-06, before RC-1):
  //   Expected: not null
  //     Actual: <null>
  //     Which: is null
  //   the engine failed while the socket stayed up, so the ring's audio is
  //   the only copy left and it must be on disk
  //
  // 🔴 THE CONSTRUCTION IS THE ASSERTION HERE. The spill is built with
  // `kRetainFromFirstFrameDefault` — the SAME symbol `openRetainedAudioSpill`
  // defaults to — rather than with a literal `true`. A literal would keep this
  // case green through a rollback of the default, which is exactly the state
  // it exists to catch. MEASURED 2026-09-06 (reverse control for card RC-1):
  // setting that constant to `false` turns this case red with
  //   Expected: not null
  //     Actual: <null>
  //   the default construction must open a journal at all
  // — i.e. it fails one assertion earlier than the bytes, because a legacy
  // default never opens a journal at all. Restored, and green again.
  //
  // ⚠️ It drives `AudioCapture`, not `spill.onEvicted`, because eviction is no
  // longer a storage trigger under the shipped face: the bytes are written when
  // they are CAPTURED. Driving the retired trigger would measure a path the
  // product does not take.
  test(
    'provider failure with a healthy socket still puts the audio on disk',
    () async {
      final RetainedAudioStore store =
          RetainedAudioStore(dir: tmp, clock: () => fakeNow);
      await store.open();
      final RetainedAudioSpill spill = RetainedAudioSpill(
        store: store,
        retainFromFirstFrame: kRetainFromFirstFrameDefault,
        clock: () => ++fakeMicros,
      );
      addTearDown(store.dispose);
      addTearDown(spill.dispose);

      final AudioCapture cap =
          AudioCapture(recorder: rec, spill: spill, clock: () => fakeNow);
      addTearDown(cap.dispose);
      await cap.start();

      // Deliberately NOT noteUplinkDown(): the socket is fine. This is the
      // whole scenario — the engine is what failed, and nothing tells this
      // layer about that. Also the positive control for the scenario itself: a
      // layer that still asked the uplink would write nothing from here on.
      expect(spill.uplinkUp, isTrue);
      for (int i = 0; i < 2; i++) {
        fakeNow = i * 200;
        rec.feed(chunkFor(i));
        await pumpEventQueue();
      }
      await spill.journalFlush();

      final String? id = spill.currentRecordingId;
      expect(id, isNotNull,
          reason: 'the default construction must open a journal at all');
      final File pcm = File('${tmp.path}${Platform.pathSeparator}'
          '$id${RetainedAudioJournal.pcmSuffix}');
      expect(
        await pcm.exists(),
        isTrue,
        reason: 'the engine failed while the socket stayed up, so the '
            'audio in the ring is the only copy left and it must be on disk',
      );
      expect(await pcm.length(), 2 * 6400,
          reason: 'every captured chunk, from the first frame');
    },
  );

  // ── (b) E13 ───────────────────────────────────────────────────────────────
  //
  // The TTL sweep deletes by file mtime and asks nothing about whether that
  // audio was ever recovered. A phone that was offline overnight loses the
  // recording it was holding precisely because it never managed to send it.
  //
  // RED OUTPUT (run un-skipped on this branch, 2026-09-06):
  //   Expected: not null
  //     Actual: <null>
  //     Which: is null
  //   this audio was never recovered, so the one thing the TTL must not do is
  //   delete it
  //
  // ✅ GREEN since card LS-3: _sweep reads manifests and takes only what says
  // `settled` (owner ruling O-2). This file has no manifest.
  test(
    'the TTL sweep leaves audio that was never recovered',
    () async {
      // 🔴 THE CLOCK MUST BE WALL-CLOCK-BASED HERE, NOT A BARE COUNTER.
      // sweep() compares its injected clock against the file's REAL mtime, so
      // a clock that starts at 0 makes every file look like it is from the
      // future and the sweep skips everything — a test that passes for a
      // reason that has nothing to do with the product. (Measured: the first
      // draft of this case was green against today's broken sweep.)
      final RetainedAudioStore store = RetainedAudioStore(
        dir: tmp,
        ttl: const Duration(hours: 24),
        clock: () => DateTime.now().millisecondsSinceEpoch + fakeNow,
      );
      await store.open();
      addTearDown(store.dispose);

      await store.append(segmentIdx: 0, bytes: chunkFor(0));
      expect(await store.read(0), isNotNull);

      // 25 hours later, and nobody ever transcribed it.
      fakeNow += const Duration(hours: 25).inMilliseconds;
      await store.sweep();

      expect(
        await store.read(0),
        isNotNull,
        reason: 'this audio was never recovered, so the one thing the TTL '
            'must not do is delete it',
      );
    },
  );

  // ── (c) E12 ───────────────────────────────────────────────────────────────
  //
  // Cap eviction drops the OLDEST file directory-wide. The oldest file is, by
  // construction, the one that has been waiting longest to be recovered — so
  // the budget is balanced by throwing away exactly the audio the layer exists
  // to protect. A5-2's answer is to stop promising, loudly, instead of
  // deleting.
  //
  // RED OUTPUT (run un-skipped on this branch, 2026-09-06):
  //   Expected: not null
  //     Actual: <null>
  //     Which: is null
  //   the cap must be balanced by refusing new bytes and saying so, not by
  //   deleting audio nobody has recovered yet
  //
  // ✅ GREEN since card LS-3: `_makeRoomFor` is deleted, so append() refuses
  // and announces instead of evicting (owner ruling O-2).
  test(
    'hitting the cap does not delete the oldest unrecovered audio',
    () async {
      final RetainedAudioStore store = RetainedAudioStore(
        dir: tmp,
        capBytes: 6400 * 2,
        clock: () => fakeNow,
      );
      await store.open();
      final List<RetainedAudioNotice> notices = <RetainedAudioNotice>[];
      store.notices.listen(notices.add);
      addTearDown(store.dispose);

      await store.append(segmentIdx: 0, bytes: chunkFor(0));
      fakeNow += 1000;
      await store.append(segmentIdx: 1, bytes: chunkFor(1));
      fakeNow += 1000;
      // This third chunk does not fit. Today the store makes room by deleting
      // segment 0.
      await store.append(segmentIdx: 2, bytes: chunkFor(2));

      expect(
        await store.read(0),
        isNotNull,
        reason: 'the cap must be balanced by refusing new bytes and saying '
            'so, not by deleting audio nobody has recovered yet',
      );
      expect(
        notices.map((RetainedAudioNotice n) => n.code),
        contains(RetainedAudioNotice.codeCapReached),
        reason: 'refusing is only acceptable if the user is told',
      );
    },
  );
}
