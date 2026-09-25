// Card CR-12-A — the paragraph rule for a continuous recording.
//
// SPEC-REF: docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md
//   §3 (Q3, the rule), §3.5 (properties P1–P6), §3.6 (the reverse-check table).
// Owner's words (2026-09-22): 「可以按1分钟左右为分片标准，并不是达1分钟就分，而是在1
//   分钟左右如果中间出现3秒以上或可形成一段话的时候再分段」.
//
// ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────
//
// This is a READ-TIME GROUPING of rows that already exist. It is NOT a second
// segmentation mechanism: the server's soft segments still decide where a row
// ends, the row's `articleOffsetMs`/`durationMs` are still its truth, and no
// frame on the wire changes. Design §2 measured why: `soft_segment_ms` and
// `MIN_PAUSE_MS` are answering a SECOND question — when a plain realtime
// utterance emits its next line to the PC (`chat_utterance.dart:58-78`,
// `_settlesPerSegment(c) <=> realtime`) — so moving them to 60s/3s would change
// the time-to-first-text of every realtime user for the sake of one light-record
// screen. Grouping above the rows leaves that alone AND makes already-recorded
// articles display under the new rule for free, because it is a function of the
// rows rather than a property written into them.
//
// Constraint A (owner, same day): paragraphs exist ONLY in light records. They
// never reach the PC timeline, and this card changes zero protocol.
//
// ── THE ONE FACT THE WHOLE RULE STANDS ON ───────────────────────────────────
//
// Every row edge the server hands us is ALREADY a natural break. After the
// cadence deadline (`due`, 30 s) `segmentCutDecision` has exactly two arms —
// `sentence` (confirmed text ends on a terminator) and `pause` (the VAD gate
// closed for >= `MIN_PAUSE_MS` = 600 ms) — and NOTHING ELSE ends a row: SEG-4
// renamed the timer's arm from 'ceiling' to 'leg' precisely so that the clock
// bounds the engine session and never the row. So a row is at least 30 s
// (terminal row excepted) and has NO maximum, and the rule here is not looking
// for a place to cut inside continuous text. It is choosing WHICH of the
// server's breaks are big enough to be a paragraph break: a sentence end is,
// a >= 3 s silence is, and a 600 ms breath is not.
//
// ── THE INPUTS ARE THREE, AND THE MISSING ONE IS MISSING ON PURPOSE ─────────
//
// The rule reads exactly: the row's duration, the DISPLAYED text of the row
// before it, and an optional "silence before this row" figure.
//
// 🔴 IT MUST NOT READ `articleOffsetMs` GAPS OR `createdAt` GAPS. Design §1
// measured both and both lie:
//   * `gap = next.offset - (cur.offset + cur.duration)` is IDENTICALLY ZERO by
//     construction, not "small". `ArticleClock.claim` advances by the sum of
//     durations (article.dart:120) and the server sets each segment's start to
//     the previous boundary (`orchestrator-rollover.ts:235,270`), so a real 5s
//     pause is split into "600ms at the tail of row N + 4,400ms at the head of
//     row N+1" and there is no seam between the rows at all.
//   * `createdAt` deltas are ARRIVAL times. `stt_from_flush_ms` was measured at
//     651–5,860 ms on this machine — larger than the 3s threshold itself.
// An implementation that derives a pause from either of those can still look
// right on a hand-picked example; it is right by coincidence.
// `article_paragraphs_test.dart` T7 pins this (same durations/text, different
// offsets and createdAt => same paragraphs), and that test is the only thing
// standing between this file and that mistake.
//
// This is R11 applied literally: the layer making the call (the phone's display
// layer) may not HAVE the fact "there was a 3-second silence here", so the rule
// is written to take it as an input and to degrade without it.
// [articlePauseBeforeMs] is the seam it arrives through; since CR-12-D it reads
// the persisted `TimelineEntry.pauseBeforeMs`.
//
// 🔴 THE PAUSE ARM IS THE PRIMARY JUDGEMENT, NOT A FUTURE MAYBE. Design §2.4
// (2026-09-22, measured against real Soniox `stt-rt-v5` frames) settled where
// the number comes from: every token Soniox sends already carries `start_ms` /
// `end_ms`, and always has — only our own `SonioxToken` declaration failed to
// name the fields, so nobody read them. Card CR-12-D declares them and carries
// the figure down to `pause_before_ms` on `stt:final`. The alternative source
// (the server's energy VAD gate) was measured in the same round and REJECTED:
// with −40 dBFS room noise the gate was open 100% of the time, longest close
// 0 ms — it would have shipped a field that reads zero in any real room.
//
// ⇒ The path WITHOUT a pause figure is the DEGRADED path, and it is degraded
// for three concrete reasons, not for lack of implementation: a non-Soniox leg
// (sherpa / FunASR / Deepgram send no timestamps), an old relay that strips the
// additive field, and rows recorded before CR-12-D. On those, only a sentence
// end can qualify an edge; an edge that is neither is left alone until the hard
// cap ([kParagraphHardMaxMs]) closes the paragraph at whatever edge comes next.
// Degraded is not broken; design §3.4 names the shape and
// `article_paragraphs_test.dart` asserts it directly.
//
// 🔴 AND THE RULE NEVER INFERS THE PAUSE ITSELF. It does no time reasoning over
// the transcript at all — it reads text ONLY to ask "did that row end on a
// sentence". This matters because of a shape §2.4 measured: punctuation and
// space tokens carry their own 60 ms spans and sit attached BEFORE the next
// word, so anything that tried to time-reason over text would have a pause cut
// in half by a comma. Skipping non-content tokens is CR-12-D's job, upstream of
// this file; there is nothing here for it to corrupt.

