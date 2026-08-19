// ST-1 (2026-08-19) — is this artifact really the STORE one?
//
// ── the gate this is the other half of ─────────────────────────────────────
//
// `apk-self-update-marker.mjs` asks the direct channel's question: does the APK
// we are about to publish CONTAIN the self-updater? Its header, written months
// before there was a store build, says what to do on the day one exists:
//
//     🔴 The day a Google Play build legitimately exists, this gate WILL go red
//     on it — and that is correct […] On that day the fix is to split the gate
//     BY CHANNEL — a Play artifact asserting the marker is ABSENT — never to
//     weaken it into "present or absent, both fine", which is a check that
//     cannot fail.
//
// This file is that split. It asserts the mirror image, and it is deliberately a
// SEPARATE command rather than a flag on the other one: two channels, two
// questions, two answers. A single gate parameterised by a channel flag would be
// one value answering two questions, and the flag would be the thing someone
// gets wrong at 2am.
//
// ── what it checks, and why each one is not enough alone ───────────────────
//
//   1. the self-update marker is ABSENT (byte scan, with the same control
//      marker so a blind scan cannot masquerade as a pass);
//   2. `REQUEST_INSTALL_PACKAGES` is not declared.
//
// (1) without (2) would pass an artifact that declares a restricted permission
// Play reviews whether or not any code uses it. (2) without (1) would pass one
// whose Dart half still tries to download and install an update, and fails in
// front of a user instead of in front of us.
//
// ── 🔴 THE ORIGINAL PARAGRAPH, KEPT, AND CORRECTED BELOW IT ────────────────
//
// The first version of this file carried a paragraph headed "WHY IT TAKES AN
// APK WHEN PLAY TAKES AN AAB". It is reproduced here rather than deleted,
// because its LAST sentence is the instruction this rewrite is executing:
//
//     The artifact submitted to Play is `build/app/outputs/bundle/storeRelease/
//     app-store-release.aab`. This gate is meant to be run on the APK built from
//     THE SAME FLAVOUR […] because:
//       · an AAB's manifest is protobuf and its entries are compressed, so
//         neither check can read it without bundletool — a dependency we do not
//         have;
//       · the flavour source set is what decides both facts, and it is identical
//         for the two outputs of that flavour.
//     ⚠️ That is an INFERENCE, and it is the weak link in this gate — stated
//     here rather than hidden: what is measured is the APK, what ships is the
//     AAB. If bundletool ever enters this repo, verify the bundle directly and
//     delete this paragraph.
//
// 🔴 Its premise is measured FALSE, and bundletool never entered the repo. Both
// obstacles it named are real; neither one required a new dependency:
//   · "its entries are compressed" — true, and now handled: `zipEntries()` plus
//     `node:zlib` inflate them. That IS why the raw scan went blind; it was
//     never a reason the bundle could not be read.
//   · "its manifest is protobuf" — true, and now handled: `usesPermissions()`
//     walks the protobuf wire format directly. aapt2 genuinely cannot help here
//     [measured, §measurement-aab], but ~50 lines of varint reading can.
// So the weak link is gone: this gate now reads THE BYTES THAT ARE SUBMITTED.
// The APK path below is kept — it is still the right check for an APK, and the
// direct channel's publisher shares its aapt locator — but the store path no
// longer measures one artifact while a different one ships.
//
// ── 🔴 WHAT READING THE BUNDLE STILL DOES NOT PROVE ────────────────────────
//
// Stated here for the same reason the paragraph above was: an unstated limit is
// how the next reader inherits a false belief.
//   · Play does not install these bytes. It generates and re-signs per-device
//     split APKs from this bundle. This gate reads the module those splits are
//     DERIVED FROM, which is the closest readable thing to what a user gets —
//     not the same bytes.
//   · The payload scan deliberately skips `BUNDLE-METADATA/` and `META-INF/`
//     (see `isShippedModuleEntry`): that data is Play-side and signing-side and
//     never reaches a device, so a marker hit inside it would be a confident
//     verdict about bytes no user receives.
//   · Both halves answer questions about THIS FILE. Neither can say anything
//     about what someone uploads to the Play console by hand.
//
// Usage:  node scripts/store-channel-gate.mjs <store.aab|store.apk>
// Exit 0 = the artifact is a store artifact. Exit 1 = it is not, and the reason
// names which of the two facts failed. Exit 2 = it could not be asked at all.
//
// ── §measurement — both channels, both directions, on real artifacts ────────
//
// 2026-08-19, all [measured] on artifacts built from this tree at 0.3.9. (The
// machine is named in the private ledger, not here — this file goes to the
// public repo, and `oss-absent-sweep` refused the first draft of this very
// paragraph for carrying a dev box's hostname. The gate that catches that is
// doing the same job as the gate below: read what actually ships.)
//
//   artifact                    self-update marker   REQUEST_INSTALL_PACKAGES
//   --------------------------  -------------------  ------------------------
//   app-direct-release.apk      3 hits (1 per ABI)   declared (9 perms)
//   app-store-release.apk       0 hits               ABSENT   (8 perms)
//   control marker              3 hits in BOTH       — the scan can see both
//
//   sizes: 75,892,590 B (direct) vs 75,401,026 B (store)
//
// And the two gates refuse each other's artifact, which is the part that makes
// this a mechanism rather than a description:
//   · THIS gate on the direct APK → exit 1, naming BOTH problems;
//   · `verifyApkCarriesSelfUpdate` (publish.mjs) on the store APK → refuses to
//     stage it, control present / feature absent, and tells the operator to
//     rebuild with the direct flavour.
// ⇒ neither channel's artifact can be shipped through the other's door by
// accident, in either direction.
//
// ── §measurement-aab — the bundle, read directly (2026-08-19) ──────────────
//
// `app-store-release.aab`, 56,134,333 B, 465 entries, single module `base`.
//
//   what                                  reading
//   ------------------------------------  -----------------------------------
//   aapt  dump permissions <aab>          exit 1, "no AndroidManifest.xml found"
//   aapt2 dump xmltree --file … <aab>     exit 1, "could not identify format"
//   raw byte scan over the whole file     control 0, feature 0  → BLIND
//   base/lib/<abi>/libapp.so in the zip   Defl:N ~59% — that IS the blindness
//   THIS gate, inflating module entries   control 3, feature 0  → ok
//   THIS gate, on the proto manifest      8 uses-permission entries
//
// 🔴 The protobuf reader is cross-validated rather than trusted, because a
// parser checked only against its own output would be the shape CLAUDE.md
// names: 「测试把我们的假设念回给我们听」. Two independent readings, hours apart,
// on a tree that moved between them:
//
//   · same-hour pair — the 8 permissions this reader takes out of the bundle's
//     protobuf manifest are, name for name AND in the same order, the 8 that
//     `aapt dump permissions` takes out of the store APK of the same flavour.
//   · later pair, after concurrent work dropped READ_MEDIA_IMAGES from the
//     merged manifest — this reader on a freshly built bundle: 7 names; aapt on
//     the direct APK of the same tree: 8 names. The difference is exactly
//     `REQUEST_INSTALL_PACKAGES` and nothing else, with the other 7 in the same
//     relative order. That is the flavour split itself, measured.
//
// ⚠️ So do NOT read "8" (or "7") as a property of this product. Both are
// readings of one artifact at one moment; the manifest changed under this file
// while it was being written, which is precisely how a true number becomes a
// stale one. What is stable — and what the drill pins — is the INVARIANT: the
// store set equals the direct set minus REQUEST_INSTALL_PACKAGES.
//
// The 256 ms it costs to inflate all 77,455,030 B of module payload is recorded
// so nobody later "optimises" it into a filename check.
//
// ── history kept, because it was true and is still instructive ─────────────
//
// The FIRST run against that bundle caught a defect in this gate, recorded at
// `declaredPermissions` rather than quietly fixed: the message said 「no
// aapt/aapt2 on this machine」 on a machine that had aapt. A gate whose job is to
// refuse artifacts must not itself hand out a confidently wrong diagnosis — the
// operator would have installed a tool that was already there and learned
// nothing about the bundle. Refusing was the correct behaviour at the time (this
// gate never passes a file it could not read); what changed is that the file can
// now be read.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import {
  APK_CONTROL_MARKER,
  APK_SELF_UPDATE_MARKER,
  countMarker,
} from './apk-self-update-marker.mjs';
import { findAaptForGates } from './publish-apk-gates.mjs';

