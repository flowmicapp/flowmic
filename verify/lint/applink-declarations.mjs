// verify/lint/applink-declarations.mjs
// APPLINK-1 — the https pairing link is declared to BOTH operating systems, and
// the declaration is actually applied to the build.
//
// ── WHAT THE PROBLEM ACTUALLY IS ─────────────────────────────────────────────
// The desktop prints a pairing QR carrying `https://flowmic.app/go/pair?…`
// (apps/desktop/src/lib/pairing.ts `buildHttpsQrPayload`, host from
// `PAIR_HTTPS_HOST`), and the phone parses that prefix
// (apps/mobile/lib/src/ui/scan_payload.dart `kPairLinkPrefixHttps`, which IS
// the protocol constant: apps/mobile/tool/gen_protocol.mjs generates it, and
// verify/lint/pair-link-single-source.mjs refuses a hand-typed second copy).
//
// 🔴 PARSING A URL IS NOT THE SAME AS BEING OFFERED IT. Which app the OS hands
// an https URL to is decided by a MANIFEST ENTRY on Android and an ENTITLEMENT
// on iOS — neither of which any compiler, any Dart test, or the host mirror
// above can see. Until this card both were missing, so a phone that HAS FlowMic
// scanned the pairing QR with the system camera and got a browser. That defect
// is silent in every direction: the parser is right, its tests are green, the
// mirror lint is green, and the product does not work.
//
// ── WHY IT ASSERTS THREE THINGS AND NOT ONE ──────────────────────────────────
// Each is a different fact with its own failure mode, and none implies another:
//
//   1. ANDROID — `src/main/AndroidManifest.xml` carries a VIEW / DEFAULT /
//      BROWSABLE intent-filter with `android:autoVerify="true"` whose data
//      element is https + the protocol host + the protocol path. Dropping any ONE of
//      those still leaves a filter that looks right in a diff: without
//      BROWSABLE a link from a web page cannot reach us at all, and without
//      `autoVerify` Android offers a disambiguation chooser instead of routing
//      — a different product, quietly.
//   2. iOS — Runner.entitlements declares `applinks:<the same host>`.
//   3. iOS AGAIN, and this is the one that matters most — that file is named by
//      `CODE_SIGN_ENTITLEMENTS` in EVERY build configuration of the Runner
//      target. There was no entitlements file and no such build setting in this
//      project before this card, so the natural half-finished state is a
//      correct-looking file that no build signs with. An entitlement nobody
//      applies is a file, not a capability — the「能力定义了没人调用」("a capability
//      defined that nobody calls") shape this repo names as its #1 historical
//      bug class. A scanner that only asked "does the file say applinks?" would
//      call that clean.
//
// The host AND the path are READ OUT OF packages/protocol/src/constants.ts rather than typed
// here, so moving either fails red instead of half-migrating the product. If
// that constant stops being a plain literal this lint FAILS rather than passing
// while covering nothing — the shape pair-link-single-source.mjs and
// password-policy-mirror.mjs already use.
//
// ── 🔴 WHAT THIS DOES NOT PROVE (stated, not implied) ────────────────────────
// · IT PROVES NOTHING ABOUT A PHONE. Both declarations are INERT until
//   flowmic.app publishes `/.well-known/assetlinks.json` and
//   `/.well-known/apple-app-site-association`. Those files do not exist —
//   publishing the hostname is the owner's decision — so today the OS still
//   sends the link to a browser on both platforms. This lint asserts our half is
//   present and applied; it cannot see the domain's half, and nothing here may
//   be quoted as "app links work".
// · IT SAYS NOTHING ABOUT SIGNING CERTIFICATES. A Play install is re-signed by
//   Google's key, so the published assetlinks.json must carry Play's
//   fingerprint as well as our release key's. No fingerprint is pinned anywhere
//   in this repo and this lint does not invent one.
// · IT SAYS NOTHING ABOUT WHAT THE APP DOES WITH THE LINK ONCE OPENED. Nothing
//   in the Dart tree subscribes to an incoming pairing URL — app_links is
//   constructed only inside lib/src/ui/login_sheet.dart, for the
//   `flowmic://login` hand-back. Routing it is a behaviour change and a
//   different card.
// · It reads SOURCE. The merged Android manifest and a signed .app are build
//   artifacts, and a Windows gate has zero proving power over what Xcode does.
//
// ── REVERSE CONTROL ──────────────────────────────────────────────────────────
// Four drills, run 2026-09-07 on dev-pc-a in the `lane/applinks`
// worktree. Each edit was reverted by hand and `git diff` on the touched file
// was empty afterwards. Readings verbatim, wrapped here only to fit.
//
// ⚠️ THE FOUR READINGS BELOW SAY `go.flowmic.app/pair`, AND THEY ARE LEFT THAT
// WAY ON PURPOSE. They are what this lint printed on 2026-09-07, and a
// measurement is not improved by editing it afterwards to match today's tree.
// The URL moved to `https://flowmic.app/go/pair` on 2026-09-08 (card DOM-1,
// owner ruling: no new hostname). What the drills prove is unchanged, because
// each one removes a DECLARATION and the URL in the message is interpolated
// from the protocol constants — which is the property DOM-1 then extended from
// the host alone to the host and the path.
//
// A — THE ANDROID DECLARATION IS DELETED (the state this tree was in before the
//     card):
//
//   FAIL apps/mobile/android/app/src/main/AndroidManifest.xml declares no
//   verified app link for https://go.flowmic.app/pair — the phone parses that
//   prefix (apps/mobile/lib/src/ui/scan_payload.dart) but Android has never been
//   told this app owns the URL, so the system camera hands the pairing QR to a
//   browser on a phone that HAS FlowMic. Needs one <intent-filter
//   android:autoVerify="true"> with VIEW + DEFAULT + BROWSABLE and <data
//   android:scheme="https" android:host="go.flowmic.app" android:path="/pair"/>
//
// B — `android:autoVerify` IS REMOVED, everything else intact. The drill that
//     matters on the Android side: the filter still reads correctly to a human,
//     and the app is merely OFFERED in a chooser instead of owning the link.
//
//   FAIL apps/mobile/android/app/src/main/AndroidManifest.xml:248 has an
//   intent-filter for https://go.flowmic.app/pair but it is missing
//   android:autoVerify="true" — without it Android never fetches
//   /.well-known/assetlinks.json, so the link is never verified and the user
//   gets a chooser (or the browser) instead of the app
//
// C — THE iOS ENTITLEMENT IS DELETED:
//
//   FAIL apps/mobile/ios/Runner/Runner.entitlements is missing — it is the only
//   place iOS is told this app owns go.flowmic.app (key
//   com.apple.developer.associated-domains, entry applinks:go.flowmic.app)
//
// D — THE FILE STAYS AND THE BUILD SETTING GOES. The façade drill: everything a
//     reader looks at is present, and no build applies it.
//
//   FAIL apps/mobile/ios/Runner.xcodeproj/project.pbxproj: the Runner target's
//   Debug, Release, Profile configuration(s) do not set CODE_SIGN_ENTITLEMENTS =
//   Runner/Runner.entitlements — the entitlements file exists and nothing signs
//   with it, so the capability is absent from every build while the repo looks
//   correct
//
// The green reading all four return to is printed by `pnpm verify:lint`.

