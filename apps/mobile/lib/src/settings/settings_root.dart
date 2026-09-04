// The composition of the settings family — the one socket client, the
// capability reader, the two phone-owned preference controllers and the
// settings backup — built together because they share one client and one
// admission edge, and because main.dart is at the 800-line source cap
// (`verify/lint/file-size.mjs`) and could not take the backup's nine
// constructor arguments. Same move as `audio/retained_audio_boot.dart`
// (2026-08-27): a block leaves main.dart whole, nothing is defaulted.
//
// 🔴 NO FRIENDLY DEFAULTS (13 册 §7 F1 ②). Every port is REQUIRED, the same
// posture as PortableController: a backup row wired to a destination that
// silently answered 「saved」 without a file would be telling a user their
// settings are safe when nothing was written.
//
// ── THE RESTORE HOOK ─────────────────────────────────────────────────────
// [SettingsBackup] writes the device-local store and then calls back here.
// Reloading the two controllers from the store is the whole of it now: the
// server learns a restored card on the next `audio:start`, because owner ruled
// on 2026-09-03 that the REQUEST is the carrier (追加裁定二 ②). Until that
// ruling 「adopt」 also meant 「push it」; there is nothing to re-send any more,
// nothing that can be owed, and therefore no 「pending sync」 state to clear.
// The phone-local habits (UI language,
// theme, text size, send policy, translate target, favorites) belong to
// controllers this file does not own; [reloadLocalHabits] is main.dart's half
// of the same hook, so 「restored on disk」 and 「restored on screen」 stay one
// event with two listeners rather than two events.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../portable/portable_ports.dart';
import '../portable/settings_backup.dart';
import '../signaling/socket_core.dart';
import 'llm_capability.dart';
import 'phone_prefs_payload.dart';
import 'prefs_controller.dart';
import 'scenario_card_controller.dart';
import 'settings_client.dart';

class SettingsRoot {
  SettingsRoot({
    required SharedPreferences prefs,
    required SocketTransport transport,
    required ValueListenable<int> roomJoins,
    required ExportDestinationPort destination,
    required ImportSourcePort source,
    required AppVersionPort version,
    required String workDir,
    required String? deviceName,
    required Future<void> Function() reloadLocalHabits,
  }) : client = SettingsClient(transport: transport, roomJoins: roomJoins),
       _cardCache = SharedPrefsScenarioCardCache(prefs),
       _prefsStore = SharedPrefsPrefsStore(prefs),
       _reloadLocalHabits = reloadLocalHabits {
    // Card LLM-NOTICE: the SERVER's capability.llm fact, never inferred locally.
    llmCapability = LlmCapability(settingsClient: client);
    scenario = ScenarioCardController(cache: _cardCache);
    this.prefs = PrefsController(store: _prefsStore);
    // The read side of the two controllers above, as one object. Nothing here
    // talks to the wire: `PhonePrefsCarrier.frame` is handed to ChatController
    // in main.dart and is CALLED by the three emitters at the moment they build
    // a frame (phone_prefs_payload.dart).
    phonePrefs = PhonePrefsCarrier(scenario: scenario, prefs: this.prefs);
    backup = SettingsBackup(
      prefs: prefs,
      destination: destination,
      source: source,
      version: version,
      workDir: workDir,
      deviceName: deviceName,
      onImported: _afterRestore,
    );
  }

  final SettingsClient client;
  late final LlmCapability llmCapability;
  late final ScenarioCardController scenario;
  late final PrefsController prefs;
  late final PhonePrefsCarrier phonePrefs;
  late final SettingsBackup backup;

  final SharedPrefsScenarioCardCache _cardCache;
  final SharedPrefsPrefsStore _prefsStore;
  final Future<void> Function() _reloadLocalHabits;

  /// Boot: hydrate both controllers from the device-local store. Neither
  /// pushes here — the admission edge does.
  Future<void> load() async {
    await scenario.load();
    await prefs.load();
  }

  Future<void> _afterRestore() async {
    scenario.adopt(await _cardCache.load());
    prefs.adopt(await _prefsStore.load());
    await _reloadLocalHabits();
  }

  /// Dispose order: consumers before the client they listen to, so nothing is
  /// still subscribed to a closed stream (the `_pcBusy` leak, 0.2.51).
  void dispose() {
    scenario.dispose();
    prefs.dispose();
    llmCapability.dispose();
    unawaited(client.dispose());
  }
}
