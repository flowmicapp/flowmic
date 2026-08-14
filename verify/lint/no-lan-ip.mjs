// verify/lint/no-lan-ip.mjs
// Lint 15/15 — the owner's private ranges must not reach shipped code or config.
//
// THE FAILURE THIS EXISTS TO PREVENT: a stranger installs the stock build and
// their app is pointed at somebody else's office LAN. That is not hypothetical —
// before card OSS-DEFAULTS (0.3.0) the seeded `stt.routings` / `llm.config` and
// four `stt/engines/*.ts` `DEFAULT_ENDPOINT` constants all dialled 100.64.7.68
// on first boot, and the sidecar bundle carried the addresses into the MSI.
//
// TWO RANGES, and only these two (see CLAUDE.md network topology):
//   · 100.64.7.*   — the owner's office LAN. PUBLICLY REGISTERED space used as
//                     a private network, which is exactly why it cannot be left
//                     lying around: on a stranger's machine it routes somewhere.
//   · 10.0.0.* — the VPN segment between the VPS and the engine boxes.
// Deliberately NOT a general "private IP" rule: 192.168.1.x / 10.x appear all
// over the tree as DOCUMENTATION examples and as legitimate runtime values, and a
// rule that fires on those would be turned off within a week.
//
// ── WHAT IS SCANNED ──────────────────────────────────────────────────────────
// SHIPPED code and config only (SCAN_ROOTS below): the app sources and the
// shared packages. NOT the built Tauri resources — see the note on SCAN_ROOTS;
// that artifact has its own scanner. NOT `docs/` — CLAUDE.md is explicit
// that "LAN IPs inside docs/ are R&D presets, not secrets", and a lint that shouted about the
// decision logs would be noise that trains people to skip it. NOT `scripts/` or
// `verify/` either: those run on a developer's machine, never on a user's.
// Test files are excluded by name, and Rust sources are truncated at the first
// `#[cfg(test)]` — that content is not in the shipped binary.
//
// ── THE WAIVER MECHANISM (and why it is not "ignore comments") ───────────────
// A hit inside a COMMENT is documentation: it explains why a thing is the way it
// is, and it dials nothing. But 「comments are exempt」 as a blanket rule would let
// a real address ride into the tree inside a `//`-prefixed line of a generated
// file, and — worse — nobody would ever know how much of this debt exists.
//
// So every file that still contains either range must appear in [WAIVERS] with an
// EXACT count and a reason, and the counts are checked in BOTH directions:
//   · more hits than declared  ⇒ FAIL (new debt, the thing this gate is for);
//   · fewer hits than declared ⇒ FAIL (a stale waiver, which reads as evidence
//     that somebody checked — the same discipline STRIP_EDITS applies with
//     "the hit count must be exactly 1" and coordinate-anchors applies to its baseline).
// An unlisted file with ANY hit fails outright.
//
// `code` and `comments` are counted separately and declared separately, because
// they are different debts: a comment costs a reader a moment of confusion, and a
// line of code costs a stranger a connection to somebody's office.
//
// EVERY ENTRY IS A DEBT, NOT AN ENDORSEMENT.
//
// REGENERATE the declarations with `NO_LAN_IP_DUMP=1 node verify/lint/no-lan-ip.mjs`
// — it prints paste-ready entries to stderr. Hand-check every `why` it leaves
// blank; a waiver without a reason is the shape this whole file argues against.

import { ROOT, walk, readText, rel, DEFAULT_SKIP_DIRS } from './_util.mjs';
import path from 'node:path';

export const name = 'no-lan-ip';

