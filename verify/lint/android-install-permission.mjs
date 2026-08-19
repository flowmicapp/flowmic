// verify/lint/android-install-permission.mjs
// ST-1 — REQUEST_INSTALL_PACKAGES lives in the DIRECT flavour and nowhere else.
//
// ── WHAT THIS DEFENDS AGAINST ────────────────────────────────────────────────
// Google Play's Device and Network Abuse policy forbids a store-delivered app
// from downloading and installing an APK to update itself. Our self-update
// needs `android.permission.REQUEST_INSTALL_PACKAGES`, and a manifest line is
// not behind any build define — apps/mobile/lib/src/update/self_update_flag.dart
// measured exactly that: the dart-define tree-shakes the Dart half and cannot
// reach a static manifest entry. Card ST-1 therefore moved the permission out
// of the shared `src/main/` manifest and into `src/direct/`, so the store
// artifact cannot carry it — not because someone remembered to strip it, but
// because it was never merged in.
//
// ── WHY A SOURCE LINT, WHEN A GATE ALREADY EXISTS ────────────────────────────
// The gate that exists reads a BUILT ARTIFACT: scripts/store-channel-gate.mjs
// unpacks the `.aab` and refuses it if the permission is present. That check is
// correct and stays. What it cannot do is answer the question earlier than a
// full store build — which nobody runs while editing a manifest. So a
// regression (someone "tidying" the permission back into `src/main/`, where it
// merges into EVERY flavour) is invisible locally, invisible in CI, invisible in
// review, and surfaces at Play review. This lint moves that refusal to commit
// time. It changes no rule and weakens nothing; it only makes the answer
// arrive days earlier — the same shape as verify/lint/oss-absent-sweep.mjs
// moving the export's sweep off release day.
//
// ── WHY IT IS TWO ASSERTIONS AND NOT ONE ─────────────────────────────────────
// "The permission is not in the store flavour" and "the permission is still in
// the direct flavour" are DIFFERENT FACTS with different failure modes, and a
// scanner that only asked the first would report a clean sheet on the day the
// permission vanished entirely — i.e. on the day self-update died in the
// artifact we ship ourselves, which is the defect 0.2.59 already shipped once
// (UP-7, scripts/apk-self-update-marker.mjs). Absence is not cleanliness. So
// the direct declaration is REQUIRED here, and its disappearance fails with its
// own wording, never counted as a pass.
//
// ── WHAT IT CANNOT SEE (stated, not implied) ─────────────────────────────────
// Only OUR source tree is scanned. Flutter plugins and AAR dependencies
// contribute their own <uses-permission> entries, and those appear solely in
// the MERGED manifest, a gitignored build artifact. If a dependency ever
// declared REQUEST_INSTALL_PACKAGES this lint would still say clean, and the
// only honest judge for that half is the artifact gate above, on a real store
// build. Do not widen this comment into a claim the scanner cannot back.
//
// ── REVERSE CONTROL ──────────────────────────────────────────────────────────
// Three drills, all run 2026-08-19, all readings verbatim (wrapped here only to
// fit the column). Each edit was restored by hand and `git diff` on the touched
// file was empty afterwards.
//
// A — THE REGRESSION THIS EXISTS TO CATCH. The declaration line was copied from
// the direct manifest into apps/mobile/android/app/src/main/AndroidManifest.xml,
// which merges into every flavour, store included:
//
//   FAIL android.permission.REQUEST_INSTALL_PACKAGES is declared at
//   apps/mobile/android/app/src/main/AndroidManifest.xml:59 — only the direct
//   flavour (apps/mobile/android/app/src/direct/AndroidManifest.xml) may carry
//   it. `src/main/` merges into EVERY flavour, so a declaration there puts a
//   restricted permission into the store artifact; Google Play's Device and
//   Network Abuse policy forbids a store-delivered app from installing an APK
//   to update itself, and the declaration is reviewed whether or not any code
//   uses it (ST-1). Put it in
//   apps/mobile/android/app/src/direct/AndroidManifest.xml or nowhere
//
// B — THE OPPOSITE DEFECT, WHICH MUST NOT READ AS CLEAN. The declaration was
// deleted from the direct manifest instead:
//
//   FAIL android.permission.REQUEST_INSTALL_PACKAGES is declared NOWHERE —
//   apps/mobile/android/app/src/direct/AndroidManifest.xml must declare it or
//   self-update is dead in the channel we ship ourselves (the 0.2.59 defect,
//   UP-7). This is NOT a clean tree: the store rule is satisfied by an app that
//   can no longer update itself at all
//
// B is the drill that matters most, because it is the one a "did the forbidden
// string disappear?" scanner would have passed.
//
// C — THE NON-MANIFEST ARM, so it is not dead code. A line
// `flowmic.reverseControl=android.permission.REQUEST_INSTALL_PACKAGES` was
// appended to apps/mobile/android/gradle.properties (the shape a Gradle
// placeholder injection would take):
//
//   FAIL android.permission.REQUEST_INSTALL_PACKAGES appears outside a comment
//   at apps/mobile/android/gradle.properties:3 — only the direct flavour […]
//
// The green reading all three drills return to:
//
//   PASS android.permission.REQUEST_INSTALL_PACKAGES declared at
//   apps/mobile/android/app/src/direct/AndroidManifest.xml:38 (direct flavour,
//   wired by create("direct") in apps/mobile/android/app/build.gradle.kts) and
//   nowhere else; 5 manifest(s) + 25 other file(s) scanned under
//   apps/mobile/android, 4 prose mention(s) in comments (allowed)

