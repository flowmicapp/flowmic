// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 A (utterance = entry;
//     source_text immutable; cancel = no entry), §4.0 D (five-state status +
//     edited bit)
//   docs/rebuild/08-MOBILE-SPEC.md §5 (target-aware inject:result write-back),
//     §7 (local timeline)
//
// TimelineStore owns the COMMITTED chat-flow entries (the live in-flight draft
// lives on ChatController). It is the single writer of the local table: build
// on utterance-final, write-back on inject:result, set the edited overlay on an
// edit, soft-remove on delete. Every mutation persists then notifies. It never
// touches the wire.
//
// 0.2.27 (owner's architecture ruling, docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md):
// it is no longer a copy of anything. There is no server table behind these rows
// to reconcile with, so the members that existed to reconcile are gone — see the
// retirement block below [applyProcessed].

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../diag/diag_log.dart';

// Card F2 addition — 「这份裁决是谁、在哪一层作出的」("who made this verdict, and
// at which layer"), used to replace an `inject:result.mode` the desktop had
// fabricated (the reasoning is in the applyInjectResult section and this
// file's header).
// Card IT-05 addition `isPcInjectionVerdictCode` — the late-receipt latch needs the
// same predicate to recognize a settled 「已投递 · 未注入」("delivered · not
// injected") row (Book 15 §2.0.1-d).
import '../session/outbox_inject_authorship.dart'
    show isPcAdmissionRefusalCode, isPcInjectionVerdictCode;
import '../signaling/wire_payloads.dart' show FlowMode, Delivery;
import 'timeline_entry.dart';
import 'timeline_persistence.dart';
import 'timeline_purge.dart';
import 'timeline_reaper.dart';

// Card F11 — the inject:result write-back (the ONE family whose question is
// 「凭什么给这一行安这个词」("what grounds do we have to put this word on this
// row")). Same library, same rule as every other split in
// this repo: nothing moved changed behaviour and no caller had to be edited.
part 'timeline_store_inject_writeback.dart';
// REQ-12-13 — minting the row for a remote key press. Split for the same 800-line cap and by the same
// rule as the write-back above: same library, delegate left on the class, no
// caller edited.
part 'timeline_store_control_rows.dart';

/// V2-06a-1 — the seam that answers「这条是对谁说的」("who this entry was
/// spoken to") at the moment a row is born.
///
/// A tiny interface rather than a `String? Function()` so the null case has a
/// name: there IS a legitimate 「no instance」 (an unpaired/local session), and
/// the design must be able to say that out loud instead of leaving the caller
/// to guess whether null means「不知道」("don't know") or「还没接线」("not wired
/// up yet").
abstract interface class InstanceOwnerProbe {
  /// Stable identity of the connected instance, or null when there is none.
  /// Must be [MobileSession.connectionIdentity] so it survives renames.
  String? get instanceId;

  /// Its display name AS IT READS NOW, snapshotted onto the row.
  String? get instanceName;
}

/// The only acceptable default: it reports「没有实例」("no instance") and is
/// structurally
/// incapable of inventing one. Distinct from the friendly-empty-implementation
/// Book 13 §7 F1 bans —
/// that kind fakes success; this one states a fact that is sometimes true.
class _NoOwner implements InstanceOwnerProbe {
  const _NoOwner();
  @override
  String? get instanceId => null;
  @override
  String? get instanceName => null;
}

class TimelineStore extends ChangeNotifier {
  TimelineStore({
    // RV-20 / Book 13 §7 F1 ②: required — no InMemoryTimelinePersistence default.
    // A friendly empty impl lets a composition root omit the real SQLite (or
    // SharedPrefs fallback) and still look healthy — rows live only in RAM and
    // vanish on relaunch. Compile-time required bites a forgotten arg earlier
    // than a runtime throw (the whole point of RV-20: lost ctor params leave
    // no new symbol to grep). Production: openTimelinePersistence(...).persistence;
    // tests: newTestStore() / InMemoryTimelinePersistence() explicitly.
    // `_NoOwner` below is the documented compliant exception (honest 「不知道」
    // ("don't know"),
    // not a fake success) — do not "fix" it.
    required TimelinePersistence persistence,
    // 🔴 window C2 —— THE ONE DELETER (lib/src/timeline/timeline_reaper.dart).
    //
    // `required` and NOT nullable-with-a-default, and the reason is Book 15 G-21
    // itself: before C2 this store deleted a row and left the row's picture file
    // on disk forever, because nothing here knew about the bytes. A friendly
    // default here would let a composition root forget the reaper and get that
    // defect back with **no new symbol to grep** — the exact shape Book 13 §7 F1 ①
    // is about. Production: main.dart builds it from the same blob store /
    // vault the exporter uses; tests: `TimelineReaper(...)` over in-memory
    // doubles (test/support/di.dart's newTestReaper()).
    required TimelineReaper reaper,
    String deviceId = 'mobile',
    InstanceOwnerProbe? owner,
  }) : _persistence = persistence,
       _reaper = reaper,
       _deviceId = deviceId,
       _owner = owner ?? const _NoOwner();

