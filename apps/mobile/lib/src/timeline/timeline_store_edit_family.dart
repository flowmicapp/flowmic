// 800-line cap — the POST-CREATION MUTATION FAMILY moved out of
// timeline_store.dart into a `part` of the same library, the same shape and
// the same reason `卡 F11` gave for the inject:result write-back beside it.
//
// 🔴 NOTHING WAS CHANGED IN THE MOVE except the receiver: each method was an
// instance method of [TimelineStore] and is now a library-private top-level
// function taking it explicitly ([store]) — a `part` shares the library, so
// `store._replace` is still in scope. Every method stays on the class as a
// one-line delegate, so **no caller and no test double had to be edited**.
//
// WHY THIS IS THE RIGHT CUT: timeline_store.dart answers 「what does this
// phone remember」 (build / find / edit / delete / purge); this file answers
// ONE narrower question inside that — 「once a row already exists, what is
// allowed to change its DISPLAY face or its delivery-in-flight state, and
// under what name」. `applyEdit` / `applyRefined` / `applyProcessed` are the
// three writers of the display face (§4.0 A: `source_text` stays immutable
// through every one of them); `markReinjecting` / `markNoted` are the two
// writers of delivery-in-flight state that do NOT go through a wire verdict
// (`applyInjectResult`, already split out beside this file, owns that one).
// The RETIRED 0.2.27 note travels with them because it explains what USED TO
// sit in this exact neighbourhood (this file's header comment in
// timeline_store.dart still calls it 「the retirement block below
// [applyProcessed]」, and moving both together keeps that true).

part of 'timeline_store.dart';

/// Edit (§4.0 A + card item 3): move the DISPLAY face and set the `edited`
/// overlay bit. `source_text` is immutable — copyWith has no sourceText param,
/// so the original is structurally untouchable here.
TimelineEntry? _applyEdit(TimelineStore store, String id, String newText) {
  final TimelineEntry? entry = store.findById(id);
  if (entry == null) return null;
  final TimelineEntry updated = entry.copyWith(
    outputText: newText,
    edited: true,
    updatedAt: DateTime.now().toUtc(),
  );
  store._replace(entry, updated);
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
TimelineEntry? _applyRefined(
  TimelineStore store,
  String id,
  String refinedText,
) {
  final TimelineEntry? entry = store.findById(id);
  if (entry == null) return null;
  final TimelineEntry updated = entry.copyWith(
    outputText: refinedText,
    refinedAt: DateTime.now().toUtc(),
    updatedAt: DateTime.now().toUtc(),
  );
  store._replace(entry, updated);
  return updated;
}

TimelineEntry? _applyProcessed(
  TimelineStore store,
  String id,
  String processedText,
  FlowMode mode,
) {
  final TimelineEntry? entry = store.findById(id);
  if (entry == null) return null;
  final TimelineEntry updated = entry.copyWith(
    outputText: processedText,
    processedText: processedText,
    processMode: mode.name,
    updatedAt: DateTime.now().toUtc(),
  );
  store._replace(entry, updated);
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
TimelineEntry? _markReinjecting(TimelineStore store, String id) {
  final TimelineEntry? entry = store.findById(id);
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
  store._replace(entry, updated);
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
TimelineEntry? _markNoted(TimelineStore store, String id) {
  final TimelineEntry? entry = store.findById(id);
  if (entry == null || !entry.awaitingDelivery) return null;
  final TimelineEntry updated = entry.copyWith(
    status: EntryStatus.noted,
    updatedAt: DateTime.now().toUtc(),
  );
  store._replace(entry, updated);
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
