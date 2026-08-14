// SPEC-REF:
//   apps/server-core/src/http/update-routes.ts (file header: 「这是哈希闸的第
//     ② 道」 — "this is the second of the hash gates" — that passage splits
//     three gates across three processes, and states verbatim that the third
//     gate is 「客户端下载完必须自己再算一遍，不符就删包 + 响亮失败」 — "once
//     the client finishes downloading it must recompute the hash itself, and
//     on mismatch delete the package + fail loudly". **This file IS that
//     third gate.**)
//   apps/mobile/lib/src/update/update_manifest.dart (UpdateArtifact — the
//     shape rules for sha256 / size / filename have already been enforced
//     there once; this file consumes them)
//   apps/mobile/lib/src/diag/diag_upload.dart (this file copies two things
//     from it: the HTTP typedef seam, and **a closed-set outcome instead of a
//     generic failure**)
//   CLAUDE.md red line: no silent failure (banned in both directions) / one
//     value answers one question
//
// ── The one question this layer answers ─────────────────────────────────────
//
// 「**Does this phone's disk currently hold an install package that IS the
// one the official site published**」. It does not decide whether to upgrade
// (that is update_check.dart), and it does not install (that is
// update_installer.dart).
//
// ── 🔴 The hash is the ONLY gate on this chain that protects the user ───────
//
// The download centre is **HTTP only** (443 is dropped outright), and the
// package for phase one is **unsigned**. So once the bytes are on disk and
// before they are handed to the system installer, `sha256` is our **only**
// criterion.
// ⇒ Mismatch ⇒ **delete the file** + land in its own outcome slot. **A file
// that has not been verified must never be handed out.**
// [UpdateDownloadResult.file] is non-null ONLY for
// [UpdateDownloadOutcome.verified] — this is not a convention, it is what
// makes "casually reuse the file from a failure branch anyway" impossible at
// the type level.
//
// ⚠️ **It must equally state what it does NOT protect against** (the
// `update-routes.ts` file header explicitly demands this sentence): a
// compromised VPS can hand out a malicious package **and** a matching sha256
// at the same time — the manifest and the package come from the same
// machine. What closes THAT hole is phase-two code signing, not this file.
// 🔴 **So nothing in this file may be read as "the update chain is
// hardened / secure."** It accomplishes exactly one verifiable thing: **the
// bytes you install are the bytes the official site's manifest described.**
//
// ── ⚠️ Compare LENGTH first, THEN hash — this order is a judgment criterion,
//    not a style choice ────────────────────────────────────────────────────
//
// A truncated download **will also** fail the hash check. Compare the hash
// first, and 「your network dropped」 gets reported as 「the package you got
// is not the one we shipped」 — a frightening falsehood, and one pointing at
// a completely different action (retry vs. don't install). So length is
// judged first, and it gets its own outcome slot.
// This is this repo's 「one value answers one question」 rule, in the shape
// it takes on the failure side.

import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:path_provider/path_provider.dart';

import '../signaling/lan_pinning.dart' show HttpTrust, openHttpClient;

import 'update_manifest.dart';

/// The subdirectory name the update package lands in.
///
/// 🔴 **It must match the `path` on `<files-path>` in
/// `android/app/src/main/res/xml/flowmic_update_paths.xml`**, because
/// `getApplicationSupportDirectory()` on Android returns exactly
/// `Context.getFilesDir()` [measured 2026-08-08, this machine dev-pc-a: read
/// `getApplicationSupportPath()` from path_provider_android 2.3.1 in the pub
/// cache — it takes `_applicationContext.filesDir`].
///
/// ⚠️ The failure direction when they disagree is **loud**:
/// `FileProvider.getUriForFile` throws `IllegalArgumentException` for a file
/// not covered by any `<paths>` root, and the Kotlin side turns that into a
/// NAMED refusal (see `UpdateInstaller.kt`). It **will not** quietly hand out
/// a broken URI.
const String kUpdateDownloadDirName = 'update';

