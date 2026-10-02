import 'package:flutter/material.dart';

import '../session/backfill_runner.dart';
import '../session/chat_controller.dart' show ArticleCompletion;
import '../session/pending_recovery.dart';
import '../settings/app_strings.dart';
import 'recovery_status_sentence.dart';
import 'tokens.dart';

/// One display rule for the chat and + panel routes into an article.
({
  int pendingMs,
  ArticleCompletion? completion,
  String? sentence,
  String? detail,
})
articleRecoveryPresentation(
  ArticleBackfill owed,
  AppStrings strings, {
  ArticleCompletion? completion,
  bool recovering = false,
  PendingRecoveryItem? item,
}) {
  item ??= owed.recoveryItem;
  completion ??= recovering
      ? ArticleCompletion.recovering
      : owed.pendingMs <= 0
      ? null
      : owed.waitingAuto
      ? ArticleCompletion.recoveryPending
      : ArticleCompletion.recoveryManual;
  final state = item?.state;
  final String? sentence = switch (completion) {
    ArticleCompletion.finishing ||
    ArticleCompletion.recovering => strings.articleFinishingStatus,
    ArticleCompletion.recoveryPending => strings.articleTailOwedWaiting,
    ArticleCompletion.recoveryManual =>
      state == null
          ? null
          : recoveryStatusSentence(
              state,
              strings,
              otherAccount: item?.otherAccount ?? false,
              retranscribable: item?.retranscribable ?? false,
              asNote: item?.retranscribeAsNote ?? false,
              blockedByServer: item?.retranscribeBlockedByServer ?? false,
            ),
    null => null,
  };
  return (
    pendingMs:
        owed.fromOutage &&
            !owed.waitingAuto &&
            completion != ArticleCompletion.recovering
        ? 0
        : owed.pendingMs,
    completion: completion,
    sentence: sentence,
    detail: item?.partlySaved == true
        ? strings.pendingRecoveryPartlySaved
        : null,
  );
}

/// Shared status slot; absent when there is no supported status fact.
class ArticleRecoveryStatus extends StatelessWidget {
  const ArticleRecoveryStatus({
    super.key,
    required this.completion,
    required this.sentence,
    this.detail,
  });
  final ArticleCompletion completion;
  final String sentence;
  final String? detail;

  @override
  Widget build(BuildContext context) => ColoredBox(
    color: FlowMicColors.canvas,
    child: SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
        child: Semantics(
          liveRegion: true,
          child: Container(
            key: const Key('article.completion'),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: FlowMicColors.surface2,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  sentence,
                  key: Key('article.completion.${completion.name}'),
                  style: TextStyle(
                    color: FlowMicColors.t2,
                    fontSize: 13,
                    height: 1.4,
                  ),
                ),
                if (detail != null)
                  Text(
                    detail!,
                    key: const Key('article.recovery.partlySaved'),
                    style: TextStyle(
                      color: FlowMicColors.t3,
                      fontSize: 12,
                      height: 1.4,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
