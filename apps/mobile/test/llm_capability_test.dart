// Card LLM-NOTICE (2026-08-25) — the phone's reader of `capability.llm`
// (lib/src/settings/llm_capability.dart), fed by the REAL SettingsClient over a
// fake transport, so the whole chain settings:list → entries → value is under
// test rather than the adoption rule alone.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/generated/flowmic_settings.g.dart';
import 'package:flowmic/src/settings/llm_capability.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

void main() {
  test('the generated key is the protocol constant, byte for byte', () {
    // The lint greps SETTINGS_KEY_CAPABILITY_LLM under apps/*; the value it
    // names must be the string the server pushes.
    expect(FlowMicSettingsKeys.capabilityLlm, 'capability.llm');
  });

  group('adopt — the pure rule', () {
    test('a well-formed value is adopted, either way', () {
      expect(LlmCapability.adopt(null, <String, Object?>{'usable': false}), isFalse);
      expect(LlmCapability.adopt(false, <String, Object?>{'usable': true}), isTrue);
    });

    test('a malformed value leaves the last answer alone (cannot parse ≠ false)', () {
      for (final Object? bad in <Object?>[null, 42, 'nope', <Object?>[], <String, Object?>{}, <String, Object?>{'usable': 'yes'}]) {
        expect(LlmCapability.adopt(false, bad), isFalse, reason: 'clobbered by $bad');
        expect(LlmCapability.adopt(null, bad), isNull, reason: 'invented by $bad');
      }
    });
  });

  group('over the real SettingsClient', () {
    test('starts UNKNOWN (null): nothing is claimed before the server speaks', () {
      final FakeSocketTransport transport = FakeSocketTransport();
      final SettingsClient client = SettingsClient(
        transport: transport,
        roomJoins: ValueNotifier<int>(0),
      );
      final LlmCapability cap = LlmCapability(settingsClient: client);
      addTearDown(() {
        cap.dispose();
        client.dispose();
      });
      expect(cap.value, isNull);
    });

    test('settings:list carrying capability.llm {usable:false} ⇒ false; a later push of true ⇒ true', () async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final ValueNotifier<int> joins = ValueNotifier<int>(0);
      final SettingsClient client = SettingsClient(transport: transport, roomJoins: joins);
      final LlmCapability cap = LlmCapability(settingsClient: client);
      addTearDown(() {
        cap.dispose();
        client.dispose();
        joins.dispose();
      });
      transport.ackQueue.add(<String, Object?>{
        'items': <Object?>[
          <String, Object?>{'key': 'stt.polish', 'value': <String, Object?>{'enabled': false}},
          <String, Object?>{'key': FlowMicSettingsKeys.capabilityLlm, 'value': <String, Object?>{'usable': false}},
        ],
      });
      transport.pushStatus(SocketStatus.connected);
      joins.value++; // the admission edge — the ONE settings rising edge
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(transport.emittedWhere(FlowMicEvents.settingsList).length, 1,
          reason: 'positive control: the snapshot really was pulled');
      expect(cap.value, isFalse);

      // The desktop configured a model: the server pushes the fact.
      transport.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
        'key': FlowMicSettingsKeys.capabilityLlm,
        'value': <String, Object?>{'usable': true},
      });
      await Future<void>.delayed(Duration.zero);
      expect(cap.value, isTrue);
    });

    test('an unrelated key never touches the answer', () async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final ValueNotifier<int> joins = ValueNotifier<int>(0);
      final SettingsClient client = SettingsClient(transport: transport, roomJoins: joins);
      final LlmCapability cap = LlmCapability(settingsClient: client);
      addTearDown(() {
        cap.dispose();
        client.dispose();
        joins.dispose();
      });
      transport.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
        'key': 'scenario.card',
        'value': <String, Object?>{'usable': false},
      });
      await Future<void>.delayed(Duration.zero);
      expect(cap.value, isNull);
    });
  });
}
