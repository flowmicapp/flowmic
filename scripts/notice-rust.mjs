// NR-135: release dependency union; metadata supplies attribution, Cargo tree
// excludes host build/proc-macro and dev dependencies (metadata unifies features).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { BUNDLED_NODE } from './vendor/bundled-node.mjs';

const TARGETS = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
};
const FEATURES = 'app,tauri/custom-protocol'; // tauri build --features app
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const normalize = (text) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const crateKey = (pkg) => `${pkg.name}@${pkg.version}`;
const isLicense = (file) => /^(LICEN[SC]E|COPYING)(?:$|[-_.])/i.test(basename(file));
const isNotice = (file) => /^(NOTICE|COPYRIGHT)(?:$|[-_.])/i.test(basename(file));

export function releasePackages(metadata, tree) {
  const packages = new Map();
  for (const pkg of metadata.packages) {
    const key = crateKey(pkg);
    if (packages.has(key)) throw new Error(`Ambiguous Cargo package: ${key}`);
    packages.set(key, pkg);
  }
  const selected = new Map();
  for (const line of tree.trim().split(/\r?\n/)) {
    const match = /^(\S+) v(\S+)(?: |$)/.exec(line);
    if (!match) throw new Error(`Unexpected cargo tree row: ${line}`);
    const key = `${match[1]}@${match[2]}`;
    const pkg = packages.get(key);
    if (!pkg) throw new Error(`Cargo metadata missing ${key}`);
    if (pkg.id === metadata.resolve.root) continue;
    if (!pkg.source?.startsWith('registry+')) {
      throw new Error(`Review non-registry dependency before adding its licenses: ${key}`);
    }
    selected.set(key, pkg);
  }
  if (!selected.size) throw new Error('Empty Rust release dependency graph');
  return [...selected.values()];
}

export function licenseFiles(pkgDir, declaredFile) {
  const files = new Set();
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Fixture/example code is not part of the release library.
        if (!['tests', 'test', 'benches', 'examples', '.git'].includes(entry.name)) walk(file);
      } else if (entry.isFile() && (isLicense(file) || isNotice(file)) &&
                 !/\.(rs|c|h|py|toml|json|stderr)$/i.test(file)) {
        files.add(file);
      }
    }
  }
  walk(pkgDir);
  if (declaredFile) files.add(join(pkgDir, declaredFile));
  return [...files].sort(compare);
}

export function readCrateLicenses(pkg, vendorDir, sources) {
  const key = crateKey(pkg);
  const pkgDir = dirname(pkg.manifest_path);
  const files = licenseFiles(pkgDir, pkg.license_file);
  const result = files.map((file) => ({
    source: relative(pkgDir, file).replaceAll('\\', '/'),
    text: normalize(readFileSync(file, 'utf8')),
  }));
  const fallback = sources[key];
  if (fallback) {
    const vcs = JSON.parse(readFileSync(join(pkgDir, '.cargo_vcs_info.json'), 'utf8'));
    if (vcs.git.sha1 !== fallback.revision) throw new Error(`License source revision changed: ${key}`);
    for (const file of fallback.files) {
      const bytes = readFileSync(join(vendorDir, file.file));
      if (digest(bytes) !== file.sha256) throw new Error(`Vendored license checksum mismatch: ${file.file}`);
      result.push({ source: file.url, text: normalize(bytes.toString('utf8')) });
    }
  }
  if (pkg.name === 'webview2-com-sys' &&
      !result.some((file) => file.source.includes('microsoft.web.webview2/') &&
        file.source.endsWith('#LICENSE.txt') && file.text.includes('Copyright (C) Microsoft Corporation.'))) {
    throw new Error(`Missing Microsoft WebView2 SDK loader license for ${key}`);
  }
  if (!files.some((file) => isLicense(file) || (pkg.license_file && file === join(pkgDir, pkg.license_file))) && !fallback?.files.length) {
    throw new Error(`No license text for ${key}; vendor a pinned upstream copy in scripts/vendor/rust-licenses`);
  }
  if (result.some((file) => !file.text)) throw new Error(`Empty license/notice file for ${key}`);
  if (!pkg.license && !pkg.license_file) throw new Error(`No license metadata for ${key}`);
  return { files: result, note: fallback?.note };
}

export function renderRustLicenses(crates) {
  const texts = new Map();
  const entries = [...crates].sort((a, b) => compare(crateKey(a), crateKey(b))).map((pkg) => {
    const refs = pkg.files.map((file) => {
      const text = normalize(file.text);
      // Normalize line endings and trailing/outer whitespace; retain all wording.
      const hash = digest(text);
      texts.set(hash, text);
      return `  ${file.source} -> SHA256 ${hash}`;
    }).sort(compare);
    return [
      `--- ${crateKey(pkg)} ---`,
      `License: ${pkg.license ?? pkg.license_file}`,
      `Authors: ${pkg.authors.length ? pkg.authors.join('; ') : '(not declared)'}`,
      `Targets: ${[...pkg.platforms].sort(compare).join(', ')}`,
      ...(pkg.note ? [pkg.note] : []),
      ...refs,
    ].join('\n');
  });
  const bodies = [...texts].sort(([a], [b]) => compare(a, b))
    .map(([hash, text]) => `--- SHA256 ${hash} ---\n\n${text}`);
  return `${entries.join('\n\n')}\n\n${bodies.join('\n\n')}\n`;
}

export function collectRustNotice(root) {
  const vendorDir = join(root, 'scripts', 'vendor', 'rust-licenses');
  const sources = JSON.parse(readFileSync(join(vendorDir, 'sources.json'), 'utf8'));
  const cwd = join(root, 'apps', 'desktop', 'src-tauri');
  const common = ['--locked', '--offline', '--features', FEATURES];
  const run = (args) => execFileSync('cargo', args, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const crates = new Map();
  const targets = Object.keys(BUNDLED_NODE).map((platform) => {
    if (!TARGETS[platform]) throw new Error(`Missing Rust NOTICE target for ${platform}`);
    return TARGETS[platform];
  }).sort(compare);
  for (const target of targets) {
    const metadata = JSON.parse(run(['metadata', '--format-version', '1', ...common, '--filter-platform', target]));
    const tree = run(['tree', ...common, '--target', target, '--edges', 'normal,no-proc-macro',
      '--prefix', 'none', '--format', '{p}', '--charset', 'ascii', '--color', 'never']);
    for (const pkg of releasePackages(metadata, tree)) {
      const key = crateKey(pkg);
      if (!crates.has(key)) crates.set(key, { ...pkg, ...readCrateLicenses(pkg, vendorDir, sources), platforms: [] });
      crates.get(key).platforms.push(target);
    }
  }
  return { count: crates.size, targets, body: renderRustLicenses([...crates.values()]) };
}
