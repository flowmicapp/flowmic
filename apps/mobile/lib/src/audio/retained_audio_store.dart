// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b
//     (segment ⊖ "retained" (留存) — the state word this layer exists to make true)
//   docs/strategy/2026-08-08-design-n1-long-recording.md §2.2 (M2)
//   packages/protocol/src/constants.ts AUDIO_DEFAULTS
//     (sample_rate_hz / channels / encoding — the format written here is the
//      CAPTURE format, byte-for-byte; see the no-transcoding note below)
//
// ── THE RETAINED-AUDIO STORE ────────────────────────────────────────────────
//
// Durable side-store for audio that was captured but which the uplink never
// carried. It is the redemption mechanism for the word "awaiting
// transcription" (待转录): doc 15 §2.0-b
// constraint 3 says that word may only ship if a mechanism backs it, because
// this repo's red line is that naming a wait "awaiting..." (待…) with nothing
// behind it is a
// lie. Before this file existed the phone wrote NO audio to disk at all
// (`audio/` held four files; path_provider / writeAsBytes / getTemporaryDirectory
// hit zero across `audio/` and `ptt/`) — so audio that outlived the 30 s ring
// did not merely fail to send, it ceased to exist.
//
// ── 🔴 WHAT THIS IS NOT, AND THE MECHANISM THAT KEEPS IT THAT WAY ───────────
//
// This must never grow into a voice-recording archive. FB-2 (voice original-file
// transport / playback) is deferred by owner ruling — design doc §6
// "deliberately not doing this" (刻意不做的) and
// the `flowmic-voice-audio-playback-requirement` memory both record "owner
// explicitly ordered: not for now" (「owner 明令暂不做」). Therefore,
// deliberately absent from this class and its callers:
//   - no playback entry point (nothing here decodes, plays, or hands out a
//     player-facing handle);
//   - no export path — [dirName] is a sibling of, never inside, any directory
//     declared in a FileProvider `<paths>` file. The update provider is rooted
//     at `<files-path path="update/">` and the clipboard provider at
//     `<cache-path path="clipboard/">`; a file outside every declared root makes
//     FileProvider.getUriForFile throw, so the boundary is enforced by the
//     platform, not by our good intentions. The FPR asset walker
//     (portable/asset_inventory.dart) enumerates the timeline DB and the image
//     blob store and has no knowledge of this directory;
//   - no uplink of the stored bytes as an asset — [read] exists to re-feed the
//     ordinary transcription path, which is the same thing the microphone would
//     have done had the link been up;
//   - the user-facing words are "retained" (留存) / "awaiting transcription"
//     (待转录), never "recording" (录音) as an asset noun.
//
// 🔴 SETTLE ⇒ DELETE IS THE ENFORCEMENT OF THAT BOUNDARY, NOT AN OPTIMIZATION.
// [settle] removes the bytes the instant the segment has been transcribed and
// minted. A store that kept them "just in case" would BE the archive this card
// is forbidden to build, no matter what the UI chose not to show.
//
// ── NO TRANSCODING ──────────────────────────────────────────────────────────
// Bytes are appended exactly as captured: PCM16 / 16 kHz / mono, the same bytes
// AudioCapture put in the ring. Re-encoding would (a) cost CPU on a device that
// is already in trouble, and (b) make the recovery feed differ from the live
// feed — and a recovery path that is not byte-identical to the live path is a
// second mechanism that will drift.

import 'dart:async';
import 'dart:io';

// Uint8List and @immutable both come from foundation; importing dart:typed_data
// and package:meta as well would be redundant (analyzer info-level warning).
import 'package:flutter/foundation.dart';

// Card LS-4 — the tombstone writes one diag line (and never a user-visible
// notice; the reason is in retained_audio_tombstone.dart's body).
import '../diag/diag_log.dart' show diag;

// Card LS-3 — the sweep has to read a manifest to know whether a recording
// settled, and `RetainedAudioJournal` owns the file-name suffixes. Data and
// names only; nothing here opens a journal.
import 'retained_audio_journal.dart';

