// VERBATIM MOVE out of chat_message_tile.dart (800-line cap: that file stood at
// 799/800 and card FB-7 has to add a selection affordance to it). [LiveDraftTile]
// is the whole cut — it is the ONE class in that file with no shared state and
// exactly one call site (`chat_flow_page.dart`'s `itemBuilder`, `live && i == 0`).
//
// `part of`, not a standalone library, for two reasons and both are load-bearing:
//   ① `_cardDecoration` is library-private and this class calls it. A standalone
//      file would have forced that helper to become public or be duplicated —
//      a duplicate is how the live row and the committed row would stop agreeing
//      about what a card looks like.
//   ② every existing import site (`import 'chat_message_tile.dart'`) keeps
//      resolving `LiveDraftTile`, so this move touches zero call sites.
//
// 🔴 Diff discipline: the body below is byte-identical to what stood at
// chat_message_tile.dart:696-799. No rename, no reflow, no comment edit. Any
// other diff is a bug.

part of 'chat_message_tile.dart';

/// The active transcription row (demo frame 3): grows with the interim, shows a
/// blinking cursor and a red "转录中"("transcribing") pill. Never persisted,
/// never long-pressable.
///
/// §4b-8 「转录中窗口动态显示本次时长/字数」("the transcribing window
/// dynamically shows this utterance's duration/word-count") — BOTH halves,
/// now wired.
///
/// Word count: real and live (`textWordCount(text)` on the SAME [text] this tile
/// already renders, growing exactly as the interim does — no separate
/// derivation to drift from the body).
///
/// Duration: [elapsed] is `ChatController.recordingElapsed` — the SAME real
/// elapsed-since-audio:start clock `recording_panel.dart` already renders,
/// driven by `RecordingTelemetry`'s own 200ms ticker
/// (`recording_telemetry.dart`, `onTick: notifyListeners`), NOT a timer
/// invented in this widget. **Verified, not assumed** (chat_controller.dart
/// read-only, per this card's file-ownership fence): `onFsmChangeRouted`
/// calls `recording.stop()` the instant the session leaves `recording` —
/// including the move into `processing` — and [RecordingTelemetry.stop] only
/// cancels the ticker, it does NOT zero `_elapsed`
/// (`reset()`, the only call that zeroes it, fires solely at the NEXT
/// `pttDown()` or on swipe-cancel — both of which also end THIS draft, so
/// they never fire while this tile is still showing THIS utterance). So
/// [elapsed] genuinely stays frozen at the true spoken duration all the way
/// through `processing`, exactly matching [RecordingTelemetry.elapsed]'s own
/// doc ("Frozen once recording ends") — there is no null/zero-during-
/// processing case to special-case here.
///
/// REQUIRED, not defaulted: same reasoning as [ChatMessageTile.queued] — a
/// friendly default would silently restore the "capability nobody calls"
/// façade this repo has already been burned by, and the compiler is a better
/// enforcement than a comment asking the caller to remember.
class LiveDraftTile extends StatelessWidget {
  const LiveDraftTile({
    super.key,
    required this.text,
    required this.committedChars,
    required this.mode,
    required this.strings,
    required this.elapsed,
    required this.statusLabel,
    required this.healthNote,
  });

  final String text;

  /// AW-1b — what the red status pill reads. REQUIRED, not defaulted to
  /// [AppStrings.liveTranscribing] here, for the same reason every other
  /// REQUIRED field on this class gives (see [committedChars]'s own doc): a
  /// friendly default would silently let a caller forget to plug in the
  /// health mapping, and that is exactly the "capability nobody calls" shape
  /// this repo has already been burned by. The mapping itself
  /// (normal/no-first-result/no-progress/byte-stall/terminal-error, §A8) lives
  /// in `live_health_copy.dart`'s `liveHealthLabel`, NOT here — this widget
  /// only renders the one string it is handed (0.2.53's render-result law
  /// stays about what paints, not about who decides what to paint).
  final String statusLabel;

  /// AW-1b — the ASR-leg health sentence (`live_health_copy.dart`'s
  /// `liveHealthNote`), or null when every signal is clear. It gets its OWN
  /// FULL-WIDTH LINE below the header row; it is deliberately NOT poured into
  /// [statusLabel]'s pill, and that is measured, not aesthetic: at 360 dp the
  /// pill is 52-170 logical pixels wide and these sentences want 171-478, so
  /// 40 of 45 locale x signal combinations rendered as an ellipsed fragment.
  /// See `liveHealthNote`'s own doc for the 0.2.53 precedent this follows, and
  /// `live_draft_tile_render_test.dart` for the loop that now measures every
  /// one of them on the rendered paragraph.
  ///
  /// REQUIRED, not defaulted to null — same reasoning as every other field on
  /// this class: a friendly default is how a caller silently stops passing the
  /// health mapping and nothing ever says so.
  final String? healthNote;

