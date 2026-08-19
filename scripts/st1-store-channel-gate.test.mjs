// Drill for the store-channel gate (ST-1, 2026-08-19).
//
// The gate it exercises asserts an ABSENCE, which is the hardest kind of check
// to trust: a scan that sees nothing at all looks exactly like a clean
// artifact. So the cases below are built around that one hazard —
//   · a real store artifact passes;
//   · a direct artifact (self-updater present) is refused;
//   · a file the scan cannot read at all is refused as BLIND, never as clean;
//   · 「we could not ask for permissions」 is refused, not treated as none.
//
// Same discipline the sibling drill (up7-apk-self-update-marker.test.mjs)
// states: every negative case here has a positive control, because otherwise a
// broken judge would pass every one of them.
//
// ── ST-1b (2026-08-19): the AAB half, and the reverse controls ─────────────
//
// The gate now reads the .aab that is actually submitted to Play, and
// `make -C apps/mobile release-store` runs it on the bundle it just built. Two
// things therefore had to be SEEN failing, not argued to fail. Both readings
// below are verbatim.
//
// § REVERSE CONTROL A — does inflating actually change the answer?
//
// A bundle entry is Deflated, so the pre-ST-1b scan (raw bytes, no inflate) was
// structurally incapable of finding the self-update marker inside one. If that
// is true, the OLD scanner must report BLIND on the very bytes the NEW scanner
// convicts. Pinned as an executable assertion below
// (`the deflated feature marker is invisible to the raw scan`) rather than as a
// sentence, because it is the single claim the whole AAB path rests on.
//
// § REVERSE CONTROL B — a REAL store bundle carrying the self-updater.
//
// Synthetic zips prove the reader; only a real build proves the marker survives
// AOT compilation into a bundle. So one was built on purpose:
//
//     flutter build appbundle --release --flavor store \
//       --dart-define=FLOWMIC_SELF_UPDATE=1
//     node scripts/store-channel-gate.mjs <that .aab>
//
//   FAIL app-store-release.aab (AAB) is NOT a publishable store artifact:
//     · it CARRIES the self-updater (3 hit(s) of '/api/updates/latest'). A store artifact must be built with `--flavor store` and WITHOUT --dart-define=FLOWMIC_SELF_UPDATE — see apps/mobile/Makefile `release-store`.
//   EXIT=1
//
// 3 hits = one per ABI, the same discriminator the direct-channel gate measures
// [scripts/apk-self-update-marker.mjs §measurement]. The permission half stayed
// green in that run, which is correct and is the point of keeping the two facts
// separate: the flavour was right, the define was not.
//
// § REVERSE CONTROL C — does a refusal actually fail the make target?
//
// With that bad bundle on disk, `apps/mobile/Makefile` was temporarily edited to
// pass the same define (so Gradle stayed UP-TO-DATE and the bad artifact
// survived rather than being rebuilt clean), and the REAL target was run:
//
//     $ make -C apps/mobile release-store
//     flutter build appbundle --release --flavor store --dart-define=FLOWMIC_SELF_UPDATE=1
//     Running Gradle task 'bundleStoreRelease'...                         9.9s
//     √ Built build\app\outputs\bundle\storeRelease\app-store-release.aab (53.7MB)
//     node ../../scripts/store-channel-gate.mjs build/app/outputs/bundle/storeRelease/app-store-release.aab
//     FAIL app-store-release.aab (AAB) is NOT a publishable store artifact:
//       · it CARRIES the self-updater (3 hit(s) of '/api/updates/latest'). [...]
//     make: *** [Makefile:91: release-store] Error 1
//     MAKE_EXIT=2
//
// 🔴 Read the 3rd and 5th lines of that transcript together. Flutter printed
// 「√ Built ...」 — a green tick, on a bundle that must never reach Play — and
// the refusal came AFTER it. That is not cosmetic: before this wiring, that tick
// was the last word the target said. It is why the Makefile comment states
// explicitly that flutter's line is not the verdict.
//
// The Makefile was then restored and verified byte-identical (sha256
// 0962b901750c4af43451b0dc5d8e85b0e68ab65f51ec6f8f747616474bb725b1, equal to the
// pre-edit reading), and the clean target re-run as the positive control:
//
//     $ make -C apps/mobile release-store
//     √ Built build\app\outputs\bundle\storeRelease\app-store-release.aab (53.5MB)
//     OK  app-store-release.aab is a store AAB: no self-updater (control 3 hit(s), feature 0), 7 permission(s), none of them android.permission.REQUEST_INSTALL_PACKAGES
//     MAKE_EXIT=0
//
// ⚠️ 7, where the run hours earlier said 8: concurrent work dropped
// READ_MEDIA_IMAGES from the merged manifest in between. Recorded rather than
// smoothed over — the count is a reading of one artifact at one moment, not a
// property of the product, and the gate's header says the same. What holds is
// the invariant: store set == direct set minus REQUEST_INSTALL_PACKAGES
// [measured both ways, scripts/store-channel-gate.mjs §measurement-aab].
//
// ⚠️ What C proves and does not prove: it proves the gate is wired into the
// target and that a refusal is fatal to it. It does not prove anything about
// what a human later uploads to the Play console — no gate in this repo can see
// that, and it stays in §1 of docs/RELEASE-IRONRULES.md for that reason.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';

