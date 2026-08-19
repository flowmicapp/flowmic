// SPEC-REF:
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-2 ③ (endpoint seam:
//     --dart-define FLOWMIC_SAAS_ENDPOINT overrides; fallback the protocol
//     default constant; the private line may point this at the owner LAN model
//     service at build time — never hardcoded in a widget)
//   packages/protocol/src/constants.ts (DEFAULT_SAAS_ENDPOINT)
//   CLAUDE.md environment facts: the old office LAN model service
//     (100.64.7.x) must never be hardcoded in code → the
//     effective endpoint is a build-time --dart-define, not a literal.
//
// The SaaS endpoint seam. The effective cloud endpoint is resolved once here so
// no widget/controller carries a hardcoded literal: a build supplies it via
// `--dart-define=FLOWMIC_SAAS_ENDPOINT=...`, and absent that the fallback is the
// protocol SSOT default (mirrored from packages/protocol DEFAULT_SAAS_ENDPOINT).
// LoginController / ConnectionsController take an injectable `saasEndpoint`
// param defaulting to [resolveSaasEndpoint], so tests dial a fake host.

import '../../generated/flowmic_protocol.g.dart' show FlowMicRelayEndpoints;

/// Mirrors packages/protocol/src/constants.ts DEFAULT_SAAS_ENDPOINT. This is the
/// fallback only — a real private build overrides it with --dart-define.
///
/// ⚠️ PRE-EXISTING HAND MIRROR, LEFT AS IT IS AND REGISTERED HERE RATHER THAN
/// SILENTLY WIDENED. Unlike the retired list below, this one is not generated —
/// it predates this card and is read from a great many call sites. It is a real
/// (small) drift seam: renaming the canonical relay would need this line changed
/// by hand. Moving it onto the codegen is a separate, mechanical change; doing
/// it inside a defect fix would have made the fix unreviewable.
const String kDefaultSaasEndpoint = 'https://flowmic.app';

/// Build-time override key. `flutter build --dart-define=FLOWMIC_SAAS_ENDPOINT=…`.
const String kSaasEndpointDefineKey = 'FLOWMIC_SAAS_ENDPOINT';

/// The effective SaaS endpoint: the --dart-define override when present and
/// non-empty, else [kDefaultSaasEndpoint]. Never a widget-embedded literal.
String resolveSaasEndpoint() {
  const String override = String.fromEnvironment(kSaasEndpointDefineKey);
  return override.isNotEmpty ? override : kDefaultSaasEndpoint;
}

// ── Retired relay addresses ────────────────────────────────────────────────
//
// THE DEFECT THIS HALF EXISTS FOR, in one line: `MobileSession.endpoint` is a
// STORED value and nothing ever revisits it, so a phone that paired over the
// cloud while a now-retired address was canonical re-dials that host on every
// launch, forever, and the only way out is to delete the pairing and pair
// again. MEASURED on tablet TB335ZC, 2026-08-19 (0.3.9 handoff §7-2): three
// `reach.probe` lines every 15 s, the stored host `ok=false verdict=offline`
// while the canonical one answered 28/28 — a row that is red for a reason
// nothing on screen states.
//
// 🔴 THE DESKTOP IS THE REFERENCE IMPLEMENTATION, NOT AN INSPIRATION.
// `apps/desktop/src-tauri/src/socket/cloud_endpoint.rs` `plan_migration()` is
// the rule; [planRetiredSaasEndpointHeal] mirrors it decision for decision, and
// the normalisation below mirrors that file's `normalise()` character for
// character. Where the two sides could disagree about what counts as retired,
// they must not — so the shape of the disagreement is made impossible: both
// compare by VALUE EQUALITY against a list, never by "anything that is not
// canonical".
//
// ⚠️ WHERE THE TWO SIDES LEGITIMATELY DIFFER, stated rather than discovered
// later: the desktop receives `canonical` + `legacy` as ARGUMENTS from its
// frontend, which can `import` @flowmic/protocol directly. Dart cannot, so the
// list reaches this file through the mobile CODEGEN instead — one more derived
// value on a path that already exists (`apps/mobile/tool/gen_protocol.mjs`,
// which the D3 lesson built precisely so no protocol value is hand-mirrored on
// this side). Different delivery, same property: neither platform writes an
// endpoint literal of its own.

/// Relay addresses this product has RETIRED — the mobile view of
/// `LEGACY_SAAS_ENDPOINTS` (packages/protocol/src/constants.ts).
///
/// 🔴 NOT A HAND-WRITTEN MIRROR, AND THE FIRST ATTEMPT AT THIS CARD WAS. It is
/// an alias for a value the codegen derives from the protocol source
/// (`FlowMicRelayEndpoints.retired`, emitted into a gitignored `*.g.dart`), so
/// the retired host is spelled out in exactly ONE tracked file in this repo. The
/// difference is not tidiness: that value is deployment data of our hosted
/// service, the open-source export STRIP_EDITs it to `[]` there, and a second
/// hand-typed copy over here would have re-published a domain the owner ruled
/// out of the project (decision 2026-08-17). `verify:lint oss-absent-sweep` is
/// the machine that says so — it refused the literal version of this line.
/// ⇒ **Never inline an entry here.** Add it in constants.ts; it arrives.
///
/// 🔴 THIS LIST HAS A LIFETIME AND IS MEANT TO BE DELETED. When the repair
/// window closes, the TypeScript value and its two STRIP_EDITS entries go in one
/// commit (audit queue, 2026-08-17 entry:「它和它的两条 STRIP_EDITS 要在同一笔里
/// 一起删」). THIS DECLARATION, ITS READER BELOW AND ITS TEST GO IN THAT SAME
/// COMMIT. Two things make that hard to forget rather than merely written down:
///   · the grep anchor `LEGACY_SAAS_ENDPOINTS` is spelled verbatim here and in
///     `readLegacySaasEndpoints()` (apps/mobile/tool/gen_protocol.mjs), so the
///     sweep that greps the token to delete the TypeScript side lands on both;
///   · deleting the declaration makes that parser THROW, so every mobile build
///     fails loudly until this side goes too.
///
/// ⚠️ EMPTY IS A LEGITIMATE VALUE, not a broken build — it is what the exported
/// tree holds, and the heal then simply has no work. Nothing here may treat an
/// empty list as a fault.
///
/// ⚠️ Entries are kept in normal form (trimmed, lowercase, no trailing slash).
/// Comparison normalises both sides anyway, so a sloppy entry would still work —
/// but it would make the list read as if the shape did not matter, and the next
/// person adding one would copy it. Asserted by the paired test,
/// `apps/mobile/test/retired_relay_endpoint_heal_test.dart`.
const List<String> kLegacySaasEndpoints = FlowMicRelayEndpoints.retired;

/// Normalise for COMPARISON only. Never for storage.
///
/// Trim, strip trailing `/`, ASCII-lowercase — mirroring `normalise()` in
/// cloud_endpoint.rs, including the order of the three steps (trim first, so a
/// trailing space AFTER a slash is not silently absorbed) and including what it
/// deliberately does NOT do:
///   · not a URL parse, and nothing beyond these three steps;
///   · the SCHEME stays part of the identity — `http://host` is a different
///     value from `https://host`, and upgrading someone's scheme is a decision
///     this heal has no standing to make (add the form to the list if wanted);
///   · no host/subdomain folding — `www.` is not the same address;
///   · ASCII-only case folding, NOT Dart's Unicode-aware `toLowerCase()`: full
///     case folding can map two visually different hosts onto one string, and a
///     non-ASCII host must only ever match byte-for-byte. This is the one place
///     a naive `.toLowerCase()` would have quietly widened the match.
String _normaliseForRetiredMatch(String v) {
  String s = v.trim();
  while (s.endsWith('/')) {
    s = s.substring(0, s.length - 1);
  }
  final StringBuffer out = StringBuffer();
  for (final int c in s.codeUnits) {
    out.writeCharCode(c >= 0x41 && c <= 0x5A ? c + 0x20 : c);
  }
  return out.toString();
}

/// The address [stored] must be healed to, or `null` when it must be left
/// exactly as it is. **Pure** — nothing is written and nothing is logged; the
/// caller owns both (mirrors `plan_migration`'s contract).
///
/// `null` — i.e. leave it alone — in every one of these cases, and each one is
/// the same case the Rust side answers `None` to:
///   · [canonical] is blank — never rewrite a real endpoint into nothing;
///   · [stored] is blank — that is「never configured」and already behaves as it
///     always has at every read site;
///   · [stored] already IS [canonical] — nothing to do, and the second line of
///     defence for idempotency;
///   · [stored] is not in [legacy] — **the direction this function exists to
///     protect**, see below.
///
/// 🔴 THE DIRECTION THAT MATTERS IS THE ONE WE MUST NOT TAKE. A pairing's
/// endpoint is not always ours: `addByCode` stores whatever address the user
/// typed or scanned, which on a self-hosted deployment is that operator's own
/// relay, and [resolveSaasEndpoint] exists precisely so a private build can
/// point at one on purpose. Rewriting one of THOSE would take a working install
/// off its own server — a worse bug than the one being fixed. So the rule is
/// value equality against a known list, never "anything that is not the
/// canonical value". UNDER-matching (a subdomain, a different scheme) is the
/// safe failure and is deliberate.
///
/// 🔴 AND THAT IS WHY [canonical] DEFAULTS TO [kDefaultSaasEndpoint] RATHER THAN
/// TO [resolveSaasEndpoint] — the one place this file's two constants are NOT
/// interchangeable. [kLegacySaasEndpoints] holds addresses OUR hosted service
/// retired, and the successor of one of those is our canonical host, not
/// whatever a `--dart-define` happens to name in some other build. Healing to
/// the override would hand a private build's relay a token it never issued. The
/// desktop makes the same choice for the same reason: `cloudEndpointSsot()`
/// passes `DEFAULT_SAAS_ENDPOINT`, a fixed protocol constant, not a per-install
/// value.
///
/// IDEMPOTENCY is by construction, not by a flag: healing removes the thing that
/// triggers it, so the next call sees a non-legacy value and answers `null`.
String? planRetiredSaasEndpointHeal(
  String stored, {
  String canonical = kDefaultSaasEndpoint,
  List<String> legacy = kLegacySaasEndpoints,
}) {
  final String target = canonical.trim();
  if (target.isEmpty) return null;
  final String have = _normaliseForRetiredMatch(stored);
  if (have.isEmpty || have == _normaliseForRetiredMatch(target)) return null;
  for (final String entry in legacy) {
    final String candidate = _normaliseForRetiredMatch(entry);
    // A blank entry could not match a non-empty `have` anyway; it is skipped
    // explicitly so that a malformed list can never become a wildcard.
    if (candidate.isEmpty) continue;
    if (candidate == have) return target;
  }
  return null;
}
