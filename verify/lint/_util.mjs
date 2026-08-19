// verify/lint/_util.mjs
// Shared helpers for the 9-lint suite. Pure node stdlib, no deps.
//
// Contract for lint modules: each exports `name` (string) and a default
// async `run()` returning { status: 'PASS'|'SKIP'|'FAIL', detail: string }.
// run-all.mjs times each and formats `STATUS name (ms) detail`.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // <root>/verify/lint
export const ROOT = path.resolve(here, '..', '..');

// Directories pruned in every walk (by basename, at any depth).
export const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build', // Vite/Flutter build output (gitignored)
  'target', // Rust build output (gitignored) — dependency build-script .rs
  '.dart_tool', // Flutter tool cache (gitignored)
  '.local', // gitignored local keystore/secrets — never scanned
  'publish', // gitignored release staging (scripts/publish.mjs) — copies of
  // already-built artifacts (MSI/APK/exe + the esbuild sidecar bundle), so
  // linting them would just re-report the source files they were built from.
  '.playwright-mcp',
  // Session-local AI tooling state: zero tracked files (git ls-files .claude
  // is empty; .claude/worktrees/ sits in .git/info/exclude), and worktrees/*
  // are FULL CHECKOUTS of this repo minted by concurrent agent sessions.
  // Walking them double-scans the whole tree with someone else's in-flight
  // state — measured twice on 2026-08-11 before this line existed:
  // no-cloud-keys went red on a worktree's copy of its own fingerprint table,
  // then file-size went red on a worktree's 44k-line sidecar build artifact.
  // Every whole-repo walker inherits this skip; do not re-fix it lint by lint.
  '.claude',
]);

// Binary file extensions skipped before any text read (fast + safe).
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.icns', '.webp', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.mov', '.webm',
  '.onnx', '.bin', '.dll', '.exe', '.so', '.dylib', '.node', '.wasm',
  '.jks', '.keystore', '.jar', '.class', '.zip', '.gz', '.tar', '.7z', '.pdf',
]);

const MAX_TEXT_BYTES = 2_000_000; // skip anything larger from text scans

export function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

// Recursively collect absolute file paths under `startAbs`.
// opts.skipDir(basename, relPath) -> prune a directory (default: DEFAULT_SKIP_DIRS).
export async function walk(startAbs, opts = {}) {
  const skipDir = opts.skipDir || ((name) => DEFAULT_SKIP_DIRS.has(name));
  const out = [];
  async function rec(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDir(e.name, rel(abs))) continue;
        await rec(abs);
      } else if (e.isFile()) {
        out.push(abs);
      }
    }
  }
  await rec(startAbs);
  return out;
}

// Read a file as UTF-8 text, or return null when it is binary / too large /
// unreadable. Binary is detected by extension first, then a NUL-byte probe.
export async function readText(abs) {
  const ext = path.extname(abs).toLowerCase();
  if (BINARY_EXT.has(ext)) return null;
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return null;
  }
  if (stat.size > MAX_TEXT_BYTES) return null;
  let buf;
  try {
    buf = await fsp.readFile(abs);
  } catch {
    return null;
  }
  if (buf.subarray(0, 8192).includes(0)) return null; // NUL byte -> binary
  return buf.toString('utf8');
}

