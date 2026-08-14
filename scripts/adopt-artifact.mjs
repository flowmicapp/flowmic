#!/usr/bin/env node
// Adopt an artifact built on ANOTHER machine into ./publish (card UP-6).
//
//     node scripts/adopt-artifact.mjs <path> --sha256 <hash-from-the-producing-machine>
//     node scripts/adopt-artifact.mjs <path> --sha256 <hash> --platform macos-arm64
//     node scripts/adopt-artifact.mjs <path> --sha256 <hash> --dry-run
//
// ── the problem this exists for ─────────────────────────────────────────────
//
// scripts/publish-download-center.mjs only uploads files it can prove
// scripts/publish.mjs vetted, and the proof is the `.sha256` sidecar sitting
// beside them. That rule is right, and it has one consequence nobody wrote
// down: an artifact built somewhere else can never satisfy it, because
// publish.mjs never touched it. The macOS build is exactly that — produced,
// signed and notarized on a Mac mini — so today it cannot reach the download
// center at all, and the owner has no way to get it.
//
// This script is the missing, EXPLICIT step: a cross-machine handshake that
// ends with the artifact holding the same evidence every local artifact holds.
//
// ── 🔴 why --sha256 is REQUIRED and will not be made optional ───────────────
//
// The obvious shortcut is to hash whatever bytes arrived and write that into
// the sidecar. That attests NOTHING. It is the cross-machine form of the trap
// scripts/build-update-manifest.mjs already names in its own comment:
// 「抄下来的哈希只证明侧车里写着什么，重算出来的才证明即将被下载的那些字节是什么」——
// except here even recomputing does not help, because the question is not "do
// these bytes hash to this" but "are these the bytes the OTHER machine built".
// Only a hash carried out-of-band from the producing machine answers that, so
// the flag is mandatory and the failure direction is deliberate:
//
//     forget the flag  ⇒ refusal ⇒ we fall back to today's state (the owner
//                        downloads by hand), which is inconvenient but honest
//     make it optional ⇒ a silent upload of unattested bytes under a name that
//                        claims they were vetted
//
// A refusal costs a round-trip. The other branch costs the meaning of every
// sidecar in ./publish.
//
// ── what this does NOT check, said out loud ────────────────────────────────
//
// · It does not verify a code signature or a notarization ticket. It checks
//   that the bytes match what the producing machine reported. If that machine
//   reported the hash of an unsigned build, this script cannot tell.
// · It does not open the archive. It checks the zip magic bytes and stops
//   there — deliberately NOT reusing pack-portable.mjs's verifyPortableArchive,
//   which encodes OUR bundle's shape (one top-level `FlowMic-portable/`). A
//   macOS artifact's top level is `FlowMic.app/`; imposing the Windows shape on
//   it would reject a perfectly good artifact.
// · When the source filename carries no version, it CANNOT cross-check the
//   version it is about to write into the name, and says so on every run
//   rather than letting the filename quietly speak for bytes nobody asked.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTABLE_PLATFORMS, portableZipName, sidecarLine } from './pack-portable.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 64 lower-case hex. Same shape the update endpoint's SHA256_RE enforces and
 *  the same shape publish.mjs's sidecars carry — uppercase, short, and
 *  whitespace-padded forms are REFUSED BY NAME rather than normalised, because
 *  a hash the caller typed differently from the one the other machine printed
 *  is a hash worth stopping on. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/** A version-shaped token anywhere in a filename, used only to cross-check the
 *  version this script is about to bake into the canonical name. */
const VERSION_TOKEN_RE = /\d+\.\d+\.\d+/g;

export class AdoptError extends Error {}

/** Pick the platform for the canonical name.
 *
 *  Explicit `--platform` always wins. Otherwise infer, but ONLY when the source
 *  filename contains exactly one known platform token — an ambiguous or absent
 *  token is a refusal, never a guess. (The repo's rule: a loud refusal beats
 *  quiet wrong data.) */
export function choosePlatform(sourceName, explicit) {
  if (explicit !== undefined) {
    if (!PORTABLE_PLATFORMS.has(explicit)) {
      throw new AdoptError(
        `--platform ${explicit} is not a known portable platform. Known: ${[...PORTABLE_PLATFORMS].join(', ')}.\n` +
        '  Adding one is an edit to PORTABLE_PLATFORMS in scripts/pack-portable.mjs, and that edit is the moment\n' +
        '  to re-check the cross-language `kind` contract — not something to work around here.',
      );
    }
    return { platform: explicit, how: 'given by --platform' };
  }
  const hits = [...PORTABLE_PLATFORMS].filter((p) => sourceName.includes(p));
  if (hits.length === 1) return { platform: hits[0], how: `inferred from the source filename (${hits[0]})` };
  if (hits.length === 0) {
    throw new AdoptError(
      `cannot tell which platform ${sourceName} is for — no known platform token in the name.\n` +
      `  Pass --platform <${[...PORTABLE_PLATFORMS].join('|')}> explicitly. Guessing here would write a filename\n` +
      '  that claims something nobody checked.',
    );
  }
  throw new AdoptError(
    `${sourceName} mentions more than one platform (${hits.join(', ')}) — refusing to guess. Pass --platform explicitly.`,
  );
}

