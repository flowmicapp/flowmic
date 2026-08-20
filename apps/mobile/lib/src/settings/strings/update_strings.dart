// AppStrings copy-catalogue shard: the settings page's 「Update」 section
// (UP-2, in-app update's check-and-notify surface).
// The one external entry point is still ../app_strings.dart (AppStrings
// composes this mixin with `with`).
//
// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §3 (failure-direction
//     table) / §5.1
//   apps/mobile/lib/src/update/update_check.dart (UpdateCheckOutcome — this
//     file writes one sentence for **each of its cells**, which is where
//     「every failure speaks for itself」 lands)
//
// 🔴 **There is not one sentence here that says 「update failed」.** Design
// §5.1 states, word for word, 「network failure / incomplete manifest /
// hash mismatch / permission refused — four different sentences, never
// merged into one」. The reason is not wording purism: they point to
// **different actions**. 「this server doesn't offer update info」 asks the
// user to look elsewhere; 「temporarily unavailable」 asks them to wait a
// bit; 「can't connect」 asks them to check their own network. Merged into
// one sentence, none of the three actions could be taken by anyone.
//
// 🔴 **Nor is there any sentence that says 「up to date」 when it is
// uncertain.** Only [updateUpToDate] ever says that, and it is triggered
// solely by the `UpdateCheckOutcome.upToDate` cell, and the UI **must**
// also render [updateLastSuccessAt] alongside it — that line is the ONLY
// evidence backing this sentence (design §5.0, final paragraph).
part of '../app_strings.dart';

