// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §3 (failure-direction
//     table) / §5.0 (notice lifecycle) / §5.1 (phone-side UI)
//   docs/decisions/2026-08-02-in-app-update-both-ends.md (owner: automatic
//     detection + reminder)
//   CLAUDE.md red line: no silent failure / unknown ≠ latest / settings
//     apply-and-save-immediately
//
// The **state holder** for the update check. It does not fire HTTP requests
// (that's update_check.dart), it does not paint the UI
// (that's ui/settings_update_card.dart), it only answers 「what should the UI
// say right now, and on what grounds」.
//
// ── 🔴 every failure degrades to the status quo ──────────────────────────────
//
// Design §3's overarching principle: every failure degrades to **the user
// continuing to use the version they already have**.
// So this class **has no path that throws**, and no path that blocks the
// App's real business:
// the check runs in the background, drops its conclusion into a field, and
// the UI reads it on its own. Check failed ⇒ the field IS that failure,
// **nothing else anywhere changes by even one character**.
//
// ── 🔴 「already up to date」 and 「last successful check」 are two halves of
// the same fact ──────────────────────────────
//
// [lastSuccessAt] only refreshes when a version comparison genuinely
// happened ([UpdateCheckResult.didCompare]).
// A failed check **does NOT** touch it — otherwise 「last successful check」
// would degrade into 「last attempted check」,
// and that would demote it from evidence to decoration (design §5.0's closing note).
//
// ── ⚠️ One reading of design §5.0, written here rather than only in a report ──────────────────
//
// §5.0's table lists 「update check failed」 as **event-type · auto-hides
// after a few seconds**. This pass **deliberately did NOT** add an
// auto-hide timer to that row on the settings page, for these reasons:
//   · that table governs the **reminder surface** (§5.1's badge / popover —
//     something floating over the real business, and it becomes noise if
//     it doesn't go away); the settings-page sketch §5.1 draws
//     **has no failure row at all**, meaning this row has no corresponding
//     contract line to begin with;
//   · while on the settings page, the user **just personally pressed 「check
//     now」**. Wiping away the answer they asked for four seconds later
//     turns an answer into a flicker.
// ⇒ Here it is treated as **state-type**: it stays up until the next check replaces it.
// 🔴 But it must **always be presented in the same frame as [lastSuccessAt]**
// (see the card's own comment) —
// that is the MECHANISM guarantee that it can never be misread as 「already
// up to date」, not merely a wording guarantee.
// **This pass did not build a reminder surface (badge)**, so §5.0's
// event-type row currently has no implementation to conflict with.
//
// ── 🔴 UP-2b: download and install are **two separate segments**, and their
// failures must never be merged (the single most important thing to
// understand in this file) ──
//
// This repo has already paid once for mixing two segments' terminology: doc
// 15 §2.0 split
// **phone→PC = delivery** from **PC→focused window = injection** into two
// separate vocabularies, because reusing one word across both segments
// let the capsule answer 「did it get injected」 with 「not delivered」, when that
// very frame had clearly already arrived.
//
// This is the same shape here:
//   · the **download segment** ([downloadOutcome]) asks 「is there a verified package on disk」;
//   · the **install segment** ([installOutcome]) asks 「was that package handed to the system installer」.
// A hash mismatch and a 「the user never granted install permission」 need to
// say two completely different sentences on screen,
// pointing at two completely different actions. **So they are two fields,
// not one `installFailure`.**
// ⇒ Download failed ⇒ the install segment says nothing at all
// ([installOutcome] stays null, and it **never even reaches** that step).

import 'package:flutter/foundation.dart';

import '../portable/portable_ports.dart' show AppVersionPort;
import 'install_source.dart';
import 'self_update_flag.dart';
import 'update_check.dart';
import 'update_download.dart';
import 'update_installer.dart';
import 'update_manifest.dart' show UpdateArtifact;
import 'update_prefs.dart';

