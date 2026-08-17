#!/usr/bin/env node
// C10-4 — a receipt for a green `pnpm verify:delivery`, so the next consumer of
// that proof can decide whether it is still the truth instead of re-deriving it.
//
// THE PROBLEM, MEASURED (release-friction ledger §1): `scripts/publish.mjs` runs
// the full gate as its GATE 0, and the deploy path (deploy/delivery_gate.py, in
// the sibling web repo) runs it again. On 0.3.6 the chain ran end to end three
// times at ~184s each, twice on a tree that had not changed a byte since the
// previous green run. That is six to ten minutes per round spent proving
// something already proved.
//
// 🔴 WHY THIS IS NOT A CACHE, AND WHY THE DISTINCTION IS THE WHOLE FILE.
// A cache answers "have I seen this before". A receipt answers "is the proof I
// am holding a proof about THIS tree, made recently, by THIS toolchain" — and
// says so out loud, every time it is used. This repo's most expensive recurring
// defect is a filtered green that is indistinguishable from a real one, so:
//
//   · ALL FOUR conditions must hold — HEAD sha, working-tree fingerprint,
//     toolchain versions, and age. Any one failing means the full gate runs.
//     There is no "mostly matches".
//   · Reuse is ANNOUNCED, loudly, naming the minute the proof was made. A
//     silent skip would make a reused proof and a fresh one look identical on
//     screen, which is the exact shape this repo keeps paying for.
//   · There is no FLAG that forges a receipt, and the honest boundary of that
//     sentence is stated rather than implied. The writer is the last link of the
//     `verify:delivery` chain and `&&` is what gets it there, so a receipt is
//     normally unforgeable by construction. What `&&` cannot prevent is somebody
//     typing `verify:preflight` and `verify:receipt` by hand with nothing in
//     between — so `--end` also refuses to write when less than MIN_GATE_MS
//     elapsed since `--begin`. That is a HEURISTIC, not a proof: it makes the
//     accidental and the lazy case impossible (the measured chain is minutes)
//     while leaving a determined hand-forgery possible, exactly as deleting the
//     gate call in publish.mjs is possible. Both are visible, deliberate acts.
//
// 🔴 THE MID-RUN EDIT HOLE, AND WHY THERE ARE TWO FILES.
// A receipt written at the END, fingerprinting the tree at the END, would
// certify a state that was never fully tested: edit a file at minute two of a
// three-minute run and the last stages saw new bytes while the first saw old
// ones, yet the fingerprint would look consistent. So the chain writes a
// PENDING marker in its first second (`--begin`, fingerprint of the tree the
// run is about to test) and the receipt in its last (`--end`, which refuses to
// write anything unless the tree still fingerprints identically). A tree that
// moved during its own gate run simply gets no receipt — the run is still green,
// it is just not reusable, which is the honest answer.
//
// ⚠️ WHAT A VALID RECEIPT STILL DOES NOT PROVE, written down rather than
// discovered later. The fingerprint covers git's answer to "what is different
// from HEAD" — tracked changes plus untracked, non-ignored files. It does NOT
// cover `node_modules/` (a `pnpm install` between the gate and the publish is
// invisible to it), nor gitignored build outputs like `packages/protocol/dist`
// or the staged sidecar payload. The toolchain readings catch the coarsest form
// of that (a different cargo/node/pnpm/flutter), and the age window bounds the
// rest. If you have just reinstalled dependencies, delete the receipt or let it
// age out; the writer will not know.
//
// Usage:
//   node scripts/gate-receipt.mjs --begin    # first link of verify:delivery
//   node scripts/gate-receipt.mjs --end      # last link of verify:delivery
//   node scripts/gate-receipt.mjs --status   # read-only: is there a usable proof?

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeTools } from './preflight-toolchain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

/** `.local/` is gitignored and every whole-repo walker in verify/ prunes it, so
 *  a receipt can never become an input to a lint, an export, or a publish
 *  artifact. It is also per-clone, which is correct: a proof is about the tree
 *  on THIS disk. */
export const RECEIPT_DIR = join(REPO_ROOT, '.local');