import path from 'node:path';

import { ROOT, readText, lineOf } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'applink-declarations';

const PROTOCOL_FILE = 'packages/protocol/src/constants.ts';
const ANDROID_MANIFEST = 'apps/mobile/android/app/src/main/AndroidManifest.xml';
const IOS_ENTITLEMENTS = 'apps/mobile/ios/Runner/Runner.entitlements';
const IOS_PBXPROJ = 'apps/mobile/ios/Runner.xcodeproj/project.pbxproj';

const PROTO_RE = /^[ \t]*export[ \t]+const[ \t]+PAIR_HTTPS_HOST[ \t]*=[ \t]*'([^']+)'[ \t]*;/m;
/**
 * The one path the phone can act on — the tail of `kPairLinkPrefixHttps`.
 *
 * 🔴 READ OUT OF THE PROTOCOL PACKAGE, NOT TYPED HERE (card DOM-1). It used to
 * be the literal `/pair` in this file, which was indistinguishable from correct
 * for as long as the path never moved. The day it moved to `/go/pair` this lint
 * would have gone on asserting that Android declares a path the desktop no
 * longer prints — a green gate over a QR the phone hands to a browser.
 */
const PROTO_PATH_RE = /^[ \t]*export[ \t]+const[ \t]+PAIR_HTTPS_PATH[ \t]*=[ \t]*'([^']+)'[ \t]*;/m;

/**
 * Blank out XML comments, keeping newlines so line numbers stay true.
 *
 * Required, not cosmetic: the manifest block this lint guards EXPLAINS itself at
 * length and the entitlements file quotes the same host in prose. A scanner that
 * could not tell an explanation from a declaration would be one somebody
 * silences by deleting the explanation — the reasoning
 * verify/lint/android-install-permission.mjs carries for the same three lines.
 */
function stripXmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Every `<intent-filter …> … </intent-filter>` block, with its 1-based line. */
function intentFilters(code) {
  const out = [];
  const re = /<intent-filter\b[\s\S]*?<\/intent-filter>/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    out.push({ text: m[0], line: lineOf(code, m.index) });
  }
  return out;
}

