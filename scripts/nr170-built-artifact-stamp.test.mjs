// Drill for scripts/build-stamp/verify-built-artifact.mjs — card NR-170.
//
// The claim under drill: `make release` / `release-store` / `release-ios` end
// with a reader that FAILS the target when any compiled Dart library inside the
// artifact is not from this tree's commit - the 0.3.107 state (an APK whose
// libapp.so were two days old, build exit 0) - and passes when they all are.
//
// Fake artifacts are real zip archives built in memory (stored and deflated
// entries), because the reader walks the zip central directory; a flat Buffer
// would not exercise the part that matters for an AAB (deflated payload).
// The Makefile half is pinned STATICALLY: the checking line must exist, come
// after the build line, and sit in the same recipe, otherwise a perfectly
// correct reader would be wired to nothing (the repo's headline failure shape).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { APK_CONTROL_MARKER, STAMP_PREFIX } from './build-stamp/artifact-sha-gate.mjs';
import { judgeBuiltArtifact, main } from './build-stamp/verify-built-artifact.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const HEAD = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd';
const OLD = '6c892da7d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6';

/** A libapp.so stand-in: noise, the control marker, and an optional stamp. */
function lib({ stamp, control = APK_CONTROL_MARKER }) {
  const parts = [Buffer.from('\x7fELF noise ')];
  if (control) parts.push(Buffer.from(`${control}\0`));
  if (stamp !== undefined) parts.push(Buffer.from(`${STAMP_PREFIX}${stamp}\0tail`));
  return Buffer.concat(parts);
}

/** Minimal zip writer: [{name, data, deflate}] -> Buffer. */
function zip(files) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const raw = f.data;
    const body = f.deflate ? deflateRawSync(raw) : raw;
    const method = f.deflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];
const apk = (stamps) =>
  zip([
    { name: 'AndroidManifest.xml', data: Buffer.from('m') },
    ...ABIS.map((abi, i) => ({ name: `lib/${abi}/libapp.so`, data: lib({ stamp: stamps[i] }) })),
  ]);
const aab = (stamps) =>
  zip([
    { name: 'BundleConfig.pb', data: Buffer.from('b') },
    ...ABIS.map((abi, i) => ({
      name: `base/lib/${abi}/libapp.so`,
      data: lib({ stamp: stamps[i] }),
      deflate: true, // a bundle deflates it - the reason a raw scan is blind
    })),
  ]);

console.log('\n§1 judgement on fake artifacts');
check('APK, every ABI = HEAD -> ok', () => {
  const v = judgeBuiltArtifact(apk([HEAD, HEAD, HEAD]), 'apk', HEAD);
  assert(v.ok && v.libs.length === 3, JSON.stringify(v));
});
check('0.3.107 STATE: APK, all three ABIs carry the old commit -> red, names it', () => {
  const v = judgeBuiltArtifact(apk([OLD, OLD, OLD]), 'apk', HEAD);
  assert(!v.ok && v.problems.length === 3, JSON.stringify(v));
  assert(v.problems.every((p) => p.includes(OLD) && p.includes(HEAD)), v.problems.join('|'));
});
check('one stale ABI among fresh ones -> red (not averaged away)', () => {
  const v = judgeBuiltArtifact(apk([HEAD, OLD, HEAD]), 'apk', HEAD);
  assert(!v.ok && v.problems.length === 1 && v.problems[0].includes('armeabi-v7a'), JSON.stringify(v));
});
check('AAB with DEFLATED payload, right stamp -> ok (the zip is inflated, not raw-scanned)', () => {
  const v = judgeBuiltArtifact(aab([HEAD, HEAD, HEAD]), 'aab', HEAD);
  assert(v.ok && v.libs.length === 3, JSON.stringify(v));
});
check('AAB with the wrong stamp -> red', () => {
  const v = judgeBuiltArtifact(aab([HEAD, OLD, HEAD]), 'aab', HEAD);
  assert(!v.ok, 'a stale bundle passed');
});
check('AAB built with no define (unstamped-dev) -> red as unstamped', () => {
  const v = judgeBuiltArtifact(aab(['unstamped-dev', 'unstamped-dev', 'unstamped-dev']), 'aab', HEAD);
  assert(!v.ok && /NO build sha/.test(v.problems[0]), JSON.stringify(v));
});
check('library without the control marker -> BLIND, never a pass', () => {
  const blind = zip([{ name: 'lib/arm64-v8a/libapp.so', data: lib({ stamp: HEAD, control: null }) }]);
  const v = judgeBuiltArtifact(blind, 'apk', HEAD);
  assert(!v.ok && /BLIND/.test(v.problems[0]), JSON.stringify(v));
});
check('artifact with no libapp.so at all -> red (a scan of nothing vouches for nothing)', () => {
  const v = judgeBuiltArtifact(zip([{ name: 'AndroidManifest.xml', data: Buffer.from('m') }]), 'apk', HEAD);
  assert(!v.ok && /Nothing was checked/.test(v.problems[0]), JSON.stringify(v));
});
check('not a zip -> red', () => {
  assert(!judgeBuiltArtifact(Buffer.from('x'.repeat(100)), 'apk', HEAD).ok, 'garbage passed');
});
check('IPA: App.framework/App right stamp -> ok, stale -> red', () => {
  const mk = (s) => zip([{ name: 'Payload/Runner.app/Frameworks/App.framework/App', data: lib({ stamp: s }) }]);
  assert(judgeBuiltArtifact(mk(HEAD), 'ipa', HEAD).ok, 'good ipa red');
  assert(!judgeBuiltArtifact(mk(OLD), 'ipa', HEAD).ok, 'stale ipa passed');
});