/// The verdict of one "download + verify" run. **A closed set** — the UI must
/// give each member its own four-language sentence.
enum UpdateDownloadOutcome {
  /// The bytes are on disk, and both length and sha256 match the manifest
  /// exactly.
  /// **Only this one** ever carries [UpdateDownloadResult.file].
  verified,

  /// 🔴 **Finished downloading, but the hash does not match ⇒ file already
  /// deleted.**
  ///
  /// The action available to the user is "retry on a different network" or
  /// "don't install" — **not** "just tap it again" — which is why it is kept
  /// separate from [sizeMismatch]: THAT one is "your connection dropped,
  /// retrying is fine."
  hashMismatch,

  /// The byte count received does not match the manifest's `size` (a
  /// truncation, or the response was something else entirely). **Deliberately
  /// kept separate** from [hashMismatch] — reasoning in the file header,
  /// "compare length first, then hash."
  sizeMismatch,

  /// Reached the download address, and it refused to hand over the file (404
  /// / 403 / 5xx / any non-200).
  serverRefused,

  /// Could not reach it at all, or the connection dropped mid-transfer.
  ///
  /// ⚠️ This is **NOT the same thing** as [UpdateCheckOutcome.unreachable]:
  /// that one means "could not ask the official site"; this one means "the
  /// download centre gave us nothing." The manifest and the artifact CAN live
  /// on two different machines (owner 2026-08-02: 「下载链接有可能是其他的
  /// URL」 — "the download link could be a different URL"), so merging these
  /// two sentences would send someone to inspect the wrong half of the chain.
  unreachable,

  /// This device could not write it (out of space / directory could not be
  /// created / permission). **Has nothing to do with the network** — the
  /// user's action is to free up space, not switch Wi-Fi.
  cannotWrite,
}

class UpdateDownloadResult {
  const UpdateDownloadResult(this.outcome, {this.file, this.detail});

  final UpdateDownloadOutcome outcome;

  /// 🔴 **Non-null ONLY for [UpdateDownloadOutcome.verified].** See the file
  /// header.
  final File? file;

  /// Machine-readable diagnostics (status code, received/expected byte
  /// counts, the raw exception). **Never surfaced on its own.**
  final String? detail;
}

/// The byte-source seam. Production goes through `dart:io`; tests pass a
/// fake — the same stance as `UpdateManifestFetcher`, and this is exactly why
/// this chain can be falsified on a machine with no network.
typedef UpdateByteSource = Future<({int status, Stream<List<int>> bytes})>
    Function(Uri url);

/// FIX-014 test-only observability seam. `HttpClient` has no public
/// `isClosed` getter anywhere in `dart:io` (checked against the SDK source:
/// the only flag is the private `_HttpClient._closing`) — the sole way
/// anything outside this file can ask "did you already get closed" is to try
/// to use the client and watch it throw `StateError('Client is closed')`.
/// This hands a test the EXACT instance `_open()` builds, right after it is
/// built, so that question can be asked about the real client after driving
/// a real response through the real `downloadAndVerify` — nothing in the
/// test re-implements the close logic being verified.
///
/// Production never assigns this; the call site below no-ops on the default
/// `null`. See `test/update_download_client_close_test.dart`.
@visibleForTesting
void Function(HttpClient client)? debugOnUpdateHttpClientOpened;

