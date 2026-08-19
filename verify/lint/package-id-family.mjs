// verify/lint/package-id-family.mjs
// P0-PKG (G2) — the platform identifiers may not snap back.
//
// ── WHAT THIS DEFENDS AGAINST, AND WHY NOTHING ELSE COULD SEE IT ─────────────
//
// On 2026-08-11 the owner ruled the identifier family. A Mac was edited to
// `app.flowmic.ios`, a findings document said so, and on 2026-08-12
// `git log -S 'app.flowmic.ios' -- apps/mobile` was EMPTY: the string existed on
// one machine and nowhere in the repository. The next checkout, rsync or tool
// run would restore the old value, and nobody would have made a mistake. That is
// what "snap-back" is — not a typo, but a value with no owner and no judge.
//
// 🔴 THE FAILURE IS INVISIBLE TO EVERY OTHER GATE, BY CONSTRUCTION. An
// applicationId is a literal in a Gradle file; a bundle id is a literal in a
// pbxproj; a Tauri identifier is a literal in JSON. No type checker reads any of
// them, no unit test asserts them, and BOTH values compile and ship. The only
// mechanism that can hold this line is one that walks the surfaces and compares
// them to a written-down answer.
//
// So this gate does exactly two things, and says which is which:
//   (1) FORBID  — the retired ids must not appear on any product surface;
//   (2) REQUIRE — each target id must be present at the surface that ships it.
//
// (2) is not decoration. Without it, deleting the `identifier` line entirely
// would satisfy (1) — a gate that only bans things is green on an empty file.
// This is the `scanner-blind` lesson (UP-7, android-provider-classes): 「I can't
// find the bad thing」 and 「the good thing is there」 are different questions and
// must never share a verdict.
//
// ── WHAT IT CANNOT SEE (stated, not implied) ────────────────────────────────
//
// It reads SOURCE, not artifacts. It cannot tell you that the APK Gradle
// actually produced carries `app.flowmic.android`, or that the .app bundle's
// Info.plist says `app.flowmic.mac` — a build could in principle override either
// from a command line this scanner never sees. Those are device-line readings
// (`aapt dump badging`, `codesign -dv`). Do not widen this header into a claim
// that the shipped artifact was checked.
//
// SPEC-REF:
//   scripts/package-ids.mjs (G1 — the SSOT this file reads)
//   docs/strategy/2026-08-12-p0-app-flowmic-package-id-migration.md (G1–G4)
//   docs/decisions/2026-08-11-owner-bundle-id-family-app-flowmic.md

import path from 'node:path';
import { ROOT, walk, readText, rel, DEFAULT_SKIP_DIRS } from './_util.mjs';
import {
  PACKAGE_IDS,
  IOS_TEST_BUNDLE_ID,
  METHOD_CHANNELS,
  ANDROID_KOTLIN_DIR,
  LEGACY_PACKAGE_IDS,
  LEGACY_METHOD_CHANNEL_NAMESPACE,
} from '../../scripts/package-ids.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/package-id-family.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'package-id-family';

// ── (1) THE BAN ─────────────────────────────────────────────────────────────

/**
 * The forbidden text. One pattern rather than a list of exact ids, because the
 * ban has to survive somebody inventing a THIRD legacy value: any reverse-DNS
 * under the retired `cloud.flowmic` root is wrong on a product surface, whether
 * or not this repo ever shipped it.
 *
 * `LEGACY_PACKAGE_IDS` and `LEGACY_METHOD_CHANNEL_NAMESPACE` are imported and
 * asserted against this pattern below — the SSOT names the values, this names
 * the shape, and a mismatch between them is itself a failure.
 */
const FORBIDDEN = /cloud\.flowmic/;

/**
 * Trees that ship, or that write things that ship. Everything outside this list
 * is unscanned — which is the honest way to say 「docs and records are exempt」:
 * the exemption is a positive list of what IS product, not a growing list of
 * excuses.
 *
 * 🔴 DELIBERATELY ABSENT, each for a stated reason — this is the exemption list
 * the card asks to be written out:
 *   • `docs/**`      — decision records and window handoffs. A record that
 *                      cannot say what it decided against is not a record, and
 *                      CLAUDE.md forbids a global regex over them outright
 *                      ("never run a global regex over the document surface… a blanket rewrite is falsifying the record").
 *   • `CHANGELOG.md` — the same, plus this migration's own release note has to
 *                      name the old id so a user can recognise the app they
 *                      already have installed.
 *   • `scratch/**`   — real-device session sheets. They record which package was
 *                      on which handset on which day; rewriting them would make
 *                      a past measurement describe a build that never existed.
 *   • `CLAUDE.md`    — the operating contract, which is a record too.
 */
