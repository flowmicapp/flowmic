#!/usr/bin/env node
// WP-8 (2026-09-02) — closes one of the three registry holes the audit named
// (docs/strategy/2026-09-02-full-implementation-audit-and-next-plan.md §5-4
// item 7): "服务端会发但 Dart 无句子也不红" ("the server can emit a code with no
// Dart sentence, and nothing goes red"). F1-b / F4 measured the consequence —
// `STT_ENGINE_AUTH_FAIL` / `STT_ENGINE_RATE_LIMITED` / `STT_ENGINE_TIMEOUT` /
// `STT_NETWORK_DROP` all already have bilingual copy in `error-codes.ts`, and
// the phone renders none of it, falling to `sttStallEngineErrorCoded` (a
// generic sentence plus the raw identifier).
//
// This script does NOT write any bespoke phone copy — that stays hand-owned
// (recording_strings.dart's per-code cases answer a PRODUCT question this
// codegen cannot: "does this fact deserve its own sentence, and what should it
// tell the user to do"). What it generates is the FALLBACK every code without
// bespoke copy can use instead of a raw identifier: a straight mirror of
// `error-codes.ts`'s own zh_CN/en pair, the same words the registry already
// carries and the same words `i18n-error-keys` already requires to be
// non-empty.
//
//   source of truth   ->  packages/protocol/src/error-codes.ts   (ERROR_CODES)
//   the Dart           ->  apps/mobile/lib/generated/protocol_error_sentences.g.dart
//
// Deliberately bilingual only (zh_CN + en), NOT all nine UI locales — the
// registry itself only ever carries two, and inventing seven more here would
// be putting words in the registry's mouth it never spoke. Every other locale
// falls back to English, the SAME declared-degradation shape
// `app_strings.dart`'s `_t()` already uses for its own twelve hand-written
// exceptions (see that file's header) — one fallback rule for the whole app,
// not two that could disagree.
//
// Usage:
//   node scripts/i18n/gen-protocol-error-sentences-dart.mjs            # write
//   node scripts/i18n/gen-protocol-error-sentences-dart.mjs --check    # verify, write nothing
//   node scripts/i18n/gen-protocol-error-sentences-dart.mjs --check --skip-missing
//        # ...but treat "not generated on this machine yet" as OK — the output
//        # is gitignored (`*.g.dart`, same policy as every other apps/mobile
//        # generated file), so on a clean checkout it legitimately does not
//        # exist until `make -C apps/mobile gen` runs.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseErrorCodes } from '../../verify/lint/i18n-error-keys.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SOURCE_REL = 'packages/protocol/src/error-codes.ts';
const OUT_REL = 'apps/mobile/lib/generated/protocol_error_sentences.g.dart';
const SELF_REL = 'scripts/i18n/gen-protocol-error-sentences-dart.mjs';

const SOURCE_ABS = join(ROOT, SOURCE_REL);
const OUT_ABS = join(ROOT, OUT_REL);

/** `parseErrorCodes`'s regex captures the QUOTED SOURCE TEXT verbatim,
 *  backslashes and all (it only needs "is this non-empty", never the decoded
 *  value) — so an entry written as `'…\'s…'` in error-codes.ts arrives here
 *  still carrying that literal `\'` two-character escape, not an apostrophe.
 *  Undo the JS escaping before re-encoding for Dart, or a source escape and a
 *  Dart escape stack (measured: COMPOSE_OUTPUT_REJECTED's `\'s` came out as
 *  `\\\'` — a broken triple-escape — before this existed). Only the escapes
 *  this file's prose actually uses are handled; anything else is unknown
 *  syntax in the SOURCE and is left alone rather than guessed at. */
function unescapeJsStringLiteral(raw) {
  return raw.replace(/\\(.)/g, (_, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    return ch; // \\ -> \ ; \' -> ' ; \" -> " ; anything else -> itself
  });
}

/** Dart single-quoted string literal, escaping the four characters that would
 *  otherwise break out of the quote or the source encoding. */
function dartLiteral(s) {
  const decoded = unescapeJsStringLiteral(s);
  return `'${decoded.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/\n/g, '\\n')}'`;
}

