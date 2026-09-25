// verify/lint/spoken-langs-mirror.mjs
// FINAL-1 — the eight spoken languages and their names exist twice: in Dart
// here, and hand-copied into TypeScript in the web client's own repository.
// They must stay the same eight, in the same order, with the same names.
//
// ── WHAT THE PROBLEM ACTUALLY IS ───────────────────────────────────────────
// `audio:start.source_lang` is a required NonEmpty field and its legal values
// are `kSpokenLangs` in `apps/mobile/lib/src/settings/app_settings.dart`. The
// browser client offers the same picker and cannot import Dart, so it re-types
// both halves in `apps/mic/src/session/spokenLangs.ts` (older checkouts), or
// `packages/core/src/account/spokenLangs.ts` reached by that mic module's
// @flowmic/web-core re-export through core's index and island/index barrels:
//   · `SPOKEN_LANG_TAGS`     mirrors `kSpokenLangs`;
//   · `SPOKEN_LANG_ENDONYMS` mirrors the `endonym` field of the `AppLocale`
//     members those tags name.
// This lint compares the literals and verifies that re-export chain when used.
//
// The failure it catches has two shapes and they are not equally loud:
//   · A TAG drifts — the browser offers a language the routing table has no
//     row for (or stops offering one the phone has), and the visitor who picks
//     it gets a refusal for a language that is on the screen in front of them.
//   · An ENDONYM drifts — nothing breaks, and one language is called two
//     different things on two surfaces of the same product, in the script of
//     somebody who cannot read the surrounding page and is hunting for exactly
//     that word. Silent, and the reason endonyms are compared here at all.
//
// ── 🔴 WHAT THIS LINT DOES *NOT* PROVE ─────────────────────────────────────
// It compares two literal tables. It cannot see:
//   · a third copy elsewhere in either repo that re-types the same eight tags
//     under another name;
//   · whether the web client's picker actually RENDERS from these constants
//     rather than from something it derived once and cached;
//   · anything at all about the ninth interface language, `zh-TW`, which is
//     deliberately absent from both sides — that absence is a ruling, not a
//     drift, and comparing lists cannot tell the two apart.
//
// ── 🔴 A MISSING SIBLING IS A SKIP, NEVER A PASS ───────────────────────────
// The web client is a separate repository checked out beside this one. A
// machine that does not have it cannot verify anything here, and reporting
// PASS there would be this suite calling an unattempted check done — the same
// thing the product's own status red line forbids. run-all.mjs keeps SKIP in
// its own bucket for exactly this. The SKIP names the two constants that went
// unchecked, so the line cannot be read as "the mirror is fine".
//
// ── SHAPE ──────────────────────────────────────────────────────────────────
// Same contract as admin-limit-mirror / password-policy-mirror: named
// files, regex-extract plain literals, FAIL if a literal is missing (a rename
// would otherwise compare against nothing and go green covering zero), FAIL if
// the two sides disagree, and say in the failure text what to do about it.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, readText, lineOf } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'spoken-langs-mirror';
const ts = createRequire(path.join(ROOT, 'packages/protocol/package.json'))('typescript');

// 🔴 `flowmic-web` IS THE BROWSER CLIENT, AND IT IS NOT THE MARKETING SITE.
// Those are two different sibling repositories whose directory names differ by
// one word, and the existing lints already point at the other one:
// password-policy-mirror and plan-limit-copy both resolve the `@flowmic/web`
// package and read `FLOWMIC_WEB_REPO`. This lint's override is therefore
// `FLOWMIC_WEB_CLIENT_REPO` — measured, not guessed: the first draft of this
// file called its override `FLOWMIC_WEB_REPO`, and setting it moved THREE
// unrelated checks off the site (password-policy-mirror and plan-limit-copy
// dropped to SKIP, i18n-generated-fresh went red on the locale snapshot). One
// variable answering two questions, caught by the other gates in the same run.
const DART_FILE = 'apps/mobile/lib/src/settings/app_settings.dart';
const WEB_REPO = 'flowmic-web';
const WEB_FILE = 'apps/mic/src/session/spokenLangs.ts';
const CORE_FILE = 'packages/core/src/account/spokenLangs.ts';

