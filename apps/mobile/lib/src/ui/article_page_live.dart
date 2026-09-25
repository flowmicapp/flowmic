// Part of article_page.dart — CARD CR-12-C: the page while the recording is
// still running.
//
// SPEC-REF:
//   docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md
//     §4.2 (one page, two forms — and the four differences), §4.3 (entry, exit,
//     stop, ceiling), §4.4 (follow scrolling, the draft), §4.6 (zero new
//     strings), §6 CR-12-C row (acceptance)
//   docs/ui-design/2026-09-22-cr12-live-article-view-demo.html cells F-1 / F-2 / F-3
//
// ── 🔴 NOT A SECOND SCREEN ──────────────────────────────────────────────────
//
// What renders is `ArticlePage` itself, rebuilt from the store on every change.
// The host below owns only what the read-back page has no use for: a
// `Listenable` subscription, a scroll position, and a latch for the stop
// sentence. Paragraph grouping, labels, the title rule and the header are the
// read-back page's own code, so the two forms cannot drift apart — which is
// the reason design §4.2 gives for refusing a separate 「recording」 page.
//
// The page turns into the read-back page IN PLACE when the recording stops:
// the bar builder answers null, the fold switches from `paragraphs` (last one
// open) to `paragraphsOf` (everything closed), and the head row's own title is
// what the app bar was already reading.
//
// A `part` so the live form can reach the page's private constructor: nothing
// outside this library can build an `ArticlePage` with a live face.

part of 'article_page.dart';

/// The four things design §4.2 says the in-progress form adds.
class _ArticleLiveFace {
  const _ArticleLiveFace({
    required this.paragraphs,
    required this.scroll,
    this.draft,
    this.bar,
    this.banner,
  });

  /// Folded with the last paragraph left open while recording.
  final List<ArticleParagraph> paragraphs;
  final ScrollController scroll;

  /// `LiveDraftTile`, under the open paragraph. Not a row, never folded.
  final Widget? draft;

  /// The dock's `ContinuousLiveBar`, or null once the recording is over.
  final Widget? bar;

  /// Status lines pinned above the list (link lost while recording; an
  /// automatic stop).
  final Widget? banner;
}

/// Design §4.4: the reader counts as 「at the bottom」 while less than this
/// fraction of a screen lies below what they can see.
const double kArticleFollowSlack = 0.25;

class _ArticleLiveHost extends StatefulWidget {
  const _ArticleLiveHost({
    super.key,
    required this.controller,
    required this.articleId,
    required this.strings,
    required this.bar,
  });

  final ChatController controller;
  final String articleId;
  final AppStrings strings;
  final Widget? Function() bar;

  @override
  State<_ArticleLiveHost> createState() => _ArticleLiveHostState();
}

class _ArticleLiveHostState extends State<_ArticleLiveHost> {
  final ScrollController _scroll = ScrollController();

  /// Design §4.4 / cell F-2: follow new content only while the reader is at
  /// the bottom. Written by [_onScroll] alone, so it tracks what the reader
  /// did, not what arrived.
  bool _follow = true;

  /// The wire (or local) reason of an automatic stop seen while this page was
  /// open. Latched rather than read off `ChatController.autoStopReason`: that
  /// one belongs to the list's banner queue and auto-hides after a few seconds
  /// (`chat_transient_banner_timers.dart`), and design §4.3 asks for a STATUS
  /// banner here, one that is still on screen when the user looks back.
  String? _stopReason;
  StreamSubscription<String>? _stopSub;

