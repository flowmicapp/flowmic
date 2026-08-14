// Card U4 — what the narrowed chat list looks like when it has no rows to paint.
//
// 🔴 THREE faces, never two. Before this card the list was simply built with
// `itemCount: 0`, so "just paired, haven't spoken yet" (刚配对完，还没说过话)
// and "this PC's history is still loading" (这台 PC 的历史还在查) and "not
// connected to any instance" (没连着任何实例) all rendered as the same blank
// gap between the header and the talk button. A user cannot act on a void:
// the first-run case needs to point at the button, and the in-flight case
// must NOT say "no history" (没有历史), which a returning user reads as
// "my records are gone" (我的记录丢了).
//
// Lives in its own file so the distinction has one home. Folded into
// `chat_flow_page`'s builder they were four lines apart and one careless edit
// away from collapsing back into a single 「empty」 branch.

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import 'tokens.dart';

/// Shared look for every 「this list has nothing to show」 line.
Widget _note(String text, {Key? key}) => Center(
  key: key,
  child: Text(
    text,
    textAlign: TextAlign.center,
    style: TextStyle(color: FlowMicColors.t3, fontSize: 12),
  ),
);

/// No connected instance. Requirement ④: a view with no identity shows none of
/// anyone's history — legacy/other-PC rows stay in "all history" (全部历史).
Widget chatNoInstanceFace(AppStrings strings) =>
    _note(strings.chatHistoryNoInstance);

/// The owner-scoped first page is still in flight.
///
/// 🔴 A spinner and NOTHING ELSE is the same void in a nicer costume, so this
/// says what it is doing. It is also reachable only while a query is genuinely
/// outstanding ([OwnerTimelinePager.firstLoadComplete] false), which is what
/// keeps it from becoming a spinner that never resolves.
Widget chatHistoryLoadingFace(AppStrings strings) => Center(
  key: const ValueKey<String>('chat.timeline.loading'),
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: <Widget>[
      const SizedBox(
        width: 18,
        height: 18,
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
      const SizedBox(height: 10),
      Text(
        strings.historyLoadingMore,
        style: TextStyle(color: FlowMicColors.t3, fontSize: 12),
      ),
    ],
  ),
);

/// Storage has ANSWERED and this instance has no rows — the first screen after
/// pairing.
///
/// ⚠️ Open item on this card: the intended copy is "no history yet · press and
/// hold the button below to start speaking" (「还没有历史记录 · 按住下面的
/// 按钮开始说话」), and the second half needs a new four-language key
/// (`chatHistoryEmptyHold`) in the history strings shard, which another card
/// owns this window. Until that key exists this renders the existing, honest
/// [AppStrings.historyEmpty] rather than a hardcoded literal: a Chinese string
/// baked into a widget would ship an untranslatable screen to three locales,
/// which is worse than a first screen that states the truth without the nudge.
Widget chatHistoryEmptyFace(AppStrings strings) => _note(
  strings.historyEmpty,
  key: const ValueKey<String>('chat.timeline.empty'),
);