// 700-line cap — the retention policy family (sweep / dropAll). Same library,
// same rule as every other split in this repo: nothing moved changed behaviour
// and no external caller had to be edited; see that file's header for the
// family and the delegates.
//
// ⚠️ It used to list `_makeRoomFor` / `_allRetained` / `_RetainedFile` as well.
// Card LS-3 deleted all three (owner ruling O-2): the cap is no longer
// balanced by evicting the oldest file, so the eviction family has no members
// left. That is why the list is short, not because it was trimmed.
part 'retained_audio_policy.dart';

// 700-line cap — card LS-4's cancel-tombstone family (write / read / the
// predicate the two pending readers below consult). Split for the same reason
// and in the same shape as the policy family above; the marker's file-name
// design and the four parsers it must slip past are argued in that header.
part 'retained_audio_tombstone.dart';

/// A retention event the user (or at minimum the diagnostics log) MUST hear
/// about. "No silent failure" (没有静默失败) runs in both directions: dropping
/// retained audio
/// silently would be the phone quietly discarding something it told the user it
/// was holding.
@immutable
class RetainedAudioNotice {
  /// Stable identifier — callers branch on this, never on [detail].
  final String code;

  /// Which segment the notice is about; null when it is about the store itself.
  final int? segmentIdx;

  /// Bytes involved, for the diagnostics line.
  final int bytes;

  const RetainedAudioNotice({
    required this.code,
    required this.bytes,
    this.segmentIdx,
  });

  // 🔴 THE `dropped-oldest` NOTICE CODE STOOD HERE AND IS GONE (card RC-1,
  // 2026-09-06), together with its nine translations. Card
  // LS-3 had already deleted its only producer (`_makeRoomFor`) under owner
  // ruling O-2 — the cap is balanced by refusing new bytes, never by deleting
  // audio nobody has recovered — and the constant was kept for one stated
  // reason: the storage face was behind an off-by-default flag, so the change
  // was a plausible thing to roll back, and a rollback without the sentence
  // would put a raw identifier on a user's screen. RC-1 turned that flag on,
  // which is the moment the deferral named as its own expiry. The repo's rule
  // that a user-visible string leaves with its producer (INJECT_NO_RECEIPT
  // precedent) is now honoured rather than deferred. Neither the constant nor
  // its wire string survives anywhere under lib/ — deliberately not even in
  // this paragraph, because
  // `test/retained_audio_dropped_oldest_retired_test.dart` reads the source
  // and would count a mention as a survival.

  /// The cap is reached: the newest audio is NOT being retained any more.
  ///
  /// ⚠️ Card LS-3 widened when this fires. It used to mean "and there was
  /// nothing older to evict"; under owner ruling O-2 there is never anything
  /// to evict, so this is now the ONLY thing hitting the ceiling does. The
  /// sentence did not have to change — it already said the right thing — but
  /// the reason it is true did.
  static const String codeCapReached = 'retained-audio-cap-reached';

  /// TTL backstop: audio nobody ever claimed (typically an app restart that
  /// orphaned it — the server session it belonged to is long gone) aged out.
  static const String codeExpired = 'retained-audio-expired';

  /// Card LS-2 — a stretch of captured audio was handed to the retention
  /// layer and did not reach the disk (an append threw, or the file grew by
  /// less than we wrote).
  ///
  /// 🔴 A NEW CODE BECAUSE NO EXISTING ONE ANSWERS THIS QUESTION. The three
  /// above are all DECISIONS this layer took — it dropped, it refused, it
  /// expired — and each one's sentence tells the user something about
  /// storage being full. This one is a FAILURE, the disk said no, and
  /// borrowing 'cap-reached' for it would send the user to free up space for
  /// a problem that has nothing to do with space.
  ///
  /// ⚠️ §A9 P1-1 ④ governs the wording: "this stretch has no local copy",
  /// never "nothing has been saved since". The interval after a hole may well
  /// still be being written, and the hole itself may still be recoverable.
  static const String codeWriteFailed = 'retained-audio-write-failed';

  @override
  String toString() =>
      'RetainedAudioNotice($code, segment=$segmentIdx, bytes=$bytes)';
}

