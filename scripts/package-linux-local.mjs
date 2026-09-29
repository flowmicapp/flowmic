#!/usr/bin/env node
// Assemble Linux artifacts locally after a successful Tauri build.
//
// This is deliberately separate from publish.mjs: it reads build output and
// writes only under `.local/linux-artifacts/`. It does not run release gates,
// upload, deploy, update a manifest, or touch the shared `publish/` directory.
//
// Output shape:
//   .local/linux-artifacts/<version>/
//     *.deb      + sha256 sidecar
//     FlowMic-linux-x64/
//       flowmic-desktop          NR-107 launcher (libc only): checks libraries, execs ↓
//       .flowmic-desktop-bin     the real Tauri binary
//       node
//       NOTICE
//       README-LINUX.txt
//       resources/{server.js,package.json,node_modules/...}
//
// NR-114: the .deb Tauri built is rewritten to Debian package name `flowmic`
// (scripts/linux-deb-package-name.mjs says why Tauri cannot be told) BEFORE any
// check below reads it; every check and the staged copy use the rewritten file.
//
// NR-107: before anything is claimed as output, the runtime dependency gate
// (scripts/linux-runtime-deps-gate.mjs) reads the real binary's DT_NEEDED list
// and refuses when a library a stock Ubuntu 22.04 desktop lacks is missing from
// the .deb Depends, the launcher's check list, or README-LINUX.txt.
//     FlowMic-<version>-portable-linux-x64.zip + sha256 sidecar
//
// Run on Linux after `pnpm --filter @flowmic/desktop tauri:build`:
//   node scripts/package-linux-local.mjs
// When CARGO_TARGET_DIR is set, this script reads that release directory.

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLED_NODE } from './vendor/bundled-node.mjs';
import { STAMP_PREFIX } from './build-stamp/require-clean-sha.mjs';
import { assertNoDevCopy } from './linux-dev-copy-gate.mjs';
import { runLinuxRuntimeDepsGate } from './linux-runtime-deps-gate.mjs';
import { renameDebPackage } from './linux-deb-package-name.mjs';
import { LINUX_PORTABLE_REAL_EXE } from './linux-portable-modes.mjs';
import {
  LINUX_PORTABLE_DIR_NAME,
  packPortable,
  sidecarLine,
} from './pack-portable.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const LINUX_PLATFORM = 'linux-x64';
const OUTPUT_MARKER = '.flowmic-linux-artifacts.json';
const LINUX_RESOURCE_DIR = 'FlowMic';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} missing at ${path}`);
  }
  if (statSync(path).size === 0) throw new Error(`${label} is empty at ${path}`);
  return path;
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} missing at ${path}`);
  }
  return path;
}

export function findVersionedArtifact(dir, version, suffix) {
  requireDirectory(dir, `${suffix} bundle directory`);
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const artifactName = new RegExp(`(?:^|[-_])${escapedVersion}[-_]amd64${escapedSuffix}$`, 'i');
  const matches = readdirSync(dir)
    .filter((name) => artifactName.test(name))
    .sort();
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${version} ${suffix} in ${dir}, found ${matches.length}: ` +
        (matches.join(', ') || '(none)'),
    );
  }
  return requireFile(join(dir, matches[0]), `${suffix} artifact`);
}

export function verifyBuildStamp(executablePath, expectedBuildSha) {
  requireFile(executablePath, 'Linux release executable');
  if (!/^[0-9a-f]{40}$/.test(expectedBuildSha ?? '')) {
    throw new Error(`expected build sha must be 40 lowercase hex, got ${JSON.stringify(expectedBuildSha)}`);
  }
  const bytes = readFileSync(executablePath);
  const expected = `${STAMP_PREFIX}${expectedBuildSha}`;
  if (!bytes.includes(Buffer.from(expected))) {
    throw new Error(
      `Linux release executable does not carry current ${expected}; refusing an unstamped or stale binary`,
    );
  }
  for (const refused of [`${STAMP_PREFIX}unstamped-dev`, `${STAMP_PREFIX}nogit`, `${STAMP_PREFIX}dirty-`]) {
    if (bytes.includes(Buffer.from(refused))) {
      throw new Error(`Linux release executable carries refused build stamp ${refused}`);
    }
  }
  return expectedBuildSha;
}

function runExtractor(command, args, cwd, label) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed (${result.error?.message ?? `exit ${result.status}`}): ` +
        `${(result.stderr || result.stdout || '').trim()}`,
    );
  }
}