export async function exists(abs) {
  try {
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function isFile(abs) {
  try {
    return (await fsp.stat(abs)).isFile();
  } catch {
    return false;
  }
}

export async function readJson(abs) {
  const txt = await readText(abs);
  if (txt == null) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

// Split a text file into 1-based line objects lazily where useful.
export function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// wc -l semantics: number of newline characters, +1 if the final line has content.
export function countLines(text) {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.charCodeAt(text.length - 1) !== 10) n++;
  return n;
}


// --- stripJsComments -------------------------------------------------------
//
// Lexical contexts: code / line / block / squote / dquote / template /
// `${…}` expr / regex. Comment characters become spaces; newlines are kept so
// line numbers stay stable for scanners that still report positions.
//
// 🔴 REGEX LITERALS (added 2026-08-19). Without them the state machine is not
// merely imprecise, it DESYNCHRONISES: a regex holding an odd number of quote
// characters — e.g. the versionName matcher that is real code in
// scripts/publish-apk-gates.mjs — opens a string context that never closes, and
// from that point on EVERY comment in the file survives stripping. Downstream
// that is a false green in the exact direction the callers exist to prevent
// (verify/lint/module-reachability.mjs counts a commented-out import as a live
// edge). Pinned by scripts/strip-js-comments.test.mjs.
//
// THE RULE — "is this `/` a regex or a division?" — decided by the PREVIOUS
// SIGNIFICANT TOKEN (last non-whitespace character emitted as code; comments
// become whitespace, so `a = /*c*/ /re/` still sees `=`):
//
//   - nothing (start of source)                          -> REGEX
//   - `++` or `--` (i.e. `x++ / y`)                       -> division
//   - identifier / digit / `_` / `$`                      -> division, UNLESS
//     the trailing word is one of RE_OK_KEYWORDS and it is not preceded by `.`
//     (so `return /re/` is a regex but `a.return / 2` is division)
//   - `)`  `]`  `'`  `"`  backtick  `.`                   -> division
//   - anything else (`( , ; : = ! & | ? + - * / % ^ ~ < > { }`) -> REGEX
//
// A candidate regex that does not close before the end of the line is treated
// as division after all, so a wrong guess can never eat the rest of a file.
// Inside a regex, `\x` escapes and `[...]` character classes are honoured, so
// a slash inside a character class does not terminate it early.
//
// 🔴 KNOWN LIMITS — this is a stripper, NOT a parser. Each of these is pinned
// as a KNOWN LIMIT case in scripts/strip-js-comments.test.mjs so that a green
// run is never read as "this understands JavaScript":
//   1. `)` always means division, so `if (x) /re/.test(s)` has its regex
//      scanned as code — and if that regex holds an odd number of quotes it
//      desynchronises exactly like the original bug. Same for `]`.
//   2. `}` always allows a regex, so a division right after an object literal
//      or a block is misread as a regex start; when a `//` comment follows on
//      the SAME line, the scan closes on that comment's first slash and the
//      comment body survives.
//   3. No ASI and no statement-position awareness at all: the decision is made
//      from one character (plus one word) of lookback, never from grammar.
//   4. Keyword lookback is textual, so an identifier that merely ends in a
//      keyword and is not preceded by `.` can be mistaken for the keyword.
// The blast radius of every limit above is bounded to a single line by the
// unterminated-candidate rule, which is why they are documented rather than
// fixed: fixing them needs a real tokenizer, and that is a different tool.

const RE_OK_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

// Previous significant characters after which a `/` is a division operator.
const DIV_AFTER = new Set([')', ']', "'", '"', '`', '.']);

const isIdentChar = (ch) => ch !== '' && /[A-Za-z0-9_$]/.test(ch);

/**
 * Strip `//` line comments and block comments from JS/TS source WITHOUT
 * corrupting string literals that contain `//` (e.g. an https URL), template
 * literals, or regex literals. See the block comment above for the
 * regex-vs-division rule and its known limits.
 *
 * Shared by source-scanning lints (ADM-P0-1): a mention inside a comment must
 * never satisfy a "must exist in production" assertion.
 */
export function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // Lexical contexts. `expr` = code inside a template `${…}` (brace-nested).
  const stack = ['code'];

  // Previous-significant-token state (maintained for code/expr only).
  let prevSig = ''; // last non-whitespace character emitted as code
  let prevSig2 = ''; // the one before it — only used to spot `++` / `--`
  let word = ''; // trailing identifier run ending at prevSig ('' if none)
  let beforeWord = ''; // significant character immediately before `word` began

  function noteSig(ch) {
    if (ch === '' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return;
    prevSig2 = prevSig;
    prevSig = ch;
    if (isIdentChar(ch)) {
      if (word === '') beforeWord = prevSig2;
      word += ch;
    } else {
      word = '';
      beforeWord = '';
    }
  }

  function regexAllowed() {
    if (prevSig === '') return true; // start of source
    if ((prevSig === '+' && prevSig2 === '+') || (prevSig === '-' && prevSig2 === '-')) {
      return false; // x++ / y
    }
    if (isIdentChar(prevSig)) return RE_OK_KEYWORDS.has(word) && beforeWord !== '.';
    return !DIV_AFTER.has(prevSig);
  }

  // Scan a regex literal whose opening '/' is at `start`. Returns the index
  // just past the closing '/', or -1 when it does not close on this line.
  function scanRegex(start) {
    let j = start + 1;
    let inClass = false;
    while (j < n) {
      const d = src[j];
      if (d === '\\') {
        j += 2;
        continue;
      }
      if (d === '\n') return -1; // unterminated -> it was not a regex
      if (inClass) {
        if (d === ']') inClass = false;
        j++;
        continue;
      }
      if (d === '[') {
        inClass = true;
        j++;
        continue;
      }
      if (d === '/') return j + 1;
      j++;
    }
    return -1;
  }

  while (i < n) {
    const ctx = stack[stack.length - 1];
    const c = src[i];
    const n1 = i + 1 < n ? src[i + 1] : '';

    if (ctx === 'code' || ctx === 'expr') {
      // `//` and `/*` are comments at every position where they could appear:
      // the empty regex must be written `/(?:)/`, so neither can start one.
      if (c === '/' && n1 === '/') {
        stack.push('line');
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && n1 === '*') {
        stack.push('block');
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && regexAllowed()) {
        const end = scanRegex(i);
        if (end !== -1) {
          out += src.slice(i, end);
          // A regex literal is a value, so a `/` after it is a division.
          prevSig2 = '/';
          prevSig = ')';
          word = '';
          beforeWord = '';
          i = end;
          continue;
        }
        // Fall through: treat this '/' as an ordinary operator character.
      }
      if (c === "'") {
        stack.push('squote');
        out += c;
        i++;
        continue;
      }
      if (c === '"') {
        stack.push('dquote');
        out += c;
        i++;
        continue;
      }
      if (c === '`') {
        stack.push('template');
        out += c;
        i++;
        continue;
      }
      if (ctx === 'expr') {
        if (c === '{') {
          stack.push('expr');
          out += c;
          noteSig(c);
          i++;
          continue;
        }
        if (c === '}') {
          stack.pop();
          out += c;
          noteSig(c);
          i++;
          continue;
        }
      }
      out += c;
      noteSig(c);
      i++;
      continue;
    }

    if (ctx === 'line') {
      if (c === '\n') {
        stack.pop();
        out += c;
      } else {
        out += ' ';
      }
      i++;
      continue;
    }

    if (ctx === 'block') {
      if (c === '*' && n1 === '/') {
        stack.pop();
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }

    if (ctx === 'squote' || ctx === 'dquote') {
      const q = ctx === 'squote' ? "'" : '"';
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === q) {
        stack.pop();
        noteSig(q); // a closed string is a value -> the next `/` is division
      }
      i++;
      continue;
    }

    if (ctx === 'template') {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        noteSig('`'); // a closed template is a value -> next `/` is division
        i++;
        continue;
      }
      if (c === '$' && n1 === '{') {
        out += '{';
        stack.push('expr');
        noteSig('{'); // start of an expression -> a `/` here is a regex
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // Unreachable: every pushed context is handled above.
    out += c;
    i++;
  }

  return out;
}