/** The version cross-check. Returns a note to print. Throws when the source
 *  filename states a version that disagrees with the reference version, because
 *  copying it to a name carrying a DIFFERENT version reproduces the exact bug
 *  publish.mjs's aapt check exists to stop: a filename that actively lies about
 *  what is inside it (13 册 D5). */
export function checkVersionAgreement(sourceName, version) {
  const found = [...new Set(sourceName.match(VERSION_TOKEN_RE) ?? [])];
  if (found.length === 0) {
    return {
      verified: false,
      note:
        `⚠ ${sourceName} carries no version in its name, so the version in the adopted name (${version}, from the root\n` +
        '  package.json) is NOT verified against the artifact. If this build is not that version, the name will lie.',
    };
  }
  const disagreeing = found.filter((v) => v !== version);
  if (disagreeing.length > 0) {
    throw new AdoptError(
      `${sourceName} names version ${disagreeing.join(', ')}, but this tree is ${version}.\n` +
      `  Adopting it would file those bytes under a name claiming ${version} — a filename that lies about its own\n` +
      '  contents, which is the failure the per-round version bump exists to end. Rebuild on the producing machine\n' +
      '  for this version, or bump/checkout the tree to match the artifact.',
    );
  }
  return { verified: true, note: `✓ source filename agrees with the reference version (${version})` };
}

/** The whole adoption, as a parameterised function so tests drive fixtures
 *  instead of the real ./publish (and so importing this module adopts nothing). */