/** The permission Play forbids for our use case, and the one the store flavour
 *  exists to leave out. Declared here as data so the drill can assert on the
 *  exact string an operator will read. */
export const STORE_FORBIDDEN_PERMISSION =
  'android.permission.REQUEST_INSTALL_PACKAGES';

/**
 * The byte half, for an APK. Mirror of `scanApkForSelfUpdate`, and the verdicts
 * are named for what an operator must DO about them.
 *
 * @returns {{control:number, feature:number,
 *            verdict:'ok'|'carries-self-update'|'blind'}}
 */
export function scanStoreArtifact(buf) {
  const control = countMarker(buf, APK_CONTROL_MARKER);
  const feature = countMarker(buf, APK_SELF_UPDATE_MARKER);
  // 'blind' first, exactly as in the sibling gate: a scan that cannot see
  // anything must never be reported as "clean". Absence of evidence is what
  // this whole gate is looking for, so a blind scan would otherwise be its
  // most confident pass.
  if (control === 0) return { control, feature, verdict: 'blind' };
  if (feature > 0) return { control, feature, verdict: 'carries-self-update' };
  return { control, feature, verdict: 'ok' };
}

/**
 * Permissions an APK declares, via aapt.
 *
 * 🔴 THREE OUTCOMES, NOT TWO, AND THE THIRD ONE IS HERE BECAUSE THIS GATE GOT
 * IT WRONG ON ITS FIRST REAL RUN. The first version returned `null` both when
 * no aapt existed and when aapt failed to read the file, so pointing it at the
 * `.aab` printed 「no aapt/aapt2 on this machine」 — measured false on the very
 * machine that printed it (aapt was right there; an AAB simply has no
 * `AndroidManifest.xml` for it to dump). One value answering two questions, in
 * a gate written to enforce that rule. The two answers send an operator to two
 * different places, so they are two results.
 *
 * @returns {{reason:'ok', permissions:string[]}
 *          |{reason:'no-tool'}
 *          |{reason:'unreadable', detail:string}}
 */
