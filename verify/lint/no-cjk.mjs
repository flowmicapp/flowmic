// verify/lint/no-cjk.mjs
// The mechanical guarantee behind "the public tree is fully English"
// (owner ruling 2026-08-14, docs/decisions/2026-08-14-owner-oss-batch2-translation-model-email-domain.md):
// the export surface must read as an English-authored codebase, not a
// translated one. ~29,000 lines of Chinese comments and test descriptions
// are being moved to English in batches; this gate is how "全英文" is
// enforced by a machine instead of by a reviewer's eyes — the same shape as
// no-lan-ip.mjs enforcing "no owner LAN address ships", or REQUIRE_ABSENT
// (scripts/opensource-manifest.mjs) enforcing "this string never reaches
// the public tree".
//
// ── WHAT IS SCANNED ──────────────────────────────────────────────────────────
// git-tracked files under apps/, packages/, verify/, scripts/, i18n/, plus
// root-level *.md — the export surface (docs/, scratch/, publish/, .local/
// are not part of what ships, so they are simply not in SCAN_PREFIXES; and
// `git ls-files` is the source of truth, so anything gitignored is already
// off the list — no separate skip-list needed, and no directory walk that
// could re-discover a build artifact by accident).
//
// ── DETECTION ────────────────────────────────────────────────────────────────
// Any codepoint in the four CJK ranges the card specified: Han ideographs
// (一-鿿), CJK Extension A (㐀-䶿), CJK punctuation
// (　-〿, catches 「」。，、 etc even where no ideograph appears on the
// same line), and fullwidth forms (＀-￯). Deliberately NOT Hangul
// (가-힣) or Kana outside the fullwidth block — Korean/Japanese text
// that uses neither Han characters nor fullwidth punctuation will not trip
// this gate, which is correct: the debt this gate tracks is CHINESE prose
// left over from this repo's own working language, not "any non-ASCII".
//
// ── ALLOWLISTS, AND WHAT THIS GATE ACTUALLY ASKS ─────────────────────────────
//
// 🔴 CORRECTED 2026-08-14, the day the translation landed. This header used to
// say the second array was "translation debt that MUST reach empty before the
// tree is pushed public". That was true while ~29,000 lines were still Chinese.
// It is now false, and leaving it would send the next reader to delete entries
// that are not debt.
//
// The sweep finished. What remains is ~1,100 files where Chinese is the SUBJECT
// rather than the prose, and the discipline requires every one of them to stay
// verbatim: quoted owner rulings (other files cite them by their Chinese
// wording), quoted product copy, STT corpora and layout fixtures (translating a
// corpus destroys the thing under test), and terminology kept beside its English
// gloss. "Does this file contain CJK" therefore stopped being a question with a
// useful answer.
//
// So the three lists now divide as:
//   PERMANENT    — Chinese that IS the product or is not ours to rewrite
//                  (locale catalogues, generated multilingual output, vendored
//                  third-party text). Never shrinks, and that is correct.
//   RESIDUAL_CJK — directory-level record of where allowed residual CJK lives.
//                  Not debt. Its STALE check still fires if an entry stops
//                  matching anything, so a directory that goes fully English
//                  cannot stay declared.
//   PROSE_ALLOW  — the only real exception list: files whose UNQUOTED Chinese
//                  prose was read one by one and judged evidence, corpus, or
//                  excluded-from-export. Anything else with unquoted prose FAILS.
//
// The load-bearing check is now proseRuns() (see the block above PROSE_ALLOW):
// a run of >=20 Chinese characters sitting outside every quote is an
// untranslated sentence, and it fails no matter which directory it is in.
// Reverse control, measured the day it was wired: injecting one such line into
// a translated file turned this gate red and named the file, the line, and the
// repair — it is not green-by-construction.

import { execFileSync } from 'node:child_process';
import { ROOT, readText, rel } from './_util.mjs';
import path from 'node:path';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/no-cjk.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'no-cjk';

/** Han + CJK Ext-A + CJK punctuation + fullwidth forms, per the card. */
export const CJK_RE = /[一-鿿㐀-䶿　-〿＀-￯]/u;
const CJK_RE_G = /[一-鿿㐀-䶿　-〿＀-￯]/gu;

/** Top-level roots that make up the export surface. Root *.md is handled
 *  separately below (a file, not a directory, test). */
const SCAN_PREFIXES = ['apps/', 'packages/', 'verify/', 'scripts/', 'i18n/'];