  /// How many characters at the head of [text] the SERVER has already
  /// finalised. Everything before it is BLACK (confirmed, and already through
  /// normalisation/dictionary/punctuation/polish); everything after it is GREY
  /// (still being transcribed).
  ///
  /// 🔴 THE SAME TWO COLOURS MEAN THE SAME TWO THINGS ON THE PC CAPSULE
  /// (owner, 2026-09-04). The model and the frame semantics behind it are
  /// written out once, in apps/desktop/src/capsule/utterance-view.ts; the phone
  /// half is `UtteranceView` and the two are pinned to one shared fixture,
  /// verify/fixtures/utterance-view-parity.json. This tile used to paint the
  /// WHOLE draft `t3` (grey), so a segment the server had finalised and a
  /// half-heard interim looked identical.
  ///
  /// REQUIRED, not defaulted — the same reasoning the rest of this class's
  /// parameters give: a friendly default (0) would silently paint a finished
  /// transcript as unconfirmed and nothing would ever say so.
  final int committedChars;
  final FlowMode mode;

  /// See [ChatMessageTile.strings].
  final AppStrings strings;

  /// See the class doc — `ChatController.recordingElapsed`, verbatim.
  final Duration elapsed;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: _cardDecoration(border: const Color(0x73818CF8)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              ModeBadge(mode, strings: strings),
              const SizedBox(width: 7),
              Text(
                strings.liveNow,
                style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
              ),
              const SizedBox(width: 7),
              StatusDot(FlowMicColors.red),
              const SizedBox(width: 7),
              Flexible(
                child: Text(
                  statusLabel,
                  overflow: TextOverflow.ellipsis,
                  maxLines: 1,
                  style: TextStyle(
                    color: FlowMicColors.red,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              // §4b-8 duration/word-count side by side (see class doc for
              // the real-source proof).
              // Duration is UNCONDITIONAL: [elapsed] is a real value the instant
              // this tile exists (RecordingPanel already shows the same
              // "00:00" at the same instant — see its own widget test), so
              // there is no null/absent case to gate here, unlike a landed
              // row's `durationMs`. Word count stays gated on non-empty
              // text: while
              // the row still shows the bare "…" placeholder nothing has been
              // counted yet, and a trailing "0 words" would read as noise.
              const SizedBox(width: 7),
              Text(
                text.isEmpty
                    ? formatEntryDuration(elapsed.inMilliseconds)
                    : '${formatEntryDuration(elapsed.inMilliseconds)} · '
                          '${strings.entryWordCountLabel(textWordCount(text))}',
                style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
              ),
            ],
          ),
          // AW-1b — the health sentence, full width, its own line.
          //
          // ⚠️ An earlier revision of this comment argued for a "maxLines 4,
          // MEASURED" clamp. There is no clamp, there never was one in this
          // file, and the argument was for a design the code below rejects —
          // a comment describing a decision nobody took, sitting where the
          // opposite decision is written out. Deleted rather than corrected;
          // the reasoning that survives is on the Text itself.
          if (healthNote != null) ...<Widget>[
            const SizedBox(height: 3),
            Text(
              healthNote!,
              // NO maxLines and NO ellipsis, for the reason `_draftText`
              // below gives for the same choice: a clipped sentence is a
              // sentence the user did not read. MEASURED at 360 dp under the
              // test font: the five `liveHealth*` keys take 1-2 lines, while
              // the terminal-error branch reuses `sttStallBannerMessage`,
              // whose entries are 165-206 characters and want 8-11. Any clamp
              // that fits the first cuts the second in half — which is
              // exactly the 0.2.53 failure, one layer down.
              //
              // 🔴 WITH NO CLAMP, `didExceedMaxLines` CAN NEVER BE TRUE HERE,
              // so a test that asserts it is false about this paragraph is a
              // tautology and says nothing (a whole locale loop of them said
              // nothing for a while). What is actually at risk is HEIGHT: the
              // row lives in the timeline list, so what a long paragraph can
              // do is push the rest of the tile up, not get cut. That is what
              // `live_draft_tile_render_test.dart` measures now — a height
              // budget at 360x640 with a control that can exceed it, plus one
              // case that mounts the whole screen and requires the PTT bar to
              // still be on it.
              style: TextStyle(
                color: FlowMicColors.red,
                fontSize: 11.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
          const SizedBox(height: 3),
          // ⚠️ ONE Text, TWO spans — never two Text widgets. The split is a
          // slice of a single string, so the black half and the grey half wrap
          // as one paragraph and cannot disagree about which characters exist.
          // No maxLines / no overflow: the draft may grow, and the reversed
          // list keeps its tail (the newest words) against the bottom of the
          // screen while the head scrolls out of view. An ellipsis here would
          // drop words the user actually said.
          _draftText(),
        ],
      ),
    );
  }

  Widget _draftText() {
    if (text.isEmpty) {
      return Text(
        '…',
        style: TextStyle(color: FlowMicColors.t3, fontSize: 13.5),
      );
    }
    // Clamped rather than trusted: a split that ran past the end of the string
    // would throw in front of the user, and 「all grey」 is the honest fallback
    // (grey claims nothing; black claims the server finalised it).
    final int cut = committedChars < 0
        ? 0
        : (committedChars > text.length ? 0 : committedChars);
    const TextStyle base = TextStyle(fontSize: 13.5);
    return Text.rich(
      TextSpan(
        children: <InlineSpan>[
          if (cut > 0)
            TextSpan(
              text: text.substring(0, cut),
              style: base.copyWith(color: FlowMicColors.t1),
            ),
          if (cut < text.length)
            TextSpan(
              text: text.substring(cut),
              style: base.copyWith(color: FlowMicColors.t3),
            ),
        ],
      ),
    );
  }
}
