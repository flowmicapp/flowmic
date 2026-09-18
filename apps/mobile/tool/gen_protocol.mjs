#!/usr/bin/env node
// WP-R3-1 — mobile protocol codegen wiring.
//
// D3 lesson (13-LESSONS-LEARNED §3): the legacy Dart event-name list was a
// HAND-mirror of the TypeScript whitelist and drifted (stuck at 54, missing
// pc:release-mobile). The new line forbids hand-written event literals: this
// script is the "one source → generated" step every mobile build runs BEFORE
// `flutter analyze` / `flutter test` / `flutter build`.
//
// It does three things:
//   1. Runs packages/protocol/scripts/gen-dart.mjs (the SSOT generator that
//      parses EVENT_NAMES from src/events.ts) — never a copy of its logic.
//   2. Copies the produced flowmic_events.g.dart into apps/mobile/lib/generated/
//      (both are gitignored `*.g.dart`; the SCRIPT is committed, the PRODUCT is
//      not — same policy as the protocol package).
//   3. Derives PROTOCOL_SCHEMA_VERSION, LEGACY_SAAS_ENDPOINTS and the https
//      pairing prefix (PAIR_HTTPS_HOST + PAIR_HTTPS_PATH) from
//      packages/protocol/src/constants.ts into flowmic_protocol.g.dart, so the
//      handshake schema_ver, the retired-relay list and the one URL prefix the
//      camera accepts are ALSO generated (no hand-mirrored integer — the legacy
//      kProtocolSchemaVersion was a manual mirror; this closes that seam too).
//
// Usage (from anywhere): node apps/mobile/tool/gen_protocol.mjs
// Convenience wrappers: apps/mobile/Makefile (`make gen`), and the pnpm script
// `@flowmic/protocol codegen:dart` covers step 1 alone.
//
// ── 🔴 WHAT GUARANTEES FRESHNESS, AND WHAT DOES NOT ────────────────────────
// The output is `*.g.dart` and therefore GITIGNORED, so nothing in the repo can
// hold a stale COMMITTED copy. Freshness comes from `make gen` being a
// prerequisite of every target that compiles Dart (apps/mobile/Makefile: `gen`
// is a dependency of analyze / test / gate-test / build / release /
// release-store / release-ios), and `pnpm verify:mobile-tests` is
// `make -C apps/mobile gate-test`.
//
// ⚠️ ORIGINAL TEXT, TRUE UNTIL 2026-09-15, KEPT BECAUSE IT NAMES THE HOLE:
//   「It does NOT come from a lint. `verify/lint/i18n-generated-fresh.mjs` runs
//   the i18n generators' own `--check` modes and this script is deliberately NOT
//   in its GENERATORS table — it has no `--check` mode, and adding one that
//   nothing calls is the façade that file's header warns about. Consequence,
//   stated plainly: editing packages/protocol/src/constants.ts and NOT
//   re-running this generator is invisible to `pnpm verify:lint`.」
//
// 🔴 CORRECTION, card H-15 (2026-09-15). That paragraph gave the right reason
// for the wrong decision. 「A `--check` nothing calls is a façade」 is true, and
// the answer to it is a caller, not an absent check — which is exactly the
// argument i18n-generated-fresh's own header makes about the i18n generators. So
// this script now HAS a `--check` mode (see `check()` at the bottom) and
// `verify/lint/protocol-generated-fresh.mjs` is the thing that runs it. Editing
// packages/protocol/src/constants.ts without re-running this generator is no
// longer invisible to `pnpm verify:lint`.
//
// It is a SEPARATE lint rather than a row in i18n-generated-fresh because these
// artefacts are not i18n: that lint's verdict says 「generated i18n artefact(s)」
// and its repair instruction is `pnpm i18n:gen`, and both would be wrong here.
// The repair here is `make -C apps/mobile gen`.
//
// ⚠️ WHAT THE LINT STILL DOES NOT PROVE: `--check` does not run the protocol
// package's event codegen, so it compares the COPY of flowmic_events.g.dart
// against `packages/protocol/gen/dart/`, not against `src/events.ts`. Reasons in
// the block comment above `renderAll()`.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/mobile/tool
const MOBILE = join(HERE, '..'); // apps/mobile
const ROOT = join(MOBILE, '..', '..'); // repo root
const PROTOCOL = join(ROOT, 'packages', 'protocol');
const GEN_SCRIPT = join(PROTOCOL, 'scripts', 'gen-dart.mjs');
const EVENTS_G = join(PROTOCOL, 'gen', 'dart', 'flowmic_events.g.dart');
const CONSTANTS_TS = join(PROTOCOL, 'src', 'constants.ts');
const SCENARIO_TS = join(PROTOCOL, 'src', 'scenario.ts');
const DICTIONARY_TS = join(PROTOCOL, 'src', 'dictionary-packs.ts');
const OUT_DIR = join(MOBILE, 'lib', 'generated');