/** The `<data …/>` elements of one filter, as attribute maps. */
function dataElements(filterText) {
  const out = [];
  const re = /<data\b[\s\S]*?\/>/g;
  let m;
  while ((m = re.exec(filterText)) !== null) {
    const attrs = {};
    const are = /android:(\w+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = are.exec(m[0])) !== null) attrs[a[1]] = a[2];
    out.push(attrs);
  }
  return out;
}

/**
 * The build configurations of the Runner TARGET, by name, with their text.
 *
 * Walks the project the way Xcode does — target -> its XCConfigurationList ->
 * each XCBuildConfiguration — rather than grepping the file for the setting.
 * That difference is the whole point of assertion 3: a `CODE_SIGN_ENTITLEMENTS`
 * line sitting in the RunnerTests target, or in a configuration the app target
 * does not use, satisfies a grep and signs nothing.
 *
 * Returns `{ error }` when the shape is not the one this parser understands, so
 * an unreadable project fails loudly instead of reporting zero problems.
 */
function runnerConfigs(pbx) {
  const listRef =
    /buildConfigurationList = ([0-9A-F]{24}) \/\* Build configuration list for PBXNativeTarget "Runner" \*\//.exec(pbx);
  if (!listRef) return { error: 'no PBXNativeTarget "Runner" with a build configuration list' };
  const listId = listRef[1];
  const listBlock = new RegExp(`${listId} /\\* [^*]*\\*/ = \\{[\\s\\S]*?\\};`).exec(pbx);
  if (!listBlock) return { error: `XCConfigurationList ${listId} is referenced but not defined` };
  const ids = [...listBlock[0].matchAll(/([0-9A-F]{24}) \/\* (\w+) \*\/,/g)].map((m) => ({ id: m[1], name: m[2] }));
  if (ids.length === 0) return { error: `XCConfigurationList ${listId} lists no build configurations` };
  const configs = [];
  for (const { id, name: cfgName } of ids) {
    const block = new RegExp(`${id} /\\* ${cfgName} \\*/ = \\{[\\s\\S]*?\\n\\t\\t\\};`).exec(pbx);
    if (!block) return { error: `build configuration ${cfgName} (${id}) is listed but not defined` };
    configs.push({ name: cfgName, text: block[0] });
  }
  return { configs };
}

