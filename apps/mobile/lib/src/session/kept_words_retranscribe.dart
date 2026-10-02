// NR-137 — WHICH RETAINED `settled_unverified` RECORDINGS MAY BE RE-TRANSCRIBED.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, the NR-137 correction (2026-10-02)
//   _dispatch/2026-10-02-nr137-design.md §1 (the five conditions and why)
//
// A recording that lands `settled_unverified` has words on the page whose
// completeness could not be proven. Re-transcribing it is only honest where the
// press can REPLACE those words, never add a second copy of them — so the
// question this file answers is 「can the earlier rows be found」, and the
// answer is yes only for an article (continuous recording) whose rows are
// loaded (⚠️ round 3: stored, loaded or not): an article row carries
// `articleId` + `articleOffsetMs`, which is how
// `RecoveryJournalLegSettle._replacePartialRows` (recovery_leg_settle.dart)
// finds the rows of a range.
//
// 🔴 WHAT IS LEFT OUT, ON PURPOSE (the design's §1 residuals):
//   · an ordinary press — its rows were delivered to a PC and the manifest
//     names only the last of them (`resultRef`, written from `rowIds.last` in
//     live_settle.dart), so a press would either duplicate the words or
//     delete delivered history;
//   · a stretch already marked `done: unverified` — the scan feeds only the
//     stretches still owed (`_Owed.of`, retained_audio_journal_scan.dart), so
//     the unproven stretch would never be the one fed.
// The pending-page state that admits a recording at all is decided by
// `PendingRecoveryStore.stateOf`; this file adds only the replaceability half.

import '../audio/retained_audio_journal.dart';
import '../diag/diag_log.dart';
import '../signaling/wire_payloads.dart' show Delivery;
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_store.dart';
import '../timeline/timeline_verified_reads.dart';

/// The manifest half: words exist (`resultRef`).
///
/// ⚠️ 更正（NR-137 round 2）: 原为 also 「no stretch concluded without proof」.
/// Such a stretch is now reopened at the press
/// (`RecoveryJournalLegKeptWords._reopenUnprovenStretches`), so it no longer
/// rules a recording out.
bool manifestAllowsKeptWordsRetranscribe(RecordingManifest m) =>
    m.resultRef != null;

/// The timeline half: which of [articleIds] are articles with rows IN STORAGE.
/// Such a recording is re-transcribed IN PLACE; any other recording (an
/// ordinary press, a legacy segment) gets a new note.
///
/// ⚠️ 更正（NR-137 round 3, review B5）: 原为 「articles whose every stored row
/// is LOADED」. A loaded check taken before the press says nothing about the
/// moment the replacement runs — a `TimelineStore.load` in between swaps the
/// window, and the replacement then missed rows that were only on disk
/// (measured: both copies on disk, audio released). The replacement now reads
/// its membership from STORAGE ([replaceKeptRowsInPlace]), so whether a row
/// happens to be loaded no longer decides anything. One storage scan.
///
/// ⚠️ NR-137 round 6 (review D2): an article that may own a row storage could
/// not decode counts too. 「No stored rows」 cannot be concluded from a scan
/// with holes, and the in-place path is the one that proves the membership
/// before it removes anything ([replaceKeptRowsInPlace] fails closed on the
/// same holes: press `failed`, audio kept). The note path would instead leave
/// the undecodable rows beside a new note and release the audio.
Future<Set<String>> replaceableArticles(
  TimelineStore timeline,
  Set<String> articleIds,
) async {
  if (articleIds.isEmpty) return const <String>{};
  final ({List<TimelineEntry> rows, Set<String> unknown}) scan =
      await articleRowsVerified(timeline, articleIds);
  return <String>{
    for (final TimelineEntry e in scan.rows)
      if (!e.isArticle && e.articleId != null) e.articleId!,
    ...scan.unknown,
  };
}

