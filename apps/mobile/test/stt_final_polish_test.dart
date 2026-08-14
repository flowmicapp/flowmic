// WP-R4-6 ②/⑦ — SttFinal additive polish fields + AppStrings bilingual face.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/stt/stt_stream.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> _finalJson({
  Object? polish,
  Object? polishReason,
  bool isSegment = false,
}) =>
    <String, Object?>{
      'text': '大家好。',
      'confidence': 0.95,
      'language': 'zh-CN',
      'segment_idx': 0,
      'is_segment': isSegment,
      'duration_ms': 1200,
      'polish': ?polish,
      'polish_reason': ?polishReason,
    };

void main() {
  test('legacy stt:final without polish fields still parses', () {
    final SttFinal? f = SttFinal.tryFromJson(_finalJson());
    expect(f, isNotNull);
    expect(f!.polish, isNull);
    expect(f.polishReason, isNull);
  });

  test('parses polish:applied', () {
    final SttFinal? f =
        SttFinal.tryFromJson(_finalJson(polish: 'applied'));
    expect(f!.polish, SttPolish.applied);
    expect(f.polishReason, isNull);
  });

  test('parses polish:skipped + frozen reasons', () {
    for (final String reason in kSttPolishReasons) {
      final SttFinal? f = SttFinal.tryFromJson(
        _finalJson(polish: 'skipped', polishReason: reason),
      );
      expect(f!.polish, SttPolish.skipped);
      expect(f.polishReason, reason);
    }
  });

  test('unknown polish / reason values are ignored (final still lands)', () {
    final SttFinal? f = SttFinal.tryFromJson(
      _finalJson(polish: 'weird', polishReason: 'nope'),
    );
    expect(f, isNotNull);
    expect(f!.polish, isNull);
    expect(f.polishReason, isNull);
  });

  test('AppStrings polishSkipped is bilingual (explicit locale)', () {
    expect(
      AppStrings.of(AppLocale.zh).polishSkipped,
      '润色未生效·已用原文',
    );
    expect(
      AppStrings.of(AppLocale.en).polishSkipped,
      'Polish skipped · raw text kept',
    );
  });
}
