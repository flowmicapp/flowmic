// NR-114 — the Debian package name of the Linux .deb is `flowmic`.
//
// WHY THIS EXISTS [owner report 2026-09-27, Ubuntu 22.04, `sudo apt install
// ./FlowMic_0.3.96_amd64.deb`]: the install worked, but the package was called
// `flow-mic`, so uninstalling meant `sudo apt remove flow-mic`.
//
// Where `flow-mic` comes from: tauri-bundler writes the control file's
// `Package:` line from the product name, kebab-cased, with no config key to
// override it. Source, tauri-cli v2.11.4 (the CLI this repo pins):
//   crates/tauri-bundler/src/bundle/linux/debian.rs, fn generate_control_file:
//     let package = heck::AsKebabCase(settings.product_name());
//     writeln!(file, "Package: {package}")?;
// and "FlowMic" kebab-cases to "flow-mic". The Tauri v2 config schema
// (@tauri-apps/cli config.schema.json, DebConfig) has depends / recommends /
// provides / conflicts / replaces / files / section / priority / changelog /
// desktopTemplate / the four maintainer scripts, and no package-name key.
// Changing productName instead would also rename the menu entry, the
// /usr/lib/<productName> resource directory the app resolves at runtime, and
// the Windows and macOS bundles.
//
// So the Linux packaging step (package-linux-local.mjs) rewrites ONE control
// line after Tauri has built the .deb: `dpkg-deb -R` -> set `Package:` ->
// `dpkg-deb -b`. The payload is repacked from the raw extraction: the same
// paths, modes, owners and file bytes, and the same md5sums, so the installed
// binary path, the menu entry, the icons and /usr/lib/FlowMic are what Tauri
// produced [measured 2026-09-27 on the 0.3.96 build: `dpkg-deb -x` of both
// trees `diff -r` identical]. Only the tar framing changes: dpkg-deb names
// entries `./usr/...` where Tauri wrote `usr/...`. Every later check (build stamp, NOTICE,
// Node pin, runtime dependency gate, the Package-name gate below) reads the
// rewritten file, which is the file that ships.
//
// Upgrade from the 0.3.96 `flow-mic` package: both packages own the same
// files, so the new one declares `Conflicts` + `Replaces` + `Provides:
// flow-mic` (the standard Debian rename; tauri.linux.conf.json
// bundle.linux.deb, which Tauri does support). The gate below insists on
// all three, because without them `apt install ./FlowMic_<v>_amd64.deb` on
// the owner's machine stops on a file conflict.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The Debian package name every FlowMic .deb must carry. */
export const DEB_PACKAGE_NAME = 'flowmic';
/** The name Tauri derives from productName "FlowMic"; 0.3.96 shipped under it. */
export const LEGACY_DEB_PACKAGE_NAME = 'flow-mic';

/** Parse a Debian control paragraph into { Field: value } (continuation lines joined with \n). */
export function parseDebControl(text) {
  const fields = {};
  let current = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      fields[current] += `\n${line}`;
      continue;
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
    if (match) {
      current = match[1];
      fields[current] = match[2];
    } else {
      current = null;
    }
  }
  return fields;
}

/** Package names in a relationship field (Depends/Conflicts/Replaces/Provides). */
export function relationPackages(field) {
  const packages = new Set();
  for (const clause of String(field ?? '').split(',')) {
    for (const alternative of clause.split('|')) {
      const name = alternative.trim().replace(/\s*\(.*\)\s*$/, '').replace(/:[a-z0-9-]+$/, '').trim();
      if (name) packages.add(name);
    }
  }
  return packages;
}

/** Return `controlText` with its single `Package:` line set to `name`. */
export function setDebControlPackage(controlText, name = DEB_PACKAGE_NAME) {
  const lines = String(controlText).split('\n');
  const at = lines.flatMap((line, i) => (/^Package:/.test(line) ? [i] : []));
  if (at.length !== 1) throw new Error(`.deb control has ${at.length} Package: lines, expected exactly one`);
  lines[at[0]] = `Package: ${name}`;
  return lines.join('\n');
}

/**
 * Pure verdict on the identity fields of the .deb that ships. Returns problems.
 * `fields` = parseDebControl(<the final .deb's control>).
 */
export function debIdentityProblems(fields, { name = DEB_PACKAGE_NAME, legacy = LEGACY_DEB_PACKAGE_NAME } = {}) {
  const problems = [];
  if (fields?.Package !== name) {
    problems.push(`.deb Package is ${JSON.stringify(fields?.Package ?? null)}, expected ${JSON.stringify(name)} (NR-114)`);
  }
  for (const field of ['Conflicts', 'Replaces', 'Provides']) {
    if (!relationPackages(fields?.[field]).has(legacy)) {
      problems.push(`.deb ${field} does not name ${legacy}: an installed 0.3.96 ${legacy} would block the upgrade (NR-114)`);
    }
  }
  return problems;
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed (${result.error?.message ?? `exit ${result.status}`}): ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  return result.stdout;
}

/** Real `dpkg-deb -f <deb>`: the whole control paragraph of a built .deb. */
export function readDebControlWithDpkg(debPath) {
  return run('dpkg-deb', ['-f', resolve(debPath)], `dpkg-deb -f ${debPath}`);
}

/**
 * Write a copy of `debPath` at `outPath` whose control `Package:` is `name`.
 * The data archive is re-packed from the raw extraction, unchanged.
 */
export function renameDebPackage({ debPath, outPath, scratchRoot, name = DEB_PACKAGE_NAME }) {
  if (process.platform !== 'linux') throw new Error(`rewriting a .deb requires Linux, got ${process.platform}`);
  if (existsSync(outPath)) throw new Error(`refusing to overwrite ${outPath}`);
  const scratch = mkdtempSync(join(scratchRoot, 'linux-deb-rename-'));
  try {
    const tree = join(scratch, 'tree');
    run('dpkg-deb', ['-R', resolve(debPath), tree], 'dpkg-deb -R');
    const control = join(tree, 'DEBIAN', 'control');
    writeFileSync(control, setDebControlPackage(readFileSync(control, 'utf8'), name));
    // dpkg-deb -b checks these modes; a tree under DrvFS reads back as 0777.
    chmodSync(join(tree, 'DEBIAN'), 0o755);
    chmodSync(control, 0o644);
    // gzip: the compression Tauri itself writes, readable by every dpkg.
    run('dpkg-deb', ['--root-owner-group', '-Zgzip', '-b', tree, resolve(outPath)], 'dpkg-deb -b');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return outPath;
}