function loadEntries() {
  if (!existsSync(SOURCE_ABS)) return { entries: null, error: `source not found: ${SOURCE_REL}` };
  const src = readFileSync(SOURCE_ABS, 'utf8');
  const { entries, error } = parseErrorCodes(src);
  if (error) return { entries: null, error };
  if (entries.length === 0) return { entries: null, error: 'parsed 0 error codes (parser drift?)' };
  const bad = entries.filter((e) => !e.zh_CN || !e.en);
  if (bad.length > 0) {
    // i18n-error-keys already refuses a missing half at commit time; this is a
    // second, independent check rather than trusting that gate ran first.
    return { entries: null, error: `${bad.length} code(s) missing zh_CN or en: ${bad.map((e) => e.code).join(', ')}` };
  }
  return { entries, error: null };
}

function render(entries) {
  const sorted = [...entries].sort((a, b) => a.code.localeCompare(b.code));
  const rows = sorted
    .map((e) => `  ${dartLiteral(e.code)}: (zhCN: ${dartLiteral(e.zh_CN)}, en: ${dartLiteral(e.en)}),`)
    .join('\n');
  return `// GENERATED — DO NOT EDIT BY HAND.
// Source: ${SOURCE_REL} (ERROR_CODES)
// Regenerate: node ${SELF_REL} (wired into \`pnpm i18n:gen\` and \`make -C apps/mobile gen\`)
//
// The bilingual FALLBACK sentence for a wire error code that has no bespoke
// phone-side copy of its own — see this file's generator for why it is
// deliberately zh_CN/en only, never all nine UI locales.
//
// ignore_for_file: constant_identifier_names

/// \`code\` (an \`ErrorCode\` from packages/protocol/src/error-codes.ts) ->
/// its registered zh_CN/en pair. ${sorted.length} entries as of the last
/// \`pnpm i18n:gen\`.
const Map<String, ({String zhCN, String en})> kProtocolErrorSentences = {
${rows}
};

/// The fallback sentence for \`code\`, or null when the registry does not know
/// it (a phone-local code, or a typo — never guessed). \`preferZh\` picks the
/// zh_CN half; every other locale reads en, the same declared-degradation
/// shape \`app_strings.dart\`'s \`_t()\` already uses for its own exceptions.
String? protocolErrorSentence(String? code, {required bool preferZh}) {
  if (code == null || code.isEmpty) return null;
  final entry = kProtocolErrorSentences[code];
  if (entry == null) return null;
  return preferZh ? entry.zhCN : entry.en;
}
`;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const skipMissing = args.includes('--skip-missing');

  const { entries, error } = loadEntries();
  if (error) {
    if (skipMissing && error.startsWith('source not found')) {
      console.log(`gen-protocol-error-sentences-dart: ${error} — skipped (--skip-missing)`);
      return;
    }
    console.error(`gen-protocol-error-sentences-dart: ${error}`);
    process.exitCode = 1;
    return;
  }

  const rendered = render(entries);

  if (check) {
    if (!existsSync(OUT_ABS)) {
      if (skipMissing) {
        console.log(`gen-protocol-error-sentences-dart: ${OUT_REL} not generated yet — skipped (--skip-missing)`);
        return;
      }
      console.error(`gen-protocol-error-sentences-dart: ${OUT_REL} does not exist — run without --check first`);
      process.exitCode = 1;
      return;
    }
    const current = readFileSync(OUT_ABS, 'utf8');
    if (current !== rendered) {
      console.error(`gen-protocol-error-sentences-dart: ${OUT_REL} is stale — regenerate with \`pnpm i18n:gen\``);
      process.exitCode = 1;
      return;
    }
    console.log(`gen-protocol-error-sentences-dart: ${OUT_REL} matches ${SOURCE_REL} (${entries.length} codes)`);
    return;
  }

  mkdirSync(dirname(OUT_ABS), { recursive: true });
  writeFileSync(OUT_ABS, rendered, 'utf8');
  console.log(`gen-protocol-error-sentences-dart: wrote ${entries.length} code(s) -> ${OUT_REL}`);
}

await main();