function runEventCodegen() {
  const res = spawnSync(process.execPath, [GEN_SCRIPT], { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`gen-dart.mjs failed with status ${res.status}`);
  }
}

/** Pull the single integer literal off `export const PROTOCOL_SCHEMA_VERSION = N;` */
function readSchemaVersion() {
  const src = readFileSync(CONSTANTS_TS, 'utf8');
  const m = src.match(/export\s+const\s+PROTOCOL_SCHEMA_VERSION\s*=\s*(\d+)\s*;/);
  if (!m) throw new Error('PROTOCOL_SCHEMA_VERSION not found in constants.ts');
  return Number(m[1]);
}

/**
 * Pull `export const LEGACY_SAAS_ENDPOINTS: readonly string[] = [...];` — the
 * relay addresses this product has RETIRED — off the protocol SSOT.
 *
 * 🔴 WHY THIS RIDES THE GENERATOR RATHER THAN BEING A DART LITERAL, which is the
 * whole point. The value is DEPLOYMENT DATA of our hosted service, not software:
 * the open-source export STRIP_EDITs it to `[]` in constants.ts, because a build
 * that is not our service has retired nothing. A hand-mirrored Dart copy would be
 * a second, unstripped home for a domain the owner ruled out of the project
 * (decision 2026-08-17) — and `verify:lint oss-absent-sweep` says so out loud.
 * Generated from the ONE source into a gitignored `*.g.dart`, the public tree
 * gets `[]` for free and no strip, waiver or exemption is needed anywhere.
 *
 * 🔴 IT THROWS WHEN THE DECLARATION IS GONE, AND THAT IS THE DELETION RATCHET.
 * The list has a lifetime: when the repair window closes it is deleted together
 * with its two STRIP_EDITS entries (audit queue, 2026-08-17 entry). On that day
 * this parse stops matching and every mobile build fails loudly — the same
 * direction as「a strip whose `find` no longer matches is a hard failure of the
 * export」— which is what makes the mobile half impossible to forget. Whoever
 * greps `LEGACY_SAAS_ENDPOINTS` to do the sweep lands on this block and on
 * `kLegacySaasEndpoints` in apps/mobile/lib/src/auth/saas_endpoint.dart.
 *
 * ⚠️ An EMPTY list is a legitimate parse, not a failure: that is exactly what the
 * exported tree holds. Missing declaration = throw; empty declaration = `[]`.
 * Those are two different questions and they get two different answers.
 */
function readLegacySaasEndpoints() {
  const src = readFileSync(CONSTANTS_TS, 'utf8');
  const m = src.match(
    /export\s+const\s+LEGACY_SAAS_ENDPOINTS\s*:[^=]*=\s*\[([^\]]*)\]\s*;/,
  );
  if (!m) throw new Error('LEGACY_SAAS_ENDPOINTS not found in constants.ts');
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).filter((v) => v.length > 0);
}

/**
 * Compose the ONE https pairing prefix from `PAIR_HTTPS_HOST` +
 * `PAIR_HTTPS_PATH` — the same two constants the desktop QR builder imports
 * (apps/desktop/src/lib/pairing.ts `buildHttpsQrPayload`) and the same two the
 * OS declarations are checked against (verify/lint/applink-declarations.mjs).
 *
 * 🔴 WHY THIS RIDES THE GENERATOR. Dart cannot import TypeScript, so the phone
 * used to spell the whole prefix by hand in lib/src/ui/scan_payload.dart and a
 * lint compared the two literals. Two hand-written copies plus a comparison is
 * one copy more than the product needs: a phone whose prefix still says `/pair`
 * while the desktop prints `/go/pair` refuses every QR it is handed — on the
 * right host, with both sides' own tests green. Generating the Dart side makes
 * disagreement unrepresentable rather than detectable.
 *
 * 🔴 IT THROWS WHEN EITHER DECLARATION IS GONE. A rename would otherwise emit
 * a prefix built from nothing, and the mobile tree would compile against a URL
 * no operating system was ever told about. Same direction as
 * `readLegacySaasEndpoints`: missing declaration = hard failure of every mobile
 * build, not a quiet default.
 *
 * ⚠️ THE SHAPE CHECK IS PART OF THE CONTRACT, not defensive noise. This
 * function CONCATENATES, and so do `buildHttpsQrPayload`
 * (apps/desktop/src/lib/pairing.ts) and `webRoomPairUrl`
 * (apps/server-core/src/http/web-room-routes.ts). A path without a leading
 * slash, or with a trailing one, builds a URL nobody declared to either
 * operating system. This check used to live in the lint that compared the two
 * literals (now verify/lint/pair-link-single-source.mjs); it moved here with
 * the composition.
 */
