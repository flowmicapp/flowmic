// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §5.1 (mobile UI
//     sketch) / §5.0 (notice lifecycle) / §3 (failure-direction table)
//   docs/decisions/2026-08-02-in-app-update-both-ends.md (owner: auto-detect
//     + notify)
//   apps/mobile/lib/src/update/update_controller.dart (where the state comes
//     from)
//   CLAUDE.md red line: settings apply-and-persist instantly / no silent
//     failure / unknown ≠ up-to-date
//
// The settings page's "Update" section. **A file of its own, a section of its
// own**, deliberately NOT folded into `_aboutCard`: that card's `last:`
// divider ownership has already been changed once by P-7, and its own comment
// records, verbatim, what happens when 「谁是最后一行」 ("who is the last row")
// has two answers (settings_preferences.dart:212-216). Squeezing one more row
// in there would be the THIRD time touching that same thing — adding a
// section instead costs only one section title.
//
// ── 🔴 The one thing this file most needs to be understood correctly ────────
//
// **「已是最新」("up to date") and 「上次成功检查于 …」("last successful
// check at …") are drawn by the SAME function** ([_verdictBlock]), not two
// independently-judged branches. Design §5.0's tail names this the easiest
// silent failure to leave in this card: showing only 「已是最新」 without its
// evidence would make a client that has **never once checked successfully**
// look **identical** to one that **just checked**.
// ⇒ Writing them as one indivisible block makes it **impossible** for someone
// to later casually strip the evidence away — it does not rely on a comment
// asking them not to.
//
// ── UP-2b: that "download and install" button now genuinely exists ─────────
//
// ⚠️ **The previous round of this file said, verbatim, 「本轮没有任何一个『下
// 载并安装』按钮」 ("this round has no 'download and install' button at
// all"), reasoning that 「a control that does nothing is worse than no
// control at all」. That sentence was true then, and is not true now** —
// behind the button now sit update_download.dart (download + compute sha256
// + delete on mismatch) and update_installer.dart (hands off to the system
// package installer). The original sentence is not left here pretending it
// still holds.
//
// 🔴 **The button appears ONLY when we can genuinely install** ([UpdateController
// .canInstall]): the manifest for this release might ship a `portable-zip` /
// `dmg`, in which case `installable` is null, and the UI still gives an
// address instead of a button — exactly what the rule above is meant to
// prevent, and it has not been overturned by a single word.
//
// 🔴 **The download stage and the install stage each draw their own line**
// (the controller's file header: "download and install are two stages"):
// 「哈希不符」("hash mismatch") and 「你还没给安装权限」("you haven't granted
// install permission") are two completely different sentences pointing at
// two completely different actions, and they are never merged into one
// generic "install failed" here.
//
// ── ⚠️ The 「visible + copyable address」 fallback has not been removed ─────
//
// It is now **the button's own fallback when it fails** (both
// `updateInstallRefused` and `updateInstallUnsupported` point to it).
// ⚠️ **Why it is still not an "open download page" button**: this repo has
// **no `url_launcher` dependency** [measured: pubspec.yaml has no such entry].
// Introducing a new dependency for one sentence would perturb pub's
// resolution (`file_picker 11` already pins `win32` to ^5, which in turn pins
// `package_info_plus` to 9.x, per pubspec's own comment there). And the repo
// **already has a precedent**: `_aboutCard`'s help row already presents a raw
// URL as `SelectableText` for the user to grab themselves. Follow it.
//
// 🔴🔴 **IN-PLACE CORRECTION (0.3.28, 2026-08-24). The paragraph above is
// FALSE today, and it is kept verbatim because of what it was doing while it
// was false.** `url_launcher: ^6.3.1` has been in `apps/mobile/pubspec.yaml`
// since 2026-08-14 (0.2.66, commit 5078c38b) with two production callers
// (`ui/cloud_signout_row.dart`, `ui/data_flow_disclosure_page.dart`), and that
// commit's own note records the resolution worry as "true about the pins and
// false about this package — dry-run resolved cleanly".
//
// So for ten days this card carried a `[measured]` sentence whose measurement
// had expired, and that sentence was **the entire justification** for the one
// thing owner asked for on 2026-08-23: tell the user where the new version is,
// and if a store can install it, go straight there. This is the repo's
// anti-façade ④ shape at full size — a comment asserting the state of
// somewhere else, whose truth value moved when that somewhere else did, while
// the comment itself could not.
// ⇒ The addresses are now openable, and **the copy control stays**:
// `launchUrl` returns false and throws, and `data_flow_disclosure_page.dart`
// already fixed the rule for that ("FAIL LOUDLY"). A tap that does nothing is
// worse than the control it replaced.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:url_launcher/url_launcher.dart';

