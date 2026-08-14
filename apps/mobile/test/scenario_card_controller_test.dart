// WP-R3-3 — save-as-you-edit + the settings-key-drift closure in action. Every scenario
// edit must emit settings:update with key == FlowMicSettingsKeys.scenarioCard
// (the SAME SSOT string the server compose reader uses) and value == the exact
// ScenarioCardSchema JSON. Uses the REAL SettingsClient over a fake transport so
// the generated event + key constants are exercised end to end.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/generated/flowmic_settings.g.dart';
import 'package:flowmic/src/settings/scenario_card.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

({SettingsClient client, FakeSocketTransport transport, ScenarioCardController ctrl})
    _wire() {
  final FakeSocketTransport t = FakeSocketTransport();
  final SettingsClient client = SettingsClient(transport: t);
  final ScenarioCardController ctrl = ScenarioCardController(
    settingsClient: client,
    cache: InMemoryScenarioCardCache(),
  );
  return (client: client, transport: t, ctrl: ctrl);
}

Map<String, Object?> _lastSettingsUpdate(FakeSocketTransport t) {
  final envelopes = t.emittedWhere(FlowMicEvents.settingsUpdate);
  expect(envelopes, isNotEmpty, reason: 'expected a settings:update emit');
  return (envelopes.last.data as Map).cast<String, Object?>();
}

void main() {
  test('toggling a profession pushes settings:update{scenario.card} with the '
      'exact schema JSON (key from the shared SSOT constant)', () async {
    final w = _wire();
    w.ctrl.toggleProfession('software development');

    final Map<String, Object?> payload = _lastSettingsUpdate(w.transport);
    // The key is the generated constant — identical to the server's
    // SETTINGS_KEY_SCENARIO_CARD. This IS the bidirectional interlock.
    expect(payload['key'], FlowMicSettingsKeys.scenarioCard);
    expect(payload['key'], 'scenario.card');
    expect(payload['value'], <String, Object?>{
      'professions': <String>['software development'],
      'domains': <String>[],
      'packs': <String>[],
      'terms': <String>[],
    });
    await w.client.dispose();
  });

  test('a full structured edit assembles one card and pushes it', () async {
    final w = _wire();
    w.ctrl.toggleProfession('software development');
    w.ctrl.toggleDomain('cloud native');
    w.ctrl.togglePack('tech-dev');
    expect(w.ctrl.addTerm('灰度发布'), TermAddOutcome.added);

    final Map<String, Object?> payload = _lastSettingsUpdate(w.transport);
    expect(payload['value'], <String, Object?>{
      'professions': <String>['software development'],
      'domains': <String>['cloud native'],
      'packs': <String>['tech-dev'],
      'terms': <String>['灰度发布'],
    });
    // Four edits → four settings:update emits (save-as-you-edit, no batching / save button).
    expect(w.transport.emittedWhere(FlowMicEvents.settingsUpdate).length, 4);
    await w.client.dispose();
  });

  test('a no-op transform (rejected term) does NOT push', () async {
    final w = _wire();
    w.ctrl.addTerm('术语'); // 1 push
    final int after = w.transport.emittedWhere(FlowMicEvents.settingsUpdate).length;
    final TermAddOutcome outcome = w.ctrl.addTerm('术语'); // duplicate → no push
    expect(outcome, TermAddOutcome.duplicate);
    expect(
      w.transport.emittedWhere(FlowMicEvents.settingsUpdate).length,
      after,
    );
    await w.client.dispose();
  });

  test('the emitted event is the settings:update whitelist constant (no literal)',
      () async {
    final w = _wire();
    w.ctrl.togglePack('proper-noun');
    expect(w.transport.emittedNames, contains('settings:update'));
    expect(FlowMicEvents.settingsUpdate, 'settings:update');
    await w.client.dispose();
  });

  // ── GA-11: hydration + peer push ───────────────────────────────────────

  test('a blank card (fresh install) hydrates from the connect-time snapshot',
      () async {
    final w = _wire();
    expect(w.ctrl.card.isEmpty, isTrue);
    w.transport.ackQueue.add(<String, Object?>{
      'items': <Object?>[
        <String, Object?>{
          'key': FlowMicSettingsKeys.scenarioCard,
          'value': <String, Object?>{
            'professions': <String>['software development'],
            'domains': <String>[],
            'packs': <String>['tech-dev'],
            'terms': <String>['灰度发布'],
          },
        },
      ],
    });

    w.transport.pushStatus(SocketStatus.connected);
    await Future<void>.delayed(Duration.zero);

    expect(w.ctrl.card.hasProfession('software development'), isTrue);
    expect(w.ctrl.card.hasPack('tech-dev'), isTrue);
    expect(w.ctrl.card.terms, <String>['灰度发布']);
    // Nothing visible was displaced — a first hydration is not an overwrite.
    expect(w.ctrl.remoteRefreshed, isFalse);
    await w.client.dispose();
  });

  test('settings:updated{scenario.card} refreshes the card and says so; the '
      'note clears on the next local edit', () async {
    final w = _wire();
    w.ctrl.togglePack('legal'); // something visible the user already had
    int notifies = 0;
    w.ctrl.addListener(() => notifies++);

    w.transport.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': FlowMicSettingsKeys.scenarioCard,
      'value': <String, Object?>{
        'professions': <String>[],
        'domains': <String>['legal tech'],
        'packs': <String>['legal', 'finance'],
        'terms': <String>[],
      },
    });

    expect(w.ctrl.card.hasPack('finance'), isTrue);
    expect(w.ctrl.card.hasDomain('legal tech'), isTrue);
    expect(w.ctrl.remoteRefreshed, isTrue, reason: 'displaced a visible card');
    expect(notifies, 1);

    w.ctrl.togglePack('medical');
    expect(w.ctrl.remoteRefreshed, isFalse);
    await w.client.dispose();
  });

  test('an unrelated key does NOT refresh the card (no spurious rebuild)',
      () async {
    final w = _wire();
    w.ctrl.togglePack('legal');
    final ScenarioCard before = w.ctrl.card;
    int notifies = 0;
    w.ctrl.addListener(() => notifies++);

    w.transport.pushIncoming(FlowMicEvents.settingsUpdated,
        <String, Object?>{'key': 'stt.polish', 'value': true});
    // Same-value echo of our OWN key is also a non-event.
    w.transport.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': FlowMicSettingsKeys.scenarioCard,
      'value': before.toJson(),
    });

    expect(w.ctrl.card, before);
    expect(notifies, 0);
    await w.client.dispose();
  });

  test('an UN-SYNCED local edit is never clobbered by a server value '
      '(last-write-wins + the pending note stays up)', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    t.failEmits = true; // socket down: the edit cannot reach the server
    final SettingsClient client = SettingsClient(transport: t);
    final ScenarioCardController ctrl = ScenarioCardController(
      settingsClient: client,
      cache: InMemoryScenarioCardCache(),
    );
    expect(ctrl.addTerm('本地未同步'), TermAddOutcome.added);
    expect(ctrl.syncPending, isTrue);

    // A stale server value arrives while our edit is still queued.
    t.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': FlowMicSettingsKeys.scenarioCard,
      'value': <String, Object?>{'terms': <String>['服务端旧值']},
    });

    expect(ctrl.card.terms, <String>['本地未同步'],
        reason: 'the queued local edit is the later write — it wins');
    expect(ctrl.syncPending, isTrue, reason: 'and the user is still told so');
    expect(ctrl.remoteRefreshed, isFalse);
    ctrl.dispose();
    await client.dispose();
    await t.close();
  });
}
