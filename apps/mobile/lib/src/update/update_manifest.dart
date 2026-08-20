// SPEC-REF:
//   apps/server-core/src/http/update-routes.ts — UpdateManifest / UpdatePlatform /
//     UpdateArtifact and `validateUpdateManifest`. THAT file is the contract; this
//     one mirrors it. When they disagree, that file wins.
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §1.2 (payload) / §1.3 (version comparison)
//   docs/decisions/2026-08-02-in-app-update-both-ends.md (owner 2026-08-02)
//   CLAUDE.md red line: no silent failure / unknown ≠ latest / one value answers only one question
//
// ── Why the client re-validates something the server has already validated ──
//
// Design §2.2 splits the hash gate into three doors, spread across three
// processes and three pieces of code, and states in writing that 「only door
// ③ actually protects the
// user」. This is the front half of door ③. It is not 「distrusting our own
// server」, it is:
//
//   🔴 **We cannot confirm the thing answering is actually our server.**
//   Production nginx's `location /` is
//   `try_files $uri $uri/ /index.html` ⇒ a nonexistent path returns **200 +
//   a whole page of
//   HTML** (design §1.4 records this verbatim, it is the single easiest
//   step to get wrong in this design). The same
//   shape shows up elsewhere: a public-Wi-Fi captive portal, hijacked DNS,
//   a misconfigured reverse-proxy box.
//   All of them will answer `200` for 「found it」.
//
// ⇒ 「parse failed」 here is a conclusion that **must be sayable out loud**,
// not an exception that can be swallowed.
//
// ── This validator's relationship to the server's ──────────────────────────
//
// The envelope (manifest_version / generated_at / platforms / platform
// keys / version shape)
// **copies the server's rules line for line**: the two ends must have
// exactly one answer to 「what counts as a valid manifest」.
//
// The ONE place they **deliberately differ**, with the reasoning written
// here rather than only in the docs: when the server meets a bad artifact
// it rejects the **WHOLE manifest** (503); here it **drops just that one
// entry**, and the caller answers based on 「how many usable ones are left
// for this platform」. Because the two sides are not answering the same
// question —
//   · the server asks 「should I be serving this manifest at all」 (one
//     suspicious entry and the answer is no);
//   · the client asks 「can THIS Android phone install a verifiable package
//     right now」 (a broken windows-x64 entry
//     has nothing to do with me).
// Writing them as the same answer is this repo's #1 bug shape.
//
// ── `kind` is an OPEN set, not a closed one ─────────────────────────────────
//
// 🔴 A `kind` this build has never heard of can appear in the manifest
// (`portable-zip` / `dmg` / anything in
// the future). **An unrecognized kind must never kill the whole path**, it
// just means 「this is one entry I won't install」.
// This is not a hypothetical risk: putting a **closed set** in this exact
// spot produced a P0 in 0.2.48 (the phone judged an
// unrecognized inject code as 「this item is still owed」 ⇒ the UI
// permanently said 「pending delivery」 and never converged), and within the
// same month
// it was replicated verbatim a second time. So this file **does not
// validate kind**, it just carries it through unchanged.

import 'dart:convert';

/// This platform's key in the `platforms` map. Matches the sample payload
/// in design §1.2.
const String kUpdatePlatformAndroid = 'android';

/// iOS's key — looked up in [UpdateManifest.storePlatforms], never in
/// `platforms`: iOS updates arrive through TestFlight / the App Store, so the
/// manifest carries the NEWS for it, not a downloadable artifact. Why that is
/// a separate top-level block: an ios entry with `artifacts: []` inside
/// `platforms` would be rejected as `empty_artifacts` by every fielded client
/// (including this validator, four screens down) — the announcement has to
/// ride a key old validators never read.
const String kUpdatePlatformIos = 'ios';

/// The artifact type this build **knows how to handle**. It is 「which kind
/// I will install」,
/// **NOT** 「which kinds the manifest is allowed to have」 — see the file
/// header 「`kind` is an open set」.
const String kUpdateInstallableKind = 'apk';

/// 64-digit lowercase hex —— sha256's only valid shape.
/// Copies `update-routes.ts:71`'s `SHA256_RE` verbatim: uppercase, spaces,
/// truncated, or empty all get rejected.
/// This is not a field where 「a bit looser is fine」 — it IS the gate itself.
final RegExp kSha256Re = RegExp(r'^[0-9a-f]{64}$');

