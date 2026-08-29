// Part of chat_controller.dart — edit + delete of an existing row.
//
// SPEC-REF:
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md (owner architecture
//     ruling: phone↔PC does not do cloud storage sync, the cloud does not store
//     transcripts; the phone is the owner of its own record)
//   docs/rebuild/08-MOBILE-SPEC.md §5 (source_text immutable),
//     master-plan §4.0 A/D (each utterance keeps its row; status = delivery truth)
//
// ── 0.2.27: THE UPLINK THIS FILE IS NAMED AFTER IS GONE ─────────────────────
//
// The file kept its name so the retirement reads where the history it refers to
// lives. What it used to hold, and why each piece left:
//
//   · `_pushRowEdit` — the ONE place a local edit was reported to the server and
//     its verdict applied (accepted → markSynced, superseded → adopt the peer's
//     text, deletedByPeer → DELETE the local row). Its four callers (the hand
//     edit here, the punctuation append in chat_control_keys, the GA-13 reprocess
//     and the GA-14 refine in chat_utterance) now stop at the local write, which
//     was always the record of truth — the uplink was a report about it.
//     ⚠️ The `deletedByPeer` arm is the reason this card exists at all: it read
//     `SETTINGS_SYNC_FAIL/'no such entry'` as 「对方删了这一行」 ("the peer
//     deleted this row") and physically removed the user's row. That code
//     answers 「id 不在表里」 ("id not in the table"); after the server
//     dropped `transcript_history` it would have answered that for EVERY edit of
//     every previously-synced row — a silent 100%-hit-rate data loss.
//   · `_reflushPending` — replayed unsynced rows into `transcript_history` on
//     each connected rising edge. ⚠️ Worth being precise about what was lost:
//     NOTHING the user can see. That queue never delivered a word to a PC
//     (delivery is `inject:request`), it only filled a server table that no
//     surface read — the web console's transcript page is being taken down in
//     this same window. So the queue was not drained on the way out and no rows
//     were 「flushed one last time」: its key (`TimelineEntry.syncState`) is
//     deleted, which abolishes the queue instead of leaving it to replay forever
//     into a handler that now answers HISTORY_SYNC_RETIRED.
//     ⚠️ Owner ruling 3 (「手机专给 PC 的内容一定要能补上」 — "content the phone
//     sends specifically to a PC must always be able to be made up") is NOT
//     served by this and never was. That is window B's persistent outbox, and
//     it must carry
//     `inject:request`, not a row into a table.
//   · `_pushDelete` — nothing up there to tombstone.
//
// What remains is the LOCAL half, and it is complete on its own: the row moves,
// it persists, every surface watching the store repaints.

part of 'chat_controller.dart';

/// Edit: moves the display face + sets the `edited` bit; `source_text` is
/// immutable (`copyWith` has no parameter for it, so that is structural).
///
/// Stays `void`: the store is the record of truth and every surface watches it.
/// There is no longer a second party to reconcile with, so there is no verdict to
/// wait for and nothing that could disagree.
void _editEntry(ChatController c, TimelineEntry entry, String newText) {
  c.store.applyEdit(entry.id, newText);
}

/// Delete: the user asked for the row to go, so it goes. Local-only, because
/// local is the only place it ever lived after this window's ruling.
void _deleteEntry(ChatController c, TimelineEntry entry) {
  c.store.delete(entry.id);
}

// ── Card NR-3: there is deliberately NO `deleteEntries` on this controller ──
//
// The multi-select batch delete calls `TimelineStore.deleteMany` directly, and
// that is a design choice rather than a shortcut. Two reasons, both
// grep-checkable:
//   ① The all-history page (`ui/history_page.dart`) has no ChatController at
//      all — it is constructed with a TimelineStore and a storage kind
//      (`main.dart` `_buildHistory`). NR-3 gives that page the same batch
//      delete as the chat page, and 「the same」 has to mean the same code. A
//      controller-level entry point could only ever serve one of the two
//      callers, which is how a second delete path gets born.
//   ② This layer would add nothing to forward: [_deleteEntry] above is
//      literally `c.store.delete(entry.id)`. A delegate that adds no behaviour
//      but does add a second name for one action is exactly the kind of
//      surface this repo keeps deleting.
// The chain is unchanged where it matters: store → `TimelineReaper`, the one
// deleter (timeline_reaper.dart's header states the rule).