import 'timeline_entry.dart';

/// 「1 分钟左右」 — the length a paragraph is aiming for. It is not itself a
/// decision point (nothing closes BECAUSE 60 s passed — that is the thing the
/// owner ruled out); it is the number the floor and the cap are derived from.
const int kParagraphTargetMs = 60000;

/// The server's row cadence: a non-terminal row is never shorter than this.
///
/// Anchor: `DEFAULT_SOFT_SEGMENT_MS = 30_000` (`orchestrator-types.ts`) and
/// `soft_segment_ms: 30_000` (`packages/protocol/src/constants.ts`); mechanism:
/// `SoftSegmentCadence` raises `due` only at `cadenceMs`, and before `due`
/// `segmentCutDecision` answers 'wait' unconditionally. The test file reads the
/// server constant back out of its source and fails if the two ever differ, so
/// the number below is a pinned copy, not a belief.
///
/// ⚠️ It is a DEPLOY-TIME tunable (`FLOWMIC_STT_SOFT_SEGMENT_MS`); the phone
/// cannot see what a given relay was started with. The rule only ever uses it
/// to DERIVE the cap and to reason about the row-count backstop; a relay tuned
/// shorter makes paragraphs land later relative to the cap, never lose rows.
///
/// ⚠️ 更正（RC-E，2026-09-24）：「before `due` `segmentCutDecision` answers 'wait'
/// unconditionally」 is still true of push-to-talk, and no longer of a LONG
/// RECORDING: there a >=3 s silence ends a row that is >=10 s old
/// (`segment-boundary.ts` `continuousSilenceCutAllowed`, book 06 §2 RC-E block), so
/// the 「a row is at least [kServerRowMinMs]」 steps below hold for push-to-talk
/// rows only. What still holds for 10–30 s rows is pinned by
/// `test/article_paragraphs_short_rows_test.dart`: the floor still gates, the cap
/// still bounds (cap + less than one row), and the unknown-length backstop is not
/// reached (a long recording's rows carry their length).
const int kServerRowMinMs = 30000;

/// The lower edge of 「左右」: below this a paragraph will not close for ANY
/// reason short of the recording ending.
///
/// 🔴 THIS NUMBER MUST STAY ABOVE [kServerRowMinMs]. A floor at or below the
/// server's row minimum makes "one row = one paragraph" reachable and the whole
/// rule a no-op on today's data.
///
/// WHY EXACTLY 2/3 OF THE TARGET, NOT JUST "SOMETHING ABOVE 30 S": a paragraph
/// is a whole number of rows, so for rows of length L the choice at the first
/// qualified edge is between ONE row (L) and TWO rows (2L). One row is the
/// closer answer to the target exactly when |L − T| <= |2L − T|, i.e. L >= 2T/3
/// = 40 s. So a 45 s row that ends on a sentence stands alone (45 is nearer 60
/// than 90 is) and a 35 s row waits for its neighbour (70 is nearer 60 than 35
/// is). The floor is where that comparison flips, not a taste.
const int kParagraphSoftMinMs = kParagraphTargetMs * 2 ~/ 3;