  final TimelinePersistence _persistence;
  final TimelineReaper _reaper;
  final String _deviceId;

  /// V2-06a-1: who the phone is talking to RIGHT NOW, asked at row-creation
  /// time and snapshotted onto the row.
  ///
  /// The default is `_NoOwner`, which reports 「不知道」("don't know") rather
  /// than a plausible
  /// value — and that is the whole design. Book 13 §7 F1 bans the friendly empty
  /// default, but the honest reading here is that an unowned row is a REAL
  /// state (an unpaired/local session genuinely has no instance), so a `throw`
  /// would be wrong too. What must never happen is a default that INVENTS an
  /// owner; `_NoOwner` cannot, and rows it produces render as unknown instance.
  final InstanceOwnerProbe _owner;

  final List<TimelineEntry> _entries = <TimelineEntry>[];

  /// Committed entries, newest-first (the chat flow renders the active draft
  /// above these; demo frames 2/3 show descending createdAt from the top).
  List<TimelineEntry> get entries => List<TimelineEntry>.unmodifiable(_entries);

  /// V2-06a-1 — the rows said TO [instanceId], newest-first.
  ///
  /// Requirement ④:「进到某个 PC 实例里，只显示与该实例相关的历史」("once inside a
  /// given PC instance, only show history related to that instance"). Filters on the
  /// birth-time owner, NOT on [TimelineEntry.pcName]: pcName exists only where a
  /// row actually landed, so filtering by it would drop every noted row —
  /// precisely the ones the user chose to keep on the phone.
  ///
  /// Legacy rows (owner null) belong to NO instance and are excluded here on
  /// purpose. They remain visible in the full-history view labelled unknown
  /// instance; letting
  /// them fall into whichever instance is open would be a silent claim about
  /// where they were spoken, which nobody knows.
  ///
  /// Card F2 (2026-08-05): now the single-owner case of [entriesForOwners], so the
  /// two views cannot drift apart on what 「这一行属于这一屏」("this row belongs
  /// to this screen") means. The chat
  /// screen no longer calls this one — see [entriesForOwners].
  List<TimelineEntry> entriesForInstance(String instanceId) =>
      entriesForOwners(<String>{instanceId});

  /// Card F2 / ruling ④ — the rows said to ANY of [ownerIds], newest-first.
  ///
  /// The whole of the machine merge on the store side: two pairings to one
  /// computer are one session surface, so the screen reads the SET of birth-time
  /// owners that belong to that machine (built by `session/machine_key.dart`)
  /// instead of one. The rows are untouched — a row keeps the
  /// `spoken_to_instance_id` it was born with forever, and merging is a mapping
  /// applied at READ time.
  ///
  /// An EMPTY set is EMPTY rows, never 「everyone」: 「不知道这一屏是谁」("we don't
  /// know whose screen this is") must not
  /// render as 「全都是你的」("it's all yours"). Rows with a null owner are
  /// excluded for the same
  /// reason [entriesForInstance] excluded them — they belong to no screen and
  /// stay in the full-history page as unknown instance.
  List<TimelineEntry> entriesForOwners(Set<String> ownerIds) {
    if (ownerIds.isEmpty) return const <TimelineEntry>[];
    return List<TimelineEntry>.unmodifiable(
      _entries.where((TimelineEntry e) {
        final String? owner = e.spokenToInstanceId;
        return owner != null && ownerIds.contains(owner);
      }),
    );
  }

  /// Rows with no recorded owner — everything written before V2-06a-1.
  /// Surfaced so the full-history page can label them honestly rather than hide them.
  List<TimelineEntry> get entriesWithUnknownInstance =>
      List<TimelineEntry>.unmodifiable(
        _entries.where((TimelineEntry e) => e.spokenToInstanceId == null),
      );

  bool get isEmpty => _entries.isEmpty;

  /// V2-06b upward-scroll pagination — how many rows a page holds.
  ///
  /// Sized so the first screen is full without loading the table: with the cap
  /// gone (V2-06a-2) `loadAll()` on a year-old history would block the first
  /// frame on thousands of rows nobody has scrolled to yet.
  static const int pageSize = 60;

  /// False once a page comes back short — the oldest row is on screen and there
  /// is nothing further up. Distinct from「还没试过」("haven't tried yet"): the
  /// UI must be able to tell
  /// 「到头了」("reached the end") from「还没加载」("hasn't loaded yet"), or it
  /// renders a spinner that never resolves.
  bool _hasMore = true;
  bool get hasMore => _hasMore;

