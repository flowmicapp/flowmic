// SPEC-REF:
//   docs/decisions/2026-08-27-owner-no-password-login-on-clients.md (owner
//     ruling, card NR-2b: THE CLIENTS CARRY NO USERNAME/PASSWORD LOGIN. The
//     phone gets exactly two entries — 「用浏览器登录」 (sign in with the browser)
//     and 「扫码登录」 (scan the QR, the existing GA-31 mechanism). Registration,
//     verification and password recovery live on the web only.)
//   docs/decisions/2026-08-11-owner-mobile-register-removed-guide-to-website.md
//     (the earlier half of the same movement: no in-app registration)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R3-3 (fail-loud when the server login
//     handler is a stub — never fabricate success)
//
// The cloud-instance sign-in sheet. TWO entries and nothing else.
//
// 🔴 WHAT LEFT, AND WHY IT IS NOT A REGRESSION. The email field, the password
// field, the submit button and the 「忘记密码」 ("forgot password") line are gone.
// The last of those was the plainest façade in this file: static text, no tap
// handler, no recovery flow behind it — a control that answered a question the
// app could not answer. The account business it implied (create an account,
// verify a mail, reset a password, sign in with Google) all exists, on the web,
// and the browser entry now takes the user there instead of imitating a fifth
// of it here.
//
// 🔴 TWO CONTROLLERS, TWO QUESTIONS. [LoginController] answers 「what did the
// account server say」; [BrowserLoginController] answers 「did the round trip
// through the browser complete」. Both errors can be on screen and they are
// rendered from different fields, because a server that refused an expired code
// and a browser that never came back need opposite actions from the user.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import '../auth/account_mask.dart';
import '../auth/browser_login.dart' show BrowserLoginCodes;
import '../auth/browser_login_controller.dart';
import '../auth/deep_link_source.dart';
import '../auth/login_controller.dart';
import '../settings/app_strings.dart';
import 'scan_payload.dart';
import 'scan_sheet.dart';
import 'tokens.dart';

/// Presents the login sheet. Resolves to true iff the user ended up logged in.
///
/// [browserLogin] is a TEST SEAM: production leaves it null and the sheet builds
/// the real controller (system browser + app_links + shared_preferences). It is
/// not defaulted to a friendly no-op — a widget test that wants the browser
/// entry must hand in a controller carrying its own fakes, which is also the
/// only way a test can prove anything about this flow at all.
Future<bool> showLoginSheet(
  BuildContext context, {
  required LoginController controller,
  required AppStrings strings,
  BrowserLoginController? browserLogin,
}) async {
  controller.clearError();
  final bool? result = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _LoginSheet(
      controller: controller,
      strings: strings,
      browserLogin: browserLogin,
    ),
  );
  return result ?? (controller.phase == LoginPhase.success);
}

class _LoginSheet extends StatefulWidget {
  const _LoginSheet({
    required this.controller,
    required this.strings,
    this.browserLogin,
  });
  final LoginController controller;
  final AppStrings strings;
  final BrowserLoginController? browserLogin;

  @override
  State<_LoginSheet> createState() => _LoginSheetState();
}

class _LoginSheetState extends State<_LoginSheet> {
  late final BrowserLoginController _browser;

  /// True only when this state built the controller, i.e. only then may it
  /// dispose it. A controller handed in by a test (or, later, by a caller that
  /// owns one for longer) belongs to whoever made it.
  late final bool _ownsBrowser;

  @override
  void initState() {
    super.initState();
    _ownsBrowser = widget.browserLogin == null;
    _browser =
        widget.browserLogin ??
        BrowserLoginController(
          login: widget.controller,
          links: AppLinksBrowserLoginLinks(),
          store: PrefsBrowserLoginStateStore(),
          opener: launchSignInInBrowser,
        );
    // COLD START. The OS is allowed to kill this app while the user is in the
    // browser, in which case the callback URL arrives as this process's LAUNCH
    // argument and no stream listener existed to receive it. Draining it here —
    // the moment the sign-in sheet is on screen — is what makes that path
    // complete instead of silently dropping a code the user did earn.
    unawaited(_browser.drainInitialLink());
  }