Future<({int status, Stream<List<int>> bytes})> _open(Uri url) async {
  // D2LAN-B3 — 🔴 THE SIXTH SITE. The design doc counted five bare
  // `HttpClient()`
  // constructions and this one was not among them; it is the one that pulls the
  // APK. Explicitly [HttpTrust.publicCa]: the download host is not necessarily
  // the manifest host (today it is a plain-HTTP LAN download centre), so TLS is
  // not what makes this byte stream trustworthy — the manifest's sha256 is, and
  // `verifyDownloadedArtifact` is where that is checked. A pin here would imply
  // a guarantee this leg does not make.
  final HttpClient client = openHttpClient(
    trust: HttpTrust.publicCa,
    connectionTimeout: const Duration(seconds: 15),
  ).client;
  debugOnUpdateHttpClientOpened?.call(client);
  final HttpClientRequest req = await client.getUrl(url);
  final HttpClientResponse res = await req.close().timeout(
    const Duration(seconds: 30),
  );

  // FIX-014 — from here on `client` has exactly ONE owner: this function.
  // `downloadAndVerify` never sees `client` itself, only the `(status,
  // bytes)` tuple returned below, so none of its return paths — today's or
  // any added later — can forget to close it; they were never the ones
  // holding it. The two `client.close(force: true)` call sites below sit on
  // mutually exclusive branches (the first one returns), so at most one of
  // them ever runs for a given call — never both, never neither.
  //
  // A non-200 response is never read by the caller (`downloadAndVerify`
  // returns `serverRefused` immediately, without touching `bytes`), so the
  // "listen to the stream" moment that would trigger the `finally` a few
  // lines down never arrives on this path — that was the leak this branch
  // closes. Close synchronously, right here, on the one path nothing
  // downstream ever reads.
  if (res.statusCode != 200) {
    client.close(force: true);
    return (status: res.statusCode, bytes: const Stream<List<int>>.empty());
  }

  // The client must stay alive until the bytes are fully read — an immediate
  // close(force:true) here would strangle a stream that has not been read
  // yet.
  // This async* wrapper is the only close site left once execution is past
  // the branch above (which already returned), so it is exactly-once, not a
  // double-close: 「读完（或读炸）之后一定收摊」 ("clean up for certain once
  // reading finishes — or blows up"), and only on the 200 path —
  // the only path `downloadAndVerify` ever listens to `bytes` on (see its
  // `await for (... in res.bytes)`, unconditionally reached once status has
  // already been checked equal to 200).
  Stream<List<int>> body() async* {
    try {
      // A timeout between chunks. Without it, a connection that **stays
      // connected but produces no bytes** would hang forever, and the UI
      // would show a never-ending "downloading" — a progress bar with no
      // finish line is just another way of violating "no silent failure."
      yield* res.timeout(const Duration(seconds: 60));
    } finally {
      client.close(force: true);
    }
  }

  return (status: res.statusCode, bytes: body());
}

/// The progress callback. [total] may be null — we do **NOT** treat the
/// server's `Content-Length` as ground truth; the caller passes in the
/// manifest's own `size` (that is the number we actually have a criterion
/// for).
typedef UpdateDownloadProgress = void Function(int received, int? total);

