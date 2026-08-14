#!/usr/bin/env node
// FlowMic portable-bundle packer (card UP-1).
//
// scripts/publish.mjs stages the one-click Windows bundle as a DIRECTORY,
// publish/FlowMic-portable/. Everything downstream of ./publish deals in single
// FILES: scripts/publish-download-center.mjs uploads files, and
// scripts/build-update-manifest.mjs writes one manifest row per file with a
// sha256. So for as long as the portable bundle was only ever a directory, it
// was the one product this repo builds and never distributes — the S8 audit
// (2026-08-05, docs/strategy/2026-08-05-s8-release-script-defects-cn.md §2)
// measured that it had never once reached the download center, and all the
// release chain did about it was print a warning naming the gap.
//
// This script closes the gap by making the bundle file-shaped: one zip beside
// the directory, carrying the same `<sha256>  <name>\n` sidecar every other
// staged artifact carries, so the existing uploader and manifest generator
// handle it with no special case at all.
//
// Run standalone (does NOT run publish.mjs's verify:delivery gate, and does not
// upload anything anywhere — it only writes two files into ./publish):
//     node scripts/pack-portable.mjs
//     node scripts/pack-portable.mjs --check     # verify + report, write nothing
//
// ── decisions this file encodes, and why (do not re-litigate casually) ───────
//
// ARCHIVE SHAPE — exactly ONE top-level entry, the directory `FlowMic-portable`,
// containing the tree verbatim. Two reasons, both concrete: a user who extracts
// into Downloads must not get ~100 MB sprayed across the root of it, and the
// updater (card UP-3) needs an unambiguous "did I extract what I think I
// extracted" check — one known top-level name is that check.
//
// FILENAME — `FlowMic-<VERSION>-portable-<platform>.zip`. The platform is IN the
// name because owner ruling 2026-08-05 ① requires Windows / macOS / Linux
// portable editions; those have to be ADDITIVE filenames that the manifest
// classifier never has to guess about. `windows-x64` is spelled exactly as the
// manifest platform key so the two can never drift into two spellings of one
// fact (see scripts/build-update-manifest.mjs `classify`).
//
// ARCHIVER — resolved by ABSOLUTE PATH and then identity-checked, never by PATH
// lookup. 🔴 This is measured, not defensive: on this machine (dev-pc-a)
// `tar` resolves to TWO DIFFERENT PROGRAMS depending on which shell started the
// process — PowerShell finds C:\Windows\System32\tar.exe (bsdtar 3.8.4 /
// libarchive, writes real zips), Git Bash finds /usr/bin/tar (GNU tar 1.35,
// which has no zip support whatsoever). Handed `-a -c -f out.zip`, GNU tar
// writes an uncompressed TAR into a file named `.zip` and EXITS 0. Measured:
//     GNU tar   → exit 0, first four bytes `46 61 6b 65` ("Fake…", tar header)
//     bsdtar    → exit 0, first four bytes `50 4b 03 04` ("PK\3\4", zip)
// So the exit code is necessary and NOT sufficient here, and "prefer tar from
// PATH" would make the output format depend on the operator's terminal. Hence:
// one absolute candidate, `--version` must say bsdtar/libarchive, and the
// produced bytes are inspected afterwards regardless.
//
// FORMAT FLAG — `--format zip` explicitly rather than relying on `-a`'s
// suffix inference. Same reasoning one level down: suffix inference is the
// mechanism that lets a wrong tool produce a wrong-format file with a
// right-looking name, and the temp file this script writes to does not have its
// final name yet anyway.
//
// FILENAME ENCODING — `--options zip:hdrcharset=UTF-8`. Measured on this
// machine: WITHOUT it, bsdtar stores `使用说明.txt` as GBK bytes
// (`cab9d3c3cbb5c3f7`) with the zip UTF-8 flag CLEAR, which extracts as mojibake
// on any machine whose ANSI codepage is not GBK — i.e. every non-Chinese
// Windows, which is precisely the audience a portable download reaches. WITH it,
// that entry carries flag 0x808 and UTF-8 bytes (`e4bdbfe794a8e8afb4e6988e`),
// while pure-ASCII entries are left alone (they are identical in every
// codepage). verifyPortableArchive() below re-asserts this on the real output,
// so the flag cannot silently stop working.
//
// 🔴 NOT REPRODUCIBLE — packing the same unchanged tree twice produces a
// DIFFERENT sha256, and that is measured, not assumed:
//     two packs inside the same wall-clock second → byte-identical
//     two packs >2s apart                        → differ by 1 timestamp byte
//     across 10 entries, content CRC differences → 0, every time
// i.e. the payload is stable and the archive embeds the clock. Consequence, and
// it is the reason this paragraph is at the top of the file rather than in a
// commit message: the update manifest PINS a sha256 for a named file, and that
// pin is the entire hash gate. So re-running this packer AFTER the manifest was
// generated silently invalidates it — every client then downloads the file the
// manifest names, hashes it, mismatches, and refuses to install, while nothing
// locally looks wrong. scripts/publish.mjs already sequences pack → upload →
// manifest, so the happy path is safe; a hand-run re-pack is the reachable
// hazard, so packPortable() warns by name when it detects one (see
// describeStaleManifest below). Making the archive reproducible would mean
// pinning entry timestamps, which is a real change to what we ship and is NOT
// in this card's scope — it is written down here instead of fixed quietly.
//
// POST-CONDITIONS — this script parses its own output's zip central directory
// rather than shelling out to a listing tool. Also measured, also not
// defensive: `tar -tf` on this machine returns that same CJK entry as
// `ʹ��˵��.txt` through the console codepage, so a listing-based comparison
// would have failed on a file that is perfectly fine — an instrument silently
// answering a different question than the one asked (memory flowmic-measure-your-ruler).
// Reading the central directory asks the archive itself.

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** The staged bundle's directory name, and therefore the archive's single
 *  top-level entry. Same literal as scripts/publish.mjs's `PORTABLE`. */
