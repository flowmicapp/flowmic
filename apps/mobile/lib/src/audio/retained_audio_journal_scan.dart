// Card LS-1 — the STARTUP RECOVERY SCAN, split out of
// retained_audio_journal.dart for the 700-line discipline (§A9 stage 1) when
// card LS-2 added its wiring notes to that file.
//
// 🔴 MOVED VERBATIM. Both classes below, and every comment in them, are
// byte-for-byte what stood at retained_audio_journal.dart:455-729. Nothing was
// rewritten and no caller was edited: retained_audio_journal.dart re-exports
// this file, so `import 'retained_audio_journal.dart'` still sees both names.
//
// WHY THIS IS THE RIGHT CUT: the journal answers 「a recording is happening,
// where do its bytes go」. This file answers 「the process died; what is on the
// disk and how much of it may be trusted」 — a different question, asked at a
// different moment, by a caller (card LS-2's boot scan) that never writes.
//
// SPEC-REF: docs/strategy/2026-08-27-project-status-log.md
//   #audio-durability-audit-draft §A3-8 (three quantities, ZERO deletes)

import 'dart:typed_data';

// One import, not three: retained_audio_journal.dart re-exports the seam and
// the manifest, and the analyzer refuses the redundant pair.
import 'retained_audio_journal.dart';

// 🔴 NOT re-exported by the journal (it imports this one privately), so the
// scan asks for it by name. Card RF-2 — see [_publishManifest].
import 'retained_audio_deleted.dart';

/// What the startup scan concluded about one recording. §A3-8 requires the
/// three quantities to be NAMED SEPARATELY; this class is that requirement.
class RecordingScan {
  final String recordingId;

  /// null when the manifest is missing or quarantined.
  final RecordingManifest? manifest;

  /// ① What the manifest SAYS was committed. A sentence, not a fact.
  final int committedClaim;

  /// ② What the PCM file measures on disk right now.
  final int observedLength;

  /// ③ What passed format/length checks and may actually be fed back.
  final JournalByteRange verifiedRecoverableRange;

  /// `observedLength > committedClaim`: bytes past the claim exist.
  final bool unverifiedTail;

  /// The unverified tail passed its checks and was folded into ③.
  final bool tailRecovered;

  /// `committedClaim > observedLength`: the commit order was violated
  /// somewhere. 🔴 The manifest high-water mark is NOT rewritten down.
  final bool claimAheadOfObserved;

  /// The PCM file has an odd byte count. Excluded from the READ VIEW only;
  /// the file is untouched.
  final bool oddTrailingByte;

  /// Manifest unreadable / version too new ⇒ parked. Zero deletes; excluded
  /// from both the recovery queue and any eviction candidate list.
  final bool quarantined;

  /// PCM present with no manifest at all (a pre-LS-1 layout, or a crash before
  /// the first commit). Owner ruling O-7 owns what happens to these; the scan
  /// only reports.
  final bool manifestMissing;

  /// Manifest format does not match what this build can feed. §A3-2a: refuse
  /// and keep the bytes — never transcode, never guess.
  final bool formatMismatch;

  /// 🔴 OWNER RULING O-5 (card LS-4) — the user swiped this recording away.
  /// The bytes are on disk and stay there; what this flag buys is that the
  /// recovery queue (RC-1) must SKIP it, so a sentence the user threw away
  /// cannot turn itself into a timeline row hours later.
  ///
  /// ⚠️ FALSE IS NOT 「not cancelled」 IN EVERY CASE. A quarantined or missing
  /// manifest cannot be read, so nothing is known about its disposition and
  /// this reports false — which is safe only because those two states are
  /// ALREADY excluded from the recovery queue by [quarantined] /
  /// [manifestMissing]. A reader that ever starts feeding those back must read
  /// this sentence first.
  final bool cancelled;

  /// 🔴 SD-2 — THE LIVE SETTLE FOR THIS RECORDING IS STILL IN FLIGHT.
  ///
  /// True when the manifest carries a `liveSettlePendingAtMs` stamp that is
  /// still inside [kLiveSettlePendingGraceMs]. It means: the press ended
  /// normally, the journal closed, and the terminal final that settles it has
  /// not been written down yet — so this recording is NOT an orphan, however
  /// much it looks like one from a directory listing (`settled:false`, nobody
  /// holding it open). `RecoveryJournalLeg._scanCandidates` skips it; a sweep
  /// that did not would open a second, billable transcription of audio that is
  /// being settled live, and mint a second row for one press.
  ///
  /// ⚠️ FALSE ONCE THE GRACE HAS PASSED, AND THAT IS THE CRASH FALLBACK. A
  /// process killed between the stamp and the settle leaves the stamp standing
  /// with nobody to clear it; after the window it is simply ignored and the
  /// recording is a candidate again. Reported as a FLAG rather than acted on
  /// here, exactly like [cancelled]: this class reads, the leg decides.
  final bool liveSettlePending;

