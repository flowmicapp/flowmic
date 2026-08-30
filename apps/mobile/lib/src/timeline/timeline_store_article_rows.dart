// Part of timeline_store.dart — THE ARTICLE HEAD ROW (card CR-7).
//
// ── WHY THIS SPLIT, AND WHY BESIDE THE CONTROL ROWS ──────────────────────────
// Same cut, same reason, same shape as timeline_store_control_rows.dart, which
// this file is deliberately modelled on: timeline_store.dart sits near the
// 800-line cap, and this is a coherent family that shares the storage without
// sharing the question. That file answers 「what does one key press leave
// behind」; this one answers 「what does one whole recording leave behind」. The
// members are library-private top-level functions taking the store explicitly,
// so `TimelineStore` keeps one-line delegates and no caller was edited.
//
// ── 🔴 A HEAD IS NOT A CONTAINER, AND THE STORAGE MODEL DEPENDS ON THAT ──────
//
// Ruling 4.C option B: the SEGMENTS are the rows. Each is an ordinary
// transcript row that settles, recovers, syncs and exports exactly as it always
// did, and the only new thing on it is `articleId`. The head holds what is true
// of the WHOLE — when it started, how long, how many segments, its title —
// because those are questions no single segment can answer.
//
// ⇒ Everything on the head is DERIVED from the members and recomputed whenever
// they change. It is stored so that a list of articles can draw a card without
// decoding every row, NOT because it is a second source of truth. A head that
// disagreed with its members would be a bug with one obvious repair, which is
// exactly the property option A (the whole recording in one row) would have
// destroyed.

part of 'timeline_store.dart';

/// 🔴 CR-7 — mint (or return) the head row for one continuous recording.
///
/// **NOT [TimelineStore.buildFromUtterance] with a different `entryType`**, and
/// the difference is not cosmetic — the same reasoning `buildControlRowOf`
/// records for a keypress. That builder wants a `mode`, a `delivery` and a
/// `text`, and a head has no words of its own: its text is a TITLE, derived
/// from the first thing said. Passing 「whatever value」 for each is how a filler
/// becomes a judgement downstream (0.2.49 F2b).
///
/// **Idempotent by construction.** [articleId] is minted once per recording and
/// is this row's `clientId`, so a second call during the same recording finds
/// the row rather than forking a second cover for it. That matters more here
/// than for an utterance: a recording's head is created lazily, on the first
/// segment that settles, and 「the first segment」 is a race with the backfill
/// channel on a bad link.
///
/// ⚠️ `origin: 'cloud'` and `EntryStatus.noted`, both structural rather than
/// chosen: continuous recording only exists where the utterance is not
/// delivered (ruling ⑨), so the head belongs to the same light-record world its
/// members do — `isLightRecord` is `origin == 'cloud' && !deleted`, and a head
/// that failed that test would vanish from the very list it exists to appear in.
TimelineEntry buildArticleHeadOf(
  TimelineStore store, {
  required String articleId,
  required DateTime startedAt,
}) {
  final TimelineEntry? existing = store.findByClientId(articleId);
  if (existing != null) return existing;
  final TimelineEntry entry = TimelineEntry(
    id: TimelineEntry.mintLocId(store._deviceId, articleId),
    clientId: articleId,
    // Structural fillers, named here rather than hidden — a recording has no
    // single mode to report and nothing to deliver.
    mode: FlowMode.realtime,
    delivery: Delivery.none,
    sourceText: null,
    // Filled by the first refresh, from the first thing actually said. Empty
    // until then, which is honest: at this instant nobody has said anything.
    outputText: '',
    status: EntryStatus.noted,
    entryType: TimelineEntry.kArticle,
    articleId: articleId,
    // A head has no position inside itself.
    origin: 'cloud',
    spokenToInstanceId: store._owner.instanceId,
    spokenToInstanceName: store._owner.instanceName,
    // 🔴 THE RECORDING'S OWN START, not `now`. The head is minted lazily, on the
    // first segment that settles, which can be a minute after the button was
    // pressed — and `createdAt` is what the list sorts by and what the card
    // shows. Stamping `now` would file a recording under the moment its first
    // sentence finished.
    createdAt: startedAt.toUtc(),
    updatedAt: startedAt.toUtc(),
  );
  store._insertNew(entry);
  return entry;
}