export function declaredPermissions(apkPath) {
  const aapt = findAaptForGates();
  if (!aapt) return { reason: 'no-tool' };
  let out;
  try {
    out = execFileSync(aapt, ['dump', 'permissions', apkPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { reason: 'unreadable', detail: String(e.stderr || e.message).trim().split('\n')[0] };
  }
  return { reason: 'ok', permissions: parseAaptPermissions(out) };
}

/**
 * The parsing half of `declaredPermissions`, split out so the drill can pin it
 * without an Android SDK on the box. (The shelling-out half cannot be tested
 * anywhere aapt is absent, which is most CI — so the half that contains the
 * rule is the half that must be reachable from a test.)
 *
 * 🔴 The prefix is `uses-permission` and NOT `uses-permission:`. aapt prints a
 * second form, `uses-permission-sdk-23:`, for the API-23-gated declaration of
 * the very same permission. Anchoring on the colon read that as "not a
 * permission" and left a one-word bypass around the single permission this gate
 * exists to refuse. The bundle reader accepts both element names for the same
 * reason (see `usesPermissions`) — two readers, one rule.
 */
export function parseAaptPermissions(aaptOutput) {
  return aaptOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('uses-permission'))
    .map((l) => {
      const m = /name='([^']+)'/.exec(l);
      return m ? m[1] : null;
    })
    .filter(Boolean);
}

// ── reading an AAB: it is a zip, and node already ships the hard part ───────

/** `<module>/manifest/AndroidManifest.xml`. Not hard-coded to `base/`: a bundle
 *  may carry feature modules, and a permission declared in one of those is
 *  still a permission this artifact declares. */
