// Card RC-S (2026-09-24) — WHICH ACCOUNT A RETAINED RECORDING BELONGS TO.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §2.3 (the defect),
//     §8 card RC-S, §11 ruling 4 (MAIN)
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §2 S1×F5 (「谁说扣谁」:
//     the payer is the person who spoke)
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
//
// The recovery queue scans every retained recording on the device and feeds
// the owed stretches back through whatever socket is up. The relay bills the
// session to that socket's `auth.userId` and nothing on either side knew who
// was signed in when the audio was captured. MEASURED (CR-12-E re-run 3, S6
// attempt 5): account h recorded, account g signed in, and the recovery ran
// under g — g's quota paid for h's audio and the relay transcribed h's audio
// for g's session.
//
// ── THE FIX, AND ITS THREE ANSWERS ──────────────────────────────────────────
//
// The account is written into the manifest's `configSnapshot` when the journal
// opens (the same moment, and the same map, that already records mode and
// spoken language as of the microphone opening — `recordingConfigSnapshot`).
// It is an ADDITIVE key: a manifest written before this card has no such key
// and reads as [RecordingOwner.unknown], which ruling 4 says runs under the
// current account as before (the journal has retained audio since 09-06, and
// holding all of it would strand it for ever).
//
// 🔴 WHAT IS STORED IS A DIGEST, NOT THE EMAIL. The manifest is a plain JSON
// file next to the PCM; the question it has to answer is 「same account or
// not」, and a digest answers that without writing an address to disk a second
// time.
//
// ⚠️ A RECORDING MADE WHILE SIGNED OUT is stamped with the empty string and
// reads as [RecordingOwner.unknown] too, i.e. it runs under whoever is signed
// in later. That is this card's reading of a case ruling 4 does not name (a
// signed-out recording has no account to protect, and holding it would strand
// every LAN recording the moment the user signs in); it is reported to MAIN as
// an open design point. Flipping it is one line in [recordingOwnerOf].

import 'dart:convert';

import 'package:crypto/crypto.dart' show sha256;

/// The manifest `configSnapshot` key. Beside `kConfigSnapshotMode` and friends
/// in spirit (recovery_identity.dart), kept here so the one reader and the one
/// writer share a file.
const String kConfigSnapshotAccount = 'account';

/// Who a retained recording belongs to, as far as this phone can tell.
enum RecordingOwner {
  /// No account recorded: a manifest older than card RC-S, or a recording made
  /// while signed out. Runs under the current account (ruling 4).
  unknown,

  /// Recorded under the account that is signed in now.
  current,

  /// Recorded under a DIFFERENT account, or under an account while nobody is
  /// signed in now. 🔴 NO ATTEMPT: no `audio:start`, no failure counted, the
  /// recording stays pending until that account signs in again.
  other,
}

/// The one reader. Both the recovery leg (whether to open an attempt) and the
/// pending-recovery list (whether to show the other-account line) ask this, so
/// the two cannot disagree about a recording.
///
/// [current] is [RecordingAccountBinding.currentDigest]: null when the binding
/// was never wired, '' when nobody is signed in.
RecordingOwner recordingOwnerOf(
  Map<String, Object?> configSnapshot,
  String? current,
) {
  final Object? recorded = configSnapshot[kConfigSnapshotAccount];
  if (recorded is! String || recorded.isEmpty) return RecordingOwner.unknown;
  // 🔴 FAIL CLOSED: the recording names an account and this phone cannot say
  // who is signed in. Running it would be the defect this file exists for.
  if (current == null) return RecordingOwner.other;
  return recorded == current ? RecordingOwner.current : RecordingOwner.other;
}

/// Stable digest of an account key (the login email). Case and surrounding
/// space are folded: the stored email is the server's answer or, failing that,
/// what the user typed (`account_store.dart`), and the same person typing
/// `A@x.com` once and `a@x.com` later is one account.
String accountDigest(String accountKey) => sha256
    .convert(utf8.encode('acct-v1|${accountKey.trim().toLowerCase()}'))
    .toString()
    .substring(0, 32);

/// The seam between the login state and the retained-audio layer.
///
/// 🔴 ONE WRITER IN PRODUCTION: `main.dart` binds it to `LoginController.email`
/// right after the controller is built (grep `recordingAccount.bind`). The
/// spill that owns this object is opened in `main()` before any controller
/// exists, which is why it is bound later rather than passed in.
///
/// ⚠️ UNBOUND IS NOT A FRIENDLY DEFAULT, it is the pre-card behaviour, stated:
/// the journal is stamped with nothing (so the recording reads as
/// [RecordingOwner.unknown]) and [currentDigest] answers null (so a recording
/// that DOES name an account is held, fail-closed). The source-scan case in
/// `recovery_account_binding_test.dart` pins that the bind exists.
class RecordingAccountBinding {
  String? Function()? _source;

  /// Wire the account source. Called once, from `main.dart`.
  void bind(String? Function() accountKey) => _source = accountKey;

  bool get isBound => _source != null;

  /// Null when unbound; '' when nobody is signed in; else [accountDigest].
  String? currentDigest() {
    final String? Function()? source = _source;
    if (source == null) return null;
    final String? key = source();
    if (key == null || key.trim().isEmpty) return '';
    return accountDigest(key);
  }

  /// [snapshot] plus the account key, as of now. Returned unchanged when
  /// unbound — see the class doc.
  Map<String, Object?> stamp(Map<String, Object?> snapshot) {
    final String? digest = currentDigest();
    if (digest == null) return snapshot;
    return <String, Object?>{...snapshot, kConfigSnapshotAccount: digest};
  }
}