mixin UpdateStrings on AppStringsLeaves {

  // ── section title ───────────────────────────────────────────────────────
  String get secUpdate =>
      _lfSecUpdate;

  // ── status (checking / update available / up to date) ────────────────────
  String get updateChecking => _lfUpdateChecking;

  /// Status-type (design §5.0): disappears the moment the status itself
  /// changes, no timer involved.
  String updateAvailableTitle(String v) => _lfUpdateAvailableTitle(v);

  /// The manifest ships a `kind` for this version (`portable-zip` / `dmg` /
  /// …) this build does not recognise. **Still 「an update is available」**,
  /// we just can't install it ⇒ point the way, not an error, and certainly
  /// not 「up to date」.
  String get updateKindUnknownNote => _lfUpdateKindUnknownNote;

  /// 🔴 The app's **ONE AND ONLY** 「up to date」 sentence.
  String updateUpToDate(String v) => _lfUpdateUpToDate(v);

  // ── every failure speaks for itself (one per UpdateCheckOutcome cell) ────

  /// Cannot even read which version this build itself is ⇒ nothing to
  /// compare against. **Must not say 「up to date」.**
  String get updateOwnVersionUnknown => _lfUpdateOwnVersionUnknown;

  /// Design §3 row 4: a missing field / missing sha256 / an invalid url ⇒
  /// **do not download**.
  String get updateIncompleteInfo => _lfUpdateIncompleteInfo;

  /// Design §3 row 2: the endpoint 404s — 「**this deployment**」 has no
  /// update manifest.
  String get updateNoManifestHere => _lfUpdateNoManifestHere;

  /// Design §3 row 3, first half: 503 — the server was reached, and it says
  /// it cannot answer right now.
  String get updateUnavailable => _lfUpdateUnavailable;

  /// Design §3 row 3, second half: never reached at all. **Kept separate**
  /// from the previous one, because the action is different.
  String get updateUnreachable => _lfUpdateUnreachable;

  /// 200, but the answer isn't a manifest — a captive portal / nginx
  /// try_files whole-page HTML falls here.
  String get updateMalformed => _lfUpdateMalformed;

  // ── evidence and toggles ──────────────────────────────────────────────────

  /// 🔴 Status-type, always shown. **It is the ONLY evidence for 「up to
  /// date」** (design §5.0, final paragraph).
  /// [when] is an absolute-instant string, formatted by the card —
  /// deliberately not a 「today / yesterday」 relative wording: that would
  /// need a whole four-language relative-time vocabulary, while an
  /// unambiguous absolute instant is already enough as evidence.
  String updateLastSuccessAt(String when) => _lfUpdateLastSuccessAt(when);

  /// Never successfully checked, not even once. **Must be said out loud** —
  /// leaving it blank would make this look the same as 「just checked」.
  String get updateNeverChecked => _lfUpdateNeverChecked;

  String get updateAutoCheckLabel => _lfUpdateAutoCheckLabel;

  /// Design §3 row 8: auto-check turned off ⇒ say 「auto-check is off」 +
  /// leave a manual check available.
  /// 🔴 **Never says 「up to date」** — off ≠ up to date.
  String get updateAutoCheckOffNote => _lfUpdateAutoCheckOffNote;

  String get updateCheckNow =>
      _lfUpdateCheckNow;

  // ── the path the user can walk right now ──────────────────────────────────

  String get updateDownloadUrlLabel => _lfUpdateDownloadUrlLabel;

  String get updateNotesUrlLabel => _lfUpdateNotesUrlLabel;

  // ── the store-delivered channel (iOS, owner 2026-08-20) ───────────────────

  /// Under 「version x is available」 when the verdict came from a
  /// `store_platforms` entry: the update arrives through TestFlight / the App
  /// Store, and this app downloads nothing itself. A different sentence from
  /// [updateKindUnknownNote] on purpose — that one promises 「download it from
  /// the address below」, which on this channel would point at an address that
  /// does not exist.
  String get updateStoreChannelNote => _lfUpdateStoreChannelNote;

  /// Label for the store-page link row (TestFlight invite / store listing).
  String get updateStoreUrlLabel => _lfUpdateStoreUrlLabel;

  String get updateCopyLink =>
      _lfUpdateCopyLink;

  String get updateLinkCopied => _lfUpdateLinkCopied;

  // ── UP-2b: download → verify → hand off to the system installer ─────────
  //
  // 🔴 **The download segment and the install segment each speak for
  // themselves, and neither segment's words may cross over to the other**
  // (the same shape as Book 15 §2.0's 「delivery ≠ injection」 constraint,
  // applied to this chain). Every sentence below belongs to exactly **one**
  // of the two segments, and contains none of the other segment's verbs.
  //
  // 🔴 **Nor does any sentence say 「secured」 or 「hardened」.** What we
  // actually deliver is one verifiable fact: the bytes you installed are the
  // bytes the official manifest describes. The manifest and the package come
  // from the same machine — if it is compromised, both change together
  // (`update-routes.ts`'s file header requires this to be stated, word for
  // word).

  String get updateDownloadAndInstall => _lfUpdateDownloadAndInstall;

  /// [percent] is already computed by the card ('42%'); no numeric
  /// formatting happens here — a separate thousands-separator convention per
  /// language is not a debt this line should carry.
  String updateDownloading(String percent) => _lfUpdateDownloading(percent);

  /// 🔴 It has its own sentence, not merged with 「downloading」: hashing a
  /// 45 MB package takes a visibly noticeable amount of time, and a progress
  /// bar stuck at 100% looks exactly the same as 「it froze」.
  String get updateVerifying => _lfUpdateVerifying;

  /// 🔴 **Hash mismatch. File deleted.** This is the single most important
  /// sentence in this chain. Contains no instruction beyond the imperative
  /// 「re-download」, and **must not** be read as 「bad network」 — that's
  /// [updateDownloadSizeMismatch]'s job, and the two point to opposite
  /// conclusions.
  String get updateDownloadHashMismatch => _lfUpdateDownloadHashMismatch;

  /// A length mismatch = the download didn't finish (or the response wasn't
  /// even that file). **The action is retry**, deliberately the opposite of
  /// the 「don't install」 sentence above — merging them would make someone
  /// do the wrong thing.
  String get updateDownloadSizeMismatch => _lfUpdateDownloadSizeMismatch;

  String get updateDownloadServerRefused => _lfUpdateDownloadServerRefused;

  /// ⚠️ **NOT the same sentence** as [updateUnreachable]: that one says 「the
  /// official site can't be reached」, this one says 「the download center
  /// couldn't be reached」. The two can be on two different machines (owner
  /// 2026-08-02: 「the download link might be a different URL」); merging
  /// them would send someone to debug the wrong half of the chain.
  String get updateDownloadUnreachable => _lfUpdateDownloadUnreachable;

  /// Unrelated to the network — the user's action is to free up space, not
  /// switch Wi-Fi.
  String get updateDownloadCannotWrite => _lfUpdateDownloadCannotWrite;

  /// 🔴 **「Handed off」 is not 「installed」.** On Android there is no
  /// silent-install path; next comes the user tapping confirm in a system
  /// dialog. Saying 「updated」 would be claiming something got done when it
  /// didn't.
  String get updateHandedToInstaller => _lfUpdateHandedToInstaller;

  /// 🔴 **The ONE failure on this whole path the user can fix themselves**
  /// — so it gets its own sentence, and it must spell out both 「where you've
  /// just been taken」 and 「what to do when you come back」.
  String get updateInstallPermissionRequired => _lfUpdateInstallPermissionRequired;

  String get updateInstallRefused => _lfUpdateInstallRefused;

  /// **Kept separate** from the previous sentence: one is 「the system said
  /// no」, the other is 「this build of ours has no such path」.
  String get updateInstallUnsupported => _lfUpdateInstallUnsupported;

  // ── this build does not carry in-app update
  //    (--dart-define=FLOWMIC_SELF_UPDATE is off) ─────────────────────────
  //
  // 🔴 An ABSENT capability must be **visible**: this section still renders,
  // just with these two sentences instead. Hiding the whole section would
  // make 「this package doesn't carry this feature」 and 「we never built this
  // feature」 look identical.

  String get updateNotBundledTitle => _lfUpdateNotBundledTitle;

  String get updateNotBundledNote => _lfUpdateNotBundledNote;

  // ── a store delivered this copy (gate ②, update/install_source.dart) ──────
  //
  // 🔴 **Kept apart from the two sentences above, and the distinction is the
  // whole reason this pair exists.** 「this build was made without the
  // feature」 and 「a store installed this, so the store updates it」 are two
  // different facts about two different packages. Folding them into one
  // sentence would tell a Play user their build is crippled, and tell a
  // sideloaded user to go look in a store they never used — the repo's
  // headline shape (one value answering two questions) on the copy face.
  //
  // ⚠️ No store is NAMED: the criterion is an allow-list of installer packages
  // and Play is only its most likely member. Writing 「Google Play」 here would
  // put a claim on screen that the code does not check.

  String get updateFromStoreTitle => _lfUpdateFromStoreTitle;

  String get updateFromStoreNote => _lfUpdateFromStoreNote;
}
