// SPEC-REF:
//   docs/legal/privacy-policy.md 「What happens to your voice」 / 「Who else sees
//     your data」 — the authoritative text this page summarises.
//   docs/rebuild/13-LESSONS-LEARNED.md §7 F2 (never state an unfinished thing as
//     done) — why the LAN-encryption paragraph stays on this page: it answers
//     THIS pairing, which the website cannot know.
//
// 0.3.0 P1 — the in-product disclosure of the CORE path.
//
// WHY THIS PAGE EXISTS. The measurement that opened the card: `soniox` and
// `deepseek` appeared ZERO times in either end's source, neither app had a
// privacy, terms or consent surface, and the ONE screen that explained what
// leaves the device was the scenario-inference consent panel — which covers a
// single optional feature (the focused executable's basename on the PC). The
// path every sentence actually takes had no description anywhere in the product.
//
// WHERE IT IS REACHED FROM. The connections page — the home screen, the first
// thing a new install shows, BEFORE any pairing exists and therefore before the
// user has said a word. That placement is the requirement, not a preference:
// a disclosure the user meets after speaking has already missed its purpose.
//
// 🔴 LEGAL PAGES ARE LIVE (2026-08-14). The previous block here said the
// documents were unpublished and therefore must not be linked. That sentence
// expired the day https://flowmic.app/privacy and /terms returned HTTP 200.
// This page opens those two URLs in the external browser. The earlier claim
// that url_launcher could not be added (file_picker 11 / win32 ^5) was true
// about the pins and false about this package — dry-run resolved cleanly.
//
// 🔴 FAIL LOUDLY. launchUrl returning false or throwing is not a no-op: the
// user is told, and a copy-to-clipboard control becomes reachable. A button
// that does nothing when tapped is worse than the copy control this replaced.
//
// 🔴 THE COPY IS NOT OWNED HERE. Every sentence lives in
// settings/strings/disclosure_strings.dart with its code coordinate, in four
// languages, and is the summary of the policy — changed in the same batch as the
// policy. This file only lays it out.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:url_launcher/url_launcher.dart';

import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import '../support/legal_urls.dart';
import 'tokens.dart';

/// Opens [url] in an external application. Returns whether a handler took it.
///
/// Production uses [_launchDisclosureUrl]. Tests inject a recording fake so
/// a tap is proven by the call, not by a widget existing.
typedef DisclosureUrlLauncher = Future<bool> Function(
  Uri url, {
  required LaunchMode mode,
});

Future<bool> _launchDisclosureUrl(
  Uri url, {
  required LaunchMode mode,
}) =>
    launchUrl(url, mode: mode);

class DataFlowDisclosurePage extends StatelessWidget {
  const DataFlowDisclosurePage({
    super.key,
    required this.appSettings,
    this.urlLauncher = _launchDisclosureUrl,
  });

  /// Listened to, not read once: the UI language is an explicit setting and
  /// switching it must re-render this page like every other screen. Reading
  /// `appSettings.locale` at construction time would freeze the disclosure into
  /// whichever language happened to be selected when it was opened.
  final AppSettingsController appSettings;

