#!/usr/bin/env node
// Codegen for the DESKTOP RUST surface of the UI-locale architecture
// (docs/strategy/2026-08-14-locale-expansion-architecture.md §4.3).
//
// WHAT PROBLEM THIS SOLVES. Before it, adding one UI language to the Rust shell
// meant: a new `UiLocale` variant, a new length in `ALL: [UiLocale; 4]`, and 22
// non-exhaustive inner matches to hand-fill — the compiler naming the same file
// 22 times. The strings were logic and the logic was strings. Now:
//
//   logic + key contract  ->  apps/desktop/src-tauri/src/ui_i18n.rs   (hand-written)
//   which languages exist ->  packages/protocol/src/locales.ts        (the registry)
//   the strings           ->  i18n/desktop-rust/<code>.json           (data, one file per language)
//   the table             ->  src/ui_i18n_table.g.rs                  (THIS script's output)
//
// Adding language N+1 to this surface = a registry row + one JSON file + a run.
// No Rust file is edited, and nothing here knows how many languages there are.
//
// 🔴 THE OUTPUT IS COMMITTED, unlike *.g.dart (which .gitignore excludes by
// the `*.g.dart` pattern).
// Cargo has no codegen step and will not run node, so a gitignored table would
// simply not compile on a clean checkout. `--check` is the guard that keeps the
// committed copy from drifting from the JSON; wire it into a lint (the
// `generate-notice --check` precedent).
//
// COMPLETENESS IS STILL THE COMPILER'S JOB — the red line in §7-1 of the
// architecture doc ("漏译＝编译错误, 不许换成运行时兜底"). The emitted `table()`
// matches exhaustively on BOTH `Msg` and `UiLocale`, so:
//   · a `Msg` variant with no JSON entry  -> non-exhaustive match -> compile error;
//   · a JSON key with no `Msg` variant    -> unknown variant      -> compile error;
//   · a language with no cell for a key   -> refused HERE, below, before emitting.
// There is no runtime fallback anywhere in the chain, by construction.
//
// 🔴 THAT LAST SENTENCE IS NO LONGER TRUE OF THE CHAIN — only of THIS SURFACE.
// Kept above rather than rewritten, because it records what the rule was and the
// three bullets over it are still exactly how this file works. Owner ruled on
// 2026-08-14 that a missing translation falls back to English
// (packages/protocol/src/locales.ts, the BASE_UI_LOCALE comment, which also
// names the two standing decisions it supersedes), and the mobile and desktop-
// webview catalogues implement that: an untranslated leaf inherits the English
// one at GENERATION time, and per-language coverage is measured into
// i18n/<surface>/coverage.json so the degradation is declared rather than
// discovered.
//
// ⚠️ THE TRAY DELIBERATELY DID NOT FOLLOW. 22 strings is small enough to finish
// in one sitting, and the compiler check below costs nothing to keep — so this
// surface still refuses an incomplete language outright. That is a CHOICE about
// where the bar sits on one surface, not a second opinion about the ruling: a
// tray language that cannot be completed simply does not ship, which is the same
// outcome the fallback produces, arrived at before the build rather than after.
// ⇒ If that ever becomes expensive (a surface this small growing a long tail),
// the fix is to adopt the fallback here too, NOT to weaken the check into a
// silent blank menu item.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  readUiLocales,
  authoredCodes,
  defaultCode,
  rustVariant,
  REPO_ROOT,
  REGISTRY_REL,
} from './locale-registry.mjs';

const DATA_REL = 'i18n/desktop-rust';
const OUT_REL = 'apps/desktop/src-tauri/src/ui_i18n_table.g.rs';
const SELF_REL = 'scripts/i18n/gen-desktop-rust.mjs';

const DATA_DIR = join(REPO_ROOT, DATA_REL);
const OUT_PATH = join(REPO_ROOT, OUT_REL);

/** A JS string -> the body of a Rust `"..."` literal. Fail-loud on anything a
 *  human would not have typed on purpose: a stray control character in a UI
 *  string is a data defect, and silently emitting `\u{...}` for it would hide
 *  the defect inside a generated file nobody reads. */
function rustLiteral(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) {
      throw new Error(`control character U+${c.toString(16).toUpperCase()} in a UI string: ${JSON.stringify(s)}`);
    } else out += ch;
  }
  return `"${out}"`;
}

