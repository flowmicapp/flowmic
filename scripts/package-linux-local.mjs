#!/usr/bin/env node
// Assemble Linux artifacts locally after a successful Tauri build.
//
// This is deliberately separate from publish.mjs: it reads build output and
// writes only under `.local/linux-artifacts/`. It does not run release gates,
// upload, deploy, update a manifest, or touch the shared `publish/` directory.
//
// Output shape:
//   .local/linux-artifacts/<version>/
//     *.AppImage + sha256 sidecar
//     *.deb      + sha256 sidecar
//     FlowMic-linux-x64/
//       flowmic-desktop
//       node
//       NOTICE
//       resources/{server.js,package.json,node_modules/...}
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

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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

function validateAppImageHeader(path) {
  const header = readFileSync(path).subarray(0, 11);
  const elf = header.length === 11 && header[0] === 0x7f && header.subarray(1, 4).toString('ascii') === 'ELF';
  const type2 = header[8] === 0x41 && header[9] === 0x49 && header[10] === 0x02;
  if (!elf || !type2) {
    throw new Error(`${path} is not an ELF AppImage type 2 (missing ELF / AI\\x02 header)`);
  }
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
    };
  }
  if (kind === 'appimage') {
    validateAppImageHeader(absoluteArtifact);
    // The type-2 runtime forwards one optional pattern to unsquashfs. Extract
    // only the two delivery bytes we must attest instead of expanding the full
    // 150+ MiB bundle. The artifact itself is already executable after Tauri.
    for (const pattern of [
      'usr/bin/flowmic-desktop',
      `usr/lib/${LINUX_RESOURCE_DIR}/resources/node`,
    ]) {
      runExtractor(absoluteArtifact, ['--appimage-extract', pattern], destination, `AppImage extraction of ${pattern}`);
    }
    const root = join(destination, 'squashfs-root');
    return {
      executable: join(root, 'usr', 'bin', 'flowmic-desktop'),
      node: join(root, 'usr', 'lib', LINUX_RESOURCE_DIR, 'resources', 'node'),
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
  stagedNodePath,
  extractBundle,
}) {
  const scratchRoot = join(repoRoot, '.local');
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, `linux-${kind}-inspect-`));
  try {
    const payload = extractBundle(kind, artifactPath, scratch);
    verifyBuildStamp(payload.executable, expectedBuildSha);
    const node =
      kind === 'appimage'
        ? verifyAppImageNode(payload.node, stagedNodePath, pin, probeVersion)
        : verifyPinnedNode(payload.node, pin, probeVersion);
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

function readElf64Section(path, wantedName) {
  const elf = readFileSync(path);
  if (
    elf.length < 64 ||
    elf[0] !== 0x7f ||
    elf.subarray(1, 4).toString('ascii') !== 'ELF' ||
    elf[4] !== 2 ||
    elf[5] !== 1
  ) {
    throw new Error(`${path} is not a little-endian ELF64 binary`);
  }
  const sectionOffset = Number(elf.readBigUInt64LE(0x28));
  const sectionEntrySize = elf.readUInt16LE(0x3a);
  const sectionCount = elf.readUInt16LE(0x3c);
  const namesIndex = elf.readUInt16LE(0x3e);
  const headerAt = (index) => sectionOffset + index * sectionEntrySize;
  const sectionRange = (index) => {
    const header = headerAt(index);
    if (header < 0 || header + 40 > elf.length) throw new Error(`${path} has an invalid ELF section table`);
    return {
      nameOffset: elf.readUInt32LE(header),
      offset: Number(elf.readBigUInt64LE(header + 24)),
      size: Number(elf.readBigUInt64LE(header + 32)),
    };
  };
  if (sectionEntrySize < 64 || namesIndex >= sectionCount) throw new Error(`${path} has an invalid ELF64 header`);
  const names = sectionRange(namesIndex);
  const namesEnd = names.offset + names.size;
  if (names.offset < 0 || namesEnd > elf.length) throw new Error(`${path} has an invalid ELF section-name table`);
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionRange(index);
    const nameStart = names.offset + section.nameOffset;
    let nameEnd = nameStart;
    while (nameEnd < namesEnd && elf[nameEnd] !== 0) nameEnd += 1;
    if (elf.subarray(nameStart, nameEnd).toString('ascii') !== wantedName) continue;
    const end = section.offset + section.size;
    if (section.offset < 0 || end > elf.length) throw new Error(`${path} has an invalid ${wantedName} section`);
    return elf.subarray(section.offset, end);
  }
  throw new Error(`${path} has no ${wantedName} ELF section`);
}

