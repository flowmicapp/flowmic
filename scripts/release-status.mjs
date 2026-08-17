#!/usr/bin/env node
// C10-5 — "where is this round up to, and what is the next command?"
//
// 🔴🔴 READ-ONLY. It runs no build, writes no file, uploads nothing, and opens
// no network connection. Every line it prints is derived from what is already
// on this disk. That constraint is the feature: the reason nobody asks the
// release chain where it is up to is that asking has always meant RUNNING
// something, and running the next step is exactly what you must not do when you
// are unsure which step is next.
//
// THE MEASURED PROBLEM (release-friction ledger §1 row 6). On 0.3.6 the publish
// run refused because the live update manifest still announced the previous
// version. That refusal was CORRECT — it is the definition of "the release is
// not finished" — but it was discovered by walking into it, minutes into a run,
// after the artefacts were already built and uploaded. Nothing was wrong except
// that the order of the remaining work lived in somebody's memory.
//
// 🔴 WHAT IT CANNOT ANSWER, AND WHY IT SAYS SO RATHER THAN GUESSING. Three of
// the steps below are facts about a SERVER, not about this disk: whether the LAN
// download center has these bytes, whether the public update endpoint announces
// this version, and whether the public GitHub release exists. A read-only tool
// could technically fetch them, and it deliberately does not — a status command
// that sometimes hangs on a network is a status command people stop running, and
// a step whose real check is a script in this repo should be reported by NAMING
// that script rather than by half-reimplementing it. Those rows print
// UNKNOWN plus the exact command that answers them. An honest unknown is worth
// more than a guess dressed as a check.
//
// Usage: node scripts/release-status.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { portableZipName } from './pack-portable.mjs';
import { readValidReceipt, MAX_AGE_MS } from './gate-receipt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
const PUBLISH_DIR = join(REPO_ROOT, 'publish');

export const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;

/** DONE / TODO / UNKNOWN — three states, never two. Collapsing UNKNOWN into
 *  TODO would tell someone to redo a step that may well be finished; collapsing
 *  it into DONE is the failure this whole repo is organised around. */
export const DONE = 'DONE';
export const TODO = 'TODO';
export const UNKNOWN = 'UNKNOWN';

/**
 * The CHANGELOG section matcher, in the SAME shape
 * scripts/publish-download-center.mjs uses: split on `## `, accept a heading
 * that mentions this version among others ("## 0.3.6 (with 0.3.5)" is a real,
 * supported spelling). Restated here rather than imported because that module is
 * excluded from the open-source export and importing it would drag this one out
 * with it; the coupling is named instead, so a change there has a place to look.
 */