import {
  APK_CONTROL_MARKER,
  APK_SELF_UPDATE_MARKER,
} from './apk-self-update-marker.mjs';
import {
  STORE_FORBIDDEN_PERMISSION,
  bundleDeclaredPermissions,
  detectArtifactKind,
  isShippedModuleEntry,
  judgeStoreArtifact,
  judgeStoreFacts,
  parseAaptPermissions,
  scanStoreArtifact,
  scanStoreBundle,
  usesPermissions,
} from './store-channel-gate.mjs';

/** Bytes that look like a build: control marker present, feature absent. */
const storeBytes = () =>
  Buffer.from(`...${APK_CONTROL_MARKER}...some other payload...`, 'utf8');

/** Bytes of a direct-channel build: both markers present. */
const directBytes = () =>
  Buffer.from(
    `...${APK_CONTROL_MARKER}...${APK_SELF_UPDATE_MARKER}...`,
    'utf8',
  );

const somePermissions = {
  reason: 'ok',
  permissions: ['android.permission.RECORD_AUDIO', 'android.permission.INTERNET'],
};

test('a store artifact passes, and the pass is not vacuous', () => {
  const v = judgeStoreArtifact(storeBytes(), somePermissions);
  assert.equal(v.pass, true);
  assert.equal(v.scan.verdict, 'ok');
  // The control marker really was found — this is what separates 「clean」 from
  // 「the scan saw nothing」, and it is the whole reason the verdict is a triple
  // rather than a boolean.
  assert.ok(v.scan.control > 0);
  assert.equal(v.scan.feature, 0);
});

test('a direct artifact is refused, and the message names the fix', () => {
  const v = judgeStoreArtifact(directBytes(), somePermissions);
  assert.equal(v.pass, false);
  assert.equal(v.scan.verdict, 'carries-self-update');
  assert.ok(v.problems.some((p) => p.includes('--flavor store')));
});

test('🔴 an unreadable file is BLIND, never a pass', () => {
  // The failure this pins: compression, a wrong file, a truncated download.
  // Reporting that as 「no self-updater found」 would be the most confident
  // wrong answer this gate could give.
  const v = judgeStoreArtifact(Buffer.from('not an apk at all'), somePermissions);
  assert.equal(v.pass, false);
  assert.equal(v.scan.verdict, 'blind');
  assert.ok(v.problems.some((p) => p.includes('BLIND')));
});

test('the forbidden permission is refused even when the bytes are clean', () => {
  const v = judgeStoreArtifact(storeBytes(), {
    reason: 'ok',
    permissions: [...somePermissions.permissions, STORE_FORBIDDEN_PERMISSION],
  });
  assert.equal(v.pass, false);
  // The byte half is happy; only the manifest half objects. Two independent
  // facts — this asserts they are not collapsed into one.
  assert.equal(v.scan.verdict, 'ok');
  assert.ok(v.problems.some((p) => p.includes(STORE_FORBIDDEN_PERMISSION)));
});

test('「no aapt at all」 is refused, not read as 「declares none」', () => {
  const v = judgeStoreArtifact(storeBytes(), { reason: 'no-tool' });
  assert.equal(v.pass, false);
  assert.ok(v.problems.some((p) => p.includes('no aapt/aapt2')));
});