/** 🔴 THE DIRECTORY IS A PARAMETER, and it is not a convenience.
 *  The drill for this module originally wrote to the constants below while
 *  claiming to work in a temporary repo, and MEASURED on the first full chain
 *  run afterwards: `verify:scripts` runs that drill in the MIDDLE of
 *  `verify:delivery`, so it deleted the live run's pending marker and the real
 *  gate — 25 lints, 2729 phone tests, everything — finished green and produced
 *  NO receipt. A test that reaches outside its sandbox does not merely risk a
 *  false result; here it silently removed the feature it was testing. */
export const receiptPathIn = (dir) => join(dir, 'gate-receipt.json');
export const pendingPathIn = (dir) => join(dir, 'gate-receipt.pending.json');
export const RECEIPT_PATH = receiptPathIn(RECEIPT_DIR);
export const PENDING_PATH = pendingPathIn(RECEIPT_DIR);

/** Bumped whenever the fingerprint recipe changes. An older receipt then fails
 *  to validate rather than being compared under new rules — a proof made by a
 *  mechanism that no longer exists is not a proof. */
export const RECEIPT_VERSION = 1;

/** How long a proof stays usable. Deliberately a constant with no env override:
 *  an env var that lengthens the window is a bypass nobody would see in a diff,
 *  and this repo's standing position on gate bypasses is that they must be
 *  visible as code. Two hours is longer than a build+publish round and shorter
 *  than a working session, so an overnight tree never reuses yesterday's proof. */
export const MAX_AGE_MS = 120 * 60 * 1000;

/** Below this, `--end` refuses to write: nothing that finished in under a minute
 *  was the delivery chain. Measured on 0.3.6, a full `verify:delivery` is ~184s,
 *  and its cheapest single stage (lint) is already ~4s — so this floor cannot
 *  reject a real run, and it does reject the `--begin` + `--end` pair typed by
 *  hand. Named as a heuristic in the header, because that is what it is. */
export const MIN_GATE_MS = 60 * 1000;

/** Fingerprinting stops rather than guessing past these. Both failures produce
 *  "no receipt" (full gate next time), never "receipt anyway". */
const MAX_DIRTY_FILES = 2000;
const MAX_DIRTY_BYTES = 64 * 1024 * 1024;

const git = (args, cwd = REPO_ROOT) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export function headSha(root = REPO_ROOT) {
  try {
    return git(['rev-parse', 'HEAD'], root).trim();
  } catch {
    return null;
  }
}

/**
 * Every path git considers different from HEAD, one per entry.
 *
 * `-z` for the same reason the exporter uses it: with the default core.quotePath
 * a non-ASCII path comes back wrapped in quotes with octal escapes, and this
 * repo has Chinese-named files. A quoted path would hash as a name that is not
 * on disk, so the file's CONTENT would never enter the fingerprint — a dirty
 * file that changes nothing measurable is precisely the hole worth avoiding.
 *
 * Ignored files are absent by git's default, which is what makes this cheap:
 * node_modules/, target/, publish/ and .local/ never appear.
 */
export function dirtyPaths(root = REPO_ROOT) {
  const raw = git(['status', '--porcelain', '-z'], root);
  const out = [];
  // -z format: `XY <path>\0`, and for renames `R  <new>\0<old>\0`. Splitting on
  // NUL and stripping the 3-char status prefix handles both; the extra old-name
  // record for a rename simply has no prefix, and is taken as a path too, which
  // is the safe direction (it hashes to "absent" and still varies with state).
  for (const rec of raw.split('\0')) {
    if (!rec) continue;
    const p = /^[ MADRCU?!]{2} /.test(rec) ? rec.slice(3) : rec;
    if (p) out.push(p);
  }
  return out;
}

function hashFileInto(h, root, rel, budget) {
  const abs = join(root, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    h.update(`${rel}\0absent\0`);
    return;
  }
  if (st.isDirectory()) {
    // An untracked DIRECTORY is one `??` entry covering an unknown number of
    // files. Walk it so editing a file inside it changes the fingerprint —
    // otherwise a whole untracked tree would be summarised by its name alone.
    for (const name of readdirSync(abs).sort()) hashFileInto(h, root, `${rel}/${name}`, budget);
    return;
  }
  budget.files += 1;
  budget.bytes += st.size;
  if (budget.files > MAX_DIRTY_FILES || budget.bytes > MAX_DIRTY_BYTES) {
    budget.exceeded = true;
    return;
  }
  h.update(`${rel}\0${st.size}\0`);
  h.update(readFileSync(abs));
}