  bool _loadingMore = false;
  bool get loadingMore => _loadingMore;

  /// The first page. Replaces the previous `loadAll()`.
  Future<void> load() async {
    final List<TimelineEntry> loaded = await _persistence.loadPage(
      limit: pageSize,
    );
    _entries
      ..clear()
      ..addAll(loaded.where((TimelineEntry e) => !e.deleted));
    // Short page ⇒ that was everything. Judged on the RAW page length, not on
    // the filtered result: a page made entirely of soft-deleted rows still means
    // there is more above it.
    _hasMore = loaded.length >= pageSize;
    _sort();
    notifyListeners();
  }

  /// One page older than the oldest row held. Idempotent while in flight — the
  /// scroll listener fires repeatedly near the top and must not stack requests.
  Future<void> loadMore() async {
    if (_loadingMore || !_hasMore || _entries.isEmpty) return;
    _loadingMore = true;
    notifyListeners();
    try {
      final List<TimelineEntry> older = await _persistence.loadPage(
        before: _entries.last.createdAt,
        limit: pageSize,
      );
      _hasMore = older.length >= pageSize;
      // Dedupe on id: a row can be written while the page is in flight, and a
      // duplicated row in the list is a Flutter key collision, not a cosmetic
      // problem.
      final Set<String> known = _entries.map((TimelineEntry e) => e.id).toSet();
      _entries.addAll(
        older.where((TimelineEntry e) => !e.deleted && !known.contains(e.id)),
      );
      _sort();
    } finally {
      _loadingMore = false;
      notifyListeners();
    }
  }

  /// V2-06b search — rows containing [query], straight from storage rather than
  /// from [entries].
  ///
  /// Deliberately NOT a filter over the loaded list. With pagination the loaded
  /// list is「用户滚到过的那些」("the ones the user has scrolled past"), so
  /// filtering it would search the part of the
  /// history the user already walked past and silently miss everything above —
  /// a search box that finds less the less you have scrolled.
  Future<List<TimelineEntry>> search(String query) async {
    final List<TimelineEntry> hits = await _persistence.search(query);
    return hits.where((TimelineEntry e) => !e.deleted).toList(growable: false);
  }

  /// window C inventory layer (Book 16 §6) — the READ-ONLY walk entry.
  ///
  /// EVERY live row on this phone, newest-first, straight from storage.
  /// Deliberately NOT a getter over [entries]: that list is 「用户滚到过的那些」
  /// ("the ones the user has scrolled past")
  /// (pagination, [pageSize]), so exporting from it would silently produce a
  /// file containing however far the user happened to scroll — the same defect
  /// [search] was written to avoid, but with data loss instead of a bad search.
  ///
  /// Soft-deleted rows are dropped here rather than by the caller: `delete()`
  /// is a soft remove, and a row the user deleted must not come back through an
  /// export → import round trip.
  ///
  /// ⚠️ **Whole-table read, on purpose.** [TimelinePersistence.loadPage] is
  /// keyset paging with a STRICT `created_at <` boundary, so two rows sharing a
  /// millisecond that straddle a page edge would drop one — invisible, and in an
  /// export that is silent data loss (a red line). `loadAll` has no boundary to get
  /// wrong. The cost is the row objects in memory (they are the app's own
  /// model objects, a few MB at the scale this product runs at); what Book 16 §8-1
  /// forbids is holding the SERIALIZED form of the whole table, and the exporter
  /// streams that one row at a time.
  ///
  /// Adds NO behaviour: it does not mutate, does not notify, does not touch
  /// [_entries], and nothing else in this class calls it.
  Future<List<TimelineEntry>> readAllRowsForInventory() async {
    final List<TimelineEntry> all = await _persistence.loadAll();
    return all
        .where((TimelineEntry e) => !e.deleted)
        .toList(growable: false)
      ..sort((TimelineEntry a, TimelineEntry b) => b.createdAt.compareTo(a.createdAt));
  }

  TimelineEntry? findById(String id) {
    for (final TimelineEntry e in _entries) {
      if (e.id == id) return e;
    }
    return null;
  }

  TimelineEntry? findByClientId(String clientId) {
    for (final TimelineEntry e in _entries) {
      if (e.clientId == clientId) return e;
    }
    return null;
  }

  /// The most-recent entry still awaiting a delivery truth (⏳ delivering, inject
  /// delivery). The FSM forbids RECORDING+PROCESSING coexistence, so there is
  /// at most one live STT utterance in flight — an inject:result with no
  /// explicit correlation id applies to THIS entry (temporal correlation).
  ///
  /// N2: the test is [TimelineEntry.awaitingDelivery], NOT `status == cached`.
  /// A row a verdict already settled as undelivered is at `cached` too, and it is NOT
  /// awaiting anything — letting it answer this question would hand the next
  /// uncorrelated verdict to a row whose truth is already in.
  TimelineEntry? get lastAwaitingInject {
    for (final TimelineEntry e in _entries) {
      if (e.delivery == Delivery.inject && e.awaitingDelivery) {
        return e;
      }
    }
    return null;
  }