console.log('\n§2 the command (exit codes + words an operator reads)');
const logs = { log: [], error: [] };
const sink = { log: (m) => logs.log.push(m), error: (m) => logs.error.push(m) };
const dir = mkdtempSync(join(tmpdir(), 'nr170-'));
try {
  const good = join(dir, 'good.apk');
  const bad = join(dir, 'bad.apk');
  writeFileSync(good, apk([HEAD, HEAD, HEAD]));
  writeFileSync(bad, apk([OLD, OLD, OLD]));
  const sha = () => ({ value: HEAD });
  check('right stamp -> exit 0', () => {
    assert(main(['--kind', 'apk', good], { resolveSha: sha, out: sink }) === 0, 'non-zero');
  });
  check('stale -> exit 1, message names the rebuild command and the dirs', () => {
    logs.error.length = 0;
    assert(main(['--kind', 'apk', bad], { resolveSha: sha, out: sink }) === 1, 'zero');
    const t = logs.error.join('\n');
    assert(t.includes('make -C apps/mobile release') && t.includes('stripped_native_libs'), t);
  });
  check('missing artifact -> exit 1 (not a skip)', () => {
    assert(main(['--kind', 'apk', join(dir, 'nope.apk')], { resolveSha: sha, out: sink }) === 1, 'zero');
  });
  check('dirty tree (resolveSha throws) -> exit 1', () => {
    const boom = () => {
      throw new Error('dirty');
    };
    assert(main(['--kind', 'apk', good], { resolveSha: boom, out: sink }) === 1, 'zero');
  });
  check('bad usage -> exit 2', () => {
    assert(main(['--kind', 'exe', good], { resolveSha: sha, out: sink }) === 2, 'not 2');
  });
  check('directory holding exactly one .ipa is accepted; zero is refused', () => {
    const d = join(dir, 'ipa');
    mkdirSync(d);
    assert(main(['--kind', 'ipa', d], { resolveSha: sha, out: sink }) === 1, 'empty dir passed');
    writeFileSync(
      join(d, 'x.ipa'),
      zip([{ name: 'Payload/Runner.app/Frameworks/App.framework/App', data: lib({ stamp: HEAD }) }]),
    );
    assert(main(['--kind', 'ipa', d], { resolveSha: sha, out: sink }) === 0, 'single ipa refused');
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('\n§3 wiring: the Makefile actually calls the reader, after the build');
const make = readFileSync(join(ROOT, 'apps', 'mobile', 'Makefile'), 'utf8').replace(/\r\n/g, '\n');
function recipe(target) {
  const lines = make.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${target}:`));
  assert(start >= 0, `no ${target} target`);
  const body = [];
  for (let i = start + 1; i < lines.length && lines[i].startsWith('\t'); i++) body.push(lines[i]);
  return body;
}
for (const [target, build, kind] of [
  ['release', 'flutter build apk --release --flavor direct', 'apk'],
  ['release-store', 'flutter build appbundle --release --flavor store', 'aab'],
  ['release-ios', 'flutter build ipa --release', 'ipa'],
]) {
  check(`${target}: build line is stamped and a --kind ${kind} check follows it`, () => {
    const r = recipe(target);
    const b = r.findIndex((l) => l.includes(build));
    const v = r.findIndex((l) => l.includes('verify-built-artifact.mjs') && l.includes(`--kind ${kind}`));
    assert(b >= 0, `build line missing: ${r.join(' / ')}`);
    assert(r[b].includes('with-build-sha.mjs') && r[b].includes('FLOWMIC_BUILD_SHA={sha}'), `build not stamped: ${r[b]}`);
    assert(v > b, `verify line missing or before the build (build ${b}, verify ${v})`);
  });
}
check('release-store: the verify line precedes the store gate line (both must pass)', () => {
  const r = recipe('release-store');
  const v = r.findIndex((l) => l.includes('verify-built-artifact.mjs'));
  const g = r.findIndex((l) => l.includes('store-channel-gate.mjs'));
  assert(v >= 0 && g > v, `order ${v}/${g}`);
});

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nnr170 built-artifact stamp drill: all green');