export function adoptArtifact({ sourcePath, attestedSha256, version, outDir, platform, dryRun = false, log = () => {} }) {
  if (typeof attestedSha256 !== 'string' || attestedSha256 === '') {
    throw new AdoptError(
      'missing --sha256 <hash>. It is REQUIRED: the sidecar this script writes is the evidence the uploader trusts,\n' +
      '  and bytes that arrived from another machine carry no such evidence on their own. Hashing whatever arrived\n' +
      '  would attest nothing — only the hash the PRODUCING machine reported can. Ask that machine for it.',
    );
  }
  if (!SHA256_RE.test(attestedSha256)) {
    const why = /^[0-9a-fA-F]+$/.test(attestedSha256)
      ? (attestedSha256.length !== 64
        ? `it is ${attestedSha256.length} hex characters, not 64`
        : 'it contains upper-case hex')
      : 'it is not hexadecimal';
    throw new AdoptError(
      `--sha256 ${attestedSha256} is not a valid sha256: ${why}.\n` +
      '  Expected exactly 64 lower-case hex characters, as printed by `sha256sum` / `shasum -a 256`.\n' +
      '  Not normalising it on your behalf: a hash typed differently from the one the other machine printed is\n' +
      '  a hash worth stopping on.',
    );
  }
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new AdoptError(`no such file: ${sourcePath}`);
  }

  const sourceName = basename(sourcePath);
  const { platform: plat, how } = choosePlatform(sourceName, platform);
  const versionCheck = checkVersionAgreement(sourceName, version);

  const bytes = readFileSync(sourcePath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== attestedSha256) {
    throw new AdoptError(
      `these bytes are NOT the ones the producing machine attested.\n` +
      `      attested : ${attestedSha256}\n` +
      `      actual   : ${actual}\n` +
      `      file     : ${sourcePath} (${bytes.length} bytes)\n` +
      '  Refusing to adopt. Either the transfer corrupted it, or this is a different build than the one whose hash\n' +
      '  you were given. Re-copy it and re-check on the producing machine.',
    );
  }
  // Magic bytes only — see the header for why this deliberately does not
  // impose the Windows bundle's internal shape on a foreign artifact.
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new AdoptError(
      `${sourceName} does not begin with the zip magic (got ${bytes.subarray(0, 4).toString('hex')}, expected 504b0304).\n` +
      '  The canonical portable artifact name ends in .zip, so filing a non-zip under it would make the name lie.',
    );
  }

  const destName = portableZipName(version, plat);
  const destPath = join(outDir, destName);
  const sidecarPath = `${destPath}.sha256`;

  log(`· source    ${sourcePath}`);
  log(`· platform  ${plat} (${how})`);
  log(`· ${versionCheck.verified ? versionCheck.note : versionCheck.note}`);
  log(`· attested  ${attestedSha256} — matches the bytes on disk`);
  log(`· adopt as  ${destName} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);

  // Never clobber a DIFFERENT artifact: ./publish is shared between windows
  // (measured 2026-08-08 — another window staged an artifact there mid-card).
  // Re-adopting the identical bytes is idempotent and fine; anything else stops.
  if (existsSync(destPath)) {
    const existing = createHash('sha256').update(readFileSync(destPath)).digest('hex');
    if (existing !== attestedSha256) {
      throw new AdoptError(
        `${destPath} already exists and holds DIFFERENT bytes (${existing.slice(0, 12)}… vs ${attestedSha256.slice(0, 12)}…).\n` +
        '  Refusing to overwrite it. ./publish is shared; if the existing file is stale, remove it deliberately and re-run.',
      );
    }
    log('· destination already holds these exact bytes — re-adopting is a no-op apart from the sidecar');
  }

  if (dryRun) {
    log(`· --dry-run: would write ${destName} and ${destName}.sha256 into ${outDir} (nothing written)`);
    return { dryRun: true, destName, destPath, sidecarPath, platform: plat, sha256: attestedSha256, size: bytes.length, versionVerified: versionCheck.verified };
  }

  copyFileSync(sourcePath, destPath);
  // Re-hash what actually landed rather than trusting the copy: a truncated
  // copy is exactly the failure a sidecar is supposed to make visible, and
  // writing the attested hash beside bytes we never re-read would bake in a
  // claim we did not check.
  const landed = createHash('sha256').update(readFileSync(destPath)).digest('hex');
  if (landed !== attestedSha256) {
    throw new AdoptError(`the copy at ${destPath} hashes to ${landed}, not ${attestedSha256} — the copy itself went wrong. Not writing a sidecar.`);
  }
  writeFileSync(sidecarPath, sidecarLine(attestedSha256, destName));

  return { dryRun: false, destName, destPath, sidecarPath, platform: plat, sha256: attestedSha256, size: bytes.length, versionVerified: versionCheck.verified };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main(argv) {
  // Presence-only booleans reject the valued spelling by name (IT-07). Valued
  // flags reject the bare spelling for the mirror-image reason: `--sha256`
  // with no value must not silently become "no attestation".
  for (const name of ['dry-run']) {
    const bad = argv.find((a) => a.startsWith(`--${name}=`));
    if (bad) {
      console.error(`✗ --${name}=… is not accepted. Use bare --${name} (no =value). Got: ${bad}`);
      process.exit(1);
    }
  }
  const valued = (name) => {
    const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i < 0) return undefined;
    const a = argv[i];
    if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      console.error(`✗ --${name} needs a value (got nothing). Spelling: --${name} <value> or --${name}=<value>.`);
      process.exit(1);
    }
    return next;
  };

  const dryRun = argv.includes('--dry-run');
  const sha = valued('sha256');
  const platform = valued('platform');
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--sha256', '--platform'].includes(argv[i - 1])));

  if (positional.length !== 1) {
    console.error('✗ expected exactly one <path> to adopt.');
    console.error('  usage: node scripts/adopt-artifact.mjs <path> --sha256 <hash-from-the-producing-machine> [--platform <token>] [--dry-run]');
    process.exit(1);
  }

  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  try {
    const r = adoptArtifact({
      sourcePath: resolve(positional[0]),
      attestedSha256: sha,
      version,
      outDir: join(ROOT, 'publish'),
      platform,
      dryRun,
      log: (m) => console.log(m),
    });
    if (r.dryRun) {
      console.log('✓ --dry-run: every check passed, nothing written');
    } else {
      console.log(`✓ ${r.destName}`);
      console.log(`✓ ${r.destName}.sha256`);
      if (!r.versionVerified) console.log('⚠ (the version in that name was NOT verified against the artifact — see above)');
    }
  } catch (e) {
    if (e instanceof AdoptError) { console.error(`✗ ${e.message}`); process.exit(1); }
    throw e;
  }
}

const thisFile = fileURLToPath(import.meta.url);
const argvEntry = process.argv[1] ? resolve(process.argv[1]) : null;
const sameEntry = (a, b) => {
  const na = normalize(resolve(a));
  const nb = normalize(resolve(b));
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
};
if (argvEntry && sameEntry(thisFile, argvEntry)) {
  main(process.argv.slice(2));
} else if (argvEntry && basename(argvEntry).toLowerCase() === basename(thisFile).toLowerCase()) {
  console.error('✗ refused to run as main module: entry path comparison failed');
  console.error(`  import.meta.url → ${thisFile}`);
  console.error(`  process.argv[1] → ${argvEntry}`);
  process.exit(1);
}