/// The executor of one check. Default is to really ask the official site.
///
/// ⚠️ **The default is NOT a friendly empty implementation** (doc 13 §7 F1
/// ②): it either really sends the request, or
/// is explicitly swapped by a test. A checker whose 「default does nothing
/// and answers success」 would turn the whole UI
/// section into a sign that permanently reads 「already up to date」.
typedef UpdateChecker = Future<UpdateCheckResult> Function({
  required String? currentVersion,
});

/// The executor of download + verification. Default is to really download
/// and really compute a sha256.
///
/// ⚠️ Same as above: **the default must not be a friendly empty
/// implementation**. A downloader whose 「default does nothing and answers
/// verified」 would let the whole chain agree with itself in tests that it
/// works, while it never read a single byte.
typedef UpdateDownloader = Future<UpdateDownloadResult> Function(
  UpdateArtifact artifact, {
  UpdateDownloadProgress? onProgress,
});

/// Hand a package that has **already been verified** to the system installer.
typedef UpdateInstallRunner = Future<UpdateInstallResult> Function(String apkPath);

class UpdateController extends ChangeNotifier {
  UpdateController({
    required AppVersionPort version,
    required UpdatePrefs prefs,
    UpdateChecker? checker,
    UpdateDownloader? downloader,
    UpdateInstallRunner? installer,
    DateTime Function() now = DateTime.now,
    this.selfUpdateEnabled = kSelfUpdateEnabled,
    this.notifyOnlyEnabled = kUpdateNotifyOnlyEnabled,
    Future<bool> Function()? storeProbe,
  })  : _storeProbe = storeProbe ?? installedFromStore,
        _version = version,
        _prefs = prefs,
        _now = now,
        _checker = checker ??
            (({required String? currentVersion}) =>
                checkForUpdate(currentVersion: currentVersion)),
        _downloader = downloader ?? downloadUpdateArtifact,
        _installer = installer ?? handOffToInstaller;

  final AppVersionPort _version;
  final UpdatePrefs _prefs;
  final UpdateChecker _checker;
  final UpdateDownloader _downloader;
  final UpdateInstallRunner _installer;
  final DateTime Function() _now;

  /// Whether this build carries in-app update at all (`--dart-define=FLOWMIC_SELF_UPDATE`).
  ///
  /// 🔴 When false, **no checking, no network access**, and the UI renders a
  /// human sentence explaining this build lacks the capability
  /// — **it does NOT hide the whole section**. Reasoning in self_update_flag.dart's file header.
  final bool selfUpdateEnabled;

  /// The iOS half (`--dart-define=FLOWMIC_UPDATE_NOTIFY`): this build CHECKS
  /// and NOTIFIES, and installs nothing — updates arrive through the store.
  /// It widens exactly one thing, [checkUsable]; [canInstall] cannot come true
  /// from it (that one still requires [selfUpdateUsable]). Why it is a const
  /// define and not `Platform.isIOS`: self_update_flag.dart's notify section
  /// (the Android store artifact's marker-absence depends on TFA folding).
  final bool notifyOnlyEnabled;

  /// Gate ② (`install_source.dart`): asked once in [load].
  final Future<bool> Function() _storeProbe;

  /// Whether a store delivered this copy. **Not** the same fact as
  /// [selfUpdateEnabled], and the card says a different sentence for each:
  /// one is 「this build was made without the feature」, the other is 「the
  /// store that installed this updates it」.
  ///
  /// Defaults to false and is only ever set by [load] — an unasked question
  /// must not read as 「yes, a store」, or every screen that paints before load
  /// would claim a fact nobody established.
  bool _fromStore = false;

  bool get installedFromAppStore => _fromStore;

  /// 🔴 THE ONE ANSWER to 「may this app install an update itself right now」.
  /// Both gates, one getter — the alternative is each call site remembering to
  /// ask twice, which is the shape that makes gate ② forgettable all over
  /// again.
  bool get selfUpdateUsable => selfUpdateEnabled && !_fromStore;

