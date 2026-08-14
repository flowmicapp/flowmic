// SPEC-REF:
//   🔴 docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §6.2 (clear — five hard constraints)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md G-17 / RV-96
//     (phone-side storage only ever grows, never shrinks — owner wants a
//     clear function he can see and operate)
//   docs/strategy/2026-08-01-data-asset-lifecycle-design.md §4-4, §5-4/-5/-6
//
// The clear feature's SELECTOR — a pure function, no I/O.
//
// ── Why the selector and the deleter are separate (the same shape on both ends) ───────────────────────────
// The confirmation dialog asks 「what will this delete」, the deleter does
// 「delete these」. **It must be the SAME batch of rows**,
// otherwise Book 16 §6.2-5's 「will free X」 is a guessed number, and a fake
// freed-space number and a fake progress bar
// are the same kind of thing. Once split into two halves, the UI gets exactly
// the list the deleter is about to consume next.
//
// ⚠️ The phone and the desktop **do not have the same number of delete
// triggers**, and that is not an inconsistency, it is a fact:
//   the desktop has three (capacity trimming / the user deleting a single row /
//   clear), the phone has only two —
//   **the phone's timeline has no automatic trimming at all** (SQLite keeps
//   everything, confirmed by Book 16 §4.1).
//   ⇒ On the phone 「clear」 is not 「a second delete path」, it IS **the
//   first**; this round folds in the existing
//   `TimelineStore.delete` too, so the two do not each delete half the job
//   (Book 15 G-21).

import 'timeline_entry.dart';

/// Which category to clear (owner's 2026-08-01 §4-4: 「clear transcribed text /
/// clear pictures, either can be run separately」).
enum ClearKind {
  /// Transcribed text rows.
  text,

  /// Picture rows (deletes the local original file along with it — that is
  /// the space owner wants freed).
  images,

  /// Both.
  both,
}

/// owner's five time windows, plus a sixth that **he did NOT rule on**, marked
/// as such everywhere it appears.
///
/// 🔴 [all] is the lead's **assumption**, pending owner's B5 approval
/// (`docs/decisions/2026-08-02-b5-stats-list-and-clear-all-options.md` §2),
/// **not a ruling**. owner listed only five windows, and 「a week ago」 does
/// not include the most recent week ⇒ per the windows he listed
/// **there is today no way at all to clear the timeline completely**, and that
/// is exactly what a device-switch/privacy scenario needs.
/// Deleting it only requires deleting this one enum value: the UI is generated
/// from this list.
enum ClearWindow { week, month, quarter, halfYear, year, all }

/// Days per window. **Fixed day counts, no calendar arithmetic**: 「three
/// months ago」 must be the same
/// span in February and in July — a deletion whose range the user cannot
/// predict is far worse than one that is off by a few days from intuition.
const Map<ClearWindow, int> kClearWindowDays = <ClearWindow, int>{
  ClearWindow.week: 7,
  ClearWindow.month: 30,
  ClearWindow.quarter: 90,
  ClearWindow.halfYear: 182,
  ClearWindow.year: 365,
};

/// The instant this window points to: rows **strictly earlier than it** are in range.
///
/// [ClearWindow.all] returns `null` — 「no lower bound」 and 「the lower bound is
/// now」 are two different things,
/// so this returns null rather than `now`.
DateTime? horizonOf(ClearWindow window, DateTime now) {
  final int? days = kClearWindowDays[window];
  if (days == null) return null;
  return now.subtract(Duration(days: days));
}

/// ⚠️ REQ-12-13 explicit note: **a remote-key-press row falls into the "text"
/// category** (it is not a picture, and [ClearKind]
/// only has two selectable types). This is a **deliberate choice this round,
/// not an oversight**:
///   · adding a third category would require touching [ClearKind], the
///     four-language copy, and the selector strip generated off
///     `ClearKind.values`
///     — that is a **product-level** change (the user has one more concept to
///     learn), belongs to owner, not to this cut;
///   · whereas 「clear transcribed text (last 7 days)」 clears the same-period
///     key-press rows along with it, consistent with the user's intent:
///     what they are clearing is the record from that period.
/// ⇒ Registered in Book 15 §2.0-e's residuals; the day owner wants them
/// cleared separately, adding a third category will fail to compile
/// (the switch in `stats_clear_sheet.dart` is exhaustive).
bool _inKind(TimelineEntry e, ClearKind kind) {
  if (kind == ClearKind.both) return true;
  return kind == ClearKind.images ? e.isImage : !e.isImage;
}

