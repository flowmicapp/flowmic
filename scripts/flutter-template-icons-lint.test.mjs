#!/usr/bin/env node
// Drill for verify/lint/flutter-template-icons.mjs -- the gate that keeps a
// Flutter-template icon or launch placeholder from shipping again.
//
// Why a drill and not just the live gate: the live gate is green the moment the
// tree is clean, and a gate that has only ever been green is indistinguishable
// from a gate that cannot go red. The reverse controls below plant the real
// template bytes (a byte-for-byte reconstruction of the 68-byte LaunchImage
// placeholder, and of the README that ships beside it) and require a FAIL.
//
// `flutterTemplateIcons(root)` takes the repo root as a parameter for exactly
// this reason -- the drill points it at a disposable fixture rather than at
// apps/mobile.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import flutterTemplateIcons from '../verify/lint/flutter-template-icons.mjs';

let failures = 0;
const ok = (name, detail) => console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

// The Flutter template's LaunchImage placeholder, verbatim: a 1x1 grey+alpha
// PNG, 68 bytes, sha256 93ae7d49...ce20. Kept as hex rather than as a copy of
// the file so the drill works on a machine with no Flutter SDK -- the same
// reason the gate embeds its hash table.
const TEMPLATE_LAUNCH_IMAGE_HEX =
  '89504e470d0a1a0a0000000d494844520000000100000001080400' +
  '0000b51c0c020000000b49444154789c63facf0000020701029a1c' +
  '31710000000049454e44ae426082';
const TEMPLATE_LAUNCH_IMAGE = Buffer.from(TEMPLATE_LAUNCH_IMAGE_HEX, 'hex');

// A distinct, non-template PNG (1x1, colour type 6). Any bytes not in the
// table would do; this one is a real decodable PNG so the fixture stays honest.
const BRAND_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d4944415478da63f8cfc0f01f0005fb02fe1c0eb1c8' +
    '0000000049454e44ae426082',
  'hex'
);

const IOS_ICONS = join('ios', 'Runner', 'Assets.xcassets', 'AppIcon.appiconset');
const IOS_LAUNCH = join('ios', 'Runner', 'Assets.xcassets', 'LaunchImage.imageset');
const ANDROID_RES = join('android', 'app', 'src', 'main', 'res');

function put(root, relPath, content) {
  const abs = join(root, 'apps', 'mobile', relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/** A clean fixture: enough PNGs to clear the blind-scan floor, none of them
 *  template bytes, and no LaunchImage README. */
function baseFixture() {
  const T = mkdtempSync(join(tmpdir(), 'fmicon-fixture-'));
  // 15 iOS app icons + 3 launch images + 5 Android mipmaps = 23 > the floor of 20.
  for (let i = 0; i < 15; i += 1) {
    // Vary the bytes so the fixture is not one file written 15 times.
    put(T, join(IOS_ICONS, `Icon-App-${i}.png`), Buffer.concat([BRAND_PNG, Buffer.from([i])]));
  }
  for (const n of ['LaunchImage.png', 'LaunchImage@2x.png', 'LaunchImage@3x.png']) {
    put(T, join(IOS_LAUNCH, n), Buffer.concat([BRAND_PNG, Buffer.from(n)]));
  }
  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    put(T, join(ANDROID_RES, `mipmap-${d}`, 'ic_launcher.png'), Buffer.concat([BRAND_PNG, Buffer.from(d)]));
  }
  return T;
}

console.log('=== control: the embedded template bytes really are the template ===');
{
  const digest = createHash('sha256').update(TEMPLATE_LAUNCH_IMAGE).digest('hex');
  check(
    digest === '93ae7d494fad0fb30cbf3ae746a39c4bc7a0f8bbf87fbb587a3f3c01f3c5ce20',
    'the planted LaunchImage bytes hash to the template sha256 in the gate table',
    digest.slice(0, 16)
  );
  check(TEMPLATE_LAUNCH_IMAGE.length === 68, 'and are 68 bytes, as the template is', String(TEMPLATE_LAUNCH_IMAGE.length));
}

console.log('=== negative control: a clean fixture PASSes ===');
{
  const T = baseFixture();
  const res = await flutterTemplateIcons(T);
  check(res.status === 'PASS', 'a fixture with no template assets passes', JSON.stringify(res));
  check(res.detail.includes('23 mobile icon/launch PNG(s)'), 'the PASS detail states how many images it actually read', res.detail);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== REVERSE CONTROL: a planted template LaunchImage FAILs ===');
{
  const T = baseFixture();
  put(T, join(IOS_LAUNCH, 'LaunchImage@2x.png'), TEMPLATE_LAUNCH_IMAGE);
  const res = await flutterTemplateIcons(T);
  check(res.status === 'FAIL', 'the template LaunchImage placeholder fails', res.status);
  check(
    res.detail.includes('LaunchImage@2x.png') && res.detail.includes('byte-identical to the Flutter template asset'),
    'the FAIL detail names the file and says why',
    res.detail
  );
  rmSync(T, { recursive: true, force: true });
}

console.log('=== REVERSE CONTROL: the android tree is scanned too, not just ios ===');
{
  const T = baseFixture();
  // Same template bytes, planted on the Android side. The gate judges by hash,
  // so what this proves is that the android walk happens at all -- an ios-only
  // scanner would report this fixture clean.
  put(T, join(ANDROID_RES, 'mipmap-hdpi', 'ic_launcher.png'), TEMPLATE_LAUNCH_IMAGE);
  const res = await flutterTemplateIcons(T);
  check(res.status === 'FAIL', 'template bytes under android/ fail as well', res.status);
  check(res.detail.includes('ic_launcher.png'), 'the FAIL detail names the android file', res.detail);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== REVERSE CONTROL: the template LaunchImage README FAILs ===');
{
  const T = baseFixture();
  put(T, join(IOS_LAUNCH, 'README.md'), Buffer.from('# Launch Screen Assets\n', 'utf8'));
  const res = await flutterTemplateIcons(T);
  check(res.status === 'FAIL', 'a surviving LaunchImage README fails', res.status);
  check(res.detail.includes('README.md') && res.detail.includes('only ever comes from'), 'the FAIL detail names the README', res.detail);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== REVERSE CONTROL: a blind scan FAILs rather than reporting clean ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmicon-blind-'));
  const res = await flutterTemplateIcons(T);
  check(res.status === 'FAIL', 'an empty tree fails instead of passing', res.status);
  check(res.detail.includes('blind'), 'the FAIL detail says the scan was blind, not that the tree was clean', res.detail);
  rmSync(T, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\nFAIL: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nPASS: flutter-template-icons gate goes red on template bytes, on the template README, and when blind');
process.exit(0);