/// The hard cap: at or past this, the paragraph closes at the NEXT row edge
/// whether or not that edge qualifies.
///
/// The owner's sentence has no terminating condition — 「在1分钟左右如果中间出现
/// 3秒以上或可形成一段话的时候再分段」 says when to close and never says what
/// to do if that moment never comes. A speaker who neither punctuates nor
/// pauses exists (`segment-boundary.ts`: "the ceiling is not optional"), so an
/// implementation MUST add one clause the owner did not say. This is it, and it
/// is written to be a BACKSTOP rather than the main road:
///
/// target + one row minimum. Past the target the rule is waiting for a
/// qualified edge, and every further row is another chance at one; a row is at
/// least [kServerRowMinMs], so `target + rowMin` grants exactly one more
/// row-edge of waiting before giving up. On 30 s rows that is the edge at 90 s
/// (60 s was the first chance, 90 s the last); on 45 s rows the edge at 90 s;
/// on 60 s rows the edge at 120 s. The paragraph a user sees from this arm is
/// 1.5–2× the target — long, but bounded, and always ending at a server-judged
/// break.
///
/// 🔴 WHEN THIS BECOMES THE MAIN ROAD (design §3.4 lists the same four): rows
/// cut on `pause` whose text carries no terminator AND no pause figure (pre-D
/// rows, non-Soniox legs, a relay that strips the field); an engine run without
/// punctuation; a speaker who ends rows on clause breaks with sub-3 s breaths;
/// English rows without a trailing period. In those cases every paragraph is
/// [kParagraphHardMaxMs, +one row] long, and that is the documented shape.
const int kParagraphHardMaxMs = kParagraphTargetMs + kServerRowMinMs;

/// The duration-free backstop: a paragraph never holds more rows OF UNKNOWN
/// LENGTH than this.
///
/// 🔴 `duration_ms` is an additive field and can be absent; `articleOffsetMs`
/// is accumulated from the same durations and does not advance without them
/// (`ArticleClock.claim`). Every time-based arm above therefore sees 0 forever
/// on such rows, and without THIS arm a half-hour recording whose rows carry no
/// length is one wall of text that never closes (`closed:false` for the whole
/// recording). The backstop must not depend on any time quantity, so it counts
/// rows — and it counts ONLY the rows that have no length, because a row that
/// has one is already governed by the floor and the cap. (The first version
/// counted every row and closed three 5 s rows at 15 s, under the floor; the
/// property test caught it.)
///
/// Why 3: an unknown-length row is still a real row, and the server's cadence
/// makes it at least [kServerRowMinMs] long IN TRUTH even though the number
/// never arrived. Three such rows are therefore at least 3 × 30 s = 90 s =
/// [kParagraphHardMaxMs]: the count is the cap expressed in row minimums, not a
/// separate opinion about paragraph length. The test file pins
/// `rows × rowMin >= cap` so that lowering either number without the other is
/// a visible act. On rows that carry a length this arm never fires at all.
///
/// User-visible consequence: a recording whose rows carry no length reads as
/// paragraphs of exactly three rows (about 90 s or more each), and those
/// paragraphs have no timestamp label (see [ArticleParagraph.startMs]).
const int kParagraphMaxUnknownRows = 3;

/// 「3秒以上」 — a silence this long qualifies the edge in front of a row, once
/// the floor is met. Only consulted when a pause figure actually exists (see
/// [articlePauseBeforeMs]); it is never derived.
///
/// The owner named this number, and design §2.4 then measured that it stands up
/// rather than merely being obeyed: on real Soniox frames the largest gap
/// BETWEEN WORDS INSIDE speech was 480 ms (420 ms with room noise), so 3,000 ms
/// sits at roughly six times the noise floor of ordinary speech, and five times
/// the server's own `MIN_PAUSE_MS` (600 ms) — which is the point: the server's
/// `pause` arm already ends rows on a breath, and this threshold is what tells
/// a breath from a stop. Recognition latency does not enter that figure — both
/// ends are Soniox's own audio clock. The figure arriving here is quantised to
/// 60 ms frames, so a threshold on a 60 ms multiple is exactly representable.
const int kStrongPauseMs = 3000;

/// Where the rule gets 「how long was the silence before this row」.
typedef ArticlePauseSource = int? Function(TimelineEntry row);