test('🔴 「aapt could not read THIS file」 is a different sentence from 「no aapt」', () => {
  // Measured, and it is why this case exists: pointed at the .aab, the first
  // version of this gate said 「no aapt/aapt2 on this machine」 on a machine that
  // had aapt. Two causes, two actions.
  const v = judgeStoreFacts(scanStoreArtifact(storeBytes()), {
    reason: 'unreadable',
    detail: 'ERROR: dump failed because no AndroidManifest.xml found',
  });
  assert.equal(v.pass, false);
  const said = v.problems.join(' ');
  assert.ok(said.includes('no AndroidManifest.xml found'));
  assert.ok(!said.includes('no aapt/aapt2'));
});

test('scanStoreArtifact decides blind BEFORE it decides anything else', () => {
  // A buffer with the feature marker and no control marker is a scan that is
  // both blind and looking at something suspicious. The order matters: it must
  // report what it does not know, not guess at what it saw.
  const v = scanStoreArtifact(Buffer.from(APK_SELF_UPDATE_MARKER, 'utf8'));
  assert.equal(v.verdict, 'blind');
});

// ── ST-1b: builders, so the AAB path is testable without a 56 MB artifact ───
//
// A real bundle is a gitignored build output; a drill that needs one is a drill
// that silently stops running (the runner's SKIP convention exists precisely
// because that has happened here before). So the zip and protobuf shapes the
// gate parses are BUILT here. The real artifact is measured in the headers of
// this file and of the gate; these tests pin the reader's rules.

/** Minimal zip writer: local headers + central directory + EOCD. `store: true`
 *  writes the entry uncompressed (an APK's libapp.so shape), otherwise Deflate
 *  (a bundle's shape — the difference this whole path exists for). */
function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const method = f.store ? 0 : 8;
    const payload = f.store ? f.data : deflateRawSync(f.data);
    const name = Buffer.from(f.name, 'utf8');
    // `usize` is a parameter so a test can declare a size that does not match
    // the bytes — that is how the reader's own ruler gets checked.
    const usize = f.usize === undefined ? f.data.length : f.usize;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc32(f.data), 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(usize, 22);
    lfh.writeUInt16LE(name.length, 26);
    parts.push(lfh, name, payload);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc32(f.data), 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(usize, 24);
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

// Protobuf writers for aapt2's XmlNode/XmlElement/XmlAttribute — field NUMBERS
// only, exactly as the gate reads them. Writing the shape by hand here is what
// makes the reader falsifiable: if the gate ever started keying off field NAMES
// (which the wire format does not carry), these would go red.
const varint = (n) => {
  const out = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
};
const lenField = (num, bytes) =>
  Buffer.concat([varint((num << 3) | 2), varint(bytes.length), bytes]);
const utf8 = (s) => Buffer.from(s, 'utf8');
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

const attrMsg = (ns, name, value) =>
  Buffer.concat([lenField(1, utf8(ns)), lenField(2, utf8(name)), lenField(3, utf8(value))]);
const elemMsg = (name, attrs = [], kids = []) =>
  Buffer.concat([
    lenField(3, utf8(name)),
    ...attrs.map((a) => lenField(4, a)),
    ...kids.map((k) => lenField(5, k)),
  ]);
const nodeMsg = (element) => lenField(1, element);

/** A <manifest> whose children are the given elements. */
const manifestProto = (children) => nodeMsg(elemMsg('manifest', [], children.map(nodeMsg)));
const usesPermissionElem = (name, element = 'uses-permission') =>
  elemMsg(element, [attrMsg(ANDROID_NS, 'name', name)]);

/** A bundle-shaped zip: BundleConfig.pb + base/manifest + a deflated payload. */
const makeBundle = ({ payload, permissions = ['android.permission.INTERNET'], extra = [] }) =>
  makeZip([
    { name: 'BundleConfig.pb', data: Buffer.from([0x08, 0x01]) },
    {
      name: 'base/manifest/AndroidManifest.xml',
      data: manifestProto(permissions.map((p) => usesPermissionElem(p))),
    },
    { name: 'base/lib/arm64-v8a/libapp.so', data: payload },
    ...extra,
  ]);

// ── ST-1b: container detection ─────────────────────────────────────────────

