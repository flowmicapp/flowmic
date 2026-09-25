// REQ-12-13 — how a remote control-key row looks in the phone's history
// (owner P0 2026-08-12). Contract = docs/rebuild/15 §2.0-e; ruling =
// docs/decisions/2026-08-12-owner-p0-control-key-history-and-haptics.md.
//
// ── WHY A SEPARATE TILE, RATHER THAN A BRANCH ADDED TO ChatMessageTile ──────
// Every cell in `ChatMessageTile` answers a question about **delivery**:
// the status pill, the resend button, the failure code, "→ PC → window",
// duration and word count. NOT ONE cell of this row applies — it is not a
// delivery, it is a keypress (the fifth paragraph of 15 册 §2.0-e). Cramming
// it in would mean every one of those seven or eight predicates grows an
// extra 「…except when it's a control-key row」 clause, and this repo has paid
// for that shape many times over.
//
// This row normally says only "sent". A `control:key-result` may now add one
// independent terminal fact: submission is uncertain. That state does not
// claim failure or success, and `deliveryFaceOf` remains reserved for message
// delivery rows — the fork still happens before it.

import 'package:flutter/widgets.dart';

import '../settings/app_strings.dart';
import '../timeline/timeline_entry.dart';
import 'time_label.dart';
import 'control_key_face.dart';
// Re-exported so `controlKeyLabel` is still reached through this file: the move
// to control_key_face.dart was made for banner_queue.dart's sake, and a move
// must not make callers (or their tests) edit imports to keep working.
export 'control_key_face.dart' show controlKeyLabel;
import 'tokens.dart';

// 🔴 `controlKeyLabel` moved VERBATIM to control_key_face.dart (card MP-14).
// It is unchanged and still reached from here — the move exists because
// banner_queue.dart now needs the same function and declares itself
// Flutter-free, and a second copy of a display name is the copy-side version of
// this repo's #1 defect shape, which that function's own comment already names.

/// A single remote control-key row.
class ChatControlTile extends StatelessWidget {
  const ChatControlTile({
    super.key,
    required this.entry,
    required this.strings,
    this.onLongPress,
  });

  final TimelineEntry entry;
  final AppStrings strings;

  /// Long-press still opens the menu — **kept deliberately**: Delete and
  /// Multi-select in that menu still apply to this row, and removing
  /// long-press would mean a control-key row **could only ever be deleted by
  /// clearing the whole history**. The menu itself has already withheld
  /// deferred re-delivery / edit / re-run / copy / favorite for this row
  /// (entry_context_menu.dart).
  final void Function(TimelineEntry entry)? onLongPress;

  @override
  Widget build(BuildContext context) {
    final String kind = entry.controlKind ?? '';
    final bool uncertain = (entry.status == EntryStatus.cached &&
          (entry.failureReason == 'INJECT_SUBMISSION_UNCERTAIN' ||
           entry.failureReason == 'submission_uncertain'));
    final Widget card = Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 9),
      decoration: BoxDecoration(
        color: FlowMicColors.surface,
        border: Border.all(color: FlowMicColors.line),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                timelineTimeLabel(entry.createdAt),
                style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
              ),
              const SizedBox(width: 7),
              // 🔴 Flexible + ellipsis, same reasoning as this row's other
              // cells, but **the test must not land on `Text.data`** (the
              // 0.2.53 rule): whether it can be read is a post-render fact.
              // So this cell deliberately carries only two things — the icon
              // and the status word — and never gets a third thing crammed
              // into it.
              Flexible(
                child: Text(
                  strings.controlRowLabel(controlKeyLabel(strings, kind)),
                  key: ValueKey<String>('entry.control.$kind.${entry.id}'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: FlowMicColors.t1, fontSize: 12.5),
                ),
              ),
              const SizedBox(width: 7),
              Text(
                uncertain ? strings.injectionUncertain : strings.controlRowSent,
                key: ValueKey<String>('entry.control.status.${entry.id}'),
                style: TextStyle(color: FlowMicColors.t2, fontSize: 10.5),
              ),
            ],
          ),
          if (uncertain) ...<Widget>[
            const SizedBox(height: 5),
            Text(
              strings.injectVerdictNote('INJECT_SUBMISSION_UNCERTAIN') ??
                  strings.injectionUncertain,
              key: ValueKey<String>('entry.control.uncertain.${entry.id}'),
              style: TextStyle(color: FlowMicColors.amber, fontSize: 11),
            ),
          ],
          // The Clear key is still the only one of the four that carries a
          // note, but **the reason changed** (T-1, 2026-08-13): it used to
          // carry a note because "it did two things in one press" (08 §5, both
          // this device AND the computer); after owner's supplement #3 removed
          // the local half, ✕ now only touches the computer, same as the
          // other three keys.
          // 🔴 The note stays, because **this is the only key that could make
          // someone worry about their own draft** — the 「✕」 glyph has a
          // sibling elsewhere in this app with the opposite consequence
          // (discarding the floating card goes through `discardBuffer`). This
          // line states exactly that distinction, and now both halves of it
          // are true.
          if (kind == 'clear') ...<Widget>[
            const SizedBox(height: 3),
            Text(
              strings.controlRowClearNote,
              key: ValueKey<String>('entry.control.clearNote.${entry.id}'),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: FlowMicColors.t3, fontSize: 11),
            ),
          ],
        ],
      ),
    );
    if (onLongPress == null) return card;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onLongPress: () => onLongPress!(entry),
      child: card,
    );
  }
}
