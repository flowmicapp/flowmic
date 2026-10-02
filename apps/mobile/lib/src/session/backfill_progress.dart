import 'package:flutter/foundation.dart';

import 'pending_recovery.dart';
import 'recovery_gate.dart';

/// Card RC-G — one piece's share of [BackfillProgress].
@immutable
class ArticleBackfill {
  const ArticleBackfill({
    required this.pendingMs,
    required this.fromOutage,
    this.waitingAuto = false,
    this.recoveryItem,
  });

  final bool waitingAuto;
  final PendingRecoveryItem? recoveryItem;

  static const ArticleBackfill none =
      ArticleBackfill(pendingMs: 0, fromOutage: false);

  /// Milliseconds of THIS piece's audio still waiting to become words.
  final int pendingMs;

  /// Was any of [pendingMs] recorded while the link (or the engine) was down?
  /// Chooses the article page's sentence exactly as
  /// [BackfillProgress.pendingFromOutage] used to, but for this piece only.
  final bool fromOutage;
}

/// How much recovery is still owed, for the face ruling ⑮ requires.
@immutable
class BackfillProgress {
  const BackfillProgress({
    required this.pendingMs,
    required this.running,
    this.serverTier,
    this.recoveringArticleId,
    this.needsManual = 0,
    this.settledUnverified = 0,
    this.pendingFromOutage = false,
    this.byArticle = const <String, ArticleBackfill>{},
  });

  static const BackfillProgress idle =
      BackfillProgress(pendingMs: 0, running: false);

  /// Card RC-1a - which of A7-3's three classes the LAST evaluated server fell
  /// into, or null when no journal pass has run (the legacy segment leg does
  /// not negotiate anything, so it leaves this alone).
  ///
  /// 🔴 THE FACE RC-1b OWES THE USER HANGS OFF THIS. Tier C means the audio is
  /// on the phone and nothing is being attempted; a screen that showed only
  /// [pendingMs] would say 「N minutes owed」 forever with no explanation.
  /// 🔴 IT IS NOT A COPY word: nothing here is a user-visible string, and this
  /// card adds none.
  final RecoveryTier? serverTier;

  /// From the attempt ledger, never inferred from a running queue scan.
  final String? recoveringArticleId;

  BackfillProgress withRecoveringArticle(String? id) => BackfillProgress(
    pendingMs: pendingMs,
    running: running,
    serverTier: serverTier,
    needsManual: needsManual,
    settledUnverified: settledUnverified,
    pendingFromOutage: pendingFromOutage,
    byArticle: byArticle,
    recoveringArticleId: id,
  );

  /// Journal recordings whose automatic budget is spent (owner ruling O-9:
  /// five attempts). Only a user action moves them; that action is RC-1b.
  /// NR-138 — plus legacy sessions whose automatic route stopped (budget
  /// spent, or retry record unreadable).
  final int needsManual;

  /// Journal recordings and legacy sessions kept without a complete proof.
  /// Kept, never auto-retried, never swept.
  final int settledUnverified;

  /// Milliseconds of audio still waiting to become words. Derived from the
  /// BYTES on disk, so it is a measurement of the remaining work rather than an
  /// estimate of how long the work will take — which is the honest thing to put
  /// on screen, and the reason ruling ⑮ could be satisfied without first knowing
  /// whether recovery is faster than real time.
  final int pendingMs;

  /// Card LK-3 — was ANY of [pendingMs] recorded while the link was down?
  ///
  /// 🔴 IT PICKS THE SENTENCE, IT IS NOT ONE. The article banner may only say
  /// 「recorded offline」 when something on disk says the link went; a pause, a
  /// capture fault or a press waiting on a receipt all owe words too, and
  /// telling that user their network dropped is a claim about their network
  /// that nothing measured (observed 2026-09-07: 「断网时录下的 26s 还在转写」
  /// on a recording that was only paused).
  ///
  /// True when a journal recording carries `JournalInterrupt.linkLoss`, or
  /// when the LEGACY face is holding bytes at all — that face writes
  /// `<session>__seg-N.pcm` only while the uplink is gone (see
  /// `audio/audio_capture_journal.dart`'s header on why its tombstone runs
  /// today).
  final bool pendingFromOutage;

  /// Card RC-G — [pendingMs] and [pendingFromOutage] again, per session key
  /// (`RetainedAudioSpill.sessionKeyOf`; a continuous recording's key is its
  /// ARTICLE id). Read through [forArticle].
  final Map<String, ArticleBackfill> byArticle;

  /// Card RC-G — what [articleId] alone still owes.
  ///
  /// 🔴 THE ARTICLE PAGE READS THIS, NEVER [pendingMs]. [pendingMs] is the
  /// whole phone's debt; printed on one piece's page it read 「断网时录下的
  /// 10:51 还在转写」 on a piece that owed 1:35, the other 9:16 being other
  /// recordings — one of which never lost the network at all (CR-12-E re-run,
  /// root-cause §5.5). Pinned by `test/article_backfill_per_article_test.dart`.
  ArticleBackfill forArticle(String articleId) =>
      byArticle[articleId] ?? ArticleBackfill.none;

  /// Whether a stretch is being fed back right now.
  final bool running;

  bool get hasWork => pendingMs > 0 || running;

  /// Card RC-1b — is there audio on this phone the pending-recovery screen
  /// would have something to say about?
  ///
  /// 🔴 IT GATES A TAP TARGET, NOT A SENTENCE. The retained-audio banner grows
  /// a 「show me」 action only when this is true, because a control that opens
  /// an empty page is the affordance R8 forbids.
  ///
  /// ⚠️ IT UNDERCOUNTS ONE CASE, ON PURPOSE RATHER THAN BY OVERSIGHT: audio the
  /// user CANCELLED is kept (owner ruling O-5) and is deliberately absent from
  /// every count here — the leg excludes it from the debt, which is correct,
  /// because nothing is owed for it. A phone whose only kept audio is
  /// cancelled therefore reaches the screen through the list entry rather than
  /// through this banner. Registered here so the gap is a decision on the
  /// record and not a bug somebody re-derives.
  bool get hasKeptAudio =>
      hasWork ||
      needsManual > 0 ||
      settledUnverified > 0 ||
      serverTier == RecoveryTier.awaitingServerCapability;
}
