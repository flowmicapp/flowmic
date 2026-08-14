// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 B (two-state
//     destination; SESSION-scoped stickiness — reconnect/reopen returns to the
//     default inject state; the "跨会话粘滞+胶囊抑制" ("cross-session
//     stickiness + capsule suppression") silent trap is rejected),
//     §4.0 C (cloud instance is fixed record-only), §4.1 (focus:state → header
//     transient, never persisted)
//   docs/ui-design/demo/mobile.html (frames 2/9/12: → {app} / → — / → 仅记录 "record only")
//
// DestinationController owns the per-session destination choice and the
// transient PC-focus label. Two rules dominate: (1) the choice is SESSION
// stickiness only — reset() on every reconnect/reopen snaps it back to inject;
// (2) a cloud instance is FIXED to record-only and cannot toggle (the lock).

import 'package:flutter/foundation.dart';

import '../settings/app_strings.dart' show AppStrings;
import '../signaling/wire_payloads.dart' show Delivery;

enum DestinationMode {
  /// → deliver to the focused PC app.
  inject,

  /// → record only ("仅记录"): captured, never sent to the PC.
  recordOnly,
}

class DestinationController extends ChangeNotifier {
  DestinationController({bool fixedRecordOnly = false})
    : _fixed = fixedRecordOnly,
      _mode = fixedRecordOnly ? DestinationMode.recordOnly : DestinationMode.inject;

  DestinationMode _mode;
  bool _fixed;
  String? _focusApp;

  DestinationMode get mode => _mode;

  /// Cloud instance: the destination is pinned to record-only (🔒) and the
  /// toggle is inert.
  bool get isFixed => _fixed;

  /// The current PC focus-app label (focus:state). Transient: null when the
  /// focus is unknown or the link is down — it is NEVER persisted.
  String? get focusApp => _focusApp;

  /// The immutable per-utterance delivery this destination produces at
  /// audio:start. record-only → Delivery.none.
  Delivery get delivery =>
      _mode == DestinationMode.recordOnly ? Delivery.none : Delivery.inject;

  bool get isRecordOnly => _mode == DestinationMode.recordOnly;

  /// Header badge label. record-only → [AppStrings.recordOnly] (the ONE
  /// translation of 「仅记录」 — V2-07.7: it used to be a sixth hard-coded copy);
  /// inject → the focus app, or a neutral em-dash when no focus is known yet
  /// (demo frame 9). The controller holds NO user-visible copy of its own:
  /// the caller hands over the explicit-locale catalogue.
  String headerLabel(AppStrings strings) {
    if (isRecordOnly) return strings.recordOnly;
    final String? app = _focusApp;
    return (app != null && app.isNotEmpty) ? app : '—';
  }

  /// Toggle inject ⇄ record-only. Inert while fixed (cloud instance).
  void toggle() {
    if (_fixed) return;
    _mode = _mode == DestinationMode.inject
        ? DestinationMode.recordOnly
        : DestinationMode.inject;
    notifyListeners();
  }

  void setRecordOnly() {
    if (_fixed || _mode == DestinationMode.recordOnly) return;
    _mode = DestinationMode.recordOnly;
    notifyListeners();
  }

  void setInject() {
    if (_fixed || _mode == DestinationMode.inject) return;
    _mode = DestinationMode.inject;
    notifyListeners();
  }

  /// Re-scope for a cloud instance (pins record-only) or a paired PC (frees the
  /// toggle). Resets the current choice to the new default.
  void configureFixed({required bool fixedRecordOnly}) {
    _fixed = fixedRecordOnly;
    _mode = fixedRecordOnly ? DestinationMode.recordOnly : DestinationMode.inject;
    notifyListeners();
  }

  /// master-plan §4.0 B: SESSION stickiness only. A reconnect or app reopen
  /// snaps the destination back to the default inject state (a cloud instance
  /// stays pinned record-only). This is the deliberate rejection of cross-
  /// session stickiness — a sticky record-only across reconnects would be a
  /// silent "your words aren't reaching the PC" trap.
  void reset() {
    final DestinationMode next =
        _fixed ? DestinationMode.recordOnly : DestinationMode.inject;
    if (_mode == next) return;
    _mode = next;
    notifyListeners();
  }

  /// focus:state arrived — update the transient header label.
  void onFocusApp(String? app) {
    final String? next = (app != null && app.isNotEmpty) ? app : null;
    if (_focusApp == next) return;
    _focusApp = next;
    notifyListeners();
  }

  /// Link down: the focus label is transient and clears immediately (§4.1 —
  /// 断连即清, "clears the instant the link drops").
  void clearFocus() => onFocusApp(null);
}