export function inScope(relPath) {
  if (SCAN_PREFIXES.some((p) => relPath.startsWith(p))) return true;
  // Root-level *.md only — not docs/*.md, not nested READMEs two levels down
  // in a package (those live under apps/ or packages/ and are already covered).
  if (!relPath.includes('/') && relPath.endsWith('.md')) return true;
  return false;
}

/** `entry` ending in '/' is a directory prefix (or the directory itself);
 *  otherwise it must match the path exactly. Same shape as no-lan-ip's file
 *  waivers, generalized to also take a directory so ~1,300 offending files
 *  do not need 1,300 individual lines. */
function underEntry(relPath, entry) {
  if (entry.endsWith('/')) return relPath === entry.slice(0, -1) || relPath.startsWith(entry);
  return relPath === entry;
}

/**
 * PERMANENT — Chinese here is product data, generated multilingual output,
 * or third-party text this repo has no right to edit. It is not debt and it
 * is not expected to ever reach zero.
 */
export const PERMANENT = [
  {
    path: 'i18n/',
    why: 'The locale data pipeline itself: per-language JSON catalogues '
      + '(i18n/desktop/*.json, i18n/mobile/*.json, i18n/desktop-rust/*.json), '
      + 'their leaves/coverage manifests, and TRANSLATION-BRIEF.md (a brief FOR '
      + 'translators that must quote the exact Chinese phrases — 「投递」/「注入」 '
      + 'etc — it is instructing them not to conflate). This is the raw material '
      + 'the whole i18n system compiles from; removing the Chinese here removes '
      + 'the zh-CN language, not a comment.',
  },
  {
    path: 'apps/desktop/src/lib/strings/generated/',
    why: 'GENERATED multilingual catalogue (catalogue.g.ts / locales.g.ts / '
      + 'msg.g.ts) compiled from i18n/desktop/*.json by scripts/i18n/gen-desktop-ts.mjs. '
      + 'The zh-CN arm of every user-facing string lives here on purpose — '
      + 'CATALOGUE.zh_CN is a real, shipped, product-required value.',
  },
  {
    path: 'apps/desktop/src-tauri/src/ui_i18n_table.g.rs',
    why: 'The Rust-side twin of the generated catalogue above (scripts/i18n/gen-desktop-rust.mjs), '
      + 'same reason: it carries the zh-CN arm of every string the Tauri shell renders.',
  },
  {
    path: 'apps/mobile/lib/src/settings/l10n/',
    why: 'GENERATED mobile catalogue (app_strings_locales.g.dart — one class per '
      + 'language, AppStringsZhCn included — and leaves.g.dart) compiled from '
      + 'i18n/mobile/*.json by scripts/i18n/gen-mobile-dart.mjs. Same shape as the '
      + 'desktop generated/ directory above; leaves.g.dart also carries one header '
      + 'line quoting an owner ruling in Chinese, kept for the same reason as the '
      + 'TRANSLATION-BRIEF quotes above.',
  },
  {
    path: 'apps/mobile/lib/generated/flowmic_settings.g.dart',
    why: 'GENERATED mirror of packages/protocol/src/dictionary-packs.ts (see below) — '
      + 'carries the same Chinese medical/legal/finance dictionary-pack preview '
      + 'strings the protocol package defines, generated by apps/mobile/tool/gen_protocol.mjs.',
  },
  {
    path: 'apps/mobile/ios/Runner/zh-Hans.lproj/',
    why: 'iOS localized Info.plist permission strings (NSMicrophoneUsageDescription '
      + 'etc) for the Simplified-Chinese locale — an Apple-mandated localization '
      + 'resource, the iOS equivalent of the i18n/ JSON catalogues above.',
  },
  {
    path: 'apps/mobile/ios/Runner/ja.lproj/',
    why: 'Same iOS localized-permission-strings mechanism, Japanese locale — Kanji '
      + 'falls inside the Han range this gate scans for, so it needs the same waiver '
      + 'as zh-Hans.lproj even though the language is not Chinese.',
  },
  {
    path: 'packages/protocol/src/locales.ts',
    why: 'THE ONE PLACE THE PRODUCT\'S UI LANGUAGES ARE LISTED (its own header '
      + 'comment says so). Carries the native endonym of every supported language '
      + '(中文 / 繁體中文 / 日本語 / …) as literal product data — these are what the '
      + 'language picker renders, not descriptions of them. The file also still '
      + 'carries some untranslated Chinese design-rationale comments (owner quotes) '
      + 'as part of the batch-translation backlog; it stays PERMANENT rather than '
      + 'PENDING because the endonym literals alone mean it can never reach zero CJK, '
      + 'and this gate has no line-level granularity to separate the two.',
  },
  {
    path: 'packages/protocol/src/dictionary-packs.ts',
    why: 'The curated STT hotword dictionary packs (F-3073): Chinese medical / legal / '
      + 'finance domain terms (心电图, 合同, 财报, …) plus Mandarin phonetic mis-hearing '
      + 'aliases for English tech terms (GitHub -> 吉特哈布). This is speech-recognition '
      + 'correction DATA for the Chinese language, not commentary about it — the '
      + 'feature has no purpose if the Chinese terms are removed.',
  },
  {
    path: 'verify/eval/cases/',
    why: 'Chinese eval corpora (merge.jsonl / organize.jsonl / realtime.jsonl / '
      + 'translate.jsonl) — recorded Chinese utterances the LLM-judge harness scores '
      + 'compose-mode output against. The product transcribes and composes Chinese '
      + 'speech; the eval fixtures have to be Chinese to test that.',
  },
  {
    path: 'scripts/vendor/funasr-MODEL_LICENSE.txt',
    why: 'Third-party vendor license text (Alibaba FunASR model license) — bilingual '
      + 'English/Chinese as shipped by the upstream project. Not our prose to '
      + 'translate or edit; a vendored license is preserved byte-for-byte or not at all.',
  },
  {
    path: 'CHANGELOG.md',
    why: 'Historical release notes. CLAUDE.md\'s own standing rule is that document '
      + 'history is never rewritten by a global pass (「文档面绝不做全局正则」) — '
      + 'past entries are a record of what shipped in Chinese at the time, not a '
      + 'live translation surface. Future entries can and should be written in English; '
      + 'this waiver does not exempt new content, only what already exists.',
  },
  {
    path: 'CLAUDE.md',
    why: 'The internal-only operating contract for this repo\'s AI sessions — and, '
      + 'critically, NOT part of the actual public export: scripts/opensource-manifest.mjs '
      + 'EXCLUDEs this exact path and REPLACEs it with CLAUDE.public.md (already '
      + '0 CJK hits) at the same destination in the exported tree. Scanning this file\'s '
      + 'thousands of lines of Chinese internal history for a gate about the PUBLIC '
      + 'surface would be measuring a file that never ships under this name; the '
      + 'manifest\'s own EXCLUDE/REPLACE pair is the authoritative statement that this '
      + 'path is not the export surface, and this waiver just agrees with it instead '
      + 'of re-deriving it.',
  },
];

