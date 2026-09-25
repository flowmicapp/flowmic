// B RC27 — the selected web target can refuse a frame before transcript or
// injection work begins. This test pins the phone's two observable duties:
// keep the outbox item owed, and explain that target-admission fact in every
// shipped locale without borrowing delivery- or injection-stage copy.

import 'package:flowmic/src/session/outbox_inject_authorship.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const String code = 'INJECT_TARGET_NOT_READY';

  test('target-not-ready stays owed and is not an injection verdict', () {
    expect(isPcAdmissionRefusalCode(code), isTrue);
    expect(isPcInjectionVerdictCode(code), isFalse);
  });

  test(
    'all nine locales explain target admission in exactly its own table',
    () {
      expect(AppLocale.values, hasLength(9));
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings strings = AppStrings(locale);
        final String? note = strings.pcAdmissionRefusalNote(code);
        expect(note, isNotNull, reason: locale.name);
        expect(note!.trim(), isNotEmpty, reason: locale.name);
        expect(strings.injectVerdictNote(code), isNull, reason: locale.name);
        expect(strings.deliveryRefusalNote(code), isNull, reason: locale.name);
        expect(
          strings.cloudImageRelayErrorNote(code),
          isNull,
          reason: locale.name,
        );
      }
    },
  );

  test('unknown and occupied-target codes do not borrow this explanation', () {
    final AppStrings strings = AppStrings(AppLocale.en);
    expect(strings.pcAdmissionRefusalNote('INJECT_NOT_PRIMARY'), isNull);
    expect(strings.pcAdmissionRefusalNote('INJECT_SOMETHING_NEW'), isNull);
  });
}
