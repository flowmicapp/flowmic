// Card WB-5a — the quota-rules guide: 「who pays for transcription」, stated for
// every case rather than for whichever one a live frame happens to name.
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §0.2 — the rule itself
//     (owner 2026-09-11 「只要有对端，就扣对端」, and the demo page's 120-second
//     per-browser cap, which is the only figure on this page).
//   docs/decisions/2026-09-12-owner-web-client-batch-image-upload-qr-only-and-hints.md
//     item 5 — owner removed the transcription-screen banner and asked for this
//     guide under the connections list instead. The web client shows the same
//     sentences after connecting, which is why they are also in
//     i18n/web/subset.json.
//   apps/mobile/lib/src/settings/strings/metering_strings.dart — the nine
//     languages and the reasoning for each line.
//
// 🔴 WHAT THIS PAGE MAY NOT DO, and each one is a rule this repo already paid
// for somewhere else:
//   · IT PRINTS NO FAR END'S REMAINDER. That number rides every
//     `billing:budget` frame and it is a stranger's commercial fact — the
//     restraint `sttStallIntegratorQuotaExceeded` states at length. The one
//     figure here is 120 seconds, and it is here because the RULE is that
//     number, not as decoration;
//   · IT ISSUES NO CALL TO ACTION ABOUT SIGNING IN. Signing in does not move
//     any ceiling this page describes, and an invitation to act would be a
//     control that changes nothing (the reason card G-2a renamed the web
//     client's sibling key away from `goUnsigned*`);
//   · IT DOES NOT CLAIM WHICH CASE IS HAPPENING NOW. It has no `payer` reader
//     and must not grow one: the phone cannot tell 「your own computer」 from
//     「somebody else's page」 off the wire, and a page that guessed would be
//     wrong for one of them on every open.
//
// 🔴 FAIL LOUDLY ON THE LINK. `launchUrl` returning false or throwing is not a
// no-op: the user is told and a copy control becomes reachable. Same shape,
// same strings, as `data_flow_disclosure_page.dart` — one wording for one
// action, on the two pages of this app that open a browser.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:url_launcher/url_launcher.dart';

import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import '../support/legal_urls.dart' show kBillingPageUrl;
import 'data_flow_disclosure_page.dart' show DisclosureUrlLauncher;
import 'tokens.dart';

/// The production launcher. [DisclosureUrlLauncher] is reused rather than
/// redeclared: a second typedef with the same shape would be a second answer to
/// 「how does this app open a browser」, and the two pages that open one
/// would then be free to drift.
Future<bool> _launchBillingUrl(Uri url, {required LaunchMode mode}) =>
    launchUrl(url, mode: mode);

class QuotaRulesPage extends StatelessWidget {
  const QuotaRulesPage({
    super.key,
    required this.appSettings,
    this.urlLauncher = _launchBillingUrl,
  });

  /// Listened to, not read once: the UI language is an explicit setting and
  /// switching it must re-render this page like every other screen.
  final AppSettingsController appSettings;