/// Copies `update-routes.ts:73`'s `VERSION_RE` verbatim.
///
/// 🔴 **Deliberately does NOT do a 「looser」 version parse** (does not
/// strip `-rc1`, does not accept two segments, does not accept a `v`
/// prefix).
/// The server uses this exact regex, and every version face
/// `bump-version.mjs` touches is this exact shape.
/// Loosening it here would give 「what counts as a version number」 a
/// second answer, and one of the two answers is necessarily wrong
/// — that is precisely the shape that has shown up five times across ten
/// releases in this repo. Cannot parse it ⇒ say 「don't know」, never guess.
final RegExp kVersionRe = RegExp(r'^\d+\.\d+\.\d+$');

/// Copies `update-routes.ts:75`'s `PLATFORM_RE` verbatim.
final RegExp kPlatformKeyRe = RegExp(r'^[a-z0-9][a-z0-9-]*$');

/// One downloadable artifact. Fields correspond one-to-one with
/// `UpdateArtifact` (`update-routes.ts:77-88`).
class UpdateArtifact {
  const UpdateArtifact({
    required this.kind,
    required this.locale,
    required this.filename,
    required this.url,
    required this.sha256,
    required this.size,
  });

  /// `apk` / `msi` / anything in the future. **Open set** — see the file header.
  final String kind;
  final String? locale;

  /// The client writes this filename to disk ⇒ path separators are not
  /// allowed (see [_artifactFrom]).
  final String filename;

  /// Absolute http(s) URL. **Plain http IS allowed** — the download center
  /// IS HTTP,
  /// which is EXACTLY the whole reason sha256 exists (design §2.1).
  final String url;
  final String sha256;
  final int size;
}

/// One platform's latest artifacts. Corresponds to `UpdatePlatform`
/// (`update-routes.ts:90-94`).
class UpdatePlatform {
  const UpdatePlatform({
    required this.version,
    required this.notesUrl,
    required this.artifacts,
    required this.droppedArtifacts,
  });

  final String version;
  final String? notesUrl;

  /// **Contains ONLY artifacts that passed item-by-item validation.** An
  /// entry missing sha256 / with an invalid url will not appear in
  /// here —  it is recorded in [droppedArtifacts] instead, so the caller
  /// can say 「the update information is incomplete」 based on that
  /// (design §3, line 4), rather than silently topping it up with a
  /// default value.
  final List<UpdateArtifact> artifacts;

  /// How many entries were dropped. **This number MUST exist**: when
  /// `artifacts` is empty,
  /// 「this platform has no artifacts at all」 and 「the artifacts were all
  /// there but none of them validated」 are two different things,
  /// and only the latter tells us we are looking at a bad manifest.
  final int droppedArtifacts;
}

/// A platform whose updates a STORE delivers. Corresponds to
/// `UpdateStorePlatform` in update-routes.ts (that file is the contract).
/// No artifacts, no sha256 — there is nothing to download, only news and a
/// page the user can walk to.
class UpdateStorePlatform {
  const UpdateStorePlatform({
    required this.version,
    required this.notesUrl,
    required this.storeUrl,
  });

  final String version;
  final String? notesUrl;

  /// The store page (TestFlight invite / store listing). Optional — the news
  /// is real even while nobody has minted the link yet.
  final String? storeUrl;
}

/// Corresponds to `UpdateManifest` (`update-routes.ts:96-102`).
class UpdateManifest {
  const UpdateManifest({
    required this.generatedAt,
    required this.platforms,
    this.storePlatforms = const <String, UpdateStorePlatform>{},
  });

  final String generatedAt;

  /// **A map, not two fixed fields** —— adding `macos-arm64` must be
  /// additive (§1.2).
  final Map<String, UpdatePlatform> platforms;

  /// Store-delivered platforms (today: `ios`). Empty when the manifest does
  /// not carry the optional `store_platforms` block — absent and empty mean
  /// the same thing, so the two are deliberately not distinguished here.
  final Map<String, UpdateStorePlatform> storePlatforms;
}

/// The parse result. **A closed set**: the caller must have a sentence
/// ready for every one of them.
sealed class ManifestParse {
  const ManifestParse();
}

class ManifestParsed extends ManifestParse {
  const ManifestParsed(this.manifest);
  final UpdateManifest manifest;
}