export function changelogSection(version = VERSION, root = REPO_ROOT) {
  let log;
  try {
    log = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  } catch {
    return null;
  }
  const hit = new RegExp(`(^|[^0-9.])${version.replace(/\./g, '\\.')}([^0-9.]|$)`);
  for (const chunk of log.split(/^## /m).slice(1)) {
    const nl = chunk.indexOf('\n');
    const title = chunk.slice(0, nl).trim();
    if (hit.test(title)) return title;
  }
  return null;
}

function publishEntries() {
  try {
    return readdirSync(PUBLISH_DIR);
  } catch {
    return null;
  }
}

/** Artefacts publish.mjs stages, named the way it names them so a filename can
 *  never disagree with what is inside it. */
export function artefactRows(version = VERSION) {
  const entries = publishEntries();
  const has = (pred) => (entries ?? []).some(pred);
  const msi = (entries ?? []).filter((f) => f.endsWith('.msi') && f.includes(version));
  return [
    {
      id: 'msi',
      label: `installers (2 x .msi @ ${version})`,
      state: msi.length >= 2 ? DONE : TODO,
      detail: entries == null ? 'publish/ does not exist' : `${msi.length} found`,
      next: 'pnpm --filter @flowmic/desktop tauri:build && node scripts/publish.mjs',
    },
    {
      id: 'apk',
      label: `Android APK (FlowMic-${version}-release.apk)`,
      state: has((f) => f === `FlowMic-${version}-release.apk`) ? DONE : TODO,
      detail: 'staged into publish/ only if the bytes carry the self-update marker',
      next: 'make -C apps/mobile release && node scripts/publish.mjs',
    },
    {
      id: 'portable',
      label: `portable archive (${portableZipName(version)})`,
      state: has((f) => f === portableZipName(version)) ? DONE : TODO,
      detail: 'the distributable form of publish/FlowMic-portable/',
      next: 'node scripts/publish.mjs',
    },
    {
      id: 'manifest',
      label: 'update-manifest.json staged locally',
      state: has((f) => f === 'update-manifest.json') ? DONE : TODO,
      detail: 'written from publish/ AFTER the download-center upload (artifacts first, then manifest)',
      next: 'node scripts/build-update-manifest.mjs',
    },
  ];
}

export async function rows() {
  const out = [];

  // ① Version faces. Reuses the lint that owns this question rather than
  // re-deriving it: version-sync discovers the faces by walking, and a second
  // hand-kept list here would be the drift this repo names on that very lint.
  let versionRow;
  try {
    const versionSync = (await import('../verify/lint/version-sync.mjs')).default;
    const r = await versionSync();
    versionRow = {
      id: 'version', label: `version faces all at ${VERSION}`,
      state: r.status === 'PASS' ? DONE : TODO, detail: r.detail,
      next: `node scripts/bump-version.mjs <x.y.z>   # then re-run`,
    };
  } catch (err) {
    versionRow = {
      id: 'version', label: 'version faces all in step',
      state: UNKNOWN, detail: `version-sync lint could not run: ${err?.message ?? err}`,
      next: 'pnpm verify:lint',
    };
  }
  out.push(versionRow);

  // ② CHANGELOG. publish-download-center REFUSES without this section, so it is
  // a hard prerequisite of publishing, not a nicety.
  const section = changelogSection();
  out.push({
    id: 'changelog',
    label: `CHANGELOG.md has a ${VERSION} section`,
    state: section ? DONE : TODO,
    detail: section ? `"${section}"` : 'the download center requires it as the release description',
    next: `write the user-visible changes under a "## ${VERSION}" heading in CHANGELOG.md`,
  });

  // ③ A green gate, and whether its proof is still usable.
  const proof = readValidReceipt();
  out.push({
    id: 'gate',
    label: 'verify:delivery proved for this exact tree',
    state: proof.ok ? DONE : TODO,
    detail: proof.ok
      ? `proved ${Math.round(proof.ageMs / 60000)} min ago for ${proof.receipt.sha.slice(0, 12)} (valid for ${Math.round(MAX_AGE_MS / 60000)} min)`
      : proof.reason,
    next: 'pnpm verify:delivery',
  });

  // ④ Artefacts on this disk.
  out.push(...artefactRows());

  // ⑤ The three server-side facts. UNKNOWN by construction — see the header.
  // 🔴 The internal LAN publisher and the private-to-public sync are BOTH
  // excluded from the open-source export, so in a public clone the commands
  // below name files that do not exist. publish.mjs already learned this lesson
  // (IT-33): it prints a NAMED notice rather than either failing or going quiet,
  // because "this capability was never shipped to you" and "this step failed"
  // are different sentences. Same treatment here — the row still exists (the
  // release step is real), it just says what this tree can and cannot do.
  const present = (rel) => existsSync(join(REPO_ROOT, rel));
  const absentNote = 'not in this tree (the export omits the internal publisher) — host publish/ however suits you';
  out.push({
    id: 'download-center',
    label: 'LAN download center carries this version',
    state: UNKNOWN,
    detail: present('scripts/publish-download-center.mjs')
      ? 'a fact about a server, not this disk — not checked here'
      : absentNote,
    next: present('scripts/publish-download-center.mjs')
      ? 'node scripts/publish-download-center.mjs   # publishes and reports'
      : 'distribute ./publish yourself; nothing here uploads for you',
  });
  out.push({
    id: 'live-manifest',
    label: 'public /api/updates/latest announces this version',
    state: UNKNOWN,
    detail: 'the step 0.2.61 shipped without, and the one 0.3.6 discovered by walking into it',
    next: 'node scripts/verify-live-update-manifest.mjs',
  });
  out.push({
    id: 'public-repo',
    label: 'public repo synced + GitHub release published',
    state: UNKNOWN,
    detail: present('scripts/opensource-sync.mjs')
      ? 'both are owner-gated outward actions; this tool never performs or infers them'
      : `${absentNote} (the sync half); the GitHub release step is present`,
    next: present('scripts/opensource-sync.mjs')
      ? 'node scripts/opensource-sync.mjs   then   node scripts/publish-github-release.mjs'
      : 'node scripts/publish-github-release.mjs',
  });

  return out;
}

function shortHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '(git unavailable)';
  }
}

export async function main() {
  const list = await rows();
  console.log(`FlowMic release status — ${VERSION} @ ${shortHead()}`);
  console.log('(read-only: nothing below was built, uploaded, or fetched)\n');

  const pad = Math.max(...list.map((r) => r.label.length));
  for (const r of list) {
    console.log(`  ${r.state.padEnd(7)} ${r.label.padEnd(pad)}  ${r.detail}`);
    // ONE COMMAND PER GAP, printed beside the gap it closes. A DONE row gets no
    // command on purpose: a list of commands you must not run is how a status
    // display turns into a checklist someone works through from the top.
    if (r.state !== DONE) console.log(`  ${' '.repeat(7)} ${' '.repeat(pad)}  -> ${r.next}`);
  }

  // "Which is next" is answered by the FIRST unfinished row in declaration
  // order, because that order IS the release order — the manifest cannot be
  // built before the artefacts, and the artefacts cannot be built on a red
  // gate. Naming one step rather than listing every gap is the difference
  // between this and the list above it.
  const next = list.find((r) => r.state === TODO) ?? list.find((r) => r.state === UNKNOWN);
  console.log('');
  if (!next) {
    console.log('  Nothing left that this tool can see.');
  } else {
    console.log(`  NEXT: ${next.label}`);
    console.log(`    ${next.next}`);
  }
  const unknown = list.filter((r) => r.state === UNKNOWN).length;
  if (unknown > 0) {
    console.log('');
    console.log(`  ${unknown} row(s) are UNKNOWN and stay that way here: they are facts about a server.`);
    console.log('  Each names the command that answers it. An honest unknown beats a guess that looks checked.');
  }
  return 0;
}

const invokedDirectly = process.argv[1] != null
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main().then((c) => process.exit(c));
