// SPEC-REF:
//   🔴 docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §6.2-1/-2
//     ("shrinking has exactly one delete path"; "deleting a row = deleting
//      100% of that row's bytes")
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md G-21, G-17 / RV-96
//   docs/rebuild/16 §9b-4 (the unknown-field side table — this card is the
//     payer for the debt that doc records)
//
// 🔴 THE PHONE'S ONE DELETER. Every row's disappearance goes through
// [TimelineReaper.reap].
//
// ── A ROW TODAY IS TIED TO THREE THINGS ──────────────────────────────────
//   ① the row itself in the table          — `TimelinePersistence.delete`
//   ② its picture file                     — `OutboxBlobStore.discard`
//      (since RV-93, **bytes are owned by the row**)
//   ③ its unknown fields in the side table — `UnknownFieldVault.forget`
//      (the debt doc 16 §9b-4 records)
//
// 🔴 **Before this card, only ① happened** (doc 15 G-21, [verified
// 2026-08-01]): `TimelineStore.delete` only did `_entries.removeAt` +
// `_persistence.delete`; `discard(` had **zero production call sites**, and
// the vault half had already been recorded as a debt back in window C.
// ⇒ When a user deleted a picture record on the phone, the picture file
// **stayed on disk forever**, while the ENTIRE reason owner asked for this
// feature was to save space.
//
// ── WHY THIS IS ONE CLASS AND NOT THREE CALL SITES ───────────────────────
// The overview design §5-6, verbatim: "user-initiated clear and automatic
// trimming are two triggers of the **SAME delete implementation** — two
// separate delete code paths are forbidden (otherwise 'was it really
// cleared' would have two different answers)". The phone today has two
// triggers (delete a single row / clear), and the audit window tomorrow may
// add a third. **There can be many triggers, but there is only ONE deleter.**
//
// ⚠️ It does **NOT** notify the UI, and does **NOT** touch the in-memory
// `_entries` — that is [TimelineStore]'s job, which has its own ordering
// rules. This class is only responsible for "not one byte belonging to
// these rows remains".

import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../portable/unknown_field_vault.dart';
import '../session/outbox_blob_store.dart';
import 'cloud/blind_store_cloud_state.dart';
import 'timeline_entry.dart';
import 'timeline_persistence.dart';
import 'timeline_purge.dart';

/// What one delete pass **actually** accomplished. Always what was
/// accomplished, never what was intended — doc 16 §6.2-5 forbids the UI
/// showing an unmeasured "X freed".
class ReapResult {
  const ReapResult({
    required this.rows,
    required this.pictures,
    required this.bytesFreed,
    required this.cutoffs,
  });

  static const ReapResult none = ReapResult(
    rows: 0,
    pictures: 0,
    bytesFreed: 0,
    cutoffs: Cutoffs.none,
  );

  /// The number of rows actually deleted from the table.
  final int rows;

  /// The number of picture **files** actually deleted from disk. ≤ [rows],
  /// and the gap is real history: before RV-93, bytes were deleted the
  /// instant delivery succeeded, so those rows are "picture rows with no
  /// picture file" (doc 16 §9b-6).
  final int pictures;

  /// The byte count **measured** before those files were deleted. 0 does not
  /// mean "not measured" — it means "there really were no bytes".
  final int bytesFreed;

  /// The marker after this deletion (cleared ≠ never existed).
  final Cutoffs cutoffs;
}

/// The marker's persistence surface. An interface rather than consuming
/// `SharedPreferences` directly, for the same reason as this repo's other
/// seams: tests don't need the plugin, and "failed to read it back" has
/// somewhere to say so.
abstract interface class CutoffStore {
  Cutoffs read();

  Future<void> write(Cutoffs cutoffs);
}

/// The production implementation. Lands on device-local prefs, in the same
/// family as `UnknownFieldVault`.
///
/// 🔴 **It MUST persist**: "what range was cleared" is a **durable fact**
/// about this machine, and must never revert to "there was never anything
/// earlier" after a restart — that is the whole reason these two sentences
/// exist (overview design §5-5; the desktop side's
/// `flowmic.history.retention` is a precedent for the same discipline).
class SharedPrefsCutoffStore implements CutoffStore {
  SharedPrefsCutoffStore(this._prefs);

  final SharedPreferences _prefs;

  static const String kKey = 'flowmic.timeline.cutoffs.v1';

  @override
  Cutoffs read() {
    final String? raw = _prefs.getString(kKey);
    if (raw == null || raw.isEmpty) return Cutoffs.none;
    try {
      return Cutoffs.fromJson(jsonDecode(raw));
    } on FormatException {
      // A corrupt blob loses the MARKS, never the rows. Answering "never
      // cleared" is the conservative direction: it under-claims (the page
      // says nothing) instead of claiming a range that was never cleared.
      return Cutoffs.none;
    }
  }

  @override
  Future<void> write(Cutoffs cutoffs) async {
    await _prefs.setString(kKey, jsonEncode(cutoffs.toJson()));
  }
}

