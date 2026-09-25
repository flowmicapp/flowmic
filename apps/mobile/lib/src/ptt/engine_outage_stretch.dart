// Card RC-3b — WHERE A LONG RECORDING'S ENGINE OUTAGE BEGAN, IN CAPTURED BYTES.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3 `stt:engine-status` row (RC-3b note:
//     `replayed_ms` on the `ready` that ends a reconnect)
//   apps/mobile/lib/src/ptt/ptt_capture_pump.dart `_noteEngineStatusForArticle`
//     (the one writer and the one reader)
//
// The relay says 「the engine is gone」 (`reconnecting`) and, later, 「it is back,
// and I re-fed it this much of what you sent meanwhile」 (`ready.replayed_ms`).
// The difference between the two is audio no engine heard, and only this phone
// still has it. Measuring that difference needs the capture position at the
// FIRST of those two frames, kept until the second: that is all this holds.
//
// ⚠️ Separate from `EngineReconnectState` on purpose. That object answers
// 「is the relay re-dialling, which attempt」 for the screens and clears on
// `failed`, on the watchdog and on an interim; the start of the outage has to
// survive all three (an interim can land before `ready`, and `failed` is followed
// by the owed-tail path, which measures from the article clock instead).

import '../audio/audio_capture.dart' show kChunkBytes;

/// Card RC-L — how far an owed stretch reaches past each of its ends
/// (root cause §8 RC-L: 「再提前 ≤1 s」 / 「+ ≤1 s」): a range cut in the middle of
/// a word loses that word on both sides of the cut.
const int kOwedEdgeMs = 1000;

/// Card RC6 (F3) — the shortest hole (after `replayed_ms` is subtracted, before
/// the [kOwedEdgeMs] edges) that is owed at all.
///
/// A replay that starts exactly where the dead leg answered still reads as a
/// small hole here, because the two ends are read on two clocks: the relay
/// computes `replayed_ms` when it SENDS `ready`, the phone reads how much it had
/// captured when the frame ARRIVES. The difference is at most the chunk being
/// captured plus the one on the uplink (one `kChunkBytes` frame each, 200 ms)
/// and the frame's own trip down; and a hole inherits the word-cut margin of
/// [kOwedEdgeMs] as well: 1000 + 2 × 200 + 100 = 1500 ms. Measured
/// on the device (CR-12-E re-check 5, lf): a 1.4 s phantom, owed as 3.4 s of
/// silence and kept as 「完整性待校验」 for good.
const int kMinOwedHoleMs = kOwedEdgeMs + 2 * _kChunkMs + _kDownlinkAllowanceMs;
const int _kChunkMs = kChunkBytes ~/ 32; // AudioCapture's frame: 6400 bytes of 16 kHz mono PCM16 = 200 ms
const int _kDownlinkAllowanceMs = 100;

/// The capture position at the start of the current engine outage of one
/// article, or nothing.
class EngineOutageStretch {
  String? _articleId;
  int? _startBytes;

  /// Card RC-L (phone half) — how far the relay had ANSWERED when the outage
  /// began, as a capture position. See [noteAnswered].
  int? _answeredAtDownBytes;

  // Card RC-L — the last chunk put on the wire (its `ts_ms` clock end, and the
  // capture position it ends at) and the last answered position, per article.
  String? _chunkArticleId;
  int _chunkBytes = 0;
  int? _chunkEndTsMs;
  String? _answeredArticleId;
  int? _answeredBytes;

  /// Card RC-L — a chunk of [articleId] went on the wire: [tsMs] as stamped,
  /// [bytes] long, with the recording [capturedBytes] in when it went. Pairs
  /// the chunk clock — the clock `stt:interim.acked_audio_ms` answers in — with
  /// a capture position.
  void noteChunk({
    required String articleId,
    required int tsMs,
    required int bytes,
    required int capturedBytes,
  }) {
    _chunkArticleId = articleId;
    _chunkBytes = capturedBytes;
    // 32 bytes per ms of PCM16 / 16 kHz mono (`kPcmBytesPerSecond`).
    _chunkEndTsMs = tsMs + bytes ~/ 32;
  }

  /// Card RC-L — an interim said the relay has answered up to [ackedMs] of our
  /// chunk clock. Converted to a capture position NOW, while the last chunk's
  /// clock is at hand: position = captured − (sent end − acked).
  void noteAnswered({required String articleId, required int ackedMs}) {
    final int? at = positionOf(articleId: articleId, tsMs: ackedMs);
    if (at == null) return;
    _answeredArticleId = articleId;
    _answeredBytes = at;
  }

  /// A point [tsMs] on [articleId]'s chunk clock, as a capture position — the
  /// conversion [noteAnswered] makes, shared with card RC4-S5's
  /// `unheard_from_ms` (`ptt_unheard_tail.dart`). Null when no chunk of that
  /// article went on the wire. A point past the last chunk's end reads as that
  /// end (nothing was captured beyond it).
  int? positionOf({required String articleId, required int tsMs}) {
    final int? end = _chunkEndTsMs;
    if (_chunkArticleId != articleId || end == null) return null;
    final int behind = end - tsMs;
    final int at = _chunkBytes - (behind > 0 ? behind * 32 : 0);
    return at < 0 ? 0 : at;
  }

  /// Card RC-L / RC-P — the capture position the relay last answered up to for
  /// [articleId], or null when it never said (an engine that reports no
  /// position, or a relay older than RC-2).
  int? answeredBytes(String articleId) =>
      _answeredArticleId == articleId ? _answeredBytes : null;

  /// A `reconnecting` frame for [articleId], [capturedBytes] into the
  /// recording. Only the FIRST frame of an outage is its start; later rungs
  /// repeat the frame and must not move it.
  void noteDown({required String articleId, required int capturedBytes}) {
    if (_articleId == articleId && _startBytes != null) return;
    _articleId = articleId;
    _startBytes = capturedBytes;
    _answeredAtDownBytes = answeredBytes(articleId);
  }

  /// Card RC-L — what [noteDown] saw answered when the current outage of
  /// [articleId] began. Read before [takeStart], which forgets the outage.
  int? answeredAtDown(String articleId) =>
      _articleId == articleId ? _answeredAtDownBytes : null;

  /// The outage of [articleId] is over (its `ready` arrived): its start, and
  /// forget it. Null when no outage of THAT article was open — an outage of an
  /// earlier recording is dropped here rather than measured against this one.
  int? takeStart(String articleId) {
    final int? start = _articleId == articleId ? _startBytes : null;
    _articleId = null;
    _startBytes = null;
    _answeredAtDownBytes = null;
    return start;
  }
}
