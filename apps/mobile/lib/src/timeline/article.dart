// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.C (the article's data model, ruling 4.C option B), §4.D (the in-article
//     timeline and where each offset comes from), §6 C2 / C5
//   apps/mobile/lib/src/timeline/timeline_entry.dart (`articleId` /
//     `articleOffsetMs` / `kArticle` — the three fields this file writes)
//   packages/protocol/src/constants.ts AUDIO_DEFAULTS (the capture format the
//     byte arithmetic below depends on)
//
// ── WHAT AN ARTICLE IS, IN ONE SENTENCE ─────────────────────────────────────
//
// One continuous recording: the segments stay ordinary rows, and a head row
// holds what is true of the whole. This file owns the two things that are
// nobody else's job — WHICH recording a row belongs to (the id), and WHERE
// inside it the row sits (the clock).
//
// ── 🔴 THE CLOCK IS THE PART THAT CAN LIE, SO READ THIS ONE ─────────────────
//
// An article's timeline is AUDIO TIME measured from the article's first byte.
// There are exactly two sources for it, and the design names both (§4.D):
//
//   · a segment recorded while the link was UP → the engine's own `duration_ms`,
//     which answers 「how long is this segment」 and nothing else. Segments are
//     contiguous on the server's wall clock (`segmentStartMs = boundaryMs`), so
//     the running sum of the ones before a row IS that row's start offset;
//   · a stretch recorded while the link was DOWN → its retained bytes ÷ 32,000.
//     PCM16 / 16 kHz / mono is exactly 32,000 bytes per second and the retention
//     layer does not transcode, so this is a measurement, not an estimate.
//
// 🔴 THE BANNED THIRD SOURCE IS 「when the final reached this phone」. It is
// sitting right there on every inbound frame, it looks like a timestamp, and it
// is systematically late by the engine's latency. One value (when we heard it)
// answering a different question (when it was said) is this repo's headline
// defect shape, and §4.D calls this one out by name.
//
// ⚠️ AND THE AXIS IS NOT WALL-CLOCK EITHER. A recording that spends four minutes
// backgrounded produces no audio for those four minutes, and they do NOT appear
// on this axis. That is correct — the user is asking 「where in this recording
// was that said」 — but it means an article's last offset can be well short of
// (ended − started), and nothing here should be read as if the two agreed.

import 'package:flutter/foundation.dart';

/// Bytes of captured audio per second: PCM16 (2 bytes) × 16 kHz × 1 channel.
///
/// 🔴 EXACT, NOT NOMINAL, and that is what makes byte-count arithmetic a
/// measurement. `AUDIO_DEFAULTS` fixes the capture format and
/// `RetainedAudioStore` writes those bytes through untranscoded — its header
/// says so and gives the reason (a recovery path that is not byte-identical to
/// the live path is a second mechanism that will drift).
///
/// ⚠️ IF THE CAPTURE FORMAT EVER CHANGES, THIS NUMBER IS WRONG AND NOTHING WILL
/// SAY SO. There is no gate that can bind a Dart constant to a protocol default
/// on the other side of the repo; the retained-audio cap carries the same
/// warning for the same reason. What would go wrong is quiet: every offline
/// stretch would be placed at the wrong offset, in proportion.
const int kPcmBytesPerSecond = 32000;

/// Milliseconds of audio in [bytes] of captured PCM.
///
/// Truncates. A partial millisecond is not audio anyone said, and rounding up
/// would let a long article accumulate offsets slightly ahead of its own
/// content — the direction that makes a timestamp point at something that has
/// not started yet.
int pcmBytesToMs(int bytes) =>
    bytes <= 0 ? 0 : (bytes * 1000) ~/ kPcmBytesPerSecond;

/// Mint the id for one article.
///
/// [seq] is the session's own counter and [micros] a wall-clock reading; the
/// pair is exactly the shape `PttSession` already mints utterance client ids
/// with (`u{seq}-{micros}`), and reusing that shape is deliberate — a second
/// id-minting convention in one app is a second thing to get right.
///
/// ⚠️ NOT a random uuid, and not derived from anything the server says. This id
/// has to exist BEFORE the first byte is captured (the retained-audio files are
/// keyed by it) and has to survive a link that never comes back, so nothing on
/// the wire may be part of it.
String mintArticleId({required int seq, required int micros}) =>
    'a$seq-$micros';