// Parse actual exports, so commented-out barrels and type-only exports do not
// make a disconnected literal table look reachable from the mic module.
function forwards(text, moduleName, names, star = false) {
  const source = ts.createSourceFile('mirror.ts', text, ts.ScriptTarget.Latest, true);
  const found = new Set();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly ||
        !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== moduleName) continue;
    if (star && !statement.exportClause) return true;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) {
        if (!item.isTypeOnly && (!item.propertyName || item.propertyName.text === item.name.text)) found.add(item.name.text);
      }
    }
  }
  return names.every((name) => found.has(name));
}

export async function resolveWebLiterals(repo, micText) {
  if (WEB_TAGS_RE.test(micText) && WEB_ENDONYMS_RE.test(micText)) return { text: micText, file: WEB_FILE };
  const names = ['SPOKEN_LANG_TAGS', 'SPOKEN_LANG_ENDONYMS'];
  if (!forwards(micText, '@flowmic/web-core', names)) {
    throw new Error(`${WEB_FILE}: neither literal tables nor both value re-exports from @flowmic/web-core`);
  }
  const root = await readText(path.join(repo, 'packages/core/src/index.ts'));
  if (!root || !forwards(root, './island/index.js', names, true)) {
    throw new Error('packages/core/src/index.ts: missing value exports through ./island/index.js');
  }
  const island = await readText(path.join(repo, 'packages/core/src/island/index.ts'));
  if (!island || !forwards(island, '../account/spokenLangs.js', names)) {
    throw new Error('packages/core/src/island/index.ts: missing spoken-language value re-exports');
  }
  const text = await readText(path.join(repo, CORE_FILE));
  if (text === null) throw new Error(`${CORE_FILE}: reachable literal source missing`);
  return { text, file: CORE_FILE };
}

/** `const List<String> kSpokenLangs = <String>['en', 'zh', …];` */
const DART_TAGS_RE =
  /^[ \t]*const[ \t]+List<String>[ \t]+kSpokenLangs[ \t]*=[ \t]*<String>\[([^\]]*)\][ \t]*;/m;
/** The `AppLocale` enum's member list, up to its own constructor. */
const DART_ENUM_RE = /\benum[ \t]+AppLocale[ \t]*\{([\s\S]*?)\n[ \t]*const[ \t]+AppLocale\(/;
/** One member: `en('English', LocaleScript.latn),` */
const DART_MEMBER_RE = /^[ \t]*([A-Za-z][A-Za-z0-9_]*)\('((?:[^'\\]|\\.)*)'[ \t]*,[ \t]*LocaleScript\./gm;

/** `export const SPOKEN_LANG_TAGS = ['en', …] as const;` */
const WEB_TAGS_RE = /^[ \t]*export[ \t]+const[ \t]+SPOKEN_LANG_TAGS[ \t]*=[ \t]*\[([^\]]*)\][ \t]*as[ \t]+const[ \t]*;/m;
/** `export const SPOKEN_LANG_ENDONYMS…= { en: 'English', … };` */
const WEB_ENDONYMS_RE = /^[ \t]*export[ \t]+const[ \t]+SPOKEN_LANG_ENDONYMS\b[^=]*=[ \t]*\{([\s\S]*?)\n[ \t]*\}[ \t]*;/m;
/** One entry: `en: 'English',` */
const WEB_ENTRY_RE = /^[ \t]*([A-Za-z][A-Za-z0-9_]*)[ \t]*:[ \t]*'((?:[^'\\]|\\.)*)'[ \t]*,?[ \t]*$/gm;

/** Quoted items out of a bracketed list body. Order is preserved because order
 *  is part of what is being compared — both sides call it the picker order. */
