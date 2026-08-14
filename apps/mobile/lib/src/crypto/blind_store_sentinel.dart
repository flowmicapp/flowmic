// E-B1 — the sentinel self-check: "is this the right passphrase?", answered
// entirely on the device.
//
// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §2 (「密钥跨端开通：同口令重输（主路径，
//   本地验证 blob `AES-GCM(MasterKey,'flowmic-e2ee-v1')`，服务端不参与判定）」
//   — "cross-device key activation: re-enter the same passphrase (the main
//   path, verified locally via blob `AES-GCM(MasterKey,'flowmic-e2ee-v1')`;
//   the server takes no part in the verdict)");
//   docs/strategy/2026-08-08-design-e-blindstore-client.md §2.1 (owner ruling
//   E-①: one account's devices share ONE key, so a second device must be able to
//   check a re-entered passphrase before it starts writing).
//
// 🔴 WHY THIS EXISTS AT ALL. Without it, a second device that derived the WRONG
// MasterKey would pull the account's blobs, fail to open every single one, and —
// unless something deliberately intervenes — render an empty timeline. The user
// would conclude their records are gone. They are not: they are one correct
// passphrase away. Design §2.1 forbids that degradation in as many words
// (「不许静默变成"云端是空的"——那是把一个可解问题说成不存在」 — "must not silently
// become 'the cloud is empty' — that turns a solvable problem into something
// that looks like it does not exist"). The sentinel is
// what makes the difference between those two situations KNOWABLE before any
// entry is even fetched.
//
// 🔴 THE SERVER NEVER PARTICIPATES IN THE JUDGEMENT. It stores the sentinel blob
// as opaque bytes like any other blob. It cannot tell a right passphrase from a
// wrong one, and neither can anyone holding the database. If this check ever
// grows a network call that returns a boolean, blind storage has been abandoned.

import 'dart:math';

import 'blind_store_envelope.dart';
import 'blind_store_key.dart';
import 'blind_store_params.dart';

/// Builds the sentinel blob for [key]. Store it next to the account (E-B2) and
/// upload it like any other blob — it reveals nothing: it is the encryption of a
/// PUBLIC, hard-coded string, so an attacker learns only that FlowMic made it.
///
/// ⚠️ It does give an offline oracle for guessing the passphrase — anyone with
/// the blob can test candidate passphrases without the server noticing. That is
/// unavoidable for any local verifier, and it is precisely the attack Argon2id's
/// 64 MiB / 3-pass cost is chosen to price out (blind_store_params.dart). It is
/// also why passphrase strength policy (E-B2) is a security control here and not
/// a usability nicety.
String createBlindStoreSentinel({
  required BlindStoreMasterKey key,
  Random? randomForNonce,
}) {
  return blindStoreSealRaw(
    key: key,
    // The reserved pseudo-entry id, so the sentinel travels the SAME seal/open
    // code path as real entries. A dedicated aad-less path would be a second
    // AEAD implementation sitting one argument away from the first — the exact
    // shape blind_store_params.dart's header forbids.
    aadSource: kBlindStoreSentinelEntryId,
    plaintext: kBlindStoreSentinelPlaintext,
    randomForNonce: randomForNonce,
  );
}

/// Answers "does [key] open [sentinel]?" — i.e. "was the re-entered passphrase
/// the right one?".
///
/// Returns a bool rather than throwing, because unlike every other path in this
/// layer, "no" here is an EXPECTED, recoverable answer with an obvious next step
/// (ask again), not a failure to report. The distinction matters: E-B4 counts
/// and speaks about entries it could not open; E-B2 simply re-prompts.
///
/// 🔴 A false return means "wrong passphrase". It must NOT be rendered as "there
/// are no cloud records" (design §2.1). The wording is E-B2's to write; this
/// function's contract is only that the two situations are distinguishable —
/// which they are, and only because this check runs BEFORE any pull.
bool blindStoreSentinelAccepts({
  required BlindStoreMasterKey key,
  required String sentinel,
}) {
  try {
    final String plain = blindStoreOpenRaw(
      key: key,
      aadSource: kBlindStoreSentinelEntryId,
      envelope: sentinel,
    );
    // GCM already authenticated the bytes, so reaching here with the wrong key
    // is not possible. The comparison guards a different thing: a well-formed
    // blob made by some OTHER FlowMic feature under the same key would
    // authenticate fine and must still not be accepted as a sentinel.
    return plain == kBlindStoreSentinelPlaintext;
  } on BlindStoreCryptoException {
    return false;
  }
}
