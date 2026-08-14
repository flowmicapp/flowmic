// T-5b-mobile — pure mapping tests (no WidgetTester / FakeAsync).
// Connection four-state colours must track the real FSM, never a bool.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final AppStrings zh = AppStrings.of(AppLocale.zh);
  final AppStrings en = AppStrings.of(AppLocale.en);

  test('connected → green + connConnected', () {
    final ConnDotMeta m = connDotMeta(ConnectionState.connected, zh);
    expect(m.color, FlowMicColors.green);
    expect(m.label, zh.connConnected);
    expect(connDotMeta(ConnectionState.connected, en).label, 'Connected');
  });

  test('connecting → amber + connecting (shared with reconnecting)', () {
    final ConnDotMeta m = connDotMeta(ConnectionState.connecting, zh);
    expect(m.color, FlowMicColors.amber);
    expect(m.label, zh.connecting);
  });

  test('reconnecting → amber + recLinkDegraded', () {
    final ConnDotMeta m = connDotMeta(ConnectionState.reconnecting, zh);
    expect(m.color, FlowMicColors.amber);
    expect(m.label, zh.recLinkDegraded);
  });

  test('error → red + connError (only true faults)', () {
    final ConnDotMeta m = connDotMeta(ConnectionState.error, zh);
    expect(m.color, FlowMicColors.red);
    expect(m.label, zh.connError);
  });

  test('disconnected → slate + notConnected (idle, NOT an alarm)', () {
    final ConnDotMeta m = connDotMeta(ConnectionState.disconnected, zh);
    expect(m.color, FlowMicColors.slate);
    expect(m.label, zh.notConnected);
    // Regression: the old binary map painted idle as red.
    expect(m.color, isNot(FlowMicColors.red));
  });
}