test('an AAB and an APK are told apart by CONTENT, not by extension', () => {
  const aab = detectArtifactKind(makeBundle({ payload: storeBytes() }));
  assert.equal(aab.kind, 'aab');
  const apk = detectArtifactKind(
    makeZip([
      { name: 'AndroidManifest.xml', data: Buffer.from('binary xml') },
      { name: 'lib/arm64-v8a/libapp.so', data: storeBytes(), store: true },
    ]),
  );
  assert.equal(apk.kind, 'apk');
  // Positive controls above; the negative is that a zip which is neither must
  // not be quietly treated as one of them.
  const neither = detectArtifactKind(makeZip([{ name: 'readme.txt', data: utf8('hi') }]));
  assert.equal(neither.kind, 'unknown');
  assert.equal(detectArtifactKind(Buffer.from('not a zip')).kind, 'unknown');
});

test('🔴 a zip64 archive is refused, not read with truncated offsets', () => {
  const z = makeBundle({ payload: storeBytes() });
  // Plant the zip64 sentinel in the EOCD's central-directory offset. A reader
  // that ignored it would follow a 32-bit offset into the middle of nowhere and
  // then report whatever it happened to find.
  z.writeUInt32LE(0xffffffff, z.length - 6);
  const d = detectArtifactKind(z);
  assert.equal(d.kind, 'unknown');
  assert.ok(d.detail.includes('zip64'));
});

// ── ST-1b: the byte half on a bundle ───────────────────────────────────────

test('a clean store bundle passes, and the control marker proves it was read', () => {
  const buf = makeBundle({ payload: storeBytes() });
  const d = detectArtifactKind(buf);
  const scan = scanStoreBundle(buf, d.entries);
  assert.equal(scan.verdict, 'ok');
  assert.ok(scan.control > 0);
  assert.equal(scan.feature, 0);
});

test('🔴 REVERSE CONTROL A: the deflated feature marker is invisible to the raw scan', () => {
  // This is the assertion the entire AAB path rests on. The same bytes:
  //   · the OLD scanner (raw, no inflate) must say BLIND — it cannot even find
  //     the control marker, let alone the feature;
  //   · the NEW scanner must convict.
  // If deflate ever stopped hiding the payload, the first assertion goes red and
  // tells us the premise changed — rather than the gate silently having been
  // unnecessary all along.
  const buf = makeBundle({ payload: directBytes() });
  assert.equal(scanStoreArtifact(buf).verdict, 'blind');
  const scan = scanStoreBundle(buf, detectArtifactKind(buf).entries);
  assert.equal(scan.verdict, 'carries-self-update');
  assert.ok(scan.feature > 0);
});

test('🔴 a bundle whose payload cannot be inflated is 「unreadable」, not 「clean」', () => {
  // Declared size and real size disagree. Reading short buffers would make every
  // absence assertion in this gate trivially true, so the reader checks its own
  // ruler and the judge refuses on the result.
  const buf = makeBundle({ payload: directBytes(), extra: [] });
  const bad = makeZip([
    { name: 'BundleConfig.pb', data: Buffer.from([0x08, 0x01]) },
    {
      name: 'base/manifest/AndroidManifest.xml',
      data: manifestProto([usesPermissionElem('android.permission.INTERNET')]),
    },
    { name: 'base/lib/arm64-v8a/libapp.so', data: directBytes(), usize: 999999 },
  ]);
  const scan = scanStoreBundle(bad, detectArtifactKind(bad).entries);
  assert.equal(scan.verdict, 'unreadable');
  const v = judgeStoreFacts(scan, somePermissions);
  assert.equal(v.pass, false);
  assert.ok(v.problems.some((p) => p.includes('could not be read')));
  // Positive control: the same shape with an honest size DOES get convicted, so
  // the refusal above is about the corruption and not about the fixture.
  assert.equal(
    scanStoreBundle(buf, detectArtifactKind(buf).entries).verdict,
    'carries-self-update',
  );
});

test('🔴 BUNDLE-METADATA is out of scope, and the scan is not blind because of it', () => {
  // Play strips it; a device never sees it. A marker hit in an R8 mapping file
  // must not fail a build whose shipped bytes are clean.
  assert.equal(isShippedModuleEntry('BUNDLE-METADATA/com.android.tools/r8.json'), false);
  assert.equal(isShippedModuleEntry('META-INF/MANIFEST.MF'), false);
  assert.equal(isShippedModuleEntry('BundleConfig.pb'), false);
  assert.equal(isShippedModuleEntry('base/lib/arm64-v8a/libapp.so'), true);
  const buf = makeBundle({
    payload: storeBytes(),
    extra: [
      { name: 'BUNDLE-METADATA/com.android.tools/mapping.txt', data: directBytes() },
    ],
  });
  const scan = scanStoreBundle(buf, detectArtifactKind(buf).entries);
  assert.equal(scan.verdict, 'ok');
  assert.equal(scan.feature, 0);
  // Positive control for the exclusion: the very same bytes inside a MODULE
  // entry are convicted, so the pass above is scoping and not blindness.
  const shipped = makeBundle({ payload: storeBytes(), extra: [
    { name: 'base/dex/classes2.dex', data: directBytes() },
  ] });
  assert.equal(
    scanStoreBundle(shipped, detectArtifactKind(shipped).entries).verdict,
    'carries-self-update',
  );
});

