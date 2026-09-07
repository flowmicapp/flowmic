// Shared rig teardown for the tests that own a temp directory.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// MEASURED 2026-09-07 (dev-pc-a, gate 0 of the 0.3.75 relay deploy):
// `live_settle_test.dart` failed with
//   PathAccessException: Deletion failed, path = '…\flowmic-ls1b-…'
//   (OS Error: another program is using this file, errno = 32)
// in its `tearDown`, on a DIFFERENT test each run — 7 of 8 oversubscribed runs
// of that one file reproduced it. The rig deleted its temp directory while a
// journal handle inside it was still open: the live settle releases its PCM
// handle in a `finally` AFTER the manifest commit that the rig waits on, and
// nothing in the rig's `dispose()` awaited the spill's queues at all.
//
// 🔴 THE FIX IS THE AWAIT, NOT THE RETRY. Every rig that owns a spill must
// `await spill.dispose()` (which now drains all three of its queues — see
// `RetainedAudioSpill.dispose`) before it deletes anything. [removeTempDir] is
// the safety net for the handles no product object owns (an OS scanner, an
// editor, the runner's own mapping of a file it just read), and it is bounded:
// after the budget it RETHROWS, so a directory we genuinely cannot remove
// still fails the test instead of passing quietly.

import 'dart:async';
import 'dart:io';

/// Delete [dir] and everything under it, retrying a Windows sharing violation.
///
/// ⚠️ NOT A SUBSTITUTE FOR AWAITING THE WRITER. A retry loop in front of a
/// missing await turns a real teardown bug into a slow test that still passes;
/// see the header for the order these two belong in.
Future<void> removeTempDir(
  Directory dir, {
  int attempts = 20,
  Duration delay = const Duration(milliseconds: 50),
}) async {
  for (int i = 0; i < attempts; i++) {
    if (!dir.existsSync()) return;
    try {
      dir.deleteSync(recursive: true);
      return;
    } on FileSystemException {
      // The last attempt reports: a directory that is still locked after the
      // whole budget is a defect, and a silent success here would hide it.
      if (i == attempts - 1) rethrow;
      await Future<void>.delayed(delay);
    }
  }
}