/// NR-137 round 3 (review B4) — remove [rows] and PROVE it: the store's
/// delete is awaited (its batch form re-raises a failed reap, where the
/// single-row form only logs), then every row is read back from storage.
/// False when any row is still there — the caller keeps the audio and says
/// the press failed. ⚠️ Round 9: ONE proof (`TimelineProof`) for all rows.
Future<bool> removeRowsDurably(
    TimelineStore timeline, List<TimelineEntry> rows) async {
  if (rows.isEmpty) return true;
  try {
    await timeline.deleteMany(rows);
  } on Object catch (e) {
    diag('audio.recovery.kept_words_remove_failed', <String, Object?>{
      'rows': rows.length,
      'error': '$e',
    });
    return false;
  }
  return _allProvenGone(timeline, <String>[for (final TimelineEntry e in rows) e.id]);
}

/// NR-137 round 4 (review D2) — is [id] PROVEN gone from storage?
///
/// 🔴 THREE ANSWERS, NOT TWO. Absent (or soft-deleted) ⇒ true. Present ⇒
/// false. A read that failed ⇒ false too: "could not read" is unknown, and
/// unknown is never verified absence (round 3 negated `isPersistedAs`, whose
/// `false` also covers a read exception — measured: a refused readback was
/// taken as proof, the press said done, two copies stayed, audio went).
///
/// ⚠️ 更正（NR-137 round 6, review D2）: 原为 `readStored(id) == null` ⇒ gone.
/// The keyed SQLite read returns null for a row whose payload will not decode
/// (`_decode` skips it), so a row still on disk was "proven" gone (measured:
/// nr137_unreadable_row_test.dart). Now [StoredRowState.unreadable] is a
/// third answer, and it is unknown like a read that threw.
///
/// ⚠️ NR-137 round 9 (review r8 B4): was a keyed read first, which let a
/// readable tombstone answer before residue of the same id was looked at.
/// Now `TimelineProof.absent`: every store read, nothing undecoded may be
/// this id, every decoded copy a tombstone.
Future<bool> provenGone(TimelineStore timeline, String id) =>
    _allProvenGone(timeline, <String>[id]);

Future<bool> _allProvenGone(TimelineStore timeline, List<String> ids) async {
  final TimelineProof proof = await timeline.proof(ids: ids);
  for (final String id in ids) {
    if (!proof.absent(id)) {
      diag('audio.recovery.kept_words_row_not_proven_gone', <String, Object?>{
        'row': id,
        'complete': proof.complete,
      });
      return false;
    }
  }
  return true;
}

/// NR-137 round 5 — the rows a WITHDRAWAL must cover: every one storage
/// holds ([storedRows]) and, beside them, any still on screen that storage
/// never got (a row whose write failed lives only in memory, and leaving it
/// would put the words on the page twice once a later attempt lands —
/// measured: `recovery_codex_review_test.dart` 「Codex rc2 ③」). Null when a
/// storage read failed.
Future<List<TimelineEntry>?> withdrawalRows(
    TimelineStore timeline, List<String> ids) async {
  final List<TimelineEntry>? stored = await storedRows(timeline, ids);
  if (stored == null) return null;
  final Set<String> onDisk = <String>{for (final TimelineEntry e in stored) e.id};
  return <TimelineEntry>[
    ...stored,
    for (final String id in ids)
      if (!onDisk.contains(id))
        if (timeline.findById(id) case final TimelineEntry e) e,
  ];
}

/// NR-137 round 4 (review D1) — the rows [ids] name, as STORAGE holds them,
/// in [ids] order; absent or soft-deleted ones are left out. Null when any
/// read failed or any row is there but undecodable (round 6, review D2): the
/// caller must not act on a partial inventory.
///
/// 🔴 NOT `findById`. The timeline's memory is a paged window
/// (`TimelineStore.pageSize`), and a reload can push a row this press wrote
/// out of it mid-press; a row that is merely not loaded is still this press's
/// row (measured: a paged-out replay segment was taken as 「earlier」 text and
/// deleted, the press said done, and the audio went).
Future<List<TimelineEntry>?> storedRows(
    TimelineStore timeline, List<String> ids) async {
  // ⚠️ NR-137 round 9: ONE proof (`TimelineProof`) for every id. A live
  // decoded copy is returned to be acted on; an id is left out only when it
  // is PROVEN absent (a tombstone alone no longer is — review B4); anything
  // else is null, so no id escapes both the act and the proof.
  final TimelineProof proof = await timeline.proof(ids: ids);
  final List<TimelineEntry> out = <TimelineEntry>[];
  for (final String id in ids) {
    final StoredRow r = proof.lookup(id);
    final TimelineEntry? e = r.entry;
    if (e != null && !e.deleted) {
      out.add(e);
    } else if (!proof.absent(id)) {
      diag('audio.recovery.kept_words_row_unreadable', <String, Object?>{
        'row': id,
        'complete': proof.complete,
      });
      return null;
    }
  }
  return out;
}