export const PORTABLE_DIR_NAME = 'FlowMic-portable';

/** Spelled exactly as the manifest platform key (`platforms['windows-x64']`).
 *  One fact, one spelling. */
export const DEFAULT_PORTABLE_PLATFORM = 'windows-x64';

/** The platforms a portable edition may legally claim (owner ruling 2026-08-05 ①
 *  frames Windows / macOS / Linux portable editions as one family).
 *
 *  🔴 ONE list, imported by everyone who needs it — scripts/build-update-manifest.mjs
 *  `classify()` (what the manifest will serve) and scripts/adopt-artifact.mjs
 *  (what may be named). Those answer two questions that must never drift apart,
 *  and this repo has already paid for the alternative: `verify:lint` discovers
 *  version faces by walking the tree while bump-version.mjs's FACES table is
 *  hand-kept, so a new package is green the day it is added and only goes red at
 *  the NEXT bump. Two hand-maintained copies of one fact is that bug waiting.
 *
 *  ⚠️ Adding a row here is the moment to re-check the cross-language `kind`
 *  contract named in build-update-manifest.mjs `classify()` — not a rename. */
export const PORTABLE_PLATFORMS = new Set(['windows-x64', 'macos-arm64', 'linux-x64']);

export function portableZipName(version, platform = DEFAULT_PORTABLE_PLATFORM) {
  return `FlowMic-${version}-portable-${platform}.zip`;
}

/** Version is non-greedy so the fixed `-portable-` literal anchors the split;
 *  the platform token is deliberately restricted to the lowercase/digit/hyphen
 *  shape the update endpoint's PLATFORM_RE accepts (see
 *  apps/server-core/src/http/update-routes.ts). A name that does not parse is
 *  refused by callers rather than guessed at. */
const PORTABLE_ZIP_RE = /^FlowMic-(.+?)-portable-([a-z0-9]+(?:-[a-z0-9]+)*)\.zip$/;

export function parsePortableZipName(name) {
  const m = PORTABLE_ZIP_RE.exec(name);
  return m ? { version: m[1], platform: m[2] } : null;
}

