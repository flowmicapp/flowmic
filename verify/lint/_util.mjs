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

/**
 * Strip `//` line comments and `/* *\/` block comments from JS/TS source
 * WITHOUT corrupting string literals that contain `//` (e.g. `'https://…'`)
 * or comment-like sequences inside template literals.
 *
 * Comment characters become spaces; newlines are kept so line numbers stay
 * stable for scanners that still report positions. Dependency-free state
 * machine (code / line / block / quotes / template / `${…}` expression).
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

  while (i < n) {
    const ctx = stack[stack.length - 1];
    const c = src[i];
    const n1 = i + 1 < n ? src[i + 1] : '';

    if (ctx === 'code' || ctx === 'expr') {
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
          i++;
          continue;
        }
        if (c === '}') {
          stack.pop();
          out += c;
          i++;
          continue;
        }
      }
      out += c;
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
      if (c === q) stack.pop();
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
        i++;
        continue;
      }
      if (c === '$' && n1 === '{') {
        out += '{';
        stack.push('expr');
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