/// Rows a kept-words fold or replacement may ever touch: record-only rows
/// that are not themselves a re-transcription note nor an article cover.
/// 🔴 A ROW THAT WENT TO A PC IS NEVER ONE OF THEM (review B3).
bool _foldable(TimelineEntry e) =>
    e.delivery == Delivery.none &&
    e.retranscribedFrom == null &&
    !e.isArticle &&
    !e.deleted;

/// NR-137 round 3 (review B5) — replace a kept article's earlier rows with
/// the press's [ownedRowIds], reading the earlier rows from STORAGE (not the
/// loaded window) and removing them durably before anything is settled.
///
/// The earlier rows are the article's stored members inside `[0,
/// rangeEndMs)` that this press did not produce. A row the user EDITED is
/// kept beside the new ones (RC-3b, MAIN 2026-09-24); a delivered row is
/// never touched. False ⇒ removal did not complete: the caller withdraws the
/// new rows and keeps the audio.
Future<bool> replaceKeptRowsInPlace({
  required TimelineStore timeline,
  required String articleId,
  required List<String> ownedRowIds,
  required int rangeEndMs,
}) async =>
    await replaceKeptRowsInPlaceForRelease(
        timeline: timeline,
        articleId: articleId,
        ownedRowIds: ownedRowIds,
        rangeEndMs: rangeEndMs) !=
    null;

/// [replaceKeptRowsInPlace], and what a release of the audio would stand on
/// (round 10, review r9 B1): the answer present, the earlier rows gone, the
/// article resolved. Null exactly when [replaceKeptRowsInPlace] is false.
/// ⚠️ The answer's presence below decides only whether THIS step completed;
/// the release itself is authorized later, by one fresh proof of the claim
/// (`TimelineStore.releaseAuthorized`), taken last.
Future<TimelineReleaseClaim?> replaceKeptRowsInPlaceForRelease({
  required TimelineStore timeline,
  required String articleId,
  required List<String> ownedRowIds,
  required int rangeEndMs,
}) async {
  final Set<String> fresh = ownedRowIds.toSet();
  // Round 6 (review D2) — a membership with holes is not a membership: a
  // member storage could not decode would stay beside the new rows.
  final List<TimelineEntry>? members;
  try {
    members = await articleMembersVerified(timeline, articleId);
  } on Object {
    return null;
  }
  if (members == null) return null;
  final List<TimelineEntry> earlier = <TimelineEntry>[
    for (final TimelineEntry e in members)
      if (!fresh.contains(e.id) &&
          !e.edited &&
          _foldable(e) &&
          (e.articleOffsetMs ?? -1) >= 0 &&
          e.articleOffsetMs! < rangeEndMs)
        e,
  ];
  bool ok = await removeRowsDurably(timeline, earlier);
  // Round 4 (review D1) — and the WHOLE owned answer is still in storage:
  // only then may anything be settled about the bytes.
  List<TimelineEntry>? answer;
  if (ok) {
    answer = await storedRows(timeline, ownedRowIds);
    ok = answer != null && answer.length == ownedRowIds.toSet().length;
  }
  diag('audio.recovery.kept_words_replaced', <String, Object?>{
    'article': articleId,
    'replaced': earlier.length,
    'durable': ok,
  });
  if (!ok) return null;
  return TimelineReleaseClaim.ofRows(present: answer!, gone: earlier)
      .and(TimelineReleaseClaim(articles: <String>{articleId}));
}

/// What a fold came to.
class KeptWordsFold {
  const KeptWordsFold({this.noteId, this.storageFailed = false, this.claim});

  /// The one note, on disk, read back — and every folded row gone from disk.
  final String? noteId;

  /// Round 10 — what releasing the audio would stand on: the note present,
  /// the folded rows gone. Authorized later by one fresh proof, taken last.
  final TimelineReleaseClaim? claim;

  /// A write or a removal did not complete: nothing may be settled, the
  /// press failed, the audio stays.
  final bool storageFailed;
}