import path from 'node:path';
import { ROOT, DEFAULT_SKIP_DIRS, readText, rel, walk } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/android-install-permission.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'android-install-permission';

const PERMISSION = 'android.permission.REQUEST_INSTALL_PACKAGES';
const BARE_TOKEN = 'REQUEST_INSTALL_PACKAGES';

const ANDROID_DIR = path.join(ROOT, 'apps', 'mobile', 'android');
const DIRECT_MANIFEST = path.join(ANDROID_DIR, 'app', 'src', 'direct', 'AndroidManifest.xml');
const APP_GRADLE = path.join(ANDROID_DIR, 'app', 'build.gradle.kts');

// Gradle caches and build output. `build`, `.git` and friends are already in
// DEFAULT_SKIP_DIRS; these three are Android-specific and are pure artifacts.
const EXTRA_SKIP = new Set(['.gradle', '.kotlin', '.cxx']);
const skipDir = (base) => DEFAULT_SKIP_DIRS.has(base) || EXTRA_SKIP.has(base);

/**
 * Blank out XML comments, keeping newlines so line numbers stay true.
 *
 * Exact rather than heuristic: XML comments cannot nest and `--` is illegal
 * inside one, so `<!--` … `-->` is unambiguous. This matters because all three
 * of our manifests DISCUSS this permission in prose — src/main's comment says
 * where it went, src/store's says why the file is empty — and that prose is the
 * most valuable thing in those files. A scanner that could not tell an
 * explanation from a declaration would force us to delete the explanations.
 *
 * (Written locally rather than shared with verify/lint/android-provider-classes.mjs,
 * which carries the same three lines for the same reason: verify/lint/_util.mjs
 * is the place a shared helper would go, and it is not this card's file to
 * change. If a third scanner needs it, move it there and delete both copies.)
 */
function stripXmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Blank out `//` and block comments LINE BY LINE, for Kotlin/Gradle sources.
 *
 * Deliberately cruder than verify/lint/_util.mjs's stripJsComments, and the
 * reason is measurable: that function lexes string literals, and Kotlin's
 * triple-quoted raw strings are not JavaScript — apps/mobile/android/app/build.gradle.kts
 * contains one (`Regex("""…""")`), which would put that lexer into the wrong
 * state for the rest of the file. A wrong-state lexer does not fail loudly; it
 * silently stops seeing things, which is the failure this whole file exists to
 * prevent. Line-based comment tracking cannot be thrown off by a string.
 *
 * What it costs: a comment that starts mid-line after code (`foo() // note`)
 * blanks only from the `//`, which is right; and a permission name that appears
 * inside a string literal is treated as CODE, which is also right — a gradle
 * `manifestPlaceholders` entry is exactly that shape.
 *
 * ⚠️ Where it is imprecise, it is imprecise in one direction only: a `//`
 * inside a string (a URL) truncates the rest of that line, so the scanner sees
 * LESS than the file says. That can hide a declaration, never invent one, and
 * the direct-manifest assertion below is what makes a scanner that has gone
 * blind fail rather than pass. `#` is honoured only at the start of a trimmed
 * line, because it is a comment in .properties and in gradlew but NOT in
 * Kotlin — treating it as one everywhere would blind the scanner mid-line in
 * exactly the sources that matter most.
 */
function stripSourceComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) {
        out.push('');
        continue;
      }
      inBlock = false;
      out.push(scanLine(line.slice(end + 2)));
      continue;
    }
    out.push(scanLine(line));
  }
  function scanLine(text) {
    const lineComment = text.indexOf('//');
    const blockStart = text.indexOf('/*');
    const hash = /^\s*#/.test(text) ? text.indexOf('#') : -1;
    const cuts = [lineComment, blockStart, hash].filter((i) => i !== -1);
    if (cuts.length === 0) return text;
    const first = Math.min(...cuts);
    if (first === blockStart && (lineComment === -1 || blockStart < lineComment) && (hash === -1 || blockStart < hash)) {
      const end = text.indexOf('*/', blockStart + 2);
      if (end === -1) {
        inBlock = true;
        return text.slice(0, blockStart);
      }
      return text.slice(0, blockStart) + scanLine(text.slice(end + 2));
    }
    return text.slice(0, first);
  }
  return out.join('\n');
}

/** 1-based line numbers of every occurrence of `needle` in `text`. */
function linesOf(text, needle) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes(needle)) hits.push(i + 1);
  });
  return hits;
}

/**
 * Every <uses-permission> element whose android:name ends in the bare token,
 * with the 1-based line each sits on.
 *
 * 🔴 ELEMENT-AWARE, NOT A STRING SEARCH, and the difference is the whole
 * question this lint answers. The bare token appears as PROSE in four places in
 * this tree (src/main's "USED TO BE HERE" note, src/store's "the emptiness is
 * the feature" note, src/direct's own header, and app/build.gradle.kts's ST-1
 * paragraph). Those paragraphs are the record of why the split exists; a
 * scanner that counted them as declarations would be a scanner someone silences
 * by deleting the explanations.
 *
 * Matched on the SUFFIX rather than the fully-qualified constant so that a
 * declaration written any other legal way (a different prefix, a
 * manifestPlaceholder resolving to the same permission) is still seen. The
 * fully-qualified form is what we ship today; pinning only that would make this
 * gate answer a narrower question than its own name.
 */
function usesPermissionTags(code) {
  const found = [];
  const re = /<uses-permission\b[\s\S]*?(?:\/>|>)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const nameAttr = /android:name\s*=\s*"([^"]*)"/.exec(m[0]);
    const value = nameAttr ? nameAttr[1] : '';
    if (!value.endsWith(BARE_TOKEN)) continue;
    found.push({ value, line: code.slice(0, m.index).split('\n').length });
  }
  return found;
}