/**
 * The two ranges, spelled EXACTLY as the card's acceptance grep spells them —
 * prefix + trailing dot, with no constraint on what follows.
 *
 * ⚠️ It was `…\.\d` for one draft, and that was a ruler that measured the wrong
 * thing: prose spells these `100.64.7.x`, so the digit anchor made every prose
 * mention invisible and the enumeration silently incomplete — a waiver list that
 * cannot see half the debt is worse than none, because it looks like a census.
 * Matching the bare prefix means prose counts too; prose is then DECLARED, which
 * is the entire point of the mechanism.
 *
 * 🔴 PLAIN STRING LITERALS, NOT REGEXES, AND THAT IS LOAD-BEARING. The public
 * export applies `scripts/opensource-manifest.mjs` REDACTIONS — a tree-wide
 * literal substitution — so in the exported tree every `100.64.7` becomes
 * `10.7.7`. Written as `/172\.77\.77\./` this rule would survive that pass
 * UNTOUCHED (the escaped form contains no `100.64.7` substring), keep hunting an
 * address the exported tree no longer contains, find zero, and declare all
 * sixteen WAIVERS stale.
 *
 * 🔴 THAT SENTENCE IS NOW A MACHINE CHECK, NOT ONLY A SENTENCE (W4A-9,
 * 2026-08-12). `checkShippedRangesRedacted()` in scripts/opensource-manifest.mjs
 * reads this very array and refuses the export when a range is not a plain
 * string, or is not covered by a REDACTION — so rewriting RANGES as regexes
 * fails at the export gate by name instead of one release later, as sixteen
 * stale waivers on somebody else's fresh checkout. Until then this paragraph was
 * a comment asserting another file's behaviour (anti-façade ④): true when written,
 * unable to notice when it stopped being.
 *
 * MEASURED both ways (2026-08-09, machine dev-pc-a, by replaying the
 * redaction over a copy of THIS FILE and over each declared file, then running
 * the redacted lint against the redacted text):
 *   · as regexes  — **13 of 16** entries wrong in the exported tree
 *                   (`engine-presets.ts` 6 code / 3 comment → 0 / 1);
 *   · as literals — **3 of 16**.
 * As literals the rule is rewritten by the same pass that rewrites the tree, so
 * both move together.
 *
 * 🔴 THE RESIDUAL 3 WERE REAL. ✅ CLOSED (W5O, 2026-08-09) — kept here because
 * the mechanism is the whole reason RANGES must stay literals:
 *   `apps/server-core/src/settings/defaults.ts`            5 → 2
 *   `apps/desktop/src/lib/strings/disclosure.ts`           1 → 0
 *   `apps/mobile/…/strings/disclosure_strings.dart`        1 → 0
 * Cause: the two OLDER redactions mapped whole addresses (`10.0.0.68` →
 * `10.0.0.10`, `.179` → `10.0.0.11`) rather than the prefix, so those hits left
 * the tree entirely while THIS file's `'10.0.0.'` literal — containing
 * neither whole address — did not move with them. The waivers then read as
 * stale and the gate FAILED 3 items on a fresh public checkout: the lint telling
 * the truth in the one register (FAIL) that is wrong for a public CI.
 *
 * FIXED by merging them into one PREFIX rule `prod-vpn-range`
 * (`10.0.0` → `10.0.0`), symmetric with `office-lan-range`. Merged rather
 * than doubled because two rules with identical effect leave the second matching
 * zero occurrences, which is a `DEAD_REDACTION` hard failure.
 *
 * MEASURED both directions by replaying the real REDACTIONS over a copy of the
 * scanned trees AND of this file, then running the redacted lint in the redacted
 * root (2026-08-09, dev-pc-a — the exporter itself could not be used, see
 * the open account below):
 *   · with the OLD whole-address rules — redacted `RANGES` came out as
 *     `['10.7.7.', '10.0.0.']` (office moved, VPN did not) ⇒ **FAIL, the
 *     exact 3 entries listed above**;
 *   · with the prefix rule — `['10.7.7.', '10.0.0.']` ⇒ **PASS, 609 files,
 *     6 code + 28 comment**, identical to the private tree.
 *
 * ⚠️ OPEN ACCOUNT, NOT THIS FILE'S: `opensource-export.mjs --out` currently
 * refuses to run at all (`TEST_SUBJECT_PAIR` — `scripts/up9-portable-self-update-marker.test.mjs`
 * names the EXCLUDEd `publish-download-center.mjs` in a string literal). That is
 * why the measurement above is a redaction REPLAY rather than a real export, and
 * it means no full export has been produced since that drill landed.
 */
export const RANGES = ['100.64.7.', '10.0.0.'];

/** Shipped trees only — what ends up on a user's machine. */
const SCAN_ROOTS = [
  'packages/protocol/src',
  'packages/stt-cloud/src',
  'apps/server-core/src',
  'apps/desktop/src',
  'apps/desktop/src-tauri/src',
  'apps/mobile/lib',
  // ⚠️ `apps/desktop/src-tauri/resources` is deliberately NOT here. It holds the
  // BUILT sidecar bundle (`server.js`, gitignored, ~1.4 MB of esbuild output) —
  // a derivative of the sources above, so linting it would re-report the same
  // debt a second time under a filename nobody can edit, and its count would
  // move with every rebuild. The artifact is measured by its own tool:
  // scripts/scan-artifact-lan-ip.mjs. One question, one mechanism.
];

