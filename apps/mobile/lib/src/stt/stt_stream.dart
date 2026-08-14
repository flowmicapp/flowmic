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
  const SttFinal({
    required this.text,
    required this.confidence,
    required this.language,
    required this.segmentIdx,
    required this.isSegment,
    required this.durationMs,
    this.polish,
    this.polishReason,
  });

  static SttFinal? tryFromJson(Map<String, Object?> j) {
    final Object? text = j['text'];
    final Object? idx = j['segment_idx'];
    if (text is! String || idx is! int) return null;
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
    );
  }
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