/**
 * RESIDUAL_CJK — directory-level entries covering translation debt
 * that has not landed yet. THIS ARRAY MUST REACH EMPTY before the first
 * public push. Each entry is removed once every CJK-containing file under
 * it has been translated (checked automatically: an entry that stops
 * matching any offending file is STALE and fails the gate, forcing it to
 * be deleted rather than left as dead ballast — see the STALE check in run()).
 *
 * Kept at one entry per top-level package/app on purpose: the debt here is
 * ~1,300 files of ordinary Chinese code comments and test descriptions
 * (verified by running this scanner's own detector over the tree before
 * writing this list), not a handful of exceptional files — a directory-level
 * ratchet is the only shape that will not itself become 1,300 lines of noise.
 * Each entry's PERMANENT carve-outs (subpaths listed above) are checked
 * FIRST by run(), so a file inside e.g. apps/mobile/lib/src/settings/l10n/
 * never needs to appear here even though it is nested under apps/mobile/.
 */
export const RESIDUAL_CJK = [
  {
    path: 'apps/desktop/',
    why: 'Vue/TS frontend + Tauri/Rust shell source, tests, and build scripts. '
      + 'Chinese design-rationale comments and test descriptions throughout '
      + '(src/, src-tauri/src/ outside ui_i18n_table.g.rs, src-tauri/{examples,tests}, '
      + 'scripts/, Cargo.toml). No product-facing Chinese here — the shipped strings '
      + 'live in the generated/ carve-out above.',
  },
  {
    path: 'apps/mobile/',
    why: 'Flutter app source, tests, and native Android/iOS glue. Chinese '
      + 'design-rationale comments and test descriptions in lib/ (outside the l10n/ '
      + 'and generated/flowmic_settings.g.dart carve-outs), test/, and the Android '
      + 'Kotlin/Gradle/manifest files. The iOS lproj carve-outs above are the only '
      + 'product-facing Chinese under this tree.',
  },
  {
    path: 'apps/server-core/',
    why: 'Relay/server TypeScript source and tests. Chinese design-rationale '
      + 'comments and test descriptions only — no locale or generated content lives '
      + 'in this package, so no carve-out is needed.',
  },
  {
    path: 'packages/protocol/',
    why: 'Shared protocol package: schemas, events, error codes, and their tests, '
      + 'plus the Dart-generation script. Chinese design-rationale comments and test '
      + 'descriptions outside the two PERMANENT files carved out above '
      + '(locales.ts, dictionary-packs.ts).',
  },
  {
    path: 'packages/stt-cloud/',
    why: 'Cloud STT engine adapter (Soniox) source and tests. Chinese '
      + 'design-rationale comments and test descriptions only.',
  },
  {
    path: 'verify/',
    why: 'Lint/golden/eval-harness source (this file\'s own siblings). Chinese '
      + 'design-rationale comments and test-name strings throughout verify/lint/, '
      + 'verify/golden/, verify/hooks/, and verify/eval/ outside the eval/cases/ '
      + 'corpora carved out above.',
  },
  {
    path: 'scripts/',
    why: 'Build/publish/deploy/i18n-generator scripts. Chinese design-rationale '
      + 'comments throughout, outside the vendored FunASR license carved out above.',
  },
];

