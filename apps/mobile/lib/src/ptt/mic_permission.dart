// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §8 (first-PTT microphone permission, F-2063)
//   CLAUDE.md red line: no silent failure (没有静默失败) — a denied microphone
//     is a NAMED, RENDERED fact with a way out, never a press that silently
//     does nothing.
//
// Card U2 (0.3.0 blocker). What the audit found [measured]:
//   · the permission was requested COLD in mid-gesture — the FIRST OS dialog the
//     user ever saw popped while their thumb was holding the talk bar;
//   · on denial, `PttSession.pttDown` swallowed the exception behind a comment
//     claiming "fail-loud" — nothing rendered, the press was a silent no-op;
//   · on Android, two denials = permanently-denied: the product's entire purpose
//     was bricked with ZERO on-screen evidence and zero `openAppSettings` calls
//     in the whole repo.
// CONTRAST: camera denial (pairing_strings.pairScanDenied) and gallery denial
// (image_strings / ImagePickDenied) are named and four-language.
// This file gives the microphone the same treatment.
//
// 🔴 ORIGINAL WORDING CORRECTED (card CAM-1, 2026-08-25). The sentence above
// used to call those two 「actionable」 as well, and for the CAMERA that was
// false — measured: the scan sheet named the refusal and then offered no way
// back at all. The controller was built once in `initState` (asking for the
// permission is a side effect of building it), nothing re-armed it, no
// lifecycle observer re-checked on resume, and `openAppSettings` was never
// called on that path — so a user who granted the permission afterwards had to
// unmount the whole sheet before the camera would work. owner reported exactly
// that on 2026-08-25.
// ⇒ anti-façade ④ in its purest form: a comment asserting ANOTHER surface's
// behaviour, whose truth value changes when that surface changes while the
// comment never does. CAM-1 makes the claim true; the correction stays so the
// next reader knows the claim was checked rather than assumed.
//
// SHAPE. [MicPermissionFlow] is the ONE decision layer:
//   · `gateForPtt()` runs BEFORE `AudioCapture.start()`, so the OS dialog is
//     never cold-fired during a hold. It never shows UI itself — it only reads
//     status and decides which FACE the talk surface must render;
//   · the OS request happens from the rendered surface's own action button
//     (`requestFromSurface`), i.e. always AFTER the rationale was on screen —
//     which is what makes 「先解释、后请求」("explain first, request second")
//     structural rather than a habit;
//   · `openSystemSettings()` is the way out of permanently-denied — the
//     `openAppSettings()` call the repo never had.
// The platform is behind [MicPermissionPort] (production impl:
// platform_mic_permission.dart), so every decision here is unit-testable
// without a device — the same seam pattern as AudioRecorder / ImagePickerPort.

import 'dart:async';

import 'package:flutter/foundation.dart';
import '../permission/os_permission.dart';

import '../diag/diag_log.dart';

/// ── THE VOCABULARY MOVED OUT (card CAM-1, 2026-08-25) ─────────────────────
///
/// The four-state probe, the port and the asked-once store now live in
/// `permission/os_permission.dart`, because the CAMERA needs exactly the same
/// three things and a copy of them would have been a second enum answering
/// 「操作系统怎么说」("what does the OS say") — this repo's headline bug shape.
///
/// 🔴 They are ALIASES, not replacements: every call site, every fake and every
/// existing U2 test keeps compiling and keeps meaning what it meant. What stays
/// microphone-specific below is the part that genuinely is: [MicFlowFace] (what
/// the TALK surface renders) and the persisted key.
typedef MicPermissionProbe = OsPermissionProbe;
typedef MicPermissionPort = OsPermissionPort;
typedef MicAskedStore = AskedOnceStore;
typedef InMemoryMicAskedStore = InMemoryAskedOnceStore;

/// The one persisted key for the MICROPHONE.
///
/// 🔴 One key per permission — see [SharedPrefsAskedOnceStore.key]. Sharing a
/// key with the camera would make granting one silence the other's rationale.
const String kMicPermissionAskedKey = 'flowmic.mic.permission_asked';

class SharedPrefsMicAskedStore extends SharedPrefsAskedOnceStore {
  const SharedPrefsMicAskedStore() : super(kMicPermissionAskedKey);
}


/// What the talk surface must render right now. Written ONLY by
/// [MicPermissionFlow]; the renderer (ui/mic_permission_banner.dart) maps each
/// face to a named four-language banner.
enum MicFlowFace {
  /// Nothing to say (granted, or the user dismissed a past notice).
  none,

  /// U2-①: the FIRST request ever is pending the user's own go-ahead — explain
  /// WHY the mic is needed; the action button fires the real OS request.
  rationale,

  /// U2-②: refused, but askable again — named message + a re-request action.
  denied,

  /// U2-③: the OS will not ask again — named message + the `openAppSettings`
  /// way out. Without this face the product's entire purpose is bricked with
  /// zero on-screen evidence (the audit's exact finding).
  permanentlyDenied,

  /// U2-④: the gate said go (or could not classify) and `AudioCapture.start()`
  /// STILL threw. Deliberately its own face rather than a borrowed 「权限被拒」
  /// ("permission was denied"): telling the user to grant a permission they
  /// already granted would be a wrong instruction — the honest sentence is
  /// 「无法启动录音」("recording could not be started").
  captureStartFailed,
}