import '../auth/saas_endpoint.dart' show kDefaultSaasEndpoint;
import '../settings/app_strings.dart';
import '../update/install_source.dart' show storeListingUrls;
import '../update/update_check.dart';
import '../update/update_controller.dart';
import '../update/update_download.dart' show UpdateDownloadOutcome;
import '../update/update_installer.dart' show UpdateInstallOutcome;
import 'settings_widgets.dart';
import 'tokens.dart';

/// Opens [url] externally; returns whether anything took it.
///
/// A seam rather than a direct `launchUrl` call so a test can prove a tap by
/// **the call it made**, not by a widget existing — the same shape
/// `data_flow_disclosure_page.dart` uses, and for the same reason: a control
/// whose only evidence is that it renders is exactly the façade this repo keeps
/// finding.
typedef UpdateUrlLauncher = Future<bool> Function(
  Uri url, {
  required LaunchMode mode,
});

Future<bool> _launchUpdateUrl(Uri url, {required LaunchMode mode}) =>
    launchUrl(url, mode: mode);

/// Where a store-delivered copy should be sent. Seam for the same reason.
typedef StoreListingResolver = Future<List<String>> Function();

class SettingsUpdateCard extends StatelessWidget {
  const SettingsUpdateCard({
    super.key,
    required this.controller,
    required this.strings,
    this.urlLauncher = _launchUpdateUrl,
    this.storeListings = storeListingUrls,
  });

  final UpdateController controller;
  final AppStrings strings;