function quotedItems(body) {
  return [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
}

/** Where the sibling repository might be. Measured on 2026-08-29 by
 *  commit-hook-mirror and inherited here rather than rediscovered: run from a
 *  LINKED WORKTREE — which is how every agent lane works — `dirname(ROOT)` is
 *  `<repo>-worktrees/`, where no sibling repo lives, and this check would print
 *  a confident, false claim about the machine and skip. A linked worktree knows
 *  its main worktree through git, and the sibling is beside THAT. */
function searchRoots() {
  const roots = [path.dirname(ROOT)];
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (commonDir) {
      const mainParent = path.dirname(path.dirname(commonDir));
      if (mainParent && !roots.includes(mainParent)) roots.push(mainParent);
    }
  } catch {
    // Not a git checkout, or no git on PATH — this only ever ADDS a place to look.
  }
  // An explicit override exists so the drift can be REHEARSED against a
  // scratch copy without editing a checkout somebody else is working in. It is
  // a path, not a switch: it cannot turn a FAIL into a PASS, only point the
  // same comparison at a different tree, and the tree it read is printed.
  //
  // 🔴 IT REPLACES THE SEARCH, IT DOES NOT EXTEND IT. Falling back to the
  // discovered sibling when the override is wrong would answer about a
  // repository nobody asked about, print a PASS, and be indistinguishable from
  // having checked the one that was named. A wrong override must SKIP.
  const override = process.env.FLOWMIC_WEB_CLIENT_REPO;
  if (override) return [{ dir: path.resolve(override), viaEnv: true }];
  return roots.map((r) => ({ dir: path.join(r, WEB_REPO), viaEnv: false }));
}

