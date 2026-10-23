// NR-297 drill — the store billing-link byte gate (AAB via store-channel-gate,
// IPA via ios-store-billing-gate) and its wiring.
//
// What the fixtures stand for: a real libapp.so / App.framework/App carries
// both the control marker and (in a build without the store define) the billing
// path [measured 2026-10-20: 0.3.117 store AAB 3 hits, 0.3.117 IPA 1 hit, both
// refused by these gates]. The fixtures are the same strings in deflated zip
// entries, so the drill runs on any box without a 75 MB artifact.
//
// Every refusal case has a pass case built the same way next to it, and every
// pass is checked to have SEEN the control marker — 「no billing link」 from a
// scan that saw nothing would be this gate's most confident wrong answer.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

import { APK_CONTROL_MARKER } from './apk-self-update-marker.mjs';
import { judgeIpa } from './ios-store-billing-gate.mjs';
import {
  STORE_BILLING_LINK_MARKER,
  STORE_CHANNEL_DEFINE,
  scanBillingLink,
} from './store-billing-link-marker.mjs';
import {
  judgeStoreFacts,
  scanStoreArtifact,
  scanStoreBundle,
  zipEntries,
} from './store-channel-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const utf8 = (s) => Buffer.from(s, 'utf8');

/** Deflate-only zip writer (central directory + EOCD), enough for the readers. */
function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const payload = deflateRawSync(f.data);
    const name = utf8(f.name);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(crc32(f.data), 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(f.data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    parts.push(lfh, name, payload);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc32(f.data), 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += lfh.length + name.length + payload.length;
  }
  const cdBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBytes, eocd]);
}

const BILLING_URL = `https://flowmic.app${STORE_BILLING_LINK_MARKER}`;
const dartWithLink = () => utf8(`..${APK_CONTROL_MARKER}..${BILLING_URL}..`);
const dartClean = () => utf8(`..${APK_CONTROL_MARKER}..https://flowmic.app/console/account..`);
const dartBlind = () => utf8(`..nothing we know..${BILLING_URL}..`);
const perms = { reason: 'ok', permissions: ['android.permission.RECORD_AUDIO'] };

const bundle = (lib) =>
  makeZip([
    { name: 'BundleConfig.pb', data: utf8('cfg') },
    { name: 'base/manifest/AndroidManifest.xml', data: utf8('proto') },
    { name: 'base/lib/arm64-v8a/libapp.so', data: lib },
  ]);
const ipa = (app, extra = []) =>
  makeZip([
    { name: 'Payload/Runner.app/Info.plist', data: utf8('plist') },
    ...(app ? [{ name: 'Payload/Runner.app/Frameworks/App.framework/App', data: app }] : []),
    ...extra,
  ]);

// ── Android: the store gate ─────────────────────────────────────────────────

test('AAB: a store bundle still carrying the billing link is refused, and the fix is named', () => {
  const buf = bundle(dartWithLink());
  const v = judgeStoreFacts(scanStoreBundle(buf, zipEntries(buf)), perms);
  assert.equal(v.pass, false);
  assert.equal(v.scan.billing, 1);
  assert.ok(v.problems.some((p) => p.includes(STORE_CHANNEL_DEFINE)), v.problems.join(' | '));
});

test('AAB: the same bundle without the link passes, and the scan SAW the payload', () => {
  const buf = bundle(dartClean());
  const v = judgeStoreFacts(scanStoreBundle(buf, zipEntries(buf)), perms);
  assert.equal(v.pass, true, v.problems.join(' | '));
  assert.equal(v.scan.billing, 0);
  assert.ok(v.scan.control > 0);
});

test('AAB: the deflated marker is invisible to a raw scan — the inflate is what sees it', () => {
  const buf = bundle(dartWithLink());
  assert.equal(scanBillingLink([buf]).verdict, 'blind');
  assert.equal(scanStoreBundle(buf, zipEntries(buf)).billing, 1);
});

test('APK: the raw-bytes scan counts the billing link too', () => {
  const v = judgeStoreFacts(scanStoreArtifact(dartWithLink()), perms);
  assert.equal(v.pass, false);
  assert.equal(v.scan.billing, 1);
  assert.equal(judgeStoreFacts(scanStoreArtifact(dartClean()), perms).pass, true);
});

test('a scan result without a billing count is refused, not read as zero', () => {
  const v = judgeStoreFacts({ control: 3, feature: 0, verdict: 'ok' }, perms);
  assert.equal(v.pass, false);
  assert.ok(v.problems.some((p) => p.includes('billing-link half was never scanned')));
});