export function extractLinuxBundle(kind, artifactPath, destination) {
  if (process.platform !== 'linux') {
    throw new Error(`real Linux bundle extraction requires Linux, got ${process.platform}`);
  }
  const absoluteArtifact = resolve(artifactPath);
  if (kind === 'deb') {
    runExtractor('dpkg-deb', ['-x', absoluteArtifact, destination], destination, 'dpkg-deb extraction');
    return {
      executable: join(destination, 'usr', 'bin', 'flowmic-desktop'),
      node: join(destination, 'usr', 'lib', LINUX_RESOURCE_DIR, 'resources', 'node'),
      notice: join(destination, DEB_NOTICE_PATH),
    };
  }
  throw new Error(`unknown Linux bundle kind ${JSON.stringify(kind)}`);
}

function verifyArtifactPayload({
  kind,
  artifactPath,
  repoRoot,
  expectedBuildSha,
  pin,
  probeVersion,
  extractBundle,
  noticePath,
}) {
  const scratchRoot = join(repoRoot, '.local');
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, `linux-${kind}-inspect-`));
  try {
    const payload = extractBundle(kind, artifactPath, scratch);
    verifyBuildStamp(payload.executable, expectedBuildSha);
    if (kind === 'deb') {
      // NR-107: the .deb carries the same NOTICE the portable zip carries.
      requireFile(payload.notice ?? '', `.deb ${DEB_NOTICE_PATH}`);
      if (!readFileSync(payload.notice).equals(readFileSync(noticePath))) {
        throw new Error(`.deb ${DEB_NOTICE_PATH} differs from the repository NOTICE`);
      }
    }
    const node = verifyPinnedNode(payload.node, pin, probeVersion);
    return {
      executableSha256: sha256(payload.executable),
      nodeSha256: node.sha256,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function currentHead(repoRoot) {
  const value = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`git rev-parse HEAD returned invalid sha ${JSON.stringify(value)}`);
  return value;
}

function prepareOwnedOutput(outDir, version) {
  const marker = join(outDir, OUTPUT_MARKER);
  if (existsSync(outDir)) {
    const info = lstatSync(outDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`output path must be a real directory, not a link or file: ${outDir}`);
    }
    const entries = readdirSync(outDir);
    if (!existsSync(marker) && entries.length > 0) {
      throw new Error(`refusing non-empty output directory not created by this producer: ${outDir}`);
    }
    if (existsSync(marker)) {
      const recorded = JSON.parse(readFileSync(marker, 'utf8'));
      if (recorded.owner !== 'package-linux-local' || recorded.platform !== LINUX_PLATFORM || recorded.version !== version) {
        throw new Error(`output ownership marker does not match ${LINUX_PLATFORM} ${version}: ${marker}`);
      }
    }
  } else {
    mkdirSync(outDir, { recursive: true });
  }
  writeFileSync(marker, `${JSON.stringify({ owner: 'package-linux-local', platform: LINUX_PLATFORM, version })}\n`);
}

