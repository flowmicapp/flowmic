// Recordings the user deleted, as a fact every writer can consult.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md (§Chose 4: O-5 — the user's delete)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A3-3 (commit order), §A4 (半应用状态)
//
// ── WHY A REGISTRY AND NOT ANOTHER EXISTENCE CHECK ──────────────────────────
//
// A delete can land at any instant while a recovery attempt runs: it happens
// in another object, through another handle, and on a phone the unlink
// succeeds while the leg's handle stays perfectly valid. The defence so far
// was `if (await _fs.exists(<manifest>))` immediately before each write —
// FOUR of them, in `recovery_journal_leg.dart` and `recovery_leg_settle.dart`,
// each added after its own window was measured.
//
// 🔴 EVERY ONE OF THOSE IS A CHECK-THEN-WRITE, AND THE WINDOW BETWEEN THEM CAN
// NEVER BE CLOSED BY ADDING ANOTHER ONE. `pending_recovery_actions_test.dart`
// went red once in a loaded gate run (2026-09-07) AFTER both re-checks were in
// place: `Expected: false  Actual: <true>` — the manifest was back. Narrowing
// a race by writing the same check a fifth time is how a defect learns to hide.
//
// What closes it is a fact that becomes true BEFORE the first byte of the
// delete is written and stays true: the id goes in here synchronously, and the
// journal's own commit consults it. So the choke point is one place
// (`RetainedAudioJournal._commitLocked`) rather than every caller, and a
// writer that forgets to ask cannot exist — there is nowhere else a manifest
// is published from.
//
// ⚠️ IT IS NOT DURABILITY AND MUST NOT BE DESCRIBED AS ONE. It lives in
// memory, for this process. What survives a restart is the absence of the
// files themselves; this only stops the writes that are already in flight from
// putting one of them back.
//
// ⚠️ IT IS ALSO NOT A REFUSAL TO DELETE. Nothing here deletes, keeps or
// refuses anything; it answers one question — 「has the user thrown this
// recording away?」 — for code that is about to write about it.

/// Ids whose files the user (or the sweep) removed in this process.
///
/// 🔴 ONE PER SPILL, NOT A GLOBAL. Same rule as [ManifestRepublishQueue] next
/// door: a `static` would be a second answer to 「which recordings are gone」
/// that no test could reset, and two rigs in one suite would see each other's.
class DeletedRecordings {
  /// Insertion-ordered and capped: this is a race guard for writes that are
  /// already in flight, so only the recent past can matter. Unbounded, it
  /// would grow for the life of the process with ids nothing will ever ask
  /// about again.
  static const int _cap = 512;

  final Set<String> _ids = <String>{};

  /// 🔴 SYNCHRONOUS ON PURPOSE. The caller marks BEFORE its first `await`, so
  /// there is no instant at which the delete has started and this still
  /// answers false.
  void mark(String recordingId) {
    _ids.add(recordingId);
    while (_ids.length > _cap) {
      _ids.remove(_ids.first);
    }
  }

  bool contains(String recordingId) => _ids.contains(recordingId);

  int get length => _ids.length;

  /// Only for a caller that legitimately re-creates a recording under an id it
  /// previously deleted. Nothing in production does today; kept so the answer
  /// to 「can this ever wrongly suppress a future recording?」 is a verb rather
  /// than an argument.
  void unmark(String recordingId) => _ids.remove(recordingId);
}
