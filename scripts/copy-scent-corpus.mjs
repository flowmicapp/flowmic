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
 * Where the web checkout keeps copy a visitor reads, and how deep the keys go.
 *
 * `flat`   -- one object of `key: 'text'` pairs (nesting exists but the key we
 *             report is the leaf, because those ids are already in receipts).
 * `nested` -- one object PER PAGE: `{ 'typing-hurts': { title, limits, ... } }`.
 *             The reported key is the whole path, `typing-hurts.limits`, so a
 *             `--key 'typing-hurts\.'` selects exactly one page.
 *
 * WHY THIS IS A TABLE. Until 2026-09-05 the site surface was `src/i18n` and
 * nothing else, so four directories of page copy -- the guide, the use-case,
 * comparison and download pages, ~5,200 units across nine locales -- were
 * NEVER audited, while the audit reported `site` as covered. A surface that
 * names itself after one of its five directories is the "one value answering
 * two questions" shape, in the corpus.
 */
export const WEB_COPY_DIRS = [
  { dir: 'src/i18n', shape: 'flat', what: 'site + console catalogues' },
  { dir: 'src/views/guide/copy', shape: 'nested', what: 'user guide chapters' },
  { dir: 'src/views/usecases/copy', shape: 'nested', what: 'use-case pages' },
  { dir: 'src/views/versus/copy', shape: 'nested', what: 'comparison pages' },
  { dir: 'src/views/download/copy', shape: 'nested', what: 'download pages' },
];

/** A TS/JS string or template literal, as source. Shared by both sweeps. */
const TS_STRING = String.raw`\`[^\`]*\`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"`;

/**
 * Blank out line comments and block comments, PRESERVING EVERY BYTE OFFSET.
 *
 * Two things are load-bearing here and each cost a measurement to find:
 *   . Offsets. A unit's id ends in `@<index>`, so a stripper that shortened the
 *     file would renumber every id after the first comment -- measured while
 *     writing this: a naive strip moved ~700 ids per locale file.
 *   . Strings first. `'https://flowmic.app'` contains `//`. A masker that did
 *     not track quotes ate the rest of that line, and the line after it.
 * Comments are not copy (see this file's header, and contract 21 sec 4-1): an
 * internal register is CORRECT in a comment, and these files are full of long
 * ones explaining why a page says what it says.
 */
export function maskTsComments(src) {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i += 1;
          break;
        }
        // An unterminated single/double quote ends at the newline; a template
        // literal does not. Getting this wrong swallows the rest of the file.
        if (quote !== '`' && src[i] === '\n') break;
        i += 1;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i += 1) if (src[i] !== '\n') out[i] = ' ';
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Every `key: 'text'` pair, keyed by its leaf. The original site sweep. */
function sweepFlat(src) {
  const re = new RegExp(String.raw`(\w+)\s*:\s*(${TS_STRING})`, 'g');
  const out = [];
  let hit;
  while ((hit = re.exec(src)) !== null) out.push({ key: hit[1], raw: hit[2], index: hit.index });
  return out;
}

/**
 * The same pairs, but carrying the object path that leads to them.
 *
 * A brace counter rather than a parser, for the reason the original sweep gave:
 * importing a TypeScript module from a sibling repository would drag that
 * repository's toolchain into this one. Strings are consumed as whole tokens so
 * a `{` inside copy cannot move the depth -- the failure mode being one stray
 * brace in one sentence renaming every key after it.
 */
const NESTED_TOKEN = new RegExp(
  [
    String.raw`(?:'(?<kq>[^'\n]+)'|"(?<kd>[^"\n]+)"|(?<kb>[A-Za-z_$][\w$]*))\s*:\s*(?:(?<open>\{)|(?<val>${TS_STRING}))`,
    String.raw`(?<str>${TS_STRING})`,
    String.raw`(?<lb>\{)`,
    String.raw`(?<rb>\})`,
  ].join('|'),
  'g',
);

function sweepNested(src) {
  const out = [];
  // `export const X = {` opens a frame with no name of its own; filtering the
  // nameless frames out is what keeps the reported key `page.field` rather than
  // `.page.field`.
  const stack = [];
  let hit;
  NESTED_TOKEN.lastIndex = 0;
  while ((hit = NESTED_TOKEN.exec(src)) !== null) {
    const g = hit.groups;
    const key = g.kq ?? g.kd ?? g.kb;
    if (g.open) stack.push(key);
    else if (g.val !== undefined && key !== undefined) out.push({ key: [...stack, key].filter(Boolean).join('.'), raw: g.val, index: hit.index });
    else if (g.lb) stack.push(null);
    else if (g.rb) stack.pop();
    // A bare string token falls through on purpose: consumed, never a unit.
  }
  return out;
}

/**
 * The web repository's copy (site + console). NOT reachable from this
 * repository's lint -- that boundary is stated in contract 21 sec 4-1 -- but it
 * IS reachable from a developer's disk, so the auditor can be pointed at it
 * rather than pretending the surface does not exist. Absence is REPORTED, never
 * silently treated as clean.
 *
 * A note about the guide's split keys (`leadBefore` / `leadStrong` /
 * `leadAfter`): they arrive as three units, because that is how they arrive in
 * the file and joining them here would invent a key that `--key` could not
 * name. The fragments are short and a model asked to judge one alone will say
 * so; the surrounding neighbours are what `scripts/copy-scent-context.mjs`
 * exists to supply.
 */
async function collectWeb({ webRoot, locales }) {
  if (!webRoot) return { units: [], notes: ['no --web-root given (pass the web checkout, or set FLOWMIC_COPY_AUDIT_WEB_ROOT)'] };
  const units = [];
  const notes = [];
  let readAny = false;
  for (const { dir, shape } of WEB_COPY_DIRS) {
    const abs = path.join(webRoot, ...dir.split('/'));
    let names;
    try {
      names = await readdir(abs);
    } catch {
      notes.push(`not readable: ${abs}`);
      continue;
    }
    readAny = true;
    for (const name of names.sort()) {
      const m = /^([a-z]{2}(?:-[A-Za-z]{2,4})?)\.ts$/.exec(name);
      if (!m) continue;
      const locale = m[1];
      if (locales && !locales.includes(locale)) continue;
      const src = maskTsComments(await readFile(path.join(abs, name), 'utf8'));
      for (const { key, raw, index } of shape === 'nested' ? sweepNested(src) : sweepFlat(src)) {
        const text = raw[0] === '`' ? raw.slice(1, -1) : decodeLiteral(raw);
        if (text === null || !isAuditableText(text)) continue;
        units.push({ id: `web/${dir}/${locale}#${key}@${index}`, surface: 'site', locale, file: `web/${dir}/${name}`, key, text });
      }
    }
  }
  // One unreadable directory is a hole in a surface that still reports units,
  // which is exactly the shape that gets read as coverage. Say it out loud.
  if (!readAny) return { units: [], notes: [`no copy directory readable under ${webRoot}`] };
  return { units, notes };
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
    for (const reason of web.notes) notes.push(`site/console NOT fully audited -- ${reason}`);
    units = units.concat(web.units);
  }
  return { units, notes };
}

export const SURFACE_IDS = ['app', 'readme', 'contrib', 'site', 'console'];
