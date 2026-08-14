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

  /// Total retained bytes across all segments. 16 kHz mono PCM16 is ~32 KB/s
  /// (~1.9 MB/min), so this is ~34 minutes of fully-offline capture. It is a
  /// bound on a pathological case, not a budget anyone is expected to reach:
  /// the ordinary lifetime of a file here is seconds, because [settle] deletes
  /// it the moment the segment is transcribed.
  static const int kDefaultCapBytes = 64 * 1024 * 1024;

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
    return true;
  }

  /// 🔴 J6 — the segment settled (its final arrived and its row was minted), so
  /// its audio has no reason to exist. Delete NOW. This is the boundary
  /// mechanism, not a cleanup nicety.
  Future<void> settle(int segmentIdx) async {
    final File f = _fileFor(segmentIdx);
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
  Future<List<int>> pendingSegments() async {
    final List<int> out = <int>[];
    for (final File f in await _segmentFiles()) {
      final int? idx = _indexOf(f);
      if (idx != null) out.add(idx);
    }
    out.sort();
    return out;
  }

  /// Retained bytes for one segment, or null when nothing is retained.
  Future<Uint8List?> read(int segmentIdx) async {
    final File f = _fileFor(segmentIdx);
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
    final List<int> pending = await pendingSegments();
    for (final int idx in pending) {
      if (_retainedBytes + incoming <= _capBytes) break;
      if (idx == keeping) continue;
      final File f = _fileFor(idx);
      if (!await f.exists()) continue;
      final int len = await f.length();
      await f.delete();
      _retainedBytes = (_retainedBytes - len).clamp(0, 1 << 62);
      _capAnnounced.remove(idx);
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

  File _fileFor(int segmentIdx) =>
      File('${_dir.path}${Platform.pathSeparator}'
          '$_filePrefix$segmentIdx$_fileSuffix');

  Future<List<File>> _segmentFiles() async {
    if (!await _dir.exists()) return const <File>[];
    final List<File> out = <File>[];
    await for (final FileSystemEntity e in _dir.list(followLinks: false)) {
      if (e is File && _indexOf(e) != null) out.add(e);
    }
    return out;
  }

  int? _indexOf(File f) {
    final String name = f.uri.pathSegments.last;
    if (!name.startsWith(_filePrefix) || !name.endsWith(_fileSuffix)) {
      return null;
    }
    return int.tryParse(
      name.substring(_filePrefix.length, name.length - _fileSuffix.length),
    );
  }
}