/// Filesystem-backed retention for unclaimed capture audio.
///
/// One file per `segment_idx` — the segment is the unit because it is the unit
/// the server already delimits and already guarantees unique
/// (`orchestrator-core.ts`: one server final per `segment_idx`, W2.5-B). This
/// class deliberately does NOT invent a second segmentation scheme (design doc §6).
///
/// ⚠️ Retention policy lives here; the DECISION to spill lives in
/// [RetainedAudioSpill] (retained_audio_spill.dart). Split on purpose: this
/// class knows nothing about the uplink, so its behaviour is testable against a
/// real filesystem with no network concepts in scope.
class RetainedAudioStore {
  /// Subdirectory under the app-support dir. Deliberately NOT `update/` and
  /// NOT `clipboard/` — see the FileProvider note in the header.
  static const String dirName = 'retained_audio';

  static const String _filePrefix = 'seg-';
  static const String _fileSuffix = '.pcm';

  /// 🔴 CR-4 — SEPARATES THE SESSION FROM THE SEGMENT IN A FILE NAME.
  ///
  /// Two underscores because a session key is `[A-Za-z0-9-]` by construction
  /// ([_sanitise]) and therefore cannot contain this, so the split is
  /// unambiguous without escaping.
  static const String _sessionSep = '__';

  /// The session these bytes belong to, when nobody has said.
  ///
  /// 🔴 THE DEFAULT IS PER-RUN, NOT CONSTANT, AND THAT IS THE ENTIRE CR-4 FIX.
  /// The measured defect (§11-d): segment indices restart at 0 every session,
  /// so a previous run that was killed mid-outage left `seg-0.pcm`, and the
  /// NEXT run's segment 0 APPENDED TO IT — 「300 bytes of orphan + 120 bytes of
  /// new audio = one 420-byte file」, which the recovery path would hand over as
  /// one continuous piece of speech. Under CR-3 that orphan is no longer a
  /// one-second tail; it can be a meeting, filed inside somebody else's
  /// article, under a session that was not running at the time.
  ///
  /// A per-run key makes the collision impossible rather than unlikely: two
  /// runs cannot share one, so no append can ever reach another run's bytes.
  /// The TTL sweep still reaps what nobody claims — it always did, and it was
  /// never the thing that was broken.
  static String _defaultSessionKey() =>
      'run-${DateTime.now().microsecondsSinceEpoch}';

  /// The budget for UNRECOVERED audio, and for the WHOLE directory: both
  /// storage faces spend it, and so do orphans left by a previous run.
  /// 16 kHz mono PCM16 is 32,000 B/s (~1.9 MB/min).
  ///
  /// 🔴 512 MiB, SET BY OWNER RULING O-2 (2026-09-06,
  /// docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
  /// threshold.md §Chose 4). The derivation the ruling states:
  ///
  ///   the longest single continuous recording any tier allows is 30 minutes
  ///   (`PLAN_LIMITS.continuous_minutes`, owner 2026-08-29, max tier)
  ///   ⇒ worst case, entirely unrecovered: 30 × 60 × 32,000 = 57.6 MB
  ///   ⇒ 512 MiB = 536.9 MB ≈ NINE such recordings, which is the number the
  ///     ruling names ("≈9 段 30 分钟录音").
  ///
  /// 🔴 WHY IT MOVED FROM 128 MiB, AND WHY THE NUMBER HAD TO GROW WHEN THE
  /// POLICY CHANGED. Under the old policy the cap was a number the store could
  /// always satisfy, because it satisfied it by DELETING the oldest audio in
  /// the directory. Ruling O-2 took that away: unrecovered audio is now exempt
  /// from both the TTL and eviction, so the cap is a hard ceiling on how much
  /// the phone can be holding at once. A ceiling you cannot evict under has to
  /// be big enough that reaching it is a real event and not a Tuesday.
  ///
  /// ⚠️ WHAT HAPPENS ON REACHING IT IS THE OTHER HALF OF THE RULING, and it is
  /// the opposite of what this store used to do: STOP RETAINING NEW BYTES and
  /// say so ([RetainedAudioNotice.codeCapReached]). Never delete older
  /// unrecovered audio to make room — the oldest file is by construction the
  /// one that has been waiting longest to be transcribed, so the old policy
  /// balanced the budget by throwing away exactly the audio this layer exists
  /// to protect (audit item E12, §A5-2).
  ///
  /// 🔴 SO: IF THE TIER CEILING EVER RISES AGAIN, COME BACK HERE. Nothing will
  /// make you — the ceiling is a server-side plan limit and this is a
  /// compile-time constant on a phone that learns its own ceiling at runtime,
  /// so no gate can bind them. `retained_audio_cap_test.dart` pins the
  /// arithmetic against a 30-minute worst case and will go red if this
  /// constant SHRINKS, but it cannot know that 30 became 60. That half is this
  /// sentence.
  ///
  /// ⚠️ The rejected alternative was computing this from the user's own tier.
  /// That would make the retention layer depend on billing, and it has no
  /// business knowing what the user pays — it would also mean a phone that has
  /// not reached the server yet has no cap at all.
  static const int kUnrecoveredCapBytes = 512 * 1024 * 1024;

