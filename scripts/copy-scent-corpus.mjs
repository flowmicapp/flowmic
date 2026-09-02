// scripts/copy-scent-corpus.mjs
// WHAT TEXT COUNTS AS COPY, for the AI-scent audit. Data extraction only: this
// module never decides whether a sentence is good, and never talks to a model.
//
// WHY IT IS A SEPARATE FILE. The auditor (scripts/copy-scent-audit.mjs) and its
// drill (scripts/copy-scent-audit.test.mjs) both need to know what a unit is.
// Two answers to "what is our copy" is this repository's most expensive
// recurring defect, so the answer exists once, here, and both dereference it.
//
// THE VALUES IN i18n/desktop/*.json AND i18n/mobile/*.json ARE SOURCE LITERALS,
// NOT PLAIN TEXT -- `"strings.app_name": "'FlowMic'"` carries its own quotes,
// escapes and `$holes`, and a value may be an ARRAY of literals that the
// generator concatenates (the reason 1,000-character paragraphs are wrapped at
// all). Handing those bytes to a model verbatim would ask it to judge our
// quoting, and it would answer -- confidently. `decodeLiteral` below is the
// whole reason this file is not four lines of JSON.parse.
//   i18n/desktop-rust/*.json is the exception: those values are plain text.
//   Getting that backwards silently strips the first and last character of
//   every tray label, so the shape is DECLARED per directory rather than
//   sniffed.
//
// WHAT IS DELIBERATELY NOT A UNIT:
//   . `locale` and other metadata keys -- not rendered to anyone.
//   . Identifier-shaped literals (SCREAMING_SNAKE, dotted keys) -- the generated
//     catalogues are full of them and no user ever sees one. Same predicate the
//     outward-voice lint uses, imported rather than restated.
//   . Strings under 3 characters, and strings with no letter in them at all
//     ('.', '$n', '--'). A model asked to judge punctuation will judge it.
//   . Comments, anywhere. An internal register is CORRECT in a comment; that is
//     contract 21 sec 1-2, and a scanner that counted comments would be red on
//     day one and switched off by day three.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, stat } from 'node:fs/promises';

import { maskMarkdown, isIdentifierLiteral } from '../verify/lint/outward-voice.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Directories of per-locale catalogues, and the SHAPE of their values.
 * `literal` = Dart/TS source literal (quoted, escaped, possibly an array).
 * `plain`   = the text itself.
 */
const CATALOGUES = [
  { dir: 'i18n/desktop', shape: 'literal', what: 'desktop app strings' },
  { dir: 'i18n/mobile', shape: 'literal', what: 'phone app strings' },
  { dir: 'i18n/desktop-rust', shape: 'plain', what: 'desktop tray / native strings' },
];

/** Root-level Markdown that a stranger reads. See contract 21 sec 1-1. */
const ROOT_MD_INCLUDE = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CLAUDE.public.md'];
/** Not copy: internal contract, history, third-party text. Contract 21 sec 4-1. */
const ROOT_MD_EXCLUDE = new Set(['CLAUDE.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']);

const META_KEYS = new Set(['locale', 'coverage', '$schema']);

/**
 * Decode one Dart/TS source literal, or an array of them, into the text a user
 * actually reads. Returns null when the value is not a literal at all, which is
 * a fact worth surfacing rather than guessing about.
 */
export function decodeLiteral(value) {
  const parts = Array.isArray(value) ? value : [value];
  let out = '';
  for (const raw of parts) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    const q = s[0];
    if ((q !== "'" && q !== '"') || s[s.length - 1] !== q || s.length < 2) return null;
    const body = s.slice(1, -1);
    // Only the escapes these catalogues actually contain. An unknown escape is
    // left as written rather than invented.
    out += body.replace(/\\(['"\\$nt])/g, (_m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  return out;
}

/**
 * The interpolation holes these catalogues use. Blanked BEFORE asking whether a
 * string contains any prose, because the variable name inside a hole is made of
 * letters: `'· $n'` is a layout fragment with no voice at all, and a predicate
 * that only looked for `\p{L}` called it copy and sent it to a model to judge.
 * (Found by the drill, not by reading -- scripts/copy-scent-audit.test.mjs.)
 */
const HOLES = /\$\{[^}]*\}|\$\w+|\{\w+\}|%\d*\$?[sdf@]/g;

/** A unit worth a model's opinion, or not. */
export function isAuditableText(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 3) return false;
  if (isIdentifierLiteral(t)) return false;
  // Needs at least one letter of its OWN, in some script, once the holes are out.
  if (!/\p{L}/u.test(t.replace(HOLES, ' '))) return false;
  return true;
}

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (META_KEYS.has(k)) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.push([key, v]);
  }
  return out;
}

async function readJson(abs) {
  return JSON.parse(await readFile(abs, 'utf8'));
}