// ── ST-1b: the protobuf half ───────────────────────────────────────────────

test('permissions are read out of the bundle protobuf manifest', () => {
  const buf = makeBundle({
    payload: storeBytes(),
    permissions: ['android.permission.RECORD_AUDIO', 'android.permission.INTERNET'],
  });
  const perms = bundleDeclaredPermissions(buf, detectArtifactKind(buf).entries);
  assert.equal(perms.reason, 'ok');
  assert.deepEqual(perms.permissions, [
    'android.permission.RECORD_AUDIO',
    'android.permission.INTERNET',
  ]);
});

test('🔴 the forbidden permission is caught in an AAB, end to end', () => {
  const buf = makeBundle({
    payload: storeBytes(),
    permissions: ['android.permission.INTERNET', STORE_FORBIDDEN_PERMISSION],
  });
  const d = detectArtifactKind(buf);
  const v = judgeStoreFacts(scanStoreBundle(buf, d.entries), bundleDeclaredPermissions(buf, d.entries));
  assert.equal(v.pass, false);
  assert.equal(v.scan.verdict, 'ok'); // byte half clean; only the manifest objects
  assert.ok(v.problems.some((p) => p.includes(STORE_FORBIDDEN_PERMISSION)));
});

test('🔴 uses-permission-sdk-23 is the same permission, in BOTH readers', () => {
  // The one-word bypass. Both halves of the gate had to be widened, so both are
  // pinned here — a rule enforced by only one of two readers is not a rule.
  const proto = manifestProto([
    usesPermissionElem(STORE_FORBIDDEN_PERMISSION, 'uses-permission-sdk-23'),
  ]);
  assert.deepEqual(usesPermissions(proto), [STORE_FORBIDDEN_PERMISSION]);
  assert.deepEqual(
    parseAaptPermissions(
      `uses-permission-sdk-23: name='${STORE_FORBIDDEN_PERMISSION}'\n` +
        "uses-permission: name='android.permission.INTERNET'\n",
    ),
    [STORE_FORBIDDEN_PERMISSION, 'android.permission.INTERNET'],
  );
});

test('🔴 an android:permission attribute is NOT a permission this app requests', () => {
  // Measured on the real bundle: a raw grep for `android.permission.*` over that
  // manifest also returns BIND_JOB_SERVICE and DUMP, which are the permissions
  // OTHER components need to reach us. Same characters, opposite meaning — this
  // is why the manifest is parsed rather than grepped.
  const proto = manifestProto([
    elemMsg('service', [attrMsg(ANDROID_NS, 'permission', 'android.permission.BIND_JOB_SERVICE')]),
    usesPermissionElem('android.permission.INTERNET'),
  ]);
  assert.deepEqual(usesPermissions(proto), ['android.permission.INTERNET']);
});

test('🔴 a manifest that will not parse is refused, not reported as declaring none', () => {
  const bad = makeZip([
    { name: 'BundleConfig.pb', data: Buffer.from([0x08, 0x01]) },
    { name: 'base/manifest/AndroidManifest.xml', data: Buffer.from('plain text, not protobuf') },
    { name: 'base/lib/arm64-v8a/libapp.so', data: storeBytes() },
  ]);
  const d = detectArtifactKind(bad);
  const perms = bundleDeclaredPermissions(bad, d.entries);
  assert.equal(perms.reason, 'unreadable');
  const v = judgeStoreFacts(scanStoreBundle(bad, d.entries), perms);
  assert.equal(v.pass, false);
  assert.equal(v.scan.verdict, 'ok'); // the byte half was fine — only the manifest failed
  assert.ok(v.problems.some((p) => p.includes('An unread manifest is not an empty one')));
});