  /// master-plan §4.0 A: an utterance's terminal final builds a row = the
  /// record of truth. `delivery:'none'` → 📥 noted; an inject delivery starts
  /// ⏳ delivering (cached, `cachedByVerdict` false — nothing has answered yet),
  /// flipping to injected / undelivered / failed when the verdict lands.
  /// Idempotent on [clientId]: a replayed final updates the existing row.
  TimelineEntry buildFromUtterance({
    required String clientId,
    required FlowMode mode,
    required Delivery delivery,
    required String text,
    String? sourceLang,
    int? durationMs,
    int segmentsCount = 0,
    String origin = 'paired',
    String entryType = TimelineEntry.kTranscript,
    String? thumbB64,
  }) {
    final TimelineEntry? existing = findByClientId(clientId);
    if (existing != null) return existing;
    final DateTime now = DateTime.now().toUtc();
    final EntryStatus status = delivery == Delivery.none
        ? EntryStatus.noted
        : EntryStatus.cached;
    final TimelineEntry entry = TimelineEntry(
      id: TimelineEntry.mintLocId(_deviceId, clientId),
      clientId: clientId,
      mode: mode,
      delivery: delivery,
      sourceText: text,
      outputText: text,
      sourceLang: sourceLang,
      status: status,
      durationMs: durationMs,
      segmentsCount: segmentsCount,
      origin: origin,
      entryType: entryType,
      thumbB64: thumbB64,
      // V2-06a-1: snapshot 「这条是对谁说的」("who this entry was spoken to") at
      // BIRTH, not at delivery. Doing it
      // here is what makes noted rows (「留在手机」("kept on the phone"), which
      // never get delivered
      // and so never get a pcName) belong to an instance at all.
      spokenToInstanceId: _owner.instanceId,
      spokenToInstanceName: _owner.instanceName,
      createdAt: now,
      updatedAt: now,
    );
    _insertNew(entry);
    return entry;
  }

  /// Put a NEWLY BUILT row at the head and make it durable + visible, in the one
  /// order every builder here uses: insert → sort → persist → notify.
  ///
  /// 🔴 EXTRACTED VERBATIM from [buildFromUtterance]'s tail — the four lines were
  /// already exactly this, in exactly this order, and that ordering is load-bearing
  /// (a notify before the persist would publish a row the disk has not accepted).
  /// Nothing about it changed in the move.
  ///
  /// It is a method rather than four inline lines because `notifyListeners` is
  /// `@protected`: a `part` file shares the library but not the class, so any
  /// builder that lives outside this class has to reach the notify through an
  /// instance member. Same constraint, same resolution, as `notifyUi` in
  /// chat_explicit_delivery.dart.
  void _insertNew(TimelineEntry entry) {
    _entries.insert(0, entry);
    _sort();
    _persistOne(entry);
    notifyListeners();
  }

  /// 🔴 REQ-12-13 — the row for ONE remote key press. Body in
  /// timeline_store_control_rows.dart (this file is at the 800-line cap); the
  /// delegate stays here so the store's public surface still says out loud that it
  /// can mint one, and so no caller or test double had to be edited.
  TimelineEntry buildControlRow({required String clientId, required String kind}) =>
      buildControlRowOf(this, clientId: clientId, kind: kind);

  /// The `mode` an inject:result carries when the verdict is 「没有投递，留着可以
  /// 补投」("not delivered, kept so it can be backfilled")
  /// (InjectResultSchema: 'sendinput' | 'clipboard' | 'cached').
  ///
  /// A literal, not an enum: this is the wire's own word, matched here and
  /// nowhere else, and the protocol package owns its definition (RV-43: this
  /// card makes zero protocol changes).
  static const String kWireModeCached = 'cached';

  // ── inject:result write-back ───────────────────────────────────────────────
  //
  // Card F11 800-line cap: the BODY moved VERBATIM to
  // timeline_store_inject_writeback.dart (a `part` of this library — see that
  // file's header for the cut and why the receiver became explicit). The METHOD
  // stays here, so every caller and every test double is byte-for-byte
  // unchanged: a structural split that forces its callers to be edited is not
  // 「只挪不改」("moved only, not changed").

  /// inject:result write-back. See [timelineApplyInjectResult] for the whole
  /// rule, including what each named argument is allowed to decide.
  bool applyInjectResult({
    String? correlationId,
    required bool ok,
    InjectTarget? target,
    String? pcName,
    String? failureReason,
    String? wireMode,
  }) => timelineApplyInjectResult(
    this,
    correlationId: correlationId,
    ok: ok,
    target: target,
    pcName: pcName,
    failureReason: failureReason,
    wireMode: wireMode,
  );