const MODULE_MANIFEST = /^[^/]+\/manifest\/AndroidManifest\.xml$/;

/**
 * Entries of a zip archive, read from the CENTRAL DIRECTORY — not from local
 * file headers, whose size fields are legitimately zero when a data descriptor
 * is used. Throws on anything it cannot read rather than returning a partial
 * list: this gate asserts an ABSENCE, so an archive read halfway is the single
 * input that must never reach the judge with a verdict attached.
 *
 * @returns {{name:string, method:number, csize:number, usize:number, lho:number}[]}
 */
export function zipEntries(buf) {
  if (buf.length < 22) throw new Error('too small to be a zip archive');
  let eocd = -1;
  // 22 B record + up to 64 KiB of trailing comment.
  const floor = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  // The zip64 sentinels. This reader does not implement zip64, and the honest
  // response to "I cannot parse this" is to say so — not to read the truncated
  // 32-bit fields, which would produce a plausible-looking entry list for the
  // wrong offsets and then a confident verdict about the wrong bytes.
  if (count === 0xffff || off === 0xffff_ffff) {
    throw new Error('zip64 archive: this reader does not handle it (refusing rather than guessing)');
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    out.push({
      name: buf.toString('utf8', off + 46, off + 46 + nlen),
      method: buf.readUInt16LE(off + 10),
      csize: buf.readUInt32LE(off + 20),
      usize: buf.readUInt32LE(off + 24),
      lho: buf.readUInt32LE(off + 42),
    });
    off += 46 + nlen + elen + clen;
  }
  return out;
}

/** One entry's real bytes. Stored and Deflate only — an unknown method throws,
 *  for the same reason zip64 does. */
export function inflateZipEntry(buf, e) {
  if (e.lho + 30 > buf.length || buf.readUInt32LE(e.lho) !== 0x04034b50) {
    throw new Error(`corrupt local header for ${e.name}`);
  }
  const nlen = buf.readUInt16LE(e.lho + 26);
  const elen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nlen + elen;
  const raw = buf.subarray(start, start + e.csize);
  let out;
  if (e.method === 0) out = Buffer.from(raw);
  else if (e.method === 8) out = inflateRawSync(raw);
  else throw new Error(`${e.name}: unsupported compression method ${e.method}`);
  // The size the archive itself declares vs. what came out. Cheap, and it is
  // the 「先核你的尺子」 check: a reader that silently returned short buffers
  // would make every absence assertion below trivially true.
  if (out.length !== e.usize) {
    throw new Error(`${e.name}: inflated ${out.length} B but the directory says ${e.usize} B`);
  }
  return out;
}

/**
 * APK or AAB — decided by CONTENT, never by the extension. A file named `.aab`
 * that is actually an APK (or the reverse) is exactly the kind of mix-up this
 * gate exists to catch, so a filename is not evidence about its own subject.
 *
 * @returns {{kind:'aab'|'apk', entries:object[]}|{kind:'unknown', detail:string}}
 */
export function detectArtifactKind(buf) {
  let entries;
  try {
    entries = zipEntries(buf);
  } catch (e) {
    return { kind: 'unknown', detail: e.message };
  }
  const names = entries.map((e) => e.name);
  if (names.includes('BundleConfig.pb') && names.some((n) => MODULE_MANIFEST.test(n))) {
    return { kind: 'aab', entries };
  }
  if (names.includes('AndroidManifest.xml')) return { kind: 'apk', entries };
  return {
    kind: 'unknown',
    detail:
      'a zip, but neither an APK (root AndroidManifest.xml) nor an AAB ' +
      '(BundleConfig.pb + <module>/manifest/AndroidManifest.xml)',
  };
}

/**
 * Is this entry part of what a device ends up running?
 *
 * `BUNDLE-METADATA/` (R8 mapping, native debug symbols, baseline profiles) and
 * `META-INF/` are Play-side and signing data; `BundleConfig.pb` describes how to
 * split, not what to run. None of them reach a device, so scanning them would
 * let a symbol name in a debug artifact fail a build whose shipped bytes are
 * clean — a confident verdict about bytes no user receives.
 */