// ── The prose detector (2026-08-14, after the translation landed) ───────────
//
// 🔴 WHAT CHANGED AND WHY. Until the translation, this gate asked "does the file
// contain CJK at all", and every app directory sat in RESIDUAL_CJK — so
// the gate was green while ~29,000 lines were still Chinese. It proved nothing.
//
// After the sweep the raw question stopped being answerable: CJK legitimately
// survives in ~1,100 files as quoted owner rulings, quoted product copy, STT
// corpora, layout fixtures and terminology kept beside its English gloss. The
// discipline REQUIRES those to stay verbatim — other files cite them by their
// Chinese wording, and translating a corpus destroys the thing under test.
//
// So the question is now the one that actually matters: **is there Chinese PROSE
// nobody translated** — a run of Chinese long enough to be a sentence, sitting
// outside any quote. Measured over the whole export surface the day it landed:
// 26 files, 74 runs, and every one of them turned out to be either an excluded
// file or evidence (a transcript diff, a CLAUDE.md excerpt). Untranslated prose:
// zero. That is what PROSE_ALLOW pins, and anything new fails.
//
// ⚠️ Quote-stripping is deliberately generous (corner brackets AND ordinary
// quotes): a false negative here costs one untranslated sentence, while a false
// positive would push someone to "translate" an owner's words or a test corpus,
// which is the one outcome the discipline forbids.
const PROSE_RUN_RE = /[一-鿿㐀-䶿　-〿]{20,}/;