  /// Edit (§4.0 A + card item 3): move the DISPLAY face and set the `edited`
  /// overlay bit. `source_text` is immutable — copyWith has no sourceText param,
  /// so the original is structurally untouchable here.
  TimelineEntry? applyEdit(String id, String newText) {
    final TimelineEntry? entry = findById(id);
    if (entry == null) return null;
    final TimelineEntry updated = entry.copyWith(
      outputText: newText,
      edited: true,
      updatedAt: DateTime.now().toUtc(),
    );
    _replace(entry, updated);
    return updated;
  }

  /// GA-01: write the compose product onto a translate/organize row. The STT
  /// text stays in `source_text` (immutable, §4.0 A) and the LLM output becomes
  /// the DISPLAY/delivered face — which is exactly what `processed_text ?? …`
  /// means, and what makes `showsSourceLine` light up the 「原文」("original
  /// text") line.
  ///
  /// `edited` is deliberately NOT set: the machine produced this, the user did
  /// not. Folding a compose product into the edited bit would make the row claim
  /// the human rewrote it.
  /// GA-14 — adopt a second-pass transcript.
  ///
  /// Moves the display face and stamps [TimelineEntry.refinedAt]. Deliberately
  /// does NOT set `edited` (that bit means 「人改过」("a human edited it")) and does NOT touch
  /// `sourceText` (write-once immutable).
  TimelineEntry? applyRefined(String id, String refinedText) {
    final TimelineEntry? entry = findById(id);
    if (entry == null) return null;
    final TimelineEntry updated = entry.copyWith(
      outputText: refinedText,
      refinedAt: DateTime.now().toUtc(),
      updatedAt: DateTime.now().toUtc(),
    );
    _replace(entry, updated);
    return updated;
  }

  TimelineEntry? applyProcessed(
    String id,
    String processedText,
    FlowMode mode,
  ) {
    final TimelineEntry? entry = findById(id);
    if (entry == null) return null;
    final TimelineEntry updated = entry.copyWith(
      outputText: processedText,
      processedText: processedText,
      processMode: mode.name,
      updatedAt: DateTime.now().toUtc(),
    );
    _replace(entry, updated);
    return updated;
  }

  /// Long-press backfill delivery: mark the entry as awaiting delivery again
  /// so its badge
  /// returns to ⏳ delivering while the re-inject is in flight. delivery stays
  /// immutable.
  ///
  /// ── owner 2026-07-31 resend timestamp: THE ONE stamping point ─────────────
  ///
  /// 「在原消息上显示一个最后的重发时间」("show a last-resend timestamp on the
  /// original message"). Every text resend entry point (inline resend /
  /// long-press backfill / resend-after-edit / resend from the failure banner) funnels through
  /// `ChatController.reInject` → `ManualDelivery.reInject`, which calls THIS
  /// method exactly once. So the stamp lives here rather than at the call sites —
  /// a timestamp written at four call sites is four implementations of one
  /// question waiting to drift.
  ///
  /// ⚠️ Correction (window B3-2b): this doc used to assert 「`grep
  /// markReinjecting lib/` =
  /// one production call site」. **It is TWO now** — `outboxResendImage`
  /// (chat_outbox_host.dart) stamps here too, because a picture resend is also
  /// a
  /// re-delivery the user asked for and the row must stop saying undelivered the
  /// instant they ask. Corrected rather than quietly left: a comment that hands
  /// the reader a grep result is only worth anything if the result is current.
  /// The 「one implementation」 property is unchanged — that is what matters —
  /// but the count was a checkable claim and it had gone stale.
  ///
  /// **WHERE THE LINE IS: 「这一行被重新投出去了吗」("was this row re-delivered"),
  /// not 「用户按了几次按钮」("how many times the user pressed the button").**
  /// `reInject`'s guards run BEFORE this call and each returns without touching
  /// the row: a cloud row, an image row, a row deleted underfoot, an empty row —
  /// and a KNOWN-DOWN link, which settles the row ✗ `LINK_DOWN` without ever
  /// attempting a send. None of those stamp, because showing 「上次重发 15:20」
  /// ("last resent 15:20") for
  /// something that provably never left is the 把没做成的事说成做成了 ("saying a
  /// thing that wasn't done was done") half of
  /// red line F2. Everything that reaches here IS a re-delivery going into flight.
  ///
  /// **AND A FAILED RE-DELIVERY STILL COUNTS.** [TimelineEntry.lastResentAt]
  /// records the ACT; [TimelineEntry.status] records the delivery truth. Making
  /// the timestamp conditional on `ok` would fold both into one value (headline
  /// bug shape) AND erase the case owner most needs to read: a row showing ✗
  /// where the only open question is 「这个 ✗ 是原来那次的，还是我刚才重发的？」
  /// ("is this ✗ from the original attempt, or from the resend I just did?").
  ///
  /// ⚠️ **The phone and the PC are deliberately different on this point, do
  /// not casually unify them.** The PC grows a NEW row per
  /// re-delivery, stamped with the re-delivery instant and sorted to the top
  /// (RV-72 — the PC timeline = a delivery log). Here the row keeps its
  /// `createdAt`, keeps its place in
  /// [_sort] (which reads `createdAt` and nothing else), and only gains this
  /// extra instant — the phone timeline = the owner of this utterance. Both
  /// answers are correct for
  /// their own end.
  TimelineEntry? markReinjecting(String id) {
    final TimelineEntry? entry = findById(id);
    if (entry == null) return null;
    final DateTime now = DateTime.now().toUtc();
    final TimelineEntry updated = entry.copyWith(
      status: EntryStatus.cached,
      // N2: back to delivering, so the previous verdict's 「未投递」("undelivered") bit must go — a row
      // whose re-delivery is in flight is waiting, not settled. This is the one
      // call that depends on copyWith letting `false` clear the bit.
      cachedByVerdict: false,
      // The stamp. `now`, not `entry.createdAt` — and NOT the same value as
      // `updatedAt` by coincidence: `updatedAt` moves on an edit, a refine, a
      // compose product and every inject verdict, so it can never answer
      // 「最后一次重发是什么时候」("when was the last resend"). Sharing the instant
      // here is arithmetic, not a
      // shared meaning; the two fields are still two questions.
      lastResentAt: now,
      updatedAt: now,
    );
    _replace(entry, updated);
    return updated;
  }