  /// Card RC-K — the owed stretch [verifiedRecoverableRange] feeds (the first
  /// one still owed), or null when the manifest records none (the whole
  /// recording is owed, as before RC-3).
  final OwedRange? owedRange;

  /// Card RC-K — how many stretches are still owed, [owedRange] included. At
  /// most 1 is 「this is the last one」: the recovery leg settles it as the
  /// single range it used to be.
  final int owedStretches;

  /// Card RC-K — bytes still owed across EVERY owed stretch (on disk). What a
  /// screen or a tally counts; [verifiedRecoverableRange] is only the next one.
  int get recoverableBytes => _recoverableBytes ?? verifiedRecoverableRange.length;
  final int? _recoverableBytes;

  final String? note;

  const RecordingScan({
    required this.recordingId,
    required this.manifest,
    required this.committedClaim,
    required this.observedLength,
    required this.verifiedRecoverableRange,
    this.unverifiedTail = false,
    this.tailRecovered = false,
    this.claimAheadOfObserved = false,
    this.oddTrailingByte = false,
    this.quarantined = false,
    this.manifestMissing = false,
    this.formatMismatch = false,
    this.cancelled = false,
    this.liveSettlePending = false,
    this.owedRange,
    this.owedStretches = 0,
    int? recoverableBytes,
    this.note,
  }) : _recoverableBytes = recoverableBytes;

  @override
  String toString() => 'RecordingScan($recordingId claim=$committedClaim '
      'observed=$observedLength recoverable=$verifiedRecoverableRange '
      'tail=$unverifiedTail/$tailRecovered ahead=$claimAheadOfObserved '
      'odd=$oddTrailingByte quarantined=$quarantined '
      'cancelled=$cancelled settlePending=$liveSettlePending)';
}

/// Startup recovery scan (§A3-8).
///
/// 🔴 NO PRODUCTION CALLER YET — wired by card LS-2 (`retained_audio_boot.dart`
/// runs it before the store's TTL sweep). It is written now because LS-0's red
/// tests need something to be red about, and because the scan is the only
/// place where the three §A3-8 quantities can be kept apart.
///
/// 🔴 IT NEVER TRUNCATES AND NEVER DELETES A PCM BYTE. The only writes it
/// performs are (a) publishing a `claimAheadOfObservedAt` marker onto a
/// manifest whose claim ran ahead, preserving that manifest's high-water mark,
/// and (b) renaming an unreadable manifest aside to quarantine it.
///
/// 🔴 AND (a) IS A WRITE, WHICH IS WHY THIS READER TAKES [DeletedRecordings].
/// Card RF-2 named the choke point for 「the user deleted this while we were
/// writing about it」 and found three writers of a manifest path; this was the
/// one nobody counted, because the class it lives in is documented as a
/// reader. Measured shape (pending_recovery_actions_test.dart's delete-race
/// case, 2026-09-12): a Retry press SCANS the directory before it dials, the
/// delete landed inside that scan, and the marker publish put
/// `<id>.manifest.json` back for audio that was gone — the card returned with
/// nothing behind it, and the user's delete read as having silently failed.
///
/// ⚠️ THE REGISTRY GUARDS THE WRITE, NOT THE REPORT. A scan already under way
/// still returns the row it read before the delete landed (the bytes were
/// there when it looked); what it no longer does is leave a file behind that
/// makes the NEXT scan say so too. Filtering the report here would be a second
/// answer to 「which recordings exist」 — the delete already removed the files,
/// and that is the answer.
class RetainedAudioJournalScan {
  const RetainedAudioJournalScan._();