export function verifyPinnedNode(
  nodePath,
  pin = BUNDLED_NODE[LINUX_PLATFORM],
  probeVersion = (path) => execFileSync(path, ['--version'], { encoding: 'utf8' }).trim(),
) {
  requireFile(nodePath, 'staged Linux Node runtime');
  if (!pin) throw new Error(`no ${LINUX_PLATFORM} entry in scripts/vendor/bundled-node.mjs`);
  const measured = {
    version: probeVersion(nodePath),
    bytes: statSync(nodePath).size,
    sha256: sha256(nodePath),
  };
  const problems = [];
  if (measured.version !== pin.version) problems.push(`version=${measured.version}, declared=${pin.version}`);
  if (measured.bytes !== pin.bytes) problems.push(`bytes=${measured.bytes}, declared=${pin.bytes}`);
  if (measured.sha256 !== pin.sha256) problems.push(`sha256=${measured.sha256}, declared=${pin.sha256}`);
  if (problems.length > 0) {
    throw new Error(`staged Linux Node is not the pinned runtime: ${problems.join('; ')}`);
  }
  return measured;
}

export const LINUX_LAUNCHER_DIR = join('apps', 'desktop', 'linux-launcher');
/** Where the .deb carries the aggregate NOTICE (tauri.linux.conf.json bundle.linux.deb.files). */
export const DEB_NOTICE_PATH = join('usr', 'share', 'doc', 'flowmic', 'NOTICE');

/** Compile the NR-107 launcher with the build distro's C compiler. It must be
 *  compiled on the oldest glibc we support (the 22.04 build distro), and the
 *  runtime dependency gate then proves it links against libc only. */
