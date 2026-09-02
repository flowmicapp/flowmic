// P2-7 (2026-09-02 audit) — `UpdateController.checkNow()` set `_checking =
// false` only on its success path (the last statement of the old body). A
// throw from `_prefs.setLastSuccessAt` — the one write in the method that was
// NOT already guarded by its own try/catch — left `_checking` latched `true`
// forever: `checkNow()`'s own guard (`if (!checkUsable || _checking) return;`)
// then makes every LATER tap of "check now" a silent no-op. Worse than a
// visibly-stuck spinner: nothing on screen says why the button stopped doing
// anything.

import 'package:flowmic/src/update/update_check.dart';
import 'package:flowmic/src/update/update_controller.dart';
import 'package:flowmic/src/update/update_prefs.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/update_fakes.dart';

/// A prefs backend that throws on its FIRST `setLastSuccessAt` call only (a
/// transient failure, the realistic shape) — proves BOTH that `_checking`
/// unlatches on the throw and that a later, otherwise-ordinary check still
/// works once the transient fault is gone.
class _ThrowingUpdatePrefs extends InMemoryUpdatePrefs {
  int calls = 0;

  @override
  Future<void> setLastSuccessAt(DateTime at) async {
    calls++;
    if (calls == 1) throw StateError('prefs exploded (test double)');
    await super.setLastSuccessAt(at);
  }
}

void main() {
  test(
      'a throw from the prefs write unlatches _checking — a LATER check must '
      'still run, not become a permanent no-op', () async {
    final _ThrowingUpdatePrefs prefs = _ThrowingUpdatePrefs();
    final UpdateController c = newTestUpdateController(
      prefs: prefs,
      checker: (({required String? currentVersion}) async =>
          UpdateCheckResult(
            UpdateCheckOutcome.upToDate,
            latestVersion: '9.9.9',
            comparedAt: DateTime.utc(2026, 8, 8, 9, 12),
          )),
    );
    await c.load();

    // First check: the prefs write throws. `checkNow()` was never guarded
    // against this write throwing (only the checker call had its own
    // try/catch), so the exception still propagates to the caller exactly as
    // it always did — the fix is that `checking` must still come back down
    // afterwards, not that this call stops throwing.
    Object? caught;
    try {
      await c.checkNow();
    } on Object catch (e) {
      caught = e;
    }
    expect(caught, isA<StateError>());
    expect(c.checking, isFalse,
        reason: 'a throw mid-check must still release the checking latch');
    expect(prefs.calls, 1);

    // 🔴 THE ASSERTION THAT MATTERS (P2-7). Before the fix, `_checking` stayed
    // `true` after the throw above, so THIS call would hit the early-return
    // guard and never touch the checker or the prefs a second time.
    await c.checkNow();
    expect(prefs.calls, 2,
        reason: 'a later, otherwise-ordinary check must still run to '
            'completion — it must not be swallowed by a stuck latch from the '
            'earlier throw');
    expect(c.checking, isFalse);
    expect(c.result?.outcome, UpdateCheckOutcome.upToDate);
  });
}