const PRODUCT_ROOTS = ['apps', 'packages', 'scripts', 'verify'];

/**
 * The single product file allowed to name a retired identifier, BY NAME.
 *
 * 🔴 One entry, and it earns it: `webview_profile.rs` migrates WebView2
 * `localStorage` out of `%LOCALAPPDATA%\<old identifier>\`. That directory is an
 * ADDRESS, not a label — it is the only place a pre-migration user's UI state
 * can be found, and it has to stay spelled correctly forever. Every other
 * mention in the product is prose, and prose was reworded instead of exempted.
 *
 * ⚠️ Adding a second entry here is a decision, not a formality. The question to
 * answer first is 「is this string an address, or is it a description?」 — only
 * addresses belong.
 */
const EXEMPT_FILES = new Set(['apps/desktop/src-tauri/src/webview_profile.rs']);

/**
 * This file itself, and the SSOT, obviously contain the forbidden text: one
 * declares it and one bans it. Excluding them by path rather than by a clever
 * regex, so the exclusion is visible.
 */
const SELF = new Set(['verify/lint/package-id-family.mjs', 'scripts/package-ids.mjs']);

// ── (2) THE REQUIREMENT ─────────────────────────────────────────────────────

/**
 * Every surface that MUST carry a target string, and the exact text it must
 * carry. `must` is a plain substring on purpose — a regex here would be a second
 * place where 「what counts as the identifier」 is decided.
 */
function requiredSurfaces() {
  const kotlin = (f) => `${ANDROID_KOTLIN_DIR}/${f}`;
  return [
    {
      file: 'apps/mobile/android/app/build.gradle.kts',
      must: [`namespace = "${PACKAGE_IDS.android}"`, `applicationId = "${PACKAGE_IDS.android}"`],
      why: 'the Android application id and Kotlin namespace',
    },
    {
      file: 'apps/mobile/ios/Runner.xcodeproj/project.pbxproj',
      must: [
        `PRODUCT_BUNDLE_IDENTIFIER = ${PACKAGE_IDS.ios};`,
        `PRODUCT_BUNDLE_IDENTIFIER = ${IOS_TEST_BUNDLE_ID};`,
      ],
      why: 'the iOS app and test bundle ids — this file is the reason P0-PKG exists '
        + '(the previous round lived only on a Mac and never reached git)',
    },
    {
      file: 'apps/desktop/src-tauri/tauri.conf.json',
      must: [`"identifier": "${PACKAGE_IDS.windows}"`],
      why: 'the Tauri identifier used for Windows bundles',
    },
    {
      file: 'apps/desktop/src-tauri/tauri.macos.conf.json',
      must: [`"identifier": "${PACKAGE_IDS.macos}"`],
      why: 'the macOS overlay Tauri merges for mac targets — one conf cannot '
        + 'truthfully answer for two platforms, so there are two',
    },
    {
      file: 'apps/desktop/src-tauri/src/webview_profile.rs',
      must: [`CURRENT_PROFILE_LEAF: &str = "${PACKAGE_IDS.windows}"`],
      why: 'the desktop reads its own webview profile out of a directory named '
        + 'by the identifier; a drift here migrates state into a directory nothing uses',
    },
    // ── MethodChannels: BOTH sides, in one gate, on purpose ──────────────────
    // A one-sided rename does not degrade anything — it makes the platform
    // handler unreachable, `invokeMethod` throws MissingPluginException, and on
    // device_info that lands during app start. Dart and Kotlin cannot import the
    // SSOT, so this is where they are held to it.
    {
      file: 'apps/mobile/lib/src/session/platform_device_info.dart',
      must: [`MethodChannel('${METHOD_CHANNELS.deviceInfo}')`],
      why: 'Dart side of the device-info channel',
    },
    {
      file: kotlin('DeviceInfo.kt'),
      must: [`CHANNEL = "${METHOD_CHANNELS.deviceInfo}"`],
      why: 'Kotlin side of the device-info channel',
    },
    {
      file: 'apps/mobile/lib/src/session/image_clipboard.dart',
      must: [`'${METHOD_CHANNELS.imageClipboard}'`],
      why: 'Dart side of the image-clipboard channel',
    },
    {
      file: kotlin('ImageClipboard.kt'),
      must: [`CHANNEL = "${METHOD_CHANNELS.imageClipboard}"`],
      why: 'Kotlin side of the image-clipboard channel',
    },
    {
      file: 'apps/mobile/lib/src/update/update_installer.dart',
      must: [`'${METHOD_CHANNELS.updateInstaller}'`],
      why: 'Dart side of the update-installer channel',
    },
    {
      file: kotlin('UpdateInstaller.kt'),
      must: [`CHANNEL = "${METHOD_CHANNELS.updateInstaller}"`],
      why: 'Kotlin side of the update-installer channel',
    },
  ];
}