export function buildLinuxLauncher({ source, output }) {
  const compiler = process.env.FLOWMIC_CC || 'cc';
  const result = spawnSync(
    compiler,
    ['-std=c11', '-O2', '-s', '-Wall', '-Wextra', '-Werror', '-Wl,--as-needed', '-o', output, source],
    { encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Linux launcher compile failed (${compiler}: ${result.error?.message ?? `exit ${result.status}`}): ` +
        `${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  return requireFile(output, 'compiled Linux launcher');
}

/** README-LINUX.txt with the release version filled in; refuses a template
 *  that still carries a placeholder after rendering. */
export function renderLinuxReadme(template, version) {
  const text = template.replaceAll('{{VERSION}}', version);
  if (/\{\{[A-Z_]+\}\}/.test(text)) throw new Error('README-LINUX.txt has an unrendered placeholder');
  return text;
}

function copyWithSidecar(source, outDir) {
  const name = basename(source);
  const destination = join(outDir, name);
  copyFileSync(source, destination);
  const hash = sha256(destination);
  writeFileSync(`${destination}.sha256`, sidecarLine(hash, name));
  return { name, path: destination, bytes: statSync(destination).size, sha256: hash };
}

export function stageLinuxArtifacts({
  repoRoot = REPO_ROOT,
  targetDir = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'target'),
  outDir,
  version,
  expectedBuildSha = currentHead(repoRoot),
  pin = BUNDLED_NODE[LINUX_PLATFORM],
  probeVersion,
  extractBundle = extractLinuxBundle,
  buildLauncher = buildLinuxLauncher,
  runtimeDepsGate = runLinuxRuntimeDepsGate,
  renameDeb = renameDebPackage,
  log = (message) => console.log(`· ${message}`),
}) {
  if (!outDir) throw new Error('outDir is required');
  if (!version) throw new Error('version is required');

  const releaseDir = join(targetDir, 'release');
  const tauriDeb = findVersionedArtifact(join(releaseDir, 'bundle', 'deb'), version, '.deb');
  const executable = requireFile(join(releaseDir, 'flowmic-desktop'), 'Linux release executable');
  const resources = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'resources');
  const stagedNode = requireFile(join(resources, 'node'), 'staged Linux Node runtime');
  const serverJs = requireFile(join(resources, 'server.js'), 'staged server.js');
  const serverPackage = requireFile(join(resources, 'package.json'), 'staged resources/package.json');
  const nodeModules = requireDirectory(join(resources, 'node_modules'), 'staged resources/node_modules');
  const notice = requireFile(join(repoRoot, 'NOTICE'), 'repository NOTICE');

  verifyPinnedNode(stagedNode, pin, probeVersion);
  verifyBuildStamp(executable, expectedBuildSha);

  // NR-114: from here on `deb` is the rewritten file (same name, Package:
  // flowmic). The Tauri output in target/ is left as Tauri wrote it, so a
  // re-run starts from the same input.
  const renameRoot = join(repoRoot, '.local');
  mkdirSync(renameRoot, { recursive: true });
  const renameScratch = mkdtempSync(join(renameRoot, 'linux-deb-named-'));
  try {
    const deb = renameDeb({
      debPath: tauriDeb,
      outPath: join(renameScratch, basename(tauriDeb)),
      scratchRoot: renameRoot,
    });
    log(`set the .deb package name (${basename(deb)})`);
    return stageFromNamedDeb({
      repoRoot, version, expectedBuildSha, pin, probeVersion, extractBundle, buildLauncher,
      runtimeDepsGate, log, outDir, deb, executable, stagedNode, serverJs, serverPackage, nodeModules, notice,
    });
  } finally {
    rmSync(renameScratch, { recursive: true, force: true });
  }
}

function stageFromNamedDeb({
  repoRoot, version, expectedBuildSha, pin, probeVersion, extractBundle, buildLauncher,
  runtimeDepsGate, log, outDir, deb, executable, stagedNode, serverJs, serverPackage, nodeModules, notice,
}) {
  // NR-107 follow-up: the AppImage is no longer built or shipped. It needs
  // libfuse2, which a stock Ubuntu 22.04 desktop does not have, so it failed
  // silently exactly like the pre-NR-107 portable binary.
  //
  // Validate bytes INSIDE the deliverable. A same-version deb left
  // over from an earlier commit has a perfectly plausible filename, while the
  // adjacent release executable says nothing about what was already packed.
  // Tauri patches bundle-type metadata into each executable, so equality with
  // the adjacent executable is not a stable contract; the embedded source
  // stamp and exact Node pin are the two content identities that are.
  for (const [kind, artifactPath] of [['deb', deb]]) {
    const measured = verifyArtifactPayload({
      kind,
      artifactPath,
      repoRoot,
      expectedBuildSha,
      pin,
      probeVersion,
      extractBundle,
      noticePath: notice,
    });
    log(`verified ${kind} payload (exe ${measured.executableSha256.slice(0, 12)}…, node ${measured.nodeSha256.slice(0, 12)}…)`);
  }
  // NR-107: build the portable launcher and README, then run the runtime
  // dependency gate on the exact bytes that will ship, all BEFORE the output
  // directory is claimed — a red gate leaves nothing behind that looks shippable.
  const launcherSource = requireFile(join(repoRoot, LINUX_LAUNCHER_DIR, 'flowmic-launcher.c'), 'Linux launcher source');
  const readmeTemplate = requireFile(join(repoRoot, LINUX_LAUNCHER_DIR, 'README-LINUX.txt'), 'README-LINUX.txt template');
  const scratchRoot = join(repoRoot, '.local');
  mkdirSync(scratchRoot, { recursive: true });
  const launcherScratch = mkdtempSync(join(scratchRoot, 'linux-launcher-'));
  let launcherBytes;
  let readmeText;
  try {
    const launcher = buildLauncher({ source: launcherSource, output: join(launcherScratch, 'flowmic-desktop') });
    const readme = join(launcherScratch, 'README-LINUX.txt');
    readmeText = renderLinuxReadme(readFileSync(readmeTemplate, 'utf8'), version);
    writeFileSync(readme, readmeText);
    runtimeDepsGate({
      executable,
      node: stagedNode,
      resourcesDir: nodeModules,
      debPath: deb,
      launcherPath: launcher,
      launcherTarget: LINUX_PORTABLE_REAL_EXE,
      readmePath: readme,
      log,
    });
    launcherBytes = readFileSync(launcher);
    // No `DEV:` placeholder ships (linux-dev-copy-gate.mjs). Before the
    // output is claimed, like the dependency gate above.
    assertNoDevCopy('the Linux portable bundle', [
      { file: 'flowmic-desktop (launcher)', bytes: launcherBytes },
      { file: 'README-LINUX.txt', bytes: Buffer.from(readmeText, 'utf8') },
    ]);
  } finally {
    rmSync(launcherScratch, { recursive: true, force: true });
  }
  prepareOwnedOutput(outDir, version);

  const copied = [copyWithSidecar(deb, outDir)];
  for (const artifact of copied) log(`staged ${artifact.name} (${artifact.bytes} bytes)`);

  const portableDir = join(outDir, LINUX_PORTABLE_DIR_NAME);
  if (existsSync(portableDir)) {
    const portableInfo = lstatSync(portableDir);
    if (portableInfo.isSymbolicLink() || !portableInfo.isDirectory()) {
      throw new Error(`refusing to replace portable path that is not a real directory: ${portableDir}`);
    }
    rmSync(portableDir, { recursive: true, force: true });
  }
  mkdirSync(join(portableDir, 'resources'), { recursive: true });
  writeFileSync(join(portableDir, 'flowmic-desktop'), launcherBytes);
  copyFileSync(executable, join(portableDir, LINUX_PORTABLE_REAL_EXE));
  copyFileSync(stagedNode, join(portableDir, 'node'));
  copyFileSync(notice, join(portableDir, 'NOTICE'));
  writeFileSync(join(portableDir, 'README-LINUX.txt'), readmeText);
  copyFileSync(serverJs, join(portableDir, 'resources', 'server.js'));
  copyFileSync(serverPackage, join(portableDir, 'resources', 'package.json'));
  cpSync(nodeModules, join(portableDir, 'resources', 'node_modules'), {
    recursive: true,
    dereference: true,
  });
  if (process.platform !== 'win32') {
    chmodSync(join(portableDir, 'flowmic-desktop'), 0o755);
    chmodSync(join(portableDir, LINUX_PORTABLE_REAL_EXE), 0o755);
    chmodSync(join(portableDir, 'node'), 0o755);
  }

  // Re-check the COPIES that go into the archive. A correct staging source does
  // not prove a downstream copy completed intact.
  verifyPinnedNode(join(portableDir, 'node'), pin, probeVersion);
  verifyBuildStamp(join(portableDir, LINUX_PORTABLE_REAL_EXE), expectedBuildSha);
  const portable = packPortable({
    outDir,
    version,
    platform: LINUX_PLATFORM,
    dirName: LINUX_PORTABLE_DIR_NAME,
    log,
  });
  log(`staged ${portable.zipName} (${portable.size} bytes)`);
  return { deb: copied[0], portableDir, portable };
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== '--target-dir' && arg !== '--out-dir') {
      throw new Error(`unknown argument ${JSON.stringify(arg)}; expected --target-dir <path> or --out-dir <path>`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`);
    parsed[arg.slice(2).replace('-dir', 'Dir')] = resolve(value);
    i += 1;
  }
  return parsed;
}

function main(argv) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`Linux local packaging requires linux-x64, got ${process.platform}-${process.arch}`);
  }
  const args = parseArgs(argv);
  const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const targetDir = args.targetDir ?? resolve(process.env.CARGO_TARGET_DIR ?? join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'target'));
  const outDir = args.outDir ?? join(REPO_ROOT, '.local', 'linux-artifacts', version);
  const result = stageLinuxArtifacts({
    targetDir,
    outDir,
    version,
    log: (message) => console.log(`· ${message}`),
  });
  console.log(`LOCAL LINUX ARTIFACTS READY: ${outDir}`);
  console.log(`  deb: ${result.deb.name}`);
  console.log(`  portable: ${result.portable.zipName} (top-level ${LINUX_PORTABLE_DIR_NAME}/)`);
}

const thisFile = fileURLToPath(import.meta.url);
const argvEntry = process.argv[1] ? resolve(process.argv[1]) : null;
const sameEntry = (a, b) => {
  const canon = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const left = normalize(canon(a));
  const right = normalize(canon(b));
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};
if (argvEntry && sameEntry(thisFile, argvEntry)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`LOCAL LINUX PACKAGING FAILED: ${error.message}`);
    process.exit(1);
  }
}