export default async function run() {
  // ── The Dart side. It lives in THIS repo, so absence is a failure. ────────
  const dartText = await readText(path.join(ROOT, DART_FILE));
  if (dartText === null) {
    return {
      status: 'FAIL',
      detail: `${DART_FILE} is missing — it declares kSpokenLangs and AppLocale.endonym, the source both web copies are compared against`,
    };
  }

  const tagsHit = DART_TAGS_RE.exec(dartText);
  if (!tagsHit) {
    return {
      status: 'FAIL',
      detail:
        `kSpokenLangs is no longer declared as a plain <String> list literal in ${DART_FILE}. ` +
        'Renamed, moved, or computed — the web mirror would now be compared against nothing. ' +
        'Update verify/lint/spoken-langs-mirror.mjs.',
    };
  }
  const dartTags = quotedItems(tagsHit[1]);
  if (dartTags.length === 0) {
    return { status: 'FAIL', detail: `${DART_FILE} kSpokenLangs parsed as an empty list — the extractor no longer matches the source` };
  }

  const enumHit = DART_ENUM_RE.exec(dartText);
  if (!enumHit) {
    return {
      status: 'FAIL',
      detail:
        `the AppLocale enum is no longer readable in ${DART_FILE} — endonyms would be compared against nothing. ` +
        'Update verify/lint/spoken-langs-mirror.mjs.',
    };
  }
  const dartEndonyms = new Map();
  for (const m of enumHit[1].matchAll(DART_MEMBER_RE)) dartEndonyms.set(m[1], m[2]);
  const unnamed = dartTags.filter((t) => !dartEndonyms.has(t));
  if (unnamed.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `${DART_FILE}: kSpokenLangs names ${unnamed.join(', ')}, which AppLocale has no member for — ` +
        'the phone itself cannot label these, so there is nothing for the web client to mirror',
    };
  }

  // ── The web side. It lives in a sibling repo, so absence is a SKIP. ───────
  let webText = null;
  let webWhere = null;
  const tried = [];
  for (const candidate of searchRoots()) {
    const abs = path.join(candidate.dir, WEB_FILE);
    tried.push(abs);
    try {
      webText = await readFile(abs, 'utf8');
      webWhere = candidate;
      break;
    } catch {
      /* not here; try the next root */
    }
  }
  if (webText === null) {
    return {
      status: 'SKIP',
      detail:
        `the ${WEB_REPO} repository is not checked out on this machine, so SPOKEN_LANG_TAGS and ` +
        `SPOKEN_LANG_ENDONYMS in ${WEB_FILE} were NOT compared against ${DART_FILE}'s ` +
        `kSpokenLangs (${dartTags.length} tags) or AppLocale.endonym — nothing about that mirror was checked here. ` +
        `Looked in: ${tried.join(', ')}. Set FLOWMIC_WEB_CLIENT_REPO to point at the checkout.`,
    };
  }
  const shown = webWhere.viaEnv ? `${webWhere.dir} (FLOWMIC_WEB_CLIENT_REPO)` : webWhere.dir;
  let webFile;
  try {
    const resolved = await resolveWebLiterals(webWhere.dir, webText);
    webText = resolved.text;
    webFile = resolved.file;
  } catch (error) {
    return { status: 'FAIL', detail: `${shown}: ${error.message}` };
  }

  const webTagsHit = WEB_TAGS_RE.exec(webText);
  if (!webTagsHit) {
    return {
      status: 'FAIL',
      detail:
        `SPOKEN_LANG_TAGS is no longer declared as a plain array literal in ${shown}/${webFile}. ` +
        'Renamed, moved, or derived — this lint would now cover zero. ' +
        'Update verify/lint/spoken-langs-mirror.mjs.',
    };
  }
  const webTags = quotedItems(webTagsHit[1]);

  const webEndonymsHit = WEB_ENDONYMS_RE.exec(webText);
  if (!webEndonymsHit) {
    return {
      status: 'FAIL',
      detail:
        `SPOKEN_LANG_ENDONYMS is no longer declared as a plain object literal in ${shown}/${webFile}. ` +
        'Renamed, moved, or derived — endonyms would now be compared against nothing. ' +
        'Update verify/lint/spoken-langs-mirror.mjs.',
    };
  }
  const webEndonyms = new Map();
  for (const m of webEndonymsHit[1].matchAll(WEB_ENTRY_RE)) webEndonyms.set(m[1], m[2]);

  // ── Compare. Both sides are named in every failure, because the fix is
  //    always "make one of these two match the other" and which one depends on
  //    which side the ruling was made on. ────────────────────────────────────
  const problems = [];

  if (dartTags.join(',') !== webTags.join(',')) {
    const dartLine = lineOf(dartText, tagsHit.index);
    const webLine = lineOf(webText, webTagsHit.index);
    problems.push(
      `tags disagree: ${DART_FILE}:${dartLine} kSpokenLangs=[${dartTags.join(', ')}] but ` +
        `${shown}/${webFile}:${webLine} SPOKEN_LANG_TAGS=[${webTags.join(', ')}]`,
    );
  }

  for (const tag of dartTags) {
    const mine = dartEndonyms.get(tag);
    const theirs = webEndonyms.get(tag);
    if (theirs === undefined) {
      problems.push(`SPOKEN_LANG_ENDONYMS has no name for '${tag}', which kSpokenLangs offers`);
    } else if (theirs !== mine) {
      problems.push(
        `endonym for '${tag}' disagrees: ${DART_FILE} AppLocale.${tag}='${mine}' but ` +
          `${shown}/${webFile} SPOKEN_LANG_ENDONYMS.${tag}='${theirs}'`,
      );
    }
  }
  for (const tag of webEndonyms.keys()) {
    if (!dartTags.includes(tag)) {
      problems.push(`SPOKEN_LANG_ENDONYMS names '${tag}', which kSpokenLangs does not offer`);
    }
  }

  if (problems.length > 0) {
    return {
      status: 'FAIL',
      detail:
        problems.join(' | ') +
        ` — the phone and the web client disagree about the spoken-language picker. ` +
        `Decide which side the ruling was made on: a change to kSpokenLangs or AppLocale.endonym in ` +
        `${DART_FILE} must be hand-copied into ${webFile} in the ${WEB_REPO} repo (and its own ` +
        `pin test updated); a change invented in ${WEB_REPO} must be reverted there, because the ` +
        `phone's list is what audio:start.source_lang is validated against.`,
    };
  }

  return {
    status: 'PASS',
    detail:
      `${dartTags.length} spoken language(s) agree between ${DART_FILE} (kSpokenLangs + AppLocale.endonym) ` +
      `and ${shown}/${webFile} (SPOKEN_LANG_TAGS + SPOKEN_LANG_ENDONYMS; mic export path verified): ` +
      dartTags.map((t) => `${t}=${dartEndonyms.get(t)}`).join(', '),
  };
}
