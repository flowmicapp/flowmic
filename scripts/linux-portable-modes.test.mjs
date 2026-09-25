// Real bsdtar archive drill for Linux mode normalization, including the actual
// packPortable platform branch. Independent central-directory inspection and
// bsdtar listing/extraction are the oracles, never the normalizer's own parser.
// Temporary files stay in this checkout's .local. No builds or publish calls.
// Run: node scripts/linux-portable-modes.test.mjs
// Missing archiver is an explicit SKIP (2), not a successful product check.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLinuxPortableModes } from './linux-portable-modes.mjs';
import { packPortable, readZipEntries, resolveArchiver } from './pack-portable.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.local');
mkdirSync(root, { recursive: true });
let archiver;
try { archiver = resolveArchiver(); } catch (error) {
  console.log(`SKIP: real bsdtar unavailable: ${error.message}`);
  process.exit(2);
}
const temp = mkdtempSync(join(root, 'linux-portable-modes-'));
const dirName = 'FlowMic-linux-x64';
const bundle = join(temp, dirName);
const contents = new Map([
  ['flowmic-desktop', 'fixture executable\n'], ['node', 'fixture runtime\n'],
  ['NOTICE', 'readable notice\n'], ['resources/node', 'nested node is not executable\n'],
  ['resources/server.js', 'console.log("fixture");\n'], ['resources/测试.txt', 'unicode path\n'],
]);
const hash = (buf) => createHash('sha256').update(buf).digest('hex');