/// Which rows one clear operation will delete. **Pure**: the confirmation box
/// counts it, the deleter deletes it, the two cannot disagree.
///
/// Already-soft-deleted rows are not counted again — to the user it is already
/// gone, and counting it into 「will delete N rows」 would make that number
/// impossible to justify.
List<TimelineEntry> planClear(
  Iterable<TimelineEntry> all,
  ClearKind kind,
  DateTime? olderThan,
) {
  return all
      .where((TimelineEntry e) {
        if (e.deleted || !_inKind(e, kind)) return false;
        if (olderThan == null) return true;
        return e.createdAt.isBefore(olderThan);
      })
      .toList(growable: false);
}

/// 「everything before this instant is gone」 — **one per category**.
///
/// 🔴 This is the structure for 「cleared ≠ never existed」 (unified design
/// §5-5) under the constraint of **not over-claiming**.
/// If only pictures were cleared but a single unified cutoff were advanced,
/// the interface would say 「records before X have all been cleared」,
/// while every text row from that period is still on screen — a single scalar
/// does not even have the capacity to express this.
///
/// ⚠️ **The phone previously had no cutoff at all** (confirmed by Book 16
/// §4.1: SQLite keeps everything, no trimming whatsoever),
/// so this is not 「porting over the desktop's version」, it is **the first
/// time the phone can answer "what have I cleared"**.
class Cutoffs {
  const Cutoffs({this.text, this.images});

  static const Cutoffs none = Cutoffs();

  /// The instant of the most recent **text** row this device has deleted; null
  /// = nothing has ever been deleted.
  final DateTime? text;

  /// Same, for **picture** rows.
  final DateTime? images;

  /// The sentence the interface keeps saying: 「everything before X has been
  /// cleared」.
  ///
  /// = the **earlier** of the two marks, and an answer is only given when
  /// **both** are present: if pictures were cleared up to March but
  /// not a single text row has ever been cleared, there is no instant for
  /// which 「nothing before it exists」 holds.
  /// Deliberately says less rather than more — the interface falls back to the
  /// two per-category sentences, and those two are true.
  DateTime? get combined {
    final DateTime? t = text;
    final DateTime? i = images;
    if (t == null || i == null) return null;
    return t.isBefore(i) ? t : i;
  }

  bool get isEmpty => text == null && images == null;

  Map<String, Object?> toJson() => <String, Object?>{
    'text': text?.toIso8601String(),
    'images': images?.toIso8601String(),
  };

  static Cutoffs fromJson(Object? raw) {
    if (raw is! Map) return Cutoffs.none;
    DateTime? at(Object? v) =>
        v is String && v.isNotEmpty ? DateTime.tryParse(v)?.toUtc() : null;
    return Cutoffs(text: at(raw['text']), images: at(raw['images']));
  }
}

/// Advances the marks based on **what was actually deleted**.
///
/// Only forward (a later deletion never undoes an earlier one), and only
/// advances the categories this deletion actually covered.
/// `advance == null` is a **single-row deletion**: the user deleted one row,
/// which says nothing about 「everything before it is gone」,
/// so the marks do not move — that is exactly the distinction between 「I
/// deleted this one」 and 「everything before it is gone」.
///
/// 🔴 [ClearKind.both] advances **both** marks using **the most recent instant
/// among all the deleted rows**, rather than taking
/// each category's own most recent: a deletion that does not distinguish by
/// category deletes 「everything earlier than its most recent row, regardless of type」.
Cutoffs advanceCutoffs(
  Cutoffs current,
  Iterable<TimelineEntry> dropped,
  ClearKind? advance,
) {
  if (advance == null || dropped.isEmpty) return current;
  DateTime? newest(ClearKind kind) {
    DateTime? max;
    for (final TimelineEntry e in dropped) {
      if (!_inKind(e, kind)) continue;
      if (max == null || e.createdAt.isAfter(max)) max = e.createdAt;
    }
    return max;
  }

  DateTime? bump(DateTime? cur, DateTime? mark) {
    if (mark == null) return cur;
    if (cur == null || mark.isAfter(cur)) return mark;
    return cur;
  }

  if (advance == ClearKind.both) {
    final DateTime? mark = newest(ClearKind.both);
    return Cutoffs(
      text: bump(current.text, mark),
      images: bump(current.images, mark),
    );
  }
  return Cutoffs(
    text: advance == ClearKind.images
        ? current.text
        : bump(current.text, newest(ClearKind.text)),
    images: advance == ClearKind.text
        ? current.images
        : bump(current.images, newest(ClearKind.images)),
  );
}
