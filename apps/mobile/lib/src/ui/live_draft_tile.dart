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
    required this.mode,
    required this.strings,
    required this.elapsed,
  });

  final String text;
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
              Text(
                strings.liveTranscribing,
                style: TextStyle(
                  color: FlowMicColors.red,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
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
          const SizedBox(height: 3),
          Text(
            text.isEmpty ? '…' : text,
            style: TextStyle(color: FlowMicColors.t3, fontSize: 13.5),
          ),
        ],
      ),
    );
  }
}