export default async function run() {
  const files = await walk(ANDROID_DIR, { skipDir });
  if (files.length === 0) {
    return {
      status: 'FAIL',
      detail:
        `found 0 files under ${rel(ANDROID_DIR)} — the scan is blind, which is not the ` +
        `same as clean (the Android host project is checked in; it cannot be empty)`,
    };
  }

  const manifests = files.filter((f) => path.basename(f) === 'AndroidManifest.xml');

  // Control assertion. Zero manifests means the filter stopped matching, not
  // that the tree became safe — and those two states must never share a verdict
  // (the marker-scanner lesson, UP-7 / scripts/apk-self-update-marker.mjs).
  if (manifests.length === 0) {
    return {
      status: 'FAIL',
      detail:
        `found 0 AndroidManifest.xml under ${rel(ANDROID_DIR)} — this app has one per ` +
        `source set (main + debug + profile + direct + store), so the scanner is blind, ` +
        `not the manifest clean`,
    };
  }

  const failures = [];
  let directDecl = null;
  let prose = 0;
  let scannedOther = 0;

  const wrongPlace = (where, why) =>
    failures.push(
      `${PERMISSION} ${why} at ${where} — only the direct flavour ` +
        `(${rel(DIRECT_MANIFEST)}) may carry it. \`src/main/\` merges into EVERY flavour, ` +
        `so a declaration there puts a restricted permission into the store artifact; ` +
        `Google Play's Device and Network Abuse policy forbids a store-delivered app from ` +
        `installing an APK to update itself, and the declaration is reviewed whether or not ` +
        `any code uses it (ST-1). Put it in ${rel(DIRECT_MANIFEST)} or nowhere`
    );

  for (const file of files) {
    const src = await readText(file);
    if (src == null) continue; // binary (launcher PNGs) — nothing to read
    const isManifest = path.basename(file) === 'AndroidManifest.xml';
    const isXml = path.extname(file).toLowerCase() === '.xml';
    if (!isManifest) scannedOther += 1;
    const code = isXml ? stripXmlComments(src) : stripSourceComments(src);
    // Everything the file says minus everything its CODE says == its prose.
    // Counted rather than discarded, because it is the witness that the two
    // strippers above actually ran:
    //   · a stripper that stripped NOTHING drives this to 0 and turns all four
    //     prose mentions into declarations — red, loudly;
    //   · a stripper that blanked EVERYTHING drives it to the raw count and, on
    //     the XML side, takes the direct declaration with it — red via the
    //     "declared NOWHERE" branch below.
    // The one case this number reports rather than fails on is a source-side
    // over-strip, which can only hide a hit. 4 is the value measured today, so
    // a change in it is a change worth reading.
    prose += linesOf(src, BARE_TOKEN).length - linesOf(code, BARE_TOKEN).length;

    if (isManifest) {
      for (const tag of usesPermissionTags(code)) {
        if (file === DIRECT_MANIFEST) {
          directDecl = directDecl ?? { line: tag.line, value: tag.value };
          continue;
        }
        wrongPlace(`${rel(file)}:${tag.line}`, `is declared`);
      }
      continue;
    }

    // Non-manifest sources. A <uses-permission> element is not the only way to
    // introduce the permission — a Gradle manifestPlaceholder resolves into one
    // — so outside the manifests any NON-COMMENT occurrence of the token is a
    // failure on its own. This arm is currently what makes app/build.gradle.kts
    // legal: it names the permission four lines into an explanation, and prose
    // is not a declaration.
    for (const line of linesOf(code, BARE_TOKEN)) {
      wrongPlace(`${rel(file)}:${line}`, `appears outside a comment`);
    }
  }

  // The other direction. Absence is a DIFFERENT defect and gets different words.
  if (directDecl === null) {
    failures.push(
      `${PERMISSION} is declared NOWHERE — ${rel(DIRECT_MANIFEST)} must declare it or ` +
        `self-update is dead in the channel we ship ourselves (the 0.2.59 defect, UP-7). ` +
        `This is NOT a clean tree: the store rule is satisfied by an app that can no ` +
        `longer update itself at all`
    );
  }

  // And the wiring that makes `src/direct/` mean anything. Without a `direct`
  // product flavour, that manifest is a file nothing merges — the permission
  // would be present in the repo and absent from every artifact, which reads
  // identically to "clean" unless something asks.
  const gradle = await readText(APP_GRADLE);
  if (gradle == null) {
    failures.push(`cannot read ${rel(APP_GRADLE)} — cannot confirm the direct flavour is wired`);
  } else if (!/create\(\s*"direct"\s*\)/.test(stripSourceComments(gradle))) {
    failures.push(
      `${rel(APP_GRADLE)} declares no \`create("direct")\` product flavour, so nothing ` +
        `merges ${rel(DIRECT_MANIFEST)} — the permission would be in the tree and in no ` +
        `artifact, which looks exactly like a clean result`
    );
  }

  if (failures.length > 0) {
    return { status: 'FAIL', detail: failures.join(' | ') };
  }
  return {
    status: 'PASS',
    detail:
      `${directDecl.value} declared at ${rel(DIRECT_MANIFEST)}:${directDecl.line} ` +
      `(direct flavour, wired by create("direct") in ${rel(APP_GRADLE)}) and nowhere else; ` +
      `${manifests.length} manifest(s) + ${scannedOther} other file(s) scanned under ` +
      `${rel(ANDROID_DIR)}, ${prose} prose mention(s) in comments (allowed)`,
  };
}