  /// 🔴 THE ONE ANSWER to 「may this app ASK about updates right now」 — a
  /// weaker question than [selfUpdateUsable], and deliberately a separate
  /// getter: an iOS notify-only build may ask (and light the dot) while it
  /// may never install. The store probe does not gate this half: 「the store
  /// updates this copy」 forbids US installing, not the user being told.
  bool get checkUsable => selfUpdateUsable || notifyOnlyEnabled;

  /// Whether the settings section renders its live half at all. False ⇒ the
  /// card shows the honest static sentence (「this build has no in-app
  /// updater」) instead of hiding — see self_update_flag.dart's header.
  bool get updateSectionEnabled => selfUpdateEnabled || notifyOnlyEnabled;

  bool _loaded = false;
  bool _checking = false;
  bool _autoCheck = true;
  DateTime? _lastSuccessAt;
  UpdateCheckResult? _result;
  bool _disposed = false;

  bool _installBusy = false;
  bool _verifying = false;
  int _received = 0;
  int? _expectedBytes;
  UpdateDownloadResult? _download;
  UpdateInstallResult? _install;

  /// Whether prefs have been read back yet. The UI paints no conclusion
  /// before this (to avoid the switch first painting its default value and
  /// then jumping).
  bool get loaded => _loaded;
  bool get checking => _checking;
  bool get autoCheckEnabled => _autoCheck;

  /// null = **never successfully checked**. The UI must say this out loud, it may not leave it blank.
  DateTime? get lastSuccessAt => _lastSuccessAt;

  /// The conclusion of the most recent check within this App lifecycle. null = not checked yet.
  ///
  /// 🔴 **Deliberately not persisted.** Showing last time's 「already up to
  /// date」 the instant the App launches would be passing off an answer
  /// that might be three days
  /// old as today's fact. The resting state after launch is 「last
  /// successful check at …」 + a button,
  /// that is the whole of what we **actually** know.
  UpdateCheckResult? get result => _result;

  /// 「is there a version newer than mine right now」 — **the whole app has only this one answer**.
  ///
  /// The card on the settings page and the badge on the chat page's gear
  /// icon read the SAME getter. Letting each judge it separately
  /// (e.g. the badge writing `result != null` on its own) would be 「one
  /// question, two answers」, and those two answers
  /// will eventually diverge — a shape that has appeared five times across ten releases in this repo.
  ///
  /// 🔴 **It is state-type** (design §5.0): it disappears the instant the
  /// state itself changes (the new version got installed, or the manifest
  /// no longer
  /// reports a higher version), **never relying on a timer**. So this is a
  /// pure derived value, with no 「read」 flag of any kind.
  bool get hasUpdate => _result?.outcome == UpdateCheckOutcome.updateAvailable;

  Future<void> load() async {
    _autoCheck = await _prefs.autoCheckEnabled();
    _lastSuccessAt = await _prefs.lastSuccessAt();
    // Gate ② rides the same load: it is one platform call, it can only change
    // when the package is replaced, and asking it here means every reader of
    // [selfUpdateUsable] sees the same answer as everything else this method
    // establishes. Asking it lazily per action would let the check card and the
    // install button disagree for one frame — 「one question, two answers」.
    _fromStore = await _storeProbe();
    _loaded = true;
    _notify();
  }

  /// Whether [kUpdateCheckInterval] has elapsed since the last successful check (never checked ⇒ yes).
  bool get isStale {
    final DateTime? last = _lastSuccessAt;
    if (last == null) return true;
    return _now().difference(last) >= kUpdateCheckInterval;
  }