/// A non-persisting implementation — **for tests and "assembly with no
/// prefs" only**.
///
/// ⚠️ It is a compliant double, not the "friendly empty implementation" doc
/// 13 §7 F1 ② bans: it **faithfully** stores whatever it is given, just in
/// memory. What would actually deceive is an implementation that "pretends
/// the write succeeded".
class InMemoryCutoffStore implements CutoffStore {
  Cutoffs _value = Cutoffs.none;

  @override
  Cutoffs read() => _value;

  @override
  Future<void> write(Cutoffs cutoffs) async {
    _value = cutoffs;
  }
}

class TimelineReaper {
  TimelineReaper({
    required TimelinePersistence persistence,
    required OutboxBlobStore images,
    required UnknownFieldVault vault,
    required CutoffStore cutoffs,
    BlindStoreRowDeleter? cloudDeleter,
  }) : _persistence = persistence,
       _images = images,
       _vault = vault,
       _cutoffStore = cutoffs,
       _cloudDeleter = cloudDeleter;

  final TimelinePersistence _persistence;
  final OutboxBlobStore _images;
  final UnknownFieldVault _vault;
  final CutoffStore _cutoffStore;

  /// Card E-CL — ④ the cloud half.
  ///
  /// Null (the default, and the state of every build before E-CL) ⇒ deletion is
  /// exactly what it was: this class deletes local bytes and nothing else.
  /// Non-null ⇒ the row's disappearance ALSO leaves a durable "the cloud
  /// still owes a tombstone" marker, written in the SAME transaction as the
  /// row (design §4.1).
  ///
  /// ⚠️ Deliberately optional rather than required: the fallback store has no
  /// place to keep such a marker, and running with a forgetful one is worse than
  /// not running at all (see [TimelineStorageOpen.cloudState]).
  final BlindStoreRowDeleter? _cloudDeleter;

  /// The marker right now. Read from the persistence surface, so "what range
  /// was cleared" can still be answered after a restart.
  Cutoffs get cutoffs => _cutoffStore.read();

  /// 🔴 Delete these rows **and everything they own**.
  ///
  /// [advance] being null means a single-row delete: the marker does not
  /// move (see [advanceCutoffs]'s explanation).
  ///
  /// [queueCloudTombstones] should only ever be passed false in ONE
  /// situation: **this row is being deleted precisely BECAUSE the cloud says
  /// it is already gone** (deleted by another device, `timeline:pull`
  /// brought back a tombstone). Queuing another delete request in that case
  /// would just make the delete bounce back and forth between the two
  /// devices forever. Any delete initiated by **the user on THIS device**
  /// must go through true — that is exactly where owner's ruling "delete
  /// frees space" gets fulfilled.
  Future<ReapResult> reap(
    List<TimelineEntry> doomed, {
    ClearKind? advance,
    bool queueCloudTombstones = true,
  }) async {
    if (doomed.isEmpty) return ReapResult(rows: 0, pictures: 0, bytesFreed: 0, cutoffs: cutoffs);
    int pictures = 0;
    int bytes = 0;
    for (final TimelineEntry e in doomed) {
      // ② The picture file. `clientId`, not `id` — the file is named by the
      // request id, and a picture row's request id IS its clientId
      // (row_image_lookup.dart explains that using `id` would "look
      // plausible and then find nothing, every time").
      if (e.isImage) {
        final String? path = await _images.pathFor(e.clientId);
        if (path != null) {
          // Measure before delete: asking for the size after deleting only
          // ever gets null, and what the UI needs to say is **how much was
          // freed**.
          final int? size = await _images.sizeOf(path);
          await _images.discard(path);
          pictures += 1;
          bytes += size ?? 0;
        }
      }
      // ① The row in the table (④'s cloud tombstone debt is in the SAME
      // transaction as it).
      //
      // 🔴 The criterion is **NOT** "is this a cloud row" but "does the
      // cloud actually have it" — `deleteRowAndQueueTombstone` itself checks
      // the `pushed` ledger inside the transaction, and only deletes the row
      // if there's nothing there. Branching on `origin == 'cloud'` would
      // introduce a SECOND answer: "was pushed" and "should be pushed" are
      // two different things, and only the former owes a tombstone.
      final BlindStoreRowDeleter? cloud = _cloudDeleter;
      if (queueCloudTombstones && cloud != null) {
        await cloud.deleteRowAndQueueTombstone(
          e.id,
          nowMs: DateTime.now().toUtc().millisecondsSinceEpoch,
        );
      } else {
        await _persistence.delete(e.id);
      }
    }
    // ③ The side table. One write, not one per row — it is a single JSON blob.
    await _vault.forget(doomed.map((TimelineEntry e) => e.id));
    final Cutoffs next = advanceCutoffs(cutoffs, doomed, advance);
    if (advance != null) await _cutoffStore.write(next);
    return ReapResult(
      rows: doomed.length,
      pictures: pictures,
      bytesFreed: bytes,
      cutoffs: next,
    );
  }
}