  static Future<List<RecordingScan>> scan({
    required String dirPath,
    JournalFileSystem fs = const IoJournalFileSystem(),
    AudioJournalFormat expected = AudioJournalFormat.current,
    int Function()? clock,
    void Function(JournalNotice notice)? onNotice,
    DeletedRecordings? deleted,
  }) async {
    final int Function() now =
        clock ?? (() => DateTime.now().millisecondsSinceEpoch);
    final List<String> names = await fs.listNames(dirPath);
    final String sep =
        dirPath.endsWith('/') || dirPath.endsWith(r'\') ? '' : '/';
    final Set<String> ids = <String>{};
    for (final String n in names) {
      if (n.endsWith(RetainedAudioJournal.pcmSuffix)) {
        ids.add(n.substring(
            0, n.length - RetainedAudioJournal.pcmSuffix.length));
      } else if (n.endsWith(RetainedAudioJournal.manifestSuffix)) {
        ids.add(n.substring(
            0, n.length - RetainedAudioJournal.manifestSuffix.length));
      }
    }
    final List<RecordingScan> out = <RecordingScan>[];
    for (final String id in ids.toList()..sort()) {
      out.add(await _scanOne(
        fs: fs,
        base: '$dirPath$sep$id',
        id: id,
        expected: expected,
        now: now,
        onNotice: onNotice,
        deleted: deleted,
      ));
    }
    return out;
  }

  static Future<RecordingScan> _scanOne({
    required JournalFileSystem fs,
    required String base,
    required String id,
    required AudioJournalFormat expected,
    required int Function() now,
    void Function(JournalNotice notice)? onNotice,
    DeletedRecordings? deleted,
  }) async {
    final String pcmPath = '$base${RetainedAudioJournal.pcmSuffix}';
    final String manifestPath = '$base${RetainedAudioJournal.manifestSuffix}';
    final int observed =
        await fs.exists(pcmPath) ? await fs.lengthOf(pcmPath) : 0;
    final bool odd = observed.isOdd;

    void notice(JournalNotice n) => onNotice?.call(n);

    if (!await fs.exists(manifestPath)) {
      // Orphan PCM. Everything on disk is unverified, but it is also all we
      // have, so it is offered as a tail — flagged, never silently trusted.
      final int end = _floorEven(observed, expected.bytesPerFrame);
      return RecordingScan(
        recordingId: id,
        manifest: null,
        committedClaim: 0,
        observedLength: observed,
        verifiedRecoverableRange: JournalByteRange(0, end),
        unverifiedTail: observed > 0,
        tailRecovered: end > 0,
        oddTrailingByte: odd,
        manifestMissing: true,
        note: 'no manifest (owner ruling O-7 owns the disposition)',
      );
    }

    RecordingManifest parsed;
    try {
      parsed = RecordingManifest.decode(
          String.fromCharCodes(await fs.readBytes(manifestPath)));
    } on Object catch (e) {
      // §A3-8: quarantine by RENAME. Zero deletes, and the PCM is not touched.
      final String parked = '$base${RetainedAudioJournal.quarantineSuffix}';
      try {
        await fs.rename(manifestPath, parked);
      } on Object {
        // Even the park failed: still report quarantined, still delete nothing.
      }
      notice(JournalNotice(
        code: JournalNotice.codeQuarantined,
        recordingId: id,
        bytes: observed,
        detail: '$e',
      ));
      return RecordingScan(
        recordingId: id,
        manifest: null,
        committedClaim: 0,
        observedLength: observed,
        verifiedRecoverableRange: JournalByteRange.empty,
        oddTrailingByte: odd,
        quarantined: true,
        note: '$e',
      );
    }

    if (!parsed.format.sameAs(expected) ||
        parsed.formatVersion != RecordingManifest.currentFormatVersion) {
      // §A3-2a / format_mismatch_refuse_test: refuse and KEEP the bytes.
      return RecordingScan(
        recordingId: id,
        manifest: parsed,
        committedClaim: parsed.committedClaimBytes,
        observedLength: observed,
        verifiedRecoverableRange: JournalByteRange.empty,
        oddTrailingByte: odd,
        formatMismatch: true,
        cancelled: parsed.cancelled,
        note: 'format ${parsed.format} v${parsed.formatVersion} '
            '!= expected $expected v${RecordingManifest.currentFormatVersion}',
      );
    }

    final int claim = parsed.committedClaimBytes;
    final int frame = parsed.format.bytesPerFrame;

    if (claim > observed && parsed.settled && observed == 0) {
      // 🔴 CARD LS-1b — THE ONE BENIGN WAY A CLAIM OUTRUNS ITS FILE: the settle
      // path released the bytes on purpose and left the manifest standing as the
      // record of where the words went. Reporting that as a commit-order
      // violation would stamp `claimAheadOfObservedAt` on every recording that
      // finished PERFECTLY, and the marker means the opposite of what happened.
      //
      // ⚠️ `observed == 0` IS PART OF THE CONDITION, not tidiness. A settled
      // recording with a SHORT file is not this case — that is a partial
      // deletion or a truncation, and it still deserves the marker below.
      return RecordingScan(
        recordingId: id,
        manifest: parsed,
        committedClaim: claim,
        observedLength: 0,
        verifiedRecoverableRange: JournalByteRange.empty,
        cancelled: parsed.cancelled,
        note: 'settled; bytes released (card LS-1b)',
      );
    }

    if (claim > observed) {
      // 🔴 The manifest ran ahead of the file. Keep the high-water mark; add a
      // marker; recover only what is actually there.
      final RecordingManifest marked =
          parsed.copyWith(claimAheadOfObservedAt: now());
      await _publishManifest(fs, base, marked, id, deleted);
      notice(JournalNotice(
        code: JournalNotice.codeClaimAheadOfObserved,
        recordingId: id,
        offset: claim,
        bytes: observed,
      ));
      final _Owed o = _Owed.of(marked, _floorEven(observed, frame));
      return RecordingScan(
        recordingId: id,
        manifest: marked,
        committedClaim: claim,
        observedLength: observed,
        verifiedRecoverableRange: o.next,
        owedRange: o.range,
        owedStretches: o.stretches,
        recoverableBytes: o.bytes,
        claimAheadOfObserved: true,
        oddTrailingByte: odd,
        cancelled: marked.cancelled,
        liveSettlePending: _settlePending(marked, now),
        note: 'commit order violated: claim $claim > observed $observed',
      );
    }

    if (observed > claim) {
      // Unverified tail. It MAY be half a write, zero padding, or real audio.
      // Fold it in when it passes the format/length check, and say so.
      final int end = _floorEven(observed, frame);
      final bool foldable = end > claim;
      notice(JournalNotice(
        code: JournalNotice.codeUnverifiedTail,
        recordingId: id,
        offset: claim,
        bytes: observed - claim,
      ));
      final _Owed o =
          _Owed.of(parsed, foldable ? end : _floorEven(claim, frame));
      return RecordingScan(
        recordingId: id,
        manifest: parsed,
        committedClaim: claim,
        observedLength: observed,
        verifiedRecoverableRange: o.next,
        owedRange: o.range,
        owedStretches: o.stretches,
        recoverableBytes: o.bytes,
        unverifiedTail: true,
        tailRecovered: foldable,
        oddTrailingByte: odd,
        cancelled: parsed.cancelled,
        liveSettlePending: _settlePending(parsed, now),
      );
    }

    final _Owed o = _Owed.of(parsed, _floorEven(claim, frame));
    return RecordingScan(
      recordingId: id,
      manifest: parsed,
      committedClaim: claim,
      observedLength: observed,
      verifiedRecoverableRange: o.next,
      owedRange: o.range,
      owedStretches: o.stretches,
      recoverableBytes: o.bytes,
      oddTrailingByte: odd,
      cancelled: parsed.cancelled,
      liveSettlePending: _settlePending(parsed, now),
    );
  }

  /// SD-2 — is [m]'s 「a settle is coming」 stamp still worth believing?
  ///
  /// 🔴 BOUNDED AT BOTH ENDS, AND THE LOWER BOUND IS NOT TIDINESS. A stamp
  /// from the FUTURE means the wall clock moved backwards between the write and
  /// this read (a timezone change, an NTP correction, a user setting the date).
  /// `now - t < grace` alone would then be true forever and the recording would
  /// be invisible to the recovery queue permanently — the one outcome this
  /// whole mechanism is not allowed to produce. A clock we cannot reason about
  /// therefore reads as 「not pending」: visible, at worst duplicated.
  static bool _settlePending(RecordingManifest m, int Function() now) {
    final int? at = m.liveSettlePendingAtMs;
    if (at == null) return false;
    final int age = now() - at;
    return age >= 0 && age < kLiveSettlePendingGraceMs;
  }

  /// Publish [m], unless the user threw this recording away.
  ///
  /// 🔴 CARD RF-2, THE SAME TWO HALVES AS `RetainedAudioJournal._commitLocked`,
  /// AND THEY DO NOT DO THE SAME JOB. The second `contains`, AFTER the rename,
  /// is the one that closes the defect: the first is a check-then-write like
  /// every existence check this family replaced, and a delete arriving between
  /// it and the rename publishes anyway. MEASURED 2026-09-12 on the case that
  /// pins this door («a delete that lands inside the recovery SCAN»): remove
  /// the pre-check alone and it is still green; remove the undo alone and it is
  /// `Expected: false  Actual: <true>`.
  ///
  /// ⚠️ THE PRE-CHECK IS KEPT ANYWAY, AND NOT AS A SECOND DEFENCE. It answers a
  /// different question — the mark was already standing when this scan reached
  /// the write, so there is nothing to say about this recording and no reason
  /// to write a file only to delete it again. It also keeps all three manifest
  /// writers reading the same, which is what stops the next reader from
  /// concluding that this one was left out on purpose.
  ///
  /// ⚠️ IT REMOVES ONLY THE MANIFEST THIS CALL PUT THERE, and never any PCM:
  /// §A3-8, nothing in the journal layer deletes audio. A swallowed failure
  /// leaves a few hundred bytes of JSON that the next scan reads as
  /// claim-ahead-of-an-absent-file — the same leftover `_deleteJournal`'s own
  /// PCM-first order accepts.
  static Future<void> _publishManifest(
    JournalFileSystem fs,
    String base,
    RecordingManifest m,
    String recordingId,
    DeletedRecordings? deleted,
  ) async {
    if (deleted?.contains(recordingId) ?? false) return;
    final String tmp = '$base${RetainedAudioJournal.manifestTempSuffix}';
    await fs.writeBytes(
      tmp,
      Uint8List.fromList(m.encode().codeUnits),
      flush: true,
    );
    final String manifestPath = '$base${RetainedAudioJournal.manifestSuffix}';
    await fs.rename(tmp, manifestPath);
    if (deleted?.contains(recordingId) ?? false) {
      try {
        await fs.deleteFile(manifestPath);
      } on Object {
        // Swallowed for the same reason the journal swallows its own undo: the
        // audio is exactly where the user put it (gone), and a scan may not
        // fail because of a write it performs on the side.
      }
    }
  }

  static int _floorEven(int n, int frame) => n - (n % frame);

  /// Card RC-3 — the range still owed: from the manifest's transcribed prefix
  /// (root-cause 2026-09-24 §1.7: this used to start at 0 unconditionally, so a
  /// recovery re-fed the rows the live path had already produced — its eight
  /// words were the recording's OPENING, pasted at the end) to [end].
  ///
  /// A prefix at or past [end] leaves nothing owed and reads as EMPTY, i.e.
  /// not a candidate. The writer never records one that way
  /// (`_accountOwedTail` returns when nothing is owed); a journal the O-2 cap
  /// cut short is the case that can still reach it.
  ///
  /// Card RC-3b — and to the manifest's owed end when the owed stretch sits in
  /// the MIDDLE of the recording (`owedRangeEndBytes`), never past what is on
  /// disk.
  ///
  /// ⚠️ 更正（RC-K，2026-09-24）：原为 one range read off the prefix/end pair.
  /// Now ONE STRETCH of `owedRanges` at a time (the first still owed), same
  /// rules per stretch; [_Owed] carries the rest. A manifest without the list
  /// reads its old pair as one stretch (`RecordingManifest._owedRangesOf`).
  static JournalByteRange _afterPrefix(OwedRange r, int end, int frame) {
    final int start = _floorEven(r.start < 0 ? 0 : r.start, frame);
    final int? owedEnd = r.end;
    final int stop =
        owedEnd == null || owedEnd >= end ? end : _floorEven(owedEnd, frame);
    return start >= stop ? JournalByteRange.empty : JournalByteRange(start, stop);
  }
}

/// Card RC-K — what a manifest still owes, measured against [end] (on disk).
class _Owed {
  const _Owed(this.next, this.range, this.stretches, this.bytes);

  /// The stretch to feed next ([RecordingScan.verifiedRecoverableRange]).
  final JournalByteRange next;
  final OwedRange? range;
  final int stretches;
  final int bytes;

  static _Owed of(RecordingManifest m, int end) {
    final List<OwedRange> owed =
        m.owedRanges.where((OwedRange r) => r.isOwed).toList();
    if (m.owedRanges.isEmpty) {
      // Nothing was ever recorded as owed: the whole recording, as before RC-3.
      final JournalByteRange all = JournalByteRange(0, end);
      return _Owed(all, null, 0, all.length);
    }
    final int frame = m.format.bytesPerFrame;
    int bytes = 0;
    for (final OwedRange r in owed) {
      bytes += RetainedAudioJournalScan._afterPrefix(r, end, frame).length;
    }
    if (owed.isEmpty) return const _Owed(JournalByteRange.empty, null, 0, 0);
    return _Owed(RetainedAudioJournalScan._afterPrefix(owed.first, end, frame),
        owed.first, owed.length, bytes);
  }
}
