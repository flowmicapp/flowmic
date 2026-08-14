// verify/lint/android-provider-classes.mjs
// W8-5 — no two <provider> entries may share one android:name.
//
// ── WHAT THIS DEFENDS AGAINST, AND WHY NOTHING ELSE COULD SEE IT ─────────────
// Declaring two providers with distinct authorities but the SAME class builds,
// installs, and registers both authorities. `dumpsys package providers` lists
// both. Every unit test passes. And then, at runtime, `ActivityThread` caches
// provider instances BY CLASS NAME, so the second authority is served by the
// instance created for the first — whose `mAuthority` was already fixed in
// `attachInfo`. `ContentProvider.validateIncomingAuthority` throws:
//
//   SecurityException: The authority <app>.update.fileprovider does not match
//   the one of the contentProvider: <app>.clipboard.fileprovider
//
// Our own provider refusing our own URI. Shipped in 0.2.59 and 0.2.60; the
// symptom the user saw was "There was a problem parsing the package" from the system installer,
// which names neither providers nor authorities. Self-update was dead on both
// releases and every gate in the repo was green.
//
// 🔴 THE FAILURE IS INVISIBLE TO TESTS BY CONSTRUCTION. It lives in the
// framework's instance cache — reachable only from a real installed app on a
// real device. `flutter test` has no ActivityThread, and the manifest is data,
// not code, so no type checker reads it either. A structural gate is the only
// thing that can hold this line, so this file is deliberately mechanical: it
// counts classes, it does not evaluate behaviour.
//
// ── WHAT IT CANNOT SEE (stated, not implied) ─────────────────────────────────
// Only OUR manifest is scanned. Flutter plugins contribute their own <provider>
// entries and those appear solely in the MERGED manifest, a gitignored build
// artefact. So this gate proves our two providers do not collide with each
// other; it does NOT prove they avoid colliding with a plugin's class. That
// half has one honest judge — `adb shell dumpsys package <id>` on a real
// install, done for 0.2.61 (both plugin providers use their own subclasses).
// Do not widen this comment into a claim the scanner cannot back.

import path from 'node:path';
import { ROOT, readText, rel } from './_util.mjs';
// P0-PKG (2026-08-12): the Kotlin source directory follows the Android package,
// which follows the applicationId. Hard-coding it here is how this scanner would
// go BLIND — and a blind scanner reports 「clean」 unless something stops it. The
// directory therefore comes from the same SSOT the id does; the control
// assertion below (0 providers ⇒ FAIL) is what turns a wrong path into a red.
import { ANDROID_KOTLIN_DIR } from '../../scripts/package-ids.mjs';

export const name = 'android-provider-classes';

const MANIFEST = path.join(
  ROOT,
  'apps',
  'mobile',
  'android',
  'app',
  'src',
  'main',
  'AndroidManifest.xml'
);
const KOTLIN_DIR = path.join(ROOT, ...ANDROID_KOTLIN_DIR.split('/'));

// Strip XML comments so prose discussing a class name cannot be mistaken for a
// declaration. The whole reason this gate exists is a comment that argued the
// providers could not collide — that argument is worth keeping, so the scanner
// has to be able to tell it apart from an attribute.
function stripXmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

function attr(tag, key) {
  const m = tag.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

export default async function run() {
  const src = await readText(MANIFEST);
  if (src == null) {
    return {
      status: 'FAIL',
      detail: `cannot read ${rel(MANIFEST)} — the scan is blind, which is not the same as clean`,
    };
  }
  const code = stripXmlComments(src);
  const tags = code.match(/<provider\b[\s\S]*?(?:\/>|>)/g) ?? [];

  // Control assertion. Zero providers means the regex stopped matching this
  // manifest, not that the manifest became safe — and those two states must
  // never produce the same verdict (the marker-scanner lesson, UP-7).
  if (tags.length === 0) {
    return {
      status: 'FAIL',
      detail:
        `found 0 <provider> entries in ${rel(MANIFEST)} — this app declares at least ` +
        `two (clipboard + update), so the scanner is blind, not the manifest clean`,
    };
  }

  const failures = [];
  const byClass = new Map();
  const seen = [];

  for (const tag of tags) {
    const cls = attr(tag, 'android:name');
    const authority = attr(tag, 'android:authorities');
    if (!cls) {
      failures.push('a <provider> has no android:name');
      continue;
    }
    seen.push(`${cls} → ${authority ?? '(no authority)'}`);
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(authority ?? '(no authority)');
  }

  for (const [cls, authorities] of byClass) {
    if (authorities.length > 1) {
      failures.push(
        `${authorities.length} <provider> entries share android:name="${cls}" ` +
          `(authorities: ${authorities.join(', ')}) — ActivityThread caches provider ` +
          `instances by class, so all but the first authority will be served by an ` +
          `instance that rejects its own URIs (W8-5). Give each authority its own subclass`
      );
    }
  }

  // A relative android:name (".Foo") must resolve to a class we actually ship.
  // A typo here fails at install time on a device and nowhere earlier.
  for (const cls of byClass.keys()) {
    if (!cls.startsWith('.')) continue;
    const simple = cls.slice(1);
    let found = null;
    for (const file of ['FlowMicFileProviders.kt']) {
      const kt = await readText(path.join(KOTLIN_DIR, file));
      if (kt == null) continue;
      if (new RegExp(`class\\s+${simple}\\s*:\\s*FileProvider\\s*\\(`).test(kt)) {
        found = file;
        break;
      }
    }
    if (!found) {
      failures.push(
        `android:name="${cls}" names a class that no scanned Kotlin file declares as ` +
          `\`class ${simple} : FileProvider()\` — the manifest and the source have drifted`
      );
    }
  }

  if (failures.length > 0) {
    return { status: 'FAIL', detail: failures.join(' | ') };
  }
  return {
    status: 'PASS',
    detail: `${tags.length} <provider> entr(ies), ${byClass.size} distinct class(es): ${seen.join('; ')}`,
  };
}