export default async function run() {
  // ── The host, from the one place that owns it ──────────────────────────────
  const protoText = await readText(path.join(ROOT, PROTOCOL_FILE));
  if (protoText === null) {
    return {
      status: 'FAIL',
      detail: `${PROTOCOL_FILE} is missing — it declares PAIR_HTTPS_HOST, the host both OS declarations are checked against`,
    };
  }
  const protoHit = PROTO_RE.exec(protoText);
  if (!protoHit) {
    return {
      status: 'FAIL',
      detail:
        `PAIR_HTTPS_HOST is no longer a plain string literal in ${PROTOCOL_FILE}. ` +
        'Renamed, moved, or computed — this lint would now compare both OS declarations against nothing. ' +
        'Update verify/lint/applink-declarations.mjs.',
    };
  }
  const protoPathHit = PROTO_PATH_RE.exec(protoText);
  if (!protoPathHit) {
    return {
      status: 'FAIL',
      detail:
        `PAIR_HTTPS_PATH is not a plain string literal in ${PROTOCOL_FILE}. ` +
        'Renamed, moved, or computed — this lint would now compare the Android path against nothing. ' +
        'Update verify/lint/applink-declarations.mjs.',
    };
  }
  const host = protoHit[1];
  const PAIR_PATH = protoPathHit[1];
  const url = `https://${host}${PAIR_PATH}`;

  const failures = [];

  // ── 1. Android ─────────────────────────────────────────────────────────────
  const manifestSrc = await readText(path.join(ROOT, ANDROID_MANIFEST));
  let androidLine = null;
  if (manifestSrc === null) {
    failures.push(`${ANDROID_MANIFEST} is missing — it is the only place Android is told this app owns ${url}`);
  } else {
    const code = stripXmlComments(manifestSrc);
    const filters = intentFilters(code);
    if (filters.length === 0) {
      // Control assertion. This manifest has a LAUNCHER filter and a
      // `flowmic://login` filter, so zero means the scanner went blind on a
      // manifest it could not parse — never the same verdict as "clean".
      failures.push(
        `${ANDROID_MANIFEST} parsed to 0 <intent-filter> elements — this manifest has a LAUNCHER filter ` +
          `and a flowmic://login filter, so the scanner is blind, not the manifest empty`
      );
    } else {
      const match = filters.find((f) =>
        dataElements(f.text).some((d) => d.scheme === 'https' && d.host === host && d.path === PAIR_PATH)
      );
      if (!match) {
        failures.push(
          `${ANDROID_MANIFEST} declares no verified app link for ${url} — the phone parses that prefix ` +
            `(apps/mobile/lib/src/ui/scan_payload.dart) but Android has never been told this app owns the URL, ` +
            `so the system camera hands the pairing QR to a browser on a phone that HAS FlowMic. Needs one ` +
            `<intent-filter android:autoVerify="true"> with VIEW + DEFAULT + BROWSABLE and ` +
            `<data android:scheme="https" android:host="${host}" android:path="${PAIR_PATH}"/>`
        );
      } else {
        androidLine = match.line;
        if (!/<intent-filter\b[^>]*android:autoVerify\s*=\s*"true"/.test(match.text)) {
          failures.push(
            `${ANDROID_MANIFEST}:${match.line} has an intent-filter for ${url} but it is missing ` +
              `android:autoVerify="true" — without it Android never fetches /.well-known/assetlinks.json, ` +
              `so the link is never verified and the user gets a chooser (or the browser) instead of the app`
          );
        }
        for (const [needle, why] of [
          ['android.intent.action.VIEW', 'a filter with no VIEW action answers no URL at all'],
          ['android.intent.category.DEFAULT', 'without DEFAULT the OS will not route an implicit VIEW here'],
          [
            'android.intent.category.BROWSABLE',
            'without BROWSABLE a link initiated by a web page or the camera cannot reach us at all',
          ],
        ]) {
          if (!match.text.includes(needle)) {
            failures.push(`${ANDROID_MANIFEST}:${match.line} the ${url} filter is missing ${needle} — ${why}`);
          }
        }
      }
    }
  }

  // ── 2. iOS: the entitlement itself ─────────────────────────────────────────
  const entSrc = await readText(path.join(ROOT, IOS_ENTITLEMENTS));
  if (entSrc === null) {
    failures.push(
      `${IOS_ENTITLEMENTS} is missing — it is the only place iOS is told this app owns ${host} ` +
        `(key com.apple.developer.associated-domains, entry applinks:${host})`
    );
  } else {
    const ent = stripXmlComments(entSrc);
    if (!ent.includes('com.apple.developer.associated-domains')) {
      failures.push(
        `${IOS_ENTITLEMENTS} does not declare com.apple.developer.associated-domains — that key is what ` +
          `carries the applinks entry; an entitlements file without it grants nothing`
      );
    }
    if (!new RegExp(`<string>\\s*applinks:${host.replace(/\./g, '\\.')}\\s*</string>`).test(ent)) {
      failures.push(
        `${IOS_ENTITLEMENTS} does not list <string>applinks:${host}</string> — the host it declares must be ` +
          `the one the desktop prints (${PROTOCOL_FILE} PAIR_HTTPS_HOST)`
      );
    }
  }

  // ── 3. iOS: and a build that actually applies it ───────────────────────────
  const pbx = await readText(path.join(ROOT, IOS_PBXPROJ));
  let wiredConfigs = [];
  if (pbx === null) {
    failures.push(`${IOS_PBXPROJ} is missing — cannot confirm any build signs with ${IOS_ENTITLEMENTS}`);
  } else {
    const parsed = runnerConfigs(pbx);
    if (parsed.error) {
      failures.push(
        `${IOS_PBXPROJ}: ${parsed.error} — this lint cannot confirm the entitlements file is applied, and an ` +
          `unreadable project is not a clean one. Update verify/lint/applink-declarations.mjs.`
      );
    } else {
      const want = /CODE_SIGN_ENTITLEMENTS = Runner\/Runner\.entitlements;/;
      const missing = parsed.configs.filter((c) => !want.test(c.text));
      wiredConfigs = parsed.configs.filter((c) => want.test(c.text)).map((c) => c.name);
      if (missing.length > 0) {
        failures.push(
          `${IOS_PBXPROJ}: the Runner target's ${missing.map((c) => c.name).join(', ')} configuration(s) do not ` +
            `set CODE_SIGN_ENTITLEMENTS = Runner/Runner.entitlements — the entitlements file exists and nothing ` +
            `signs with it, so the capability is absent from every build while the repo looks correct`
        );
      }
    }
  }

  if (failures.length > 0) {
    return { status: 'FAIL', detail: failures.join(' | ') };
  }
  return {
    status: 'PASS',
    detail:
      `${url} (host from ${PROTOCOL_FILE} PAIR_HTTPS_HOST) is declared to both systems: ` +
      `${ANDROID_MANIFEST}:${androidLine} autoVerify intent-filter with VIEW+DEFAULT+BROWSABLE; ` +
      `${IOS_ENTITLEMENTS} applinks:${host}, applied by CODE_SIGN_ENTITLEMENTS in ${wiredConfigs.length} ` +
      `Runner configuration(s) (${wiredConfigs.join(', ')}). ` +
      `INERT until ${host} publishes /.well-known/assetlinks.json and apple-app-site-association — not checked here`,
  };
}