  @override
  void dispose() {
    if (_ownsBrowser) _browser.dispose();
    super.dispose();
  }

  /// GA-31 — scan the console's sign-in QR.
  ///
  /// A PAIRING code scanned here gets its own message: right app, wrong screen.
  /// Sending it to the login call would produce AUTH_LOGIN_FAILED, which reads as
  /// 「the account or password is wrong」 for a user who typed no password at all
  /// — and after this card, for a user who CANNOT type one.
  Future<void> _scanLogin() async {
    final AppStrings s = widget.strings;
    await showScanSheet(
      context,
      strings: s,
      title: s.loginScanTitle,
      hint: s.loginScanHint,
      onScan: (String value) async {
        final LoginScan? scan = parseLoginLink(value);
        if (scan == null) {
          if (!mounted) return false;
          final ScanResult r = classifyScan(value);
          _toast(r.verdict == ScanVerdict.pairLink ? s.loginScanIsPair : s.pairScanForeign);
          return false; // keep the camera running
        }
        await widget.controller.loginWithQr(nonce: scan.nonce, endpoint: scan.endpoint);
        return true;
      },
    );
    if (!mounted) return;
    // The controller's phase drives the sheet exactly as the browser flow does —
    // success closes it, a failure shows the same loud, mapped code.
    if (widget.controller.phase == LoginPhase.success) Navigator.of(context).pop(true);
  }

  Future<void> _startBrowserLogin() async {
    widget.controller.clearError();
    _browser.clearError();
    await _browser.start();
  }

