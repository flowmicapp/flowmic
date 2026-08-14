// The ONE reader of the UI-locale registry.
//
// Source of truth: packages/protocol/src/locales.ts (`UI_LOCALES`). That file's
// own header states the rule this module serves: "a new language is a ROW HERE
// plus a data file, and nothing else". Every surface generator reads the list
// THROUGH here, so the number of places that know how to spell a locale list
// stays at one. Five duplicated endonym maps is the shape this replaces.
//
// Parsed TEXTUALLY, no TypeScript runtime and no build step — same technique and
// same reason as packages/protocol/scripts/gen-dart.mjs (`extractEventNames`):
// codegen must run on a bare `node`, before and independently of
// `pnpm --filter @flowmic/protocol build`. The registry is a flat array of
// object literals written on one line each, which is what makes this safe; the
// parser refuses anything it does not fully understand rather than guessing.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
// Module-local on purpose: every caller goes through the functions below, so
// there is no exported path constant for someone to read the registry a second,
// slightly different way.
const REGISTRY_PATH = join(REPO_ROOT, 'packages', 'protocol', 'src', 'locales.ts');
/** Repo-relative form, for generated-file banners (no absolute paths in output). */
export const REGISTRY_REL = 'packages/protocol/src/locales.ts';

/**
 * Every row of `UI_LOCALES`, in registry order (which is display order).
 * @returns {{code:string, dart:string, endonym:string, script:string, authored:boolean}[]}
 */
export function readUiLocales(source = readFileSync(REGISTRY_PATH, 'utf8')) {
  const start = source.indexOf('export const UI_LOCALES');
  if (start === -1) throw new Error(`locale-registry: UI_LOCALES not found in ${REGISTRY_REL}`);
  const open = source.indexOf('[', start);
  const close = source.indexOf('] as const', open);
  if (open === -1 || close === -1) {
    throw new Error(`locale-registry: UI_LOCALES array bounds not found in ${REGISTRY_REL}`);
  }
  const body = source.slice(open + 1, close);

  const rows = [];
  for (const rawLine of body.split('\n')) {
    // Drop line comments first: the registry carries long prose notes between
    // rows, and a quoted tag inside one must never become a row.
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line.startsWith('{')) continue;
    const objEnd = line.lastIndexOf('}');
    if (objEnd === -1) {
      throw new Error(`locale-registry: row is not on a single line, refusing to guess: ${line}`);
    }
    const inner = line.slice(1, objEnd);
    const row = {};
    for (const [, key, str] of inner.matchAll(/(\w+)\s*:\s*'([^']*)'/g)) row[key] = str;
    if (/\bauthored\s*:\s*true\b/.test(inner)) row.authored = true;
    for (const required of ['code', 'dart', 'endonym', 'script']) {
      if (!row[required]) {
        throw new Error(`locale-registry: row missing '${required}': ${line}`);
      }
    }
    rows.push({ ...row, authored: row.authored === true });
  }
  if (rows.length === 0) throw new Error('locale-registry: no rows extracted');
  return rows;
}

/** `DEFAULT_UI_LOCALE` — what the first frame renders before a human has
 *  chosen. Read from the registry rather than restated per surface: it is the
 *  same product fact, and a surface that disagrees with the registry about it
 *  boots in a language the rest of the app is not in. */
export function defaultCode(source = readFileSync(REGISTRY_PATH, 'utf8'), rows = undefined) {
  const m = source.match(/export const DEFAULT_UI_LOCALE\s*:[^=]*=\s*'([^']+)'/);
  if (!m) throw new Error(`locale-registry: DEFAULT_UI_LOCALE not found in ${REGISTRY_REL}`);
  const code = m[1];
  const all = rows ?? readUiLocales(source);
  if (!all.some((r) => r.code === code)) {
    throw new Error(`locale-registry: DEFAULT_UI_LOCALE '${code}' is not a UI_LOCALES row`);
  }
  return code;
}

/** `BASE_UI_LOCALE` — the language a MISSING translation falls back to (owner
 *  2026-08-14, 17 册 §0-bis). Deliberately read separately from
 *  [defaultCode]: the registry keeps them as two constants because 「缺译回落到
 *  哪一种」 and 「新装的第一帧渲染哪一种」 are two questions, and this repo's
 *  most-repeated defect is one value answering two. A generator that reached for
 *  DEFAULT_UI_LOCALE here would silently move the fallback base the day a
 *  ruling moves the startup default. */
export function baseCode(source = readFileSync(REGISTRY_PATH, 'utf8'), rows = undefined) {
  const m = source.match(/export const BASE_UI_LOCALE\s*:[^=]*=\s*'([^']+)'/);
  if (!m) throw new Error(`locale-registry: BASE_UI_LOCALE not found in ${REGISTRY_REL}`);
  const code = m[1];
  const all = rows ?? readUiLocales(source);
  if (!all.some((r) => r.code === code)) {
    throw new Error(`locale-registry: BASE_UI_LOCALE '${code}' is not a UI_LOCALES row`);
  }
  return code;
}

/** The languages copy is WRITTEN in. A generator must never take a translated
 *  locale as its reference column — that is how a machine translation becomes
 *  the origin of the next one (17 册 §1). */
export function authoredCodes(rows = readUiLocales()) {
  const authored = rows.filter((r) => r.authored).map((r) => r.code);
  if (authored.length === 0) throw new Error('locale-registry: no authored locale');
  return authored;
}

/**
 * `zh-CN` -> `ZhCn`, `en` -> `En`, `zh-TW` -> `ZhTw`. The Rust enum variant name
 * for a locale code. Derived rather than stored: unlike the Dart member name
 * (which the registry keeps as a `dart` field because Dart forbids the hyphen
 * AND wants lowerCamel), the Rust spelling is a pure function of the code with
 * no case left to a human's discretion.
 */
export function rustVariant(code) {
  const parts = code.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) throw new Error(`locale-registry: cannot form a Rust variant from ${code}`);
  return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join('');
}
