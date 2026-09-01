// verify/lint/outward-voice.mjs
// Outward copy must not be written in this repository's internal register.
// Contract: docs/rebuild/21-OUTWARD-COPY-VOICE-CONTRACT.md
//   (ruling D2 wrote "17-", and that number was already taken twice in
//   docs/rebuild/ — see the correction block at the top of the contract)
// Rulings:  docs/decisions/2026-09-01-owner-outward-copy-voice-rulings.md (D3, D7)
// Terms:    verify/lint/outward-voice-terms.mjs (the data; nothing restates it)
//
// WHY THIS EXISTS. A section was added to the public README.md in the register
// this repository uses internally — meta-disclaimers ("if that file and this
// table disagree, the file is right"), narration of what we have and have not
// measured, and aphorisms ("silence dressed up as a transcript, which is worse
// than an error"). That register is correct in CLAUDE.md and wrong on a landing
// page. The owner rejected it and ruled that banned terms and meta-statements
// become a hard gate while cadence only prints a number.
//
// 🔴 WHAT THIS GATE DOES *NOT* DECIDE — read this before trusting a PASS.
// A machine can decide four things: whether a listed internal word appears in
// copy, whether a listed meta-statement template appears in copy, how many
// em-dashes there are per thousand words, and whether its own scanner was
// awake. It cannot decide whether a sentence is preachy, whether a three-part
// list is mechanically parallel, whether a paragraph is written from the
// visitor's point of view, or whether an adjective is hype. Those are the four
// prohibitions in the contract's §2, and three and a half of them are outside
// this file. **PASS here means "no listed term and no listed template reached a
// scanned surface". It does not mean the contract was honoured.** The rest is an
// AI review plus a human decision, exactly as amendment M4 requires. Saying
// otherwise would make this lint answer a question it did not measure — the
// shape this repository calls 一个值答了两个问题.
//
// ── WHAT IS SCANNED, AND WHAT COUNTS AS COPY ────────────────────────────────
// COPY, NOT COMMENTS. Measured across the outward surfaces on 2026-09-01: most
// hits repo-wide are inside comments, which are an internal surface. A gate
// that counted those would be red on day one and dead by day three, so every
// file is masked down to the text a reader can actually see before it is
// scanned:
//   *.md    — HTML comments, fenced code, inline code spans and link targets
//             are blanked. A fenced block is a command the reader is meant to
//             type, not our voice.
//   *.ts    — comments blanked (the shared position-safe stripper), then only
//             the interiors of string literals are kept. This is load-bearing
//             for the generated catalogue: its KEYS are identifiers such as
//             `diag_probe_start` that no user ever sees, and scanning them
//             would report six leaks where the product has one.
//   *.dart  — comments blanked (including nested block comments and the
//             triple-quoted string forms), then only string interiors kept.
// Masking preserves offsets, so reported line numbers are the real ones.
//
// ── WHAT IS DELIBERATELY OUT OF SCOPE ───────────────────────────────────────
// · The marketing site and the account console live in the WEB repository. A
//   gate here cannot see them; their half belongs beside that repository's
//   no-raw-identifiers test, which already has a real
//   `pnpm build -> vitest -> deploy refuses an unbuilt dist` chain. The `site`
//   and `console` surfaces are still named in the term data because the
//   contract's prompt routes by the same names.
// · CLAUDE.md (internal contract; the export replaces it) and CHANGELOG.md
//   (history, which this repository's standing rule never rewrites, and which
//   the public tree does not carry). LICENSE and NOTICE are third-party text.
// · Vue components, Rust strings, and every app string outside the two
//   catalogues below. Widening the face is cheap; doing it without first
//   measuring what it would report is how a gate arrives red.
//
// ── THE PINS ────────────────────────────────────────────────────────────────
// verify/lint/outward-voice-baseline.mjs holds the occurrences that were
// already on a surface when this gate landed and are owned by a card that is
// not this one. A pin is exact: more occurrences fail as new, fewer fail as a
// pin that must be lowered or deleted. Nothing may be added to it without a
// ruling to point at.