  /// Test seam. Production leaves the defaults.
  final UpdateUrlLauncher urlLauncher;
  final StoreListingResolver storeListings;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (BuildContext context, _) {
      // 🔴 An absent capability must be **visible**, the whole section may not
      // be hidden — a feature that quietly vanished and a feature that was
      // never built look identical to the user. The full reasoning is in
      // update/self_update_flag.dart's file header. `updateSectionEnabled`
      // covers both live forms: self-update (Android direct) and notify-only
      // (iOS) — a notify-only build still gets the full check UI below; what
      // it never gets is an install button (canInstall stays structurally
      // false there).
      if (!controller.updateSectionEnabled) {
        return _staticCard(
          strings.updateNotBundledTitle,
          strings.updateNotBundledNote,
        );
      }
      // Gate ② (update/install_source.dart): the build HAS the self-update
      // feature and a store delivered this copy, so the store updates it. A
      // separate sentence from the one above on purpose — see
      // update_strings.dart at these keys. Deliberately NOT short-circuited
      // for a notify-only build: its store probe answers false (the allow-list
      // is Android installer packages), and a notify-only build's job is
      // precisely to keep checking.
      if (controller.selfUpdateEnabled && controller.installedFromAppStore) {
        // 0.3.28 — this card named an action ("new versions arrive there") and
        // then offered no way to take it. owner 2026-08-23 asked for the
        // handoff; `storeListingUrls` supplies the candidates and answers with
        // an EMPTY list when it could not learn our own package name, in which
        // case the sentence stands alone exactly as before. A control that
        // cannot know where it would go is not offered.
        return _staticCard(
          strings.updateFromStoreTitle,
          strings.updateFromStoreNote,
          storeControl: true,
        );
      }
      return settingsCard(
        child: Column(
          children: <Widget>[
            settingsRow(child: _verdictBlock()),
            settingsRow(last: true, child: _controlsBlock()),
          ],
        ),
      );
    },
  );

  /// One shape, two facts: 「this build has no updater」 and 「a store updates
  /// this copy」 both render as a single explanatory row. The SHAPE is shared
  /// because it is the same kind of statement; the SENTENCES are not, and the
  /// caller picks which — never this method.
  Widget _staticCard(String title, String note, {bool storeControl = false}) =>
      settingsCard(
        child: settingsRow(
          last: true,
          child: Row(
            children: <Widget>[
              Icon(Icons.system_update_outlined, size: 20, color: FlowMicColors.t3),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(title, style: kRowTitle),
                    const SizedBox(height: 3),
                    Text(note, style: kRowSub),
                    if (storeControl) ...<Widget>[
                      const SizedBox(height: 8),
                      _StoreHandoff(
                        strings: strings,
                        urlLauncher: urlLauncher,
                        storeListings: storeListings,
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      );

  /// 🔴 **The verdict + its evidence, one block, indivisible.** See the file header.
  Widget _verdictBlock() {
    final UpdateCheckResult? r = controller.result;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        // The resting state (no check has run yet this launch): **say nothing
        // above, not a word.** Especially not 「已是最新」 ("up to date") — we
        // genuinely do not know right now. The evidence line below states when
        // we last knew, which is exactly the only thing that is true right now.
        if (controller.checking) ...<Widget>[
          Text(strings.updateChecking, style: kRowTitle),
          const SizedBox(height: 6),
        ] else if (r != null) ...<Widget>[
          ..._verdictOf(r),
          const SizedBox(height: 6),
        ],
        // ── The evidence line. Always present, always sharing a frame with
        // whatever is above it. ──────────────────────────────────────────
        Text(_evidenceLine(), style: kRowSub),
      ],
    );
  }

  /// Each outcome slot speaks its own sentence. **No generic 「更新失败」
  /// ("update failed")** (design §5.1).
  List<Widget> _verdictOf(UpdateCheckResult r) {
    switch (r.outcome) {
      case UpdateCheckOutcome.updateAvailable:
        return <Widget>[
          Row(
            children: <Widget>[
              // The state-type dot (design §5.0): while the state holds, it
              // stays; once the state is gone, it leaves on its own.
              Container(
                width: 8,
                height: 8,
                margin: const EdgeInsets.only(right: 8),
                decoration: BoxDecoration(
                  color: FlowMicColors.brand,
                  shape: BoxShape.circle,
                ),
              ),
              Expanded(
                child: Text(
                  strings.updateAvailableTitle(r.latestVersion ?? ''),
                  style: kRowTitle,
                ),
              ),
            ],
          ),
          // The store-delivered channel (iOS): the update arrives through
          // TestFlight / the App Store. The BRANCH is keyed on `storeChannel`,
          // NOT on `storeUrl != null` — a link-less store entry must never
          // fall through to the 「download it from the address below」 copy
          // with no address below.
          // ⚠️ 0.3.29 corrects this paragraph: it used to end 「must still say
          // the store sentence」, and that was one step short. Keying the
          // BRANCH on the channel is right; keying the SENTENCE on it too made
          // one sentence answer two questions — 「a store delivers this」 and
          // 「here is how to reach it」 — and the second answer was absent.
          if (r.storeChannel) ...<Widget>[
            const SizedBox(height: 6),
            // 🔴 0.3.29 — TWO FACTS, TWO SENTENCES. `storeChannel` says the
            // update arrives through a store; `storeUrl` says whether anyone
            // has minted the way in. Sending someone to TestFlight when no
            // invite exists is an instruction they cannot carry out — the same
            // shape as pointing at a download address that is not there, which
            // is the exact thing the branch below this one was written to
            // avoid. Owner ruled the linkless sentence on 2026-08-24.
            Text(
              r.storeUrl == null
                  ? strings.updateStoreNoLinkNote
                  : strings.updateStoreChannelNote,
              style: kRowSub,
            ),
          ]
          // 🔴 The manifest ships a type we don't recognise for this release
          // (`portable-zip` / `dmg` / …).
          // **Still "a new version exists"** — it points the way, it is not
          // an error, and it certainly does not say 「已是最新」 ("up to date").
          else if (r.installable == null) ...<Widget>[
            const SizedBox(height: 6),
            Text(strings.updateKindUnknownNote, style: kRowSub),
          ],
          ..._installBlock(),
          if (r.notesUrl != null) ..._linkRow(strings.updateNotesUrlLabel, r.notesUrl!),
          if (r.downloadUrl != null)
            ..._linkRow(strings.updateDownloadUrlLabel, r.downloadUrl!),
          if (r.storeUrl != null) ..._linkRow(strings.updateStoreUrlLabel, r.storeUrl!),
          // 「联系官方团队」 with no address is a dead end. This row is the
          // address, and it is the SAME constant the check itself dialled
          // (update_check.dart::resolveUpdateEndpoint) — not a second literal
          // that can drift away from it.
          if (r.storeChannel && r.storeUrl == null)
            ..._linkRow(strings.updateOfficialSiteLabel, kDefaultSaasEndpoint),
        ];
      // 🔴 The one and only slot in the whole app allowed to say this
      // sentence, and the evidence line above it is its sole justification.
      case UpdateCheckOutcome.upToDate:
        return <Widget>[
          Text(strings.updateUpToDate(r.latestVersion ?? ''), style: kRowTitle),
        ];
      case UpdateCheckOutcome.ownVersionUnknown:
        return _failure(strings.updateOwnVersionUnknown);
      case UpdateCheckOutcome.incompleteInfo:
        return _failure(strings.updateIncompleteInfo);
      case UpdateCheckOutcome.noManifestHere:
        return _failure(strings.updateNoManifestHere);
      case UpdateCheckOutcome.unavailable:
        return _failure(strings.updateUnavailable);
      case UpdateCheckOutcome.unreachable:
        return _failure(strings.updateUnreachable);
      case UpdateCheckOutcome.malformed:
        return _failure(strings.updateMalformed);
    }
  }

  /// That button, and **one sentence for each of the two stages**.
  ///
  /// 🔴 Order IS meaning: while it's running, say only that it's running; if
  /// the download stage does not clear, it stops there — **the install stage
  /// says not a single word** — that stage genuinely did not happen this
  /// time.
  List<Widget> _installBlock() {
    // Can't install (this release's manifest is not an apk) ⇒ no button. The
    // updateKindUnknownNote sentence above already explains why, and the
    // address is right below.
    if (!controller.canInstall) return const <Widget>[];

    final List<Widget> out = <Widget>[const SizedBox(height: 8)];

    if (controller.installBusy) {
      out.add(
        Text(
          controller.verifying
              ? strings.updateVerifying
              : strings.updateDownloading(_percentLine()),
          style: kRowSub,
        ),
      );
    } else {
      // ── the download stage ────────────────────────────────────────
      final String? failed = _downloadSentence();
      if (failed != null) {
        out.addAll(_failure(failed));
      } else {
        // ── the install stage. Only reached once the download stage
        // has cleared. ────────────────────────────────────────────
        final String? install = _installSentence();
        if (install != null) {
          out.add(Text(install, style: kRowSub));
        }
      }
    }

    out
      ..add(const SizedBox(height: 8))
      ..add(
        Align(
          alignment: Alignment.centerLeft,
          child: FilledButton(
            key: const ValueKey<String>('update.install'),
            onPressed: controller.installBusy
                ? null
                : () => controller.downloadAndInstall(),
            child: Text(strings.updateDownloadAndInstall),
          ),
        ),
      );
    return out;
  }

  /// The download stage's sentence, or null (＝ this stage did not happen, or
  /// it cleared).
  String? _downloadSentence() => switch (controller.downloadOutcome) {
    null || UpdateDownloadOutcome.verified => null,
    UpdateDownloadOutcome.hashMismatch => strings.updateDownloadHashMismatch,
    UpdateDownloadOutcome.sizeMismatch => strings.updateDownloadSizeMismatch,
    UpdateDownloadOutcome.serverRefused => strings.updateDownloadServerRefused,
    UpdateDownloadOutcome.unreachable => strings.updateDownloadUnreachable,
    UpdateDownloadOutcome.cannotWrite => strings.updateDownloadCannotWrite,
  };

  /// The install stage's sentence, or null (＝ this stage has not been reached
  /// yet).
  String? _installSentence() => switch (controller.installOutcome) {
    null => null,
    UpdateInstallOutcome.handedToInstaller => strings.updateHandedToInstaller,
    UpdateInstallOutcome.permissionRequired =>
      strings.updateInstallPermissionRequired,
    UpdateInstallOutcome.refused => strings.updateInstallRefused,
    UpdateInstallOutcome.unsupportedPlatform => strings.updateInstallUnsupported,
  };

  /// `42%`, or `…` — **do not invent a percentage when the total is
  /// unknown**.
  /// The criterion is the manifest's own `size` (controller's
  /// [UpdateController.expectedBytes]), not the server's self-reported
  /// `Content-Length`: that number is itself one of the things we are here to
  /// verify.
  String _percentLine() {
    final int? total = controller.expectedBytes;
    if (total == null || total <= 0) return '…';
    final double pct = (controller.receivedBytes / total) * 100;
    return '${pct.clamp(0, 100).toStringAsFixed(0)}%';
  }

  List<Widget> _failure(String sentence) => <Widget>[
    Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Icon(Icons.error_outline, size: 18, color: FlowMicColors.amber),
        const SizedBox(width: 8),
        Expanded(child: Text(sentence, style: kRowTitle)),
      ],
    ),
  ];

  /// An address the user can act on right now: visible, openable, copyable.
  ///
  /// 🔴 0.3.28 — this used to be selectable text plus a copy control and
  /// nothing else. See the correction block at the top of this file for why
  /// it stayed that way ten days longer than it had to.
  List<Widget> _linkRow(String label, String url) => <Widget>[
    const SizedBox(height: 8),
    _UpdateLink(
      label: label,
      url: url,
      strings: strings,
      urlLauncher: urlLauncher,
    ),
  ];

  /// 「上次成功检查 …」("last successful check …") / 「从未成功检查过」
  /// ("never successfully checked").
  ///
  /// 🔴 **It is refreshed ONLY by 「真的比出过版本」("an actual version
  /// comparison happened")** (the controller writes it only on `didCompare`).
  /// If a failed check were allowed to touch it, that would quietly swap
  /// 「last successful check」 for 「last attempted check」, and at that point
  /// it would stop being evidence at all.
  String _evidenceLine() {
    final DateTime? at = controller.lastSuccessAt;
    if (at == null) return strings.updateNeverChecked;
    return strings.updateLastSuccessAt(formatCheckedAt(at));
  }

  Widget _controlsBlock() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: <Widget>[
      Row(
        children: <Widget>[
          Expanded(child: Text(strings.updateAutoCheckLabel, style: kRowTitle)),
          Switch(
            key: const ValueKey<String>('update.autoCheck'),
            value: controller.autoCheckEnabled,
            // Applies-and-persists instantly, no save button (red line).
            onChanged: (bool v) => controller.setAutoCheckEnabled(v),
          ),
        ],
      ),
      // Design §3 line 8: when it's off, say plainly that it's off. 🔴 **NEVER
      // say 「已是最新」 ("up to date")** — off ≠ up to date, and the manual
      // check remains available regardless.
      if (!controller.autoCheckEnabled) ...<Widget>[
        const SizedBox(height: 2),
        Text(strings.updateAutoCheckOffNote, style: kRowSub),
      ],
      const SizedBox(height: 8),
      Align(
        alignment: Alignment.centerLeft,
        child: TextButton(
          key: const ValueKey<String>('update.checkNow'),
          onPressed: controller.checking ? null : () => controller.checkNow(),
          child: Text(strings.updateCheckNow),
        ),
      ),
    ],
  );
}