/**
 * sha256 over (HEAD sha, then every dirty path and its bytes, sorted).
 *
 * Content, not mtime: a checkout that restores a file to identical bytes must
 * fingerprint identically, and a touch that changes nothing must not invalidate
 * a proof. Returns null when the tree cannot be fingerprinted within budget —
 * the caller's only correct response to that is to write no receipt.
 */
export function fingerprint(root = REPO_ROOT) {
  const sha = headSha(root);
  if (sha == null) return null;
  let paths;
  try {
    paths = dirtyPaths(root).sort();
  } catch {
    return null;
  }
  const h = createHash('sha256');
  h.update(`head\0${sha}\0`);
  const budget = { files: 0, bytes: 0, exceeded: false };
  for (const p of paths) hashFileInto(h, root, p, budget);
  if (budget.exceeded) return null;
  return { sha, digest: h.digest('hex'), dirtyCount: paths.length };
}

/** Tool readings as `id@version` strings — the shape compared at read time.
 *  A tool that cannot be probed becomes `id@MISSING`, which can never equal a
 *  successful reading, so a toolchain that broke since the gate ran refuses
 *  reuse instead of silently matching. */
export function toolStamp(results = probeTools()) {
  return results.map((r) => `${r.id}@${r.ok ? r.version : 'MISSING'}`).sort();
}