/// Rejected. [reason] is a **machine-readable short code meant for
/// diagnostics**, not a sentence meant for the user ——
/// what the user sees is the four-language copy the caller picks based on
/// the outcome.
class ManifestRejected extends ManifestParse {
  const ManifestRejected(this.reason);
  final String reason;
}

/// Parse the response body into a manifest, or say clearly why it could not.
///
/// 🔴 **It REJECTS, it does not PATCH.** A bad manifest silently topped up
/// with default values would be served to the user looking
/// 「normal」 — the server-side validator's file header
/// (`update-routes.ts:114-117`)
/// says this exact sentence verbatim, this file copies its posture.
ManifestParse parseUpdateManifest(String body) {
  final Object? raw;
  try {
    raw = jsonDecode(body);
  } on FormatException {
    // A captive portal / nginx try_files's whole-page HTML lands here.
    // This is the ONE case this function most needs to catch, not an edge case.
    return const ManifestRejected('unparsable_json');
  }
  return validateUpdateManifest(raw);
}

/// A pure validator —— no IO, so the entire set of shape rules is
/// unit-testable without a network.
ManifestParse validateUpdateManifest(Object? raw) {
  if (raw is! Map<String, Object?>) return const ManifestRejected('not_an_object');
  if (raw['manifest_version'] != 1) {
    return const ManifestRejected('unsupported_manifest_version');
  }
  final Object? generatedAt = raw['generated_at'];
  if (generatedAt is! String || generatedAt.trim().isEmpty) {
    return const ManifestRejected('missing_generated_at');
  }
  final Object? platformsRaw = raw['platforms'];
  if (platformsRaw is! Map<String, Object?>) {
    return const ManifestRejected('missing_platforms');
  }
  // An empty platforms is the most dangerous kind of 「valid」: it would
  // read as 「no platform has an update」.
  // That is not a fact we know — what we know is that this manifest has no
  // content. (The server behaves the same way at :126-128.)
  if (platformsRaw.isEmpty) return const ManifestRejected('empty_platforms');

  final Map<String, UpdatePlatform> platforms = <String, UpdatePlatform>{};
  for (final MapEntry<String, Object?> entry in platformsRaw.entries) {
    final String key = entry.key;
    if (!kPlatformKeyRe.hasMatch(key)) {
      return ManifestRejected('bad_platform_key:$key');
    }
    final Object? p = entry.value;
    if (p is! Map<String, Object?>) return ManifestRejected('bad_platform:$key');

    final Object? version = p['version'];
    if (version is! String || !kVersionRe.hasMatch(version)) {
      return ManifestRejected('bad_version:$key');
    }
    final Object? notesUrl = p['notes_url'];
    if (notesUrl != null && (notesUrl is! String || !isHttpUrl(notesUrl))) {
      return ManifestRejected('bad_notes_url:$key');
    }
    final Object? artifactsRaw = p['artifacts'];
    if (artifactsRaw is! List<Object?> || artifactsRaw.isEmpty) {
      return ManifestRejected('empty_artifacts:$key');
    }

    // ⚠️ Dropped item by item rather than rejecting the whole thing — the
    // ONE place this differs from the server, reasoning in the file header.
    final List<UpdateArtifact> artifacts = <UpdateArtifact>[];
    int dropped = 0;
    for (final Object? a in artifactsRaw) {
      final UpdateArtifact? parsed = _artifactFrom(a);
      if (parsed == null) {
        dropped++;
      } else {
        artifacts.add(parsed);
      }
    }
    platforms[key] = UpdatePlatform(
      version: version,
      notesUrl: notesUrl as String?,
      artifacts: artifacts,
      droppedArtifacts: dropped,
    );
  }

  // The optional store block — same envelope posture as the server's
  // validator (reject, never patch): a store entry with a mangled version
  // would make this phone compare against garbage and then say something it
  // cannot back.
  final Map<String, UpdateStorePlatform> storePlatforms =
      <String, UpdateStorePlatform>{};
  final Object? storeRaw = raw['store_platforms'];
  if (storeRaw != null) {
    if (storeRaw is! Map<String, Object?>) {
      return const ManifestRejected('bad_store_platforms');
    }
    for (final MapEntry<String, Object?> entry in storeRaw.entries) {
      final String key = entry.key;
      if (!kPlatformKeyRe.hasMatch(key)) {
        return ManifestRejected('bad_store_platform_key:$key');
      }
      final Object? p = entry.value;
      if (p is! Map<String, Object?>) return ManifestRejected('bad_store_platform:$key');
      final Object? version = p['version'];
      if (version is! String || !kVersionRe.hasMatch(version)) {
        return ManifestRejected('bad_store_version:$key');
      }
      final Object? notesUrl = p['notes_url'];
      if (notesUrl != null && (notesUrl is! String || !isHttpUrl(notesUrl))) {
        return ManifestRejected('bad_store_notes_url:$key');
      }
      final Object? storeUrl = p['store_url'];
      if (storeUrl != null && (storeUrl is! String || !isHttpUrl(storeUrl))) {
        return ManifestRejected('bad_store_url:$key');
      }
      storePlatforms[key] = UpdateStorePlatform(
        version: version,
        notesUrl: notesUrl as String?,
        storeUrl: storeUrl as String?,
      );
    }
  }

  return ManifestParsed(
    UpdateManifest(
      generatedAt: generatedAt,
      platforms: platforms,
      storePlatforms: storePlatforms,
    ),
  );
}