  /// master-plan §4.0 A ✕ clear-buffer: 「已 final 的条目保留为 noted」("an entry
  /// that already went final is kept as noted"). Under manual-send
  /// an utterance builds its row immediately (record of truth) but stays ⏳ until
  /// the user presses ➤; discarding the buffer (✕ / mode switch) means that text
  /// was captured and never delivered, which is exactly 📥 noted.
  ///
  /// Only a still-awaiting (⏳ delivering) row moves. An already
  /// injected/failed/noted row carries a settled delivery truth and is never
  /// rewritten — status stays delivery-truth-only (§4.0 D), no new state is
  /// invented.
  ///
  /// N2: undelivered is settled too (a verdict said so), so the guard asks
  /// [TimelineEntry.awaitingDelivery] rather than `status == cached`. Rewriting
  /// it to noted would erase a real verdict and, worse, take the resend
  /// affordance
  /// away from the one state that exists to offer it.
  TimelineEntry? markNoted(String id) {
    final TimelineEntry? entry = findById(id);
    if (entry == null || !entry.awaitingDelivery) return null;
    final TimelineEntry updated = entry.copyWith(
      status: EntryStatus.noted,
      updatedAt: DateTime.now().toUtc(),
    );
    _replace(entry, updated);
    return updated;
  }

  // ── RETIRED 0.2.27: the server-mirror bookkeeping that used to live here ────
  //
  // owner's architecture ruling (docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md):
  // 手机↔PC 不做云端存储同步、云端不存转录 ("phone↔PC does not do cloud storage
  // sync, the cloud does not store transcripts"). This store is now the OWNER of the
  // phone's timeline, not one of two copies, so five members lost their subject:
  //
  //   · `pendingSync` + `markSynced` — the 「服务器上有没有这一行」("whether this
  //     row exists on the server") ledger, read by
  //     TimelineSyncGate.reflushPending on every connection edge. Both are gone,
  //     and so is [TimelineEntry.syncState], which is what they were made of:
  //     leaving the flag behind would have left a value on every row claiming an
  //     answer to a question nobody can ask any more. THAT is how the queue was
  //     wound up — not drained, ABOLISHED. Nothing was replayed on the way out,
  //     because replaying into a table that no longer exists is not a farewell.
  //     ⚠️ No user-visible state moved: `syncState` was never rendered anywhere
  //     (grep: zero UI readers), and the row's own five-state `status` — the
  //     delivery truth — is untouched. A row built offline still reads
  //     undelivered
  //     exactly as before, and backfill delivery is still how it gets delivered.
  //   · `adoptServerText` / `removeDeletedByPeer` / the `_conflicts` FIFO
  //     (`lastConflict` / `dismissConflict` / RV-52's bound) — the C5 「以服务器
  //     为准, and the loser MUST be told」("the server takes priority, and the
  //     loser MUST be told") machinery. It arbitrated two writers of
  //     one server row; there is one writer now. `removeDeletedByPeer` in
  //     particular DELETED a real local row whenever the server answered
  //     「no such entry」 — a code that only ever meant 「id 不在表里」("the id is
  //     not in the table") — so it was
  //     also the sharpest edge on the stop-write path.
  //
  // The C5 design (LWW + 「输家必须被告知」("the loser must be told")) is
  // preserved as design, not as
  // unreachable code: docs/strategy/2026-07-30-c5-conflict-criteria-design.md,
  // which names the light-note-multi-device case that will reuse it.

