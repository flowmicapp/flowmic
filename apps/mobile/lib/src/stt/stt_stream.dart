// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §3 (stt:interim / stt:final carry
//     segment_idx + is_segment; SegmentBuffer assembly)
//   packages/protocol/src/protocol-schemas-audio.ts (SttInterimSchema /
//     SttFinalSchema / SttLevelSchema)
//   R2/R3 task card WP-R3-1: "this card stops at the data-layer stream" — the display binding is
//     WP-R3-2's job; this exposes the typed interim/final/level streams only.
//
// Typed inbound STT payloads + the data-layer streams the chat-flow UI (WP-R3-2)
// will bind to. No widgets here: this is the seam between the socket event loop
// and the presentation layer.

import 'dart:async';

/// stt:interim — SttInterimSchema.
class SttInterim {
  final String text;
  final double confidence;
  final String language;
  final int segmentIdx;
  const SttInterim({
    required this.text,
    required this.confidence,
    required this.language,
    required this.segmentIdx,
  });

  static SttInterim? tryFromJson(Map<String, Object?> j) {
    final Object? text = j['text'];
    final Object? idx = j['segment_idx'];
    if (text is! String || idx is! int) return null;
    return SttInterim(
      text: text,
      confidence: (j['confidence'] as num?)?.toDouble() ?? 0.0,
      language: j['language'] is String ? j['language'] as String : '',
      segmentIdx: idx,
    );
  }
}

/// Wire values for stt:final.polish (WP-R4-6 ②). Absence on the wire ⇔ polish
/// was not enabled for the session; mobile never invents a default.
enum SttPolish { applied, skipped }

/// Frozen polish_reason values when [SttPolish.skipped] (WP-R4-6 ②).
const Set<String> kSttPolishReasons = <String>{
  'timeout',
  'llm_error',
  'empty_output',
  'guard_reject',
};

/// stt:final — SttFinalSchema. [isSegment] true = a soft-segment boundary
/// (more to come); false = the terminal final that closes the utterance and
/// drives the FSM PROCESSING → JUST_DONE transition.
///
/// WP-R4-6 ②/⑦: optional [polish] / [polishReason] are the honest-signal face
/// for opt-in stt.polish — parsed here, surfaced transiently by ChatController
/// (never written into timeline schema / status five-state).
class SttFinal {
  final String text;
  final double confidence;
  final String language;
  final int segmentIdx;
  final bool isSegment;
  final int durationMs;
  final SttPolish? polish;
  final String? polishReason;

  /// D7 (2026-09-03) — the server-minted id of the utterance this final
  /// belongs to (additive optional on the wire; an older relay strips it and
  /// this reads null). Stored on the row the terminal final builds so a later
  /// [SttRefined] carrying the same id can find it.
  final String? utteranceId;

  /// Card EMPTY-1 (2026-09-04) — WHY this final carries no text, verbatim off
  /// the wire (`stt:final.empty_reason`). Null on every final that HAS text, on
  /// every recording whose emptiness an `stt:error` already explained, and on
  /// every server that predates the card — so null keeps the pre-card behaviour
  /// exactly (the phone's own 「no speech was heard」 sentence).
  ///
  /// 🔴 KEPT AS A RAW STRING, deliberately NOT parsed into a Dart enum. A second
  /// hand-maintained mirror of a server-side domain is the thing nothing binds
  /// (the open account behind the 0.2.53 defect); the copy table decides what it
  /// recognises, and an unrecognised value gets the generic sentence plus this
  /// token rather than a sentence invented for it.
  final String? emptyReason;
  const SttFinal({
    required this.text,
    required this.confidence,
    required this.language,
    required this.segmentIdx,
    required this.isSegment,
    required this.durationMs,
    this.polish,
    this.polishReason,
    this.utteranceId,
    this.emptyReason,
  });

  static SttFinal? tryFromJson(Map<String, Object?> j) {
    final Object? text = j['text'];
    final Object? idx = j['segment_idx'];
    if (text is! String || idx is! int) return null;
    final Object? utt = j['utterance_id'];
    final SttPolish? polish = switch (j['polish']) {
      'applied' => SttPolish.applied,
      'skipped' => SttPolish.skipped,
      _ => null,
    };
    final Object? reasonRaw = j['polish_reason'];
    final String? polishReason =
        reasonRaw is String && kSttPolishReasons.contains(reasonRaw)
            ? reasonRaw
            : null;
    return SttFinal(
      text: text,
      confidence: (j['confidence'] as num?)?.toDouble() ?? 0.0,
      language: j['language'] is String ? j['language'] as String : '',
      segmentIdx: idx,
      isSegment: j['is_segment'] == true,
      durationMs: (j['duration_ms'] as num?)?.toInt() ?? 0,
      polish: polish,
      polishReason: polishReason,
      utteranceId: utt is String && utt.isNotEmpty ? utt : null,
      emptyReason: switch (j['empty_reason']) {
        final String r when r.isNotEmpty => r,
        _ => null,
      },
    );
  }
}

/// stt:refined — a LATE, better transcript of one utterance, named by the
/// same server-minted [utteranceId] its terminal `stt:final` carried (D7).
/// Only frames that name their utterance reach this type: ptt_inbound.dart
/// drops the rest at the wire, because a refine that names nothing has no row
/// it can honestly be applied to.
class SttRefined {
  const SttRefined({required this.utteranceId, required this.text});
  final String utteranceId;
  final String text;
}

/// The typed STT stream layer. The socket event loop feeds raw payloads in;
/// WP-R3-2's chat-flow view listens on the exposed streams. [amplitudeDb] mirrors
/// stt:level for the amplitude meter (SttLevelSchema.amplitude_db).
class SttStream {
  final _interimCtl = StreamController<SttInterim>.broadcast();
  final _finalCtl = StreamController<SttFinal>.broadcast();
  final _levelCtl = StreamController<double>.broadcast();

  Stream<SttInterim> get interims => _interimCtl.stream;
  Stream<SttFinal> get finals => _finalCtl.stream;
  Stream<double> get amplitudeDb => _levelCtl.stream;

  void onInterim(Map<String, Object?> data) {
    final SttInterim? parsed = SttInterim.tryFromJson(data);
    if (parsed != null) _interimCtl.add(parsed);
  }

  void onFinal(Map<String, Object?> data) {
    final SttFinal? parsed = SttFinal.tryFromJson(data);
    if (parsed != null) _finalCtl.add(parsed);
  }

  void onLevel(Map<String, Object?> data) {
    final Object? amp = data['amplitude_db'];
    if (amp is num) _levelCtl.add(amp.toDouble());
  }

  Future<void> dispose() async {
    await _interimCtl.close();
    await _finalCtl.close();
    await _levelCtl.close();
  }
}
