// SPEC-REF:
//   docs/ui-design/2026-08-06-fb3-fb4-composer-redesign.md §5 (FB-4 three
//     font-size tiers / 字号三档)
//   docs/decisions/2026-08-06-owner-rulings-ui-mcp-pairing.md D3 (1.00/0.92/0.85)
//   CLAUDE.md red line: settings apply and save immediately, no save button
//     (设置即改即存、无保存按钮)
//
// FB-4 —— the **sole point where the global three-tier font size takes
// effect** (phone side; owner explicitly ruled the PC side does not do this).
//
// Why this is a `MediaQuery` layer rather than editing those 173 `fontSize:`
// literals directly:
//   · those 173 spots are numbers from a **measured inventory** (design draft
//     §5); changing them one by one is 173 chances to get it wrong, and every
//     new screen added afterwards is one more spot that can be missed;
//   · `textScaler` is the layer Flutter already multiplies into every
//     `TextStyle.fontSize`, so "multiply uniformly" is the only implementation
//     in this framework that **cannot miss a spot**.
//   ⚠️ A font-size token SSOT (matching the treatment colour tokens get) is a
//     **future cleanup card**, explicitly out of scope for this one — this
//     approach does not depend on it, and it is written here so the next
//     person knows this is a debt, not something forgotten.
//
// 🔴 Why this is a NAMED widget rather than a closure inline in main.dart:
// `main()` needs sqflite / secure storage / platform channels to actually run,
// which a test cannot pump. An anonymous closure written inside `builder:`
// would therefore be **invisible to the entire test suite** — exactly the
// shape this repo's "wiring tests are mandatory" rule exists to prevent
// (0.2.51 tripped over this). After extracting it into a widget:
//   ① `text_scale_test.dart` pumps it directly and asserts the scaler in the
//      render tree;
//   ② the same test also re-reads `lib/main.dart`'s source, pinning down that
//      production really does mount it
//      (precedent: `first_run_locale_test.dart`'s structural guard).
// Neither check is optional: only ① would let "the widget works great but
// nobody uses it" stay all-green.

import 'package:flutter/material.dart';

import '../settings/app_settings.dart';

/// FB-4 —— **multiplies together** "the font size the user wants at the OS
/// level" and "the tier the user picked inside this App".
///
/// 🔴 Why NOT `TextScaler.linear(mq.textScaler.textScaleFactor * factor)`:
/// `textScaleFactor` is Flutter's already-deprecated **estimated value**, and
/// starting with Android 14 the system's own scaling is **non-linear**
/// (`PlatformDispatcher.scaleFontSize`: small text scales up more, large text
/// scales up less). Rebuilding a linear curve from that estimate would mean
/// swapping the user's system setting for an approximation — exactly the
/// "swallowing the system setting" this card explicitly forbids, just in a
/// form that is hard to notice (nothing looks wrong on screen, and the user
/// will never come report it). This instead **wraps around** the system
/// curve: let it finish computing along its own curve first, then multiply by
/// the tier factor.
///
/// ⚠️ `extends` rather than `implements`: the base class already supplies the
/// default implementation of `clamp()`; we only need to answer two questions
/// (`scale` and that legacy estimated value).
///
/// It lives in ui/ rather than in `app_settings.dart`: this is a **rendering**
/// concern, and that file is the settings controller — dragging painting into
/// the settings layer for the sake of one factor would be the wrong
/// direction. That file keeps only the lookup table (`AppTextScale`), because
/// the enum itself is half of the storage contract.
@immutable
class FlowMicTextScaler extends TextScaler {
  const FlowMicTextScaler({required this.system, required this.factor});

  /// The system's own curve (the one `MediaQuery` already carries; on a real
  /// device this is `SystemTextScaler`).
  final TextScaler system;

  /// [AppTextScale.factor].
  final double factor;

  @override
  double scale(double fontSize) => system.scale(fontSize) * factor;

  /// The legacy estimated value. The base class requires implementing it, so
  /// this can only faithfully relay the system curve's own estimate and then
  /// multiply by the tier — **no product logic anywhere is allowed to read
  /// it** (reading it is equivalent to flattening the non-linear curve back
  /// into a linear one).
  @override
  double get textScaleFactor =>
      // ignore: deprecated_member_use
      system.textScaleFactor * factor;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is FlowMicTextScaler &&
          other.system == system &&
          other.factor == factor;

  @override
  int get hashCode => Object.hash(system, factor);

  @override
  String toString() => 'FlowMicTextScaler($system × $factor)';
}

/// Multiplies [AppSettingsController.textScale] into this subtree's
/// `MediaQuery.textScaler`.
///
/// 🔴 **Multiply, do not replace** (this card's red line): `FlowMicTextScaler`
/// wraps around whatever `MediaQuery` already carries (on a real device,
/// `SystemTextScaler`, non-linear from Android 14 onward), letting the system
/// finish computing along its own curve before multiplying by the tier.
/// Replacing it instead would mean swallowing the accessibility setting for
/// "how large a font this phone's owner needs" — with nothing visibly wrong
/// on screen, a defect no user would ever come back to report.
class TextScaleScope extends StatelessWidget {
  const TextScaleScope({
    super.key,
    required this.appSettings,
    required this.child,
  });

  /// The SAME instance the settings page holds (the one handed down from
  /// main.dart's composition root), so "which tier is selected in settings"
  /// and "which tier the screen is currently laying out with" can never
  /// disagree.
  final AppSettingsController appSettings;

  final Widget child;

  @override
  Widget build(BuildContext context) {
    // ListenableBuilder: tap a chip → setTextScale → notifyListeners →
    // rebuild here → next frame the whole tree re-lays-out at the new tier.
    // **No restart required** (the visible face of the apply-and-save-
    // immediately red line).
    return ListenableBuilder(
      listenable: appSettings,
      builder: (BuildContext context, Widget? inner) {
        final MediaQueryData data = MediaQuery.of(context);
        return MediaQuery(
          data: data.copyWith(
            textScaler: FlowMicTextScaler(
              system: data.textScaler,
              factor: appSettings.textScale.factor,
            ),
          ),
          child: inner!,
        );
      },
      // `child` rides ListenableBuilder's own child slot: a tier change only
      // rebuilds this one MediaQuery layer, not the construction of the
      // entire app subtree (re-layout is handled by MediaQuery's own
      // dependency mechanism).
      child: child,
    );
  }
}
