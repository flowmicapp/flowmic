// Fixture-driven drill for the local-only Linux artifact producer.
// It writes only under this worktree's gitignored .local directory and never
// invokes publish.mjs, an uploader, a deployment script, or a real build.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  copyFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readZipEntries } from './pack-portable.mjs';
import {
  findVersionedArtifact,
  LINUX_PLATFORM,
  stageLinuxArtifacts,
  verifyBuildStamp,
  verifyPinnedNode,
} from './package-linux-local.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_ROOT = join(ROOT, '.local');
mkdirSync(TEST_ROOT, { recursive: true });
const temp = mkdtempSync(join(TEST_ROOT, 'linux-package-test-'));
let failures = 0;
const assertTrue = (condition, label) => {
  if (condition) console.log(`PASS ${label}`);
  else { console.log(`FAIL ${label}`); failures += 1; }
};
const put = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

try {
  const version = '9.8.7';
  const repo = join(temp, 'repo');
  const target = join(temp, 'target');
  const out = join(temp, 'out');
  const release = join(target, 'release');
  const resources = join(repo, 'apps', 'desktop', 'src-tauri', 'resources');
  const nodeBytes = Buffer.from('fixture-linux-node');
  const buildSha = 'a'.repeat(40);
  const staleBuildSha = 'b'.repeat(40);
  const pin = {
    version: 'v22.22.3',
    bytes: nodeBytes.length,
    sha256: digest(nodeBytes),
  };

  // NR-107 follow-up: a stale AppImage beside the deb must be ignored, not required or staged.
  put(join(release, 'bundle', 'appimage', `FlowMic_${version}_amd64.AppImage`), 'appimage-bytes');
  put(join(release, 'bundle', 'deb', `FlowMic_${version}_amd64.deb`), 'deb-bytes');
  put(join(release, 'flowmic-desktop'), `linux-executable flowmic-build-sha:${buildSha}`);
  put(join(resources, 'node'), nodeBytes);
  put(join(resources, 'server.js'), 'server');
  put(join(resources, 'package.json'), '{"type":"module"}\n');
  put(join(resources, 'node_modules', 'fixture', 'index.js'), 'module');
  put(join(repo, 'NOTICE'), 'notice');
  put(join(repo, 'apps', 'desktop', 'linux-launcher', 'flowmic-launcher.c'), 'int main(void) { return 0; }\n');
  put(join(repo, 'apps', 'desktop', 'linux-launcher', 'README-LINUX.txt'), 'Install ./FlowMic_{{VERSION}}_amd64.deb\n');
  // NR-107: the real compiler and the real gate are exercised on Linux by the
  // release build (and the gate by its own drill); here they are replaced by
  // recorders so the drill can assert they were called, with what, and when.
  const gateCalls = [];
  // NR-114: the real rewrite needs dpkg-deb (exercised on Linux by the stale-deb
  // case below and by scripts/linux-deb-package-name.test.mjs); elsewhere a
  // recorder copies the file so the drill can see which path every later step read.
  const renameCalls = [];
  const copyRename = ({ debPath, outPath }) => {
    renameCalls.push({ debPath, outPath, gateCallsBefore: gateCalls.length });
    copyFileSync(debPath, outPath);
    return outPath;
  };
  const fakeLauncher = ({ output }) => { put(output, 'fixture-launcher'); return output; };
  const recordingGate = (args) => {
    gateCalls.push({ ...args, outputClaimed: existsSync(join(out, '.flowmic-linux-artifacts.json')) });
  };

  assertTrue(LINUX_PLATFORM === 'linux-x64', 'platform token matches the manifest key');
  assertTrue(
    findVersionedArtifact(join(release, 'bundle', 'deb'), version, '.deb').endsWith('.deb'),
    'artifact discovery requires this version and suffix',
  );
  put(join(release, 'bundle', 'deb', 'FlowMic_9.8.70_amd64.deb'), 'stale-version');
  put(join(release, 'bundle', 'deb', `FlowMic_${version}_aarch64.deb`), 'wrong-arch');
  assertTrue(
    findVersionedArtifact(join(release, 'bundle', 'deb'), version, '.deb').endsWith(`_${version}_amd64.deb`),
    'artifact discovery rejects a version prefix and the wrong architecture',
  );

  assertTrue(
    verifyBuildStamp(join(release, 'flowmic-desktop'), buildSha) === buildSha,
    'release executable carries the expected FLOWMIC_BUILD_SHA stamp',
  );
  let staleBuildRefused = false;
  try {
    verifyBuildStamp(join(release, 'flowmic-desktop'), 'b'.repeat(40));
  } catch (error) {
    staleBuildRefused = /unstamped or stale/.test(error.message);
  }
  assertTrue(staleBuildRefused, 'reverse control: a stale release executable is refused');

  const measured = verifyPinnedNode(join(resources, 'node'), pin, () => pin.version);
  assertTrue(measured.sha256 === pin.sha256, 'positive control: fixture Node matches all pin fields');
  let wrongPinRefused = false;
  try {
    verifyPinnedNode(join(resources, 'node'), { ...pin, sha256: '0'.repeat(64) }, () => pin.version);
  } catch (error) {
    wrongPinRefused = /sha256=/.test(error.message);
  }
  assertTrue(wrongPinRefused, 'reverse control: a wrong declared hash is refused by name');

  if (process.platform === 'linux') {
    const debRoot = join(temp, 'stale-deb-root');
    put(
      join(debRoot, 'DEBIAN', 'control'),
      `Package: flowmic-fixture\nVersion: ${version}\nArchitecture: amd64\nMaintainer: test\nDescription: fixture\n`,
    );
    put(join(debRoot, 'usr', 'bin', 'flowmic-desktop'), `same-version-old-binary flowmic-build-sha:${staleBuildSha}`);
    put(join(debRoot, 'usr', 'lib', 'FlowMic', 'resources', 'node'), nodeBytes);
    const debPath = join(release, 'bundle', 'deb', `FlowMic_${version}_amd64.deb`);
    rmSync(debPath, { force: true });
    try {
      // DrvFS presents directories as 0777 even when chmod metadata is off;
      // --nocheck permits this synthetic control tree while still producing a
      // real ar/deb container that the production extractor must read.
      execFileSync('dpkg-deb', ['--build', '--nocheck', debRoot, debPath], { encoding: 'utf8' });
    } catch (error) {
      throw new Error(`fixture dpkg-deb failed: ${(error.stderr || error.stdout || error.message).trim()}`);
    }
    let staleDebRefused = false;
    try {
      stageLinuxArtifacts({
        repoRoot: repo,
        targetDir: target,
        outDir: join(temp, 'stale-deb-output'),
        version,
        expectedBuildSha: buildSha,
        pin,
        probeVersion: () => pin.version,
        log: () => {},
      });
    } catch (error) {
      staleDebRefused = /unstamped or stale/.test(error.message);
    }
    assertTrue(staleDebRefused, 'reverse control: same-version deb containing an older build stamp is refused');
    assertTrue(!existsSync(join(temp, 'stale-deb-output')), 'stale deb refusal happens before output ownership is claimed');
    put(debPath, 'deb-bytes');
  }

  const fixtureExtractor = (_kind, _artifactPath, destination) => {
    const executable = join(destination, 'usr', 'bin', 'flowmic-desktop');
    const bundledNode = join(destination, 'usr', 'lib', 'FlowMic', 'resources', 'node');
    mkdirSync(dirname(executable), { recursive: true });
    mkdirSync(dirname(bundledNode), { recursive: true });
    copyFileSync(join(release, 'flowmic-desktop'), executable);
    copyFileSync(join(resources, 'node'), bundledNode);
    const notice = join(destination, 'usr', 'share', 'doc', 'flowmic', 'NOTICE');
    mkdirSync(dirname(notice), { recursive: true });
    copyFileSync(join(repo, 'NOTICE'), notice);
    return { executable, node: bundledNode, notice };
  };

  const result = stageLinuxArtifacts({
    repoRoot: repo,
    targetDir: target,
    outDir: out,
    version,
    expectedBuildSha: buildSha,
    pin,
    probeVersion: () => pin.version,
    extractBundle: fixtureExtractor, renameDeb: copyRename,
    buildLauncher: fakeLauncher,
    runtimeDepsGate: recordingGate,
    log: () => {},
  });
  assertTrue(gateCalls.length === 1, 'NR-107: the runtime dependency gate ran exactly once');
  assertTrue(
    renameCalls.length === 1 && renameCalls[0].gateCallsBefore === 0 &&
      renameCalls[0].debPath === join(release, 'bundle', 'deb', `FlowMic_${version}_amd64.deb`),
    'NR-114: the package-name rewrite runs once, on the Tauri .deb, before the gate',
  );
  assertTrue(
    gateCalls[0]?.debPath === renameCalls[0]?.outPath && gateCalls[0].debPath !== renameCalls[0].debPath,
    'NR-114: the gate reads the rewritten .deb, not the Tauri output',
  );
  assertTrue(
    !readdirSync(join(repo, '.local')).some((n) => n.startsWith('linux-deb-named-')),
    'NR-114: the rewrite scratch directory is removed after staging',
  );
  assertTrue(gateCalls[0]?.outputClaimed === false, 'NR-107: the gate runs before the output directory is claimed');
  assertTrue(
    gateCalls[0]?.executable === join(release, 'flowmic-desktop') &&
      gateCalls[0]?.debPath.endsWith(`FlowMic_${version}_amd64.deb`) &&
      gateCalls[0]?.launcherTarget === '.flowmic-desktop-bin',
    'NR-107: the gate reads the real binary, the built .deb and the launcher target name',
  );
  assertTrue(!('appImage' in result) && !readdirSync(out).some((n) => /appimage/i.test(n)), 'NR-107: no AppImage is staged');
  assertTrue(existsSync(result.deb.path) && existsSync(`${result.deb.path}.sha256`), 'deb and sidecar staged');
  assertTrue(existsSync(result.portable.zipPath) && existsSync(`${result.portable.zipPath}.sha256`), 'portable zip and sidecar staged');

  const entries = readZipEntries(readFileSync(result.portable.zipPath)).map((entry) => entry.name);
  const expected = [
    'FlowMic-linux-x64/NOTICE',
    'FlowMic-linux-x64/README-LINUX.txt',
    'FlowMic-linux-x64/flowmic-desktop',
    'FlowMic-linux-x64/.flowmic-desktop-bin',
    'FlowMic-linux-x64/node',
    'FlowMic-linux-x64/resources/node_modules/fixture/index.js',
    'FlowMic-linux-x64/resources/package.json',
    'FlowMic-linux-x64/resources/server.js',
  ];
  for (const entry of expected) assertTrue(entries.includes(entry), `portable archive contains ${entry}`);
  const extractedLauncher = join(result.portableDir, 'flowmic-desktop');
  assertTrue(readFileSync(extractedLauncher, 'utf8') === 'fixture-launcher', 'NR-107: flowmic-desktop is the launcher');
  assertTrue(
    readFileSync(join(result.portableDir, '.flowmic-desktop-bin'), 'utf8').includes(`flowmic-build-sha:${buildSha}`),
    'NR-107: the real binary sits beside the launcher under its hidden name',
  );
  assertTrue(
    readFileSync(join(result.portableDir, 'README-LINUX.txt'), 'utf8').includes(`FlowMic_${version}_amd64.deb`),
    'NR-107: README-LINUX.txt carries the release version',
  );
  // NR-107 follow-up reverse control: a DEV: placeholder in the README is refused before output.
  const readmeTemplate = join(repo, 'apps', 'desktop', 'linux-launcher', 'README-LINUX.txt');
  const readmeGood = readFileSync(readmeTemplate, 'utf8');
  writeFileSync(readmeTemplate, 'DEV: placeholder sentence\n');
  let devRefused = false;
  const devOut = join(temp, 'dev-red-output');
  try {
    stageLinuxArtifacts({
      repoRoot: repo, targetDir: target, outDir: devOut, version, expectedBuildSha: buildSha, pin,
      probeVersion: () => pin.version, extractBundle: fixtureExtractor, renameDeb: copyRename, buildLauncher: fakeLauncher,
      runtimeDepsGate: recordingGate, log: () => {},
    });
  } catch (error) {
    devRefused = /DEV:` placeholder/.test(error.message) && /README-LINUX\.txt: DEV: placeholder sentence/.test(error.message);
  }
  writeFileSync(readmeTemplate, readmeGood);
  assertTrue(devRefused && !existsSync(devOut), 'NR-107 reverse control: a DEV: sentence in README-LINUX.txt is refused before any output exists');
  let launcherDevRefused = false;
  try {
    stageLinuxArtifacts({
      repoRoot: repo, targetDir: target, outDir: devOut, version, expectedBuildSha: buildSha, pin,
      probeVersion: () => pin.version, extractBundle: fixtureExtractor, renameDeb: copyRename,
      buildLauncher: ({ output }) => { put(output, Buffer.from('\0DEV: FlowMic cannot start\0')); return output; },
      runtimeDepsGate: recordingGate, log: () => {},
    });
  } catch (error) {
    launcherDevRefused = /flowmic-desktop \(launcher\): DEV: FlowMic cannot start/.test(error.message);
  }
  assertTrue(launcherDevRefused && !existsSync(devOut), 'NR-107 reverse control: a DEV: string in the launcher binary is refused');
  let gateRedLeavesNothing = false;
  const redOut = join(temp, 'gate-red-output');
  try {
    stageLinuxArtifacts({
      repoRoot: repo, targetDir: target, outDir: redOut, version, expectedBuildSha: buildSha, pin,
      probeVersion: () => pin.version, extractBundle: fixtureExtractor, renameDeb: copyRename, buildLauncher: fakeLauncher,
      runtimeDepsGate: () => { throw new Error('Linux runtime dependency gate RED (1)'); }, log: () => {},
    });
  } catch (error) {
    gateRedLeavesNothing = /gate RED/.test(error.message) && !existsSync(redOut);
  }
  assertTrue(gateRedLeavesNothing, 'NR-107 reverse control: a red gate stops staging before any output exists');
  let renameRedLeavesNothing = false;
  const renameRedOut = join(temp, 'rename-red-output');
  try {
    stageLinuxArtifacts({
      repoRoot: repo, targetDir: target, outDir: renameRedOut, version, expectedBuildSha: buildSha, pin,
      probeVersion: () => pin.version, extractBundle: fixtureExtractor, buildLauncher: fakeLauncher,
      renameDeb: () => { throw new Error('dpkg-deb -b failed (exit 2)'); },
      runtimeDepsGate: recordingGate, log: () => {},
    });
  } catch (error) {
    renameRedLeavesNothing = /dpkg-deb -b failed/.test(error.message) && !existsSync(renameRedOut);
  }
  assertTrue(renameRedLeavesNothing, 'NR-114 reverse control: a failed package-name rewrite stops staging before any output exists');
  assertTrue(
    entries.every((entry) => entry === 'FlowMic-linux-x64/' || entry.startsWith('FlowMic-linux-x64/')),
    'portable archive has exactly one documented top-level directory',
  );

  const foreignOut = join(temp, 'foreign-output');
  put(join(foreignOut, 'unrelated.txt'), 'keep');
  let foreignOutRefused = false;
  try {
    stageLinuxArtifacts({
      repoRoot: repo,
      targetDir: target,
      outDir: foreignOut,
      version,
      expectedBuildSha: buildSha,
      pin,
      probeVersion: () => pin.version,
      extractBundle: fixtureExtractor, renameDeb: copyRename,
      buildLauncher: fakeLauncher,
      runtimeDepsGate: recordingGate,
      log: () => {},
    });
  } catch (error) {
    foreignOutRefused = /not created by this producer/.test(error.message);
  }
  assertTrue(foreignOutRefused, 'unowned non-empty --out-dir is refused before recursive replacement');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`FAIL ${failures} assertion(s)`);
  process.exit(1);
}
console.log('PASS local Linux artifact producer');
