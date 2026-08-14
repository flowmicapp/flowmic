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

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import '../settings/app_strings.dart';
import '../update/update_check.dart';
import '../update/update_controller.dart';
import '../update/update_download.dart' show UpdateDownloadOutcome;
import '../update/update_installer.dart' show UpdateInstallOutcome;
import 'settings_widgets.dart';
import 'tokens.dart';

class SettingsUpdateCard extends StatelessWidget {
  const SettingsUpdateCard({
    super.key,
    required this.controller,
    required this.strings,
  });

  final UpdateController controller;
  final AppStrings strings;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (BuildContext context, _) {
      // 🔴 An absent capability must be **visible**, the whole section may not
      // be hidden — a feature that quietly vanished and a feature that was
      // never built look identical to the user. The full reasoning is in
      // update/self_update_flag.dart's file header.
      if (!controller.selfUpdateEnabled) return _notBundledCard();
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

  Widget _notBundledCard() => settingsCard(
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
                Text(strings.updateNotBundledTitle, style: kRowTitle),
                const SizedBox(height: 3),
                Text(strings.updateNotBundledNote, style: kRowSub),
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
          // 🔴 The manifest ships a type we don't recognise for this release
          // (`portable-zip` / `dmg` / …).
          // **Still "a new version exists"** — it points the way, it is not
          // an error, and it certainly does not say 「已是最新」 ("up to date").
          if (r.installable == null) ...<Widget>[
            const SizedBox(height: 6),
            Text(strings.updateKindUnknownNote, style: kRowSub),
          ],
          ..._installBlock(),
          if (r.notesUrl != null) ..._linkRow(strings.updateNotesUrlLabel, r.notesUrl!),
          if (r.downloadUrl != null)
            ..._linkRow(strings.updateDownloadUrlLabel, r.downloadUrl!),
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

  /// An address the user can use right now: visible, selectable, one-tap copy.
  List<Widget> _linkRow(String label, String url) => <Widget>[
    const SizedBox(height: 8),
    Text(label, style: kRowSub),
    const SizedBox(height: 2),
    SelectableText(url, style: kRowSub),
    const SizedBox(height: 4),
    Builder(
      builder: (BuildContext context) => InkWell(
        key: ValueKey<String>('update.copy.$label'),
        onTap: () {
          Clipboard.setData(ClipboardData(text: url));
          ScaffoldMessenger.maybeOf(
            context,
          )?.showSnackBar(SnackBar(content: Text(strings.updateLinkCopied)));
        },
        // ⚠️ `Row` hands a non-flex child an **unbounded width** constraint ⇒
        // that label would lay itself out inside infinite width, meaning the
        // question 「does it actually fit」 is **never even asked** in the
        // render tree (`test/support/legibility.dart`'s check ③ caught this
        // build red on the spot). Adding `Flexible` is not a layout
        // preference, it is what makes this sentence **falsifiable again**.
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.copy_outlined, size: 14, color: FlowMicColors.brand),
            const SizedBox(width: 4),
            Flexible(
              child: Text(
                strings.updateCopyLink,
                style: TextStyle(color: FlowMicColors.brand, fontSize: 11),
              ),
            ),
          ],
        ),
      ),
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
