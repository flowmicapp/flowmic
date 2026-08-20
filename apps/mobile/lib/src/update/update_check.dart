// SPEC-REF:
//   apps/server-core/src/http/update-routes.ts (GET /api/updates/latest —
//     200/405/503, not mounted ⇒ the router's 404)
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §3 (the failure-
//     direction table — every row
//     is a behaviour that MUST be met, not decoration)
//   apps/mobile/lib/src/diag/diag_upload.dart (this file copies two things
//     from it: the HTTP typedef
//     seam, and **a closed-set outcome rather than one generic failure**)
//   CLAUDE.md red line: no silent failures / unknown ≠ latest
//
// ── THE ONE QUESTION THIS LAYER ANSWERS ────────────────────────────────
//
// 「**should this phone update right now, and what's the evidence**」. It does
// not download, does not install, does not touch the UI.
//
// 🔴 **Unknown ≠ latest.** Every kind of failure on this chain — could not be
// reached, could not answer, could not be read, this platform has no entry,
// we don't even know our own version — must land in **its own dedicated
// slot**, and **no slot is allowed to say 「already up to date」** unless we
// genuinely obtained a comparable version number and the comparison came out
// not-newer.
// The complete table is in [UpdateCheckOutcome]'s per-member documentation.
//
// ⚠️ Why every failure gets its own slot instead of one `failed`: design draft
// §5.1 states, verbatim,
// 「each failure speaks for itself …… must never be collapsed into one 'update
// failed'」. They **point at different actions**:
// 「this server doesn't provide update info」 sends someone to ask elsewhere;
// 「temporarily unavailable」 tells someone to wait a bit;
// 「can't connect」 sends someone to check their own network. Collapse them
// into one sentence and none of the three actions is achievable any more.

import 'dart:convert';
import 'dart:io';

import '../auth/saas_endpoint.dart';
import '../signaling/http_endpoint.dart';
import '../signaling/lan_pinning.dart' show HttpTrust, openHttpClient;
import 'update_manifest.dart';

/// The manifest endpoint's absolute path. The exact same string as
/// `update-routes.ts:67`'s `UPDATE_MANIFEST_PATH`.
const String kUpdateManifestPath = '/api/updates/latest';

/// Build-time override for 「where to ask about updates」.
/// `--dart-define=FLOWMIC_UPDATE_ENDPOINT=…`.
const String kUpdateEndpointDefineKey = 'FLOWMIC_UPDATE_ENDPOINT';

/// 🔴 **「which server am I connected to」 and 「which is the latest FlowMic
/// version」 are two different questions.**
///
/// The first version of this wrote `resolveSaasEndpoint()`, and that value
/// can be pointed at an internal-network machine by
/// `--dart-define=FLOWMIC_SAAS_ENDPOINT` (that is exactly how private-domain
/// builds use it).
/// So 「I pointed the relay at the LAN」 would **incidentally** carry 「where
/// to ask about updates」 along with it —
/// one value answering two questions, the #1 shape that has shown up five
/// times across this repo's ten releases, and I built it a sixth time myself.
///
/// Design draft §1.1 has already pinned the answer: **both client platforms
/// always ask the official site**, because 「which is the latest FlowMic
/// version」
/// is a **global fact**, unrelated to which server you happen to be connected
/// to (a self-hosted deployment's users should still receive App updates).
///
/// ⇒ The default reaches directly for [kDefaultSaasEndpoint] (the official-
/// site constant itself), **bypassing**
/// `resolveSaasEndpoint()`; changing it separately requires its own define.
/// ⚠️ The failure direction is safe: if it really does get pointed at a
/// machine with no such route mounted ⇒ 404 ⇒
/// 「this server doesn't provide update info」, degrading to the status quo,
/// never falsely claiming 「already up to date」.
String resolveUpdateEndpoint() {
  const String override = String.fromEnvironment(kUpdateEndpointDefineKey);
  return override.isNotEmpty ? override : kDefaultSaasEndpoint;
}

/// Which manifest key this device reads. iOS → [kUpdatePlatformIos] (resolved
/// against `store_platforms` — see `_decide`), everything else →
/// [kUpdatePlatformAndroid], which is exactly what the pre-iOS builds always
/// asked for. A runtime judgement, not a define: 「which OS am I on」 is a fact
/// the process can read, unlike 「does this build carry the feature」.
String defaultUpdatePlatform() =>
    Platform.isIOS ? kUpdatePlatformIos : kUpdatePlatformAndroid;

/// The conclusion of one check. **A closed set** — the UI must give each
/// member its own four-language sentence.
enum UpdateCheckOutcome {
  /// The manifest's version is strictly greater than this device's own
  /// version (design draft §1.3).
  ///
  /// ⚠️ It does **NOT guarantee** we can install: see [UpdateCheckResult.installable].
  updateAvailable,

  /// The manifest version is `==` or `<` this device's own version.
  ///
  /// 🔴 **The ONLY member in this whole table allowed to show 「already up to
  /// date」 on screen** (design draft §3 row 7).
  /// And when it does, it **must always carry 「last checked successfully at
  /// …」 alongside it** — see
  /// [UpdateCheckResult.comparedAt]'s doc; that line is the sole evidence for
  /// this sentence.
  upToDate,

  /// 🔴 **Cannot even read which version this device itself is** ⇒ nothing to
  /// compare against, so nothing can be asserted.
  ///
  /// `AppVersionPort.appVersion()`'s contract states explicitly 「null = truly
  /// could not be read」,
  /// and the version string could also be a shape we don't recognise
  /// ([parseVersion] returns null).
  ///
  /// ⚠️ **This row is NOT in design draft §3's table — it was added this
  /// round.** The reason for adding it is that table's own governing
  /// principle:
  /// falling into [upToDate] in this situation would be passing off 「don't
  /// know」 as 「latest」 —
  /// a build that has never once been able to read its own version would
  /// **permanently show 「already up to date」**,
  /// and that is precisely what that table exists to prevent.
  ownVersionUnknown,

  /// The manifest is reachable and its envelope is valid, but **this
  /// platform's own entry cannot be used** (design draft §3 row 4):
  /// entry missing / every artifact is missing a sha256, or has an invalid
  /// url.
  ///
  /// 🔴 **Do not download.** The UI says 「update info incomplete, cannot
  /// verify the install package」 + a link to the downloads page.
  incompleteInfo,

  /// Endpoint 404 —「**this deployment** doesn't provide an update manifest」
  /// (design draft §3 row 2).
  /// A deployment with no `FLOWMIC_UPDATE_MANIFEST_PATH` configured lands on
  /// the router's 404.
  noManifestHere,

  /// Endpoint 503 (`UPDATE_MANIFEST_UNAVAILABLE`), or some other non-200
  /// response.
  /// **We DID reach the server — it is the server saying it cannot answer
  /// right now** (design draft §3 row 3, first half).
  unavailable,

  /// Never reached it at all: DNS failure / timeout / connection refused / the
  /// endpoint string isn't even a requestable address.
  /// (Design draft §3 row 3, second half. Kept separate from [unavailable]
  /// because one tells someone to wait, the other tells someone to check
  /// their network.)
  unreachable,

  /// 200, but what it answered with is not a manifest.
  ///
  /// 🔴 What this slot catches is **「the file is gone」 disguised as 「found
  /// it」**: production nginx's
  /// `try_files $uri $uri/ /index.html` answers a non-existent path with 200 +
  /// a full HTML page
  /// (design draft §1.4); a captive portal and a hijacked DNS are the same
  /// shape.
  malformed,
}

/// The complete conclusion of one check.
class UpdateCheckResult {
  const UpdateCheckResult(
    this.outcome, {
    this.latestVersion,
    this.notesUrl,
    this.installable,
    this.downloadUrl,
    this.usableArtifacts = 0,
    this.detail,
    this.comparedAt,
    this.storeChannel = false,
    this.storeUrl,
  });

  final UpdateCheckOutcome outcome;

  /// The latest version the manifest states. Non-null only for
  /// [UpdateCheckOutcome.updateAvailable] /
  /// [UpdateCheckOutcome.upToDate] — on every other branch we **do not have**
  /// this fact.
  final String? latestVersion;

  final String? notesUrl;

  /// 🔴 **The one artifact this build knows how to install** (`kind ==
  /// 'apk'`), null when there isn't one.
  ///
  /// null is **NOT a failure**: the manifest might only carry types we've
  /// never heard of, like `portable-zip` / `dmg`. In that case the outcome is
  /// still [UpdateCheckOutcome.updateAvailable] —
  /// **「there's a new version, get it here」**, not a crash, not 「already up
  /// to date」, and definitely not a state the user has no way out of. Reason:
  /// see update_manifest.dart's file header, 「`kind` is an open set」.
  final UpdateArtifact? installable;

  /// The path the user can walk right now: the installable artifact's url, or
  /// failing that the manifest's first artifact's url.
  /// **It always points at a real download address**, so the on-screen 「get
  /// it here」 sentence is never empty talk.
  final String? downloadUrl;

  /// How many artifacts in this platform's own entry are verifiable. Zero
  /// while the version is newer ⇒ [incompleteInfo].
  final int usableArtifacts;

  /// Machine-readable diagnostics (status code, refusal short-code, the raw
  /// exception text).
  /// **Never shown on screen by itself** — what shows is the four-language
  /// sentence that corresponds to the outcome; this is only supplementary.
  final String? detail;

  /// 🔴 **The exact moment we genuinely produced a comparison result.**
  ///
  /// Only [updateAvailable] / [upToDate] carry it — they are the only two
  /// cases of 「we genuinely do know」. The UI persists it as 「last checked
  /// successfully at …」, and that line is the **sole evidence** for the
  /// 「already up to date」 sentence: without it, a client that has **never
  /// once checked successfully** and a client that **just checked** look
  /// identical on screen (the easiest-to-miss silent failure at the end of
  /// design draft §5.0).
  final DateTime? comparedAt;

  /// Whether this run genuinely produced a version comparison — i.e. whether
  /// 「last checked successfully」 should be refreshed.
  bool get didCompare => comparedAt != null;

  /// True when the verdict came from a `store_platforms` entry — a platform
  /// whose updates a STORE delivers (iOS). The UI's action for it is 「go to
  /// the store page」, never a download; [installable] and [downloadUrl] are
  /// null by construction on this path.
  ///
  /// 🔴 A separate boolean rather than 「storeUrl != null」: the link is
  /// optional (the news is real before anyone minted an invite URL), and
  /// keying the sentence on the link would make a link-less store entry fall
  /// into the 「package type this build cannot install」 copy — a sentence that
  /// then points at a download address that does not exist.
  final bool storeChannel;

  /// The store page to walk to (TestFlight invite / store listing), when the
  /// manifest carries one. Only ever non-null alongside [storeChannel].
  final String? storeUrl;
}

/// The HTTP seam. Production goes through `dart:io`, tests pass a fake.
/// Copies `diag_upload.dart:57-61`'s shape.
typedef UpdateManifestFetcher = Future<({int status, String body})> Function(Uri url);

Future<({int status, String body})> _fetch(Uri url) async {
  // D2LAN-B3 — 🔴 EXPLICITLY [HttpTrust.publicCa], AND THAT IS THE DECISION.
  // This dials the official site over a real CA chain, not a PC on the LAN.
  // Pinning it would swap a certificate its owner rotates for a constant baked
  // into an APK, and the first legitimate rotation would take the update channel
  // down — with no way to ship the fix, because the fix ships through here.
  final HttpClient client = openHttpClient(
    trust: HttpTrust.publicCa,
    connectionTimeout: const Duration(seconds: 5),
  ).client;
  try {
    final HttpClientRequest req = await client.getUrl(url);
    // The check cycle runs on the order of days, caching saves not a single
    // cent, and it would only create 「I just published a release, why hasn't
    // the client noticed」-style
    // problems that are impossible to debug (the server side also sets
    // `cache-control: no-store`, :266).
    req.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
    final HttpClientResponse res =
        await req.close().timeout(const Duration(seconds: 10));
    // utf8, not the platform encoding: the body is JSON off a Linux VPS, and
    // `SystemEncoding` would decode it in whatever the phone's locale happens to
    // be — a version number that survives that is luck, not correctness.
    final String body = await res.transform(utf8.decoder).join();
    return (status: res.statusCode, body: body);
  } finally {
    client.close(force: true);
  }
}

/// Asks the official site once: 「what's the latest FlowMic version, should
/// I update」.
///
/// [currentVersion] = `AppVersionPort.appVersion()`'s answer, verbatim
/// (**null is allowed**).
/// [endpoint] defaults to [resolveUpdateEndpoint] (= the official site,
/// **NOT** the currently-connected relay address;
/// reason in that function's own doc) — never hard-code a domain literal here.
///
/// 🔴 This function **never throws**. Every path must land in some member of
/// [UpdateCheckOutcome]:
/// a thrown exception would get caught at some call site and turned into 「I
/// guess there's no update」.
Future<UpdateCheckResult> checkForUpdate({
  required String? currentVersion,
  String? endpoint,
  // null ⇒ resolved from the OS ([defaultUpdatePlatform]). A default value
  // must be const in Dart, and the honest default here is a runtime fact.
  String? platform,
  UpdateManifestFetcher fetcher = _fetch,
  DateTime Function() now = DateTime.now,
}) async {
  // ① First ask who we are. If it can't be read there is nothing to compare
  // against — so there is no point wasting a request.
  final String? mine = currentVersion?.trim();
  if (mine == null || mine.isEmpty || parseVersion(mine) == null) {
    return UpdateCheckResult(
      UpdateCheckOutcome.ownVersionUnknown,
      detail: mine == null || mine.isEmpty ? 'app_version_null' : 'app_version_unparsable:$mine',
    );
  }

  // ② Build the URL. 🔴 Only ever goes through the http_endpoint.dart funnel
  // — a `ws://` endpoint would make
  // `HttpClient.getUrl` throw an **ArgumentError (an Error, not an
  // Exception)**,
  // and this exact wrong turn has already cost this repo three silent
  // failures (see that file's own header).
  final Uri url;
  try {
    url = httpEndpointUri(endpoint ?? resolveUpdateEndpoint(), kUpdateManifestPath);
  } on Object catch (e) {
    return UpdateCheckResult(UpdateCheckOutcome.unreachable, detail: 'bad_endpoint:$e');
  }

  // ③ Send the request. `on Object` rather than `on Exception`: same as
  // above, an Error must be caught too.
  final ({int status, String body}) res;
  try {
    res = await fetcher(url);
  } on Object catch (e) {
    return UpdateCheckResult(UpdateCheckOutcome.unreachable, detail: e.toString());
  }

  if (res.status == 404) {
    return const UpdateCheckResult(UpdateCheckOutcome.noManifestHere, detail: '404');
  }
  if (res.status != 200) {
    // 503 is the server itself saying 「I can't answer right now」; 405/500/502
    // are some other mishap.
    // The action for the user is the same for both (come back later), so they
    // share one slot, but `detail` still tells them apart.
    return UpdateCheckResult(UpdateCheckOutcome.unavailable, detail: '${res.status}');
  }

  // ④ Can we understand it.
  final ManifestParse parsed = parseUpdateManifest(res.body);
  switch (parsed) {
    case ManifestRejected(:final String reason):
      return UpdateCheckResult(UpdateCheckOutcome.malformed, detail: reason);
    case ManifestParsed(:final UpdateManifest manifest):
      return _decide(manifest, mine, platform ?? defaultUpdatePlatform(), now);
  }
}

UpdateCheckResult _decide(
  UpdateManifest manifest,
  String mine,
  String platform,
  DateTime Function() now,
) {
  final UpdatePlatform? entry = manifest.platforms[platform];
  if (entry == null) {
    // A store-delivered platform (iOS) is announced in `store_platforms`,
    // never in `platforms` — see kUpdatePlatformIos's doc for why. `platforms`
    // is looked at first so that if the same key ever appeared in both, the
    // downloadable entry would win (it is the stronger claim).
    final UpdateStorePlatform? store = manifest.storePlatforms[platform];
    if (store != null) return _decideStore(store, mine, now);
    // Design draft §3 row 4, first half: this platform's entry is missing.
    // 🔴 **NOT 「already up to date」** — we don't know whether there's an
    // update; what we know is that this manifest doesn't mention us. (An OLD
    // deployed server also lands an iOS phone here: its validator rebuilds
    // the manifest from the keys it knows and strips `store_platforms` — the
    // honest degradation until the relay is redeployed, and why the deploy
    // order is server first, manifest second.)
    return const UpdateCheckResult(
      UpdateCheckOutcome.incompleteInfo,
      detail: 'platform_absent',
    );
  }

  final int? cmp = compareVersions(entry.version, mine);
  if (cmp == null) {
    // Unreachable in practice (envelope validation already checked both
    // sides with kVersionRe), but collapsing it into 「not an update」
    // would be passing off 「don't know」 as 「latest」, so it explicitly lands
    // on malformed.
    return const UpdateCheckResult(UpdateCheckOutcome.malformed, detail: 'version_incomparable');
  }

  // ⑤ Not newer than mine ⇒ the one and only slot allowed to say 「already
  // up to date」, and it carries 「when was this compared」.
  if (cmp <= 0) {
    return UpdateCheckResult(
      UpdateCheckOutcome.upToDate,
      latestVersion: entry.version,
      notesUrl: entry.notesUrl,
      comparedAt: now(),
    );
  }

  // ⑥ Newer than mine, but not a single verifiable artifact ⇒ design draft
  // §3 row 4, second half: **do not download**.
  // ⚠️ This slot is **a different thing** from 「there's a new version but the
  // type is unrecognised」 — do not merge them:
  //    this one is 「the manifest is broken」 (missing sha256 / invalid url ⇒
  //    cannot verify, unsafe to install even if we did);
  //    that one is 「the manifest is perfectly fine, this release just isn't
  //    shipped as an apk」 (see `installable == null` below).
  if (entry.artifacts.isEmpty) {
    return UpdateCheckResult(
      UpdateCheckOutcome.incompleteInfo,
      latestVersion: entry.version,
      notesUrl: entry.notesUrl,
      detail: 'no_usable_artifacts:dropped=${entry.droppedArtifacts}',
    );
  }

  // ⑦ There's a new version. Pick the one we know how to install; failing
  // to find one is **still** 「there's a new version」.
  UpdateArtifact? installable;
  for (final UpdateArtifact a in entry.artifacts) {
    if (a.kind == kUpdateInstallableKind) {
      installable = a;
      break;
    }
  }
  return UpdateCheckResult(
    UpdateCheckOutcome.updateAvailable,
    latestVersion: entry.version,
    notesUrl: entry.notesUrl,
    installable: installable,
    downloadUrl: (installable ?? entry.artifacts.first).url,
    usableArtifacts: entry.artifacts.length,
    comparedAt: now(),
    detail: installable == null
        ? 'no_known_kind:${entry.artifacts.map((UpdateArtifact a) => a.kind).join(",")}'
        : null,
  );
}

/// The store-delivered half of `_decide`. Same comparison rule (§1.3: only
/// strictly-greater is news), same 「upToDate is the only slot allowed to say
/// up to date」 — the only difference is what the answer CARRIES: a store page
/// instead of artifacts, and [UpdateCheckResult.storeChannel] so the UI says
/// 「update in the store」 rather than 「download from the address below」.
UpdateCheckResult _decideStore(
  UpdateStorePlatform store,
  String mine,
  DateTime Function() now,
) {
  final int? cmp = compareVersions(store.version, mine);
  if (cmp == null) {
    // Same slot as the sibling above, same reasoning: collapsing 「could not
    // compare」 into 「not an update」 would pass off 「don't know」 as 「latest」.
    return const UpdateCheckResult(UpdateCheckOutcome.malformed, detail: 'version_incomparable');
  }
  if (cmp <= 0) {
    return UpdateCheckResult(
      UpdateCheckOutcome.upToDate,
      latestVersion: store.version,
      notesUrl: store.notesUrl,
      comparedAt: now(),
    );
  }
  return UpdateCheckResult(
    UpdateCheckOutcome.updateAvailable,
    latestVersion: store.version,
    notesUrl: store.notesUrl,
    comparedAt: now(),
    storeChannel: true,
    storeUrl: store.storeUrl,
    detail: 'store_channel',
  );
}