  /// Trigger ① —— the user deletes a row on the timeline.
  ///
  /// 🔴 G-21: this used to be `_entries.removeAt` + `_persistence.delete`, i.e.
  /// it dropped the ROW and left the row's picture file (and its carried fields)
  /// behind forever. It goes through the one deleter now, so 「这一行的字节没了吗」
  /// ("are this row's bytes gone")
  /// has one answer whichever way the row leaves.
  ///
  /// `advance` is null on purpose: 「我删了这一条」("I deleted this one") says
  /// nothing about everything
  /// older than it, and moving the cutoff here would claim it did.
  void delete(String id) {
    final int i = _entries.indexWhere((TimelineEntry e) => e.id == id);
    if (i < 0) return;
    final TimelineEntry gone = _entries.removeAt(i);
    // Fire-and-forget like every other persist on this class — order is held by
    // the single-writer invariant (every mutation goes through this class, on
    // one isolate) plus sqflite's own serialised write chain.
    //
    // D9: fire-and-forget, NOT fail-silent. A reap that throws means the row
    // (or its bytes) is still on disk while the screen shows it gone — the
    // mirror image of the persist_failed case below, and it gets the same loud
    // trail instead of vanishing into an unawaited future.
    unawaited(
      _reaper.reap(<TimelineEntry>[gone]).then<void>(
        (_) {},
        onError: (Object e) => diag('timeline.reap_failed', <String, Object?>{
          'entry_id': gone.id,
          'is_image': gone.isImage,
          'error': e,
        }),
      ),
    );
    notifyListeners();
  }

  /// Trigger ② —— owner's RV-96 clear (pick one of two types + a time bracket).
  ///
  /// Returns what it ACTUALLY did.
  ///
  /// 🔴 D7 — THE DOOMED SET COMES FROM STORAGE, NOT FROM [_entries]. The
  /// confirmation dialog's 「将删除 N 条」("N entries will be deleted") is
  /// counted by the inventory layer over
  /// the WHOLE table (`AssetInventory.walk` → [readAllRowsForInventory] →
  /// `TimelinePersistence.loadAll`), while [_entries] holds only the pages the
  /// user has scrolled to ([pageSize] = 60). Selecting the doomed rows from
  /// [_entries] deleted at most one page's worth, then advanced the cutoff over
  /// the whole promised range — an irreversible delete that reported more than
  /// it did, with the survivors' image files still on disk. Selecting from the
  /// same full-table source with the same [planClear] predicate is what makes
  /// 「将删除 N 条」("N entries will be deleted") and 「已删除 N 条」("N entries
  /// have been deleted") agree for real (Book 16 §6.2-5).
  ///
  /// The cutoff advance stays inside [TimelineReaper.reap], AFTER every row (and
  /// its bytes) in the batch is gone — a throw mid-batch aborts before the
  /// cutoff is written, so the marks never claim a range the delete did not
  /// finish covering.
  ///
  /// Pinned by timeline_clear_boundary_test.dart (>60 rows across the pagination
  /// boundary; the old in-memory selection goes red there).
  Future<ReapResult> clear(
    ClearKind kind,
    ClearWindow window, {
    DateTime? now,
  }) async {
    final DateTime? horizon = horizonOf(window, now ?? DateTime.now().toUtc());
    final List<TimelineEntry> doomed = planClear(
      await _persistence.loadAll(),
      kind,
      horizon,
    );
    if (doomed.isEmpty) {
      return ReapResult(rows: 0, pictures: 0, bytesFreed: 0, cutoffs: _reaper.cutoffs);
    }
    final Set<String> ids = doomed.map((TimelineEntry e) => e.id).toSet();
    final ReapResult out;
    try {
      out = await _reaper.reap(doomed, advance: kind);
    } catch (e) {
      // 🔴 D7, partial-failure form — a delete that did not finish must not
      // leave the SCREEN claiming it did, for the same reason the cutoff is
      // only written after the last row. The rows therefore leave [_entries]
      // AFTER the reap returns, never before: if the batch dies halfway the
      // honest direction is to under-claim the deletion (a row still listed
      // whose bytes may already be gone — the next [load] reconciles it)
      // rather than over-claim it (rows wiped off the screen while they are
      // still on disk), which is the very shape this card removed.
      // No silent failure either: the trail names the batch that did not
      // complete. A user-visible 「清空没做完」("the clear didn't finish") sentence would need new copy —
      // reported as a follow-up need, not smuggled in.
      diag('timeline.clear_failed', <String, Object?>{
        'kind': kind.name,
        'window': window.name,
        'planned_rows': doomed.length,
        'error': e,
      });
      rethrow;
    }
    _entries.removeWhere((TimelineEntry e) => ids.contains(e.id));
    notifyListeners();
    return out;
  }