/// The mic-permission decision layer, owned by [PttSession] (one per session,
/// disposed with it). All writes to [face] happen here — the UI only reads.
class MicPermissionFlow {
  MicPermissionFlow({required MicPermissionPort port, required MicAskedStore asked})
    : _port = port,
      _asked = asked;

  final MicPermissionPort _port;
  final MicAskedStore _asked;

  /// The rendered truth. ValueNotifier (not a stream) for the same reason
  /// [PttSession.roomJoins] is: the page merges it into its Listenable set and
  /// re-reads the current value on every build.
  final ValueNotifier<MicFlowFace> face = ValueNotifier<MicFlowFace>(MicFlowFace.none);

  /// P6 (0.3.1) — whether the LAST [gateForPtt] saw a definitive GRANTED.
  /// `AudioCapture.start(permissionPreflighted:)` reads this to skip its own
  /// redundant permission round trip (each one is a platform-channel hop on
  /// the press-latency path). Deliberately false on `unavailable`: that arm
  /// means 「could not classify」, and capture's own probe is the fallback
  /// that arm has always relied on — skipping it there would change behavior,
  /// not just latency.
  bool get lastGateSawGranted => _lastGateSawGranted;
  bool _lastGateSawGranted = false;

  /// PTT-down gate — runs BEFORE capture, shows NO OS UI. Returns whether the
  /// press may proceed to `AudioCapture.start()`. A false return has ALWAYS
  /// just written the face the surface must render, so a refused press is a
  /// rendered fact by construction, never a silent no-op.
  Future<bool> gateForPtt() async {
    final MicPermissionProbe probe = await _port.status();
    _lastGateSawGranted = probe == MicPermissionProbe.granted;
    switch (probe) {
      case MicPermissionProbe.granted:
        // Self-clears the moment the OS says yes (e.g. granted in system
        // settings while the permanently-denied banner was still up).
        if (face.value != MicFlowFace.none) face.value = MicFlowFace.none;
        return true;
      case MicPermissionProbe.unavailable:
        // Cannot classify — fall through to capture, whose own failure lands in
        // [noteCaptureStartRefused]. See the enum value's doc for why this is
        // not a friendly default.
        return true;
      case MicPermissionProbe.permanentlyDenied:
        diag('mic.permission.blocked', const <String, Object?>{'probe': 'permanently_denied'});
        face.value = MicFlowFace.permanentlyDenied;
        return false;
      case MicPermissionProbe.denied:
        final bool asked = await _asked.askedBefore();
        diag('mic.permission.blocked', <String, Object?>{
          'probe': 'denied',
          'asked_before': asked,
        });
        // First contact explains; later contacts report the refusal. Both carry
        // the SAME action (the real OS request) — only the wording differs.
        face.value = asked ? MicFlowFace.denied : MicFlowFace.rationale;
        return false;
    }
  }

  /// The rationale/denied banner's action: run the REAL OS request. This is the
  /// only place the first request can be born, and it is by construction after
  /// the rationale rendered — the surface's button is what called us.
  Future<void> requestFromSurface() async {
    await _asked.markAsked(); // before the dialog: a killed dialog still counts
    final MicPermissionProbe probe = await _port.request();
    diag('mic.permission.requested', <String, Object?>{'result': probe.name});
    face.value = switch (probe) {
      // Granted: nothing left to say — the next hold records.
      MicPermissionProbe.granted || MicPermissionProbe.unavailable => MicFlowFace.none,
      MicPermissionProbe.denied => MicFlowFace.denied,
      // Android answers `permanentlyDenied` here WITHOUT showing a dialog when
      // the user hit "don't ask again" earlier — this transition is exactly
      // how the banner swaps its action from 「允许」("Allow") to 「去设置开启」
      // ("go to Settings to enable it").
      MicPermissionProbe.permanentlyDenied => MicFlowFace.permanentlyDenied,
    };
  }

  /// The permanently-denied banner's action — the `openAppSettings` way out.
  Future<void> openSystemSettings() async {
    diag('mic.permission.open_settings', const <String, Object?>{});
    await _port.openSettings();
    // The face deliberately stays up: whether the user actually granted in
    // settings is unknowable from here. The next PTT-down re-probes and
    // self-clears via [gateForPtt] if they did.
  }

  /// `AudioCapture.start()` threw after the gate said go (or could not
  /// classify). Re-probe so the face tells the truth about WHY — and never
  /// stays silent (the exact swallow this card removes from pttDown).
  Future<void> noteCaptureStartRefused() async {
    final MicPermissionProbe probe = await _port.status();
    diag('mic.capture.start_refused', <String, Object?>{'probe': probe.name});
    face.value = switch (probe) {
      // The OS says granted (or cannot say): the failure was NOT a missing
      // permission, so do not send the user to a permission screen that is
      // already green — name the real event instead.
      MicPermissionProbe.granted || MicPermissionProbe.unavailable =>
        MicFlowFace.captureStartFailed,
      MicPermissionProbe.denied => MicFlowFace.denied,
      MicPermissionProbe.permanentlyDenied => MicFlowFace.permanentlyDenied,
    };
  }

  /// ✕ on the banner. EVENT-lifecycle (banner_queue.dart's contract): the
  /// refused press is over and the user is not trapped (text compose still
  /// works), so hiding is allowed — and the NEXT refused press re-raises it
  /// through [gateForPtt] (藏不是丢 — "hidden is not the same as dropped").
  void dismiss() {
    if (face.value != MicFlowFace.none) face.value = MicFlowFace.none;
  }

  void dispose() => face.dispose();
}