export function verifyAppImageNode(nodePath, stagedNodePath, pin, probeVersion) {
  const probe = probeVersion ?? ((path) => execFileSync(path, ['--version'], { encoding: 'utf8' }).trim());
  const absoluteNode = resolve(nodePath);
  const absoluteStagedNode = resolve(stagedNodePath);
  try {
    return verifyPinnedNode(absoluteNode, pin, probe);
  } catch (exactError) {
    // linuxdeploy legitimately rewrites ELF loader/RPATH metadata inside an
    // AppImage. The real L-8 output is 4 KiB larger and cannot retain the
    // upstream whole-file hash. Refuse a version-only claim: both large code
    // and immutable-data sections must remain byte-identical to the exact
    // pinned staging source checked immediately before artifact inspection.
    const version = probe(absoluteNode);
    if (version !== pin.version) throw exactError;
    for (const section of ['.text', '.rodata']) {
      const stagedHash = sha256Bytes(readElf64Section(absoluteStagedNode, section));
      const bundledHash = sha256Bytes(readElf64Section(absoluteNode, section));
      if (bundledHash !== stagedHash) {
        throw new Error(
          `AppImage Node ${section} does not match the pinned staging runtime: ` +
            `bundled=${bundledHash} staged=${stagedHash}; whole-file check said ${exactError.message}`,
        );
      }
    }
    return {
      version,
      bytes: statSync(absoluteNode).size,
      sha256: sha256(absoluteNode),
      transformedByLinuxdeploy: true,
    };
  }
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
  log = (message) => console.log(`· ${message}`),
}) {
  if (!outDir) throw new Error('outDir is required');
  if (!version) throw new Error('version is required');

  const releaseDir = join(targetDir, 'release');
  const appImage = findVersionedArtifact(join(releaseDir, 'bundle', 'appimage'), version, '.AppImage');
  const deb = findVersionedArtifact(join(releaseDir, 'bundle', 'deb'), version, '.deb');
  const executable = requireFile(join(releaseDir, 'flowmic-desktop'), 'Linux release executable');
  const resources = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'resources');
  const stagedNode = requireFile(join(resources, 'node'), 'staged Linux Node runtime');
  const serverJs = requireFile(join(resources, 'server.js'), 'staged server.js');
  const serverPackage = requireFile(join(resources, 'package.json'), 'staged resources/package.json');
  const nodeModules = requireDirectory(join(resources, 'node_modules'), 'staged resources/node_modules');
  const notice = requireFile(join(repoRoot, 'NOTICE'), 'repository NOTICE');

  verifyPinnedNode(stagedNode, pin, probeVersion);
  verifyBuildStamp(executable, expectedBuildSha);
  // Validate bytes INSIDE both deliverables. A same-version AppImage/deb left
  // over from an earlier commit has a perfectly plausible filename, while the
  // adjacent release executable says nothing about what was already packed.
  // Tauri patches bundle-type metadata into each executable, so equality with
  // the adjacent executable is not a stable contract; the embedded source
  // stamp and exact Node pin are the two content identities that are.
  for (const [kind, artifactPath] of [['deb', deb], ['appimage', appImage]]) {
    const measured = verifyArtifactPayload({
      kind,
      artifactPath,
      repoRoot,
      expectedBuildSha,
      pin,
      probeVersion,
      stagedNodePath: stagedNode,
      extractBundle,
    });
    log(`verified ${kind} payload (exe ${measured.executableSha256.slice(0, 12)}…, node ${measured.nodeSha256.slice(0, 12)}…)`);
  }
  prepareOwnedOutput(outDir, version);

  const copied = [copyWithSidecar(appImage, outDir), copyWithSidecar(deb, outDir)];
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
  copyFileSync(executable, join(portableDir, 'flowmic-desktop'));
  copyFileSync(stagedNode, join(portableDir, 'node'));
  copyFileSync(notice, join(portableDir, 'NOTICE'));
  copyFileSync(serverJs, join(portableDir, 'resources', 'server.js'));
  copyFileSync(serverPackage, join(portableDir, 'resources', 'package.json'));
  cpSync(nodeModules, join(portableDir, 'resources', 'node_modules'), {
    recursive: true,
    dereference: true,
  });
  if (process.platform !== 'win32') {
    chmodSync(join(portableDir, 'flowmic-desktop'), 0o755);
    chmodSync(join(portableDir, 'node'), 0o755);
  }

  // Re-check the COPY that goes into the archive. A correct staging source does
  // not prove a downstream copy completed intact.
  verifyPinnedNode(join(portableDir, 'node'), pin, probeVersion);
  const portable = packPortable({
    outDir,
    version,
    platform: LINUX_PLATFORM,
    dirName: LINUX_PORTABLE_DIR_NAME,
    log,
  });
  log(`staged ${portable.zipName} (${portable.size} bytes)`);
  return { appImage: copied[0], deb: copied[1], portableDir, portable };
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
  console.log(`  AppImage: ${result.appImage.name}`);
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