  // ⚠️ `previewClear(kind, window)` LIVED HERE AND IS DELETED (D7). Its doc
  // claimed it was 「the same selector the confirmation dialog uses」 — false:
  // the clear sheet's preview never called it (grep `previewClear` under
  // apps/mobile/lib now returns this comment and nothing else); the sheet counts
  // via `AssetInventory`. It looked only at the loaded pages, so keeping it
  // around invites the exact defect D7 fixed — somebody wiring a whole-table
  // promise to a one-page answer.
  //
  // WHERE THE PROMISE LIVES INSTEAD, and why that is not a downgrade: the
  // preview the product actually shows is `AssetInventory.readAllRows()` →
  // [readAllRowsForInventory] → [planClear] (stats_clear_sheet.dart `_recount`),
  // and [clear] above now selects from the same whole-table source through the
  // same [planClear]. The 「preview set == deleted set」 invariant is pinned
  // against THAT chain — timeline_purge_test.dart 「清空删掉的恰好是「预估链」承诺
  // 的那些行」("what clear deletes is exactly the rows the 'estimate chain'
  // promised") for the predicate, timeline_clear_boundary_test.dart for the
  // >pageSize case that the deleted method could never have got right.
  // Restoring a store-level preview would either be a second, page-shaped answer
  // to a whole-table question, or — if [clear] delegated to it — a pinning test
  // that cannot fail.

  /// 「清掉了什么范围」("what range was cleared") — still answerable after a
  /// restart (persisted in [TimelineReaper]'s CutoffStore).
  Cutoffs get cutoffs => _reaper.cutoffs;

  void _replace(TimelineEntry oldE, TimelineEntry newE) {
    final int i = _entries.indexWhere((TimelineEntry e) => e.id == oldE.id);
    if (i < 0) return;
    _entries[i] = newE;
    _sort();
    _persistOne(newE);
    notifyListeners();
  }

  void _sort() => _entries.sort(
    (TimelineEntry a, TimelineEntry b) => b.createdAt.compareTo(a.createdAt),
  );

  // V2-06a-2 step 1: every mutation now names the ROW it changed instead of
  // handing the whole table back. The old `saveAll(_entries)` on each edit is
  // the write amplification the SQLite move exists to remove — and leaving it
  // in place while swapping the engine would have produced a version that runs
  // SQLite and is exactly as slow.
  //
  // Fire-and-forget, as before. Order is preserved by the single-writer
  // invariant: every mutation goes through this class, and each call is issued
  // in mutation order on the same isolate.

  // ── D9 ① — a failed row write must not be silent ───────────────────────────
  //
  // Before this card the write was a bare `unawaited(_persistence.upsert(...))`,
  // so a row that never reached disk looked exactly like one that did — on
  // screen now, gone after restart, with nothing anywhere naming it. Red line F2's
  // second direction.
  //
  // ⚠️ WHERE THE FAILURE ACTUALLY WENT — checked in the code rather than
  // assumed, because the first version of this note blamed the wrong layer.
  // `SqfliteTimelinePersistence._serialize` (timeline_sqlite.dart:574) does
  // `_writes = next.catchError(...)` and RETURNS `next` UNCAUGHT: its
  // `catchError` keeps the write CHAIN alive and does not mark the returned
  // future handled. What dropped the error is `unawaited` right here — the
  // error then surfaced as an unhandled async error in the app's zone, which on
  // a phone reaches no DiagLog, no screen and no diagnosing human. Silent in
  // the only sense that matters, but by THIS line's doing, not the store's.
  //
  // THE HONEST MINIMUM, and why it stops here (documented per D9): the failure
  // now lands in DiagLog — the one phone-side trail that reaches a diagnosing
  // human — with the row id and the error. The in-memory row is deliberately
  // KEPT: it is true for this session (the user did say it, the text is on
  // screen), and no per-row UI surface claims durability — the only durability
  // claim in the product is the full-history footnote, which speaks per-STORE
  // (storageKind), not per-row. A user-visible per-row 「未落盘」("not yet
  // written to disk") marker would
  // need new copy, which this wave may not add; reported as a follow-up need.
  //
  // Pinned by timeline_persist_failure_test.dart (throwing persistence ⇒ the
  // diag line MUST appear; the old path shows nothing).
  void _persistOne(TimelineEntry entry) {
    unawaited(
      _persistence.upsert(entry).then<void>(
        (_) {},
        onError: (Object e) => diag('timeline.persist_failed', <String, Object?>{
          'entry_id': entry.id,
          'status': entry.status.name,
          'error': e,
        }),
      ),
    );
  }

}