  /// How long a SETTLED recording may sit before the sweep reclaims it.
  ///
  /// 🔴 CARD LS-3 CHANGED WHAT THIS APPLIES TO, AND THE CHANGE RETIRES THE
  /// 24-HOUR BACKSTOP FOR EVERYTHING THE OLD SWEEP ACTUALLY REACHED.
  /// It used to mean "delete any retained file older than this, whatever it
  /// is". Under owner ruling O-2 the TTL may only take audio whose manifest
  /// says [RecordingManifest.settled] — and a legacy `<session>__seg-N.pcm`
  /// file has no manifest at all, so by definition it is unrecovered and the
  /// sweep never touches it again (§A5-1, audit item E13: a phone that was
  /// offline overnight used to lose the recording it was holding precisely
  /// because it never managed to send it).
  ///
  /// ⚠️ THAT IS A REAL LOSS OF A REAL BACKSTOP AND IT IS ACCEPTED, not
  /// overlooked. What the backstop bought was a bound on orphan audio from a
  /// run that was killed mid-outage; what pays for it now is
  /// [kUnrecoveredCapBytes], which bounds the same bytes by SIZE instead of by
  /// AGE. The ruling chose that trade deliberately: an age bound deletes audio
  /// whose only fault is that nobody has recovered it yet, and a size bound
  /// refuses new audio instead, out loud. Reaching the ceiling degrades the
  /// product visibly; the old backstop degraded it silently, hours later, on a
  /// phone the user had put in a pocket.
  static const Duration kDefaultTtl = Duration(hours: 24);

  final Directory _dir;
  final int _capBytes;
  final Duration _ttl;
  final int Function() _clock;

  final StreamController<RetainedAudioNotice> _notices =
      StreamController<RetainedAudioNotice>.broadcast();

  /// F6 (2026-09-02 audit) — the SAME facts [notices] carries, also held as a
  /// value.
  ///
  /// Before this, the only way to hear about an eviction or a TTL expiry was
  /// a broadcast-stream event, and the store's own header already says
  /// "callers MUST surface these" — but a stream event delivered to no
  /// listener is exactly as gone as one this class never raised, and the
  /// production listener (`retained_audio_boot.dart`) wrote it to the
  /// diagnostics log only. A `ValueListenable` lets a widget bind to "the
  /// most recent retention event" the same way [BackfillRunner.progress] is
  /// already read by the article/composer UI, with no risk of a listener
  /// attaching a beat too late and missing the one event that mattered.
  ///
  /// ⚠️ STILL A MECHANISM, NOT YET A SCREEN. Wiring this into an on-screen
  /// notice belongs to whoever owns the banner-queue plumbing
  /// (`session/chat_notices.dart`, `ui/banner_queue.dart`) — outside this
  /// file's reach. What was missing was never a way to LISTEN; both
  /// [notices] and this existed in spirit already. What is added here is the
  /// localised sentence for each code ([RecordingStrings
  /// .retainedAudioNoticeMessage]) and a value a UI layer can bind to without
  /// first subscribing to a stream — the two pieces a future caller needs
  /// and did not have.
  final ValueNotifier<RetainedAudioNotice?> lastNotice =
      ValueNotifier<RetainedAudioNotice?>(null);

