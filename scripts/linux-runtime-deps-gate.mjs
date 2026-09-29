// NR-107 — the Linux runtime dependency gate.
//
// WHY THIS EXISTS [owner report 2026-09-25, stock Ubuntu 22.04 desktop, 0.3.95]:
//   double-clicking the portable `flowmic-desktop` did nothing at all; from a
//   terminal the loader said `libwebkit2gtk-4.1.so.0: cannot open shared object
//   file`. The binary's DT_NEEDED list names three libraries a stock 22.04 desktop
//   does not have (scripts/linux-runtime-libs.mjs has the measurement). The release
//   "smoke start" ran inside the WSL build distro, which has every -dev package
//   installed, so it proved nothing about a user's machine.
//
// WHAT IT CHECKS, before any Linux artifact is claimed as output:
//   every DT_NEEDED soname of the shipped ELF files (the real app binary, the
//   bundled node, the native addon libraries) is either
//     - provided inside the bundle (a sibling file of the same name), or
//     - stock on Ubuntu 22.04 desktop (STOCK_UBUNTU_2204_DESKTOP), or
//     - classified in NEEDS_INSTALL, AND then its apt package is
//         (a) a direct entry of the built .deb's `Depends`, and
//         (b) in the portable launcher's check list (the soname string is in the
//             launcher BINARY) and in its `sudo apt install` line, and
//         (c) in README-LINUX.txt's `sudo apt install` line.
//   An unclassified soname is red: guessing "probably stock" is how 0.3.95 shipped.
//   NR-114: the same read of the built .deb's control also has to say
//   `Package: flowmic` with Conflicts/Replaces/Provides naming `flow-mic`
//   (scripts/linux-deb-package-name.mjs has the why and the rule).
//   The launcher itself may link only against libc, or it could not start on the
//   machine it exists to explain.
//
// The core (`evaluateLinuxRuntimeDeps`) is pure so the drill can remove one entry
// and watch it go red; `runLinuxRuntimeDepsGate` does the file and dpkg reading.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { readElfNeeded } from './elf64.mjs';
import { debIdentityProblems, parseDebControl, readDebControlWithDpkg } from './linux-deb-package-name.mjs';
import {
  LAUNCHER_ALLOWED_NEEDED,
  NEEDS_INSTALL,
  STOCK_UBUNTU_2204_DESKTOP,
} from './linux-runtime-libs.mjs';

/** Package names from a Debian `Depends` field. Version constraints and
 *  architecture qualifiers are dropped; for an alternative (`a | b`) every
 *  branch counts, since either satisfies the relationship. */
export function parseDebDepends(field) {
  const packages = new Set();
  for (const clause of String(field ?? '').split(',')) {
    for (const alternative of clause.split('|')) {
      const name = alternative.trim().replace(/\s*\(.*\)\s*$/, '').replace(/:[a-z0-9-]+$/, '').trim();
      if (name) packages.add(name);
    }
  }
  return packages;
}