/// Downloads [artifact] into [into], and **proves** it is the exact one the
/// manifest describes.
///
/// [into] is a directory **owned exclusively by the updater** — this
/// function's first act is to wipe it clean. Do not put anything else in
/// there. Reason: a half-written file left over from a previous failed
/// attempt, sharing this run's filename ⇒ without clearing it, the new bytes
/// would silently "continue" onto the old ones.
///
/// 🔴 This function **never throws**. Every path must land on some member of
/// [UpdateDownloadOutcome].
Future<UpdateDownloadResult> downloadAndVerify({
  required UpdateArtifact artifact,
  required Directory into,
  UpdateByteSource open = _open,
  UpdateDownloadProgress? onProgress,
}) async {
  // ① The destination. `filename` has already been enforced once in
  // update_manifest.dart's `_artifactFrom` (`/`, `\`, `..` all refused), so it
  // can be concatenated directly here.
  final String sep = Platform.pathSeparator;
  final String base = into.path.endsWith(sep) ? into.path : '${into.path}$sep';
  final File target = File('$base${artifact.filename}');

  // ⓪ 🔴 Reuse: if disk already holds a package with this filename that
  //    **fully verifies** (length + sha256 both match exactly), use it
  //    directly, never re-download. owner 2026-08-13: the first tap on
  //    install has to go to Settings first to authorize "install unknown
  //    apps", and after authorization returns the user taps again — that
  //    already-downloaded, already-verified 78 MB package should not be
  //    thrown away and re-fetched. Reuse **must go through the SAME gate**
  //    (the file header states sha256 is this chain's ONLY criterion): trusting
  //    "the file exists" alone would let a half-written package / a swapped
  //    package through. Fails verification ⇒ falls through to clear-the-dir
  //    + re-download below, with the exact same failure direction as never
  //    having downloaded at all. This also survives the app being killed by
  //    the system while sitting on the settings page — the controller's
  //    in-memory state is gone, but the package still sits on disk, and it is
  //    recognised the same way the next time in.
  final UpdateDownloadResult? reused = await _reuseIfVerified(target, artifact);
  if (reused != null) return reused;

  // ①' Reuse did not succeed (absent / wrong length / wrong hash) ⇒ wipe this
  //    updater-exclusive directory and rebuild it. A half-written file left
  //    over from a previous failed attempt, sharing this run's filename ⇒
  //    without clearing it, the new bytes would "continue" onto the old ones.
  try {
    if (await into.exists()) {
      await into.delete(recursive: true);
    }
    await into.create(recursive: true);
  } on Object catch (e) {
    return UpdateDownloadResult(
      UpdateDownloadOutcome.cannotWrite,
      detail: 'prepare_dir:$e',
    );
  }

  // ② The URL. The manifest validator has already guaranteed it is an
  // absolute http(s) URL, but `Uri.parse` can still throw, and a thrown Error
  // (not an Exception) has already cost this repo three separate silent-
  // failure incidents.
  final Uri url;
  try {
    url = Uri.parse(artifact.url);
  } on Object catch (e) {
    return UpdateDownloadResult(
      UpdateDownloadOutcome.unreachable,
      detail: 'bad_url:$e',
    );
  }

  final ({int status, Stream<List<int>> bytes}) res;
  try {
    res = await open(url);
  } on Object catch (e) {
    return UpdateDownloadResult(
      UpdateDownloadOutcome.unreachable,
      detail: 'open:$e',
    );
  }
  if (res.status != 200) {
    return UpdateDownloadResult(
      UpdateDownloadOutcome.serverRefused,
      detail: 'http_${res.status}',
    );
  }

  // ③ Compute the hash while writing. **Never load 45 MB into memory** — an
  // OOM would show up in the shape of "the app just vanished", which is the
  // least explainable of all possible failures.
  Digest? digest;
  final ByteConversionSink hasher = sha256.startChunkedConversion(
    ChunkedConversionSink<Digest>.withCallback(
      (List<Digest> all) => digest = all.single,
    ),
  );
  final IOSink sink = target.openWrite();
  int received = 0;
  try {
    await for (final List<int> chunk in res.bytes) {
      sink.add(chunk);
      hasher.add(chunk);
      received += chunk.length;
      onProgress?.call(received, artifact.size);
    }
    await sink.flush();
    await sink.close();
    hasher.close();
  } on Object catch (e) {
    // If "the network dropped" and "the disk is full" cannot be told apart,
    // the user will go fix the wrong one. `FileSystemException` is the most
    // direct criterion available to us; everything else counts as a network
    // failure.
    try {
      await sink.close();
    } on Object catch (_) {
      // Failing to close is not a reason to stop deleting the file — what
      // gets swallowed here is "the cleanup itself failed to close cleanly",
      // and the actual verdict (the outcome returned below) is not swallowed
      // in the slightest.
    }
    final bool disk = e is FileSystemException;
    final String note = await _discard(target);
    return UpdateDownloadResult(
      disk ? UpdateDownloadOutcome.cannotWrite : UpdateDownloadOutcome.unreachable,
      detail: 'stream:$e$note',
    );
  }

  // ④ 🔴 Compare length first. Reasoning in the file header: a truncation and
  // tampering point at opposite actions.
  if (received != artifact.size) {
    final String note = await _discard(target);
    return UpdateDownloadResult(
      UpdateDownloadOutcome.sizeMismatch,
      detail: 'got=$received want=${artifact.size}$note',
    );
  }

  // ⑤ 🔴 The hash gate itself. `Digest.toString()` produces lowercase hex,
  // which is the exact same shape `kSha256Re` recognises in the manifest.
  final String actual = digest!.toString();
  if (actual != artifact.sha256) {
    final String note = await _discard(target);
    return UpdateDownloadResult(
      UpdateDownloadOutcome.hashMismatch,
      detail: 'got=$actual want=${artifact.sha256}$note',
    );
  }

  return UpdateDownloadResult(UpdateDownloadOutcome.verified, file: target);
}