  /// Running total, seeded by [open] and maintained on every mutation so the
  /// cap check does not stat the directory on every 200 ms chunk.
  int _retainedBytes = 0;

  /// Which session the unqualified reads and writes below are about.
  ///
  /// ⚠️ A CURSOR, NOT A SCOPE. [pendingSessions] / the `session:` parameters
  /// deliberately reach past it, because recovery's whole job is to look at
  /// audio this run did not capture. What the cursor buys is that the WRITE
  /// path — the 200 ms hot loop — never has to be told, and so can never be
  /// told wrongly.
  String _session = _defaultSessionKey();

  /// The session key writes are currently filed under.
  String get sessionKey => _session;

  /// Bytes retained for the CURRENT session, counted as they were written.
  ///
  /// 🔴 IN MEMORY, AND THAT IS THE POINT. The same number can be read off the
  /// disk ([bytesForSession]) and that read LOSES A RACE: the recovery
  /// channel begins deleting a stretch the moment it has transcribed it, so a
  /// reader that arrives afterwards measures a gap that has already been
  /// partly reclaimed and reports it as shorter than it was. Measured, not
  /// reasoned about — the C3 acceptance failed on exactly that, reporting a
  /// 45-second outage as 0.
  ///
  /// The article clock needs 「how long was the gap」 and needs it to be a
  /// property of the audio, not of when it happened to ask.
  ///
  /// ⚠️ Counts APPENDS, so it excludes anything a previous run left behind
  /// and anything the cap dropped. Both exclusions are correct for its one
  /// caller: it answers 「how much did THIS recording retain」.
  int get sessionRetainedBytes => _sessionBytes;
  int _sessionBytes = 0;

  /// Segments already announced via [RetainedAudioNotice.codeCapReached], so a
  /// full store does not emit one notice per chunk. Cleared when space frees.
  final Set<int> _capAnnounced = <int>{};

  bool _closed = false;

  RetainedAudioStore({
    required Directory dir,
    int capBytes = kUnrecoveredCapBytes,
    Duration ttl = kDefaultTtl,
    int Function()? clock,
  })  : _dir = dir,
        _capBytes = capBytes,
        _ttl = ttl,
        _clock = clock ?? _wallClock {
    if (capBytes <= 0) {
      throw ArgumentError.value(capBytes, 'capBytes', 'cap must be > 0');
    }
  }

  static int _wallClock() => DateTime.now().millisecondsSinceEpoch;

  /// Retention notices. Callers MUST surface these; see the class header.
  Stream<RetainedAudioNotice> get notices => _notices.stream;

  /// Bytes currently retained on disk.
  int get retainedBytes => _retainedBytes;

  /// The budget, so the other storage face can spend the SAME one.
  ///
  /// 🔴 Card LS-2 gave this layer a second writer (the per-recording journal
  /// in `retained_audio_spill.dart`). Two writers with two budgets is two
  /// answers to "how much may this directory hold", and owner ruling O-2 set
  /// one number. Exposing the number is how the journal asks it rather than
  /// carrying a copy.
  int get capBytes => _capBytes;

  /// Where the files live. Read by the journal face so both layouts land in
  /// one directory and one listing (LS-3's sweep walks both).
  String get dirPath => _dir.path;

  /// Announce something this store did not itself do.
  ///
  /// 🔴 CARD LS-2 — THE MERGE, AND WHY IT IS A METHOD RATHER THAN A SECOND
  /// STREAM. Write failures happen OUTSIDE this class: the store never
  /// returned, so it never got the chance to announce anything, and the spill
  /// grew its own `writeFailures` channel with a comment saying the merge was
  /// later work. That later work is here. [lastNotice] is the value
  /// `onRetainedAudioNoticeRouted` (session/chat_notices.dart) already binds
  /// to, so a fact that reaches it
  /// reaches the screen; a fact that stops at a second broadcast stream is as
  /// gone as one nobody raised.
  ///
  /// ⚠️ Callers are the retention layer itself (spill + journal). It is not a
  /// public address for arbitrary code to put sentences on the user's screen.
  void announce(RetainedAudioNotice notice) => _announce(notice);

