// Card RC-K (NR-100) — WHAT A RECORDING STILL OWES, AS A LIST OF STRETCHES.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (b), the RC-K correction
//   docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §5.4, §10-4
//
// DATA ONLY, like retained_audio_manifest.dart (which carries the list and
// re-exports this file): a value type, its JSON codec, and the one merge rule.
//
// 🔴 WHY A LIST. RC-3b kept ONE owed range and widened it when a second
// outage came (earliest start, latest end). Nothing owed was ever left out,
// but the live audio BETWEEN the two outages was fed to the recovery again:
// its words came back a second time, and the recovered row claimed the gap
// between the outages, so the article header read long by it. Each outage is
// its own stretch, recovered on its own and placed where it was spoken.

/// One owed stretch of a recording's PCM, in bytes: `[start, end)`.
class OwedRange {
  const OwedRange({required this.start, this.end, this.atMs, this.done});

  /// First owed byte (frame-aligned by the writer).
  final int start;

  /// One past the last owed byte; null ⇒ to the end of the journal (an owed
  /// TAIL — the recording ended with its link or engine down).
  final int? end;

  /// Where on the article clock this stretch's recovered rows belong — the
  /// value `ArticleScribe` returned when the stretch was accounted. Persisted
  /// so each stretch is placed at its OWN spot, across a relaunch too. Null on
  /// a stretch migrated from a manifest older than RC-K.
  final int? atMs;

  /// Null while still owed; [doneSettled], [doneUnverified] or [doneEmpty] once
  /// a recovery of this stretch reached a conclusion and the next one may be fed.
  final String? done;

  static const String doneSettled = 'settled';
  static const String doneUnverified = 'unverified';

  /// Codex rc2 ② — came back with no words: skipped for this pass, REOPENED
  /// when the recording concludes, so the user's retry feeds it.
  static const String doneEmpty = 'empty';

  bool get isOwed => done == null;

  OwedRange withDone(String? outcome) =>
      OwedRange(start: start, end: end, atMs: atMs, done: outcome);

  Map<String, Object?> toJson() => <String, Object?>{
        'start': start,
        if (end != null) 'end': end,
        if (atMs != null) 'atMs': atMs,
        if (done != null) 'done': done,
      };

  static OwedRange? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? s = raw['start'];
    if (s is! num) return null;
    final Object? e = raw['end'];
    final Object? a = raw['atMs'];
    final Object? d = raw['done'];
    return OwedRange(
      start: s.toInt(),
      end: e is num ? e.toInt() : null,
      atMs: a is num ? a.toInt() : null,
      done: d is String ? d : null,
    );
  }

  @override
  String toString() => '[$start,${end ?? 'end'})@${atMs ?? '-'}${done ?? ''}';
}

/// Card RC-K — the list after [add] is owed as well.
///
/// 🔴 NEVER WIDENS ACROSS A GAP. Only stretches that OVERLAP merge (a stretch
/// measured on the capture clock can overlap one measured on the article clock
/// by a fraction of a second); the merged one keeps the earlier start, the
/// later end (null wins: a tail runs to the end) and the earlier stretch's
/// placement. Touching stretches stay two: they were two outages, placed at two
/// spots. The result is sorted by start.
List<OwedRange> addOwedRange(List<OwedRange> ranges, OwedRange add) {
  OwedRange merged = add;
  final List<OwedRange> out = <OwedRange>[];
  for (final OwedRange r in ranges) {
    if (_overlaps(r, merged)) {
      final bool rFirst = r.start <= merged.start;
      merged = OwedRange(
        start: rFirst ? r.start : merged.start,
        end: r.end == null || merged.end == null
            ? null
            : (r.end! > merged.end! ? r.end : merged.end),
        atMs: rFirst ? (r.atMs ?? merged.atMs) : (merged.atMs ?? r.atMs),
        // A stretch that grew is owed again, whatever part of it was done.
      );
    } else {
      out.add(r);
    }
  }
  out.add(merged);
  out.sort((OwedRange a, OwedRange b) => a.start.compareTo(b.start));
  return out;
}

/// Codex rc3 ① — the still-owed stretch that starts at [fromBytes] now starts
/// at [toBytes] (floored to [frameBytes]): the audio between them has become a
/// row on disk (the dead leg's draft, card RC-P). The ONLY writer that moves an
/// owed start LATER, and its one caller (`narrowOwedTail`,
/// retained_audio_owed_widen.dart) runs only once that row has been read back —
/// the rule of `setTranscribedPrefix` (a later start claims those bytes are
/// words) is honoured by the read-back, not waived. A stretch already done, or
/// one that would come out empty, is left as it is.
List<OwedRange> narrowOwedStart(
    List<OwedRange> ranges, int fromBytes, int toBytes, int frameBytes) {
  final int to = toBytes - (toBytes % frameBytes);
  return <OwedRange>[
    for (final OwedRange r in ranges)
      r.start == fromBytes && r.isOwed && (r.end == null || r.end! > to)
          ? OwedRange(start: to, end: r.end, atMs: r.atMs)
          : r,
  ];
}

/// Card RC7 (Codex rc6 ②) — an owed TAIL from [fromBytes] to the end, as the
/// pieces of it that no listed stretch covers (owed or done), frame-aligned.
///
/// 🔴 WHY PIECES. RC-P owes the tail from the article clock, which can sit
/// before a bounded hole still owed (two outages, no row between them). Written
/// as one range it OVERLAPPED that hole, [addOwedRange] merged the two, and any
/// later write that concluded the tail — the draft's narrowing, the closing
/// rung's withdrawal — concluded the hole with it: its words were never
/// recovered. Laid around the listed stretches instead, the pieces only touch
/// them (touching stretches stay two), and each piece can be concluded on its
/// own ([markOwedRangeDone] / [narrowOwedStart] by start). A done stretch is
/// left out as well: overlapping it would reopen it.
List<OwedRange> owedTailPieces(
    List<OwedRange> ranges, int fromBytes, int frameBytes) {
  int cursor = fromBytes - (fromBytes % frameBytes);
  final List<OwedRange> sorted = <OwedRange>[...ranges]
    ..sort((OwedRange a, OwedRange b) => a.start.compareTo(b.start));
  final List<OwedRange> out = <OwedRange>[];
  for (final OwedRange r in sorted) {
    final int? e = r.end;
    if (e != null && e <= cursor) continue;
    if (r.start > cursor) out.add(OwedRange(start: cursor, end: r.start));
    if (e == null) return out; // a listed tail already runs to the end
    if (e > cursor) cursor = e;
  }
  out.add(OwedRange(start: cursor));
  return out;
}

bool _overlaps(OwedRange a, OwedRange b) {
  final bool aBeforeB = a.end != null && a.end! <= b.start;
  final bool bBeforeA = b.end != null && b.end! <= a.start;
  return !aBeforeB && !bBeforeA;
}