/** `{n}` / `{detail}` occurrences, as a sorted, de-duplicated list. */
function placeholders(s) {
  return [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

function loadSurfaceData(rows) {
  const byCode = new Map(rows.map((r) => [r.code, r]));

  // A data file for a code that is not a registry row means the two drifted —
  // refuse rather than emit a language the rest of the product does not know
  // about. (The other direction, a row with no data file, is the NORMAL state
  // during a staged rollout and is reported instead: architecture §8, P0-P3
  // deliberately keep four languages while the mechanism changes.)
  const present = readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
  for (const code of present) {
    if (!byCode.has(code)) {
      throw new Error(`${DATA_REL}/${code}.json has no row in ${REGISTRY_REL} — registry and data drifted`);
    }
  }

  // Registry order is display order; keep it so the emitted table's order is a
  // property of the registry and not of the filesystem's readdir.
  const emitted = rows.filter((r) => present.includes(r.code));
  const pending = rows.filter((r) => !present.includes(r.code)).map((r) => r.code);
  if (emitted.length === 0) throw new Error(`no locale data files in ${DATA_REL}`);

  const tables = new Map();
  for (const row of emitted) {
    tables.set(row.code, JSON.parse(readFileSync(join(DATA_DIR, `${row.code}.json`), 'utf8')));
  }

  // Key order comes from the AUTHORED language, never from a translation —
  // 17 册 §1: zh-CN and en are where meaning originates, everything else is
  // produced from them, so a translation must not get to decide the shape.
  const referenceCode = authoredCodes(rows).find((c) => tables.has(c));
  if (!referenceCode) {
    throw new Error(`no authored locale among the data files — refusing to take a translation as the reference column`);
  }
  const keys = Object.keys(tables.get(referenceCode));
  if (keys.length === 0) throw new Error(`${referenceCode}.json is empty`);

  for (const [code, table] of tables) {
    const own = Object.keys(table);
    const missing = keys.filter((k) => !own.includes(k));
    const extra = own.filter((k) => !keys.includes(k));
    if (missing.length || extra.length) {
      throw new Error(
        `${code}.json key set differs from ${referenceCode}.json — missing [${missing}], unexpected [${extra}]`
      );
    }
    for (const k of keys) {
      const v = table[k];
      if (typeof v !== 'string' || v.trim() === '') {
        throw new Error(`${code}.json key ${k} is empty — a missing translation must be fixed, not shipped`);
      }
      // The placeholder contract is the authored column's. A translation that
      // drops `{n}` renders a literal count-less sentence on the tray; catching
      // it here means it never reaches a build, let alone a user.
      const want = placeholders(tables.get(referenceCode)[k]);
      const got = placeholders(v);
      if (want.join(',') !== got.join(',')) {
        throw new Error(
          `${code}.json key ${k} placeholder mismatch — ${referenceCode} has [${want}], this has [${got}]`
        );
      }
    }
  }

  const fallback = defaultCode(undefined, rows);
  if (!tables.has(fallback)) {
    throw new Error(`DEFAULT_UI_LOCALE '${fallback}' has no ${DATA_REL}/${fallback}.json — the language the first frame renders in must exist on every surface`);
  }

  return { emitted, pending, keys, tables, fallback };
}

function render({ emitted, pending, keys, tables, fallback }) {
  const variants = new Map(emitted.map((r) => [r.code, rustVariant(r.code)]));

  const enumRows = emitted
    .map((r) => `    /// \`${r.code}\` — ${r.endonym} (${r.script}).\n    ${variants.get(r.code)},`)
    .join('\n');
  const allRows = emitted.map((r) => `        UiLocale::${variants.get(r.code)},`).join('\n');
  const tagArms = emitted
    .map((r) => `            UiLocale::${variants.get(r.code)} => ${rustLiteral(r.code)},`)
    .join('\n');
  const scriptArms = emitted
    .map((r) => `            UiLocale::${variants.get(r.code)} => ${rustLiteral(r.script)},`)
    .join('\n');
  const authoredArms = emitted
    .map((r) => `            UiLocale::${variants.get(r.code)} => ${r.authored ? 'true' : 'false'},`)
    .join('\n');
  const msgAll = keys.map((k) => `        Msg::${k},`).join('\n');

  const tableArms = keys
    .map((k) => {
      const inner = emitted
        .map((r) => `            UiLocale::${variants.get(r.code)} => ${rustLiteral(tables.get(r.code)[k])},`)
        .join('\n');
      return `        Msg::${k} => match locale {\n${inner}\n        },`;
    })
    .join('\n');

  const pendingLine = pending.length
    ? `// Registry rows with no ${DATA_REL}/<code>.json yet, therefore NOT emitted:\n//   ${pending.join(', ')}\n// (Staged on purpose — architecture §8 keeps four languages through P0-P3 so a\n// mechanism failure and a translation failure cannot be confused for each other.)`
    : `// Every registry row has a data file on this surface.`;

  return `// GENERATED — DO NOT EDIT BY HAND.
// Source: ${REGISTRY_REL} (UI_LOCALES) + ${DATA_REL}/<code>.json
// Regenerate: node ${SELF_REL}
// Count: ${emitted.length} locale(s) x ${keys.length} message(s) = ${emitted.length * keys.length} cell(s).
${pendingLine}
//
// \`include!\`d by src/ui_i18n.rs, so this shares that module's namespace: \`Msg\`
// and the per-key doc comments that pin each key to its production call site
// live THERE (the key contract is authored, only the data is generated).
//
// 🔴 THIS FILE IS COMMITTED. \`*.g.dart\` is gitignored because a pnpm step
// rebuilds it; cargo has no codegen step, so a gitignored table would not
// compile on a clean checkout. Running the generator with \`--check\` is what
// keeps the committed copy honest.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiLocale {
${enumRows}
}

impl UiLocale {
    /// Every shipped UI locale, in registry (display) order.
    ///
    /// 🔴 A SLICE, not \`[UiLocale; N]\`. The old array wrote the number of
    /// languages into a TYPE, which is the single most expensive line in the
    /// old add-a-language bill: it cannot be derived, so it can only be
    /// remembered. Nothing in this crate now states how many languages exist.
    pub const ALL: &'static [UiLocale] = &[
${allRows}
    ];

    /// The persisted tag — byte-identical to the \`code\` field of the registry
    /// row, which is what the WebView stores under \`flowmic.ui.locale\` and what
    /// \`ui_locale_set\` (shell/locale_sync.rs) is handed.
    pub fn tag(self) -> &'static str {
        match self {
${tagArms}
        }
    }
}

/// The product default when nothing was ever chosen — the registry's
/// \`DEFAULT_UI_LOCALE\`, so the Rust shell and the WebView cannot disagree about
/// which language the first frame is in. NEVER derived from the OS (red line).
pub const DEFAULT_LOCALE: UiLocale = UiLocale::${rustVariant(fallback)};

/// Index of [DEFAULT_LOCALE] inside [UiLocale::ALL].
///
/// Generated because AtomicU8::new needs a const and position() is not one.
/// Before this existed, CURRENT started at 0 and a test pinned the COINCIDENCE
/// that row 0 happened to be the default. The 2026-08-14 registry reorder (English
/// moved first, as the base language) broke that coincidence and the test caught
/// it — which is the test working. Emitting the real index removes the luck
/// instead of re-pinning a new coincidence.
pub const DEFAULT_LOCALE_INDEX: u8 = ${emitted.findIndex((r) => r.code === fallback)};

/// The two registry columns the table test reasons about, mirrored verbatim.
///
/// 🔴 \`#[cfg(test)]\` ON PURPOSE. Their only consumer today is the anti-copy-paste
/// test in \`ui_i18n.rs\`; an exported symbol with no caller is this repo's #1
/// historical defect class, so they are gated rather than left \`pub\` and unused.
/// When a production consumer appears — the Rust twin of \`SCRIPT_WIDTH_FACTOR\`
/// is the obvious candidate — drop the \`cfg\`.
///
/// \`script\` is the ISO 15924 code as a string rather than an enum so that a
/// registry row with a NEW script does not turn into a non-exhaustive match in
/// a file nobody edits: the rule table in \`ui_i18n.rs\` refuses an unknown script
/// out loud instead.
#[cfg(test)]
impl UiLocale {
    pub fn script(self) -> &'static str {
        match self {
${scriptArms}
        }
    }

    /// True for the languages whose copy is WRITTEN, not translated (17 册 §1).
    /// The table test compares translations AGAINST these and never the reverse.
    pub fn is_authored(self) -> bool {
        match self {
${authoredArms}
        }
    }
}

impl Msg {
    /// Every key, in the order the authored language's data file lists them.
    /// A slice for the same reason \`UiLocale::ALL\` is one — the count of keys
    /// is data, not type information.
    pub const ALL: &'static [Msg] = &[
${msgAll}
    ];
}

/// The strings. Exhaustive on both axes, so the compiler — not a runtime
/// fallback, not a test — is what refuses an incomplete table.
fn table(locale: UiLocale, msg: Msg) -> &'static str {
    match msg {
${tableArms}
    }
}
`;
}

function main() {
  const check = process.argv.includes('--check');
  const rows = readUiLocales();
  const data = loadSurfaceData(rows);
  const rendered = render(data);

  if (check) {
    const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : null;
    if (current !== rendered) {
      console.error(
        `gen-desktop-rust --check: ${OUT_REL} is stale — run \`node ${SELF_REL}\` and commit the result.`
      );
      process.exit(1);
    }
    console.log(`gen-desktop-rust --check: ${OUT_REL} is up to date.`);
    return;
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, rendered, 'utf8');
  const cells = data.emitted.length * data.keys.length;
  console.log(
    `gen-desktop-rust: ${data.emitted.length} locale(s) x ${data.keys.length} message(s) = ${cells} cell(s) -> ${OUT_REL}`
  );
  if (data.pending.length) {
    console.log(`gen-desktop-rust: NOT emitted (no ${DATA_REL}/<code>.json yet): ${data.pending.join(', ')}`);
  }
}

main();
