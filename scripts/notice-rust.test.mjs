// NR-135: release membership, license-file completeness and deterministic dedup.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCrateLicenses, releasePackages, renderRustLicenses } from './notice-rust.mjs';

const local = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.local');
mkdirSync(local, { recursive: true });
const temp = mkdtempSync(join(local, 'notice-rust-'));
const pkg = (name, extra = {}) => ({
  id: name, name, version: '1.0.0', source: 'registry+https://example.invalid',
  license: 'MIT', authors: ['Upstream author'], manifest_path: join(temp, 'Cargo.toml'),
  license_file: null, ...extra,
});
try {
  const metadata = {
    resolve: { root: 'app' },
    packages: ['app', 'runtime', 'build-only', 'test-only', 'proc-macro', 'other-target'].map((name) => pkg(name)),
  };
  assert.deepEqual(releasePackages(metadata, 'app v1.0.0 (local)\nruntime v1.0.0\nruntime v1.0.0 (*)\n')
    .map((p) => p.name), ['runtime']);
  assert.throws(() => releasePackages(metadata, 'app v1.0.0\nmissing v1.0.0'), /metadata missing/);
  assert.throws(() => releasePackages(metadata, 'app v1.0.0'), /Empty Rust/);
  assert.throws(() => releasePackages({ ...metadata, packages: [pkg('runtime', { source: null })] },
    'runtime v1.0.0'), /non-registry/);

  assert.throws(() => readCrateLicenses(pkg('runtime'), temp, {}), /No license text/);
  writeFileSync(join(temp, 'LICENSE-MIT'), 'MIT fixture\r\nCopyright A\r\n');
  writeFileSync(join(temp, 'LICENSE-APACHE'), 'Apache fixture\n');
  writeFileSync(join(temp, 'NOTICE'), 'Upstream attribution\n');
  writeFileSync(join(temp, 'COPYRIGHT'), 'Additional copyright\n');
  writeFileSync(join(temp, 'copying.rs'), 'not a license');
  mkdirSync(join(temp, 'licenses'));
  writeFileSync(join(temp, 'licenses', 'COPYING.txt'), 'Nested license\n');
  const license = readCrateLicenses(pkg('runtime', { license: 'MIT OR Apache-2.0' }), temp, {});
  assert.equal(license.files.length, 5);
  assert.ok(license.files.some((f) => f.source === 'NOTICE' && f.text === 'Upstream attribution'));
  assert.ok(license.files.some((f) => f.source === 'licenses/COPYING.txt'));
  const crates = ['b', 'a'].map((name) => ({ ...pkg(name), ...license, platforms: ['z-target', 'a-target'] }));
  const text = renderRustLicenses(crates);
  assert.equal(text, renderRustLicenses([...crates].reverse()));
  assert.equal((text.match(/MIT fixture/g) ?? []).length, 1);
  assert.equal((text.match(/Upstream attribution/g) ?? []).length, 1);
  assert.ok(text.indexOf('--- a@') < text.indexOf('--- b@'));
  assert.ok(text.includes('Authors: Upstream author'));
  assert.ok(!text.includes(temp));
  crates[0].files = [{ source: 'LICENSE', text: 'MIT fixture\nCopyright B' }];
  assert.equal((renderRustLicenses(crates).match(/MIT fixture/g) ?? []).length, 2);

  writeFileSync(join(temp, '.cargo_vcs_info.json'), JSON.stringify({ git: { sha1: 'revision' } }));
  const fallback = { 'runtime@1.0.0': { revision: 'wrong', files: [] } };
  assert.throws(() => readCrateLicenses(pkg('runtime'), temp, fallback), /revision changed/);
  fallback['runtime@1.0.0'] = { revision: 'revision', files: [{ file: 'NOTICE', url: 'upstream', sha256: 'wrong' }] };
  assert.throws(() => readCrateLicenses(pkg('runtime'), temp, fallback), /checksum mismatch/);
  fallback['runtime@1.0.0'].files[0].sha256 = createHash('sha256').update('Upstream attribution\n').digest('hex');
  assert.equal(readCrateLicenses(pkg('runtime'), temp, fallback).files.length, 6);
  const webview = pkg('webview2-com-sys', { version: '0.38.2' });
  assert.throws(() => readCrateLicenses(webview, temp, {}), /Missing Microsoft WebView2/);
  const realSources = JSON.parse(readFileSync(join(local, '..', 'scripts/vendor/rust-licenses/sources.json'), 'utf8'));
  const sdk = realSources['webview2-com-sys@0.38.2'];
  const sdkFiles = sdk.files.filter((file) => file.url.includes('microsoft.web.webview2/'));
  assert.equal(sdkFiles.length, 2);
  const pinned = { 'webview2-com-sys@0.38.2': { ...sdk, revision: 'revision', files: sdkFiles } };
  const attributed = readCrateLicenses(webview, join(local, '..', 'scripts/vendor/rust-licenses'), pinned);
  const rendered = renderRustLicenses([{ ...webview, ...attributed, platforms: ['x86_64-pc-windows-msvc'] }]);
  assert.ok(rendered.includes('Copyright (C) Microsoft Corporation. All rights reserved.'));
  assert.ok(rendered.includes('Redistributions in binary form must reproduce'));
  assert.ok(rendered.includes('NOTICES AND INFORMATION'));
  console.log('PASS NR-135: release membership, upstream notices, missing/revised sources, deterministic license dedup');
} finally {
  if (!resolve(temp).startsWith(`${local}${sep}`)) throw new Error('Unexpected fixture path');
  rmSync(temp, { recursive: true, force: true });
}
