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
//   3. Derives PROTOCOL_SCHEMA_VERSION from packages/protocol/src/constants.ts
//      into flowmic_protocol.g.dart, so the handshake schema_ver is ALSO
//      generated (no hand-mirrored integer — the legacy kProtocolSchemaVersion
//      was a manual mirror; this closes that seam too).
//
// Usage (from anywhere): node apps/mobile/tool/gen_protocol.mjs
// Convenience wrappers: apps/mobile/Makefile (`make gen`), and the pnpm script
// `@flowmic/protocol codegen:dart` covers step 1 alone.

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

function writeProtocolConsts(schemaVersion) {
  const dart = `// GENERATED — DO NOT EDIT BY HAND.
// Source: packages/protocol/src/constants.ts (PROTOCOL_SCHEMA_VERSION)
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
`;
  writeFileSync(join(OUT_DIR, 'flowmic_protocol.g.dart'), dart, 'utf8');
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
function writeSettingsConsts() {
  const constants = readFileSync(CONSTANTS_TS, 'utf8');
  const scenario = readFileSync(SCENARIO_TS, 'utf8');
  const dictionary = readFileSync(DICTIONARY_TS, 'utf8');

  const scenarioCardKey = readConstStr(constants, 'SETTINGS_KEY_SCENARIO_CARD');
  const maxLabel = readConstInt(scenario, 'SCENARIO_MAX_LABEL_LEN');
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
  writeFileSync(join(OUT_DIR, 'flowmic_settings.g.dart'), dart, 'utf8');
  return { keys: 2, packs: packs.length };
}

function main() {
  runEventCodegen();
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(EVENTS_G, join(OUT_DIR, 'flowmic_events.g.dart'));
  writeProtocolConsts(readSchemaVersion());
  const s = writeSettingsConsts();
  console.log(
    `gen_protocol: events + schema + settings(${s.keys} keys, ${s.packs} packs) -> ${OUT_DIR}`,
  );
}

main();
