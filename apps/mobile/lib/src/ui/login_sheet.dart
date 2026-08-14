// SPEC-REF:
//   docs/ui-design/demo/mobile.html frame 10 (cloud-instance login — email/
//     password, forgot password,
//     unlocking the cloud instance after login); the demo's do-login state machine
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R3-3 (fail-loud when the server login
//     handler is a stub — never fabricate success)
//   docs/decisions/2026-08-11-owner-mobile-register-removed-guide-to-website.md
//     (owner ruling: NO in-app registration — account creation lives on the
//     official website; the app keeps sign-in, forgot-password and QR login)
//
// The cloud-instance login bottom sheet. Login submits mobile:login through the
// LoginController and shows whatever comes back — a success ONLY on an explicit
// ok ack, otherwise the loud error the controller produced. The register tab
// that used to live here was removed per the 2026-08-11 owner ruling; in its
// place a footer names the official website as the one place accounts are
// created, shows the URL and offers copy-to-clipboard (this app deliberately
// has no external-link opener — see help_link.dart for the rationale: a link
// affordance that opens nowhere is worse than a visible, copyable address).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import '../auth/login_controller.dart';
import '../auth/saas_endpoint.dart' show kDefaultSaasEndpoint;
import '../settings/app_strings.dart';
import 'scan_payload.dart';
import 'scan_sheet.dart';
import 'tokens.dart';

/// Where accounts are created. Derived from [kDefaultSaasEndpoint] so the
/// origin cannot drift from the one the app itself talks to.
///
/// ⚠️ Registration on the website is an IN-PAGE tab of `/signin` — there is no
/// `/register` path, do NOT invent one. And do NOT append a `?mode=create`
/// deep link either: today the web `SignInView`'s `mode` is local state only,
/// nothing parses a query param. If a deep link is ever wanted, the web side
/// must learn the query FIRST, and only then may this constant point at it.
const String kRegisterWebsiteUrl = '$kDefaultSaasEndpoint/signin';

/// Presents the login sheet. Resolves to true iff the user ended up logged in.
Future<bool> showLoginSheet(
  BuildContext context, {
  required LoginController controller,
  required AppStrings strings,
}) async {
  controller.clearError();
  final bool? result = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _LoginSheet(controller: controller, strings: strings),
  );
  return result ?? (controller.phase == LoginPhase.success);
}

class _LoginSheet extends StatefulWidget {
  const _LoginSheet({required this.controller, required this.strings});
  final LoginController controller;
  final AppStrings strings;

  @override
  State<_LoginSheet> createState() => _LoginSheetState();
}

class _LoginSheetState extends State<_LoginSheet> {
  final TextEditingController _email = TextEditingController();
  final TextEditingController _password = TextEditingController();

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    await widget.controller.login(email: _email.text, password: _password.text);
    if (widget.controller.phase == LoginPhase.success && mounted) {
      // Give the success tick a beat, then dismiss.
      await Future<void>.delayed(const Duration(milliseconds: 700));
      if (mounted) Navigator.of(context).pop(true);
    }
  }

  /// GA-31 — scan the console's sign-in QR.
  ///
  /// A PAIRING code scanned here gets its own message: right app, wrong screen.
  /// Sending it to the login call would produce AUTH_LOGIN_FAILED, which reads as
  /// 「the account or password is wrong」 for a user who typed no password at all.
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
    // The controller's phase drives the sheet exactly as a typed login does —
    // success closes it, a failure shows the same loud, mapped code.
    if (widget.controller.phase == LoginPhase.success) Navigator.of(context).pop(true);
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
        child: ListenableBuilder(
          listenable: widget.controller,
          builder: (BuildContext context, _) {
            if (widget.controller.phase == LoginPhase.success) {
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
      Text(
        widget.controller.email ?? '',
        style: TextStyle(color: FlowMicColors.t2, fontSize: 12),
      ),
      const SizedBox(height: 12),
    ],
  );

  Widget _formBody(AppStrings s) {
    final bool busy = widget.controller.isBusy;
    final String? errorCode = widget.controller.errorCode;
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
              onTap: () => Navigator.of(context).pop(false),
              child: Icon(Icons.close, color: FlowMicColors.t3, size: 18),
            ),
          ],
        ),
        const SizedBox(height: 12),
        _field(controller: _email, hint: s.emailHint, keyboard: TextInputType.emailAddress),
        const SizedBox(height: 10),
        _field(controller: _password, hint: s.passwordHint, obscure: true),
        const SizedBox(height: 6),
        Align(
          alignment: Alignment.centerRight,
          child: Text(
            s.forgotPassword,
            style: TextStyle(color: FlowMicColors.brand, fontSize: 11),
          ),
        ),
        const SizedBox(height: 12),
        if (errorCode != null) ...<Widget>[
          _errorBanner(s.loginError(errorCode)),
          const SizedBox(height: 10),
        ],
        _primaryButton(
          label: busy ? s.connecting : s.loginButton,
          enabled: !busy,
          onTap: _submit,
        ),
        // GA-31 QR-code sign-in: the console draws a QR, this scans it.
        const SizedBox(height: 10),
        GestureDetector(
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
        _registerGuidance(s),
      ],
    );
  }

  /// 2026-08-11 owner ruling: account creation happens on the official website
  /// only. This footer replaces the removed register tab — it names the fact,
  /// shows the address (selectable) and copies it on demand. No opener: the
  /// app deliberately ships without url_launcher (see help_link.dart).
  Widget _registerGuidance(AppStrings s) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: BoxDecoration(
      color: FlowMicColors.surface2,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          s.registerOnWebsite,
          style: TextStyle(color: FlowMicColors.t2, fontSize: 11.5),
        ),
        const SizedBox(height: 6),
        Row(
          children: <Widget>[
            Expanded(
              child: SelectableText(
                kRegisterWebsiteUrl,
                style: TextStyle(color: FlowMicColors.brand, fontSize: 11.5),
              ),
            ),
            const SizedBox(width: 8),
            InkWell(
              key: const ValueKey<String>('login.register.copyUrl'),
              onTap: () {
                Clipboard.setData(
                  const ClipboardData(text: kRegisterWebsiteUrl),
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

  Widget _field({
    required TextEditingController controller,
    required String hint,
    bool obscure = false,
    TextInputType? keyboard,
  }) => TextField(
    controller: controller,
    obscureText: obscure,
    keyboardType: keyboard,
    onChanged: (_) => widget.controller.clearError(),
    style: TextStyle(color: FlowMicColors.t1, fontSize: 13),
    decoration: InputDecoration(
      hintText: hint,
      hintStyle: TextStyle(color: FlowMicColors.t3, fontSize: 13),
      filled: true,
      fillColor: FlowMicColors.surface2,
      contentPadding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: FlowMicColors.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: FlowMicColors.brand),
      ),
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
    required String label,
    required bool enabled,
    required VoidCallback onTap,
  }) => Opacity(
    opacity: enabled ? 1 : 0.5,
    child: GestureDetector(
      onTap: enabled ? onTap : null,
      child: Container(
        height: 46,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          gradient: const LinearGradient(colors: <Color>[Color(0xFF5B54E8), Color(0xFF7C74F2)]),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Text(
          label,
          style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w600),
        ),
      ),
    ),
  );
}