function readJsonOrNull(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function begin({ root = REPO_ROOT, now = Date.now(), dir = RECEIPT_DIR } = {}) {
  const receiptPath = receiptPathIn(dir);
  const pendingPath = pendingPathIn(dir);
  // A stale receipt must not survive the start of a new run: from this moment
  // the tree is being re-proved, and a leftover proof from before would be
  // available to a concurrent publish that has no idea a gate is mid-flight.
  try {
    if (existsSync(receiptPath)) unlinkSync(receiptPath);
  } catch { /* best effort — a receipt that cannot be removed simply ages out */ }

  const fp = fingerprint(root);
  if (fp == null) {
    console.log('· gate receipt: tree could not be fingerprinted (too many/large uncommitted files, or git unavailable) — this run will produce no reusable proof.');
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(pendingPath, `${JSON.stringify({
    version: RECEIPT_VERSION, sha: fp.sha, digest: fp.digest, dirtyCount: fp.dirtyCount, startedAt: now,
  }, null, 2)}\n`);
  return 0;
}

export function end({ root = REPO_ROOT, now = Date.now(), dir = RECEIPT_DIR } = {}) {
  const receiptPath = receiptPathIn(dir);
  const pendingPath = pendingPathIn(dir);
  const pending = readJsonOrNull(pendingPath);
  if (!pending || pending.version !== RECEIPT_VERSION) {
    console.log('· gate receipt: no matching --begin marker for this run — no proof written (run the whole `pnpm verify:delivery` chain to get one).');
    return 0;
  }
  const fp = fingerprint(root);
  if (fp == null) {
    console.log('· gate receipt: tree could not be fingerprinted at the end of the run — no proof written.');
    return 0;
  }
  if (fp.sha !== pending.sha || fp.digest !== pending.digest) {
    // The honest outcome, and the reason --begin exists at all.
    console.log('· gate receipt: the working tree CHANGED during this gate run — no proof written.');
    console.log('  The run itself is still green; it is simply not a proof about any single state of the tree.');
    return 0;
  }
  const elapsed = now - Number(pending.startedAt ?? 0);
  if (!(elapsed >= MIN_GATE_MS)) {
    console.log(`· gate receipt: only ${Math.round(elapsed / 1000)}s elapsed since --begin — no proof written.`);
    console.log(`  Nothing that finished in under ${Math.round(MIN_GATE_MS / 1000)}s was \`pnpm verify:delivery\`, so this would`);
    console.log('  have been a receipt for a run that did not happen. Run the whole chain.');
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify({
    version: RECEIPT_VERSION,
    sha: fp.sha,
    digest: fp.digest,
    dirtyCount: fp.dirtyCount,
    tools: toolStamp(),
    startedAt: pending.startedAt,
    finishedAt: now,
  }, null, 2)}\n`);
  try {
    unlinkSync(pendingPath);
  } catch { /* the pending marker is superseded either way */ }
  console.log(`✓ gate receipt written for ${fp.sha.slice(0, 12)} (${fp.dirtyCount} uncommitted path(s)) — publish may reuse it for the next ${Math.round(MAX_AGE_MS / 60000)} minutes.`);
  return 0;
}

/**
 * Read the receipt and decide whether it may stand in for a fresh gate run.
 * Returns `{ ok, receipt, reason, ageMs }` — `reason` is written for a human
 * reading a publish log, so it always names WHICH condition failed rather than
 * "invalid".
 */
export function readValidReceipt({ root = REPO_ROOT, now = Date.now(), tools = null, dir = RECEIPT_DIR } = {}) {
  const receipt = readJsonOrNull(receiptPathIn(dir));
  if (!receipt) return { ok: false, reason: 'no receipt on disk' };
  if (receipt.version !== RECEIPT_VERSION) {
    return { ok: false, receipt, reason: `receipt format v${receipt.version} predates the current recipe (v${RECEIPT_VERSION})` };
  }
  const ageMs = now - Number(receipt.finishedAt ?? 0);
  if (!(ageMs >= 0) || ageMs > MAX_AGE_MS) {
    return { ok: false, receipt, ageMs, reason: `receipt is ${Math.round(ageMs / 60000)} min old (limit ${Math.round(MAX_AGE_MS / 60000)} min)` };
  }
  const fp = fingerprint(root);
  if (fp == null) return { ok: false, receipt, ageMs, reason: 'working tree cannot be fingerprinted now' };
  if (fp.sha !== receipt.sha) {
    return { ok: false, receipt, ageMs, reason: `HEAD moved (${receipt.sha.slice(0, 12)} → ${fp.sha.slice(0, 12)})` };
  }
  if (fp.digest !== receipt.digest) {
    return { ok: false, receipt, ageMs, reason: 'working tree changed since the gate ran' };
  }
  const nowTools = tools ?? toolStamp();
  const want = (receipt.tools ?? []).join('|');
  if (want !== nowTools.join('|')) {
    return { ok: false, receipt, ageMs, reason: `toolchain changed since the gate ran (${want || '(none recorded)'} → ${nowTools.join('|')})` };
  }
  return { ok: true, receipt, ageMs };
}

/** The banner publish/deploy prints INSTEAD of a gate run. It is deliberately
 *  as loud as the gate's own heading: the operator must never have to look
 *  twice to tell a reused proof from a fresh one. */
export function reuseBanner(result) {
  const made = new Date(result.receipt.finishedAt);
  const hh = String(made.getHours()).padStart(2, '0');
  const mm = String(made.getMinutes()).padStart(2, '0');
  return [
    '── REUSING A GATE PROOF — verify:delivery is NOT being run now ──────────',
    `   proved at ${hh}:${mm} (${Math.round(result.ageMs / 60000)} min ago) for HEAD ${result.receipt.sha.slice(0, 12)}`,
    `   same HEAD, same working tree (${result.receipt.dirtyCount} uncommitted path(s)), same toolchain, inside the ${Math.round(MAX_AGE_MS / 60000)}-minute window`,
    '   To force a fresh run: delete .local/gate-receipt.json (or change anything in the tree).',
    '────────────────────────────────────────────────────────────────────────',
  ].join('\n');
}

export function status({ root = REPO_ROOT, now = Date.now(), dir = RECEIPT_DIR } = {}) {
  const r = readValidReceipt({ root, now, dir });
  if (r.ok) {
    console.log(reuseBanner(r));
    return 0;
  }
  console.log(`· no usable gate proof: ${r.reason}`);
  console.log('  Next publish/deploy will run the full `pnpm verify:delivery`.');
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--begin')) return begin();
  if (argv.includes('--end')) return end();
  if (argv.includes('--status')) return status();
  console.error('usage: node scripts/gate-receipt.mjs --begin | --end | --status');
  return 1;
}

const invokedDirectly = process.argv[1] != null
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main());