  /// Test seam. Production leaves the default, which is [launchUrl].
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
              s.discTitle,
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
                  s.discEntrySub,
                  style: TextStyle(color: FlowMicColors.t2, fontSize: 12.5, height: 1.6),
                ),
                const SizedBox(height: 10),
                Text(
                  s.discLead,
                  style: TextStyle(color: FlowMicColors.t3, fontSize: 12.5, height: 1.65),
                ),
                const SizedBox(height: 14),
                // WP3 C16 (owner 2026-08-17: a simple DIAGRAM plus short
                // explanation — the diagram is the explanation, the text is
                // the caption). Five nodes on one vertical rail, drawn with
                // widgets and tokens — never a raster image: an image cannot
                // be localised and a screen reader cannot read it. Step 2's
                // three engine cases hang off their node as branches.
                _card(<Widget>[
                  _node(
                    icon: Icons.mic_none_rounded,
                    title: s.discStep1Title,
                    body: s.discStep1Body,
                    first: true,
                  ),
                  _node(
                    icon: Icons.graphic_eq_rounded,
                    title: s.discStep2Title,
                    body: s.discStep2Body,
                    branches: <String>[
                      s.discStep2Cloud,
                      s.discStep2Byok,
                      s.discStep2Local,
                    ],
                  ),
                  _node(
                    icon: Icons.auto_awesome_outlined,
                    title: s.discStep3Title,
                    body: s.discStep3Body,
                  ),
                  _node(
                    icon: Icons.computer_rounded,
                    title: s.discStep4Title,
                    body: s.discStep4Body,
                    // State-dependent truth, amber: which pairings are
                    // encrypted depends on how each was made, and the copy
                    // points at 「Connection encryption」 for THIS one's state.
                    warn: s.discStep4LanPlain,
                  ),
                  _node(
                    icon: Icons.inventory_2_outlined,
                    title: s.discStep5Title,
                    body: s.discStep5Body,
                    last: true,
                  ),
                ]),
                const SizedBox(height: 10),
                // Where the two moved claim families went (WP3 C16: the
                // engine-selection order and the LAN-TLS fine print live in
                // the privacy policy; this line is the pointer, so shortening
                // the page never silently shortened the product's story).
                Text(
                  s.discDetailsOnSite,
                  style: TextStyle(color: FlowMicColors.t3, fontSize: 11.5, height: 1.6),
                ),
                const SizedBox(height: 12),
                _card(<Widget>[
                  _stepTitle(s.discLegalTitle),
                  _LegalLink(
                    controlKey: 'disclosure.legal.privacy',
                    copyKey: 'disclosure.legal.privacy.copy',
                    label: s.discLegalPrivacy,
                    url: kPrivacyPolicyUrl,
                    openLabel: s.discOpenInBrowser,
                    copyLabel: s.discCopyLink,
                    copiedToast: s.discLinkCopied,
                    openFailed: s.discOpenFailed,
                    urlLauncher: urlLauncher,
                  ),
                  const SizedBox(height: 10),
                  _LegalLink(
                    controlKey: 'disclosure.legal.terms',
                    copyKey: 'disclosure.legal.terms.copy',
                    label: s.discLegalTerms,
                    url: kTermsOfServiceUrl,
                    openLabel: s.discOpenInBrowser,
                    copyLabel: s.discCopyLink,
                    copiedToast: s.discLinkCopied,
                    openFailed: s.discOpenFailed,
                    urlLauncher: urlLauncher,
                  ),
                ]),
                const SizedBox(height: 12),
                Text(
                  s.discScopeNote,
                  style: TextStyle(color: FlowMicColors.t3, fontSize: 11.5, height: 1.6),
                ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _card(List<Widget> children) => Container(
    padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
    decoration: BoxDecoration(
      color: FlowMicColors.surface,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: FlowMicColors.line),
    ),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
  );

  /// One diagram node: an icon dot on the shared vertical rail, the step's
  /// name beside it, the caption underneath, optional engine branches and the
  /// amber state-dependent note. [IntrinsicHeight] is what lets the rail's
  /// connector stretch to the node's full height, so the line is continuous
  /// whatever each caption's wrap count is.
  Widget _node({
    required IconData icon,
    required String title,
    required String body,
    List<String> branches = const <String>[],
    String? warn,
    bool first = false,
    bool last = false,
  }) => IntrinsicHeight(
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        SizedBox(
          width: 26,
          child: Column(
            children: <Widget>[
              SizedBox(
                height: 4,
                child: first ? null : Center(child: _railLine()),
              ),
              Container(
                width: 24,
                height: 24,
                decoration: BoxDecoration(
                  color: FlowMicColors.tealSoft,
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, size: 14, color: FlowMicColors.teal),
              ),
              if (!last) Expanded(child: _railLine()),
            ],
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Padding(
            padding: EdgeInsets.only(bottom: last ? 0 : 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.only(top: 4, bottom: 4),
                  child: Text(
                    title,
                    style: TextStyle(
                      color: FlowMicColors.t1,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Text(
                  body,
                  style: TextStyle(color: FlowMicColors.t2, fontSize: 12.5, height: 1.6),
                ),
                for (final String branch in branches)
                  Padding(
                    padding: const EdgeInsets.only(top: 6, left: 2),
                    child: Text(
                      branch,
                      style: TextStyle(color: FlowMicColors.t3, fontSize: 12, height: 1.55),
                    ),
                  ),
                if (warn != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      warn,
                      style: TextStyle(color: FlowMicColors.amber, fontSize: 12, height: 1.55),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    ),
  );

  Widget _railLine() => Container(width: 2, color: FlowMicColors.line);

  Widget _stepTitle(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 5),
    child: Text(
      text,
      style: TextStyle(color: FlowMicColors.t1, fontSize: 13, fontWeight: FontWeight.w600),
    ),
  );
}

/// One named document. Primary tap opens the live URL; a failed or throwing
/// launch reveals the copy fallback and tells the user why.
class _LegalLink extends StatefulWidget {
  const _LegalLink({
    required this.controlKey,
    required this.copyKey,
    required this.label,
    required this.url,
    required this.openLabel,
    required this.copyLabel,
    required this.copiedToast,
    required this.openFailed,
    required this.urlLauncher,
  });

  final String controlKey;
  final String copyKey;
  final String label;
  final String url;
  final String openLabel;
  final String copyLabel;
  final String copiedToast;
  final String openFailed;
  final DisclosureUrlLauncher urlLauncher;

  @override
  State<_LegalLink> createState() => _LegalLinkState();
}

class _LegalLinkState extends State<_LegalLink> {
  bool _openFailed = false;

  Future<void> _open() async {
    bool opened = false;
    try {
      opened = await widget.urlLauncher(
        Uri.parse(widget.url),
        mode: LaunchMode.externalApplication,
      );
    } catch (_) {
      opened = false;
    }
    if (!mounted || opened) return;
    setState(() => _openFailed = true);
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(
        content: Text(widget.openFailed),
        action: SnackBarAction(
          label: widget.copyLabel,
          onPressed: _copy,
        ),
      ),
    );
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.url));
    if (!mounted) return;
    final ScaffoldMessengerState? messenger = ScaffoldMessenger.maybeOf(context);
    messenger
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
          widget.url,
          style: TextStyle(color: FlowMicColors.brand, fontSize: 12.5, height: 1.5),
        ),
        const SizedBox(height: 4),
        InkWell(
          key: ValueKey<String>(widget.controlKey),
          onTap: _open,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.open_in_new, size: 13, color: FlowMicColors.brand),
              const SizedBox(width: 4),
              Flexible(
                child: Text(
                  widget.openLabel,
                  style: TextStyle(color: FlowMicColors.brand, fontSize: 11),
                ),
              ),
            ],
          ),
        ),
        if (_openFailed) ...<Widget>[
          const SizedBox(height: 4),
          InkWell(
            key: ValueKey<String>(widget.copyKey),
            onTap: _copy,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(Icons.copy_outlined, size: 13, color: FlowMicColors.brand),
                const SizedBox(width: 4),
                Flexible(
                  child: Text(
                    widget.copyLabel,
                    style: TextStyle(color: FlowMicColors.brand, fontSize: 11),
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}