import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { ROOT, readText, stripJsComments } from './_util.mjs';
import { BANNED, META_PATTERNS, CONTROL_STRING, EM_DASH_PER_1000_REFERENCE } from './outward-voice-terms.mjs';
import { KNOWN_HITS } from './outward-voice-baseline.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/outward-voice.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'outward-voice';

/** Root-level documents that are NOT outward copy, each with the reason. */
const ROOT_MD_EXCLUDED = new Map([
  ['CLAUDE.md', 'internal operating contract; the open-source export replaces it with CLAUDE.public.md'],
  ['CHANGELOG.md', 'release history — never rewritten by a pass, and not carried by the public tree'],
]);

/** Contributor-facing: exempt from internal VOCABULARY, not from META_PATTERNS. */
const CONTRIB_FILES = new Set(['CONTRIBUTING.md', 'SECURITY.md', 'CLAUDE.public.md']);

/**
 * The surfaces this repository can actually walk. `site` and `console` are
 * named in the term data because the contract's prompt routes by the same
 * names, and they are NOT here because their files live in the web repository.
 */
const SCANNABLE_SURFACES = new Set(['readme', 'contrib', 'app']);

/** App surfaces this repository can walk. Both are string catalogues. */
const APP_FILES = ['apps/desktop/src/lib/strings/generated/catalogue.g.ts'];
const APP_DIRS = ['apps/mobile/lib/src/settings/strings/'];

// ── masking ─────────────────────────────────────────────────────────────────
// Every masker returns a string of the SAME LENGTH as its input, with
// everything that is not reader-visible copy replaced by spaces and every
// newline preserved, so a match offset still maps to the real line.

const blank = (s) => s.replace(/[^\n]/g, ' ');

function maskRegion(text, re) {
  return text.replace(re, (m) => blank(m));
}

/**
 * Markdown -> the prose a reader sees.
 *
 * NOT masked, on purpose: indented code blocks. Telling one from a list
 * continuation line needs a real block parser, and guessing wrong would blank
 * ordinary prose — a false negative that hides a term is cheaper than a masker
 * that silently deletes half a document from the scan.
 */
export function maskMarkdown(text) {
  let t = text;
  t = maskRegion(t, /<!--[\s\S]*?-->/g); // HTML comments
  t = maskRegion(t, /^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[^\n]*$/gm); // fenced code
  t = maskRegion(t, /`[^`\n]*`/g); // inline code spans
  t = maskRegion(t, /\]\([^)\n]*\)/g); // link and image targets
  t = maskRegion(t, /<https?:\/\/[^>\n]*>/g); // autolinks
  return t;
}

/**
 * A string literal is not automatically copy. `'LLM_PROBE_FAIL'` is a protocol
 * identifier used as a switch case, and counting it would report a leak where
 * the product has none. A literal with no lower-case letter and no space is an
 * identifier, and identifiers rendered to a user are a different rule with its
 * own gate (the web repository's no-raw-identifiers test).
 *
 * An underscore is REQUIRED, deliberately. Without it the test also swallows
 * `'OK'` and `'PROBE'`, which are perfectly good button labels — and swallowing
 * a shouted label is the one direction where this shortcut would hide a real
 * leak rather than a false one.
 */
export function isIdentifierLiteral(s) {
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(s);
}

/** Keep only the interiors of string literals in already-comment-blanked JS/TS. */
function keepStringInteriors(commentFree) {
  const out = blank(commentFree).split('');
  const LITERAL = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;
  for (let m; (m = LITERAL.exec(commentFree)); ) {
    const from = m.index + 1;
    const to = m.index + m[0].length - 1;
    if (isIdentifierLiteral(commentFree.slice(from, to))) continue;
    // Copy the interior only: the quotes themselves are not copy, and dropping
    // them stops `'` from ever looking like an apostrophe inside a match.
    for (let i = from; i < to; i++) out[i] = commentFree[i];
  }
  return maskInterpolations(out.join(''));
}