// This small independent reader exposes byte offsets and raw attributes only;
// it does not import, copy or call the normalizer's validation/classification.
function inspect(buf) {
  const end = buf.lastIndexOf(Buffer.from('504b0506', 'hex'));
  assert.ok(end >= 0);
  let cursor = buf.readUInt32LE(end + 16);
  const start = cursor;
  const rows = [];
  while (cursor < end) {
    assert.equal(buf.readUInt32LE(cursor), 0x02014b50);
    const length = buf.readUInt16LE(cursor + 28);
    rows.push({ offset: cursor, name: buf.toString('utf8', cursor + 46, cursor + 46 + length),
      creator: buf[cursor + 5], attrs: buf.readUInt32LE(cursor + 38),
      mode: buf.readUInt32LE(cursor + 38) >>> 16, local: buf.readUInt32LE(cursor + 42) });
    cursor += 46 + length + buf.readUInt16LE(cursor + 30) + buf.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  return { end, start, rows };
}

try {
  mkdirSync(join(bundle, 'resources'), { recursive: true });
  for (const [rel, body] of contents) {
    writeFileSync(join(bundle, rel), body);
    chmodSync(join(bundle, rel), 0o777);
  }
  chmodSync(bundle, 0o777);
  chmodSync(join(bundle, 'resources'), 0o777);
  if (process.platform === 'linux') {
    for (const rel of contents.keys()) assert.equal(statSync(join(bundle, rel)).mode & 0o777, 0o777);
  }
  const rawPath = join(temp, 'raw.zip');
  execFileSync(archiver.path, ['-c', '--format', 'zip', '--options', 'zip:hdrcharset=UTF-8', '-f', rawPath, '-C', temp, dirName]);
  const raw = readFileSync(rawPath);
  const original = Buffer.from(raw);
  const before = inspect(raw);
  if (process.platform === 'linux') {
    assert.ok(before.rows.filter((row) => !row.name.endsWith('/')).every((row) => (row.mode & 0o777) === 0o777), 'real staged 0777 must reach the uncorrected ZIP');
    console.log('PASS Linux staging and raw bsdtar ZIP both independently measured 0777');
  }
  const normalized = normalizeLinuxPortableModes(raw, dirName);
  assert.deepEqual(raw, original, 'helper must not mutate caller input');
  assert.deepEqual(normalizeLinuxPortableModes(normalized, dirName), normalized, 'normalization is idempotent');
  const after = inspect(normalized);
  assert.deepEqual(readZipEntries(normalized), readZipEntries(raw));
  const allowedChanges = new Set(before.rows.flatMap((row) => [row.offset + 5, row.offset + 38, row.offset + 39, row.offset + 40, row.offset + 41]));
  assert.equal(normalized.length, raw.length);
  for (let i = 0; i < raw.length; i++) {
    if (!allowedChanges.has(i)) assert.equal(normalized[i], raw[i], `non-mode byte changed at ${i}`);
  }
  for (const row of after.rows) {
    const expected = row.name.endsWith('/') ? 0o040755
      : [`${dirName}/flowmic-desktop`, `${dirName}/node`].includes(row.name) ? 0o100755 : 0o100644;
    assert.equal(row.mode, expected, `independent mode read: ${row.name}`);
    assert.equal(row.creator, 3, 'UNIX creator');
    assert.equal(row.attrs & 0xffff, before.rows.find((r) => r.name === row.name).attrs & 0xffff, 'DOS bits preserved');
  }
  const normalizedPath = join(temp, 'normalized.zip');
  writeFileSync(normalizedPath, normalized);
  const listing = execFileSync(archiver.path, ['-tvf', normalizedPath], { encoding: 'utf8' });
  for (const row of after.rows) {
    if (/[^\x00-\x7f]/.test(row.name)) continue; // byte-level UTF-8 proof above; terminal encoding is not a pathname oracle.
    const line = listing.split('\n').find((line) => line.trimEnd().endsWith(row.name));
    assert.ok(line, `bsdtar lists ${row.name}`);
    assert.equal(line.slice(0, 10), row.name.endsWith('/') ? 'drwxr-xr-x' : row.mode === 0o100755 ? '-rwxr-xr-x' : '-rw-r--r--');
  }
  const extracted = join(temp, 'extracted');
  mkdirSync(extracted);
  execFileSync(archiver.path, ['-xf', normalizedPath, '-C', extracted]);
  for (const [rel, body] of contents) assert.equal(readFileSync(join(extracted, dirName, rel), 'utf8'), body);
  console.log('PASS real bsdtar: independent modes 0755/0644, creator UNIX, DOS bits and every other byte unchanged, extracted content identical');

  const linux = packPortable({ outDir: temp, version: '9.9.9', platform: 'linux-x64', dirName });
  const linuxBytes = readFileSync(linux.zipPath);
  assert.deepEqual(inspect(linuxBytes).rows.map(({ name, mode, creator }) => ({ name, mode, creator })),
    after.rows.map(({ name, mode, creator }) => ({ name, mode, creator })), 'production Linux branch must normalize archive');
  assert.equal(linux.hash, hash(linuxBytes));
  assert.equal(readFileSync(`${linux.zipPath}.sha256`, 'utf8'), `${hash(linuxBytes)}  ${linux.zipName}\n`);
  const windows = packPortable({ outDir: temp, version: '9.9.9', platform: 'windows-x64', dirName });
  const windowsRows = inspect(readFileSync(windows.zipPath)).rows;
  assert.deepEqual(windowsRows.map(({ name, creator, attrs }) => ({ name, creator, attrs })),
    before.rows.map(({ name, creator, attrs }) => ({ name, creator, attrs })), 'Windows platform preserves original archiver attributes');
  console.log('PASS production packPortable: Linux normalization precedes checksum; Windows platform ZIP retains raw modes');

  const file = before.rows.find((row) => row.name.endsWith('/NOTICE'));
  const mutate = (label, edit) => {
    const bad = Buffer.from(raw);
    edit(bad);
    const snapshot = Buffer.from(bad);
    assert.throws(() => normalizeLinuxPortableModes(bad, dirName), /Linux portable ZIP:/, label);
    assert.deepEqual(bad, snapshot, `refusal must be atomic: ${label}`);
  };
  mutate('EOCD comment overrun', (b) => b.writeUInt16LE(1, before.end + 20));
  mutate('multiple disks', (b) => b.writeUInt16LE(1, before.end + 4));
  mutate('ZIP64 EOCD', (b) => b.writeUInt32LE(0xffffffff, before.end + 12));
  mutate('bad table boundary', (b) => b.writeUInt32LE(1, before.end + 12));
  mutate('bad table count', (b) => b.writeUInt16LE(1, before.end + 10));
  mutate('bad table signature', (b) => b.writeUInt32LE(0, before.start));
  mutate('entry length overrun', (b) => b.writeUInt16LE(0xffff, file.offset + 30));
  mutate('ZIP64 per-entry offset', (b) => b.writeUInt32LE(0xffffffff, file.offset + 42));
  mutate('ZIP64 local entry size', (b) => b.writeUInt32LE(0xffffffff, file.local + 22));
  mutate('special file', (b) => b.writeUInt32LE((0o120777 << 16) >>> 0, file.offset + 38));
  mutate('file directory bit', (b) => b.writeUInt32LE((file.attrs | 0x10) >>> 0, file.offset + 38));
  mutate('local name mismatch', (b) => { b[file.local + 30] = 88; });
  mutate('unsafe slash', (b) => { b[file.offset + 46] = 47; });
  mutate('unsafe backslash', (b) => { b[file.offset + 46] = 92; });
  mutate('unsafe NUL', (b) => { b[file.offset + 46] = 0; });
  mutate('traversal', (b) => b.write('../', file.offset + 46));
  mutate('invalid UTF-8', (b) => { b[file.offset + 46] = 255; });
  mutate('local payload out of bounds', (b) => b.writeUInt32LE(0xfffffffe, file.offset + 20));
  mutate('ZIP64 extra', (b) => b.writeUInt16LE(1, file.offset + 46 + b.readUInt16LE(file.offset + 28)));
  mutate('alternate path extra', (b) => b.writeUInt16LE(0x7075, file.offset + 46 + b.readUInt16LE(file.offset + 28)));
  mutate('duplicate path', (b) => {
    const node = before.rows.find((row) => row.name === `${dirName}/node`);
    const name = Buffer.from(`${dirName}/node`);
    // NOTICE has two more bytes; retaining the original record extent with a
    // two-byte comment makes this a structurally sized duplicate, not an overrun.
    name.copy(b, file.offset + 46);
    b.copyWithin(file.offset + 46 + name.length, file.offset + 46 + name.length + 2,
      file.offset + 46 + b.readUInt16LE(file.offset + 28) + b.readUInt16LE(file.offset + 30));
    b.writeUInt16LE(name.length, file.offset + 28);
    b.writeUInt16LE(2, file.offset + 32);
    b.writeUInt32LE(node.local, file.offset + 42);
  });
  assert.throws(() => normalizeLinuxPortableModes(raw.subarray(0, 21), dirName), /not a classic ZIP/);
  assert.throws(() => normalizeLinuxPortableModes(raw, '../bad'), /invalid top-level/);
  console.log('PASS malformed classic ZIP, ZIP64, path and special-file refusals leave input untouched');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('PASS linux-portable-modes.test.mjs');