/// The production pause source: the row's own persisted
/// [TimelineEntry.pauseBeforeMs].
///
/// Card CR-12-D carries the figure through four layers that all live outside
/// this file — Soniox adapter (word token times) → orchestrator
/// (`apps/server-core/src/stt/segment-pause.ts`) → `stt:final.pause_before_ms`
/// → `SttFinal.pauseBeforeMs` (`stt_stream.dart`) → the row, stamped in
/// `_settleSpan` (`chat_utterance_settle.dart`) and kept in the payload key
/// `pause_before_ms` (`timeline_entry_codec.dart`). Until 2026-09-23 this
/// function returned null for every row because none of that existed; the
/// arm below was written and tested against an injected source in the
/// meantime. `article_paragraphs_test.dart` T12 now drives the arm through
/// this function with codec-decoded rows, and `pause_before_ms_test.dart`
/// drives it from a wire frame.
///
/// Null here is still common and still means 「我不知道」: non-Soniox legs,
/// an old relay that strips the additive field, an engine reconnect, a row
/// that covers more than one engine segment, and every row recorded before
/// CR-12-D. On null the arm stays silent and the documented degraded rule
/// (§3.4) decides — it is never read as 0.
int? articlePauseBeforeMs(TimelineEntry row) => row.pauseBeforeMs;

/// Sentence-final punctuation, a PINNED COPY of the server's
/// `SENTENCE_TERMINATORS` (`apps/server-core/src/stt/segment-boundary.ts`),
/// duplicate full-width pair included.
///
/// 🔴 This is the same list, not a similar one: `article_paragraphs_test.dart`
/// reads the server source and fails when the two strings differ, so "tidying"
/// either side goes red instead of drifting. D-10: the server file is the
/// contract for what "ends a sentence" means to the engine, and this layer does
/// not get a second opinion on that set.
const String kServerSentenceTerminators = '。！？…‼⁇⁈⁉！？!?';

/// Closing marks that may sit AFTER the terminator: 「他说「走吧。」」 ends a
/// sentence even though its last character is a bracket.
const String _kClosers = '」』”’"\')]）】';

final RegExp _kLetter = RegExp(r'\p{L}', unicode: true);

/// True when [text] ends on a sentence the engine already committed — the
/// server's set, plus ONE display-layer extension for the ASCII period.
///
/// ── THE SERVER REFUSES `.` AND THIS LAYER ACCEPTS IT; THE REASON IS THE
/// POSITION, NOT THE CHARACTER ─────────────────────────────────────────────
///
/// `segment-boundary.ts` excludes `.` on purpose: English STT emits it inside
/// abbreviations and numbers ("U.S.", "3.5"), and the server is deciding WHERE
/// TO CUT A LIVE STREAM, chunk by chunk — accepting it would put the knife
/// inside a sentence, and this repo has paid for that twice (0.2.53, ENG-4).
///
/// Here the only candidate position is the END OF A ROW, and because the
/// server never cuts on `.`, a row that ends in `.` was cut by the `pause` arm:
/// the speaker stopped for >= 600 ms right after that period. THAT is the guard
/// against "U.S." — a period followed by a real pause is a full stop far more
/// often than not — and the letter check below is not; it only throws out
/// numerals ("3.5", "version 3."). An abbreviation followed by a pause
/// ("… the U.S. [600 ms] economy …") IS accepted and closes the paragraph one
/// row early, at a row seam the server already drew. That is the priced error:
/// the cost is a paragraph break at an existing row break, never a sentence
/// split; and the alternative — refusing `.` — takes the sentence arm away from
/// every English recording and sends them all to the hard cap. The test file
/// pins "U.S." as ACCEPTED so that the price stays visible.
///
/// `...` (three ASCII periods) is read as the ellipsis `…`, which IS on the
/// server's list — the same mark typed two ways must not land on two answers.
bool endsSentence(String text) {
  int end = text.length;
  // Find the last visible character, stepping over trailing whitespace and any
  // closing quotes/brackets (with whitespace allowed between them).
  while (end > 0) {
    final String c = text[end - 1];
    if (c.trim().isEmpty || _kClosers.contains(c)) {
      end--;
      continue;
    }
    break;
  }
  if (end == 0) return false;
  final String last = text[end - 1];
  if (kServerSentenceTerminators.contains(last)) return true;
  if (last != '.') return false;
  if (end < 2) return false;
  final String before = text[end - 2];
  if (before == '.') return true; // "..." is "…"
  return _kLetter.hasMatch(before);
}

/// One displayed paragraph: the rows it is made of, in transcript order.
class ArticleParagraph {
  ArticleParagraph(List<TimelineEntry> rows, {required this.closed})
    : rows = List<TimelineEntry>.unmodifiable(rows);

