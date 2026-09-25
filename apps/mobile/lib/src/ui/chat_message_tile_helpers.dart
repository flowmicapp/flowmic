// 800-line cap: moved VERBATIM from chat_message_tile.dart; no behavior change.
part of 'chat_message_tile.dart';

// owner 2026-07-26 ④: was a bare HH:mm for every row — a day-old 19:08 read as
// fresh. The dated rule lives (tested) in time_label.dart.

/// 「PC名 → 窗口名」("PC name → window name") — this row **is addressed to
/// which PC**, and (only present once it landed) **which window it entered**.
///
/// 🔴 Card L7 / owner 2026-08-02, verbatim: 「**the PC name must be shown**」.
///
/// ⚠️ This function used to only read [TimelineEntry.pcName], and that field
/// **is only written once the row actually lands**
/// (`timeline_store.dart`: `pcName: ok ? pcName : null`) ⇒ **precisely the
/// rows that most need to know
/// 「which PC is this one waiting on」** (pending delivery / undelivered /
/// noted only) **show no PC name at all**.
/// owner's sentence was pointing at exactly this hole.
///
/// Now two tiers:
///   ① [TimelineEntry.spokenToInstanceName] —— the **destination**, frozen the
///      moment the row was minted
///      (`timeline_store.dart:305`, its only writer), so **every row has
///      one**, regardless of whether delivery succeeded;
///   ② [TimelineEntry.pcName] —— the one it **actually landed on**, present
///      only for rows that landed.
///
/// 🔴 **When both exist, ② WINS**: the destination is 「who I meant to send it
/// to」, `pcName` is 「where it actually
/// went」, and the latter is the stronger fact. In the overwhelming majority
/// of cases the two agree; the one time they do not (a re-pair, a PC renamed)
/// we should say where it really went. **This is not merging two values into
/// one** — they are still two fields answering two questions,
/// this is only a **display priority**, and the one preferred is the one
/// that can be proven.
///
/// Never invents a leg: neither present (legacy data) ⇒ nothing is drawn.
String? _provenance(TimelineEntry e) {
  final String dest = (e.spokenToInstanceName ?? '').trim();
  final String landed = (e.pcName ?? '').trim();
  final String pc = landed.isNotEmpty ? landed : dest;
  final String win = (e.injectTarget?.windowTitle ?? '').trim();
  if (pc.isEmpty && win.isEmpty) return null;
  if (pc.isEmpty) return '→ $win';
  if (win.isEmpty) return '→ $pc';
  return '$pc → $win';
}

/// §4b-8 per-row display of transcription duration + word count. ONE function decides both whether the chip
/// shows and what it says — same reasoning as [_reasonLineFor]'s own doc: two
/// separately-maintained conditions (one gating render, one building text)
/// are how they drift apart.
///
/// Word count is ALWAYS present for a non-picture row (`entryWordCount` only
/// returns null for [TimelineEntry.isImage] — see entry_metrics.dart), so the
/// duration clause is the only optional half: `durationMs == null` (no real
/// duration was ever stamped on this row) drops the leading "12s · " rather
/// than rendering a fabricated "0s" — the CLAUDE.md red line this card exists
/// to respect (「不许画『0 秒』——那是把『没有』说成『零』」("must not draw '0
/// seconds' — that turns 'none' into 'zero'")).
String? _metricsLabel(TimelineEntry e, AppStrings strings) {
  final int? words = entryWordCount(e);
  if (words == null) return null; // picture row: nothing to count
  return entryMetricsLine(e.durationMs, words, strings);
}

/// 「12s · 34 words」, or just 「34 words」 when [durationMs] is null — the ONE
/// spelling of a duration-and-count line. A timeline row ([_metricsLabel]) and
/// an article paragraph header (NR-97, `article_page.dart` `_paragraphMetrics`)
/// both call it, so the two cannot drift into two formats.
///
/// Callers pass null for an unknown duration and must not pass a guessed 0
/// (see [_metricsLabel]); [words] comes from `entry_metrics.dart`, never from
/// a second counter.
String entryMetricsLine(int? durationMs, int words, AppStrings strings) {
  final String wordsLabel = strings.entryWordCountLabel(words);
  if (durationMs == null) return wordsLabel;
  return '${formatEntryDuration(durationMs)} · $wordsLabel';
}

BoxDecoration _cardDecoration({Color? border}) => BoxDecoration(
  color: FlowMicColors.surface,
  border: Border.all(color: border ?? FlowMicColors.line),
  borderRadius: BorderRadius.circular(18),
);
