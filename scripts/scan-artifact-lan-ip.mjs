// scripts/scan-artifact-lan-ip.mjs
// Does a BUILT artifact carry the owner's private ranges?
//
// The source-level question is `verify/lint/no-lan-ip.mjs`'s. This one is
// different and it is the one that actually decides whether a stranger is
// affected: what is in the BYTES we hand out. Those two answers can disagree,
// and when they do the artifact is right —
//
//   · a source file can be clean while a bundler inlines a dependency that is not
//     (the sidecar bundle is server-core + protocol + zod + socket.io in one
//     file, so every preset endpoint in @flowmic/protocol lands in it);
//   · a source file can be dirty in a COMMENT while the artifact is clean,
//     because esbuild drops comments.
//
// 🔴 THE PRECEDENT THIS IS BUILT ON (CLAUDE.md, UP-7, 2026-08-08): the 0.2.59 APK
// shipped with self-update silently tree-shaken out. Every gate was green, the
// build exited 0, and the only thing that would have caught it was reading the
// bytes of the thing that was about to be published — which is what
// `scripts/apk-self-update-marker.mjs` now does. Same shape, same remedy: measure
// the artifact, not the intention.
//
// ✅ WIRED INTO `scripts/publish.mjs` (2026-08-12) — the account below is CLOSED.
// This header used to read "NOT WIRED INTO scripts/publish.mjs … the wiring is an
// OPEN ACCOUNT handed to the release window … an unrun scanner is worth exactly
// as much as an unrun test". It was true when written (card OSS-DEFAULTS was
// forbidden to touch the publisher, W4A §1-bis-1) and it stayed true through one
// release window that ran this by hand and deliberately left the wire undone
// (W6R §1-3, because wiring it as a bare refuse-on-any-hit gate would have been
// red on a CORRECT tree — 「一开始就红的门第二天就会被所有人无视」).
//
// The caller is `scripts/publish-lan-ip-gate.mjs`, imported by publish.mjs as
// GATE 0d. It answers W6R's blocking question (「预设目录里的私网段算不算 ship」)
// by declaring the preset catalogue's occurrences against the exact count
// verify/lint/no-lan-ip.mjs already waives, and refusing everything else — read
// that file's header for the accounting. This module's own exit codes are
// unchanged and it is still runnable by hand.
//
// USAGE
//   node scripts/scan-artifact-lan-ip.mjs [path …]
// With no arguments it scans [DEFAULT_TARGETS] — the artifacts that exist on a
// dev machine after a build. Exit 0 = clean, 1 = hits, 2 = nothing to scan.
//
// 🔴 EXIT 2 IS NOT SUCCESS, and it is spelled differently from exit 0 on purpose.
// A scanner that reports "clean" when it found no files to read is the failure
// mode `apk-self-update-marker.mjs` guards with a control string: "the scan is
// blind" and "the artifact is clean" are two different facts that demand two
// different actions, and collapsing them is how a green light gets shipped.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The two ranges, spelled as the acceptance criterion spells them. Kept as a
 * LITERAL substring search rather than a regex: this file is read as bytes, and a
 * plain `indexOf` cannot be fooled by a regex feature nobody meant to use.
 *
 * ⚠️ Deliberately the same two as verify/lint/no-lan-ip.mjs and NOT a general
 * private-IP rule — `127.0.0.1` and `192.168.1.5` are legitimately in these
 * artifacts (loopback sidecar host, UI placeholder text).
 */
export const RANGES = ['100.64.7.', '10.0.0.'];

/**
 * A CONTROL string: something every one of these artifacts certainly contains.
 * If the control is missing, the scan did not read what it thinks it read (wrong
 * file, wrong encoding, truncated download) and a zero-hit result proves nothing.
 * Straight from the UP-7 lesson — a scan reporting 0 must be able to tell
 * "clean" from "blind", because the two demand opposite actions.
 */
export const CONTROL = 'flowmic';

export const DEFAULT_TARGETS = [
  'apps/desktop/src-tauri/resources/server.js',
  'apps/desktop/dist',
  'publish',
];