  /// The member rows, oldest first — the order `articleMembersIn` produced.
  final List<TimelineEntry> rows;

  /// False only for the paragraph still being spoken into. A closed paragraph
  /// is a promise: property P1 says it never moves again.
  final bool closed;

  /// Where the paragraph starts inside the recording, or null when the first
  /// row does not know its own offset.
  ///
  /// ⚠️ READ THIS, DO NOT CONFUSE IT WITH THE RULE'S INPUTS. Offsets are how a
  /// paragraph is LABELLED (`formatArticleRange` uses the same two numbers for
  /// a row); they are not, and must never become, how it is DECIDED. See the
  /// file header and test T7.
  ///
  /// Null is null, not 0: a label of 「00:00」 on a paragraph whose position is
  /// unknown is a state word that cannot answer 「凭什么」 (R11), and it would
  /// put the same label on every such paragraph. The screen decides what an
  /// unknown looks like; this layer refuses to invent a number.
  int? get startMs => rows.isEmpty ? null : rows.first.articleOffsetMs;

  /// Where it ends: the last row's offset plus that row's length — or null when
  /// either of those is unknown, for the same reason as [startMs].
  int? get endMs {
    if (rows.isEmpty) return null;
    final TimelineEntry last = rows.last;
    final int? offset = last.articleOffsetMs;
    final int? d = last.durationMs;
    if (offset == null || d == null || d <= 0) return null;
    return offset + d;
  }

  /// The sum of the member rows' lengths — what the rule compares to the floor
  /// and the cap. Not the same as `endMs - startMs` when a row's length is
  /// unknown, and the rule uses THIS one.
  int get spokenMs {
    int total = 0;
    for (final TimelineEntry r in rows) {
      total += _durationOf(r);
    }
    return total;
  }
}

/// The words of one paragraph, read as a single passage — the ONE function for
/// that question.
///
/// This is 「同一段录音读成一段」, not a delivery rule. Forwarding stays
/// `joinSelectedTexts` (owner ruling 2026-08-12 #3: one record, one '\n') —
/// two questions, two functions, and neither may grow the other's job.
/// CR-12-F's with-timestamp format MUST call this for the paragraph body and
/// never join rows itself.
///
/// The seam between two rows of one paragraph is a server-judged natural
/// break inside one spoken passage, not a record boundary, so no newline is
/// drawn. A single ASCII space is inserted only where both neighbours of the
/// seam are non-whitespace ASCII (an English word boundary); CJK rows join
/// directly, the way the approved cell E-2′ draws them. Rows whose displayed
/// text is blank are dropped.
String paragraphText(ArticleParagraph paragraph) {
  final List<String> parts = <String>[
    for (final TimelineEntry r in paragraph.rows)
      if (r.displayText.trim().isNotEmpty) r.displayText.trim(),
  ];
  final StringBuffer b = StringBuffer();
  for (final String part in parts) {
    if (b.isNotEmpty &&
        b.toString().codeUnitAt(b.length - 1) < 128 &&
        part.codeUnitAt(0) < 128) {
      b.write(' ');
    }
    b.write(part);
  }
  return b.toString();
}

int _durationOf(TimelineEntry row) {
  final int? d = row.durationMs;
  // Same judgement as `ArticleClock.claim` (article.dart:120): a row of unknown
  // length happened, and happened HERE, but contributes nothing to the clock.
  // [kParagraphMaxUnknownRows] is what keeps that from meaning "never closes".
  return (d != null && d > 0) ? d : 0;
}