/// Reuses an already-on-disk copy of the package: returns [verified] only if
/// BOTH length + sha256 match the manifest exactly, otherwise returns null
/// (leaving [downloadAndVerify] to do "clear the dir + re-download").
///
/// 🔴 Goes through **the exact same hash gate** as the download path, not
/// "trust it because the file exists" — this file's header states sha256 is
/// this chain's only criterion protecting the user. Computes the hash while
/// reading, never loading the whole package into memory (the same discipline
/// as [downloadAndVerify]).
///
/// ⚠️ It does **NOT delete** a file that fails verification: deletion and
/// rebuilding are both handled uniformly by [downloadAndVerify]'s clear-the-
/// dir step; this function only answers "can THIS one be used as-is." **Any
/// disk-read exception is treated as "cannot reuse" (returns null)** — a
/// half-read file must never be allowed to pass itself off as verified —
/// that is exactly what this gate exists to block.
///
/// ⚠️ Deliberately does **NOT report progress**: reuse is only a local hash
/// recomputation (a few hundred milliseconds), not a download. Wiring a
/// progress callback onto it would light up a progress bar on screen that
/// looks like "downloading again", which is the exact opposite of what this
/// change is meant to do (stop the user from thinking it is re-downloading).
Future<UpdateDownloadResult?> _reuseIfVerified(
  File target,
  UpdateArtifact artifact,
) async {
  try {
    if (!await target.exists()) return null;
    if (await target.length() != artifact.size) return null; // truncated / a different package ⇒ do not reuse
    Digest? digest;
    final ByteConversionSink hasher = sha256.startChunkedConversion(
      ChunkedConversionSink<Digest>.withCallback(
        (List<Digest> all) => digest = all.single,
      ),
    );
    int seen = 0;
    await for (final List<int> chunk in target.openRead()) {
      hasher.add(chunk);
      seen += chunk.length;
    }
    hasher.close();
    if (seen != artifact.size) return null; // what was actually read disagrees with what was declared ⇒ do not reuse
    if (digest!.toString() != artifact.sha256) return null; // it has been swapped ⇒ do not reuse
    return UpdateDownloadResult(UpdateDownloadOutcome.verified, file: target);
  } on Object {
    return null; // any disk-read hiccup at all falls back to re-download, never treat a half-read file as verified
  }
}

/// Deletes a file that failed verification, and records "did the delete
/// actually succeed" into `detail`.
///
/// 🔴 A failed deletion does **NOT** make the verdict any better: the outcome
/// is still that failure, [UpdateDownloadResult.file] is still null ⇒ the
/// install step gets nothing to work with either way. This is recorded here
/// so that "there's still a bad package sitting on disk" can be SAID in
/// diagnostics, rather than only known in someone's head.
Future<String> _discard(File f) async {
  try {
    if (await f.exists()) await f.delete();
    return '';
  } on Object catch (e) {
    return ' undeleted:$e';
  }
}

/// Production default: the directory is supplied by `path_provider`.
///
/// ⚠️ **This is not a friendly empty implementation** (13 册 §7 F1 ②): it
/// either genuinely downloads, or is explicitly swapped out by a test.
/// Falls to [UpdateDownloadOutcome.cannotWrite] when the directory cannot be
/// obtained, rather than pretending success.
Future<UpdateDownloadResult> downloadUpdateArtifact(
  UpdateArtifact artifact, {
  UpdateDownloadProgress? onProgress,
}) async {
  final Directory support;
  try {
    support = await getApplicationSupportDirectory();
  } on Object catch (e) {
    return UpdateDownloadResult(
      UpdateDownloadOutcome.cannotWrite,
      detail: 'no_support_dir:$e',
    );
  }
  final String sep = Platform.pathSeparator;
  return downloadAndVerify(
    artifact: artifact,
    into: Directory('${support.path}$sep$kUpdateDownloadDirName'),
    onProgress: onProgress,
  );
}