  /// Create the directory if needed and seed [retainedBytes] from what is
  /// already there. Safe to call more than once.
  Future<void> open() async {
    if (!await _dir.exists()) {
      await _dir.create(recursive: true);
    }
    _retainedBytes = 0;
    for (final File f in await _segmentFiles()) {
      _retainedBytes += await f.length();
    }
  }

  /// 🔴 CR-4 — file everything from here on under [key].
  ///
  /// Called by `beginContinuous` with the ARTICLE ID, so one string names 「which
  /// recording」 for the rows and for the bytes. That identity is what lets the
  /// re-transcription channel (CR-5) answer 「which article do these bytes belong
  /// to」 without a second table — §11-d's conclusion was that the missing thing
  /// was never a state ledger, it was an identity.
  ///
  /// ⚠️ Sanitised, not validated: a key that reached the filesystem with a
  /// separator in it would silently write outside this directory. Refusing
  /// instead would mean an unusable key stops a recording, and losing the
  /// user's audio is worse than filing it under a squashed name.
  void beginSession(String key) {
    final String k = _sanitise(key);
    if (k.isEmpty) return;
    _session = k;
    _sessionBytes = 0;
  }

  /// Go back to a fresh per-run key.
  ///
  /// NOT 「back to the previous key」, which would need a stack and would mean a
  /// missed `endSession` silently re-files later audio under an old recording.
  /// A fresh key can only ever be wrong in the harmless direction: bytes filed
  /// under a session nobody will claim, which the TTL sweep already handles.
  void endSession() {
    _session = _defaultSessionKey();
    _sessionBytes = 0;
  }

  /// 🔴 CARD LS-4 (owner ruling O-5) — mark [session] cancelled: keep every
  /// byte, and never list it as pending again.
  ///
  /// CALLER: `RetainedAudioSpill.tombstoneCurrentRecording`, reached only from
  /// `AudioCapture.fenceAndStop(reason: JournalInterrupt.cancelled)` — i.e.
  /// `PttSession.pttCancel`, the swipe-up. Body in
  /// retained_audio_tombstone.dart.
  Future<void> tombstoneSession({String? session}) =>
      _writeTombstone(this, session);

  /// Session keys carrying a tombstone. Exposed because the assertion that
  /// matters (「this session is not pending AND its bytes are still here」) needs
  /// to be able to name the marker rather than infer it from an absence.
  Future<Set<String>> tombstonedSessions() => _readTombstones(this);

  /// Every session key with retained bytes on disk, including this run's and
  /// every previous run's orphans, MINUS the ones the user cancelled.
  /// Recovery's entry point.
  ///
  /// 🔴 THE SUBTRACTION IS CARD LS-4. `BackfillRunner.sweep` walks exactly
  /// this list (grep `pendingSessions` in session/backfill_runner.dart), so
  /// filtering HERE is what
  /// makes 「永不自动转」 true for every recovery edge at once, including the
  /// ones that do not exist yet.
  ///
  /// ⚠️ [bytesForSession] deliberately does NOT filter: the cap counts these
  /// bytes and the ruling keeps them, so 「how much is on disk」 stays true.
  Future<List<String>> pendingSessions() async {
    final Set<String> tombstoned = await _readTombstones(this);
    final Set<String> out = <String>{};
    for (final File f in await _segmentFiles()) {
      final String? s = _sessionOf(f);
      if (s != null && !tombstoned.contains(s)) out.add(s);
    }
    final List<String> keys = out.toList()..sort();
    return keys;
  }

  /// Retained bytes for one whole session, or 0.
  Future<int> bytesForSession(String session) async {
    int total = 0;
    for (final File f in await _segmentFiles()) {
      if (_sessionOf(f) == _sanitise(session)) total += await f.length();
    }
    return total;
  }

