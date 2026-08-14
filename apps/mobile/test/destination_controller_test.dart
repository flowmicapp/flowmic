// WP-R3-2 acceptance — destination two-state + SESSION stickiness reset +
// cloud-instance fixed lock + transient focus label. SPEC-REF: master-plan
// §4.0 B/C.

import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('defaults to inject; toggle flips to record-only and back', () {
    final DestinationController d = DestinationController();
    expect(d.mode, DestinationMode.inject);
    expect(d.delivery, Delivery.inject);
    d.toggle();
    expect(d.isRecordOnly, isTrue);
    expect(d.delivery, Delivery.none);
    d.toggle();
    expect(d.delivery, Delivery.inject);
  });

  test('header label reflects focus app / record-only / no-focus', () {
    const AppStrings zh = AppStringsZh();
    final DestinationController d = DestinationController();
    expect(d.headerLabel(zh), '—'); // no focus yet
    d.onFocusApp('WeChat');
    expect(d.headerLabel(zh), 'WeChat');
    d.setRecordOnly();
    expect(d.headerLabel(zh), '仅记录');
    // The record-only word is the catalogue's ONE translation of the term
    // (V2-07.7) — an explicit-EN caller gets the English face.
    expect(d.headerLabel(AppStrings(AppLocale.en)), 'Record only');
  });

  test('reset() snaps record-only back to the default inject (§4.0 B)', () {
    final DestinationController d = DestinationController();
    d.setRecordOnly();
    expect(d.isRecordOnly, isTrue);
    d.reset(); // a reconnect / reopen
    expect(d.mode, DestinationMode.inject);
  });

  test('a cloud instance is FIXED to record-only; toggle + reset are inert', () {
    final DestinationController d =
        DestinationController(fixedRecordOnly: true);
    expect(d.isFixed, isTrue);
    expect(d.isRecordOnly, isTrue);
    d.toggle();
    expect(d.isRecordOnly, isTrue); // lock holds
    d.setInject();
    expect(d.isRecordOnly, isTrue);
    d.reset();
    expect(d.isRecordOnly, isTrue); // still pinned after a reconnect
  });

  test('focus label is transient — clears on link loss (§4.1)', () {
    final DestinationController d = DestinationController();
    d.onFocusApp('Notepad');
    expect(d.focusApp, 'Notepad');
    d.clearFocus();
    expect(d.focusApp, isNull);
    expect(d.headerLabel(AppStrings(AppLocale.zh)), '—');
  });

  test('configureFixed re-scopes for cloud vs paired', () {
    final DestinationController d = DestinationController();
    d.configureFixed(fixedRecordOnly: true);
    expect(d.isFixed, isTrue);
    expect(d.isRecordOnly, isTrue);
    d.configureFixed(fixedRecordOnly: false);
    expect(d.isFixed, isFalse);
    expect(d.mode, DestinationMode.inject);
  });
}