async function collectCatalogues({ root, locales }) {
  const units = [];
  for (const { dir, shape } of CATALOGUES) {
    const abs = path.join(root, dir);
    let names;
    try {
      names = await readdir(abs);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const locale = name.slice(0, -5);
      // leaves.json / coverage.json are contracts ABOUT the catalogue, not copy.
      if (locale === 'leaves' || locale === 'coverage') continue;
      if (locales && !locales.includes(locale)) continue;
      const json = await readJson(path.join(abs, name));
      for (const [key, value] of flatten(json, '', [])) {
        const text = shape === 'literal' ? decodeLiteral(value) : typeof value === 'string' ? value : null;
        if (text === null) continue;
        if (!isAuditableText(text)) continue;
        units.push({ id: `${dir}/${locale}#${key}`, surface: 'app', locale, file: `${dir}/${name}`, key, text });
      }
    }
  }
  return units;
}

/**
 * Markdown becomes one unit per BLOCK. Blocks, not files: a model handed a
 * 400-line README returns an essay about the README, and a model handed one
 * sentence at a time loses the paragraph's own rhythm -- which is half of what
 * "reads like a machine wrote it" even means.
 */
async function collectRootMarkdown({ root }) {
  const units = [];
  for (const name of ROOT_MD_INCLUDE) {
    if (ROOT_MD_EXCLUDE.has(name)) continue;
    const abs = path.join(root, name);
    try {
      await stat(abs);
    } catch {
      continue;
    }
    const masked = maskMarkdown(await readFile(abs, 'utf8'));
    const lines = masked.split('\n');
    let block = [];
    let startLine = 1;
    const flush = () => {
      const text = block.join('\n').trim();
      if (isAuditableText(text) && text.split(/\s+/).length >= 6) {
        units.push({
          id: `${name}#L${startLine}`,
          surface: name === 'README.md' ? 'readme' : 'contrib',
          locale: 'en',
          file: name,
          key: `L${startLine}`,
          text,
        });
      }
      block = [];
    };
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === '') {
        flush();
        startLine = i + 2;
        continue;
      }
      if (block.length === 0) startLine = i + 1;
      block.push(line);
    }
    flush();
  }
  return units;
}

/**
 * The web repository's locale catalogues (site + console). NOT reachable from
 * this repository's lint -- that boundary is stated in contract 21 sec 4-1 --
 * but it IS reachable from a developer's disk, so the auditor can be pointed at
 * it rather than pretending the surface does not exist. Absence is REPORTED,
 * never silently treated as clean.
 */
async function collectWeb({ webRoot, locales }) {
  if (!webRoot) return { units: [], reason: 'no --web-root given (pass the web checkout, or set FLOWMIC_COPY_AUDIT_WEB_ROOT)' };
  const dir = path.join(webRoot, 'src', 'i18n');
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return { units: [], reason: `not readable: ${dir}` };
  }
  const units = [];
  for (const name of names.sort()) {
    const m = /^([a-z]{2}(?:-[A-Za-z]{2,4})?)\.ts$/.exec(name);
    if (!m) continue;
    const locale = m[1];
    if (locales && !locales.includes(locale)) continue;
    const src = await readFile(path.join(dir, name), 'utf8');
    // Deliberately a LEXICAL sweep, not an import: importing a TypeScript module
    // from a sibling repository would drag that repository's toolchain into this
    // one. Every `key: 'text'` pair is a unit; template literals are taken whole.
    const re = /(\w+)\s*:\s*(`[^`]*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
    let hit;
    while ((hit = re.exec(src)) !== null) {
      const key = hit[1];
      const raw = hit[2];
      const text = raw[0] === '`' ? raw.slice(1, -1) : decodeLiteral(raw);
      if (text === null || !isAuditableText(text)) continue;
      units.push({ id: `web/src/i18n/${locale}#${key}@${hit.index}`, surface: 'site', locale, file: `web/src/i18n/${name}`, key, text });
    }
  }
  return { units, reason: null };
}

/**
 * Collect every unit for the requested surfaces.
 * @returns {Promise<{units: Array, notes: string[]}>}
 */
export async function collectUnits({ root = ROOT, surfaces = null, locales = null, webRoot = null } = {}) {
  const want = (s) => !surfaces || surfaces.includes(s);
  const notes = [];
  let units = [];
  if (want('app')) units = units.concat(await collectCatalogues({ root, locales }));
  if (want('readme') || want('contrib')) {
    const md = await collectRootMarkdown({ root });
    units = units.concat(md.filter((u) => want(u.surface)));
  }
  if (want('site') || want('console')) {
    const web = await collectWeb({ webRoot, locales });
    if (web.reason) notes.push(`site/console NOT audited -- ${web.reason}`);
    units = units.concat(web.units);
  }
  return { units, notes };
}

export const SURFACE_IDS = ['app', 'readme', 'contrib', 'site', 'console'];