  /// Append captured PCM for [segmentIdx]. Returns whether the bytes were
  /// retained; a `false` return has ALWAYS been announced on [notices] first —
  /// this method never drops quietly.
  Future<bool> append({
    required int segmentIdx,
    required Uint8List bytes,
  }) async {
    if (_closed || bytes.isEmpty) return false;
    // 🔴 CARD LS-3 / OWNER RULING O-2 — THERE IS NO `_makeRoomFor` CALL HERE
    // ANY MORE, AND ITS ABSENCE IS THE POLICY.
    // What stood on this line evicted the oldest file in the directory to fit
    // the incoming write. The oldest file is, by construction, the audio that
    // has been waiting longest to be transcribed — so the budget was balanced
    // by deleting exactly what this layer exists to protect (audit item E12).
    // The ruling replaces "make room" with "stop promising": refuse the new
    // bytes, say so, and leave every unrecovered byte where it is. The
    // eviction function is gone from retained_audio_policy.dart entirely
    // rather than left behind a flag, because a deletion path that still
    // compiles is a deletion path somebody will call.
    if (_retainedBytes + bytes.length > _capBytes) {
      // Refuse LOUDLY. Note what this no longer means: it is not "nothing
      // older was left to give up", it is "we do not give anything up".
      if (_capAnnounced.add(segmentIdx)) {
        _announce(RetainedAudioNotice(
          code: RetainedAudioNotice.codeCapReached,
          segmentIdx: segmentIdx,
          bytes: _retainedBytes,
        ));
      }
      return false;
    }
    final File f = _fileFor(segmentIdx);
    await f.writeAsBytes(bytes, mode: FileMode.append, flush: false);
    _retainedBytes += bytes.length;
    _sessionBytes += bytes.length;
    return true;
  }

  /// 🔴 J6 — the segment settled (its final arrived and its row was minted), so
  /// its audio has no reason to exist. Delete NOW. This is the boundary
  /// mechanism, not a cleanup nicety.
  Future<void> settle(int segmentIdx, {String? session}) async {
    final File f = _fileFor(segmentIdx, session: session);
    if (!await f.exists()) {
      _capAnnounced.remove(segmentIdx);
      return;
    }
    final int len = await f.length();
    await f.delete();
    _retainedBytes = (_retainedBytes - len).clamp(0, 1 << 62);
    _capAnnounced.remove(segmentIdx);
  }

  /// Segment indices with retained audio, ascending — i.e. the segments whose
  /// audio no final has claimed. Recovery feeds them back IN THIS ORDER.
  ///
  /// Scoped to [session], defaulting to the one writes are going to. Recovery
  /// names a session explicitly, because the audio it cares about is usually
  /// somebody else's — a previous run that was killed mid-outage.
  /// 🔴 Card LS-4: a tombstoned session has NO pending segments, however
  /// many files it has. BOTH readers are filtered — this one is reachable with
  /// an explicit key by anyone holding a session name from before the cancel,
  /// and filtering only the outer one is a door locked from one side.
  Future<List<int>> pendingSegments({String? session}) async {
    final String want = _sanitise(session ?? _session);
    if ((await _readTombstones(this)).contains(want)) return const <int>[];
    final List<int> out = <int>[];
    for (final File f in await _segmentFiles()) {
      if (_sessionOf(f) != want) continue;
      final int? idx = _indexOf(f);
      if (idx != null) out.add(idx);
    }
    out.sort();
    return out;
  }

  /// Retained bytes for one segment, or null when nothing is retained.
  Future<Uint8List?> read(int segmentIdx, {String? session}) async {
    final File f = _fileFor(segmentIdx, session: session);
    if (!await f.exists()) return null;
    return f.readAsBytes();
  }

  /// TTL sweep. Card LS-3: it may only take a recording whose manifest says
  /// [RecordingManifest.settled], which no legacy segment file has and nothing
  /// writes yet — see [kDefaultTtl] and the body in retained_audio_policy.dart
  /// for what that retires and what pays for it.
  Future<void> sweep() => _sweep(this);

  /// Drop everything. Used by teardown paths that know no segment can ever be
  /// claimed again; still announces, because bytes we said we were holding do
  /// not get to vanish quietly. Body moved to retained_audio_policy.dart
  /// alongside [sweep].
  Future<void> dropAll() => _dropAllFiles(this);

  Future<void> dispose() async {
    _closed = true;
    lastNotice.dispose();
    await _notices.close();
  }

  // --------------------------------------------------------------- internals

  void _announce(RetainedAudioNotice n) {
    debugPrint('[flowmic.audio] retained-audio: $n');
    lastNotice.value = n;
    if (!_notices.isClosed) _notices.add(n);
  }