/** Chinese left AFTER removing quoted spans — i.e. prose, not citation. */
export function proseRuns(text) {
  const unquoted = text
    .replace(/[「『][^」』]*[」』]/g, '')
    .replace(/"[^"\n]*"/g, '')
    .replace(/'[^'\n]*'/g, '')
    .replace(/`[^`\n]*`/g, '');
  return unquoted.split('\n').filter((l) => PROSE_RUN_RE.test(l)).length;
}

/** Files whose unquoted Chinese runs were read one by one on 2026-08-14 and are
 *  NOT untranslated prose. Four kinds, and the kind is stated per entry because
 *  "why is this still Chinese" is the question a reader will have. Shrinking
 *  this list is always welcome; growing it needs the same file-by-file read. */
export const PROSE_ALLOW = [
  // (a) A gloss whose closing parenthesis falls on the next line, so the quote
  //     stripper cannot see that the Chinese is already quoted. Cosmetic.
  'apps/mobile/lib/src/session/chat_notices.dart',
  'apps/mobile/lib/src/timeline/timeline_entry.dart',
  'apps/desktop/src/lib/cached-cause-face.test.ts',
  'apps/desktop/src/lib/update-tag-parity.test.ts',
  // (b) Evidence: a real transcript with the dropped characters bracketed, and
  //     the user-visible sentences an error code produces. Translating either
  //     destroys the thing being demonstrated.
  'apps/server-core/test/stt-outage-loss.test.ts',
  'apps/mobile/test/image_verdict_affordance_test.dart',
  'apps/mobile/test/image_verdict_focus_lost_test.dart',
  // (c) Never reaches the public tree (EXCLUDEd by scripts/opensource-manifest.mjs),
  //     so its language is an internal matter.
  'packages/stt-cloud/src/engines/soniox.ts',
  'scripts/opensource-export.mjs',
  'scripts/opensource-export-selftest.mjs',
  'scripts/opensource-manifest.mjs',
  'scripts/opensource-manifest-strips.mjs',
  'scripts/publish-download-center.mjs',
  // (d) 🔴 PRODUCT COPY, NOT A COMMENT — and an open question, not a resolution:
  //     publish.mjs writes 使用说明.txt / README.txt INTO the shipped archives,
  //     in Chinese. The public repo would hand an international audience a
  //     Chinese read-me. That is a product decision (the app itself is
  //     multilingual), registered in the cutover plan rather than fixed by a
  //     translation batch, because changing it changes what users receive.
  'scripts/publish.mjs',
];

/** Scan one file's text; returns null if it has no CJK, else {count, firstLine}. */
export function scanText(text) {
  const lines = text.split('\n');
  let count = 0;
  let firstLine = -1;
  for (let n = 0; n < lines.length; n++) {
    const m = lines[n].match(CJK_RE_G);
    if (m) {
      count += m.length;
      if (firstLine === -1) firstLine = n + 1;
    }
  }
  return count === 0 ? null : { count, firstLine };
}

export default async function run() {
  // -z for the same reason the exporter uses it: git quotes non-ASCII paths by
  // default, and a quoted path matches none of the prefixes below — a
  // Chinese-named file would silently drop out of this gate's scope, which for
  // a gate about Chinese is the worst possible blind spot.
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .map((s) => s.trim())
    .filter(Boolean);

  const findings = [];
  const residualHit = new Set(); // which RESIDUAL_CJK entries matched >=1 offender
  let scanned = 0;
  let permanentHits = 0;
  let residualHits = 0;

  for (const relPath of tracked) {
    if (!inScope(relPath)) continue;
    const abs = path.join(ROOT, relPath);
    const text = await readText(abs); // handles binary-ext / NUL-probe / size cap
    if (text == null) continue;
    scanned++;

    const found = scanText(text);
    if (!found) continue; // clean file — nothing to allowlist

    const permEntry = PERMANENT.find((e) => underEntry(relPath, e.path));
    if (permEntry) {
      permanentHits++;
      continue;
    }

    const resEntry = RESIDUAL_CJK.find((e) => underEntry(relPath, e.path));
    if (resEntry) {
      residualHits++;
      residualHit.add(resEntry.path);
    }

    // The real question since 2026-08-14: Chinese PROSE outside every quote.
    // Quoted rulings, corpora and glossed terms are allowed to stay by design —
    // see the block above PROSE_ALLOW for why the raw-CJK question was retired.
    const runs = proseRuns(text);
    if (runs > 0 && !PROSE_ALLOW.includes(relPath)) {
      findings.push(
        `${relPath}:${found.firstLine}: ${runs} line(s) of unquoted Chinese prose `
          + `(>=20 chars with no quote around it) — translate it, or add it to PROSE_ALLOW `
          + `with the reason if it is evidence, corpus, or a file the public tree excludes`
      );
    }
  }

  // The ratchet: a RESIDUAL_CJK entry that no longer covers any offending file
  // means its batch finished — it must be deleted, not left declared. Same
  // direction as no-lan-ip's stale-waiver check.
  //
  // 🔴 "Nothing left to declare" and "nothing there to declare" are two different
  // answers, and conflating them broke this gate in the one tree that matters.
  // MEASURED 2026-08-14, on the first run of verify:delivery INSIDE an exported
  // tree: `packages/stt-cloud/` is a private package the export EXCLUDEs, so its
  // entry covered zero files there and the ratchet called it stale — telling a
  // public contributor to delete a declaration about a directory they cannot see,
  // on the first command CONTRIBUTING asks them to run. In this repo the same
  // entry is live and correct. So the ratchet now only judges directories that
  // EXIST in the tree being scanned: present-and-clean is a finished batch,
  // absent-entirely is a different tree, and only the first is stale.
  for (const entry of RESIDUAL_CJK) {
    if (residualHit.has(entry.path)) continue;
    const present = tracked.some((p) => inScope(p) && underEntry(p, entry.path));
    if (present) {
      findings.push(`${entry.path}: declared RESIDUAL_CJK but has 0 CJK hits — stale, delete this entry`);
    }
  }

  if (findings.length > 0) {
    return {
      status: 'FAIL',
      detail: `${findings.length} issue(s): ${findings.slice(0, 8).join('; ')}`,
    };
  }
  return {
    status: 'PASS',
    detail: `${scanned} file(s) scanned, ${permanentHits} permanent-allowlisted, `
      + `${residualHits} with allowed residual CJK, 0 unlisted`,
  };
}