test('a blind bundle is refused as BLIND whatever the billing count says', () => {
  const buf = bundle(dartBlind());
  const v = judgeStoreFacts(scanStoreBundle(buf, zipEntries(buf)), perms);
  assert.equal(v.pass, false);
  assert.ok(v.problems.some((p) => p.includes('BLIND')));
});

// ── iOS: the IPA gate ───────────────────────────────────────────────────────

test('IPA: App.framework/App carrying the billing link is refused (exit 1)', () => {
  const v = judgeIpa(ipa(dartWithLink()), 'x.ipa');
  assert.equal(v.exit, 1);
  assert.equal(v.scan.billing, 1);
  assert.ok(v.lines.join(' ').includes(STORE_CHANNEL_DEFINE));
});

test('IPA: a clean App.framework/App passes (exit 0) and the control was seen', () => {
  const v = judgeIpa(ipa(dartClean()), 'x.ipa');
  assert.equal(v.exit, 0, v.lines.join(' | '));
  assert.ok(v.scan.control > 0);
});

test('IPA: a blind scan is a refusal, not a pass', () => {
  const v = judgeIpa(ipa(dartBlind()), 'x.ipa');
  assert.equal(v.exit, 1);
  assert.ok(v.lines.join(' ').includes('BLIND'));
});

test('IPA: only the Dart snapshot is judged — the path elsewhere in the archive is not it', () => {
  const v = judgeIpa(
    ipa(dartClean(), [{ name: 'Payload/Runner.app/notes.txt', data: utf8(BILLING_URL) }]),
    'x.ipa',
  );
  assert.equal(v.exit, 0, v.lines.join(' | '));
});

test('IPA: no App.framework/App at all cannot be asked (exit 2), never a pass', () => {
  assert.equal(judgeIpa(ipa(null), 'x.ipa').exit, 2);
  assert.equal(judgeIpa(utf8('not a zip'), 'x.ipa').exit, 2);
});

// ── wiring: the define, the flag, the targets ───────────────────────────────

const make = readFileSync(join(ROOT, 'apps/mobile/Makefile'), 'utf8').replace(/\r\n/g, '\n');
function recipe(target) {
  const lines = make.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${target}:`));
  assert.ok(start >= 0, `no ${target} target`);
  const body = [];
  for (let i = start + 1; i < lines.length && lines[i].startsWith('\t'); i++) body.push(lines[i]);
  return body;
}
const defineValue = STORE_CHANNEL_DEFINE.replace('--dart-define=', '');

test('the Dart flag reads the define the gates quote', () => {
  const dart = readFileSync(join(ROOT, 'apps/mobile/lib/src/support/store_channel_flag.dart'), 'utf8');
  const key = defineValue.split('=')[0];
  assert.ok(dart.includes(`kStoreChannelDefineKey = '${key}'`));
  const urls = readFileSync(join(ROOT, 'apps/mobile/lib/src/support/legal_urls.dart'), 'utf8');
  // The marker is the path the card opens, not a label: pinned to the constant.
  assert.ok(urls.includes(`kBillingPageUrl = '$kDefaultSaasEndpoint${STORE_BILLING_LINK_MARKER}'`));
});

test('release-store and release-ios build with the store define; release does not', () => {
  const build = (t, cmd) => recipe(t).find((l) => l.includes(cmd));
  const store = build('release-store', 'flutter build appbundle');
  const ios = build('release-ios', 'flutter build ipa');
  const direct = build('release', 'flutter build apk');
  assert.ok(store && store.includes(defineValue), store);
  assert.ok(ios && ios.includes(defineValue), ios);
  assert.ok(direct && !direct.includes('FLOWMIC_STORE_CHANNEL'), direct);
});

test('release-ios ends in the IPA gate, after the build', () => {
  const r = recipe('release-ios');
  const b = r.findIndex((l) => l.includes('flutter build ipa'));
  const g = r.findIndex((l) => l.includes('ios-store-billing-gate.mjs'));
  assert.ok(b >= 0 && g > b, `build ${b}, gate ${g}`);
});

test('gate-test renders the guide once more as a store build', () => {
  const r = recipe('gate-test');
  assert.ok(
    r.some((l) => l.includes(defineValue) && l.includes('quota_rules_store_channel_test.dart')),
    r.join(' / '),
  );
});