  /// The recording's own start (`ArticleScribe.startedAt`, which is what the
  /// head row will carry). Read once: the page is pushed right after
  /// `beginContinuous`, while the scribe's clock is open.
  late final DateTime _startedAt;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _startedAt =
        widget.controller.session.articles.startedAt ?? DateTime.now().toUtc();
    _stopSub = widget.controller.session.autoStopped.listen((String reason) {
      if (mounted) setState(() => _stopReason = reason);
    });
  }

  @override
  void dispose() {
    _scroll.removeListener(_onScroll);
    unawaited(_stopSub?.cancel());
    _scroll.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_scroll.hasClients) return;
    final ScrollPosition p = _scroll.position;
    _follow =
        p.maxScrollExtent - p.pixels <
        p.viewportDimension * kArticleFollowSlack;
  }

  void _followToEnd() {
    if (!mounted || !_follow || !_scroll.hasClients) return;
    final ScrollPosition p = _scroll.position;
    if (p.pixels < p.maxScrollExtent) _scroll.jumpTo(p.maxScrollExtent);
  }

  /// Before the first segment settles there is no head row yet
  /// (`buildArticleHeadOf` mints it lazily). This stands in for it on screen
  /// only — never stored — and carries exactly what that function will stamp:
  /// the recording's start, no title, nothing counted.
  TimelineEntry _unmintedHead() => TimelineEntry(
    id: '',
    clientId: widget.articleId,
    mode: FlowMode.realtime,
    delivery: Delivery.none,
    sourceText: null,
    outputText: '',
    status: EntryStatus.noted,
    entryType: TimelineEntry.kArticle,
    articleId: widget.articleId,
    origin: 'cloud',
    createdAt: _startedAt,
    updatedAt: _startedAt,
  );

  @override
  Widget build(BuildContext context) {
    final ChatController c = widget.controller;
    return ListenableBuilder(
      listenable: Listenable.merge(<Listenable>[
        c,
        c.store,
        c.backfill.progress,
      ]),
      builder: (BuildContext context, _) {
        final bool recording = c.session.recordingArticleId == widget.articleId;
        final List<TimelineEntry> rows = articleMembersOf(
          c.store,
          widget.articleId,
        );
        final Widget? bar = widget.bar();
        // Card RC-G — this piece's debt, not the phone's.
        final ArticleBackfill owed =
            c.backfill.progress.value.forArticle(widget.articleId);
        WidgetsBinding.instance.addPostFrameCallback((_) => _followToEnd());
        return ArticlePage._live(
          head: c.store.findByClientId(widget.articleId) ?? _unmintedHead(),
          rows: rows,
          strings: widget.strings,
          pendingBackfillMs: owed.pendingMs,
          pendingBackfillFromOutage: owed.fromOutage,
          live: _ArticleLiveFace(
            paragraphs: recording ? _foldOpen(rows) : paragraphsOf(rows),
            scroll: _scroll,
            draft: recording && c.hasLiveDraft ? _draft(c) : null,
            bar: bar == null ? null : _barSlot(bar),
            banner: _statusLines(c),
          ),
        );
      },
    );
  }

  /// The same reducer [paragraphsOf] folds with, read before `onEnd`: the
  /// last paragraph is still being spoken into.
  List<ArticleParagraph> _foldOpen(List<TimelineEntry> rows) {
    final ArticleParagrapher p = ArticleParagrapher();
    for (final TimelineEntry r in rows) {
      p.onRow(r);
    }
    return p.paragraphs;
  }

  /// Wired the way the light-record list wires it (`chat_flow_scroll.dart`),
  /// off the same controller getters.
  Widget _draft(ChatController c) => Padding(
    key: const Key('article.live.draft'),
    padding: const EdgeInsets.only(top: 10),
    child: LiveDraftTile(
      text: c.liveText,
      committedChars: c.liveCommittedChars,
      mode: c.mode,
      strings: widget.strings,
      elapsed: c.recordingElapsed,
      statusLabel: widget.strings.liveTranscribing,
      healthNote: liveHealthNote(c.asrHealth.value, widget.strings),
    ),
  );

  Widget _barSlot(Widget bar) => ColoredBox(
    color: FlowMicColors.canvas,
    child: SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
        child: bar,
      ),
    ),
  );

  /// The status lines pinned above the transcript, or null when there is
  /// nothing to say.
  ///
  /// ① Card CR-3's standing line — the microphone is still open, the link is
  /// not, and the audio is being kept on this phone. The same predicate and
  /// the same sentence as the list's banner slot (`chat_banner_sources.dart`);
  /// without it the screen the user now records on would give no sign that
  /// the transcript has stopped growing, or why.
  ///
  /// ② An automatic stop, in the sentence the list's banner queue picks for
  /// the same reason (`recordingAutoStoppedMessage`), so the two screens
  /// cannot name one stop differently.
  ///
  /// ③ Card NR-96-B — the relay is re-dialling the speech engine. Read off
  /// `PttSession.engineReconnect`, the SAME value the bar at this page's foot
  /// draws its chip from (design §3.4), and cleared by the same edges. Its own
  /// sentence, not ①'s: that one is about the phone's link and promises the
  /// audio is kept, and neither is what this is (§5.1).
  ///
  /// ④ Card RC-3 — ① is the LINK cause only (its sentence says 「link down」),
  /// and ③ takes the kept form when this phone is really keeping the audio
  /// (`ContinuousOffline.engineKept`) — SEG-2's kept/plain pair.
  Widget? _statusLines(ChatController c) {
    final String? stop = _stopReason;
    final ContinuousOffline cause = c.session.continuousOffline;
    final bool offline = cause == ContinuousOffline.linkKept;
    final EngineReconnectFace? engine = c.session.engineReconnect.value;
    if (stop == null && !offline && engine == null) return null;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (offline)
          _line(
            const Key('article.live.offline'),
            widget.strings.bannerContinuousOffline,
          ),
        if (engine != null)
          _line(
            const Key('article.live.engineReconnecting'),
            cause == ContinuousOffline.engineKept
                ? widget.strings.articleLiveEngineReconnectingKept(engine.attempt)
                : widget.strings.articleLiveEngineReconnecting(engine.attempt),
          ),
        if (stop != null)
          _line(
            const Key('article.live.stopped'),
            widget.strings.recordingAutoStoppedMessage(stop),
          ),
      ],
    );
  }

  Widget _line(Key key, String text) => Container(
    key: key,
    margin: const EdgeInsets.fromLTRB(16, 10, 16, 0),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: BoxDecoration(
      color: FlowMicColors.surface2,
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: FlowMicColors.line),
    ),
    child: Text(
      text,
      style: TextStyle(color: FlowMicColors.t2, fontSize: 13, height: 1.4),
    ),
  );
}
