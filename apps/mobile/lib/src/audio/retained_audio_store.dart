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

  /// Cap hit: the OLDEST retained segment was discarded to make room.
  static const String codeDroppedOldest = 'retained-audio-dropped-oldest';

  /// Cap hit with nothing older to give up: the newest audio is NOT being
  /// retained any more. Distinct from [codeDroppedOldest] because the two ask
  /// for opposite things — one lost the beginning, this one loses the end.
  static const String codeCapReached = 'retained-audio-cap-reached';

  /// TTL backstop: audio nobody ever claimed (typically an app restart that
  /// orphaned it — the server session it belonged to is long gone) aged out.
  static const String codeExpired = 'retained-audio-expired';

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

  /// Total retained bytes across all segments — the budget for the WHOLE
  /// directory, shared with orphans from a previous run and with residue whose
  /// TTL has not expired. 16 kHz mono PCM16 is 32,000 B/s (~1.9 MB/min).
  ///
  /// 🔴 THIS NUMBER IS DERIVED, AND HERE IS THE DERIVATION — because the thing
  /// it is derived FROM lives on the server and cannot reach into this file.
  ///
  ///   the longest single continuous recording any tier allows is 30 minutes
  ///   (`PLAN_LIMITS.continuous_minutes`, owner 2026-08-29, max tier)
  ///   ⇒ worst case, entirely offline: 30 × 60 × 32,000 = 57.6 MB
  ///   ⇒ this cap is 128 MiB = 134.2 MB ≈ 2.3× that, i.e. the pathological
  ///     session fits in 43% and the rest is headroom for orphans and TTL
  ///     residue.
  ///
  /// ⚠️ IT WAS 64 MiB AND THAT HAD STOPPED BEING ENOUGH. Under the old 15-minute
  /// ceiling the worst case was 28.8 MB against 67.1 MB — comfortable. Ruling ⑬
  /// doubled the ceiling to 30 minutes and the same number became 86% of the
  /// budget, leaving ~9 MiB of margin: one directory of orphans the sweep had
  /// not reached yet could evict a live recording's audio.
  ///
  /// 🔴 SO: IF THE TIER CEILING EVER RISES AGAIN, COME BACK HERE. Nothing will
  /// make you — the ceiling is a server-side plan limit and this is a
  /// compile-time constant on a phone that learns its own ceiling at runtime,
  /// so no gate can bind them. `retained_audio_cap_test.dart` pins the
  /// arithmetic against a 30-minute worst case and will go red if this constant
  /// SHRINKS, but it cannot know that 30 became 60. That half is this sentence.
  ///
  /// ⚠️ The behaviour on hitting the cap is unchanged and must stay unchanged:
  /// drop the OLDEST and say so (`codeCapReached`). Never silently.
  ///
  /// It remains a bound on a pathological case rather than a budget anyone is
  /// expected to reach: the ordinary lifetime of a file here is seconds,
  /// because [settle] deletes it the moment the segment is transcribed.
  ///
  /// ⚠️ The rejected alternative was computing this from the user's own tier.
  /// That would make the retention layer depend on billing, and it has no
  /// business knowing what the user pays — it would also mean a phone that has
  /// not reached the server yet has no cap at all.
  static const int kDefaultCapBytes = 128 * 1024 * 1024;

  /// Backstop only. The real expiry is settle⇒delete; this catches audio that
  /// can never be claimed because the session that owned it no longer exists
  /// (app killed mid-outage). Long enough that a phone left in a pocket
  /// overnight during an outage still recovers in the morning.
  static const Duration kDefaultTtl = Duration(hours: 24);

  final Directory _dir;
  final int _capBytes;
  final Duration _ttl;
  final int Function() _clock;

  final StreamController<RetainedAudioNotice> _notices =
      StreamController<RetainedAudioNotice>.broadcast();

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
    int capBytes = kDefaultCapBytes,
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

  /// Every session key with retained bytes on disk, including this run's and
  /// every previous run's orphans. Recovery's entry point.
  Future<List<String>> pendingSessions() async {
    final Set<String> out = <String>{};
    for (final File f in await _segmentFiles()) {
      final String? s = _sessionOf(f);
      if (s != null) out.add(s);
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
    await _makeRoomFor(bytes.length, keeping: segmentIdx);
    if (_retainedBytes + bytes.length > _capBytes) {
      // Nothing left to give up: the only remaining candidate is the segment we
      // are being asked to grow. Refuse LOUDLY rather than throw away the
      // beginning of the very utterance we are trying to preserve.
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
  Future<List<int>> pendingSegments({String? session}) async {
    final String want = _sanitise(session ?? _session);
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

  /// TTL backstop sweep. Anything older than the TTL is announced and removed.
  Future<void> sweep() async {
    final int now = _clock();
    for (final File f in await _segmentFiles()) {
      final FileStat st = await f.stat();
      if (now - st.modified.millisecondsSinceEpoch < _ttl.inMilliseconds) {
        continue;
      }
      final int len = await f.length();
      final int? idx = _indexOf(f);
      await f.delete();
      _retainedBytes = (_retainedBytes - len).clamp(0, 1 << 62);
      if (idx != null) _capAnnounced.remove(idx);
      _announce(RetainedAudioNotice(
        code: RetainedAudioNotice.codeExpired,
        segmentIdx: idx,
        bytes: len,
      ));
    }
  }

  /// Drop everything. Used by teardown paths that know no segment can ever be
  /// claimed again; still announces, because bytes we said we were holding do
  /// not get to vanish quietly.
  Future<void> dropAll() async {
    for (final File f in await _segmentFiles()) {
      final int len = await f.length();
      final int? idx = _indexOf(f);
      await f.delete();
      _announce(RetainedAudioNotice(
        code: RetainedAudioNotice.codeExpired,
        segmentIdx: idx,
        bytes: len,
      ));
    }
    _retainedBytes = 0;
    _capAnnounced.clear();
  }

  Future<void> dispose() async {
    _closed = true;
    await _notices.close();
  }

  // --------------------------------------------------------------- internals

  /// Evict oldest segments (never [keeping]) until [incoming] bytes fit.
  Future<void> _makeRoomFor(int incoming, {required int keeping}) async {
    if (_retainedBytes + incoming <= _capBytes) return;
    // 🔴 EVICTION IS DIRECTORY-WIDE, NOT SESSION-SCOPED, and that is deliberate.
    // The cap is a budget for the WHOLE directory (see [kDefaultCapBytes]), so
    // a run that is about to overflow it must be able to give up a previous
    // run's orphans — which are, by definition, the oldest and the least
    // claimable audio here. Scoping eviction to this session would leave the
    // cap unreachable-in-practice and then refuse a LIVE recording's bytes
    // while megabytes of abandoned audio sat next to it.
    //
    // ⚠️ `keeping` still protects only THIS session's segment: an index from
    // another session is a different file and is fair game.
    final List<_RetainedFile> pending = await _allRetained();
    for (final _RetainedFile r in pending) {
      if (_retainedBytes + incoming <= _capBytes) break;
      if (r.session == _session && r.idx == keeping) continue;
      final int idx = r.idx;
      final File f = r.file;
      if (!await f.exists()) continue;
      final int len = await f.length();
      await f.delete();
      _retainedBytes = (_retainedBytes - len).clamp(0, 1 << 62);
      if (r.session == _session) _capAnnounced.remove(idx);
      // 🔴 Cap hit ⇒ say so. Silent dropping is a red-line violation.
      _announce(RetainedAudioNotice(
        code: RetainedAudioNotice.codeDroppedOldest,
        segmentIdx: idx,
        bytes: len,
      ));
    }
  }

  void _announce(RetainedAudioNotice n) {
    debugPrint('[flowmic.audio] retained-audio: $n');
    if (!_notices.isClosed) _notices.add(n);
  }

  File _fileFor(int segmentIdx, {String? session}) =>
      File('${_dir.path}${Platform.pathSeparator}'
          '${_sanitise(session ?? _session)}$_sessionSep'
          '$_filePrefix$segmentIdx$_fileSuffix');

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

  /// Everything retained, oldest segment first within oldest session first.
  Future<List<_RetainedFile>> _allRetained() async {
    final List<_RetainedFile> out = <_RetainedFile>[];
    for (final File f in await _segmentFiles()) {
      final String? s = _sessionOf(f);
      final int? idx = _indexOf(f);
      if (s == null || idx == null) continue;
      out.add(_RetainedFile(session: s, idx: idx, file: f));
    }
    out.sort((_RetainedFile a, _RetainedFile b) {
      // Another session's audio goes FIRST: this run's live recording is the
      // one thing here that somebody is still speaking into.
      final bool aMine = a.session == _session;
      final bool bMine = b.session == _session;
      if (aMine != bMine) return aMine ? 1 : -1;
      final int bySession = a.session.compareTo(b.session);
      return bySession != 0 ? bySession : a.idx.compareTo(b.idx);
    });
    return out;
  }

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

/// One retained file, with both halves of its key already parsed.
@immutable
class _RetainedFile {
  const _RetainedFile({
    required this.session,
    required this.idx,
    required this.file,
  });
  final String session;
  final int idx;
  final File file;
}