/// Absolute-instant string `YYYY-MM-DD HH:MM` (local timezone).
///
/// Deliberately does **NOT** do relative words like "today / yesterday": that
/// would need a full four-language set of relative-time phrasing, whereas
/// this line's only job is to **serve as evidence** — an unambiguous absolute
/// instant is already enough, with the side benefit of not having semantics
/// that shift across midnight. `intl` is not a dependency, and it is not
/// pulled in for this one line.
String formatCheckedAt(DateTime at) {
  final DateTime t = at.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}';
}

/// One address: what it is, what it says, and two ways to act on it.
///
/// 🔴 THE COPY CONTROL IS UNCONDITIONAL, not a consolation prize revealed after
/// a failure. `data_flow_disclosure_page.dart` shows its copy control only once
/// opening has failed, and that is right for a legal page nobody transcribes.
/// These addresses are different: the common reason to want a download URL is
/// to finish the job **on the other machine**, and hiding the copy behind a
/// failure would mean the working path is the one that serves that badly.
class _UpdateLink extends StatefulWidget {
  const _UpdateLink({
    required this.label,
    required this.url,
    required this.strings,
    required this.urlLauncher,
  });

  final String label;
  final String url;
  final AppStrings strings;
  final UpdateUrlLauncher urlLauncher;