function readPairHttpsPrefix() {
  const src = readFileSync(CONSTANTS_TS, 'utf8');

  const hostM = src.match(/export\s+const\s+PAIR_HTTPS_HOST\s*=\s*'([^']+)'\s*;/);
  if (!hostM) {
    throw new Error(
      'PAIR_HTTPS_HOST is not declared as a plain string literal in '
        + 'packages/protocol/src/constants.ts — renamed, moved or computed. '
        + 'The mobile pairing prefix is generated from it; update this parser.',
    );
  }
  const pathM = src.match(/export\s+const\s+PAIR_HTTPS_PATH\s*=\s*'([^']+)'\s*;/);
  if (!pathM) {
    throw new Error(
      'PAIR_HTTPS_PATH is not declared as a plain string literal in '
        + 'packages/protocol/src/constants.ts — renamed, moved or computed. '
        + 'The mobile pairing prefix is generated from it; update this parser.',
    );
  }

  const host = hostM[1];
  const linkPath = pathM[1];
  if (/[\s/:]/.test(host)) {
    throw new Error(
      `PAIR_HTTPS_HOST='${host}' is not a bare host — no scheme, no slash, no colon, `
        + 'no whitespace. This generator prepends `https://` to it.',
    );
  }
  if (!linkPath.startsWith('/') || linkPath.endsWith('/')) {
    throw new Error(
      `PAIR_HTTPS_PATH='${linkPath}' is not a bare path — it needs a leading slash and no `
        + 'trailing one, because this generator (and the desktop builder, and the relay\'s '
        + 'web-room pair_url) all CONCATENATE it after the host.',
    );
  }

  return { host, path: linkPath };
}

/**
 * Compose the ONE custom-scheme pairing prefix from `PAIR_CUSTOM_SCHEME` +
 * `PAIR_CUSTOM_HOST` — the sibling of `readPairHttpsPrefix` above, and for the
 * same reason (card H-14, 2026-09-15).
 *
 * 🔴 WHY THIS RIDES THE GENERATOR. Until this card the custom half had NO single
 * source at all: the desktop builder typed `flowmic://pair` inline, the phone
 * declared a second copy in `lib/src/ui/scan_payload.dart`, and
 * `lib/src/signaling/wire_payloads.dart` typed a THIRD one rather than reading
 * the constant beside it. The https half had already paid for exactly this
 * (XC-1-FIX) and the lint that closed it, `pair-link-single-source`, covered
 * only the https spelling — so nothing could even count the copies here.
 *
 * 🔴 IT THROWS WHEN EITHER DECLARATION IS GONE, same direction as its https
 * sibling: a rename would otherwise emit a prefix built from nothing and the
 * phone would refuse every QR the desktop prints, with both sides' tests green.
 *
 * ⚠️ THE SHAPE CHECK IS PART OF THE CONTRACT. This function CONCATENATES
 * `<scheme>://<host>`, and so does `buildQrPayload` (apps/desktop/src/lib/
 * pairing.ts). A scheme carrying `:` or `/`, or a host carrying either, builds a
 * URL neither side can parse back.
 */
