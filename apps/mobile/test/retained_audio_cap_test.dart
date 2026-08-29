// Card CR-4 (owner 2026-08-29) — the retained-audio budget, and the arithmetic
// it is derived from.
//
// SPEC-REF:
//   apps/mobile/lib/src/audio/retained_audio_store.dart (kDefaultCapBytes)
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
      RetainedAudioStore.kDefaultCapBytes,
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
    expect(RetainedAudioStore.kDefaultCapBytes, 128 * 1024 * 1024);
  });

  test('🔴 REVERSE CONTROL: the previous value would fail the headroom test',
      () {
    // Without this, the assertion above could be satisfied by a cap that had
    // never moved — it proves the bar is actually above where we used to be.
    expect(64 * 1024 * 1024, lessThan(2 * _worstCaseSessionBytes),
        reason: 'if this is ever false the headroom test has stopped '
            'discriminating and the first test is decoration');
  });

  test('the cap is enforced, not merely declared', () async {
    // The constant is only a number until something reads it. A tiny store
    // proves the plumbing: over-budget appends do not silently grow the
    // directory, and the drop is announced.
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-cap-');
    addTearDown(() {
      if (tmp.existsSync()) tmp.deleteSync(recursive: true);
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
    await store.dispose();

    expect(store.retainedBytes, lessThanOrEqualTo(1000));
    expect(notices, isNotEmpty,
        reason: 'dropping retained audio silently is the failure this layer '
            'exists to prevent — the drop must be heard');
  });
}