  @override
  State<_UpdateLink> createState() => _UpdateLinkState();
}

class _UpdateLinkState extends State<_UpdateLink> {
  bool _openFailed = false;

  Future<void> _open() async {
    bool opened = false;
    try {
      opened = await widget.urlLauncher(
        Uri.parse(widget.url),
        mode: LaunchMode.externalApplication,
      );
    } catch (_) {
      // 🔴 A throw and a `false` are the SAME fact to the user — nothing on
      // this phone took the address — so they get the same sentence. They are
      // not the same fact to us, which is why neither is swallowed into a
      // no-op: the sentence appears either way.
      opened = false;
    }
    if (!mounted || opened) return;
    setState(() => _openFailed = true);
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.url));
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(widget.strings.updateLinkCopied)));
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: <Widget>[
      Text(widget.label, style: kRowSub),
      const SizedBox(height: 2),
      // Still selectable: the address is the evidence for the two controls
      // under it, and a user who trusts neither can read it.
      SelectableText(widget.url, style: kRowSub),
      const SizedBox(height: 4),
      // 🔴 `Wrap`, not `Row`, and it is a measurement concern rather than a
      // layout preference. A `Row` hands a non-flex child an UNBOUNDED width
      // constraint, so every `Text` under it lays itself out inside infinite
      // width and the question 「does it fit」 is never asked in the render
      // tree — `support/legibility.dart`'s check ③ exists for exactly that
      // cell and caught this build red the first time these two controls sat
      // in a Row. `Wrap` passes finite loose constraints down, which is what
      // makes the sentence falsifiable again; the wrapping itself is the bonus
      // (「Копировать ссылку」 beside 「Открыть」 is a long line at 360dp).
      Wrap(
        spacing: 16,
        runSpacing: 6,
        children: <Widget>[
          _MiniAction(
            controlKey: 'update.open.${widget.label}',
            icon: Icons.open_in_new,
            label: widget.strings.updateOpenLink,
            onTap: _open,
          ),
          _MiniAction(
            controlKey: 'update.copy.${widget.label}',
            icon: Icons.copy_outlined,
            label: widget.strings.updateCopyLink,
            onTap: _copy,
          ),
        ],
      ),
      if (_openFailed) ...<Widget>[
        const SizedBox(height: 4),
        Text(
          widget.strings.updateOpenFailed,
          key: ValueKey<String>('update.openFailed.${widget.label}'),
          style: TextStyle(color: FlowMicColors.amber, fontSize: 11, height: 1.4),
        ),
      ],
    ],
  );
}

