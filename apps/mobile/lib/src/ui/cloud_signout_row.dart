// SPEC-REF:
//   docs/strategy/2026-08-02-l3-account-card-design.md §5 (the phone settings
//     page's cloud block)
//   owner 2026-08-02 form ruling:「设置页那一块不放退出本身，而是放一个『前往…』的
//     跳转按钮 ⇒ 危险动作只有一个落点」("the settings-page block does not host
//     sign-out itself, but a 'go to…' navigation button instead ⇒ the
//     dangerous action has only one landing point")
//   CLAUDE.md red line: no silent failure (banned in both directions)
//
// The **ONLY** UI landing point for signing out of the cloud login: the
// cloud-instance representation on the device page (the instance list).
// Host is either the dashed entry card OR the remembered saas pairing row
// (GA-33 retires the dashed card once that row exists — A2 device-found
// 2026-08-11: parking sign-out only on the dashed card made it vanish when signed
// in). At most one host is mounted. Settings still only navigates here.
//
// 🔴 Premise correction (verified against the code, contradicting owner's
// account): owner's original premise was 「the phone device page has
// sign-out, settings does not」. On starting work, `grep -rn "logout()"
// apps/mobile/lib` came back with
// **only ONE production call site, in settings_page.dart** — none at all on
// the device page. Doing it literally (swap that settings-page
// sign-out for a button pointing at the device page) would leave the user
// with no way to sign out at all, and turn the button's copy into a
// promise that greps to nothing. So what happens here is moving **the
// same** `login.logout()` call over,
// not writing a second one — after the move it still has exactly one
// production call site.
//
// ⚠️ This step touches `connections_page.dart` (beyond the literal scope
// owner gave L3, 「the settings page's cloud block」), for the reason above,
// already accounted for explicitly in the design doc §5.2.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:url_launcher/url_launcher.dart';

import '../auth/login_controller.dart';
import '../session/connections_controller.dart';
import '../settings/app_strings.dart';
import '../support/legal_urls.dart' show kAccountPageUrl;
import 'confirm_dialog.dart';
import 'tokens.dart';

/// The signed-in identity + the sign-out affordance, for the cloud instance card.
/// Renders NOTHING when signed out — the card's own tap already drives to login,
/// and a 「退出」("sign out") that cannot do anything would be the same façade as a disabled
/// button nobody can explain.
/// Opens the account page in an external browser. Production is [launchUrl];
/// tests inject a recorder, so 「the link works」 is proven by the call and not
/// by a widget existing (the same seam `data_flow_disclosure_page.dart` uses,
/// and for the same reason).
typedef AccountUrlLauncher = Future<bool> Function(
  Uri url, {
  required LaunchMode mode,
});

Future<bool> _launchAccountUrl(Uri url, {required LaunchMode mode}) =>
    launchUrl(url, mode: mode);

class CloudSignOutRow extends StatefulWidget {
  const CloudSignOutRow({
    super.key,
    required this.login,
    required this.connections,
    required this.strings,
    this.urlLauncher = _launchAccountUrl,
  });

  /// Test seam for the account link. Production leaves the default.
  final AccountUrlLauncher urlLauncher;

  final LoginController login;

  /// A2 (owner 2026-08-11) — the sign-out verb is now
  /// [ConnectionsController.signOutCloud], which wraps `login.logout()` with the
  /// two session-scope halves logout() cannot reach (drop a live cloud session,
  /// purge the cloud-instance pairing rows minted under the old account).
  /// REQUIRED, not an optional callback: an optional that defaults to the bare
  /// logout would be a friendly-empty DI default — the exact façade shape
  /// CLAUDE.md anti-façade ② bans.
  final ConnectionsController connections;
  final AppStrings strings;

  @override
  State<CloudSignOutRow> createState() => _CloudSignOutRowState();
}

