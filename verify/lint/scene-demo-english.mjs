// verify/lint/scene-demo-english.mjs
// The machine gate behind the owner's 2026-08-27 iron rule: the scene-demo
// animations (docs/scene-demo/) are a RECORDING SURFACE — they get screen-
// captured into marketing video and embedded into the public website — and
// their default language is ENGLISH. Chinese is kept, but only inside the
// frozen snapshot docs/scene-demo/zh-archive/ (internal, never released).
//
// Why this is a separate lint instead of extending no-cjk.mjs: no-cjk asks
// "is there untranslated Chinese PROSE on the export surface" and deliberately
// leaves docs/ out of scope. This gate asks a stricter question about a
// narrower surface: "can a single CJK codepoint REACH THE RENDERED FRAME".
// For a demo that ships as pixels, one stray 「已注入」 in a status chip is a
// product defect, not translation debt — so comments are exempt (they never
// render) and everything else fails, with no allowlist and no prose threshold.
//
// ── WHAT IS SCANNED ─────────────────────────────────────────────────────────
// *.html / *.js / *.css under docs/scene-demo/, found by a FILESYSTEM walk —
// deliberately not `git ls-files`: docs/scene-demo/ is gitignored (7cb89f1f
// untracked it as an externally-owned working directory), so the git index
// answers "nothing there" while the recording surface sits right on disk.
// The first wiring of this gate used ls-files and reported "0 file(s)
// scanned, PASS" over a fully-Chinese directory — a blind gate, caught by
// reading its own PASS detail before trusting it (先核你的尺子).
// When the directory is absent (CI clones don't have it), the gate SKIPs.
// Excluded: docs/scene-demo/zh-archive/ (the Chinese snapshot — its whole
// purpose is to contain Chinese) and *.md (README/HANDOFF are internal docs,
// Chinese-allowed per the repo's language discipline).
//
// ── DETECTION ───────────────────────────────────────────────────────────────
// Comments are stripped first (<!-- --> in HTML, /* */ everywhere, // line
// tails not preceded by ':' so https:// URLs survive), then any codepoint in
// the same four CJK ranges no-cjk.mjs scans (Han, Ext-A, CJK punctuation,
// fullwidth forms) fails and names the file and line. Chinese comments are
// legal — the repo does not retro-translate comments — but a Chinese string
// literal, attribute, or text node is exactly what this gate exists to stop.
//
// ── THE ONE INTENTIONAL EXCEPTION: `zh-allowed:` ────────────────────────────
// The Translate scenario demonstrates English → Chinese (owner, 2026-08-27):
// the user speaks casual English and a polished Simplified-Chinese email
// lands in Outlook. That Chinese IS the product story — rendering it is the
// point, so it cannot be a violation. A line that deliberately carries such
// demo content must end with a comment containing the token
// `zh-allowed: <reason>` (e.g. `// zh-allowed: translate-demo output`), and
// the gate skips exactly those lines. The marker lives ON the line it
// excuses — greppable, reviewable in place, and the PASS detail reports how
// many lines used it so a creeping blanket exemption stays visible.
//
// Reverse control, measured 2026-08-27 the day it was wired: run mid-cutover,
// while five of the twelve files were still Chinese, it went red naming each
// file and line; the fully-translated tree turned it green. Not
// green-by-construction — and its first (ls-files-based) wiring was, which is
// why the PASS detail prints the scanned-file count: a PASS that says
// "0 file(s) scanned" is a confession, not a result.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, readText } from './_util.mjs';
import { CJK_RE } from './no-cjk.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'scene-demo-english';

const SCOPE_PREFIX = 'docs/scene-demo/';
const ARCHIVE_PREFIX = 'docs/scene-demo/zh-archive/';
const EXTS = new Set(['.html', '.js', '.css']);

export function inScope(relPath) {
  if (!relPath.startsWith(SCOPE_PREFIX)) return false;
  if (relPath.startsWith(ARCHIVE_PREFIX)) return false;
  return EXTS.has(path.extname(relPath).toLowerCase());
}

/** Strip comment spans so Chinese comments (legal, never rendered) do not
 *  trip a gate about rendered frames. Newlines inside stripped spans are kept
 *  so reported line numbers stay true to the original file. */
export function stripComments(text) {
  const keepLines = (m) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/<!--[\s\S]*?-->/g, keepLines)
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    // '//' line tails, but not '://' (URLs) — the lookbehind spares https://
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** Walk docs/scene-demo on disk (it is gitignored — see header). Returns
 *  repo-relative paths with forward slashes so inScope()'s prefixes match. */
function walkSceneDemo() {
  const rootAbs = path.join(ROOT, 'docs', 'scene-demo');
  if (!existsSync(rootAbs)) return null;
  const out = [];
  const stack = [rootAbs];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(abs); continue; }
      if (ent.isFile()) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

export default async function run() {
  const files = walkSceneDemo();
  if (files === null) {
    return { status: 'SKIP', detail: 'docs/scene-demo/ absent in this tree (gitignored working dir) — nothing to scan' };
  }

  const findings = [];
  let scanned = 0;
  let markedLines = 0;

  for (const relPath of files) {
    if (!inScope(relPath)) continue;
    const text = await readText(path.join(ROOT, relPath));
    if (text == null) continue;
    scanned++;

    // Drop `zh-allowed:`-marked lines BEFORE comment-stripping: the marker is
    // itself a comment, and stripping first would erase the exemption it grants.
    const rawLines = text.split('\n');
    const kept = rawLines.map((l) => (l.includes('zh-allowed:') ? '' : l));
    for (const l of rawLines) if (l.includes('zh-allowed:')) markedLines++;
    const stripped = stripComments(kept.join('\n'));
    const lines = stripped.split('\n');
    for (let n = 0; n < lines.length; n++) {
      if (CJK_RE.test(lines[n])) {
        findings.push(
          `${relPath}:${n + 1}: CJK outside a comment — the demo's default language is English `
            + `(owner iron rule 2026-08-27); translate it, or if it is deliberate translate-demo `
            + `output, mark the line with \`zh-allowed: <reason>\`; archived Chinese belongs in `
            + `docs/scene-demo/zh-archive/`
        );
        break; // one finding per file is enough to act on
      }
    }
  }

  // The archive must keep existing: "Chinese is kept" is half of the ruling,
  // and a cleanup pass that deletes zh-archive/ would silently break it.
  // Checked on the filesystem, not via git ls-files: the working tree is what
  // "kept" means, and this also keeps the gate honest before first commit.
  const archivePresent = existsSync(path.join(ROOT, ARCHIVE_PREFIX, 'README.md'));
  if (scanned > 0 && !archivePresent) {
    findings.push(
      `${ARCHIVE_PREFIX}: missing — the Chinese snapshot is part of the 2026-08-27 ruling `
        + `(kept internally, never released); restore it or record a new owner ruling`
    );
  }

  if (findings.length > 0) {
    return { status: 'FAIL', detail: `${findings.length} issue(s): ${findings.slice(0, 6).join('; ')}` };
  }
  return {
    status: 'PASS',
    detail: `${scanned} file(s) scanned, 0 CJK outside comments `
      + `(${markedLines} zh-allowed line(s)); zh-archive present`,
  };
}
