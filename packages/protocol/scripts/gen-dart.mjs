#!/usr/bin/env node
// WP-R0-1 Dart codegen (D3 lesson: "新版协议包必须带 Dart codegen" — the legacy
// hand-mirrored Dart event list drifted, stuck at 54 names).
//
// Scope of THIS card: EVENT NAME CONSTANTS ONLY. The zod-schema → Dart mirror
// is deferred to R3. The generated *.g.dart is gitignored (root .gitignore);
// the script is committed, the product is not.
//
// Source of truth: src/events.ts EVENT_NAMES. Parsed textually (no TS runtime)
// so this runs on a bare `node` with zero build step.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const SRC = join(PKG, 'src', 'events.ts');
const OUT = join(PKG, 'gen', 'dart', 'flowmic_events.g.dart');

/** Extract the string literals inside the `EVENT_NAMES = [ ... ] as const` array. */
function extractEventNames(source) {
  const start = source.indexOf('EVENT_NAMES');
  if (start === -1) throw new Error('EVENT_NAMES not found in events.ts');
  const open = source.indexOf('[', start);
  const close = source.indexOf('] as const', open);
  if (open === -1 || close === -1) throw new Error('EVENT_NAMES array bounds not found');
  const body = source.slice(open + 1, close);

  const names = [];
  for (const rawLine of body.split('\n')) {
    // Drop line comments so a `//` note can never contribute a false literal.
    const line = rawLine.replace(/\/\/.*$/, '');
    const m = line.match(/'([^']+)'/);
    if (m) names.push(m[1]);
  }
  if (names.length === 0) throw new Error('no event names extracted');
  return names;
}

/** `history:list-result` -> `historyListResult` (a legal Dart identifier). */
function toCamel(eventName) {
  const parts = eventName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p[0].toLowerCase() + p.slice(1) : p[0].toUpperCase() + p.slice(1)))
    .join('');
}

function generate(names) {
  const consts = names
    .map((n) => `  static const String ${toCamel(n)} = '${n}';`)
    .join('\n');
  const setEntries = names.map((n) => `    ${toCamel(n)},`).join('\n');
  return `// GENERATED — DO NOT EDIT BY HAND.
// Source: packages/protocol/src/events.ts (EVENT_NAMES)
// Regenerate: node packages/protocol/scripts/gen-dart.mjs
// Count: ${names.length} canonical events (protocol schema v2).
//
// ignore_for_file: constant_identifier_names, lines_longer_than_80_chars

/// The FlowMic socket.io event-name whitelist, mirrored from the TypeScript
/// protocol package. Any event a Dart client emits/receives MUST be one of
/// these; unknown names are a protocol violation.
class FlowMicEvents {
  FlowMicEvents._();

${consts}

  /// Every canonical event name, for whitelist membership checks.
  static const Set<String> all = <String>{
${setEntries}
  };

  static bool isKnown(String name) => all.contains(name);
}
`;
}

function main() {
  const source = readFileSync(SRC, 'utf8');
  const names = extractEventNames(source);
  const dart = generate(names);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, dart, 'utf8');
  console.log(`gen-dart: wrote ${names.length} event constants -> ${OUT}`);
}

main();
