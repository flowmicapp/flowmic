// SPEC-REF:
//   docs/decisions/2026-08-27-owner-no-password-login-on-clients.md (card NR-2b)
//   CLAUDE.md 反 façade ②: a DI default must be the real implementation or a
//     throw — never a friendly empty one, which is how a whole feature ships
//     wired to nothing and green.
//
// The three PLATFORM seams the browser sign-in round trip needs, and nothing
// else. Each one is an interface plus the one production implementation; every
// test drives a fake, so no test in this repo touches app_links, url_launcher
// or SharedPreferences for this flow.
//
// ⚠️ These are the only lines of this card that cannot be proven on the machine
// it was written on (Windows). The Android half is exercised by a real APK; the
// iOS half — the `CFBundleURLTypes` registration and whether app_links receives
// through this target's `SceneDelegate` — is CONFIG AND PLUGIN BEHAVIOUR that
// only a device on the mac line can answer. Repo law: a Windows gate has zero
// proving power over a non-Windows surface. Recorded as unproven, not as done.

import 'package:app_links/app_links.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

/// Incoming `flowmic://…` URLs, both halves of delivery:
///  · [stream] — the app is already running when the browser redirects;
///  · [initialLink] — the app was NOT running and the OS started it with the
///    URL. This is a normal outcome of the flow (the OS is free to kill a
///    backgrounded app while the user types a password), so it is a first-class
///    input here, not a corner case.
abstract class BrowserLoginLinks {
  Stream<Uri> get stream;

  /// The URL this process was launched with, or null. Answering the same URL on
  /// a second call is fine and expected — the caller de-duplicates.
  Future<Uri?> initialLink();
}

/// Production: the app_links plugin.
class AppLinksBrowserLoginLinks implements BrowserLoginLinks {
  AppLinksBrowserLoginLinks([AppLinks? links]) : _links = links ?? AppLinks();

  final AppLinks _links;

  @override
  Stream<Uri> get stream => _links.uriLinkStream;

  @override
  Future<Uri?> initialLink() => _links.getInitialLink();
}

/// Hand a URL to the system browser. True iff the OS accepted it.
///
/// ⚠️ True does NOT mean a browser is in front of the user — no OS tells us
/// that. It means the launch was accepted, which is exactly as much as the
/// desktop's `openExternalUrl` claims for the same reason.
typedef BrowserLoginOpener = Future<bool> Function(Uri url);

/// Production opener: the external browser, never an in-app webview.
///
/// 🔴 `LaunchMode.externalApplication` is load-bearing, not a preference. The
/// console redirects to `flowmic://login`, and a redirect to a foreign scheme
/// inside an in-app webview has nowhere to go — the OS-level browser is what
/// hands the URL back to us. It is also the honest surface for typing an
/// account password into: the user can see whose address bar it is.
///
/// Returns false instead of throwing when the platform refuses, so the caller
/// has one branch to render rather than two.
Future<bool> launchSignInInBrowser(Uri url) async {
  try {
    return await launchUrl(url, mode: LaunchMode.externalApplication);
  } on Object {
    return false;
  }
}

/// Where the pending [BrowserLoginRequest] survives a cold start.
abstract class BrowserLoginStateStore {
  Future<String?> read();
  Future<void> write(String value);
  Future<void> clear();
}

/// Production: one `shared_preferences` key.
///
/// ⚠️ Deliberately NOT `flutter_secure_storage`, which is where the JWT lives.
/// The stored value is a binding token: it grants nothing, it is compared and
/// then thrown away, and it is useless to anyone who cannot also mint the nonce
/// it will be checked against. Putting it in the secure store would suggest it
/// is a credential and would cost a keystore round trip on a screen that has to
/// feel instant.
class PrefsBrowserLoginStateStore implements BrowserLoginStateStore {
  static const String key = 'flowmic.auth.browserLogin.pending';

  @override
  Future<String?> read() async =>
      (await SharedPreferences.getInstance()).getString(key);

  @override
  Future<void> write(String value) async {
    await (await SharedPreferences.getInstance()).setString(key, value);
  }

  @override
  Future<void> clear() async {
    await (await SharedPreferences.getInstance()).remove(key);
  }
}

/// Test double. Production must never construct this — the controller takes the
/// store as a required argument precisely so forgetting it cannot compile.
class InMemoryBrowserLoginStateStore implements BrowserLoginStateStore {
  String? _value;

  @override
  Future<String?> read() async => _value;

  @override
  Future<void> write(String value) async => _value = value;

  @override
  Future<void> clear() async => _value = null;
}