/// The rule, as an incremental reducer — and the ONLY implementation of it.
///
/// [paragraphsOf] is a fold over this class rather than a second, batch
/// algorithm, which is what makes property P2 (live view == read-back view)
/// structural instead of a coincidence two code paths have to keep agreeing on.
/// The test still asserts P2, because the thing it guards against is a FUTURE
/// edit that optimises [paragraphsOf] into its own loop.
///
/// 🔴 THE DECISION IS TAKEN WHEN A ROW ARRIVES, ABOUT THE EDGE IN FRONT OF IT,
/// USING ONLY WHAT CAME BEFORE (plus that row's own pause figure). That is the
/// mechanism behind "a closed paragraph never moves" — not a promise made in a
/// comment. Nothing here can see a later row, so nothing here can revise an
/// earlier answer.
///
/// ⚠️ ONE EXCEPTION, AND IT IS VISIBLE TO THE USER ALREADY. A backfilled
/// segment (ruling ⑮, `article_catchup_screen_test.dart`) is INSERTED by offset
/// into the middle of an article that already has closed paragraphs. The screen
/// re-folds the new member list, and paragraphs after the insertion point may
/// come out differently. That is the same visible effect ⑮ already has ("it
/// fills itself in when it catches up"), and P2 guarantees the re-folded view
/// matches the read-back view. P1 governs the normal path: rows appended at the
/// end while recording.
///
/// ⚠️ THE TAIL CAN BE SHORT, AND THAT IS LEFT ALONE ON PURPOSE. When the last
/// row of a recording is short (the terminal row is the one row the cadence
/// does not bound), it can end up as a paragraph of its own — 「好的。」 at
/// 02:15 under a 60 s paragraph. Merging it back at [onEnd] would withdraw a
/// boundary the screen already drew (P1, and T5's mutation (a) is exactly that
/// merge); deciding at the row's arrival needs to know it IS the last row, and
/// no row says so. So the tail is shown as what it is: the last thing said,
/// with its true timestamp. The test file pins this shape as a case rather than
/// leaving it as an accident.
class ArticleParagrapher {
  ArticleParagrapher({ArticlePauseSource pauseSource = articlePauseBeforeMs})
    : _pauseSource = pauseSource;

  final ArticlePauseSource _pauseSource;
  final List<ArticleParagraph> _closed = <ArticleParagraph>[];
  List<TimelineEntry> _open = <TimelineEntry>[];
  int _openMs = 0;
  int _openUnknown = 0;

  void _start(TimelineEntry row) {
    _open = <TimelineEntry>[row];
    _openMs = _durationOf(row);
    _openUnknown = _durationOf(row) == 0 ? 1 : 0;
  }

  /// Feed the next row of the article, in transcript order.
  void onRow(TimelineEntry row) {
    if (_open.isEmpty) {
      // The first row of a paragraph can never close it: there is no edge in
      // front of it to close.
      _start(row);
      return;
    }
    // Is the edge in front of this row a paragraph-sized break? Every row edge
    // is already a server-judged sentence end or >= 600 ms pause (file header);
    // "qualified" is the subset that is a sentence end or a >= 3 s silence.
    final bool qualified =
        endsSentence(_open.last.displayText) ||
        (_pauseSource(row) ?? 0) >= kStrongPauseMs;
    // 「并不是达1分钟就分」: between the floor and the cap ONLY a qualified
    // edge closes. Past the cap any edge does (the clause the owner did not
    // say, see [kParagraphHardMaxMs]); the count of rows without a length is
    // the backstop for rows the time arms cannot see (see
    // [kParagraphMaxUnknownRows]).
    final bool close =
        (_openMs >= kParagraphSoftMinMs && qualified) ||
        _openMs >= kParagraphHardMaxMs ||
        _openUnknown >= kParagraphMaxUnknownRows;
    if (close) {
      _closed.add(ArticleParagraph(_open, closed: true));
      _start(row);
      return;
    }
    _open.add(row);
    final int d = _durationOf(row);
    _openMs += d;
    if (d == 0) _openUnknown++;
  }

  /// What the screen shows right now: the closed paragraphs plus the one still
  /// being spoken into (`closed: false`).
  List<ArticleParagraph> get paragraphs =>
      List<ArticleParagraph>.unmodifiable(<ArticleParagraph>[
        ..._closed,
        if (_open.isNotEmpty) ArticleParagraph(_open, closed: false),
      ]);

  /// The recording ended: everything is closed now.
  ///
  /// Pure and repeatable on purpose — it reads the state rather than sealing
  /// it, so calling it twice, or calling it and then feeding a late row, cannot
  /// produce a different answer than folding the whole list would.
  List<ArticleParagraph> onEnd() =>
      List<ArticleParagraph>.unmodifiable(<ArticleParagraph>[
        ..._closed,
        if (_open.isNotEmpty) ArticleParagraph(_open, closed: true),
      ]);
}

/// Every paragraph of a finished article — the read-back view.
///
/// [rows] must already be in transcript order, i.e. straight out of
/// `articleMembersIn` (`article_view.dart`), which is the one author of that
/// order.
List<ArticleParagraph> paragraphsOf(
  Iterable<TimelineEntry> rows, {
  ArticlePauseSource pauseSource = articlePauseBeforeMs,
}) {
  final ArticleParagrapher p = ArticleParagrapher(pauseSource: pauseSource);
  for (final TimelineEntry r in rows) {
    p.onRow(r);
  }
  return p.onEnd();
}