export function isShippedModuleEntry(name) {
  if (name.endsWith('/')) return false;
  if (name === 'BundleConfig.pb') return false;
  const top = name.split('/')[0];
  return top !== 'BUNDLE-METADATA' && top !== 'META-INF';
}

/**
 * The byte half, for an AAB. Same triple, same 'blind'-first order, and the same
 * control marker — but every entry must be INFLATED first, because that is the
 * whole difference between the two containers: an APK stores
 * `lib/<abi>/libapp.so` uncompressed (android:extractNativeLibs=false requires
 * it), a bundle deflates it [measured ~59%, §measurement-aab]. Running the raw
 * scan on bundle bytes is what produced the old BLIND verdict, and BLIND was the
 * right answer to the wrong question.
 *
 * @returns {{control:number, feature:number,
 *            verdict:'ok'|'carries-self-update'|'blind'|'unreadable',
 *            detail?:string}}
 */
export function scanStoreBundle(buf, entries) {
  let control = 0;
  let feature = 0;
  try {
    for (const e of entries) {
      if (!isShippedModuleEntry(e.name)) continue;
      const bytes = inflateZipEntry(buf, e);
      control += countMarker(bytes, APK_CONTROL_MARKER);
      feature += countMarker(bytes, APK_SELF_UPDATE_MARKER);
    }
  } catch (e) {
    // Distinct from 'blind': blind means "read it, saw nothing"; this means
    // "could not read it". Two causes, two things to do about them.
    return { control, feature, verdict: 'unreadable', detail: e.message };
  }
  if (control === 0) return { control, feature, verdict: 'blind' };
  if (feature > 0) return { control, feature, verdict: 'carries-self-update' };
  return { control, feature, verdict: 'ok' };
}

// ── the protobuf half: aapt2 cannot read a bundle manifest, varints can ─────
//
// `aapt2 dump xmltree --file base/manifest/AndroidManifest.xml <aab>` exits 1
// with "could not identify format of APK" [measured, §measurement-aab], so the
// bundle's manifest is parsed here. Only the wire format is needed, and only
// three message shapes out of aapt2's Resources.proto:
//
//   XmlNode      { XmlElement element = 1 }
//   XmlElement   { string name = 3; repeated XmlAttribute attribute = 4;
//                  repeated XmlNode child = 5 }
//   XmlAttribute { string namespace_uri = 1; string name = 2; string value = 3 }
//
// Field NUMBERS are the contract here, not field names, and protobuf's own
// compatibility rules freeze them — which is why a hand reader is safe in a way
// that scraping strings out of the blob would not be. A raw grep for
// `android.permission.*` over the same manifest also returns `BIND_JOB_SERVICE`
// and `DUMP` [measured]: those are `android:permission` attributes on services,
// not permissions this app requests. Same characters, different question.

