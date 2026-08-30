// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.C (「一篇」/ the article), §4.D (the in-article timeline), §6 C2 / C5
//   apps/mobile/lib/src/timeline/article.dart (the id, the clock, the summary)
//   apps/mobile/lib/src/ptt/ptt_continuous.dart (the ONE begin and ONE end this
//     object hangs off — C8 is a claim about every exit)
//
// ── WHAT THIS IS ────────────────────────────────────────────────────────────
//
// The FOURTH thing that turns on when a continuous recording starts. The other
// three — the flag (CR-3), the screen hold (CR-2) and the ceiling's clock
// (CR-6) — are already begun and ended in one place for the reason C8 states:
// five exits × N verbs is N chances at each exit to forget one, and the one
// that gets forgotten is the one whose symptom shows up a week later.
//
// This one's symptom would be worse than a battery reading. A scribe left open
// after a recording ends would stamp the NEXT utterance — an ordinary
// push-to-talk sentence, spoken hours later — with the previous recording's id,
// and it would appear inside that article, at an offset derived from a clock
// that has been standing still. That is the ID-CROSS-WIRING shape (owner's
// 「绝不许串号」) arriving in the audio-ownership direction rather than the
// delivery-addressing one, and §11-d already records the retained-audio half of
// exactly this hazard.
//
// ⇒ it lives beside them, opens with them, and closes with them.
//
// ── WHY IT IS ON THE SESSION AND NOT ON THE CONTROLLER ──────────────────────
//
// Because both of its inputs are session-layer facts:
//   · a segment's duration arrives on `stt:final`, which the session dispatches;
//   · an outage's LENGTH is a byte count on disk, known to the retention layer
//     the moment the link returns — and known to nobody else, ever, because
//     `settle` deletes those bytes as soon as the segment is transcribed.
// The controller is a READER: it asks 「which article, and at what offset」 while
// minting a row. Putting the scribe there would have meant the link-loss edge
// reaching up into the UI layer to report a byte count, which is the wrong
// direction and the hard one to undo.

import '../timeline/article.dart';
import 'article_replay.dart';

/// Whose recording this row belongs to, and where inside it.
///
/// Closed by default. Every getter answers null while closed, so a caller that
/// forgets to ask 「is one open」 gets 「this row belongs to no recording」 — the
/// same answer every ordinary push-to-talk row has always had. Failing toward
/// 「no article」 rather than toward 「the last article」 is the whole reason this
/// is an object rather than two nullable fields on the session.
class ArticleScribe {
  ArticleScribe({int Function()? micros}) : _micros = micros ?? _wallMicros;

  final int Function() _micros;
  static int _wallMicros() => DateTime.now().microsecondsSinceEpoch;

  ArticleClock? _clock;
  int _seq = 0;

  /// The stretch being re-transcribed right now, if any.
  ///
  /// 🔴 IT TAKES PRECEDENCE OVER THE LIVE CLOCK IN [claim], and it must: while a
  /// replay is feeding recovered audio through the ordinary transcription path,
  /// EVERY row that settles is a recovered one. There is no interleaving to get
  /// wrong, because a replay and a live capture cannot both hold the microphone
  /// — the replay only runs when nothing is being recorded (see BackfillRunner).
  ///
  /// ⚠️ The two are separate objects rather than two modes of one, so a row's
  /// offset can always be traced to WHICH cursor answered. See
  /// article_replay.dart for why that separation is not ceremony.
  ArticleReplayCursor? _replay;

  /// Where each outage BEGAN, per article, in the order the outages happened.
  ///
  /// 🔴 THIS MEMORY IS THE ONLY PLACE THE ANSWER SURVIVES, and the recovery
  /// runs long after the moment it was knowable. Deriving it later from the
  /// rows — 「the gap starts where the last row ended」 — is correct ONLY for
  /// an orphan whose app died in the gap. When the link came back and the
  /// user kept talking, the rows that follow the gap are already past it, so
  /// that derivation lands the recovered sentences AFTER the ones they
  /// preceded. Measured: the C3 acceptance produced exactly that order.
  ///
  /// ⚠️ Deliberately NOT cleared by [end]. The recording ends, and only then
  /// can the recovery run; a map cleared with the recording would take the
  /// answer with it. Each entry is dropped when it is handed out.
  final Map<String, List<int>> _stretchStarts = <String, List<int>>{};

  /// The article rows should be filed under right now — the stretch being
  /// replayed if there is one, otherwise the recording that is running.
  String? get articleId => _replay?.articleId ?? _clock?.articleId;
  bool get isOpen => _clock != null || _replay != null;

  /// The recording that is STILL BEING RECORDED, or null.
  ///
  /// 🔴 NOT [articleId], and the difference is the whole reason this getter
  /// exists. [articleId] answers 「where do rows go right now」 and therefore
  /// names the REPLAYED article while a recovery sweep is placing recovered
  /// segments — which happens long after that recording ended. A screen that
  /// asked [articleId] 「is this recording still running」 would be told yes for
  /// a finished piece, and would un-collapse it back into loose rows in the
  /// middle of a sweep, then collapse it again when the sweep finished.
  ///
  /// One value, one question: the clock is open only while the microphone is.
  String? get liveArticleId => _clock?.articleId;

  /// Whether a recovered stretch is being placed right now.
  bool get isReplaying => _replay != null;

  /// Audio time accounted for so far, or null when nothing is open.
  int? get accountedMs => _clock?.accountedMs;

  /// The open recording's wall-clock start — the head row's `createdAt`.
  DateTime? get startedAt => _clock?.startedAt;

