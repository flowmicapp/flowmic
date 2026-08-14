// SPEC-REF:
//   docs/strategy/2026-07-30-task-package-v1.md RV-60
//   CLAUDE.md red line: no silent failures — both directions forbidden (never
//   call a real drop "not dropped")
//
// RV-60: an EXPLICIT window while THIS phone opened the system photo picker.
// Not AppLifecycleState — any background would then look "expected", and a real
// drop outside the picker would be dressed up as fine. Only the code that
// opened the album may arm this; the cap is the hard upper bound so a user who
// stays in the picker forever cannot keep the soft alert forever.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../diag/diag_log.dart';

/// How long the soft "expected drop" posture may last. Past this, the drop is
/// treated as a real one even if the picker is still open.
const Duration kAlbumAwayCap = Duration(minutes: 10);

/// Process-wide latch: the photo picker is open on THIS phone right now.
///
/// Singleton for the same reason [DiagLog] is — socket disconnect forensic and
/// the chat banner both need the SAME answer without threading a handle through
/// every composition root. Tests reset via [resetForTest].
class AlbumAway extends ChangeNotifier {
  AlbumAway._();

  static final AlbumAway instance = AlbumAway._();

  bool _open = false;
  Timer? _cap;
  String? _closeReason;

  /// True from [open] until [close] (picker returned) or the cap fires.
  bool get isOpen => _open;

  /// Last close reason (`picker_returned` / `cap_expired` / …), for tests.
  String? get lastCloseReason => _closeReason;

  /// Arm the window. Idempotent while already open (a second open does not
  /// refresh the cap — the first open owns the deadline).
  void open({Duration cap = kAlbumAwayCap}) {
    if (_open) return;
    _open = true;
    _closeReason = null;
    diag('album_away.open', <String, Object?>{
      'cap_ms': cap.inMilliseconds,
    });
    _cap?.cancel();
    _cap = Timer(cap, () => close(reason: 'cap_expired'));
    notifyListeners();
  }

  /// End the window. Idempotent — a late [close] after the cap already fired
  /// is a no-op (the cap's reason stays).
  void close({required String reason}) {
    if (!_open) return;
    _open = false;
    _closeReason = reason;
    _cap?.cancel();
    _cap = null;
    diag('album_away.close', <String, Object?>{'reason': reason});
    notifyListeners();
  }

  /// Test-only: drop any open window without a forensic line.
  @visibleForTesting
  void resetForTest() {
    _cap?.cancel();
    _cap = null;
    _open = false;
    _closeReason = null;
  }
}