/** Reads one protobuf varint. Returns [value, nextOffset]. */
function readVarint(b, i) {
  let value = 0n;
  let shift = 0n;
  for (;;) {
    if (i >= b.length) throw new Error('truncated varint');
    const c = b[i++];
    value |= BigInt(c & 0x7f) << shift;
    if ((c & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error('varint too long');
  }
  return [value, i];
}

/** Yields {num, wire, bytes?} for each field of one protobuf message. */
function* protoFields(b) {
  let i = 0;
  while (i < b.length) {
    let key;
    [key, i] = readVarint(b, i);
    const num = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      [, i] = readVarint(b, i);
      yield { num, wire };
    } else if (wire === 2) {
      let len;
      [len, i] = readVarint(b, i);
      const end = i + Number(len);
      if (end > b.length) throw new Error('truncated length-delimited field');
      yield { num, wire, bytes: b.subarray(i, end) };
      i = end;
    } else if (wire === 5) {
      i += 4;
      yield { num, wire };
    } else if (wire === 1) {
      i += 8;
      yield { num, wire };
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

/** XmlNode -> its XmlElement bytes, or null when the node is text. */
function xmlElement(nodeBytes) {
  for (const f of protoFields(nodeBytes)) if (f.num === 1 && f.wire === 2) return f.bytes;
  return null;
}

function xmlElementParts(elementBytes) {
  let name = '';
  const attributes = [];
  const children = [];
  for (const f of protoFields(elementBytes)) {
    if (f.wire !== 2) continue;
    if (f.num === 3) name = f.bytes.toString('utf8');
    else if (f.num === 4) attributes.push(f.bytes);
    else if (f.num === 5) children.push(f.bytes);
  }
  return { name, attributes, children };
}

function xmlAttributeParts(attributeBytes) {
  let ns = '';
  let name = '';
  let value = '';
  for (const f of protoFields(attributeBytes)) {
    if (f.wire !== 2) continue;
    if (f.num === 1) ns = f.bytes.toString('utf8');
    else if (f.num === 2) name = f.bytes.toString('utf8');
    else if (f.num === 3) value = f.bytes.toString('utf8');
  }
  return { ns, name, value };
}

/**
 * The permission names a protobuf-encoded AndroidManifest requests.
 *
 * Accepts `uses-permission-sdk-23` as well as `uses-permission`: it declares the
 * same permission with an API floor, and treating it as a different element
 * would leave a one-word bypass around the single permission this gate exists to
 * refuse. `declaredPermissions` (the aapt path) was widened to match on the same
 * day and for the same reason.
 */
export function usesPermissions(manifestProto) {
  const root = xmlElement(manifestProto);
  if (!root) throw new Error('manifest protobuf has no root element');
  const { name, children } = xmlElementParts(root);
  if (name !== 'manifest') throw new Error(`manifest protobuf root is <${name}>, not <manifest>`);
  const out = [];
  for (const child of children) {
    const el = xmlElement(child);
    if (!el) continue;
    const parts = xmlElementParts(el);
    if (parts.name !== 'uses-permission' && parts.name !== 'uses-permission-sdk-23') continue;
    for (const a of parts.attributes) {
      const attr = xmlAttributeParts(a);
      if (attr.ns === ANDROID_NS && attr.name === 'name') out.push(attr.value);
    }
  }
  return out;
}

/**
 * Permissions an AAB declares — every module's manifest, unioned. Same result
 * shape as `declaredPermissions` so the judge below cannot tell which container
 * it is judging, and therefore cannot grow two sets of rules.
 *
 * There is no 'no-tool' outcome here: node's zlib is the tool, and it is always
 * present. That is a second reason this path is better than the aapt one, not
 * merely an implementation detail.
 *
 * @returns {{reason:'ok', permissions:string[]}|{reason:'unreadable', detail:string}}
 */
export function bundleDeclaredPermissions(buf, entries) {
  const manifests = entries.filter((e) => MODULE_MANIFEST.test(e.name));
  if (manifests.length === 0) {
    return {
      reason: 'unreadable',
      detail: 'no <module>/manifest/AndroidManifest.xml in the bundle',
    };
  }
  const permissions = new Set();
  try {
    for (const m of manifests) {
      for (const p of usesPermissions(inflateZipEntry(buf, m))) permissions.add(p);
    }
  } catch (e) {
    return { reason: 'unreadable', detail: e.message };
  }
  return { reason: 'ok', permissions: [...permissions] };
}

// ── the judge ──────────────────────────────────────────────────────────────

/** The whole verdict, from facts already gathered. Pure: the caller supplies a
 *  scan triple and a permission result, whichever container they came from. */
export function judgeStoreFacts(scan, perms) {
  const problems = [];
  if (scan.verdict === 'blind') {
    problems.push(
      `the scan is BLIND: the control marker '${APK_CONTROL_MARKER}' is absent, so ` +
        'this file is either not a FlowMic build or its payload could not be seen. ' +
        'Nothing is proven about the self-updater either way — fix the scan, do not publish.',
    );
  } else if (scan.verdict === 'unreadable') {
    problems.push(
      `the payload could not be read (${scan.detail}). That is not the same as ` +
        '"nothing found": this gate asserts an ABSENCE, so a container it cannot ' +
        'open is refused rather than reported clean.',
    );
  } else if (scan.verdict === 'carries-self-update') {
    problems.push(
      `it CARRIES the self-updater (${scan.feature} hit(s) of '${APK_SELF_UPDATE_MARKER}'). ` +
        'A store artifact must be built with `--flavor store` and WITHOUT ' +
        '--dart-define=FLOWMIC_SELF_UPDATE — see apps/mobile/Makefile `release-store`.',
    );
  }
  if (perms.reason === 'no-tool') {
    problems.push(
      'permissions could not be read: no aapt/aapt2 on this machine. This gate ' +
        'does not pass on an unasked question — install Android build-tools, run ' +
        'it where they exist, or point it at the .aab (which needs no aapt).',
    );
  } else if (perms.reason === 'unreadable') {
    problems.push(
      `permissions could not be read: ${perms.detail}. An unread manifest is not ` +
        'an empty one — refusing.',
    );
  } else if (perms.permissions.includes(STORE_FORBIDDEN_PERMISSION)) {
    problems.push(
      `it declares ${STORE_FORBIDDEN_PERMISSION}. That line lives in the DIRECT ` +
        'flavour only (android/app/src/direct/AndroidManifest.xml); its presence ' +
        'here means the build did not use --flavor store.',
    );
  }
  return { scan, perms, problems, pass: problems.length === 0 };
}

/** APK convenience wrapper, kept so the drill and any caller that already holds
 *  APK bytes keep the signature they had. */
export function judgeStoreArtifact(buf, perms) {
  return judgeStoreFacts(scanStoreArtifact(buf), perms);
}

function main(argv) {
  const path = argv[2];
  if (!path) {
    console.error('usage: node scripts/store-channel-gate.mjs <store.aab|store.apk>');
    return 2;
  }
  if (!existsSync(path)) {
    console.error(`store-channel-gate: no such file: ${path}`);
    return 2;
  }
  const buf = readFileSync(path);
  const name = path.split(/[\\/]/).pop();
  const detected = detectArtifactKind(buf);
  if (detected.kind === 'unknown') {
    // Exit 2, not 1: "this is not a store artifact" and "I could not tell what
    // this is" send an operator to two different places. Either way nothing is
    // published — the distinction is in what they should go and look at.
    console.error(`FAIL ${name} could not be identified: ${detected.detail}`);
    return 2;
  }
  const verdict =
    detected.kind === 'aab'
      ? judgeStoreFacts(
          scanStoreBundle(buf, detected.entries),
          bundleDeclaredPermissions(buf, detected.entries),
        )
      : judgeStoreFacts(scanStoreArtifact(buf), declaredPermissions(path));
  if (verdict.pass) {
    // The container is named in the PASS line on purpose. "The gate was green"
    // must not be separable from "green about WHICH artifact" — the AAB is what
    // Play receives, and an operator reading this line months from now should
    // not have to reconstruct which file was measured.
    console.log(
      `OK  ${name} is a store ${detected.kind.toUpperCase()}: no self-updater ` +
        `(control ${verdict.scan.control} hit(s), feature 0), ` +
        `${verdict.perms.permissions.length} permission(s), none of them ` +
        `${STORE_FORBIDDEN_PERMISSION}`,
    );
    return 0;
  }
  console.error(
    `FAIL ${name} (${detected.kind.toUpperCase()}) is NOT a publishable store artifact:`,
  );
  for (const p of verdict.problems) console.error(`  · ${p}`);
  return 1;
}

// Run as a command, importable as a module: the drill imports the judgement
// functions, the operator runs the file. The entry comparison is the repo's
// existing idiom (adopt-artifact.mjs): realpath both sides, and treat a missing
// argv[1] (`node -e`, a worker thread) as 「not the entry point」 rather than
// crashing on it — a guard that throws while deciding whether to run is worse
// than either answer.
const thisFile = fileURLToPath(import.meta.url);
const argvEntry = process.argv[1] ? resolve(process.argv[1]) : null;
const canon = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
if (argvEntry && normalize(canon(thisFile)) === normalize(canon(argvEntry))) {
  process.exit(main(process.argv));
}
