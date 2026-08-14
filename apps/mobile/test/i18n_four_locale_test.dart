// V2-07.5 acceptance — the four-language catalogue: ten representative keys
// must return FOUR MUTUALLY DISTINCT values across zh/en/ja/ko. This catches
// the failure mode no compiler can see — 「ja forgot the translation and just
// copied en」. Explicit locale only — nothing here reads the OS locale
// (CLAUDE.md red line).
//
// 🔴 0.2.67 — THIS TEST GOT MORE IMPORTANT, NOT LESS. It used to say 「the
// required-named-parameter `_t` already makes a MISSING language a compile
// error, so this only has to catch the copy」. Half of that is now false: owner
// ruled on 2026-08-14 that a missing translation FALLS BACK TO ENGLISH (17 册
// §0-bis), so a language can ship incomplete on purpose and the compiler will
// not say a word. What replaces the compiler is measurement —
// i18n/mobile/coverage.json, emitted by the generator — plus assertions like
// these, which are the only thing that can tell 「translated to the same word」
// from 「never translated」.
//
// Deliberately NOT asserted: the keys whose CORRECT translations legitimately
// coincide across zh/ja through shared kanji vocabulary — 未成功 (statusFailed,
// deliberately the literal calque per N2), 整理 (modeLabel organize), 教育 /
// 法律 / 保存. A shared glyph is not an untranslated copy, and a blanket
// 「all keys differ」 assertion would force someone to 「fix」 correct copy.
//
// N2 pins its own pair separately (inject_state_narrowing_test.dart): what
// matters for 投递中 / 未投递 is not that four locales differ from each other but
// that the TWO WORDS differ WITHIN each locale — a locale where they coincide has
// silently re-merged the two states for its users.

import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const AppStrings zh = AppStringsZh();
  const AppStrings en = AppStringsEn();
  const AppStrings ja = AppStringsJa();
  const AppStrings ko = AppStringsKo();

  final Map<String, String Function(AppStrings)> keys =
      <String, String Function(AppStrings)>{
    'settingsTitle': (AppStrings s) => s.settingsTitle,
    'secPreferences': (AppStrings s) => s.secPreferences,
    'connConnected': (AppStrings s) => s.connConnected,
    'historyTitle': (AppStrings s) => s.historyTitle,
    'composeHint': (AppStrings s) => s.composeHint,
    'recordOnly': (AppStrings s) => s.recordOnly,
    'aiRowNote': (AppStrings s) => s.aiRowNote,
    'historyFallbackNote': (AppStrings s) => s.historyFallbackNote,
    'pttHold': (AppStrings s) => s.pttHold,
    'favoritesEmpty': (AppStrings s) => s.favoritesEmpty,
  };

  for (final MapEntry<String, String Function(AppStrings)> k in keys.entries) {
    test('${k.key}: four mutually distinct faces', () {
      final Set<String> values = <String>{
        k.value(zh),
        k.value(en),
        k.value(ja),
        k.value(ko),
      };
      expect(values, hasLength(4), reason: '${k.key}: two locales coincide');
    });
  }

  test('modeLabel(translate): four mutually distinct faces', () {
    final Set<String> values = <String>{
      zh.modeLabel(FlowMode.translate),
      en.modeLabel(FlowMode.translate),
      ja.modeLabel(FlowMode.translate),
      ko.modeLabel(FlowMode.translate),
    };
    expect(values, hasLength(4));
  });
}
