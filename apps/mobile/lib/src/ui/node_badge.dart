// owner 2026-08-30 — 「给手机上的 PC 连接实例信息增加一个节点的微小图标显示，
// 转录界面的 PC 实例名旁也加这样的小图标，好容易区分」 with the labels named:
// the Tokyo node reads `asia`, the New York one reads `us`.
//
// SPEC-REF: apps/server-core/src/http/node-routes.ts (NodeEntry.short — where
//   the label comes from and why it is not a map in this app);
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §1.
//
// ── WHAT IT IS AND IS NOT ────────────────────────────────────────────────────
//
// It answers ONE question — 「我这条云端通道走的是哪个机房」 — and it is
// INFORMATION, never a control. Only the desktop chooses a node; the phone
// follows its PC (§4-1, and that following is what removes cross-node room
// sync from the design entirely). So it must not look tappable, must not sit in
// a row of buttons, and must never be worded as a choice.
//
// 🔴 ABSENT ON LAN, AND THAT IS THE HONEST ANSWER RATHER THAN A GAP. A local
// connection does not pass through a node at all, so a badge reading `us` there
// would be a fact about a path that connection never takes. The caller decides
// (it is the one holding the channel); this widget only refuses to draw an
// empty string.
//
// ── WHY IT LOOKS LIKE THIS ───────────────────────────────────────────────────
//
//   · a PILL, matching `ChannelBadge`'s vocabulary rather than inventing one —
//     the two are siblings: the channel badge answers 「LAN or cloud」, this one
//     answers 「WHICH cloud door」, and a user who has learnt to read one has
//     already learnt to read the other;
//   · a DIFFERENT ink from the channel badge, because two pills side by side in
//     the same colour read as one control split in two;
//   · TEXT, not a flag or a globe. A flag is a political claim we have no
//     business making about a datacentre, and a globe cannot distinguish two
//     nodes — which is the entire job;
//   · `tabular` figures and a fixed height so a `us` → `asia` change cannot
//     reflow the row it sits in. That row holds the computer's NAME, which this
//     product has already starved twice (0.2.51).

import 'package:flutter/material.dart';

import 'tokens.dart';

/// A node label pill — `us`, `asia`. Nothing when there is no node to name.
class NodeBadge extends StatelessWidget {
  const NodeBadge({super.key, required this.label, this.dense = false});

  /// Already resolved by the caller: the operator's `short`, or empty.
  ///
  /// 🔴 RESOLUTION IS THE CALLER'S JOB, not this widget's, so that 「what may
  /// appear here」 is decided at the one place that knows both the id and the
  /// label ([nodeBadgeLabel]). A widget that took an id and a label and picked
  /// between them would be a second author for that decision — and it is a
  /// decision with a rule on it: the id must never reach a screen.
  final String label;

  /// The transcription header is tighter than the instance list.
  final bool dense;

  @override
  Widget build(BuildContext context) {
    if (label.trim().isEmpty) return const SizedBox.shrink();
    return Container(
      key: ValueKey<String>('node.badge.$label'),
      padding: EdgeInsets.symmetric(horizontal: dense ? 5 : 6, vertical: 1),
      decoration: BoxDecoration(
        color: FlowMicColors.slateSoft,
        borderRadius: BorderRadius.circular(99),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.clip,
        style: TextStyle(
          color: FlowMicColors.t2,
          fontSize: dense ? 9 : 9.5,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.3,
          fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
        ),
      ),
    );
  }
}

/// The label to draw for [nodeId] — the operator's word, or NOTHING.
///
/// 🔴 2026-08-30, owner: 「当前只有 asia/us 两个节点，不要显示其它文字」. An
/// earlier draft of this function fell back to the node ID, and argued for it:
/// hiding the badge would make its absence mean two things (a LAN connection,
/// and 「we have no label yet」).
///
/// That argument loses to one that was already written down, and I should have
/// reached it first: **`srvjp` is an internal identifier**, and the 2026-08-22
/// iron rule says every word a user can see must not be a placeholder, a
/// half-finished thing, or internal vocabulary (the web console has a lint for
/// exactly this — `no-raw-identifiers.test.ts`). A relay node's id is our word
/// for it, not the user's.
///
/// ⚠️ The 0.2.53 precedent I cited for the fallback does NOT transfer, and the
/// difference is worth stating: there, printing an unregistered error code beat
/// INVENTING a sentence for it — the choice was between an identifier and a
/// fabrication. Here the alternative is nothing at all, and nothing is honest.
///
/// ⇒ Empty means 「no label to show」, and every caller must then draw no badge.
/// The ambiguity the old argument worried about is real and is simply cheap:
/// both branches produce the same correct behaviour, which is silence.
String nodeBadgeLabel(String? nodeId, Map<String, String> shortById) {
  final String id = (nodeId ?? '').trim();
  if (id.isEmpty) return '';
  final String? short = shortById[id];
  return (short != null && short.trim().isNotEmpty) ? short.trim() : '';
}
