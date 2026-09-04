// WP-B2 (2026-09-03) — THE CARRIER IS THE REQUEST.
//
// owner's follow-up ruling that evening (docs/decisions/2026-09-03-owner-web-
// rulings-phone-owned-settings.md, 追加裁定二 ②):「手机发起一次转录周期时，向服务器
// 的请求里要把客户端的这些参数一起带过去」. So the four phone-owned keys ride an
// optional `prefs` object on `audio:start` and `compose:start`, nothing is
// stored anywhere, and the server REFUSES a `settings:update` of those keys
// from any client.
//
// What this file pins, and why each one is here rather than implied:
//   ① the four literals in `phone_prefs_payload.dart` — the settings-key-drift
//      SET anchors — are the SAME strings the generated SSOT constants carry
//      (the equality the drift-lint ruling rests on; the anchors MOVED here
//      from settings_client.dart's deleted `push*` methods);
//   ② a never-set key is ABSENT, and a phone that has set nothing sends no
//      `prefs` key at all (a fresh install's frames are unchanged);
//   ③ `audio:start` and `compose:start` carry the SAME bundle — if they could
//      disagree, one sentence would be polished one way when spoken and another
//      way when organised;
//   ④ a settings change is on the NEXT `audio:start` with no reconnect, which
//      is the whole point of moving the carrier off the admission edge;
//   ⑤ NO `settings:update` is ever emitted, for these keys or any other —
//      apps/mobile has no settings writer left at all.
//
// ── REVERSE CONTROL (executed 2026-09-03, on this tree) ────────────────────
// Break: put the deleted push back on the wire — two lines in `pttDown`
// (lib/src/ptt/ptt_edges.dart), right after `fsm.onPttDown()`:
//   transport.emit(FlowMicEvents.settingsUpdate,
//       <String, Object?>{'key': 'scenario.card', 'value': <String, Object?>{}});
// OBSERVED (`flutter test test/phone_prefs_payload_test.dart`), verbatim:
//   00:02 +5 -1: (4) a settings change is on the NEXT audio:start — no
//   reconnect, no room join, no push [E]
//     Expected: empty
//       Actual: [EventEnvelope:EventEnvelope(settings:update, {key: scenario.card, value: {}})]
//   00:02 +5 -2: (5) apps/mobile emits NO settings:update at all — the phone has
//   no settings writer left [E]
//     Expected: empty
//       Actual: [EventEnvelope:EventEnvelope(settings:update, {key: scenario.card, value: {}})]
// Reverted: `REVERSE-CONTROL-WPB2` greps to 0, `FlowMicEvents.settingsUpdate`
// appears nowhere under apps/mobile/lib except its own generated declaration,
// and the suite is green again.
//
// ⚠️ Worth stating because it nearly cost this file its point: cases ② and ③
// stay GREEN under that break — they read `prefs` off the audio:start frame,
// which the extra emit does not touch. A file that only asserted the bundle's
// CONTENTS would have watched the deleted mechanism come back and said nothing.
// That is what ⑤ is for, and why it asserts on the whole transport rather than
// on one event name (G13 rule 1).

import 'dart:convert';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/generated/flowmic_settings.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/settings/phone_prefs_payload.dart';
import 'package:flowmic/src/settings/prefs_controller.dart';
import 'package:flowmic/src/settings/scenario_card.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// Real controllers + a real ChatController over a fake socket. Deliberately
/// NOT a hand-built payload: the deliverable is 「the frame the product emits
/// carries this」, and a DTO assembled inside the test would prove only that
/// the DTO can hold a map (13 册 §7 F1 ③ / the 0.3.47 screen-face law).
class _Rig {
  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final TimelineSyncGate gate;
  late final ScenarioCardController scenario;
  late final PrefsController prefs;
  late final PhonePrefsCarrier carrier;
  late final ChatController controller;