export function isPortableZipName(name) {
  return parsePortableZipName(name) !== null;
}

/** The sidecar format is a CONTRACT, not a convenience: scripts/publish.mjs
 *  `stage()` writes it and three other places parse it back with
 *  `.trim().split(/\s+/)[0]` (publish-download-center.mjs `collectArtifacts`,
 *  build-update-manifest.mjs's hash gate, apps/desktop's verify-bundle). Two
 *  spaces between hash and name — the sha256sum(1) format. */
export function sidecarLine(hash, name) {
  return `${hash}  ${name}\n`;
}

/** Locate a libarchive-backed archiver by absolute path and prove its identity.
 *  Throws — never returns a "close enough" tool, and never falls back to a PATH
 *  lookup (see the ARCHIVER note in the header: PATH answers differently
 *  depending on which shell launched us, and the wrong answer fails silently). */
export function resolveArchiver(env = process.env, platform = process.platform) {
  const override = env.FLOWMIC_BSDTAR;
  const candidates = override
    ? [override]
    : platform === 'win32'
      ? [join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe')]
      // Not `tar` on these platforms either, and for the same measured reason:
      // on Linux `tar` is GNU tar. Name bsdtar explicitly. (Owner ruling
      // 2026-08-05 ① puts macOS/Linux portable editions on the roadmap; this
      // list is where they arrive, not a promise that they work today.)
      : ['/usr/bin/bsdtar', '/usr/local/bin/bsdtar', '/opt/homebrew/bin/bsdtar'];

  const tried = [];
  for (const p of candidates) {
    if (!existsSync(p)) { tried.push(`${p} — not present`); continue; }
    let identity;
    try {
      identity = execFileSync(p, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
    } catch (e) {
      tried.push(`${p} — \`--version\` failed: ${e.message}`);
      continue;
    }
    if (!/bsdtar|libarchive/i.test(identity)) {
      tried.push(`${p} — reports "${identity}", which is not libarchive (GNU tar cannot write zip at all: it writes a TAR into the .zip filename and exits 0)`);
      continue;
    }
    return { path: p, identity };
  }
  throw new Error(
    'no libarchive/bsdtar archiver found — cannot pack the portable bundle.\n' +
    tried.map((t) => `      tried ${t}`).join('\n') +
    '\n      Set FLOWMIC_BSDTAR to an absolute path if it lives somewhere else on this machine.' +
    '\n      Deliberately NOT falling back to whatever `tar` PATH resolves to: on this repo\'s' +
    '\n      dev machine that is GNU tar under Git Bash, which would produce a tar named .zip' +
    '\n      and exit 0 — a silent wrong-format artifact is worse than a refused publish.',
  );
}

/** Every regular file under `dir`, as `{ rel, size }` with POSIX-separated
 *  relative paths, sorted. Anything that is neither a regular file nor a
 *  directory stops the pack: we would not be able to say what the archived
 *  form of it means. */
export function walkPortableTree(dir) {
  const out = [];
  const walk = (abs, rel) => {
    const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of entries) {
      const childAbs = join(abs, d.name);
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(childAbs, childRel);
      else if (d.isFile()) out.push({ rel: childRel, size: statSync(childAbs).size });
      else throw new Error(`${childRel} is neither a regular file nor a directory — refusing to pack a tree whose archived form is unpredictable`);
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Parse a zip's central directory out of its own bytes.
 *
 *  Pure (Buffer in, entries out) so the shape rules are testable without
 *  producing a 100 MB archive, and so nothing here depends on a listing tool's
 *  console encoding (header note: `tar -tf` mangles the one non-ASCII name in
 *  this bundle).
 *
 *  Throws on: not-a-zip, zip64 (this bundle is ~130 MB with a few dozen files
 *  since ENG-1b staged the sherpa addon under resources/node_modules — still far
 *  under both zip64 thresholds [4 GiB / 65,535 entries]; if that ever changes,
 *  the size/count fields move into the zip64 records and every
 *  comparison below would silently compare sentinels — refuse instead of
 *  mis-parsing), a corrupt central directory, and a non-ASCII entry name
 *  stored without the UTF-8 flag (that name extracts as mojibake on any
 *  machine with a different ANSI codepage). */
export function readZipEntries(buf) {
  if (buf.length < 22) throw new Error('not a zip: file is shorter than an end-of-central-directory record');
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`not a zip: first four bytes are ${buf.subarray(0, 4).toString('hex')}, expected 504b0304 ("PK\\3\\4")`);
  }
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record found');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('zip64 archive — this parser reads the classic central directory only, and comparing zip64 sentinel values would silently compare 0xffffffff to real sizes');
  }

  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      throw new Error(`corrupt zip: central-directory entry ${n} of ${count} has no 0x02014b50 signature at offset ${p}`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const utf8Flag = (flags & 0x800) !== 0;
    const asciiOnly = rawName.every((b) => b < 0x80);
    if (!asciiOnly && !utf8Flag) {
      throw new Error(
        `zip entry name is non-ASCII (${rawName.toString('hex')}) but the UTF-8 flag is clear — it would extract as mojibake ` +
        'on any machine whose ANSI codepage differs from the packing machine\'s. Pass --options zip:hdrcharset=UTF-8.',
      );
    }
    if (size === 0xffffffff) throw new Error(`zip64 per-entry size on entry ${n} — refusing to compare a sentinel against a real size`);
    const name = rawName.toString('utf8');
    entries.push({ name, size, isDir: name.endsWith('/'), utf8Flag, asciiOnly });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Prove the archive contains the source tree — both directions, by name and by
 *  size. "The zip opened" is not the measurement; "these N files are in it,
 *  these N files are on disk, the two sets are equal" is.
 *
 *  Pure: takes bytes and the already-walked source list. */
export function verifyPortableArchive(buf, sourceFiles, dirName = PORTABLE_DIR_NAME) {
  const entries = readZipEntries(buf);
  const problems = [];

  const topLevel = new Set(entries.map((e) => e.name.split('/')[0]));
  if (topLevel.size !== 1 || !topLevel.has(dirName)) {
    problems.push(`top-level entries are ${JSON.stringify([...topLevel])}, expected exactly ["${dirName}"]`);
  }

  const prefix = `${dirName}/`;
  const inZip = new Map();
  for (const e of entries) {
    if (e.isDir) continue;
    if (!e.name.startsWith(prefix)) { problems.push(`entry ${JSON.stringify(e.name)} is outside ${prefix}`); continue; }
    inZip.set(e.name.slice(prefix.length), e.size);
  }

  const onDisk = new Map(sourceFiles.map((f) => [f.rel, f.size]));
  const missing = [...onDisk.keys()].filter((k) => !inZip.has(k));
  const extra = [...inZip.keys()].filter((k) => !onDisk.has(k));
  const wrongSize = [...onDisk.entries()]
    .filter(([k, v]) => inZip.has(k) && inZip.get(k) !== v)
    .map(([k, v]) => `${k} (disk ${v} B, zip ${inZip.get(k)} B)`);

  if (missing.length) problems.push(`${missing.length} source file(s) missing from the archive: ${missing.join(', ')}`);
  if (extra.length) problems.push(`${extra.length} archive entr(ies) not in the source tree: ${extra.join(', ')}`);
  if (wrongSize.length) problems.push(`${wrongSize.length} size mismatch(es): ${wrongSize.join(', ')}`);

  if (problems.length) {
    throw new Error(`packed archive does not match the staged bundle:\n${problems.map((p) => `      · ${p}`).join('\n')}`);
  }
  return { fileEntries: inZip.size, totalEntries: entries.length };
}

/** Does an already-generated update-manifest.json in `outDir` still claim a
 *  sha256 for this zip that the freshly-packed bytes no longer have?
 *
 *  Exists because this packer is NOT reproducible (see the header): a hand-run
 *  re-pack after the manifest was built leaves a manifest whose hash pin is
 *  stale, and the failure surfaces only on a user's machine as "update refused,
 *  hash mismatch". Returns a message to print, or null when there is nothing to
 *  say. Deliberately non-fatal and read-only: publish.mjs regenerates the
 *  manifest downstream of this step anyway, so refusing here would block the
 *  normal path to warn about the abnormal one. */
export function describeStaleManifest(outDir, zipName, freshHash) {
  const manifestPath = join(outDir, 'update-manifest.json');
  if (!existsSync(manifestPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return `⚠ ${manifestPath} exists but is not valid JSON — regenerate it with \`node scripts/build-update-manifest.mjs\`.`;
  }
  for (const platform of Object.values(parsed?.platforms ?? {})) {
    for (const a of platform?.artifacts ?? []) {
      if (a?.filename !== zipName) continue;
      if (a?.sha256 === freshHash) return null;
      return (
        `⚠ update-manifest.json still pins sha256 ${String(a?.sha256).slice(0, 12)}… for ${zipName}, but the archive just\n` +
        `  written hashes to ${freshHash.slice(0, 12)}…. This packer is not reproducible (it embeds the clock), so ANY\n` +
        '  re-pack invalidates an existing manifest. A client would download this file, hash it, mismatch, and refuse\n' +
        '  to install — with nothing on this machine looking wrong. Re-run `node scripts/build-update-manifest.mjs`\n' +
        '  (and re-upload, if these bytes were already published: artifacts-before-manifest).'
      );
    }
  }
  return null;
}

/** Pack `<outDir>/FlowMic-portable/` into `<outDir>/<portableZipName(...)>`
 *  plus its `.sha256` sidecar.
 *
 *  `outDir` and `version` are parameters, not module reads, so tests can drive
 *  a tiny fixture tree instead of the real 100 MB bundle (and so importing this
 *  module packs nothing — S8's lesson: a script that does real work at import
 *  time cannot be tested without doing real work).
 *
 *  With `check: true` it verifies every precondition, reports what it WOULD
 *  write, and touches nothing. */
export function packPortable({ outDir, version, platform = DEFAULT_PORTABLE_PLATFORM, check = false, log = () => {} }) {
  const started = Date.now();
  const dirPath = join(outDir, PORTABLE_DIR_NAME);
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    throw new Error(`no ${dirPath} — nothing to pack (run \`node scripts/publish.mjs\` first, it stages the bundle)`);
  }
  const sourceFiles = walkPortableTree(dirPath);
  if (sourceFiles.length === 0) throw new Error(`${dirPath} is empty — refusing to publish an empty portable bundle`);

  const archiver = resolveArchiver();
  const zipName = portableZipName(version, platform);
  const zipPath = join(outDir, zipName);
  const sourceBytes = sourceFiles.reduce((n, f) => n + f.size, 0);

  log(`· archiver ${archiver.path} (${archiver.identity})`);
  log(`· source   ${dirPath} — ${sourceFiles.length} file(s), ${(sourceBytes / 1024 / 1024).toFixed(1)} MB`);

  if (check) {
    log(`· would write ${zipName} + ${zipName}.sha256 into ${outDir} (--check: nothing written)`);
    return { check: true, zipName, zipPath, sourceFiles: sourceFiles.length, sourceBytes, archiver };
  }

  // Pack to a temp name FIRST, then rename. Two reasons: a killed or failed run
  // must never leave a half-written file under the real artifact name (the
  // uploader and the manifest generator both trust names in ./publish), and the
  // temp name is deliberately not one `isDistributableArtifactName` can match,
  // so even a leftover cannot be uploaded. It still ends in `.zip` so nothing
  // downstream of the archiver has to reason about suffix inference.
  const tmpPath = join(outDir, `.pack-portable-${process.pid}.zip`);
  rmSync(tmpPath, { force: true });

  let result;
  try {
    const r = spawnSync(
      archiver.path,
      ['-c', '--format', 'zip', '--options', 'zip:hdrcharset=UTF-8', '-f', tmpPath, '-C', outDir, PORTABLE_DIR_NAME],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    // Judged on the exit code — and, because the header's measurement showed the
    // exit code alone cannot tell a zip from a tar, on the bytes below too.
    if (r.error) throw new Error(`${archiver.path} could not be run: ${r.error.message}`);
    if (r.status !== 0) {
      throw new Error(`${archiver.path} exited ${r.status}${r.signal ? ` (signal ${r.signal})` : ''}: ${(r.stderr || '').trim().slice(0, 500)}`);
    }
    if (!existsSync(tmpPath)) throw new Error(`${archiver.path} exited 0 but wrote no archive`);

    const buf = readFileSync(tmpPath);
    const shape = verifyPortableArchive(buf, sourceFiles);
    const hash = createHash('sha256').update(buf).digest('hex');

    renameSync(tmpPath, zipPath);
    writeFileSync(`${zipPath}.sha256`, sidecarLine(hash, zipName));

    const stale = describeStaleManifest(outDir, zipName, hash);
    if (stale) log(stale);

    result = {
      check: false,
      zipName,
      zipPath,
      hash,
      size: buf.length,
      sourceFiles: sourceFiles.length,
      sourceBytes,
      fileEntries: shape.fileEntries,
      totalEntries: shape.totalEntries,
      ms: Date.now() - started,
      archiver,
    };
  } finally {
    // Whatever went wrong, do not leave a partial archive behind. On the happy
    // path the rename already moved it, so this is a no-op.
    rmSync(tmpPath, { force: true });
  }
  return result;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// Only when this file is the process entry point; importing it for the pure
// helpers above must pack nothing (same entry-point discipline as
// publish-download-center.mjs, card IT-11).
function main(argv) {
  // Presence-only boolean, `--check=1` REJECTED rather than coerced — IT-07's
  // rule. A flag whose valued spelling silently means the opposite of what the
  // operator typed is how a "just looking" run writes files.
  const bad = argv.find((a) => a.startsWith('--check='));
  if (bad) {
    console.error(`✗ --check=… is not accepted. Use bare --check (no =value). Got: ${bad}`);
    process.exit(1);
  }
  const check = argv.includes('--check');
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const outDir = join(ROOT, 'publish');

  try {
    const r = packPortable({ outDir, version, check, log: (m) => console.log(m) });
    if (r.check) {
      console.log(`✓ --check: preconditions pass, nothing written`);
      return;
    }
    console.log(
      `✓ ${r.zipName}  (${(r.size / 1024 / 1024).toFixed(1)} MB, ${r.fileEntries} file entries, ` +
      `${(r.ms / 1000).toFixed(1)}s)  ${r.hash.slice(0, 8)}…`,
    );
    console.log(`✓ ${r.zipName}.sha256`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

// Exact string compare on the URL is a false-negative trap on Windows (drive-letter
// case, junctions) — that shape used to exit 0 with zero work done (IT-11). Compare
// resolved paths, case-folded on win32, exactly as publish-download-center.mjs does.
const thisFile = fileURLToPath(import.meta.url);
const argvEntry = process.argv[1] ? resolve(process.argv[1]) : null;
const sameEntry = (a, b) => {
  // realpath BOTH sides — macOS /var → /private/var symlinks make the ESM
  // loader's URL and argv[1] disagree about one file. See the identical fix
  // and its CI measurement in adopt-artifact.mjs (up6, 2026-08-15).
  const canon = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const na = normalize(canon(a));
  const nb = normalize(canon(b));
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
};
if (argvEntry && sameEntry(thisFile, argvEntry)) {
  main(process.argv.slice(2));
} else if (argvEntry && basename(argvEntry).toLowerCase() === basename(thisFile).toLowerCase()) {
  // Invoked as this program by name, but the path compare disagreed — say so
  // rather than silently doing nothing (IT-11's silent-failure red line).
  console.error('✗ refused to run as main module: entry path comparison failed');
  console.error(`  import.meta.url → ${thisFile}`);
  console.error(`  process.argv[1] → ${argvEntry}`);
  process.exit(1);
}
