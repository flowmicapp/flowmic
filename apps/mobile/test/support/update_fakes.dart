// Test doubles for UP-2 (in-app update check + reminder).
//
// 🔴 These are LEGITIMATE doubles, not the friendly empty defaults 13 册 §7 F1 ②
// bans. [newTestUpdateController]'s checker does not answer "already latest" — it
// answers "unreachable", which is the truth about a controller with no network and no
// server. A double that quietly reported success here would make every settings
// test agree that updates work, which is precisely the shape this repo pays for.
//
// ⚠️ It also exists so a settings-page test never touches the real network: the
// production default of [UpdateController] IS a real HTTP call, by design
// (13 册 §7 F1 ②: DI defaults must not be a friendly empty implementation).

import 'package:flowmic/src/update/update_check.dart';
import 'package:flowmic/src/update/update_controller.dart';
import 'package:flowmic/src/update/update_prefs.dart';
import 'package:flowmic/src/portable/portable_ports.dart';

/// An [AppVersionPort] that answers a fixed string (or null).
///
/// ⚠️ `FixedAppVersion` already exists in support/portable_fakes.dart; this file
/// deliberately does NOT define a second one — it re-exports nothing and callers
/// import that one. Two doubles answering "which version am I" would be the repo's #1
/// shape in the test harness itself.
typedef UpdateCheckStub = Future<UpdateCheckResult> Function({
  required String? currentVersion,
});

/// A controller wired to fakes: no network, no shared_preferences.
///
/// [outcome] defaults to "unreachable" — see the header for why that, and not
/// "already latest", is the honest resting answer for a controller with no server.
/// 🔴 **[downloader] / [installer] deliberately have no default doubles; they
/// are passed through as-is (null ⇒ production implementation).**
///
/// Unlike the [checker] double above — that one exists because **every**
/// settings-page test constructs a controller, and they must never touch the
/// real network. The download/install path is only taken when **that button is
/// pressed**, and a test that presses it **must say what it expects to happen**.
/// Stuffing a "defaults to success" downloader here would let every assertion
/// about "what happens when the hash does not match" pass on a double that
/// never read a single byte (13 册 §7 F1 ②).
UpdateController newTestUpdateController({
  AppVersionPort? version,
  UpdatePrefs? prefs,
  UpdateCheckStub? checker,
  UpdateDownloader? downloader,
  UpdateInstallRunner? installer,
  bool selfUpdateEnabled = true,
  DateTime Function()? now,
}) => UpdateController(
  version: version ?? const _NullVersion(),
  prefs: prefs ?? InMemoryUpdatePrefs(),
  selfUpdateEnabled: selfUpdateEnabled,
  now: now ?? DateTime.now,
  downloader: downloader,
  installer: installer,
  checker: checker ??
      (({required String? currentVersion}) async => const UpdateCheckResult(
            UpdateCheckOutcome.unreachable,
            detail: 'test double: no server',
          )),
);

/// Answers null — 「genuinely cannot be read」, the port's own documented case.
class _NullVersion implements AppVersionPort {
  const _NullVersion();
  @override
  Future<String?> appVersion() async => null;
}