/// Recompute one article's head from its member rows.
///
/// Called after every change to a member (a segment settles, a backfilled
/// segment lands, a row is edited or deleted). Cheap and total: it reads the
/// members and writes the head, so there is no incremental state to get out of
/// step — the failure mode of a `+= 1` counter is a head that is wrong forever
/// and cannot say why.
///
/// Returns the derived summary (also useful to a caller that wants to render it
/// without re-reading), or null when the article has no head row.
///
/// 🔴 THE TITLE IS ONLY EVER DERIVED WHILE IT IS STILL DERIVED. Once the user
/// edits it the row carries `edited`, and this function must not overwrite it —
/// a recomputation that clobbered a typed title would be the store quietly
/// undoing the user's work, and it would do it on the next segment, which is to
/// say immediately.
ArticleSummary? refreshArticleHeadOf(TimelineStore store, String articleId) {
  final TimelineEntry? head = store.findByClientId(articleId);
  if (head == null || !head.isArticle) return null;
  final List<TimelineEntry> members = articleMembersOf(store, articleId);
  int durationMs = 0;
  int words = 0;
  DateTime endedAt = head.createdAt;
  for (final TimelineEntry m in members) {
    durationMs += m.durationMs ?? 0;
    words += textWordCount(m.displayText);
    if (m.createdAt.isAfter(endedAt)) endedAt = m.createdAt;
  }
  final String title = head.edited
      ? head.outputText
      : ArticleSummary.titleFrom(
          members.isEmpty ? '' : members.first.displayText,
        );
  final ArticleSummary summary = ArticleSummary(
    articleId: articleId,
    startedAt: head.createdAt,
    endedAt: endedAt,
    segmentCount: members.length,
    durationMs: durationMs,
    wordCount: words,
    title: title,
  );
  // ⚠️ `updatedAt` carries the article's END, which is the one place this row
  // deviates from every other row's meaning of that field. Stated rather than
  // discovered: the alternative was a new payload key answering a question
  // `updatedAt` already answers on a row that is only ever touched by this
  // function.
  final TimelineEntry next = head.copyWith(
    outputText: title,
    durationMs: durationMs,
    updatedAt: endedAt,
  );
  // `segmentsCount` has no copyWith parameter (it is written once at build time
  // for an utterance), so the head is rebuilt rather than copied when the count
  // moves. Rebuilding preserves the id, which is what every reader keys on.
  final TimelineEntry withCount = next.segmentsCount == members.length
      ? next
      : _rebuildHeadWithCount(next, members.length);
  store._replace(head, withCount);
  return summary;
}

/// Every row that belongs to [articleId], OLDEST FIRST.
///
/// 🔴 THE ORDER IS THE CONTRACT. An article is a transcript, and a transcript
/// read newest-first is not a transcript — which is why this deliberately does
/// not reuse the store's own newest-first ordering, and why the sqlite index
/// added for it is ASC where its two neighbours are DESC.
///
/// Excludes the head (a cover is not one of the things that were said) and
/// soft-deleted rows. The predicate and the sort are [articleMembersIn]'s —
/// this is the in-memory reader over them.
List<TimelineEntry> articleMembersOf(TimelineStore store, String articleId) =>
    articleMembersIn(store._entries, articleId);

/// The same rows, read from STORAGE rather than from the loaded pages.
///
/// For the surface that cannot trust its pages: the full-history page holds a
/// paginated window plus search hits that come straight from storage, so a
/// head the user long-pressed there can be loaded while its members never were
/// (a hit is one row, not its recording). Copying through [articleMembersOf]
/// on that page would render a recording from whatever happened to be paged
/// in, and it would look like a shorter recording rather than a truncated copy.
///
/// The light-record screen keeps [articleMembersOf]: it opens `ArticlePage`
/// from the store already, so its copy reads the same rows its page shows.
Future<List<TimelineEntry>> articleMembersOnDisk(
  TimelineStore store,
  String articleId,
) async => articleMembersIn(await store._persistence.loadAll(), articleId);

/// Every article head on this device, newest first.
List<TimelineEntry> articleHeadsOf(TimelineStore store) => <TimelineEntry>[
  for (final TimelineEntry e in store._entries)
    if (e.isArticle && !e.deleted) e,
];

/// Rebuild a head with a new `segmentsCount`.
///
/// A whole rebuild rather than a `copyWith` parameter, and the asymmetry is on
/// purpose: on an UTTERANCE row `segmentsCount` is written once and must never
/// be revised (it records how many engine spans stood behind that row), so
/// widening `copyWith` for this one caller would open it for that one too.
TimelineEntry _rebuildHeadWithCount(TimelineEntry head, int count) =>
    TimelineEntry(
      id: head.id,
      clientId: head.clientId,
      mode: head.mode,
      delivery: head.delivery,
      sourceText: head.sourceText,
      outputText: head.outputText,
      status: head.status,
      entryType: head.entryType,
      articleId: head.articleId,
      durationMs: head.durationMs,
      segmentsCount: count,
      origin: head.origin,
      edited: head.edited,
      deleted: head.deleted,
      spokenToInstanceId: head.spokenToInstanceId,
      spokenToInstanceName: head.spokenToInstanceName,
      createdAt: head.createdAt,
      updatedAt: head.updatedAt,
    );