  static Future<_Rig> create({
    ScenarioCard card = ScenarioCard.empty,
    PhonePrefs held = PhonePrefs.empty,
  }) async {
    final _Rig r = _Rig();
    r.transport = FakeSocketTransport();
    r.session = newTestSession(
      transport: r.transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      // Collapse the JUST_DONE dwell so one test can speak twice without
      // sleeping through it (spoken_language_test's precedent).
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(r.session);
    r.store = newTestStore();
    r.destination = DestinationController();
    r.gate = TimelineSyncGate(transport: r.transport);
    r.scenario = ScenarioCardController(cache: InMemoryScenarioCardCache(card));
    await r.scenario.load();
    r.prefs = PrefsController(store: InMemoryPrefsStore(held));
    await r.prefs.load();
    r.carrier = PhonePrefsCarrier(scenario: r.scenario, prefs: r.prefs);
    r.controller = ChatController(
      session: r.session,
      store: r.store,
      destination: r.destination,
      syncGate: r.gate,
      localPrefs: InMemoryLocalPrefs(),
      // The one production wire, mirrored: main.dart passes exactly this.
      phonePrefs: r.carrier.frame,
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
    );
    r.transport.pushStatus(SocketStatus.connected);
    await pumpEventQueue();
    return r;
  }

  /// One press-and-release; returns the `prefs` object off THIS utterance's
  /// `audio:start` frame (null = the key was omitted).
  Future<Map<String, Object?>?> speak() async {
    final int before = transport.emittedWhere(FlowMicEvents.audioStart).length;
    await controller.pttDown();
    await controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': 'hi',
      'confidence': 0.9,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 900,
    });
    await pumpEventQueue();
    final List<EventEnvelope> starts =
        transport.emittedWhere(FlowMicEvents.audioStart);
    // Positive control: an "absent" assertion below must not be able to pass
    // because the probe is blind (G13's rule 2).
    expect(starts.length, before + 1,
        reason: 'this utterance must actually have emitted one audio:start');
    final Map<String, Object?> frame =
        Map<String, Object?>.from(starts.last.data! as Map);
    final Object? bundle = frame['prefs'];
    return bundle == null ? null : Map<String, Object?>.from(bundle as Map);
  }

  /// The `prefs` object off a `compose:start` the product's ONE compose emitter
  /// puts on the wire.
  Map<String, Object?>? compose() {
    final int before = transport.emittedWhere(FlowMicEvents.composeStart).length;
    final bool ok = controller.composeGate.emitAiCompose(
      const ComposeStartPayload(
        task: ComposeTask.organize,
        sourceText: 'hi',
        requestId: 'r1',
      ),
    );
    expect(ok, isTrue, reason: 'positive control: the frame really went out');
    final List<EventEnvelope> outs =
        transport.emittedWhere(FlowMicEvents.composeStart);
    expect(outs.length, before + 1);
    final Object? bundle =
        Map<String, Object?>.from(outs.last.data! as Map)['prefs'];
    return bundle == null ? null : Map<String, Object?>.from(bundle as Map);
  }

  Future<void> dispose() async {
    await controller.dispose();
    prefs.dispose();
    scenario.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  // ── ① the literal SET anchors == the generated SSOT constants ─────────────
  test('(1) the four dotted keys the builder writes ARE the SSOT constants the '
      'server reads', () async {
    final PrefsController prefs = PrefsController(
      store: InMemoryPrefsStore(
        const PhonePrefs(
          polish: PolishPrefs(enabled: true, strength: PolishStrength.smooth),
          refine: RefinePrefs(enabled: true),
          inference: InferenceConsentPrefs(granted: true),
        ),
      ),
    );
    await prefs.load();
    final ScenarioCardController scenario = ScenarioCardController(
      cache: InMemoryScenarioCardCache(
        const ScenarioCard(terms: <ScenarioTerm>[ScenarioTerm('FlowMic')]),
      ),
    );
    await scenario.load();
    final Map<String, Object?> bundle =
        PhonePrefsCarrier(scenario: scenario, prefs: prefs).bundle();

    expect(bundle.keys, unorderedEquals(kPhonePrefsKeys));
    expect(kPhonePrefsKeys, <String>[
      'scenario.card',
      'stt.polish',
      'stt.refine',
      'scenario.inference',
    ], reason: 'the literals in phone_prefs_payload.dart are these four');
    expect(FlowMicSettingsKeys.scenarioCard, 'scenario.card');
    expect(FlowMicSettingsKeys.sttPolish, 'stt.polish');
    expect(FlowMicSettingsKeys.sttRefine, 'stt.refine');
    expect(FlowMicSettingsKeys.scenarioInference, 'scenario.inference');

    // Each value is EXACTLY the shape its own schema always had.
    expect(bundle['stt.polish'],
        <String, Object?>{'enabled': true, 'strength': 'smooth'});
    expect(bundle['stt.refine'], <String, Object?>{'enabled': true});
    expect(bundle['scenario.inference'],
        <String, Object?>{'granted': true, 'granted_for': 'external'});
    expect((bundle['scenario.card']! as Map)['terms'], <Object>['FlowMic']);

    prefs.dispose();
    scenario.dispose();
  });

  // ── ② never-set is absent ─────────────────────────────────────────────────
  test('(2) a phone that has set nothing sends NO prefs key at all', () async {
    final _Rig r = await _Rig.create();
    expect(await r.speak(), isNull,
        reason: 'a fresh install\'s audio:start is byte-for-byte what it was');
    expect(r.compose(), isNull);
    await r.dispose();
  });

  test('(2b) only the keys the user has actually set travel', () async {
    final _Rig r = await _Rig.create(
      held: const PhonePrefs(refine: RefinePrefs(enabled: false)),
    );
    expect((await r.speak())!.keys, <String>['stt.refine'],
        reason: 'polish and the consent were never touched — the server '
            'applies ITS default, which this phone cannot compute');
    await r.dispose();
  });

  test('(2c) an empty card is not carried, a non-empty one is', () async {
    final _Rig empty = await _Rig.create();
    expect(await empty.speak(), isNull);
    await empty.dispose();

    final _Rig full = await _Rig.create(
      card: const ScenarioCard(domains: <String>['frontend']),
    );
    expect((await full.speak())!.keys, <String>['scenario.card']);
    await full.dispose();
  });

  // ── ③ both frames say the same thing ──────────────────────────────────────
  test('(3) audio:start and compose:start carry the SAME bundle', () async {
    final _Rig r = await _Rig.create(
      card: const ScenarioCard(terms: <ScenarioTerm>[ScenarioTerm('灰度发布')]),
      held: const PhonePrefs(
        polish: PolishPrefs(enabled: false),
        inference: InferenceConsentPrefs(granted: true),
      ),
    );
    final Map<String, Object?>? onAudio = await r.speak();
    final Map<String, Object?>? onCompose = r.compose();
    expect(onAudio, isNotNull);
    expect(onCompose, onAudio,
        reason: 'two answers to 「what does this phone hold」 is the shape this '
            'repo keeps paying for');
    expect(onAudio!.keys, unorderedEquals(<String>[
      'scenario.card',
      'stt.polish',
      'scenario.inference',
    ]));
    await r.dispose();
  });

  // ── ④ a change lands on the NEXT request, with no reconnect ───────────────
  test('(4) a settings change is on the NEXT audio:start — no reconnect, no '
      'room join, no push', () async {
    final _Rig r = await _Rig.create();
    expect(await r.speak(), isNull);

    // The user taps the switch. Nothing else happens: the socket is not
    // touched, no admission edge fires.
    r.prefs.setRefineEnabled(true);
    r.prefs.setPolishStrength(PolishStrength.smooth);
    r.scenario.toggleDomain('frontend');
    expect(r.transport.emittedWhere(FlowMicEvents.settingsUpdate), isEmpty);

    final Map<String, Object?>? next = await r.speak();
    expect(next, isNotNull);
    expect(next!['stt.refine'], <String, Object?>{'enabled': true});
    expect(next['stt.polish'],
        <String, Object?>{'enabled': true, 'strength': 'smooth'});
    expect((next['scenario.card']! as Map)['domains'], <String>['frontend']);
    // And the compose leg sees the same change in the same breath.
    expect(r.compose(), next);
    await r.dispose();
  });

  // ── ⑤ nothing writes a setting any more ───────────────────────────────────
  test('(5) apps/mobile emits NO settings:update at all — the phone has no '
      'settings writer left', () async {
    final _Rig r = await _Rig.create(
      card: const ScenarioCard(packs: <String>['tech-dev']),
      held: const PhonePrefs(polish: PolishPrefs(enabled: true)),
    );
    r.prefs.setInferenceGranted(true);
    r.scenario.addTerm('idempotent');
    await r.speak();
    r.compose();
    // The four keys specifically — and, since this is the whole transport,
    // every other key too.
    expect(r.transport.emittedWhere(FlowMicEvents.settingsUpdate), isEmpty);
    await r.dispose();
  });

  // ── ⑥ the wire vocabulary is ENGLISH, the store's is ids (2026-09-04) ──────
  test('(6) the card on audio:start / compose:start carries the ENGLISH '
      'canonical names — never the ids the phone stores, never a locale label',
      () async {
    final _Rig r = await _Rig.create(
      card: const ScenarioCard(
        professions: <String>['software-dev', 'devops-sre'],
        domains: <String>['data-ml', 'cloud-native'],
        packs: <String>['tech-dev'],
      ),
    );
    final Map<String, Object?>? frame = await r.speak();
    final Map<Object?, Object?> card =
        frame!['scenario.card']! as Map<Object?, Object?>;
    expect(card['professions'], <String>['software development', 'devops / SRE']);
    expect(card['domains'], <String>['data / ML', 'cloud native']);
    // Pack ids were ALWAYS protocol ids and are not translated — the change
    // must not have swept them up.
    expect(card['packs'], <String>['tech-dev']);
    // The compose leg reads the same builder, so it says the same thing.
    expect(r.compose(), frame);
    // And the negative: not one id and not one localized label crossed.
    final String wire = jsonEncode(card);
    for (final String forbidden in <String>[
      'software-dev', 'devops-sre', 'data-ml', 'cloud-native',
      '软件开发', 'Software', 'Développement logiciel',
    ]) {
      expect(wire.contains(forbidden), isFalse, reason: forbidden);
    }
    await r.dispose();
  });
}