/** A test file by name. Tests are not shipped, and they legitimately need
 *  addresses to assert about (`settings-defaults.test.ts` pins the exact seeds a
 *  deployment gets). */
function isTestFile(relPath) {
  const base = path.basename(relPath);
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /_test\.dart$/.test(base) ||
    /_tests\.rs$/.test(base) ||
    /(^|\/)tests?\//.test(relPath)
  );
}

/**
 * Strip content that is not compiled into the shipped artifact.
 *
 * Rust: everything from the first `#[cfg(test)]` onward. Crude on purpose — a
 * real parse would be a second answer to a question `cargo` already owns, and the
 * conservative direction here is to scan LESS of a file we already scan rather
 * than to invent a syntax tree. ⚠️ It therefore also drops any real code that
 * happens to sit after a test module; every Rust file in SCAN_ROOTS today has its
 * test module last, which is the convention, not a guarantee.
 */
function shippedText(relPath, text) {
  if (!relPath.endsWith('.rs')) return text;
  const i = text.indexOf('#[cfg(test)]');
  return i === -1 ? text : text.slice(0, i);
}

/**
 * Where a line's comment begins, or -1.
 *
 * 🔴 THE `://` TRAP, AND IT CAUGHT THIS FILE'S FIRST DRAFT. A naive
 * `line.includes('//')` reads `endpoint: 'http://100.64.7.68:10095'` as a
 * COMMENT, because a URL scheme contains `//`. Measured on the real tree: the
 * first run reported the preset catalogue as `0 code / 8 comments` — it
 * classified all six live endpoint literals as documentation and would have
 * waived, in perpetuity, precisely the lines this lint exists to count. The
 * detector has to skip a `//` immediately preceded by `:`.
 */
function commentStart(line) {
  for (let i = line.indexOf('//'); i !== -1; i = line.indexOf('//', i + 2)) {
    if (i > 0 && line[i - 1] === ':') continue; // URL scheme, not a comment
    return i;
  }
  const block = line.indexOf('/*');
  return block === -1 ? -1 : block;
}

/** Is the hit at `col` inside a comment? Line-oriented and language-agnostic: a
 *  `#` / `*` / `///` leader, or a comment opener earlier on the same line. Block
 *  comments are covered by their continuation `*` leaders, which is how every
 *  long comment in this tree is actually written. A hit that is NOT PROVABLY in a
 *  comment counts as CODE — a wrong guess must land on the loud side. */
