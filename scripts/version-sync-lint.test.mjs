#!/usr/bin/env node
// Drill for verify/lint/version-sync.mjs — the gate that keeps every "which
// version is this" face (package.json, Cargo.toml, bootstrap.ts's
// SERVER_VERSION, CLAUDE.md's anchor, …) agreeing with root. Until this file
// existed it had no fixture test, despite its own header naming the exact
// failure mode a drift produces (13 book D5: three release rounds all called
// themselves 0.1.0, and owner had to diff SHA256 to tell them apart).
//
// `run()` gained an explicit `rootAbs = ROOT` parameter on 2026-09-02 (B2-A) —
// suggested by this repo's own precedent in another lint's test header ("the
// shape a root-parameterised sibling lint already has") — specifically so
// this drill can build a small disposable tree with just the REQUIRED fixed
// faces (Cargo.toml, Cargo.lock, bootstrap.ts, CLAUDE.md) instead of pointing
// at the real repo, where drifting a face on purpose is not an option.
//
// The `optional` cross-check against scripts/opensource-manifest.mjs's
// EXCLUDE list still reads the REAL repo's manifest regardless of `rootAbs`
// (it answers "does the public export drop this face", which is a property of
// THIS repo's manifest, not of the fixture) — documented as a known limit
// rather than routed around, since parameterising that too is a bigger seam
// change than "keep behaviour identical" allows for B2-A.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import versionSync from '../verify/lint/version-sync.mjs';

let failures = 0;
const ok = (name, detail) => console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

function put(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** Build a tree carrying every REQUIRED fixed-list face at `version`. */
function buildTree(version) {
  const T = mkdtempSync(join(tmpdir(), 'fmvs-fixture-'));
  put(T, 'package.json', JSON.stringify({ name: 'flowmic', version }, null, 2));
  put(T, 'apps/desktop/src-tauri/Cargo.toml', `[package]\nname = "flowmic-desktop"\nversion = "${version}"\nedition = "2021"\n`);
  put(T, 'apps/desktop/src-tauri/Cargo.lock', `[[package]]\nname = "flowmic-desktop"\nversion = "${version}"\ndependencies = []\n`);
  put(T, 'apps/server-core/src/bootstrap.ts', `export const SERVER_VERSION = '${version}';\n`);
  put(T, 'CLAUDE.md', `# CLAUDE.md\n\ncurrent version: <!--version:current-->${version}<!--/version:current-->\n`);
  return T;
}

try {
  console.log('=== §1 a tree where every required face matches root PASSes (positive control) ===');
  {
    const T = buildTree('9.9.9');
    const res = await versionSync(T);
    check(res.status === 'PASS', 'a fully-aligned fixture tree passes', JSON.stringify(res));
    check(res.detail.includes('9.9.9'), 'the PASS detail names the aligned version', res.detail);
    rmSync(T, { recursive: true, force: true });
  }

  console.log('=== §2 REVERSE CONTROL: ONE drifted face (Cargo.toml) FAILs, the others being right does not save it ===');
  {
    const T = buildTree('1.2.3');
    // Drift exactly one face after building an otherwise-aligned tree — same
    // shape as the historical incident (one file forgotten during a bump).
    put(T, 'apps/desktop/src-tauri/Cargo.toml', `[package]\nname = "flowmic-desktop"\nversion = "1.2.4"\nedition = "2021"\n`);
    const res = await versionSync(T);
    check(res.status === 'FAIL', 'a single drifted face fails the whole gate', JSON.stringify(res));
    check(res.detail.includes('Cargo.toml') && res.detail.includes('1.2.4'), 'the FAIL detail names the offending face and its wrong version', res.detail);
    rmSync(T, { recursive: true, force: true });
  }

  console.log('=== §3 REVERSE CONTROL: a drifted CLAUDE.md anchor FAILs (the doc face, not just machine faces) ===');
  {
    const T = buildTree('2.0.0');
    put(T, 'CLAUDE.md', `# CLAUDE.md\n\ncurrent version: <!--version:current-->1.9.9<!--/version:current-->\n`);
    const res = await versionSync(T);
    check(res.status === 'FAIL', 'a drifted CLAUDE.md anchor fails', JSON.stringify(res));
    check(res.detail.includes('CLAUDE.md'), 'the FAIL detail names CLAUDE.md', res.detail);
    rmSync(T, { recursive: true, force: true });
  }

  console.log('=== §4 a REQUIRED face missing entirely (no `optional` note) FAILs, not SKIPs ===');
  {
    const T = mkdtempSync(join(tmpdir(), 'fmvs-missing-'));
    put(T, 'package.json', JSON.stringify({ name: 'flowmic', version: '3.0.0' }, null, 2));
    // Deliberately omit Cargo.toml/Cargo.lock/bootstrap.ts/CLAUDE.md.
    const res = await versionSync(T);
    check(res.status === 'FAIL', 'a missing required fixed-list face fails rather than silently skipping', JSON.stringify(res));
    check(res.detail.includes('missing'), 'the FAIL detail says the face is missing', res.detail);
    rmSync(T, { recursive: true, force: true });
  }

  console.log('=== §5 discovery-based faces absent (no apps/*, packages/*) SKIP by kind, not FAIL ===');
  {
    // §1's tree has apps/desktop and apps/server-core but no packages/*
    // workspace package.json and no pubspec.yaml/tauri.conf.json anywhere —
    // those are discovery-based and their absence must not fail the gate.
    const T = buildTree('4.4.4');
    const res = await versionSync(T);
    check(res.status === 'PASS', 'absence of discovery-based faces does not fail the gate', JSON.stringify(res));
    check(res.detail.includes('skipped'), 'the PASS detail names what was skipped, not silently', res.detail);
    rmSync(T, { recursive: true, force: true });
  }

  console.log('=== §6 the lint itself runs on the real repo (default root) and answers ===');
  {
    const res = await versionSync();
    check(res.status === 'PASS', 'the real repo tree is self-consistent', JSON.stringify(res));
    console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
  }

  console.log('=== §7 KNOWN LIMIT (not tested here): the optional/EXCLUDE cross-check reads the REAL manifest ===');
  {
    // CLAUDE.public.md's `optional` note is cross-checked against the REAL
    // repo's scripts/opensource-manifest.mjs regardless of rootAbs — that
    // property belongs to this repo's manifest, not to a fixture tree. §1-§5
    // above never populate CLAUDE.public.md, so they exercise the "optional,
    // absent -> skipped" branch, never the excludedBy() cross-check branch.
    ok('documented as out of this drill fixture scope; exercised by §6 against the real repo');
  }
} finally {
  // buildTree()'s temp dirs are cleaned inline after each use; nothing left.
}

console.log(`\n${failures === 0 ? '✔' : '✘'} version-sync drill — ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);