  /// Open a new article and return its id.
  ///
  /// The id is minted HERE, before a single byte is captured, and that ordering
  /// is load-bearing rather than tidy: the retained-audio files are keyed by it
  /// (CR-4), so an id that appeared later would leave the outage's own audio
  /// filed under nothing. It is also why nothing on the wire may contribute to
  /// it — this recording may never reach a server at all.
  ///
  /// ⚠️ Re-opening while one is already open REPLACES it. There is no such thing
  /// as two continuous recordings at once (the entry is disabled while one
  /// runs, and the live bar replaces the push-to-talk bar rather than sitting
  /// beside it), so the alternative — refusing, and leaving the previous
  /// recording's id in place — would attach the new recording's words to the old
  /// one. Between two wrong answers, take the one whose damage stops here.
  String begin({DateTime? startedAt}) {
    // A new recording ends any replay: nothing the microphone produces from here
    // belongs to an old gap.
    _replay = null;
    final String id = mintArticleId(seq: _seq++, micros: _micros());
    _clock = ArticleClock(
      articleId: id,
      startedAt: (startedAt ?? DateTime.now()).toUtc(),
    );
    return id;
  }

  /// Close the open article AND any replay in progress.
  ///
  /// Called from the edges that are about to mint rows belonging to neither:
  /// an ordinary press, and the session going away.
  void end() {
    _clock = null;
    _replay = null;
  }

  /// Claim this row's place in the recording: its article and its start offset.
  ///
  /// Null when no recording is open, which is the answer for every ordinary
  /// utterance and must stay cheap to get.
  ///
  /// 🔴 CLAIMING ADVANCES THE CLOCK, so it must be called ONCE per row and only
  /// for a row that is really being minted. A caller that claimed twice for one
  /// row would push every later row late by that row's own length, and the
  /// error compounds silently down the rest of the recording — there is nothing
  /// to compare it against.
  ({String articleId, int offsetMs})? claim(int? durationMs) {
    final ArticleReplayCursor? r = _replay;
    if (r != null) {
      return (articleId: r.articleId, offsetMs: r.claim(durationMs));
    }
    final ArticleClock? c = _clock;
    if (c == null) return null;
    return (articleId: c.articleId, offsetMs: c.claim(durationMs));
  }

  /// Begin placing the rows recovered from one offline stretch.
  ///
  /// The caller supplies where that stretch starts, because only the caller can
  /// know: the live clock has it while the recording is still running, and an
  /// orphan from a killed app has to derive it from the rows already filed under
  /// the article. Never zero by default — see article_replay.dart.
  void beginReplay(ArticleReplayTarget target) {
    _replay = ArticleReplayCursor(target);
  }

  /// Stop placing recovered rows. Idempotent.
  ///
  /// 🔴 CALLED ONLY WHEN NO RECOVERY SESSION WAS OPENED. Closing it after a
  /// successful one — which is where it was first put, and it looked like the
  /// obvious place — closes it BEFORE the rows arrive: the FSM reaches rest
  /// on the terminal frame, and the settlement that frame triggers runs a
  /// microtask later, off a stream. The recovered sentences were then stamped
  /// by the LIVE clock and filed at the end of the recording, which is the
  /// exact defect the replay cursor exists to prevent.
  ///
  /// It is the §11-c shape for the third time in this unit: a teardown ahead
  /// of something that still reads what it tears down. The cursor is closed
  /// instead by [begin] and [end] — the edges that are about to mint rows
  /// belonging to something else — and nothing else can mint a row in
  /// between.
  void endReplay() {
    _replay = null;
  }

  /// An offline stretch of [bytes] captured PCM has ended. Account for its
  /// duration and return the offset it starts at (null when nothing is open).
  ///
  /// See [ArticleClock.accountOfflineBytes] for why this happens when the
  /// STRETCH ends rather than when its text arrives.
  int? accountOfflineBytes(int bytes) {
    final ArticleClock? c = _clock;
    if (c == null) return null;
    final int start = c.accountOfflineBytes(bytes);
    (_stretchStarts[c.articleId] ??= <int>[]).add(start);
    return start;
  }

  /// The next recorded outage start for [articleId], oldest first — WITHOUT
  /// consuming it.
  ///
  /// FIFO because outages happen in time order and the retained segments are
  /// recovered in ascending index order — the two sequences are the same
  /// sequence. Null once they are used up, which is the signal to fall back
  /// to the row derivation (correct for an orphan, and only then).
  ///
  /// 🔴 READING AND CONSUMING ARE SEPARATE VERBS, and merging them was a real
  /// defect: a sweep fires on the link edge while the recording is still
  /// running, is correctly refused by the FSM gate — and a destructive read
  /// had already thrown the answer away. The recovery that ran minutes later
  /// then fell through to the row derivation and filed the recovered
  /// sentences AFTER the live ones that followed them. Measured on the C3
  /// acceptance, twice.
  ///
  /// ⇒ [dropStretchStart] is called only once a stretch has really been
  /// recovered.
  int? peekStretchStart(String articleId) {
    final List<int>? starts = _stretchStarts[articleId];
    if (starts == null || starts.isEmpty) return null;
    return starts.first;
  }

  /// Forget the oldest recorded outage start for [articleId] — its stretch
  /// has been recovered and its rows exist.
  void dropStretchStart(String articleId) {
    final List<int>? starts = _stretchStarts[articleId];
    if (starts == null || starts.isEmpty) return;
    starts.removeAt(0);
    if (starts.isEmpty) _stretchStarts.remove(articleId);
  }
}