  /// Test seam. Production leaves the default.
  final DisclosureUrlLauncher urlLauncher;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: appSettings,
      builder: (BuildContext context, _) {
        final AppStrings s = AppStrings.of(appSettings.locale);
        return Scaffold(
          backgroundColor: FlowMicColors.canvas,
          appBar: AppBar(
            backgroundColor: FlowMicColors.canvas,
            surfaceTintColor: Colors.transparent,
            elevation: 0,
            iconTheme: IconThemeData(color: FlowMicColors.t2),
            title: Text(
              s.quotaRulesTitle,
              style: TextStyle(
                color: FlowMicColors.t1,
                fontSize: 16,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          body: SafeArea(
            top: false,
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(14, 6, 14, 28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    s.quotaRulesSub,
                    style: TextStyle(
                      color: FlowMicColors.t2,
                      fontSize: 12.5,
                      height: 1.6,
                    ),
                  ),
                  const SizedBox(height: 14),
                  _card(<Widget>[
                    // The five cases of 22 册 §0.2, in the order a reader meets
                    // them: the common one first, the refusal last.
                    _rule(s.quotaRulesLine1, first: true),
                    _rule(s.quotaRulesLine2),
                    _rule(s.quotaRulesLine3),
                    _rule(s.quotaRulesLine4),
                    _rule(s.quotaRulesLine5),
                  ]),
                  const SizedBox(height: 12),
                  Text(
                    s.quotaRulesClosing,
                    style: TextStyle(
                      color: FlowMicColors.t3,
                      fontSize: 11.5,
                      height: 1.6,
                    ),
                  ),
                  const SizedBox(height: 14),
                  _card(<Widget>[
                    _BillingLink(
                      label: s.quotaRulesConsoleLink,
                      openLabel: s.discOpenInBrowser,
                      copyLabel: s.discCopyLink,
                      copiedToast: s.discLinkCopied,
                      openFailed: s.discOpenFailed,
                      urlLauncher: urlLauncher,
                    ),
                  ]),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _card(List<Widget> children) => Container(
    padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
    decoration: BoxDecoration(
      color: FlowMicColors.surface,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: FlowMicColors.line),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    ),
  );

  /// One rule. The dot is drawn rather than typed so no language has to carry a
  /// bullet character in its data, and the text is [Expanded] so a long
  /// sentence WRAPS instead of being clipped — 0.2.53's defect was a sentence
  /// squeezed into a row that could not hold it.
  Widget _rule(String text, {bool first = false}) => Padding(
    padding: EdgeInsets.only(top: first ? 0 : 9),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Container(
            width: 5,
            height: 5,
            decoration: BoxDecoration(
              color: FlowMicColors.teal,
              shape: BoxShape.circle,
            ),
          ),
        ),
        const SizedBox(width: 9),
        Expanded(
          child: Text(
            text,
            style: TextStyle(
              color: FlowMicColors.t2,
              fontSize: 12.5,
              height: 1.6,
            ),
          ),
        ),
      ],
    ),
  );
}

/// The account's own billing page. Primary tap opens it; a failed or throwing
/// launch reveals the copy fallback and says why.
class _BillingLink extends StatefulWidget {
  const _BillingLink({
    required this.label,
    required this.openLabel,
    required this.copyLabel,
    required this.copiedToast,
    required this.openFailed,
    required this.urlLauncher,
  });

  final String label;
  final String openLabel;
  final String copyLabel;
  final String copiedToast;
  final String openFailed;
  final DisclosureUrlLauncher urlLauncher;

  @override
  State<_BillingLink> createState() => _BillingLinkState();
}

class _BillingLinkState extends State<_BillingLink> {
  Future<void> _open() async {
    bool opened = false;
    try {
      opened = await widget.urlLauncher(
        Uri.parse(kBillingPageUrl),
        mode: LaunchMode.externalApplication,
      );
    } catch (_) {
      opened = false;
    }
    if (!mounted || opened) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(
        content: Text(widget.openFailed),
        action: SnackBarAction(label: widget.copyLabel, onPressed: _copy),
      ),
    );
  }

  Future<void> _copy() async {
    await Clipboard.setData(const ClipboardData(text: kBillingPageUrl));
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(widget.copiedToast)));
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          widget.label,
          style: TextStyle(
            color: FlowMicColors.t1,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          kBillingPageUrl,
          style: TextStyle(
            color: FlowMicColors.brand,
            fontSize: 12.5,
            height: 1.5,
          ),
        ),
        const SizedBox(height: 4),
        InkWell(
          key: const ValueKey<String>('quotaRules.billing.open'),
          onTap: _open,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.open_in_new, size: 14, color: FlowMicColors.brand),
              const SizedBox(width: 6),
              Text(
                widget.openLabel,
                style: TextStyle(color: FlowMicColors.brand, fontSize: 12.5),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