/** Packages named by every `sudo apt install …` line in a text or binary. */
export function extractInstallPackages(textOrBytes) {
  const text = Buffer.isBuffer(textOrBytes) ? textOrBytes.toString('latin1') : String(textOrBytes);
  const packages = new Set();
  for (const match of text.matchAll(/sudo apt install ([^\n\r\0"]+)/g)) {
    for (const word of match[1].trim().split(/\s+/)) {
      if (word && !word.startsWith('./') && !word.startsWith('-')) packages.add(word);
    }
  }
  return packages;
}

/** Does the binary carry `soname` as a complete NUL-terminated C string? */
export function binaryHasCString(bytes, value) {
  const needle = Buffer.from(`${value}\0`, 'latin1');
  for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1)) {
    const before = at === 0 ? 0 : bytes[at - 1];
    if (!/[A-Za-z0-9._+-]/.test(String.fromCharCode(before))) return true;
  }
  return false;
}

/**
 * Pure verdict. `elfFiles` = [{ label, needed: string[], bundled: Set<string> }].
 * Returns { problems: string[], nonStock: Map<soname, package> }.
 */
export function evaluateLinuxRuntimeDeps({
  elfFiles,
  debDepends,
  debFields,
  launcherBytes,
  launcherNeeded,
  launcherTarget,
  readmeText,
  stock = STOCK_UBUNTU_2204_DESKTOP,
  needsInstall = NEEDS_INSTALL,
  launcherAllowed = LAUNCHER_ALLOWED_NEEDED,
}) {
  const problems = [];
  if (!debFields) problems.push('the .deb control was not read (NR-114 package identity unchecked)');
  else problems.push(...debIdentityProblems(debFields));
  const nonStock = new Map();
  for (const file of elfFiles) {
    for (const soname of file.needed) {
      if (file.bundled?.has(soname) || stock.has(soname)) continue;
      const pkg = needsInstall.get(soname);
      if (!pkg) {
        problems.push(
          `${file.label} needs ${soname}, which is neither stock on Ubuntu 22.04 desktop nor classified — ` +
            'add it to scripts/linux-runtime-libs.mjs (STOCK only with the manifest as evidence)',
        );
        continue;
      }
      nonStock.set(soname, pkg);
    }
  }
  const launcherPackages = extractInstallPackages(launcherBytes);
  const readmePackages = extractInstallPackages(readmeText);
  if (launcherPackages.size === 0) problems.push('the launcher carries no `sudo apt install` line');
  if (readmePackages.size === 0) problems.push('README-LINUX.txt carries no `sudo apt install` line');
  for (const [soname, pkg] of nonStock) {
    if (!debDepends.has(pkg)) problems.push(`.deb Depends is missing ${pkg} (for ${soname})`);
    if (!binaryHasCString(launcherBytes, soname)) problems.push(`the launcher does not check ${soname}`);
    if (launcherPackages.size && !launcherPackages.has(pkg)) {
      problems.push(`the launcher's install line does not name ${pkg} (for ${soname})`);
    }
    if (readmePackages.size && !readmePackages.has(pkg)) {
      problems.push(`README-LINUX.txt's install line does not name ${pkg} (for ${soname})`);
    }
  }
  for (const soname of launcherNeeded) {
    if (!launcherAllowed.has(soname)) {
      problems.push(`the launcher links ${soname}; it may link only ${[...launcherAllowed].join(', ')}`);
    }
  }
  if (launcherTarget && !binaryHasCString(launcherBytes, launcherTarget)) {
    problems.push(`the launcher does not name the real binary ${launcherTarget}`);
  }
  return { problems, nonStock };
}

function isElf(path) {
  const head = Buffer.alloc(4);
  const fd = openSync(path, 'r');
  try {
    return readSync(fd, head, 0, 4, 0) === 4 && head[0] === 0x7f && head.subarray(1).toString('ascii') === 'ELF';
  } finally {
    closeSync(fd);
  }
}

/** Every ELF file under `dir` (native addons, their bundled libraries). */
function elfFilesUnder(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(so(\.\d+)*|node)$/.test(entry.name) && isElf(path)) found.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

/**
 * The gate as the Linux producer runs it. Throws with every problem listed;
 * returns the evaluation when green.
 */
export function runLinuxRuntimeDepsGate({
  executable,
  node,
  resourcesDir,
  debPath,
  launcherPath,
  launcherTarget,
  readmePath,
  readDebControl = readDebControlWithDpkg,
  log = () => {},
}) {
  for (const [label, path] of [['app binary', executable], ['bundled node', node], ['.deb', debPath],
    ['launcher', launcherPath], ['README-LINUX.txt', readmePath]]) {
    if (!path || !existsSync(path) || !statSync(path).isFile()) throw new Error(`runtime dependency gate: ${label} missing at ${path}`);
  }
  const elfFiles = [
    { label: basename(executable), needed: readElfNeeded(executable), bundled: new Set() },
    { label: 'bundled node', needed: readElfNeeded(node), bundled: new Set() },
  ];
  for (const path of elfFilesUnder(resourcesDir)) {
    elfFiles.push({
      label: path.slice(resourcesDir.length + 1),
      needed: readElfNeeded(path),
      bundled: new Set(readdirSync(dirname(path))),
    });
  }
  const launcherBytes = readFileSync(launcherPath);
  const debFields = parseDebControl(readDebControl(debPath));
  const verdict = evaluateLinuxRuntimeDeps({
    elfFiles,
    debDepends: parseDebDepends(debFields.Depends),
    debFields,
    launcherBytes,
    launcherNeeded: readElfNeeded(launcherBytes, 'launcher'),
    launcherTarget,
    readmeText: readFileSync(readmePath, 'utf8'),
  });
  if (verdict.problems.length > 0) {
    throw new Error(
      `Linux runtime dependency gate RED (${verdict.problems.length}):\n  - ${verdict.problems.join('\n  - ')}`,
    );
  }
  log(
    `runtime dependency gate green: ${elfFiles.length} ELF file(s); needs install on stock 22.04: ` +
      `${[...verdict.nonStock.keys()].join(', ') || '(none)'}; all in .deb Depends, launcher and README; ` +
      `.deb Package: ${debFields.Package} (replaces ${debFields.Replaces})`,
  );
  return verdict;
}