class _CloudSignOutRowState extends State<CloudSignOutRow> {
  Future<void> _signOut() async {
    final AppStrings s = widget.strings;
    // The second confirmation goes through the same confirmDestructive every
    // destructive action goes through (owner
    // 2026-07-27), the copy spells out exactly what is lost: the local
    // login is cleared, records are unaffected, the account will not be
    // deleted.
    // REQ-12-01: the three load-bearing clauses are all still here — the loss in
    // `message`, the two survivals in `unaffected`. Splitting them is the whole
    // change: they answer OPPOSITE questions and used to be one grey paragraph.
    final bool ok = await confirmDestructive(
      context,
      title: s.logoutConfirmTitle,
      message: s.logoutConfirmBody,
      unaffectedLabel: s.confirmUnaffectedLabel,
      unaffected: <String>[
        s.logoutConfirmKeepsRecords,
        s.logoutConfirmKeepsAccount,
      ],
      confirmLabel: s.logoutConfirmAction,
      cancelLabel: s.cancel,
    );
    if (!ok || !mounted) return;
    // A2: the session-aware sign-out (ends a live cloud session + purges the
    // old account's cloud-instance pairing rows), which itself awaits the one
    // `login.logout()` — there is still exactly one account-clearing verb.
    await widget.connections.signOutCloud();
    if (!mounted) return;
    // The other half of 「没做成的事不许说成做成了」("must not say a thing that
    // failed succeeded"): the local device is definitely signed out, the
    // server may not have heard about it.
    // LoginController has already recorded that half of the fact on
    // `logoutNotice` — say it out loud, rather than letting
    // silence claim on its behalf that the cloud session has been revoked.
    final String? notice = widget.login.logoutNotice;
    if (notice != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.logoutNotice(notice))),
      );
    }
    setState(() {});
  }

  /// ST-2 — the way to the account page. FAIL LOUDLY when nothing takes the
  /// URL: the address is copied and the user is told, exactly as the disclosure
  /// page does. A link that silently does nothing is the same façade as a dead
  /// button, and on this particular row it would be worse — a user looking for
  /// how to delete their account would conclude there is no way.
  Future<void> _openAccountPage() async {
    final AppStrings s = widget.strings;
    bool opened = false;
    try {
      opened = await widget.urlLauncher(
        Uri.parse(kAccountPageUrl),
        mode: LaunchMode.externalApplication,
      );
    } catch (_) {
      opened = false;
    }
    if (opened || !mounted) return;
    // 🔴 SAY IT FIRST, COPY SECOND, and the order is the point. Telling the user
    // is the half that must happen; putting the clipboard write ahead of it made
    // the sentence depend on a platform channel — measured while writing the
    // test for this path: the snackbar never appeared, because the await ahead
    // of it never came back in that environment. A message that a side errand
    // can swallow is the silent failure this row exists to avoid.
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('${s.discOpenFailed}\n$kAccountPageUrl')),
    );
    try {
      await Clipboard.setData(const ClipboardData(text: kAccountPageUrl));
    } catch (_) {
      // The address is on screen and selectable-by-eye either way; a clipboard
      // that refuses is not worth a second error message.
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.login.isLoggedIn) return const SizedBox.shrink();
    final String email = widget.login.email ?? '';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _identityRow(email),
        // Its own line, below the destructive chip rather than beside it: the
        // sign-out ruling gives a dangerous action one landing point and one
        // undivided target, and crowding a second tappable into that Row is how
        // a near-miss ends up signing someone out.
        GestureDetector(
          key: const ValueKey<String>('cloud.account.manage'),
          behavior: HitTestBehavior.opaque,
          onTap: _openAccountPage,
          child: Padding(
            padding: const EdgeInsets.only(top: 8, bottom: 2),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  widget.strings.accountManageLink,
                  style: TextStyle(
                    color: FlowMicColors.brand,
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  widget.strings.accountManageNote,
                  style: TextStyle(color: FlowMicColors.t3, fontSize: 11),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _identityRow(String email) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: <Widget>[
          if (email.isNotEmpty)
            Flexible(
              child: Text(
                email,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: FlowMicColors.t2, fontSize: 11.5),
              ),
            ),
          const SizedBox(width: 10),
          // Its own gesture inside a tappable card: the inner detector wins, so
          // tapping sign-out never also opens the cloud instance.
          //
          // REQ-12-01 — it used to be a bare `Text` under a `GestureDetector`
          // whose default `deferToChild` made the hit box the GLYPHS: about
          // 26×14 logical px for 「登出」("sign out"). Two bad outcomes from
          // one cause, and
          // they pull in opposite directions, which is why padding is the fix
          // rather than moving the control: a near-miss activated the CARD (=
          // enter the cloud instance) instead of doing nothing, and hitting it
          // on purpose took aim. Now it is an opaque red-tinted chip.
          // ⚠️ Honest about what this is NOT: 30dp tall, not Material's 48dp.
          // This row sits inside a card header, and 48 would push the identity
          // line apart. The claim here is「a real control instead of a word」,
          // not「meets the tap-target minimum」.
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: _signOut,
            child: Container(
              constraints: const BoxConstraints(minHeight: 30),
              alignment: Alignment.center,
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
              decoration: BoxDecoration(
                color: FlowMicColors.redSoft,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                widget.strings.logout,
                style: TextStyle(
                  color: FlowMicColors.red,
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