  /// Call this at launch. A request only goes out when all three hold at
  /// once: 「build has the capability + user hasn't turned it off +
  /// it's genuinely time to check」.
  ///
  /// ⚠️ This pass **does NOT** build a recurring timer for 「re-check if the
  /// App has stayed open past 24 hours」:
  /// the launch-time check covers the vast majority of cases, and a
  /// standing timer would need extra lifecycle and
  /// dispose handling — this pass does not invent a mechanism for a
  /// scenario nobody has observed. This is a stated debt, not an oversight.
  Future<void> maybeAutoCheck() async {
    // Gate ② needs [load] to have run before it can answer, and this is the one
    // entry point that may run before it — so ask the flags first (cheap, and it
    // is the case where nothing exists at all), then load, then the pair.
    // 🔴 Both flags are consts folded through final fields (TFA): when neither
    // build define is set, this line is where the whole chain goes dead and
    // the marker string gets tree-shaken — the Android store gate depends on it.
    if (!selfUpdateEnabled && !notifyOnlyEnabled) return;
    if (!_loaded) await load();
    if (!checkUsable) return;
    if (!_autoCheck || !isStale) return;
    await checkNow();
  }

  /// Manual 「check now」.
  ///
  /// 🔴 **It stays usable even when auto-check is turned off** (design §3
  /// row 8): what's turned off is 「automatic」,
  /// not 「checking」. The UI in that state says 「auto-check is off」,
  /// **and never says 「already up to date」**.
  Future<void> checkNow() async {
    if (!checkUsable || _checking) return;
    _checking = true;
    // A new check replaces [result], while the two segments' outcomes speak
    // about the **PREVIOUS** artifact. Keeping them around would let the
    // screen answer the new package's question with the old package's
    // conclusion — this repo's #1 bug shape.
    _download = null;
    _install = null;
    _notify();
    UpdateCheckResult res;
    try {
      final String? mine = await _version.appVersion();
      res = await _checker(currentVersion: mine);
    } on Object catch (e) {
      // checkForUpdate is contractually non-throwing, but a swapped-in checker might throw.
      // 🔴 Collapsing to 「probably no update」 would be this chain's worst failure ⇒ named as 「unreachable」.
      res = UpdateCheckResult(UpdateCheckOutcome.unreachable, detail: 'checker_threw:$e');
    }
    _result = res;
    // The credential only refreshes when a version comparison genuinely happened. A failed attempt must not touch it — see file header.
    final DateTime? at = res.comparedAt;
    if (at != null) {
      _lastSuccessAt = at;
      await _prefs.setLastSuccessAt(at);
    }
    _checking = false;
    _notify();
  }

  // ── UP-2b: download → verify → hand off to the system installer ─────────────────────────────────

  /// This path is currently underway (downloading, verifying, or being handed off). The button greys out accordingly.
  bool get installBusy => _installBusy;

  /// Bytes are fully received; this is the tail before the download settles —
  /// flushing the file to disk and finalizing the digest.
  ///
  /// 🔴 Correction: this state used to be justified as "hashing a 45 MB
  /// package takes visually perceptible time, and a progress bar stuck at
  /// 100% looks exactly like it froze." That mechanism is gone —
  /// `update_download.dart` now feeds every chunk to the hasher as it streams
  /// in, alongside the write to disk, so by the time [receivedBytes] reaches
  /// [expectedBytes] the digest is essentially already computed. This phase
  /// is now near-instant, not a perceptible wait.
  ///
  /// The state still earns its keep: the tail (flush + close + the length/
  /// hash comparisons) is still real work, so the UI has a true label for it
  /// instead of guessing "downloading" or "done" for however briefly it
  /// takes. Just do not expect — or write a test expecting — a multi-second
  /// pause behind it; there is not one anymore.
  bool get verifying => _verifying;

  int get receivedBytes => _received;

  /// The size the manifest says this package should be. **The criterion
  /// comes from the manifest, not the server's `Content-Length`**
  /// — that number is what the machine being downloaded from says, and
  /// that machine is exactly what we are trying to verify.
  int? get expectedBytes => _expectedBytes;

