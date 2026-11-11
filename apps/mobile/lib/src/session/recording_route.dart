// D-MKT-22 (2026-11-10) — A KEPT RECORDING IS FED BACK AUTOMATICALLY ONLY ALONG
// THE ROUTE IT WAS RECORDED ON.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.7, the D-MKT-22
//     addition (THE contract for every rule in this file)
//   docs/marketing/verification-reports/V-LAN-speech-path.md §7 ① (the defect)
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
//
// The recovery queue feeds owed audio through whatever socket is up, with no
// record of where the audio was being sent when it was captured. MEASURED: a
// recording that failed on the computer's built-in engine (no model) was fed
// back by itself after the computer was switched to a cloud engine, and its
// audio went to that engine with nobody pressing anything.
//
// ── TWO HOLDS, BOTH LIKE CARD RC-S's ACCOUNT HOLD ───────────────────────────
//
// Held = no `audio:start`, no attempt recorded, no failure counted, no backoff
// written. A press of 「Try again now」 is the user's consent to the current
// route, so neither hold refuses it (the account hold still does).
//
//   ① ROUTE: the press stamps the channel (`lan` / `relay`) and the paired
//     computer (`pc_machine_uid`) into the manifest's `configSnapshot`. A
//     different channel or a different computer now ⇒ held.
//   ② ENGINE SETUP: an attempt that ended `STT_CONFIG_MISSING` means the engine
//     at the other end had nothing usable configured. Fixing that is a
//     configuration change, and this phone cannot see whether the change also
//     moved the audio to another kind of engine (the computer's built-in model
//     vs a cloud service set on it) — so it does not guess.
//
// ⚠️ WHAT THIS DOES NOT CLOSE, stated in the contract too: same channel, same
// computer, the computer's engine changed after a failure of ANOTHER kind (a
// link drop, an engine error). No fact on the wire tells the phone which kind
// of engine the computer uses, so nothing here can tell that change apart.

import '../audio/retained_audio_manifest.dart';
import 'instance_probe.dart' show ServerChannel;

/// The manifest `configSnapshot` keys. Beside `kConfigSnapshotAccount`
/// (recording_account.dart) and the variant keys (recovery_identity.dart).
const String kConfigSnapshotRouteChannel = 'route_channel';
const String kConfigSnapshotRoutePc = 'route_pc';

/// The engine's named refusal to open (server-core `STT_CONFIG_MISSING`; the
/// phone cannot import the TS registry). Read off `JournalAttempt.failureCode`,
/// which the leg writes from the server's own code (recovery_leg_wire.dart).
const String kSttConfigMissingCode = 'STT_CONFIG_MISSING';

/// The on-disk word for a channel. Null for a channel not yet known.
String? routeChannelWire(ServerChannel? c) => switch (c) {
      ServerChannel.lan => 'lan',
      ServerChannel.cloudRelay => 'relay',
      null => null,
    };

/// [snapshot] plus the route of this press. A part not known now is left out,
/// and a recording with no route keys runs as before this card (old manifests
/// read the same way).
Map<String, Object?> stampRecordingRoute(
  Map<String, Object?> snapshot, {
  required ServerChannel? channel,
  required String? pcMachineUid,
}) {
  final String? wire = routeChannelWire(channel);
  return <String, Object?>{
    ...snapshot,
    kConfigSnapshotRouteChannel: ?wire,
    if (pcMachineUid != null && pcMachineUid.isNotEmpty)
      kConfigSnapshotRoutePc: pcMachineUid,
  };
}

/// Why the automatic route will not feed a recording.
enum RecordingRouteHold {
  none,

  /// Recorded over another channel, or to another computer.
  routeChanged,

  /// An attempt ended with the engine refusing to open for want of a setup.
  engineSetup,
}

/// The one reader. The recovery leg (whether to open an automatic attempt) and
/// the pending list (which sentence the card says) both ask it, so the two
/// cannot disagree about a recording.
///
/// A part of the current route that is not known (null) never produces
/// [RecordingRouteHold.routeChanged] — the card must not claim a change nobody
/// measured. The leg refuses that case separately ([routeUnknownNow]).
RecordingRouteHold recordingRouteHoldOf(
  RecordingManifest manifest, {
  required ServerChannel? channel,
  required String? pcMachineUid,
}) {
  for (final JournalAttempt a in manifest.attempts) {
    if (a.failureCode == kSttConfigMissingCode) {
      return RecordingRouteHold.engineSetup;
    }
  }
  final Map<String, Object?> snap = manifest.configSnapshot;
  final Object? recChannel = snap[kConfigSnapshotRouteChannel];
  final String? nowChannel = routeChannelWire(channel);
  if (recChannel is String && nowChannel != null && recChannel != nowChannel) {
    return RecordingRouteHold.routeChanged;
  }
  final Object? recPc = snap[kConfigSnapshotRoutePc];
  if (recPc is String &&
      pcMachineUid != null &&
      pcMachineUid.isNotEmpty &&
      recPc != pcMachineUid) {
    return RecordingRouteHold.routeChanged;
  }
  return RecordingRouteHold.none;
}

/// 🔴 FAIL CLOSED for the automatic route: the recording names a channel and
/// this phone cannot say which one it is on now.
bool routeUnknownNow(RecordingManifest manifest, ServerChannel? channel) =>
    manifest.configSnapshot[kConfigSnapshotRouteChannel] is String &&
    channel == null;
