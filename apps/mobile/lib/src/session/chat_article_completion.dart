// NR-115 / NR-105: facts shared by the live article and its reopened page.
part of 'chat_controller.dart';

enum ArticleCompletion {
  finishing,
  recovering,
  recoveryPending,
  recoveryManual,
}

extension ChatArticleCompletion on ChatController {
  ArticleCompletion? articleCompletion(String id) {
    if (session.recordingArticleId == id) return null;
    if (session.articles.attempts.recoveringArticle.value == id) {
      return ArticleCompletion.recovering;
    }
    final bool live =
        session.articles.liveArticleId == id && !session.continuous.isActive;
    if (live &&
        session.articles.attempts.liveHold &&
        !session.recoveryOwnsSession &&
        (session.fsm.session == SessionState.processing ||
            session.fsm.session == SessionState.justDone)) {
      return ArticleCompletion.finishing;
    }
    final debt = backfill.progress.value.forArticle(id);
    if (debt.pendingMs > 0) {
      return debt.waitingAuto
          ? ArticleCompletion.recoveryPending
          : ArticleCompletion.recoveryManual;
    }
    final item = articleRecoveryItem(id);
    if (item != null) {
      return item.state == PendingRecoveryState.waitingAuto &&
              !item.otherAccount
          ? ArticleCompletion.recoveryPending
          : ArticleCompletion.recoveryManual;
    }
    // F5: silence/terminal recovery cannot revive the display snapshot.
    _articleDrafts.remove(id);
    return null;
  }

  PendingRecoveryItem? articleRecoveryItem(String id) {
    final debt = backfill.progress.value.forArticle(id);
    if (debt.pendingMs > 0) return debt.recoveryItem;
    // Before the first scan, use the same pending-screen derivation on the
    // stopped recording's actual manifest, bounded by its hold/owed ticket.
    final attempts = session.articles.attempts;
    final manifest = session.audio.retainedAudio?.liveManifest;
    if (session.articles.liveArticleId == id &&
        !session.continuous.isActive &&
        (attempts.liveHold || session.articles.owedTailPendingFor(id)) &&
        manifest != null &&
        RetainedAudioSpill.sessionKeyOf(manifest.recordingId) == id &&
        !manifest.settled) {
      return PendingRecoveryStore.itemOf(
        cancelled: manifest.cancelled,
        manifest: manifest,
        tier: backfill.journalLeg?.currentTier,
        durationMs: debt.pendingMs,
        currentAccount: session.audio.retainedAudio?.recordingAccount
            .currentDigest(),
      );
    }
    return null;
  }

  bool get articleFinishing {
    final String? id = session.articles.liveArticleId;
    return id != null && articleCompletion(id) == ArticleCompletion.finishing;
  }

  bool articleActionHeld(TimelineEntry row) =>
      row.articleId != null &&
      articleCompletion(row.articleId!) == ArticleCompletion.finishing;

  // This is a display snapshot, never a timeline row or a final transcript.
  // It survives a stall clearing the ordinary PTT draft, and route disposal.
  void _rememberArticleDraft() {
    final String? id = session.articles.liveArticleId;
    if (id == null || session.recoveryOwnsSession || liveText.isEmpty) return;
    _articleDrafts[id] = (
      text: liveText,
      committed: liveCommittedChars,
      offsetMs: session.articles.accountedMs ?? 0,
    );
  }

  ({String text, int committed, int offsetMs})? articleDraft(String id) =>
      _articleDrafts[id];

  void _articleSpanLanded(TimelineEntry entry) {
    final String? id = entry.articleId;
    final draft = _articleDrafts[id];
    if (id == null || draft == null) return;
    final int start = entry.articleOffsetMs ?? 0;
    final int end = start + (entry.durationMs ?? 0);
    if (start <= draft.offsetMs && end > draft.offsetMs) {
      _articleDrafts.remove(id);
    }
  }
}