function readPairCustomPrefix() {
  const src = readFileSync(CONSTANTS_TS, 'utf8');

  const schemeM = src.match(/export\s+const\s+PAIR_CUSTOM_SCHEME\s*=\s*'([^']+)'\s*;/);
  if (!schemeM) {
    throw new Error(
      'PAIR_CUSTOM_SCHEME is not declared as a plain string literal in '
        + 'packages/protocol/src/constants.ts — renamed, moved or computed. '
        + 'The phone custom-scheme pairing prefix is generated from it; update this parser.',
    );
  }
  const hostM = src.match(/export\s+const\s+PAIR_CUSTOM_HOST\s*=\s*'([^']+)'\s*;/);
  if (!hostM) {
    throw new Error(
      'PAIR_CUSTOM_HOST is not declared as a plain string literal in '
        + 'packages/protocol/src/constants.ts — renamed, moved or computed. '
        + 'The phone custom-scheme pairing prefix is generated from it; update this parser.',
    );
  }

  const scheme = schemeM[1];
  const host = hostM[1];
  if (/[\s/:?#]/.test(scheme)) {
    throw new Error(
      `PAIR_CUSTOM_SCHEME='${scheme}' is not a bare scheme — no colon, no slash, no query, `
        + 'no whitespace. This generator appends `://` to it.',
    );
  }
  if (/[\s/:?#]/.test(host)) {
    throw new Error(
      `PAIR_CUSTOM_HOST='${host}' is not a bare host — no scheme, no slash, no colon, no query, `
        + 'no whitespace. This generator (and the desktop builder) CONCATENATE it after `://`.',
    );
  }

  return { scheme, host };
}

/**
 * Read `DEMO_PAIR_HTTPS_PATH` — the site-demo room's pair_url path
 * (owner ruling 2026-09-17, docs/decisions/2026-09-17-owner-app-scans-demo-qr-
 * as-ephemeral-session.md): the App may now recognise that QR and join as an
 * EPHEMERAL session. The phone matches on host + LAST path segment (the site
 * puts a locale in front: `/go/zh-cn/demo`), so what it needs from here is the
 * declared path, never a hand-typed `demo`.
 *
 * 🔴 IT THROWS WHEN THE DECLARATION IS GONE, same direction as the two readers
 * above: a rename would otherwise leave the phone matching a segment nobody
 * mints any more, with every test green.
 *
 * ⚠️ Same shape check as `readPairHttpsPrefix`: `webRoomPairUrl`
 * (apps/server-core/src/http/web-room-routes.ts) CONCATENATES it after the
 * host, so a path without a leading slash or with a trailing one would build a
 * URL whose last segment is not what this generator promises.
 */
function readDemoPairHttpsPath() {
  const src = readFileSync(CONSTANTS_TS, 'utf8');
  const m = src.match(/export\s+const\s+DEMO_PAIR_HTTPS_PATH\s*=\s*'([^']+)'\s*;/);
  if (!m) {
    throw new Error(
      'DEMO_PAIR_HTTPS_PATH is not declared as a plain string literal in '
        + 'packages/protocol/src/constants.ts — renamed, moved or computed. '
        + 'The mobile demo-link recogniser is generated from it; update this parser.',
    );
  }
  const demoPath = m[1];
  if (!demoPath.startsWith('/') || demoPath.endsWith('/') || demoPath === '/') {
    throw new Error(
      `DEMO_PAIR_HTTPS_PATH='${demoPath}' is not a bare path — it needs a leading slash, `
        + 'no trailing one, and at least one segment, because the phone matches on its '
        + 'LAST segment and the relay CONCATENATES it after the host.',
    );
  }
  return demoPath;
}