  File _fileFor(int segmentIdx, {String? session}) =>
      File('${_dir.path}${Platform.pathSeparator}'
          '${_sanitise(session ?? _session)}$_sessionSep'
          '$_filePrefix$segmentIdx$_fileSuffix');

  /// Card LS-4 — where a session's tombstone lives. [key] must already be
  /// sanitised (its one caller sanitises).
  File _tombstoneFileFor(String key) =>
      File('${_dir.path}${Platform.pathSeparator}'
          '$key$_sessionSep$_tombstoneSuffix');

  /// `[A-Za-z0-9-]` only. See [beginSession] for why this squashes rather than
  /// refuses.
  static String _sanitise(String key) =>
      key.replaceAll(RegExp(r'[^A-Za-z0-9-]'), '-');

  /// The session a retained file belongs to, or null when the name is not one
  /// of ours.
  ///
  /// ⚠️ A file with NO session part is not adopted into the current session —
  /// it is not recognised at all, so it is not read, not evicted and not swept.
  /// That shape can only come from a build older than CR-4, and the honest
  /// answer for it is 「we do not know whose this is」. Claiming it would be the
  /// exact cross-filing this card exists to stop, done deliberately.
  String? _sessionOf(File f) {
    final String name = f.uri.pathSegments.last;
    final int i = name.indexOf(_sessionSep);
    if (i <= 0) return null;
    return name.substring(0, i);
  }

  /// Journal manifests in this directory (card LS-3's sweep input).
  ///
  /// ⚠️ Deliberately a DIFFERENT listing from [_segmentFiles], not a filter on
  /// it: the two layouts answer different questions, and a single walk that
  /// returned both would invite a caller to treat "a file here" as one kind of
  /// thing. A legacy segment file has no manifest and is never in this list —
  /// which is exactly why the sweep cannot reach it.
  Future<List<File>> _manifestFiles() async {
    if (!await _dir.exists()) return const <File>[];
    final List<File> out = <File>[];
    try {
      await for (final FileSystemEntity e in _dir.list(followLinks: false)) {
        if (e is File &&
            e.path.endsWith(RetainedAudioJournal.manifestSuffix)) {
          out.add(e);
        }
      }
    } on FileSystemException {
      // Same reasoning as [_segmentFiles]: the directory went away under the
      // listing, and "there is nothing here" is both the honest answer and the
      // safe one.
      return const <File>[];
    }
    out.sort((File a, File b) => a.path.compareTo(b.path));
    return out;
  }

  /// Where a journal recording's PCM lives, given its id.
  String _pcmPathFor(String recordingId) =>
      '${_dir.path}${Platform.pathSeparator}'
      '$recordingId${RetainedAudioJournal.pcmSuffix}';

  Future<List<File>> _segmentFiles() async {
    if (!await _dir.exists()) return const <File>[];
    final List<File> out = <File>[];
    try {
      await for (final FileSystemEntity e in _dir.list(followLinks: false)) {
        if (e is File && _indexOf(e) != null) out.add(e);
      }
    } on FileSystemException {
      // The directory went away UNDER the listing. It is app-support storage, so
      // this is the OS reclaiming space, a user clearing app data, or a teardown
      // racing a sweep — none of which is an error this layer can act on, and
      // all of which mean the same thing: there is no retained audio now.
      //
      // Returning empty is the honest answer AND the safe one: every caller
      // treats empty as 「nothing owed」, and nothing here reports success for
      // audio that is gone. The alternative — letting it throw — takes down a
      // recovery sweep over a directory that no longer has anything in it.
      return const <File>[];
    }
    return out;
  }

  int? _indexOf(File f) {
    final String full = f.uri.pathSegments.last;
    final int sep = full.indexOf(_sessionSep);
    if (sep <= 0) return null;
    final String name = full.substring(sep + _sessionSep.length);
    if (!name.startsWith(_filePrefix) || !name.endsWith(_fileSuffix)) {
      return null;
    }
    return int.tryParse(
      name.substring(_filePrefix.length, name.length - _fileSuffix.length),
    );
  }
}
