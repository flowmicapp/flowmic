// Card CR-4 (owner 2026-08-29) — the retained-audio budget, and the arithmetic
// it is derived from.
//
// SPEC-REF:
//   apps/mobile/lib/src/audio/retained_audio_store.dart (kUnrecoveredCapBytes)
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md §Chose 4 (owner ruling O-2: the independent 512 MiB cap,
//     and "on reaching it, stop promising -- never delete the old")
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.F (the measurement that made 64 MiB too small, and owner's ruling)
//   apps/server-core/src/billing/plans.ts (`continuous_minutes`, the ceiling
//     this is derived from — server-side, and unreachable from here)
//
// ── 🔴 WHAT THIS FILE CAN AND CANNOT PROMISE ────────────────────────────────
//
// The cap exists to survive the worst legal continuous recording: 30 minutes,
// entirely offline, at the capture format's fixed 32,000 bytes per second.
//
// 🔴 CARD LS-3 CHANGED WHAT REACHING IT MEANS, WHICH IS WHY THE NUMBER MOVED.
// The arithmetic below is the same shape it always was, but it used to be a
// number the store could always satisfy — it satisfied it by deleting the
// oldest audio in the directory. Owner ruling O-2 forbade that: unrecovered
// audio is exempt from eviction, so the cap is now a hard ceiling and the
// ruling set it at 512 MiB (≈9 worst-case recordings, not 2). A ceiling you
// cannot evict under has to be big enough that reaching it is an event.
//
// This test pins THAT arithmetic. It will go red if somebody shrinks the
// constant, changes the capture format, or trims the headroom away.
//
// It will NOT go red if the TIER CEILING rises — that number lives in
// `PLAN_LIMITS` on the server, the phone learns its own ceiling at runtime from
// `/api/cloud/summary`, and there is no build-time path between them. Saying so
// out loud is the point: a test whose limits are undeclared gets read as
// covering more than it does, and this repo has paid for that before. The other
// half of the guard is the sentence in the constant's own doc.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/temp_teardown.dart';

/// The capture format, fixed by AUDIO_DEFAULTS: PCM16 / 16 kHz / mono.
/// 16000 samples/s × 2 bytes = 32,000 B/s. The store transcodes nothing, so
/// this is exactly what lands on disk.
const int _bytesPerSecond = 32000;

/// `PLAN_LIMITS.continuous_minutes` on the max tier (owner 2026-08-29).
/// Hard-coded HERE on purpose rather than imported: there is nothing to import,
/// and pretending otherwise would hide the coupling this file exists to name.
const int _maxTierMinutes = 30;

/// 57,600,000 bytes.
const int _worstCaseSessionBytes = _maxTierMinutes * 60 * _bytesPerSecond;

void main() {
  test('🔴 the cap holds the worst legal session with real headroom', () {
    expect(
      RetainedAudioStore.kUnrecoveredCapBytes,
      greaterThanOrEqualTo(2 * _worstCaseSessionBytes),
      reason: 'A 30-minute recording that never reached the network is '
          '$_worstCaseSessionBytes bytes. The cap is the budget for the WHOLE '
          'directory — orphans from a previous run and un-expired TTL residue '
          'share it — so holding exactly one worst-case session is not enough. '
          'Two of them is the margin owner\'s ruling bought; at 64 MiB the '
          'worst case was 86% of the budget and one un-swept orphan directory '
          'could evict a live recording.',
    );
  });

  test('the ruled value, stated once so a silent re-cut is visible', () {
    // Owner ruling O-2, 2026-09-06. Was 128 MiB while the store could still
    // evict its way back under the line.
    expect(RetainedAudioStore.kUnrecoveredCapBytes, 512 * 1024 * 1024);
  });

  test('🔴 REVERSE CONTROL: the previous value would fail the headroom test',
      () {
    // Without this, the assertion above could be satisfied by a cap that had
    // never moved — it proves the bar is actually above where we used to be.
    expect(64 * 1024 * 1024, lessThan(2 * _worstCaseSessionBytes),
        reason: 'if this is ever false the headroom test has stopped '
            'discriminating and the first test is decoration');
  });

  test('the cap is enforced by REFUSING, not by deleting', () async {
    // The constant is only a number until something reads it. A tiny store
    // proves the plumbing.
    //
    // 🔴 THIS ASSERTION USED TO BE WEAKER THAN IT LOOKED, and card LS-3 is why
    // it is worth saying. It read "over-budget appends do not silently grow
    // the directory, and the drop is announced" — and it was green against a
    // store that stayed under budget by DELETING the caller's earlier audio,
    // which is the behaviour owner ruling O-2 then forbade. Staying under a
    // cap and keeping what you were given are two different promises; the
    // first test only ever checked the first one.
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-cap-');
    addTearDown(() async {
      await removeTempDir(tmp);
    });
    final List<RetainedAudioNotice> notices = <RetainedAudioNotice>[];
    final RetainedAudioStore store = RetainedAudioStore(
      dir: tmp,
      capBytes: 1000,
      clock: () => 0,
    );
    store.notices.listen(notices.add);
    await store.open();

    for (int seg = 0; seg < 4; seg++) {
      await store.append(segmentIdx: seg, bytes: Uint8List(400));
    }

    expect(store.retainedBytes, lessThanOrEqualTo(1000));
    expect(await store.read(0), isNotNull,
        reason: 'the FIRST segment is the one that has been waiting longest '
            'to be transcribed. Under O-2 it is the last thing that may be '
            'given up, and in fact it is never given up at all.');
    expect(
      notices.map((RetainedAudioNotice n) => n.code),
      contains(RetainedAudioNotice.codeCapReached),
      reason: 'refusing is only acceptable if it is heard',
    );
    expect(
      notices.map((RetainedAudioNotice n) => n.code),
      // Card RC-1 retired the constant; the WIRE STRING is what a
        // resurrected eviction path would announce, so that is what is
        // asserted absent here.
        isNot(contains('retained-audio-dropped-oldest')),
      reason: 'this layer no longer has an eviction path at all — if this '
          'code appears, _makeRoomFor has come back',
    );
    await store.dispose();
  });
}