export default async function run() {
  const failures = [];

  // ── (0) The SSOT must agree with the shape this file bans. ────────────────
  // Without this, somebody could retire a third id, add it to LEGACY_PACKAGE_IDS,
  // and the ban would quietly not cover it.
  for (const legacy of [...LEGACY_PACKAGE_IDS, LEGACY_METHOD_CHANNEL_NAMESPACE]) {
    if (!FORBIDDEN.test(legacy)) {
      failures.push(
        `the SSOT lists "${legacy}" as retired, but this gate's FORBIDDEN pattern ` +
          `(${FORBIDDEN}) does not match it — the ban and the list have drifted`
      );
    }
  }
  // And a target id must never itself match the ban (a rename to something still
  // under the old root would be green on both halves otherwise).
  for (const [platform, id] of Object.entries(PACKAGE_IDS)) {
    if (FORBIDDEN.test(id)) {
      failures.push(`target id for ${platform} ("${id}") matches the retired pattern`);
    }
  }

  // ── (1) Ban sweep. ────────────────────────────────────────────────────────
  let scanned = 0;
  const offenders = [];
  for (const root of PRODUCT_ROOTS) {
    const abs = path.join(ROOT, root);
    for (const file of await walk(abs, { skipDir: (n) => DEFAULT_SKIP_DIRS.has(n) })) {
      const r = rel(file);
      if (SELF.has(r) || EXEMPT_FILES.has(r)) continue;
      const src = await readText(file);
      if (src == null) continue;
      scanned++;
      if (!FORBIDDEN.test(src)) continue;
      const line = src.split('\n').findIndex((l) => FORBIDDEN.test(l)) + 1;
      offenders.push(`${r}:${line}`);
    }
  }
  // Control assertion: a walk that reads nothing must not report 「clean」.
  if (scanned === 0) {
    failures.push(
      `walked ${PRODUCT_ROOTS.join('/')} and read 0 files — the scanner is blind, ` +
        `which is not the same as the tree being clean`
    );
  }
  if (offenders.length > 0) {
    failures.push(
      `retired identifier (${FORBIDDEN}) on ${offenders.length} product surface(s): ` +
        `${offenders.slice(0, 8).join(', ')}${offenders.length > 8 ? ', …' : ''} — ` +
        `migrate it, or if the string is an ADDRESS rather than a label, add the file ` +
        `to EXEMPT_FILES with the reason`
    );
  }

  // ── (2) Presence sweep. ───────────────────────────────────────────────────
  const surfaces = requiredSurfaces();
  for (const s of surfaces) {
    const src = await readText(path.join(ROOT, s.file));
    if (src == null) {
      failures.push(`cannot read ${s.file} — ${s.why} is unverifiable, not verified`);
      continue;
    }
    for (const needle of s.must) {
      if (!src.includes(needle)) {
        failures.push(`${s.file} does not contain \`${needle}\` (${s.why})`);
      }
    }
  }

  if (failures.length > 0) {
    return { status: 'FAIL', detail: failures.join(' | ') };
  }
  return {
    status: 'PASS',
    detail:
      `${Object.values(PACKAGE_IDS).join(' / ')} present across ${surfaces.length} surface(s); ` +
      `no retired id in ${scanned} product file(s) ` +
      `(${EXEMPT_FILES.size} exempt by name, docs/CHANGELOG/scratch unscanned by design)`,
  };
}