  /// 🔴 THE SHEET HAS TO CLOSE ITSELF, and it is not cosmetic.
  ///
  /// The typed form used to dismiss on its own after the success tick, because
  /// the tap that submitted it was the last thing the user did. The browser
  /// round trip is not like that: the sign-in completes while the user is in
  /// ANOTHER APP, so they come back to a sheet already showing a green tick
  /// with nothing left to do on it. Leaving it open would make the last step of
  /// a working flow「now dismiss this yourself」.
  ///
  /// Guarded by [_closing] because both controllers notify and the builder runs
  /// on each — scheduling one pop per notification would pop the route more
  /// than once.
  bool _closing = false;
  void _closeOnSuccess() {
    if (_closing) return;
    _closing = true;
    // The same beat the typed form used, so the tick is seen rather than
    // flashed past.
    Future<void>.delayed(const Duration(milliseconds: 700), () {
      if (mounted) Navigator.of(context).pop(true);
    });
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings s = widget.strings;
    final double insets = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: insets),
      child: Container(
        decoration: BoxDecoration(
          color: FlowMicColors.surface,
          border: Border(top: BorderSide(color: FlowMicColors.line)),
          borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 22),
        // BOTH controllers drive this tree: the browser round trip changes the
        // phase without the account server saying anything, and the account
        // server answers without the browser controller moving.
        child: ListenableBuilder(
          listenable: Listenable.merge(<Listenable>[widget.controller, _browser]),
          builder: (BuildContext context, _) {
            if (widget.controller.phase == LoginPhase.success) {
              _closeOnSuccess();
              return _successBody(s);
            }
            return _formBody(s);
          },
        ),
      ),
    );
  }

  Widget _grab() => Center(
    child: Container(
      width: 36,
      height: 4,
      margin: const EdgeInsets.only(bottom: 14),
      decoration: BoxDecoration(
        color: FlowMicColors.line,
        borderRadius: BorderRadius.circular(99),
      ),
    ),
  );

  Widget _successBody(AppStrings s) => Column(
    mainAxisSize: MainAxisSize.min,
    children: <Widget>[
      _grab(),
      const SizedBox(height: 8),
      Container(
        width: 46,
        height: 46,
        decoration: BoxDecoration(
          color: FlowMicColors.greenSoft,
          shape: BoxShape.circle,
        ),
        child: Icon(Icons.check, color: FlowMicColors.green, size: 22),
      ),
      const SizedBox(height: 10),
      Text(
        s.tabLogin,
        style: TextStyle(
          color: FlowMicColors.t1,
          fontSize: 15,
          fontWeight: FontWeight.w700,
        ),
      ),
      const SizedBox(height: 4),
      // MASKED, like every other place this phone names the account (owner
      // 2026-08-27:「所有显示账号的地方都要用星号遮盖」). This tick is shown for
      // 700ms in a bottom sheet that anyone standing behind the user can read,
      // and it is the one render site where the address arrives from the wire
      // rather than from storage — which is exactly the kind of difference that
      // makes a sweep miss a site. One function, every site.
      Text(
        maskAccountEmail(widget.controller.email),
        style: TextStyle(color: FlowMicColors.t2, fontSize: 12),
      ),
      const SizedBox(height: 12),
    ],
  );

  Widget _formBody(AppStrings s) {
    final bool waiting = _browser.phase == BrowserLoginPhase.waiting;
    final bool busy = widget.controller.isBusy || _browser.isBusy;
    final String? loginErrorCode = widget.controller.errorCode;
    final String? browserErrorCode = _browser.errorCode;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _grab(),
        Row(
          children: <Widget>[
            Text(
              s.loginTitle,
              style: TextStyle(
                color: FlowMicColors.t1,
                fontSize: 15,
                fontWeight: FontWeight.w700,
              ),
            ),
            const Spacer(),
            InkWell(
              key: const ValueKey<String>('login.close'),
              onTap: () => Navigator.of(context).pop(false),
              child: Icon(Icons.close, color: FlowMicColors.t3, size: 18),
            ),
          ],
        ),
        const SizedBox(height: 12),
        // Entry ①: the browser. Primary, because it is the only entry that
        // works when the user has no PC in front of them.
        _primaryButton(
          key: const ValueKey<String>('login.browser.start'),
          label: busy
              ? (waiting ? s.browserLoginWaiting : s.connecting)
              : (browserErrorCode != null
                    ? s.browserLoginRetry
                    : s.browserLoginTitle),
          enabled: !busy,
          onTap: _startBrowserLogin,
        ),
        // 🔴 THE CANCEL IS NOT DECORATION. Nothing on either OS tells this app
        // that the user closed the browser tab, so without a way out the button
        // would sit in its waiting state until the timeout. The timeout is the
        // machine's answer to that; this is the user's.
        if (waiting) ...<Widget>[
          const SizedBox(height: 8),
          GestureDetector(
            key: const ValueKey<String>('login.browser.cancel'),
            onTap: () => unawaited(_browser.cancel()),
            child: Text(
              s.browserLoginCancel,
              textAlign: TextAlign.center,
              style: TextStyle(color: FlowMicColors.t3, fontSize: 12),
            ),
          ),
        ],
        const SizedBox(height: 10),
        if (browserErrorCode != null) ...<Widget>[
          _errorBanner(s.browserLoginError(browserErrorCode)),
          const SizedBox(height: 10),
        ],
        if (loginErrorCode != null) ...<Widget>[
          _errorBanner(s.loginError(loginErrorCode)),
          const SizedBox(height: 10),
        ],
        // Entry ②: GA-31 QR sign-in — the console draws a QR, this scans it.
        GestureDetector(
          key: const ValueKey<String>('login.scan.start'),
          onTap: busy ? null : _scanLogin,
          child: Container(
            height: 44,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              border: Border.all(color: FlowMicColors.line),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Icon(Icons.qr_code_scanner, size: 16, color: FlowMicColors.t2),
                const SizedBox(width: 8),
                Text(
                  s.loginScanTitle,
                  style: TextStyle(color: FlowMicColors.t2, fontSize: 13.5, fontWeight: FontWeight.w600),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 10),
        Text(
          s.loginFootnote,
          textAlign: TextAlign.center,
          style: TextStyle(color: FlowMicColors.t3, fontSize: 11),
        ),
        const SizedBox(height: 12),
        _browserGuidance(s),
      ],
    );
  }

  /// The explainer for entry ①, carrying the address in plain sight.
  ///
  /// 🔴 THE VISIBLE, COPYABLE ADDRESS IS THE FALLBACK, NOT A DECORATION. When
  /// the OS opens nothing — no browser installed, a launch refused, a locked-
  /// down device — [BrowserLoginCodes.openFailed] is shown and the only route
  /// left is the user typing this address somewhere themselves. That is the
  /// same argument the removed register footer was built on; what changed is
  /// the sentence above it, since registration now happens INSIDE this flow
  /// rather than on a page we merely point at.
  ///
  /// 🔴 …AND FROM 0.3.37 IT ALSO CARRIES THE ONE REFUSAL THIS APP CANNOT SEE
  /// (owner 2026-08-27 UAT ①, measured on a Lenovo tablet whose stock browser
  /// is the system default): Google's sign-in page refuses some built-in
  /// browsers outright, Chrome on the same device works. The note sits HERE,
  /// immediately above the address, because the action it asks for is 「open
  /// THAT address somewhere else」 — a sentence parked anywhere else would name
  /// a thing the user then has to go and find.
  ///
  /// ⚠️ IT IS DELIBERATELY NOT REPEATED ON THE FAILED/TIMED-OUT FACE, and that
  /// is not an omission. A refused browser produces no callback, so it lands on
  /// [BrowserLoginCodes.timedOut] — whose banner renders in `_formBody`, on
  /// THIS SAME SHEET, a few dp above this box. The note is already on screen at
  /// that moment; printing it twice would put one sentence in two places and
  /// make the second one look like a different answer.
  Widget _browserGuidance(AppStrings s) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: BoxDecoration(
      color: FlowMicColors.surface2,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          s.browserLoginHint,
          style: TextStyle(color: FlowMicColors.t2, fontSize: 11.5),
        ),
        const SizedBox(height: 6),
        Text(
          s.browserLoginBrowserRefused,
          key: const ValueKey<String>('login.browser.refusedNote'),
          style: TextStyle(color: FlowMicColors.t3, fontSize: 11),
        ),
        const SizedBox(height: 6),
        Row(
          children: <Widget>[
            Expanded(
              child: SelectableText(
                _browser.signInPageUrl,
                style: TextStyle(color: FlowMicColors.brand, fontSize: 11.5),
              ),
            ),
            const SizedBox(width: 8),
            InkWell(
              key: const ValueKey<String>('login.register.copyUrl'),
              onTap: () {
                Clipboard.setData(
                  ClipboardData(text: _browser.signInPageUrl),
                );
                _toast(s.registerLinkCopied);
              },
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(Icons.copy_outlined, size: 13, color: FlowMicColors.brand),
                  const SizedBox(width: 4),
                  Text(
                    s.registerCopyLink,
                    style: TextStyle(color: FlowMicColors.brand, fontSize: 11),
                  ),
                ],
              ),
            ),
          ],
        ),
      ],
    ),
  );

  Widget _errorBanner(String message) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: BoxDecoration(
      color: FlowMicColors.redSoft,
      border: Border.all(color: const Color(0x4DF87171)),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      children: <Widget>[
        const Icon(Icons.error_outline, size: 14, color: Color(0xFFFCA5A5)),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            message,
            style: const TextStyle(color: Color(0xFFFCA5A5), fontSize: 12),
          ),
        ),
      ],
    ),
  );

  Widget _primaryButton({
    required Key key,
    required String label,
    required bool enabled,
    required VoidCallback onTap,
  }) => Opacity(
    opacity: enabled ? 1 : 0.5,
    child: GestureDetector(
      key: key,
      onTap: enabled ? onTap : null,
      child: Container(
        height: 46,
        alignment: Alignment.center,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          gradient: const LinearGradient(colors: <Color>[Color(0xFF5B54E8), Color(0xFF7C74F2)]),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Text(
          label,
          textAlign: TextAlign.center,
          style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w600),
        ),
      ),
    ),
  );
}