  /// The download segment's conclusion. null = no download has happened this time.
  UpdateDownloadOutcome? get downloadOutcome => _download?.outcome;

  /// The install segment's conclusion. null = **never even reached the
  /// install segment** (download failed, or the button hasn't been pressed yet).
  /// 🔴 A separate field from [downloadOutcome], reasoning in the file
  /// header's 「download and install are two segments」.
  UpdateInstallOutcome? get installOutcome => _install?.outcome;

  /// The machine-readable diagnostic (each segment's own raw words). **Never shown on screen by itself.**
  String? get installDetail => _install?.detail ?? _download?.detail;

  /// Whether this phone can press that button right now — **the whole app has only this one answer**.
  ///
  /// 「there is a new version」 does not imply 「we can install it」: this
  /// version in the manifest might have been shipped as a
  /// `portable-zip` / `dmg` ([UpdateCheckResult.installable] is null).
  /// In that case the UI gives an address, not a button.
  bool get canInstall =>
      selfUpdateUsable &&
      _result?.outcome == UpdateCheckOutcome.updateAvailable &&
      _result?.installable != null;

  /// Download that package, verify it, hand it to the system installer.
  ///
  /// 🔴 **Hash mismatch ⇒ that is the end of it.** The install step is
  /// structurally unable to reach that file:
  /// `UpdateDownloadResult.file` is only non-null when verified, and the
  /// only path here is to take it from there.
  /// This is not 「remember not to call it」, it is making 「carelessly
  /// install the unverified copy too」 impossible to write.
  ///
  /// 🔴 This method **does not throw**. Every path lands on one cell of the two segments' outcomes.
  Future<void> downloadAndInstall() async {
    if (!canInstall || _installBusy) return;
    final UpdateArtifact artifact = _result!.installable!;

    _installBusy = true;
    _verifying = false;
    _received = 0;
    _expectedBytes = artifact.size;
    // The previous conclusion must be cleared **at the START of this run**,
    // not at the end. Keeping it around would put 「downloading now」
    // and last round's 「hash mismatch」 on screen at the same time — each
    // sentence was true at some past moment,
    // but together they are a lie.
    _download = null;
    _install = null;
    _notify();

    UpdateDownloadResult down;
    try {
      down = await _downloader(
        artifact,
        onProgress: (int received, int? total) {
          _received = received;
          // All bytes received ⇒ flip to verifying so the UI labels the tail
          // phase instead of showing a full-but-stuck download bar.
          // Correction (hygiene-007): this used to say "the time after this is
          // spent hashing" — false since update_download.dart started feeding
          // every chunk to the hasher as it streams; see the [verifying] getter
          // for what actually remains here (flush/close/compare, near-instant).
          _verifying = total != null && received >= total;
          _notify();
        },
      );
    } on Object catch (e) {
      // downloadAndVerify is contractually non-throwing, but a swapped-in downloader might throw.
      // 🔴 Collapsing to 「probably downloaded fine」 would be this chain's worst failure ⇒ named as 「unreachable」.
      down = UpdateDownloadResult(
        UpdateDownloadOutcome.unreachable,
        detail: 'downloader_threw:$e',
      );
    }
    _download = down;
    _verifying = false;

    if (down.outcome != UpdateDownloadOutcome.verified || down.file == null) {
      _installBusy = false;
      _notify();
      return;
    }

    try {
      _install = await _installer(down.file!.path);
    } on Object catch (e) {
      _install = UpdateInstallResult(
        UpdateInstallOutcome.refused,
        detail: 'installer_threw:$e',
      );
    }
    _installBusy = false;
    _notify();
  }

  /// Apply-and-save-immediately, no save button (red line).
  Future<void> setAutoCheckEnabled(bool enabled) async {
    if (_autoCheck == enabled) return;
    _autoCheck = enabled;
    _notify();
    await _prefs.setAutoCheckEnabled(enabled);
  }

  void _notify() {
    if (_disposed) return;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
