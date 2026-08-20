// The iOS notify-only channel (owner 2026-08-20: mac/iOS get a reminder too).
//
// What this file pins, controller-level:
//   ① notify-only ALONE is enough to check — the dot can light on a build that
//     carries no installer at all;
//   ② 🔴 notify-only can NEVER install — `canInstall` stays false even when the
//     checker hands back a perfectly installable artifact. This is the line
//     that keeps the 2026-08-19 ruling (self-install and a store channel are
//     mutually exclusive) true on iOS by construction, not by copy;
//   ③ both flags off ⇒ maybeAutoCheck touches nothing (the TFA-folding
//     precondition the Android store artifact's marker-absence rests on —
//     asserted here at the behaviour level, measured at the byte level by
//     scripts/store-channel-gate.mjs).

import 'package:flowmic/src/update/update_check.dart';
import 'package:flowmic/src/update/update_controller.dart';
import 'package:flowmic/src/update/update_manifest.dart' show UpdateArtifact;
import 'package:flutter_test/flutter_test.dart';

import 'support/portable_fakes.dart' show FixedAppVersion;
import 'support/update_fakes.dart';

const String _sha = 'abc1230000000000000000000000000000000000000000000000000000000def';

UpdateCheckResult _storeNews() => const UpdateCheckResult(
  UpdateCheckOutcome.updateAvailable,
  latestVersion: '9.9.9',
  notesUrl: 'https://github.com/flowmicapp/flowmic/releases/tag/v9.9.9',
  storeChannel: true,
  storeUrl: 'https://testflight.apple.com/join/example',
);

void main() {
  test('notify-only alone is enough for the automatic check to go out', () async {
    int asked = 0;
    final UpdateController c = newTestUpdateController(
      version: const FixedAppVersion('0.3.11'),
      selfUpdateEnabled: false,
      notifyOnlyEnabled: true,
      checker: (({required String? currentVersion}) async {
        asked += 1;
        return _storeNews();
      }),
    );
    await c.maybeAutoCheck();
    expect(asked, 1);
    expect(c.hasUpdate, isTrue, reason: 'the gear dot reads this getter');
  });

  test('🔴 notify-only can NEVER install, even when handed an installable artifact', () async {
    final UpdateController c = newTestUpdateController(
      version: const FixedAppVersion('0.3.11'),
      selfUpdateEnabled: false,
      notifyOnlyEnabled: true,
      // An adversarial checker: a store-channel build somehow receives a
      // full apk entry (a tampered or mis-built manifest). The install gate
      // must hold on selfUpdateUsable, not on what the wire claims.
      checker: (({required String? currentVersion}) async => const UpdateCheckResult(
            UpdateCheckOutcome.updateAvailable,
            latestVersion: '9.9.9',
            installable: UpdateArtifact(
              kind: 'apk',
              locale: null,
              filename: 'FlowMic-9.9.9-release.apk',
              url: 'http://x.test/a.apk',
              sha256: _sha,
              size: 1,
            ),
            downloadUrl: 'http://x.test/a.apk',
          )),
    );
    await c.maybeAutoCheck();
    expect(c.hasUpdate, isTrue);
    expect(c.canInstall, isFalse, reason: 'notify-only must never grow an install button');
    // …and pressing the button anyway is a no-op, not a crash: the guard is
    // the first line of downloadAndInstall.
    await c.downloadAndInstall();
    expect(c.installBusy, isFalse);
    expect(c.downloadOutcome, isNull);
  });

  test('🔴 both flags off ⇒ the checker is never touched (the tree-shaking precondition)', () async {
    int asked = 0;
    final UpdateController c = newTestUpdateController(
      version: const FixedAppVersion('0.3.11'),
      selfUpdateEnabled: false,
      notifyOnlyEnabled: false,
      checker: (({required String? currentVersion}) async {
        asked += 1;
        return _storeNews();
      }),
    );
    await c.maybeAutoCheck();
    await c.checkNow();
    expect(asked, 0);
    expect(c.updateSectionEnabled, isFalse, reason: 'the card shows the static sentence');
  });

  test('the store probe does not silence a notify-only build — its job is precisely to keep checking', () async {
    int asked = 0;
    final UpdateController c = newTestUpdateController(
      version: const FixedAppVersion('0.3.11'),
      selfUpdateEnabled: false,
      notifyOnlyEnabled: true,
      storeProbe: () async => true,
      checker: (({required String? currentVersion}) async {
        asked += 1;
        return _storeNews();
      }),
    );
    await c.maybeAutoCheck();
    expect(asked, 1);
  });
}