/// The 「a store delivered this copy」 card's way out (owner 2026-08-23).
///
/// 🔴 It resolves the destination on TAP, not at build time, and the two
/// candidates are tried IN ORDER: `market://` hands straight to the Play app,
/// and on a device without Play Services it resolves to nothing at all — which
/// is common in this product's market, not an edge case. The `https://` form
/// always lands somewhere. Falling through is the whole design; offering only
/// the first would be a dead tap for a large share of users.
///
/// ⚠️ An empty candidate list (we could not read our own package name) renders
/// NOTHING. The card's sentence then stands alone, exactly as it did before —
/// a control that cannot know where it goes is not offered.
class _StoreHandoff extends StatefulWidget {
  const _StoreHandoff({
    required this.strings,
    required this.urlLauncher,
    required this.storeListings,
  });

  final AppStrings strings;
  final UpdateUrlLauncher urlLauncher;
  final StoreListingResolver storeListings;

  @override
  State<_StoreHandoff> createState() => _StoreHandoffState();
}

class _StoreHandoffState extends State<_StoreHandoff> {
  bool _failed = false;

  Future<void> _open() async {
    List<String> candidates;
    try {
      candidates = await widget.storeListings();
    } catch (_) {
      candidates = const <String>[];
    }
    for (final String candidate in candidates) {
      try {
        if (await widget.urlLauncher(
          Uri.parse(candidate),
          mode: LaunchMode.externalApplication,
        )) {
          return;
        }
      } catch (_) {
        // Try the next candidate. A `market://` scheme nothing claims throws
        // on some Android versions and returns false on others; both mean the
        // same thing here.
      }
    }
    if (!mounted) return;
    setState(() => _failed = true);
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: <Widget>[
      _MiniAction(
        controlKey: 'update.openStore',
        icon: Icons.storefront_outlined,
        label: widget.strings.updateOpenStore,
        onTap: _open,
      ),
      if (_failed) ...<Widget>[
        const SizedBox(height: 4),
        Text(
          widget.strings.updateOpenFailed,
          key: const ValueKey<String>('update.openFailed.store'),
          style: TextStyle(color: FlowMicColors.amber, fontSize: 11, height: 1.4),
        ),
      ],
    ],
  );
}

/// The small brand-coloured icon+label control this card uses for every action
/// that is not the install button.
///
/// ⚠️ `Flexible` around the label is not a layout preference. `Row` hands a
/// non-flex child an **unbounded** width constraint, so 「does it fit」 is never
/// even asked in the render tree — `test/support/legibility.dart`'s check ③
/// caught this exact build red once already. It is what keeps the sentence
/// falsifiable.
class _MiniAction extends StatelessWidget {
  const _MiniAction({
    required this.controlKey,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final String controlKey;
  final IconData icon;
  final String label;
  final Future<void> Function() onTap;

  @override
  Widget build(BuildContext context) => InkWell(
    key: ValueKey<String>(controlKey),
    onTap: onTap,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(icon, size: 14, color: FlowMicColors.brand),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            label,
            style: TextStyle(color: FlowMicColors.brand, fontSize: 11),
          ),
        ),
      ],
    ),
  );
}