/// Where each row of one article starts, in audio milliseconds from its first
/// byte.
///
/// ── WHY THIS IS A CLASS AND NOT A `fold` OVER THE ROWS ──────────────────────
///
/// Because the offline stretch has no row of its own until its audio is
/// re-transcribed, which can be minutes later or never. At the moment the link
/// comes back, the phone knows exactly how much audio it retained; if that is
/// not accounted for THEN, the live rows that follow are placed as though the
/// outage had no duration, and every one of them is early by the length of the
/// outage. Deriving offsets later from the rows that exist would produce a
/// confident, wrong answer — and it is confident because the rows themselves
/// look complete.
///
/// ⇒ 「how much audio has this article accounted for so far」 is a fact that must
/// be maintained as it happens. That is this object.
class ArticleClock {
  ArticleClock({required this.articleId, required this.startedAt});

  final String articleId;

  /// Wall-clock start, for the head row's display only. NEVER an input to an
  /// offset — see the file header on why the two axes must not be mixed.
  final DateTime startedAt;

  int _accountedMs = 0;

  /// Total audio time this article has accounted for. The next row starts here.
  int get accountedMs => _accountedMs;

  /// Claim the offset for a row covering [durationMs] of audio, and advance.
  ///
  /// A null or non-positive duration claims its offset and advances by nothing.
  /// That is the honest handling of a row whose engine never reported a length:
  /// it still HAPPENED, and it happened here — but it cannot contribute to
  /// where the next one starts, because we do not know how long it was.
  /// Advancing by a guessed default would push every later row wrong by the
  /// guess, and the error would compound.
  int claim(int? durationMs) {
    final int start = _accountedMs;
    if (durationMs != null && durationMs > 0) _accountedMs += durationMs;
    return start;
  }

  /// Account for a stretch recorded while the link was down, given its retained
  /// byte count. Returns the offset that stretch STARTS at.
  ///
  /// 🔴 CALLED WHEN THE STRETCH ENDS, NOT WHEN ITS TEXT ARRIVES. The bytes are
  /// on disk and countable the moment the link returns; the transcript may be
  /// far behind (ruling ⑮ allows it to lag, provided the UI says so). Waiting
  /// for the text would leave every row spoken after the outage sitting at an
  /// offset that ignores the outage entirely.
  int accountOfflineBytes(int bytes) {
    final int start = _accountedMs;
    _accountedMs += pcmBytesToMs(bytes);
    return start;
  }

  /// A backfilled row lands INSIDE a stretch that has already been accounted
  /// for, so it must not advance the clock again.
  ///
  /// [stretchStartMs] is what [accountOfflineBytes] returned for that stretch,
  /// and [withinMs] is the sum of the durations of the backfilled rows before
  /// this one in the same stretch. Kept as an explicit pair rather than a second
  /// cursor on this object: a stretch is replayed asynchronously, possibly
  /// interleaved with live recording, and a shared cursor would then be answering
  /// two questions at once — the exact shape this repo keeps paying for.
  static int offsetWithinStretch({
    required int stretchStartMs,
    required int withinMs,
  }) => stretchStartMs + withinMs;
}

/// What an article's head row says about the whole recording.
///
/// Derived, never authored: every field is a function of the member rows, so
/// there is no second place where 「how many segments does this article have」
/// could disagree with the segments. The head row STORES the derivation because
/// a list of articles must not decode every row to draw a card — but it is
/// recomputed from the rows on every change, so a stale head is a bug with one
/// obvious repair rather than a fact nobody can check.
@immutable
class ArticleSummary {
  const ArticleSummary({
    required this.articleId,
    required this.startedAt,
    required this.endedAt,
    required this.segmentCount,
    required this.durationMs,
    required this.wordCount,
    required this.title,
  });

  final String articleId;
  final DateTime startedAt;
  final DateTime endedAt;
  final int segmentCount;

  /// Audio time, summed from the member rows — see the file header. NOT
  /// `endedAt - startedAt`, which counts pauses the recording did not record.
  final int durationMs;
  final int wordCount;

  /// The first words of the recording, bounded. Editable by the user, which is
  /// what makes it a stored field rather than a render-time slice: an edited
  /// title must survive, and it sets the row's `edited` bit like any other edit.
  final String title;

  /// The bound on a derived title. Long enough to be recognisable in a list,
  /// short enough that the card does not become the transcript.
  static const int kTitleMaxChars = 40;

  /// Derive a title from the first segment's words.
  ///
  /// ⚠️ Cuts on a code-unit boundary and appends nothing. No ellipsis, because
  /// the list card already truncates for layout and two truncations would make
  /// 「…」 part of the stored data — a display artefact written to disk, which is
  /// how a rendering decision becomes permanent.
  static String titleFrom(String firstText) {
    final String t = firstText.trim();
    if (t.length <= kTitleMaxChars) return t;
    return t.substring(0, kTitleMaxChars);
  }
}