function renderProtocolConsts(schemaVersion, retiredEndpoints, pairLink, pairCustom, demoPath) {
  const dart = `// GENERATED — DO NOT EDIT BY HAND.
// Source: packages/protocol/src/constants.ts
//   (PROTOCOL_SCHEMA_VERSION, LEGACY_SAAS_ENDPOINTS,
//    PAIR_HTTPS_HOST + PAIR_HTTPS_PATH, DEMO_PAIR_HTTPS_PATH)
// Regenerate: node apps/mobile/tool/gen_protocol.mjs
//
// ignore_for_file: constant_identifier_names

/// Handshake-level protocol constants, mirrored from the TypeScript protocol
/// package so the mobile client never hand-maintains an integer that can drift.
class FlowMicProtocol {
  FlowMicProtocol._();

  /// Sent as \`handshake.auth.schema_ver\` on every connect (04-PROTOCOL-SPEC §2).
  /// A pre-schema server simply never reads it; this client never requires one
  /// back — additive capability metadata, never a gate.
  static const int schemaVersion = ${schemaVersion};
}

/// Relay addresses this product has RETIRED, generated from
/// \`LEGACY_SAAS_ENDPOINTS\` — never hand-mirrored, because the value is
/// deployment data of ONE hosted service rather than a property of this
/// software.
///
/// EMPTY IS A CORRECT VALUE, not a broken build: a build of this project that is
/// not that hosted service has retired nothing, and the heal reading this list
/// then simply has no work to do. That is an empty set, not an inert mechanism.
///
/// The rule that consumes it is \`planRetiredSaasEndpointHeal\`
/// (src/auth/saas_endpoint.dart); the reference implementation both platforms
/// mirror is apps/desktop/src-tauri/src/socket/cloud_endpoint.rs.
class FlowMicRelayEndpoints {
  FlowMicRelayEndpoints._();

  static const List<String> retired = <String>[
${retiredEndpoints.map((e) => `    '${dartStr(e)}',`).join('\n')}
  ];
}

/// The https form of the pairing link, generated from \`PAIR_HTTPS_HOST\` +
/// \`PAIR_HTTPS_PATH\`.
///
/// 🔴 THE ONE Dart spelling. \`kPairLinkPrefixHttps\` (src/ui/scan_payload.dart)
/// is this value; \`PairEntry.parse\` (src/signaling/wire_payloads.dart) and the
/// paste gate (src/ui/add_pairing_sheet.dart) go through that constant. Nothing
/// in \`apps/mobile/lib\` may re-type the prefix —
/// \`verify:lint pair-link-single-source\` scans for exactly that.
///
/// 🔴 THE APEX, NOT \`www.\` (card DOM-1, owner ruling 2026-09-08). iOS Universal
/// Links do not follow redirects, so the host in a scanned link has to be one
/// the app declared (\`applinks:flowmic.app\`); \`www.\` is a different host and
/// opens Safari. The \`www\` -> apex 301 at the edge serves links a person typed;
/// it is deliberately not a second prefix here.
class FlowMicPairLink {
  FlowMicPairLink._();

  /// Host half (\`PAIR_HTTPS_HOST\`) — the one host declared to both operating
  /// systems (android/app/src/main/AndroidManifest.xml, ios/Runner/
  /// Runner.entitlements; pinned by verify/lint/applink-declarations.mjs).
  static const String host = '${dartStr(pairLink.host)}';

  /// Path half (\`PAIR_HTTPS_PATH\`). Bare path: leading slash, no trailing one.
  static const String path = '${dartStr(pairLink.path)}';

  /// What a scanned link must start with to be ours.
  static const String httpsPrefix = 'https://\$host\$path';

  /// Scheme half of the custom-scheme twin (\`PAIR_CUSTOM_SCHEME\`). Bare: no
  /// colon, no slash. NOTE it is the same scheme as \`flowmic://login\` — the
  /// scheme says whose link this is, [customHost] says which of our links.
  static const String customScheme = '${dartStr(pairCustom.scheme)}';

  /// Host half of that twin (\`PAIR_CUSTOM_HOST\`).
  static const String customHost = '${dartStr(pairCustom.host)}';

  /// The custom-scheme form of the same link — \`flowmic://pair?…\`, the QR the
  /// desktop has printed since 04 §3.1 and the form a pasted link still uses.
  ///
  /// 🔴 THE ONE Dart spelling, exactly like [httpsPrefix] above.
  /// \`kPairLinkPrefix\` (src/ui/scan_payload.dart) IS this value, and
  /// \`PairEntry.parse\` (src/signaling/wire_payloads.dart) goes through that
  /// constant — it used to type this prefix inline, which is the third copy
  /// card H-14 removed. \`verify:lint pair-link-single-source\` scans
  /// \`apps/mobile/lib\` for a hand-typed one so it cannot come back.
  ///
  /// ⚠️ NOT declared to either operating system (only \`flowmic://login\` is):
  /// this link arrives by camera or paste, never by being opened. See the
  /// constants.ts block for why that is deliberate.
  static const String customPrefix = '\$customScheme://\$customHost';

  /// The site-demo room's pair_url path (\`DEMO_PAIR_HTTPS_PATH\`). Bare path:
  /// leading slash, no trailing one. The phone recognises a demo QR by
  /// \`host\` + the LAST segment of this path (the site prefixes a locale:
  /// \`/go/zh-cn/demo\`), and joins it as an EPHEMERAL session — owner ruling
  /// 2026-09-17. \`isDemoPairLink\` (src/ui/scan_payload.dart) is the ONE
  /// reader; \`classifyScan\` and \`PairEntry.parse\` both go through it.
  ///
  /// ⚠️ Still NOT declared to either operating system, and still must not be
  /// (verify/lint/applink-declarations.mjs): this link reaches the App by being
  /// SCANNED. Ruling 6 of 2026-09-09 kept that half; only the 「the App refuses
  /// it」 half was overturned.
  static const String demoPath = '${dartStr(demoPath)}';
}
`;
  return dart;
}

// ── settings keys + scenario limits + dictionary packs ──────────────────────
// Same "parse the source textually, no TS runtime" discipline as the event
// codegen: the scenario-card settings surface (WP-R3-3) must never hand-mirror
// the key string 'scenario.card', the ≤8/≤16/≤40/≤100 caps, or the curated pack
// ids — every one of those is a protocol SSOT value the server also reads, and a
// hand copy is exactly the D3 drift class. Regenerated into flowmic_settings.g.dart.