/** `${...}` and `$name` are code inside a string, not words a reader sees. */
function maskInterpolations(text) {
  return maskRegion(maskRegion(text, /\$\{[^}\n]*\}/g), /\$[A-Za-z_][A-Za-z0-9_]*/g);
}

export function maskTs(text) {
  return keepStringInteriors(stripJsComments(text));
}

/**
 * Dart -> string interiors only.
 *
 * Written rather than borrowed because Dart differs from JS in two ways that
 * both desynchronise a JS scanner: block comments NEST, and `'''`/`"""` open a
 * string that ordinary single-quote handling would read as two empty strings
 * followed by an unterminated one.
 */
export function maskDart(text) {
  const out = blank(text).split('');
  const n = text.length;
  let i = 0;
  let depth = 0; // nested /* */ depth
  while (i < n) {
    if (depth > 0) {
      if (text.startsWith('/*', i)) { depth++; i += 2; continue; }
      if (text.startsWith('*/', i)) { depth--; i += 2; continue; }
      i++;
      continue;
    }
    if (text.startsWith('//', i)) {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (text.startsWith('/*', i)) { depth = 1; i += 2; continue; }

    const raw = text[i] === 'r' && (text[i + 1] === "'" || text[i + 1] === '"');
    const q0 = raw ? i + 1 : i;
    const ch = text[q0];
    if (ch === "'" || ch === '"') {
      const triple = text.startsWith(ch.repeat(3), q0);
      const close = triple ? ch.repeat(3) : ch;
      const from = q0 + close.length;
      let j = from;
      while (j < n) {
        if (!raw && text[j] === '\\') { j += 2; continue; }
        if (!triple && text[j] === '\n') break; // unterminated single-line string
        if (text.startsWith(close, j)) break;
        j++;
      }
      if (!isIdentifierLiteral(text.slice(from, j))) {
        for (let k = from; k < j; k++) out[k] = text[k];
      }
      i = j + (text.startsWith(close, j) ? close.length : 0);
      continue;
    }
    i++;
  }
  return maskInterpolations(out.join(''));
}

function maskFor(relPath, text) {
  if (relPath.endsWith('.md')) return maskMarkdown(text);
  if (relPath.endsWith('.ts')) return maskTs(text);
  if (relPath.endsWith('.dart')) return maskDart(text);
  return blank(text);
}

// ── scanning ────────────────────────────────────────────────────────────────

const WORD_EDGE = '[A-Za-z0-9]';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A term matches its inflections, because the leaks are inflected. Measured
 * while wiring this gate: the first version missed "golden paths" in README.md
 * and "Not probed" in the desktop catalogue — two real occurrences of two
 * listed terms, invisible because the list stores the lemma and the copy uses
 * a plural and a past tense. A term list that only matches the dictionary form
 * measures the list, not the copy.
 *
 * Covered: -s, -es, -d, -ed, -ing, and the e-dropping -ing (probe -> probing).
 * NOT covered: irregular forms. There are none in the list, and inventing a
 * stemmer for a fourteen-entry table would be a second thing to be wrong.
 */
export function termRegex(entry) {
  const t = entry.term;
  const alts = [esc(t)];
  if (/[a-z]$/i.test(t)) {
    alts.push(`${esc(t)}(?:s|es|d|ed|ing)`);
    if (/e$/i.test(t)) alts.push(`${esc(t.slice(0, -1))}ing`);
  }
  // `verify:` ends in a colon, so a trailing word boundary would never match.
  const lead = new RegExp(`^${WORD_EDGE}`).test(t) ? `(?<!${WORD_EDGE})` : '';
  const tail = new RegExp(`${WORD_EDGE}$`).test(t) ? `(?!${WORD_EDGE})` : '';
  return new RegExp(`${lead}(?:${alts.join('|')})${tail}`, entry.caseSensitive ? 'g' : 'gi');
}

/**
 * The desktop catalogue is GENERATED. Naming the file that carries the string
 * would send the reader to edit the one place an edit does not survive — and
 * `verify:lint i18n-generated-fresh` would then go red on the edit rather than
 * on the copy. Point at the source instead.
 */
function generatedNote(relPath) {
  return relPath.endsWith('.g.ts')
    ? ' [GENERATED: edit i18n/desktop/*.json, then `node scripts/i18n/gen-desktop-ts.mjs`]'
    : '';
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function emDashPer1000(masked) {
  const words = masked.split(/\s+/).filter(Boolean).length;
  const dashes = (masked.match(/—/g) || []).length;
  return { words, dashes, density: words ? (dashes * 1000) / words : 0 };
}

function surfaceOf(relPath) {
  if (!relPath.includes('/') && relPath.endsWith('.md')) {
    if (ROOT_MD_EXCLUDED.has(relPath)) return null;
    return CONTRIB_FILES.has(relPath) ? 'contrib' : 'readme';
  }
  if (APP_FILES.includes(relPath)) return 'app';
  if (APP_DIRS.some((d) => relPath.startsWith(d)) && relPath.endsWith('.dart')) return 'app';
  return null;
}

export default async function outwardVoice() {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return { status: 'SKIP', detail: 'git ls-files unavailable — not a git checkout, or git is missing' };
  }

  const files = tracked.map((p) => ({ rel: p, surface: surfaceOf(p) })).filter((f) => f.surface);
  if (files.length === 0) {
    // git answered but the routing named nothing: the ruler is broken, not the
    // tree. Failing loudly beats reporting "0 hits" from a scan of no files.
    return { status: 'FAIL', detail: 'surface routing matched 0 tracked files — the routing is broken, not the copy' };
  }

  const findings = [];
  const hits = new Map(); // `${rel}|${term}` -> count
  const allowUsed = new Set(); // `${term}|${allowIndex}`
  const density = [];
  let controlHits = 0;
  let scannedChars = 0;

  for (const { rel: relPath, surface } of files) {
    const text = await readText(path.join(ROOT, relPath));
    if (text == null) continue;
    const copy = maskFor(relPath, text);
    // Prose wraps, and a sentence shape does not stop being one because the
    // author hit Enter. Measured: "if that file and this table\never disagree"
    // sat unmatched by the disagree pattern purely because `.` does not cross a
    // newline. Scanning is done on a newline-flattened copy of the SAME LENGTH,
    // so every reported line number still comes from the real text.
    const flat = copy.replace(/\n/g, ' ');
    scannedChars += copy.replace(/\s/g, '').length;
    controlHits += (copy.match(new RegExp(CONTROL_STRING, 'g')) || []).length;
    if (relPath.endsWith('.md')) density.push({ rel: relPath, ...emDashPer1000(copy) });

    for (const entry of BANNED) {
      // Amendment M2: contributor documents are exempt from vocabulary only.
      if (surface === 'contrib') continue;
      if (!entry.surfaces.includes(surface)) continue;
      const re = termRegex(entry);
      for (let m; (m = re.exec(flat)); ) {
        const context = flat.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
        const waiver = (entry.allow || []).findIndex((a) => a.re.test(context));
        if (waiver >= 0) { allowUsed.add(`${entry.term}|${waiver}`); continue; }
        const key = `${relPath}|${entry.term}`;
        hits.set(key, (hits.get(key) || 0) + 1);
        const pin = KNOWN_HITS.find((k) => k.file === relPath && k.term === entry.term);
        if (!pin) {
          findings.push(
            `${relPath}:${lineAt(copy, m.index)}: "${m[0]}" on the ${surface} surface — ${entry.why}${generatedNote(relPath)}`
          );
        }
      }
    }

    for (const meta of META_PATTERNS) {
      const re = new RegExp(meta.re.source, `${meta.re.flags.replace('g', '')}g`);
      for (let m; (m = re.exec(flat)); ) {
        findings.push(`${relPath}:${lineAt(copy, m.index)}: meta-statement "${m[0].trim()}" — ${meta.why}`);
      }
    }
  }

  // Pins: exact counts, and a pin that matches nothing is deleted, not left.
  for (const pin of KNOWN_HITS) {
    const seen = hits.get(`${pin.file}|${pin.term}`) || 0;
    if (seen === pin.count) continue;
    findings.push(
      seen === 0
        ? `${pin.file}: pinned "${pin.term}" x${pin.count} matches nothing now — the card landed, delete this pin from outward-voice-baseline.mjs`
        : `${pin.file}: "${pin.term}" occurs ${seen} time(s), pinned at ${pin.count} — `
          + (seen > pin.count ? 'a new one was added' : 'part of it was fixed; lower or delete the pin')
    );
  }

  // Waivers rot the same way pins do — but only a waiver this gate could
  // possibly have exercised. `site` and `console` are in the web repository, so
  // a waiver on a term routed only there would be reported stale on the day it
  // was written, and the message would tell the author to delete a correct
  // waiver. "Nothing left to waive" and "nothing here to waive" are two
  // answers; no-cjk's ratchet learned the same distinction the hard way.
  for (const entry of BANNED) {
    const reachable = entry.surfaces.some((s) => SCANNABLE_SURFACES.has(s));
    if (!reachable) continue;
    (entry.allow || []).forEach((a, idx) => {
      if (!allowUsed.has(`${entry.term}|${idx}`)) {
        findings.push(`"${entry.term}" carries an allow for ${a.re} that matched nothing — stale, delete it from outward-voice-terms.mjs`);
      }
    });
  }

  const banned = [...hits.values()].reduce((a, b) => a + b, 0);
  if (banned === 0 && controlHits === 0) {
    // Two verdicts, opposite actions. "Nothing banned was found" and "the
    // scanner read nothing" print the same zero, and the fix for one is to
    // celebrate while the fix for the other is to repair the masker.
    return {
      status: 'FAIL',
      detail:
        `blind scan: 0 banned terms AND 0 occurrences of the control string "${CONTROL_STRING}" across `
        + `${files.length} file(s). Those are two different verdicts with opposite actions — this one says `
        + 'the masker or the routing is broken, NOT that the copy is clean. Fix the scanner, do not relax the list.',
    };
  }

  if (findings.length > 0) {
    const shown = findings.slice(0, 8);
    return {
      status: 'FAIL',
      detail:
        `${findings.length} issue(s)${findings.length > shown.length ? ` (first ${shown.length} shown)` : ''}: `
        + shown.join(' | '),
    };
  }

  density.sort((a, b) => b.density - a.density);
  const cadence = density
    .map((d) => `${d.rel} ${d.density.toFixed(1)}`)
    .join(', ');
  const over = density.filter((d) => d.density > EM_DASH_PER_1000_REFERENCE).length;
  const pinned = KNOWN_HITS.reduce((a, k) => a + k.count, 0);

  return {
    status: 'PASS',
    detail:
      `${files.length} outward file(s) scanned, ${scannedChars} non-space char(s) of copy, `
      + `control "${CONTROL_STRING}" x${controlHits} (scanner awake); `
      + `${pinned} pinned occurrence(s) in ${KNOWN_HITS.length} pin(s), 0 new. `
      + `Em-dashes per 1,000 words, PRINTED NOT ENFORCED (ruling D7), reference ${EM_DASH_PER_1000_REFERENCE}, `
      + `${over} file(s) over it: ${cadence}. `
      + 'DOES NOT DECIDE whether a sentence is preachy, parallel, hype, or written from the visitor\'s point of view — see file header',
  };
}