/** Extensions that are not text and would only produce mojibake noise. */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.ico', '.icns', '.webp', '.woff', '.woff2', '.ttf', '.otf',
  '.exe', '.dll', '.so', '.dylib', '.node', '.wasm', '.onnx', '.jks', '.keystore',
  '.zip', '.gz', '.7z', '.pdf', '.mp3', '.wav',
]);

function filesUnder(abs, out = []) {
  if (!existsSync(abs)) return out;
  const st = statSync(abs);
  if (st.isFile()) {
    if (!BINARY_EXT.has(path.extname(abs).toLowerCase())) out.push(abs);
    return out;
  }
  if (!st.isDirectory()) return out;
  for (const entry of readdirSync(abs)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    filesUnder(path.join(abs, entry), out);
  }
  return out;
}

/**
 * Scan one blob. Returns `{ hits, control }` — `hits` are `{ range, count }` and
 * `control` says whether the CONTROL string was present.
 *
 * Pure and exported so the test can drive it with fixtures instead of needing a
 * real build to exist.
 */
export function scanBuffer(text) {
  const hits = [];
  for (const range of RANGES) {
    let count = 0;
    for (let i = text.indexOf(range); i !== -1; i = text.indexOf(range, i + range.length)) count++;
    if (count > 0) hits.push({ range, count });
  }
  return { hits, control: text.toLowerCase().includes(CONTROL) };
}

/** Scan the given paths (files or directories). Returns a report object. */
export function scanTargets(targets = DEFAULT_TARGETS, root = ROOT) {
  const files = [];
  for (const t of targets) filesUnder(path.isAbsolute(t) ? t : path.join(root, t), files);

  const findings = [];
  let scanned = 0;
  let controlSeen = 0;
  for (const abs of files) {
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    scanned++;
    const { hits, control } = scanBuffer(text);
    if (control) controlSeen++;
    for (const h of hits) {
      findings.push({ file: path.relative(root, abs).split(path.sep).join('/'), ...h });
    }
  }
  return { scanned, controlSeen, findings };
}

function main(argv) {
  const targets = argv.length > 0 ? argv : DEFAULT_TARGETS;
  const { scanned, controlSeen, findings } = scanTargets(targets);

  if (scanned === 0) {
    process.stderr.write(
      `scan-artifact-lan-ip: NOTHING TO SCAN — none of [${targets.join(', ')}] exist.\n` +
        `  Build first (pnpm --filter @flowmic/desktop build:sidecar), then re-run.\n` +
        `  Exiting 2, NOT 0: "no files found" and "the files are clean" are different facts.\n`,
    );
    return 2;
  }
  if (controlSeen === 0) {
    process.stderr.write(
      `scan-artifact-lan-ip: THE SCAN IS BLIND — read ${scanned} file(s) and not one contained\n` +
        `  the control string '${CONTROL}'. A zero-hit result here would be evidence about the\n` +
        `  scanner, not about the artifact. Check the paths and the encoding.\n`,
    );
    return 2;
  }

  if (findings.length === 0) {
    process.stdout.write(
      `scan-artifact-lan-ip: OK — ${scanned} file(s), control present in ${controlSeen}, ` +
        `0 occurrence(s) of ${RANGES.join(' / ')}\n`,
    );
    return 0;
  }

  const total = findings.reduce((n, f) => n + f.count, 0);
  process.stderr.write(
    `scan-artifact-lan-ip: ${total} occurrence(s) of a private range in built artifacts ` +
      `(${scanned} file(s) scanned):\n`,
  );
  for (const f of findings) process.stderr.write(`  ${f.file}: ${f.count} × ${f.range}\n`);
  process.stderr.write(
    `\n  These bytes ship. A stranger who installs this build gets them.\n` +
      `  Today's known source: the LAN preset catalogue in packages/protocol/src/engine-presets.ts,\n` +
      `  which card OSS-DEFAULTS deliberately did NOT remove (CLAUDE.md 「预设走 presets 包」).\n` +
      `  See the OSS-DEFAULTS report's open accounts before treating this as a regression.\n`,
  );
  return 1;
}

// Only run when invoked directly, so importing this from a test (or one day from
// publish.mjs) does not scan and exit as a side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