/** `export const NAME = 'value';` → value (string). */
function readConstStr(src, name) {
  const m = src.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*'([^']*)'\\s*;`));
  if (!m) throw new Error(`${name} (string) not found`);
  return m[1];
}
/** `export const NAME = <int>;` → number. */
function readConstInt(src, name) {
  const m = src.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(\\d+)\\s*;`));
  if (!m) throw new Error(`${name} (int) not found`);
  return Number(m[1]);
}
/** Parse DICTIONARY_PACKS into [{id, label, preview}] — id + label + a short
 *  entry-term preview (first 4 terms). The mobile only ever needs the id (the
 *  ScenarioCard.packs contract value), a label, and preview text; the actual
 *  term merge (composeDictionary) is a SERVER concern. */
function parseDictionaryPacks(src) {
  const start = src.indexOf('DICTIONARY_PACKS');
  const open = src.indexOf('[', start);
  const close = src.indexOf('] as const', open);
  const body = src.slice(open, close === -1 ? src.length : close);
  const marks = [];
  for (const m of body.matchAll(/id:\s*'([^']+)'/g)) marks.push({ id: m[1], index: m.index });
  if (marks.length === 0) throw new Error('no dictionary packs parsed');
  const packs = [];
  for (let i = 0; i < marks.length; i++) {
    const chunk = body.slice(marks[i].index, i + 1 < marks.length ? marks[i + 1].index : body.length);
    const labelM = chunk.match(/label:\s*'([^']+)'/);
    const terms = [...chunk.matchAll(/term:\s*'([^']+)'/g)].map((x) => x[1]);
    const preview = terms.slice(0, 4).join(' · ') + (terms.length > 4 ? ' …' : '');
    packs.push({ id: marks[i].id, label: labelM ? labelM[1] : marks[i].id, preview });
  }
  return packs;
}

/** Escape a JS string for a single-quoted Dart literal. */
function dartStr(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$');
}

// A1c (2026-07-31): this used to also emit FlowMicSettingsKeys.timelineSyncNoted
// and a FlowMicSettingsDefaults class, mirroring protocol's
// SETTINGS_KEY_TIMELINE_SYNC_NOTED / SETTINGS_TIMELINE_SYNC_NOTED_DEFAULT. Both
// are gone: card A1 retired the toggle's only consumer (TimelineSyncGate's
// emit-side gate) under the owner's no-cloud-sync ruling, and card A1c deleted
// the settings-page toggle itself, leaving mobile with zero readers for either
// generated constant. The TS-side constants stay in
// packages/protocol/src/constants.ts untouched (out of this card's scope) — this
// is mobile's codegen no longer mirroring a value it never reads, not a
// protocol-level retirement.
function renderSettingsConsts() {
  const constants = readFileSync(CONSTANTS_TS, 'utf8');
  const scenario = readFileSync(SCENARIO_TS, 'utf8');
  const dictionary = readFileSync(DICTIONARY_TS, 'utf8');

  const scenarioCardKey = readConstStr(constants, 'SETTINGS_KEY_SCENARIO_CARD');
  // Card LLM-NOTICE (2026-08-25): the READ-ONLY capability fact the phone
  // consumes (settings/llm_capability.dart). Mirrored so the phone never
  // hand-copies the key string; the constant NAME below is what
  // verify/lint/settings-key-drift.mjs greps for a UI consumer.
  const capabilityLlmKey = readConstStr(constants, 'SETTINGS_KEY_CAPABILITY_LLM');
  // 2026-09-03 (phone-owned preferences, WP-B): the three keys the phone now
  // owns beside the scenario card. Mirrored for the same reason as the card key
  // — every NON-anchor reference (pending-sync lookups, tests, the backup file's
  // key names) goes through the constant, and the one literal SET anchor per
  // key in settings_client.dart is pinned equal to it by a test.
  const sttPolishKey = readConstStr(constants, 'SETTINGS_KEY_STT_POLISH');
  const sttRefineKey = readConstStr(constants, 'SETTINGS_KEY_STT_REFINE');
  const scenarioInferenceKey = readConstStr(constants, 'SETTINGS_KEY_SCENARIO_INFERENCE');
  const maxLabel = readConstInt(scenario, 'SCENARIO_MAX_LABEL_LEN');
  const maxAliases = readConstInt(scenario, 'SCENARIO_MAX_ALIASES_PER_TERM');
  const maxProf = readConstInt(scenario, 'SCENARIO_MAX_PROFESSIONS');
  const maxDom = readConstInt(scenario, 'SCENARIO_MAX_DOMAINS');
  const maxPacks = readConstInt(scenario, 'SCENARIO_MAX_PACKS');
  const maxTerms = readConstInt(scenario, 'SCENARIO_MAX_TERMS');
  const packs = parseDictionaryPacks(dictionary);

  const packLines = packs
    .map((p) => `    FlowMicDictionaryPack(id: '${dartStr(p.id)}', label: '${dartStr(p.label)}', preview: '${dartStr(p.preview)}'),`)
    .join('\n');

  const dart = `// GENERATED — DO NOT EDIT BY HAND.
// Source: packages/protocol/src/{constants,scenario,dictionary-packs}.ts
// Regenerate: node apps/mobile/tool/gen_protocol.mjs
//
// ignore_for_file: constant_identifier_names, lines_longer_than_80_chars

/// user_settings KV key names + scenario-card limits + curated dictionary packs,
/// mirrored from the TypeScript protocol SSOT so the mobile client never hand-
/// maintains a key string / cap / pack id that can drift from the server reader.
/// The scenario.card key here is the SAME string the server's compose pipeline
/// reads (SETTINGS_KEY_SCENARIO_CARD) — that shared constant IS the settings-
/// key-drift closure (both ends name one SSOT value, neither hand-copies it).
class FlowMicSettingsKeys {
  FlowMicSettingsKeys._();

  /// settings:update payload key for the structured scenario card.
  static const String scenarioCard = '${dartStr(scenarioCardKey)}';

  /// READ-ONLY: 'capability.llm' (SETTINGS_KEY_CAPABILITY_LLM), value
  /// {usable: bool}, synthesised by the server on every settings read and
  /// never storable — the phone only ever READS it (settings/llm_capability.dart).
  static const String capabilityLlm = '${dartStr(capabilityLlmKey)}';

  /// settings:update payload key for the AI-polish switch + strength
  /// ({enabled, strength?}; SETTINGS_KEY_STT_POLISH).
  static const String sttPolish = '${dartStr(sttPolishKey)}';

  /// settings:update payload key for the two-pass refine switch
  /// ({enabled}; SETTINGS_KEY_STT_REFINE).
  static const String sttRefine = '${dartStr(sttRefineKey)}';

  /// settings:update payload key for the scenario-inference consent row
  /// ({granted, granted_for}; SETTINGS_KEY_SCENARIO_INFERENCE).
  static const String scenarioInference = '${dartStr(scenarioInferenceKey)}';
}

/// ScenarioCard array/label caps (master-plan §4.1) — the UI enforces these at
/// entry so a card never fails the server's zod round-trip.
class FlowMicScenarioLimits {
  FlowMicScenarioLimits._();

  static const int maxLabelLen = ${maxLabel};
  static const int maxProfessions = ${maxProf};
  static const int maxDomains = ${maxDom};
  static const int maxPacks = ${maxPacks};
  static const int maxTerms = ${maxTerms};
  /// Aliases one custom term may carry (SCENARIO_MAX_ALIASES_PER_TERM).
  static const int maxAliasesPerTerm = ${maxAliases};
}

/// One curated dictionary pack. [id] is the ScenarioCard.packs contract value
/// (must equal a protocol DICTIONARY_PACKS id); [label] is the English SSOT
/// label; [preview] is a short first-few-terms hint for the checkbox sub-line.
class FlowMicDictionaryPack {
  const FlowMicDictionaryPack({
    required this.id,
    required this.label,
    required this.preview,
  });

  final String id;
  final String label;
  final String preview;
}

class FlowMicDictionaryPacks {
  FlowMicDictionaryPacks._();

  static const List<FlowMicDictionaryPack> all = <FlowMicDictionaryPack>[
${packLines}
  ];
}
`;
  return { dart, keys: 3, packs: packs.length };
}

// ── what this generator would put on disk, computed without touching it ──────
//
// Card H-15 (2026-09-15). Everything above renders a string; the only thing that
// writes is `main()`. That split is what lets `--check` exist at all, and
// `--check` is what lets a LINT ask the question — see the header's freshness
// section, which used to say plainly that no lint watched this artefact.
//
// 🔴 THE EVENT FILE IS A COPY, NOT A RENDER, and the difference is the whole
// honesty of this mode. `flowmic_events.g.dart` is produced by the protocol
// package's own generator into `packages/protocol/gen/dart/` and copied here.
// `--check` compares the copy against that source WITHOUT running the source's
// generator, because a check that writes is not a check. So it catches 「the copy
// is behind the generated events file」 and does NOT catch 「the generated events
// file is itself behind src/events.ts」. Stated rather than papered over: the
// second question is answered by `make gen` before anything compiles Dart, and
// by nothing in `verify:lint`.
function renderAll() {
  const retired = readLegacySaasEndpoints();
  const pairLink = readPairHttpsPrefix();
  const pairCustom = readPairCustomPrefix();
  const demoPath = readDemoPairHttpsPath();
  const settings = renderSettingsConsts();
  return {
    retired,
    pairLink,
    pairCustom,
    settings,
    files: [
      {
        name: 'flowmic_protocol.g.dart',
        text: renderProtocolConsts(readSchemaVersion(), retired, pairLink, pairCustom, demoPath),
        // Rendered here from packages/protocol/src/constants.ts.
        source: 'packages/protocol/src/constants.ts',
      },
      {
        name: 'flowmic_settings.g.dart',
        text: settings.dart,
        source: 'packages/protocol/src/{constants,scenario,dictionary-packs}.ts',
      },
      {
        name: 'flowmic_events.g.dart',
        // Copied, not rendered — see the block comment above.
        copyOf: EVENTS_G,
        source: 'packages/protocol/gen/dart/flowmic_events.g.dart',
      },
    ],
  };
}

/** Line endings are not part of the comparison: git checkouts on Windows rewrite
 *  them, and a CRLF copy compiles to exactly the same Dart. */
function normaliseEol(text) {
  return text.replace(/\r\n/g, '\n');
}

/**
 * `--check`: exit 0 if every artefact on disk already equals what this
 * generator would write, 1 otherwise, writing nothing either way.
 *
 * `--skip-missing`: an artefact that has NEVER been generated is not a defect.
 * These files are `*.g.dart` and therefore gitignored, so 「absent」 is the normal
 * state of a fresh clone. Without the flag, absent is stale — which is the right
 * answer on an authoring machine and on a release build.
 *
 * ⚠️ WHAT THIS MODE CANNOT SEE, same limitation the i18n rows carry and for the
 * same reason: it covers 「never generated」, not 「generated once, then pulled」.
 * A long-lived checkout whose gitignored artefacts predate the last pull reports
 * stale, and that verdict is TRUE — nothing can ship from that tree until
 * `make gen` runs, because every mobile target depends on it.
 */
function check(skipMissing) {
  const plan = renderAll();
  const stale = [];
  const missing = [];
  let compared = 0;

  for (const f of plan.files) {
    const onDisk = join(OUT_DIR, f.name);
    let actual;
    try {
      actual = normaliseEol(readFileSync(onDisk, 'utf8'));
    } catch {
      missing.push(f.name);
      continue;
    }
    let expected;
    if (f.copyOf) {
      try {
        expected = normaliseEol(readFileSync(f.copyOf, 'utf8'));
      } catch {
        // The thing it is a copy OF has never been generated either. Nothing is
        // knowable about this artefact; reported as missing rather than stale so
        // the two repairs stay distinguishable (`make gen` vs. a real drift).
        missing.push(`${f.name} (source ${f.source} not generated)`);
        continue;
      }
    } else {
      expected = normaliseEol(f.text);
    }
    compared += 1;
    if (actual !== expected) {
      stale.push(`${f.name} differs from what ${f.source} would produce`);
    }
  }

  if (missing.length > 0 && !skipMissing) {
    stale.push(`never generated: ${missing.join(', ')}`);
  }
  if (stale.length > 0) {
    console.error(
      `gen_protocol --check: ${stale.length} problem(s) — run \`make -C apps/mobile gen\`: `
        + stale.join('; '),
    );
    return 1;
  }

  // 🔴 NOTHING COMPARED IS NOT A PASS, AND IT GETS ITS OWN EXIT CODE.
  // With `--skip-missing` on a tree where `make gen` has never run, every
  // artefact lands in `missing` and the loop above finds nothing to disagree
  // with. Exiting 0 there would be a check that covered ZERO reporting success
  // — the shape this repo's status red line forbids, and the reason
  // commit-hook-mirror says 「nothing verifiable happened … say so」. So:
  //   0 = every artefact on disk matches what this generator would write
  //   1 = at least one is stale (or absent without --skip-missing)
  //   2 = nothing was comparable; the caller must not read this as coverage
  // Same 0/1/2 vocabulary scripts/run-script-tests.mjs already uses.
  if (compared === 0) {
    console.log(
      'gen_protocol --check: nothing compared — '
        + `${missing.length} artefact(s) have never been generated in this checkout `
        + `(${missing.join(', ')}). Normal on a fresh clone (*.g.dart is gitignored); `
        + 'run `make -C apps/mobile gen`. NOTHING about freshness was verified here.',
    );
    return 2;
  }

  console.log(
    `gen_protocol --check: ${compared} generated artefact(s) match their source data`
      + (missing.length > 0 ? `; ${missing.length} never generated (skipped): ${missing.join(', ')}` : ''),
  );
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--check')) {
    process.exit(check(argv.includes('--skip-missing')));
  }

  runEventCodegen();
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(EVENTS_G, join(OUT_DIR, 'flowmic_events.g.dart'));
  const plan = renderAll();
  for (const f of plan.files) {
    if (f.copyOf) continue; // already copied above
    writeFileSync(join(OUT_DIR, f.name), f.text, 'utf8');
  }
  console.log(
    `gen_protocol: events + schema + retired-relays(${plan.retired.length})`
      + ` + pair-link(https://${plan.pairLink.host}${plan.pairLink.path},`
      + ` ${plan.pairCustom.scheme}://${plan.pairCustom.host})`
      + ` + settings(${plan.settings.keys} keys, ${plan.settings.packs} packs) -> ${OUT_DIR}`,
  );
}

main();