function isComment(line, col) {
  if (/^\s*(\*|#|\/\/)/.test(line)) return true;
  const c = commentStart(line);
  return c !== -1 && c < col;
}

/** Count hits in one file's shipped text, split by comment/code. */
export function scanText(relPath, rawText) {
  const text = shippedText(relPath, rawText);
  const lines = text.split('\n');
  let code = 0;
  let comments = 0;
  const samples = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    for (const range of RANGES) {
      for (let i = line.indexOf(range); i !== -1; i = line.indexOf(range, i + range.length)) {
        if (isComment(line, i)) comments++;
        else {
          code++;
          samples.push(`${relPath}:${n + 1} ${range}`);
        }
      }
    }
  }
  return { code, comments, samples };
}

/**
 * The declaration verdict for ONE file: `null` when it matches its waiver.
 *
 * Extracted from [run] so it can be driven with fixtures (W5O, 2026-08-09).
 * `run` walks the real SCAN_ROOTS and has no injection point, so the two
 * branches that actually FAIL this gate — an undeclared file, and a count that
 * has drifted — were reachable only by editing a shipped source file to make the
 * repo dirty. That is not a test one runs, so it was never run. Behaviour here is
 * byte-for-byte what `run` did inline.
 */
export function auditFile(relPath, found, waiver) {
  const { code, comments, samples } = found;
  if (!waiver) {
    return (
      `${relPath}: ${code} code + ${comments} comment hit(s), NOT DECLARED` +
      (samples.length ? ` — e.g. ${samples[0]}` : '')
    );
  }
  if (code !== waiver.code || comments !== waiver.comments) {
    return (
      `${relPath}: declared ${waiver.code} code / ${waiver.comments} comment, found ${code} / ${comments}` +
      (code > waiver.code && samples.length ? ` — new code hit e.g. ${samples[waiver.code] ?? samples[0]}` : '')
    );
  }
  return null;
}

/**
 * 🔴 THE DECLARED DEBT. Counts are exact in both directions — see the header.
 *
 * The `code` column is the one that matters. It is 6 today and every one of them
 * lives in ONE file, the bundled preset catalogue, for a reason CLAUDE.md states
 * as a standing ruling: "never hard-code 100.64.7.x (**presets go in the presets package**)". The
 * presets package IS the sanctioned home; what OSS-DEFAULTS removed was every
 * address OUTSIDE it, plus every default that made a stranger's install USE one.
 *
 * ⚠️ THAT IS NOT THE SAME AS SAYING THE CATALOGUE IS FINE. A stock build still
 * offers those six menu entries, and picking one dials the owner's office. Two
 * things stand between that and a public release, and neither is this lint:
 * `scripts/scan-artifact-lan-ip.mjs` MEASURES the built sidecar bundle and
 * reports whatever it finds as an open account, and `scripts/opensource-manifest.mjs`
 * REDACTIONS rewrites the prefix on the way out to the public tree. The open
 * account is written up in the OSS-DEFAULTS report; do not read this waiver as
 * a decision that it is closed.
 *
 * 🔴 THIS PARAGRAPH USED TO SAY THE ARTIFACT SCANNER 「MEASURES THE SIX」, AND
 * THAT NUMBER WAS WRONG THE DAY IT WAS WRITTEN (W5O, 2026-08-09). Measured on
 * dev-pc-a: `scripts/ossdef-artifact-lan-ip.test.mjs` §5 reports **11**
 * occurrences in `apps/desktop/src-tauri/resources/server.js`, because that
 * bundle is a build from BEFORE this card — hits 7..11 are the four
 * `DEFAULT_ENDPOINT` constants the card deleted, still present in a stale
 * artifact nobody rebuilt. Two counts, two different questions: this file counts
 * SOURCE, that tool counts a BUILD, and the build can be older than the source.
 * ⇒ The number is deliberately not restated here now. A comment that asserts
 * another tool's output is reverse-façade ④ — its truth changes when that tool's
 * input changes, and it cannot notice. Run the tool and read its number.
 */
export const WAIVERS = [
  {
    file: 'packages/protocol/src/engine-presets.ts',
    code: 6,
    comments: 4,
    why: 'The bundled preset CATALOGUE — four LAN STT presets + two LAN LLM presets. '
      + 'CLAUDE.md 「预设走 presets 包」 puts the R&D addresses here on purpose. Nothing '
      + 'SELECTS them any more (settings/defaults.ts seeds builtin-sherpa-local and no '
      + 'LLM); a deployment names one through FLOWMIC_DEFAULT_*_PRESET. Still a live '
      + 'menu a stranger can pick — see the note above this list.',
  },
  {
    file: 'apps/server-core/src/settings/defaults.ts',
    code: 0,
    comments: 5,
    why: 'The FLOWMIC_DEFAULT_*_HOST block: the owner ruling of 2026-07-27 quoted '
      + 'verbatim plus the /etc/flowmic-app/env example. Deleting the addresses would '
      + 'delete the record of which two machines that override exists for.',
  },
  {
    file: 'apps/server-core/src/http/router.ts',
    code: 0,
    comments: 2,
    why: 'Why the trusted-proxy ordering puts legal-but-non-standard office ranges '
      + 'below public space. The range is the example that makes the rule legible.',
  },
  {
    file: 'apps/server-core/src/lan-tls/x509.ts',
    code: 0,
    comments: 2,
    why: 'SAN list of the cert actually issued during LAN-TLS bring-up — a measurement, '
      + 'and measurements are not rewritten.',
  },
  {
    file: 'apps/server-core/src/stt/engines/base.ts',
    code: 0,
    comments: 3,
    why: 'The OSS-DEFAULTS header on `requireEndpoint` itself: it names the address the '
      + 'four deleted DEFAULT_ENDPOINT constants used to dial. A refusal is easier to '
      + 'trust when the thing it replaced is on the page. Third occurrence added '
      + '2026-08-14 by the English translation: the header quotes the Chinese rule it '
      + 'enforces and now carries an English rendering beside it, so the address the '
      + 'rule names appears in both halves of that one quote.',
  },
  {
    file: 'apps/server-core/src/compose/llm/openai-compatible.ts',
    code: 0,
    comments: 1,
    why: 'SPEC-REF pointing at the vLLM box the adapter was written against.',
  },
  {
    file: 'apps/desktop/src/lib/lan-endpoint.ts',
    code: 0,
    comments: 1,
    why: 'Explains why RFC1918-first ranking guesses wrong for this tablet: 100.64.7.x '
      + 'is NOT RFC1918. Remove the address and the sentence stops being checkable.',
  },
  {
    file: 'apps/desktop/src/lib/pairing.ts',
    code: 0,
    comments: 1,
    why: 'RV-21 post-mortem: the single candidate the QR used to carry.',
  },
  {
    file: 'apps/desktop/src/lib/strings/disclosure.ts',
    code: 0,
    comments: 1,
    why: 'W1 ledger §7.7.5 measurement (45 connections to the FunASR box) cited as the '
      + 'evidence behind a user-facing disclosure sentence.',
  },
  {
    file: 'apps/desktop/src/main-window/settings-model.ts',
    code: 0,
    comments: 3,
    why: 'OSS-DEFAULTS itself: the addresses the defaults USED to be, named so the '
      + 'change is legible. Removing them would leave 「was a preset」 with no referent.',
  },
  {
    file: 'apps/desktop/src-tauri/src/sidecar/io.rs',
    code: 0,
    comments: 1,
    why: 'Same RFC1918-ranking explanation as lan-endpoint.ts, Rust side.',
  },
  {
    file: 'apps/mobile/lib/src/auth/saas_endpoint.dart',
    code: 0,
    comments: 1,
    why: 'SPEC-REF citing the CLAUDE.md 代码禁写死 rule this file complies with.',
  },
  {
    file: 'apps/mobile/lib/src/session/instance_probe.dart',
    code: 0,
    comments: 1,
    why: 'Why the classifier cannot prove this range is private (it is registered space).',
  },
  {
    file: 'apps/mobile/lib/src/session/image_upload.dart',
    code: 0,
    comments: 1,
    why: 'RV-97 post-mortem: the exact malformed URL that threw.',
  },
  {
    file: 'apps/mobile/lib/src/settings/strings/disclosure_strings.dart',
    code: 0,
    comments: 1,
    why: 'The Dart mirror of the disclosure.ts citation above — same measurement.',
  },
  {
    file: 'apps/mobile/lib/src/settings/strings/image_strings.dart',
    code: 0,
    comments: 2,
    why: 'RV-97 post-mortem quoted in the string table beside the copy it produced. '
      + 'Second occurrence added 2026-08-14 by the English translation: the quoted '
      + 'failure line is kept verbatim (it is evidence) with an English rendering '
      + 'beside it, and the address is inside the quoted text itself.',
  },
];

export default async function run() {
  const byFile = new Map(WAIVERS.map((w) => [w.file, w]));
  const findings = [];
  const seen = new Set();
  let scanned = 0;
  let codeTotal = 0;
  let commentTotal = 0;
  const dump = [];

  for (const root of SCAN_ROOTS) {
    const abs = path.join(ROOT, root);
    let files;
    try {
      files = await walk(abs, { skipDir: (name) => DEFAULT_SKIP_DIRS.has(name) });
    } catch {
      continue; // a root that does not exist on this checkout (resources/ is built)
    }
    for (const f of files) {
      const r = rel(f);
      if (isTestFile(r)) continue;
      const text = await readText(f);
      if (text == null) continue;
      scanned++;
      const { code, comments, samples } = scanText(r, text);
      if (code === 0 && comments === 0) continue;
      codeTotal += code;
      commentTotal += comments;
      dump.push(`  { file: '${r}', code: ${code}, comments: ${comments}, why: '' },`);
      const w = byFile.get(r);
      if (w) seen.add(r);
      const finding = auditFile(r, { code, comments, samples }, w);
      if (finding !== null) findings.push(finding);
    }
  }

  // A declaration for a file that no longer has hits (or no longer exists) is a
  // stale waiver — the same failure a dead REDACTION is.
  for (const w of WAIVERS) {
    if (!seen.has(w.file)) findings.push(`${w.file}: declared but produced no hits (stale waiver — delete it)`);
  }

  if (process.env.NO_LAN_IP_DUMP === '1') {
    process.stderr.write(`export const WAIVERS = [\n${dump.join('\n')}\n];\n`);
  }

  if (findings.length > 0) {
    return {
      status: 'FAIL',
      detail: `${findings.length} issue(s): ${findings.slice(0, 8).join('; ')}`,
    };
  }
  return {
    status: 'PASS',
    detail: `${scanned} shipped file(s) scanned, ${codeTotal} code + ${commentTotal} comment hit(s), all declared`,
  };
}
