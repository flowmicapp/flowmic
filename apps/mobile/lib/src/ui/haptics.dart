// V2-04 — haptic confirmations. Usage posture: the user holds the phone and
// watches the PC SCREEN, not the phone — visual feedback is invisible in the
// moment that matters, so haptics are the ONLY confirmation channel.
//
// Success and failure are deliberately DIFFERENT patterns (one short pulse vs
// two). A single undifferentiated buzz would re-commit the "silent failure" sin on the
// haptic channel: the user would know 「something happened」 without knowing
// 「did it succeed」.
//
// Pure framework HapticFeedback (package:flutter/services.dart) — no plugins.

import 'package:flutter/services.dart';

abstract final class FlowMicHaptics {
  /// PTT down ACCEPTED — recording really started. A refused press (FSM gate,
  /// mic denied) is a non-event and must NOT buzz: a vibration there would
  /// claim a recording that does not exist.
  static Future<void> pttDown() => HapticFeedback.mediumImpact();

  /// PTT released into a send — the utterance is on its way.
  static Future<void> pttSend() => HapticFeedback.lightImpact();

  /// Swipe-up cancel — the utterance was discarded. Heavy on purpose so the
  /// destructive gesture is unmistakable against the send's light pulse.
  static Future<void> pttCancel() => HapticFeedback.heavyImpact();

  /// inject:result ok — the PC really landed the text. ONE short pulse.
  static Future<void> injectSuccess() => HapticFeedback.lightImpact();

  /// inject:result not ok — TWO short pulses, distinguishable by feel alone
  /// for someone who never glances at the phone.
  static Future<void> injectFailure() async {
    await HapticFeedback.lightImpact();
    await Future<void>.delayed(const Duration(milliseconds: 140));
    await HapticFeedback.lightImpact();
  }

  // ── REQ-12-13 — the four remote keys (owner P0 2026-08-12) ─────────────────
  //
  // The posture at the top of this file is exactly why owner asked for these: the
  // user is holding the phone and watching the PC, and until now a remote key press
  // gave the hand NOTHING — the four keys had a usage counter and no feedback at all.

  /// A remote key's frame LEFT THE DEVICE. One SELECTION click — deliberately not
  /// [pttSend]'s light impact and not [injectSuccess]'s.
  ///
  /// 🔴 IT MUST NOT FEEL LIKE injected. `injectSuccess` means 「the computer
  /// really accepted this text」,
  /// and this end cannot claim that for a keypress: `control:key` has no receipt
  /// frame, so all this confirms is 「it was sent」 (docs/rebuild/15 §2.0-e). Two
  /// different claims must not share one sensation — that is 「one value
  /// answering two questions」 on
  /// the haptic channel, and the file header's own rule.
  static Future<void> controlKeySent() => HapticFeedback.selectionClick();

  /// A remote key that did NOT leave the device — same TWO pulses as
  /// [injectFailure], because it is the same claim (「this did not succeed」) and the user's
  /// hand should not have to learn a second failure vocabulary.
  ///
  /// ⚠️ The vibration is never the only feedback here: `sendControlKey` raises the
  /// compose banner on both refusal branches. A buzz that says 「something
  /// happened」 without
  /// saying WHAT is the thing this file exists to prevent.
  static Future<void> controlKeyRefused() => injectFailure();
}