/// NR-137 (MAIN 2026-10-02) — turn the rows one re-transcription produced
/// into ONE record-only note marked as a re-transcription of
/// [sourceRecordingId], and remove the rows it was made from.
///
/// 🔴 FOR A RECORDING WHOSE EARLIER ROWS ARE NOT REPLACED IN PLACE: an
/// ordinary press (its rows are delivered history and stay exactly as they
/// are), a legacy segment. `origin: 'cloud'` + `Delivery.none` (a light
/// record, `EntryStatus.noted`, never sent — `entry_never_sent.dart`), one
/// row however many spans the engine cut it into.
///
/// ⚠️ 更正（NR-137 round 3, review B3/B4）:
///   · [ownedRowIds] must be the rows THIS replay settled (the segment
///     ledger, `SegmentBuffer.settlement`), never a timeline-wide difference
///     — and each one is checked again here ([_foldable]): a row that went to
///     a PC is never folded or removed, whoever passed it in;
///   · the removal is awaited and read back ([removeRowsDurably]), and it
///     happens BEFORE the note is written. If it does not complete, no note
///     is written and [KeptWordsFold.storageFailed] is set: the caller keeps
///     the audio and reports the failure.
Future<KeptWordsFold> consolidateIntoRetranscribedNote({
  required TimelineStore timeline,
  required List<String> ownedRowIds,
  required String sourceRecordingId,
  required String clientId,
}) async {
  // Round 4 (review D1) — from STORAGE, so a row this replay wrote that a
  // reload paged out is still folded (and still removed).
  final List<TimelineEntry>? stored = await storedRows(timeline, ownedRowIds);
  if (stored == null) return const KeptWordsFold(storageFailed: true);
  final List<TimelineEntry> rows = <TimelineEntry>[
    for (final TimelineEntry e in stored)
      if (_foldable(e)) e,
  ];
  final String text = rows
      .map((TimelineEntry e) => e.displayText.trim())
      .where((String t) => t.isNotEmpty)
      .join('\n');
  if (text.isEmpty) {
    final bool gone = await removeRowsDurably(timeline, rows);
    return KeptWordsFold(storageFailed: !gone);
  }
  // 🔴 THE REPLAY ROWS GO FIRST, THE NOTE SECOND (review B4). If storage
  // refuses the removal, no note is written: the page never holds the note
  // AND the rows it was made from. If the note then fails, the press failed
  // and its own rows are gone — the earlier words were never touched, and
  // the audio stays for the next press.
  if (!await removeRowsDurably(timeline, rows)) {
    diag('audio.recovery.retranscribed_note', <String, Object?>{
      'source': sourceRecordingId,
      'rows': rows.length,
      'note': null,
      'failed': 'remove_rows',
    });
    return const KeptWordsFold(storageFailed: true);
  }
  final int ms =
      rows.fold<int>(0, (int s, TimelineEntry e) => s + (e.durationMs ?? 0));
  final TimelineEntry note = timeline.buildFromUtterance(
    clientId: clientId,
    mode: rows.first.mode,
    delivery: Delivery.none,
    text: text,
    sourceLang: rows.first.sourceLang,
    durationMs: ms > 0 ? ms : null,
    segmentsCount: rows.length,
    origin: 'cloud',
    retranscribedFrom: sourceRecordingId,
    mcpContentReady: true,
  );
  await timeline.awaitPersisted(note.id);
  final bool written = await timeline.isPersistedAs(note.id, (TimelineEntry s) =>
      !s.deleted &&
      s.sourceText == note.sourceText &&
      s.outputText == note.outputText &&
      s.retranscribedFrom == sourceRecordingId &&
      s.delivery == Delivery.none);
  if (!written) await removeRowsDurably(timeline, <TimelineEntry>[note]);
  final bool removed = written;
  diag('audio.recovery.retranscribed_note', <String, Object?>{
    'source': sourceRecordingId,
    'rows': rows.length,
    'note': removed ? note.id : null,
  });
  return removed
      ? KeptWordsFold(
          noteId: note.id,
          claim: TimelineReleaseClaim.ofRows(
              present: <TimelineEntry>[note], gone: rows))
      : const KeptWordsFold(storageFailed: true);
}