/// One artifact, or null (＝ this one is unusable, the caller says 「the
/// update information is incomplete」 based on that).
///
/// 🔴 **`kind` is only checked for 「being a non-empty string」, not for
/// WHAT it is.** See the file header.
UpdateArtifact? _artifactFrom(Object? a) {
  if (a is! Map<String, Object?>) return null;
  final Object? kind = a['kind'];
  if (kind is! String || kind.trim().isEmpty) return null;
  final Object? locale = a['locale'];
  if (locale != null && locale is! String) return null;
  final Object? filename = a['filename'];
  if (filename is! String || filename.trim().isEmpty) return null;
  // The client writes this filename to disk under its own download
  // directory. `..`/`/`/`\` would let a tampered manifest
  // direct the client to write outside that directory — reject at the
  // boundary beats each call site being careful on its own (the server
  // does the same at :156-160).
  if (filename.contains('/') || filename.contains(r'\') || filename.contains('..')) {
    return null;
  }
  // 🔴 The hash gate. Empty string, uppercase, truncated, missing — all
  // die right here.
  final Object? sha256 = a['sha256'];
  if (sha256 is! String || !kSha256Re.hasMatch(sha256)) return null;
  final Object? url = a['url'];
  if (url is! String || !isHttpUrl(url)) return null;
  final Object? size = a['size'];
  if (size is! int || size <= 0) return null;
  return UpdateArtifact(
    kind: kind,
    locale: locale as String?,
    filename: filename,
    url: url,
    sha256: sha256,
    size: size,
  );
}

/// Absolute http(s) URL, no other scheme is recognized.
///
/// owner's own words were 「the link might be a different URL」 — that
/// means 「it might be on a different host」,
/// **NOT 「it might be anything at all」**. `file:` would let a tampered
/// manifest point the client at a local file
/// (the server says the exact same thing at :185-195).
bool isHttpUrl(String v) {
  final Uri? u = Uri.tryParse(v);
  if (u == null || !u.isAbsolute) return false;
  return u.scheme == 'http' || u.scheme == 'https';
}

/// Three number segments, or null.
///
/// 🔴 null is an answer that **must be handled on its own**, it must not
/// collapse into false at the call site ——
/// 「don't know whether it's an update」 and 「it's not an update」 lead to
/// completely opposite screens on this chain.
List<int>? parseVersion(String raw) {
  final String v = raw.trim();
  if (!kVersionRe.hasMatch(v)) return null;
  return v.split('.').map(int.parse).toList(growable: false);
}

/// Compares [a] and [b] segment by segment: -1 / 0 / 1, **null if either
/// side fails to parse**.
///
/// Design §1.3: only a manifest version strictly `>` the local version
/// counts as 「there is a new version」; both `==` and `<` count as
/// 「already up to date」. **There is never a downgrade path** (the card's
/// own rule: 「version numbers only go forward, never back — ship a bad
/// version, and the fix is the next version」).
int? compareVersions(String a, String b) {
  final List<int>? x = parseVersion(a);
  final List<int>? y = parseVersion(b);
  if (x == null || y == null) return null;
  for (int i = 0; i < 3; i++) {
    if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}
