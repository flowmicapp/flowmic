// verify/lint/coordinate-anchors.mjs
// Lint 12/12 — IT-43, tightened by IT-55 / IT-59 / IT-60: a file:line
// coordinate written in code must carry a code-shaped, greppable anchor that
// really sits near that line — and the baseline pins the CLAIM being made,
// not just the coordinate it is made about.
//
// WHY THIS IS A GATE AND NOT A RULE
// ---------------------------------
// The rule "line numbers rot, symbol names don't" was stated by the lead in one
// window and broken twice BY ITS OWN AUTHOR inside that same window. A rule that
// its author cannot keep is not a rule, it is a wish. So it gets mechanised.
// The two measured breakages are this lint's positive controls; both are fixed
// in the same commit that adds the lint (they are deliberately NOT baselined):
//   - scripts/opensource-manifest.mjs cited line 104 of verify/lint/version-sync.mjs
//     for the `CLAUDE.md` face; commit 40314cf had pushed that face down ~48
//     lines. (Written out in words here on purpose: this file must be clean
//     under its own gate, and spelling the number would make the header itself a
//     hit the day version-sync.mjs moves again.)
//   - apps/server-core/src/room/pair-rate-limit.ts cited a test title that
//     existed nowhere in the repo.
//
// WHAT IS CHECKED
// ---------------
// Detector (exactly one): a textual reference of the shape
//   <some>/<path>/<file>.<ext>:<NNN>
// appearing anywhere in a scanned code file (comment or string alike — this is
// a text check, it does not parse).
//
// A hit FAILS when any of:
//   (a) the referenced file does not exist;
//   (b) NNN is past that file's last line;
//   (c) the referring CLAIM WINDOW (see below) carries no anchor token at all;
//   (d) NONE of the claim window's anchor tokens appears in the referenced
//       file within ±ANCHOR_WINDOW lines of NNN.
//
// THE ANCHOR PREDICATE — WHAT IT EXCLUDES, AND WHAT IT DOES NOT (IT-55)
// ---------------------------------------------------------------------
// History first, because the tightening is a measured response to a measured
// hole: a 2026-08-06 three-arm probe (throwaway file, since deleted, residual
// grep 0) carried the SAME false claim in all three arms — that `countLines`
// sits at line 13 of verify/lint/_util.mjs, when line 13 is really the `ROOT`
// constant whose body reads `path.resolve(here, …)`. Only the arm that named
// nothing but the true symbol was reported. The other two smuggled the word
// `path` into the sentence (once backticked, once as a sentence ending on the
// bare word followed by a full stop) and went green, because the old tokenizer
// took ANY quoted string of 3+ chars and any word containing a dot — so
// `path`, `path.`, `Node.` and `here.` all qualified as "anchors".
//
// The predicate now EXCLUDES exactly three shapes:
//   1. a QUOTED single prose-shaped word — all letters, no separator, no
//      interior capital (`path`, `const`, `return`, `Path`) — UNLESS it is in
//      QUOTED_LITERAL_ALLOWLIST. That list exists because some legitimate
//      protocol literals are all-lowercase words (`sendinput` is the measured
//      example: it is a real InjectMode value, and refusing it would
//      false-reject a true citation of the line that defines it). The list is
//      deliberately closed-by-default: an all-lowercase quoted word NOT on the
//      list is refused, which fails LOUD (a red tells you to drop the `:NNN`
//      or extend the list) instead of letting prose rot pass silently.
//   2. a bare word whose only "identifier signal" is TRAILING punctuation —
//      trailing `.` / `:` runs are stripped before the shape test, so a
//      sentence-final `path.` or `Node.` no longer counts, while an interior
//      dot (`path.resolve`, `users.email`) still does.
//   3. dotted Latin abbreviations (`e.g.`, `i.e.`, …) — the closeout
//      adversarial review (2026-08-06) proved shape 2's rule blind to them:
//      `e.g.` loses only its TRAILING dot and keeps an interior one, so it
//      passed as an identifier, and any comment containing `e.g.` on both
//      sides greened a rotted coordinate. Closed list ABBREVIATIONS below;
//      compared lowercase after trailing-dot strip, in BOTH token branches.
// It does NOT exclude:
//   - multi-word quoted phrases (they are explicit claims of literal text);
//   - quoted words containing digits, `_`, `::`, `.`, or an interior capital
//     (`utf8`, `PAIR_IP_MAX_KEYS`, `fooBar`, `Foo::bar`);
//   - all-caps quoted words (`ROOT`, `TEMP`) — constant-shaped;
//   - allowlisted lowercase literals near a line that merely USES the word in
//     prose — a quoted `cached` still anchors to a comment saying "cached".
// ⇒ So the enforced property is still one of WORDS, not of verified symbols:
//   a coordinate is red when no code-shaped word of its claim window appears
//   within ±ANCHOR_WINDOW lines of the cited line. A GREEN COORDINATE IS NOT
//   A VERIFIED COORDINATE — the gate bounds how far a citation can rot before
//   someone notices; it certifies no individual citation, and a reader still
//   has to follow the number. Which remains the real argument for the escape
//   hatch below.
//
// REWRAP INSENSITIVITY — the reverse direction of the same door (IT-55, row 8)
// ---------------------------------------------------------------------------
// The referrer-side window went through three shapes, each a measured
// correction of the last: the card said "the referring line only" (±0), which
// measured the FORMATTER, not the claim — a comment naming `resolve_node_exe`
// whose coordinate wraps to the next line at column 100 was refused for a
// reason unrelated to its truth. ±1 physical lines fixed that shape and broke
// on the next one: re-wrap a CORRECT comment so the symbol lands two physical
// lines from the coordinate (same words, same order, same claim — only a
// newline moved) and it went red, which trains people to add baseline entries.
// So the window is now measured in NORMALIZED CHARACTERS, not physical lines:
// comment leaders (`//`, `*`, `#`…) are stripped, whitespace runs collapse to
// one space, lines join on a single space, and anchors are collected within
// ±REFERRER_SPAN normalized chars of the reference. Moving a newline through
// a comment no longer changes the window's content AT ALL — that is the
// invariance property, and it is pinned by a regression probe in
// scripts/coordinate-anchors-lint.test.mjs (grep `re-wrapped across three
// lines` there for the exact assertion).
//
// THE BASELINE PINS THE CLAIM, NOT JUST THE COORDINATE (IT-59)
// ------------------------------------------------------------
// A baseline that stores only `referrer|target#NNN` is a slot, and a slot can
// absorb a DIFFERENT claim: measured 2026-08-06, replacing the entire sentence
// around a baselined coordinate with an invented one still reported PASS 0 new
// (only 55 of the 60 pinned keys were even unique). So every baseline entry
// now carries a 12-hex sha256 of the CLAIM WINDOW — ±CLAIM_SPAN normalized
// chars around the reference, reference text itself blanked. Change the words
// of a baselined claim and the digest no longer matches: the hit is NEW and
// the gate fails. Because the digest is computed over the same normalized text
// as the anchor window, re-wrapping a pinned claim does NOT invalidate its
// entry (same probe file, grep `digest is identical for wrapped and unwrapped`).
// The cost, stated: an edit to unrelated text that sits within ±CLAIM_SPAN
// normalized chars of a pinned reference also changes the digest and shows up
// as 1 new / 1 stale-pinned. That is deliberate — the neighbourhood of a claim
// is part of the claim — and the DUMP switch below regenerates honestly.
//
// …AND IT PINS THE TARGET REGION TOO (IT-64, made sound by IT-65)
// ----------------------------------------------------------------
// IT-59 pinned the referrer's sentence and nothing else, which left the pin
// certifying nothing about the thing it points AT: a baselined coordinate
// stayed absorbed while the target's cited region was rewritten wholesale.
// (Ruling: docs/decisions/2026-08-06-it64-anchor-lint-tolerances-are-a-choice.md
// — the one soundness hole taken out of that card's measured escape set; every
// other tolerance there was recorded as debt, not tightened.) So the pin is now
// composed of TWO digests:
//
//   pinKey = <referrer>|<target path>#<NNN>|<referrer digest>|<target digest>
//
//   - referrer digest — UNCHANGED from IT-59, and untouched by IT-65: sha256/12
//     of the ±CLAIM_SPAN normalized claim window, reference text blanked.
//   - target digest — sha256/12 of the TARGET's cited window: exactly the
//     ±ANCHOR_WINDOW lines the anchor predicate already reads, hashed as TWO
//     components (built in targetWindowText):
//       · the WORDS — each line through normalizeChunk (comment leader
//         stripped, whitespace runs collapsed to one space), lines that
//         contribute no words dropped, joined on single spaces;
//       · the LEADER VECTOR — leaderOf() per line, positional, joined on `|`.
//     Sentinels instead of a digest when there is no window to hash:
//     TARGET_MISSING (file did not resolve) / TARGET_PAST_EOF (line beyond the
//     file's end), so a target appearing or growing past the cited line is
//     itself a pin change rather than a silent one.
//
// 🔴 WHY THE TARGET SIDE GETS ITS OWN TREATMENT — the IT-65 correction
// --------------------------------------------------------------------
// IT-64 shipped this sentence: "One normalizer, not two — a second
// normalization would be two answers to the question 'what counts as the same
// text'." It was wrong, and it was wrong in the direction that voided the
// digest it was defending. THE TWO SIDES ARE NOT ASKING ONE QUESTION. A
// citation lives INSIDE a comment, so on the referrer side `//` is the envelope
// and stripping it is right. The target window is CODE, where a leading `//` or
// `*` is MEANING — so stripping it there erased the difference between a line
// and its deletion. Reproduced twice (adversarial review, then the supervisor
// on the real tree, both against an already-baselined coordinate):
//     append a marker to the cited line   -> FAIL, 3 new   (caught)
//     prefix `// ` to the cited line      -> PASS, 0 new   (NOT caught)
// The pin caught a comment being ADDED to a line and did not catch the line
// being DELETED. The same collision hit `*count += 1;` vs `count += 1;`, which
// matters for .rs targets: the leader regex eats a leading `*` because `*` is
// also a block-comment interior marker.
// ⇒ Two questions, two treatments. That is NOT the "one value answering two
// questions" smell this repo hunts — it is the exact inverse of it: IT-64 had
// ONE normalizer answering two different questions, and the second answer was
// false. Do not "unify" these back into one function.
//
// 🔴 AND WHY THE LEADER IS A POSITIONAL VECTOR, NOT LEFT INLINE IN THE TEXT
// The obvious repair — stop stripping the leader, leave it in each line's words
// — was built and MEASURED before being rejected. It closes the hole, and it
// costs too much: with the leader inline, the join makes the digest
// position-sensitive, so merely RE-WRAPPING a comment inside the window moves
// it. Probe (throwaway: whole tree copied twice, every comment in the copy
// reflowed by one word, repo untouched, since deleted):
//     leader inline in the words     -> 28 of 48 pinned entries flip
//     leader as a positional vector  ->  7 of 48   (what ships)
//     IT-64 as shipped               ->  7 of 48   (control)
// The 7 are the same 7 in all three arms and are honest: a word crossing the
// window's EDGE genuinely changes which words are inside it. So the vector buys
// the deletion check for ZERO added churn, where the inline form would have put
// 21 more entries on a hair-trigger against edits that change no code at all.
// It is also the only one of the two that keeps the rewrap invariance below.
//
// WHAT THE TARGET DIGEST IS AND IS NOT INVARIANT TO — stated exactly, because
// this is what decides whether the gate churns. Every line of this list has a
// probe behind it in scripts/coordinate-anchors-lint.test.mjs:
//   INVARIANT to: re-indentation; widened or narrowed whitespace runs; trailing
//     whitespace; the spacing between a comment leader and its text (`//x` and
//     `// x` are the same); and moving a word across a line break INSIDE the
//     window at unchanged line count — INCLUDING the case where that leaves the
//     donor line holding nothing but its leader.
//     🔴 That last clause is a CORRECTION, not a restatement: IT-64's header
//     claimed the line-break case flatly, and the closeout review measured the
//     exception — a leader-only line normalized to '' and the join emitted a
//     double space, so the digest moved after all. Lines contributing no words
//     are now dropped from the words half, which makes the original claim TRUE
//     rather than narrowing it (the cheaper of the two repairs, and the one
//     that removes churn instead of documenting it). Probe (d) pins it.
//   NOT invariant to: any change to the WORDS in the window; a line being
//     COMMENTED OUT or uncommented, and any change of leader style (`//` ↔
//     `///` ↔ `*` ↔ `#` ↔ `<!--`) — that is the leader vector's whole job; a
//     leading `*` appearing or disappearing (`*count` vs `count`); inserting or
//     deleting a blank line inside the window; a reflow that changes the number
//     of lines inside the window (different content then falls within
//     ±ANCHOR_WINDOW, which is the point — the window moved); a trailing `*/`
//     or other line-END comment punctuation (only LEADERS are recognised, so a
//     `//` ↔ `/** */` reformat changes both components); and lines entering or
//     leaving the window because code above the cited line shifted.
//   ⇒ The direct effect is the one the ruling asked for: the 48 pinned debts go
//   red on the day their targets actually move. That is what a debt record is
//   for. It also means a wholesale reformat of a cited region shows up as churn
//   in the baseline; regenerate with the DUMP switch, do not hand-edit.
//
// THREE FALSE-POSITIVE FAMILIES THAT ARE LIVE TODAY (IT-64, measured)
// -------------------------------------------------------------------
// Recorded here because the ruling forbids publishing only the good news, and
// because a gate whose known noise is undocumented is a gate people learn to
// silence by appending to the baseline:
//   1. Comment-style reformat: rewriting a `//` block as `/** */` changes both
//      halves of the target digest (the leader vector by construction, and the
//      words because the closing `*/` at line END is not a leader and survives)
//      ⇒ the digest moves and the entry reports as 1 new / 1 stale, even though
//      not a word changed. IT-65 neither shrank nor widened this family — it is
//      the price of asking the leader question at all, and it is the reason the
//      leader is asked ONCE PER LINE instead of being mixed into the words.
//      What WAS measured, and is a different mutation from this one: a comment
//      RE-WRAP (words moved between lines, no style change) costs 7 of 48
//      pinned entries — identical before and after IT-65, and all 7 from words
//      crossing the window edge. See the IT-65 section above for that probe.
//   2. Inserting a blank line above a pinned claim changes its digest, for the
//      same reason on the referrer side: the blank normalizes to an empty
//      element and the join emits a double space inside ±CLAIM_SPAN.
//   3. CONTEXT_LINES=8 truncation can red a TRUE claim: only 8 physical lines
//      each side are fed to the normalizer, so a citation whose symbol sits
//      ~10 short lines away never enters the referrer window at all and the
//      coordinate fails for a reason unrelated to its truth.
// None of the three were tightened this round; they are the measured cost of
// the tolerances the ruling deliberately left alone.
//
// THE SCAN FACE IS INDEPENDENT OF CODEGEN STATE (IT-60)
// -----------------------------------------------------
// `*.g.dart` files are build artifacts (gitignored by the root .gitignore's
// `*.g.dart` pattern — greppable there) that exist only on machines where
// codegen has run. Before this card, they were scanned when present: the same
// gate measured two different faces on different machines, silently (the
// third-iteration ledger caught 956-vs-947 file counts in two sections of the
// same document). Generated files are now excluded BY NAME PATTERN
// (GENERATED_NAME_RE) plus the explicit GENERATED set, so the face is
// identical whether or not codegen has run; a `git ls-files`-derived face was
// considered and rejected because this lint also runs in the exported public
// tree, where spawning git and the timing of `git init` would make the face
// depend on the exporter's internal ordering — a second silent divergence.
// The face size (file count) and the number of exclusions print on EVERY run,
// pass or fail, so a divergence is loud, not silent.
//
// 🔴 THE ESCAPE HATCH IS THE BEHAVIOUR WE WANT
// A reference that DROPS `:NNN` and keeps only the path + symbol
// ("grep `evictOneUnlockedSocket` in pair-rate-limit.ts") is OUT OF SCOPE
// ENTIRELY — this lint never sees it. NOT because that form cannot rot: it
// can, and did — bridge.ts once attributed `AUDIO_PAUSE` to socket/client.rs
// where it greps to zero (the real definers are events.rs / fanout.rs;
// measured, IT-49, docs/decisions/2026-08-06-it49-no-gate-for-path-plus-quote-shape.md).
// The claim that DOES hold is about failure DIRECTION: when path + symbol
// rots, it fails LOUD at the moment of use (the reader greps, gets zero, and
// knows at once the citation is broken); when path:NNN rots, it fails SILENT
// (the reader lands on the wrong line and has no signal they did). Pushing
// people from the silent-failing form onto the loud-failing one is the
// migration this gate exists for. Deleting a number is always an acceptable
// way to go green here.
//
// SCOPE — and the reasons, stated so the next reader does not "helpfully" widen it
// --------------------------------------------------------------------------
// Referring (scanned) files: .ts .tsx .js .mjs .cjs .rs .dart .vue under
//   apps/ packages/ scripts/ verify/. DEFAULT_SKIP_DIRS prunes node_modules,
//   dist, build, target, .dart_tool, publish, .local.
// Referenced (target) files: the SAME extension set, enforced by the detector
//   regex itself. A cite of *.md / *.json / *.toml / .gitignore is therefore not
//   even a hit: "is symbol S near line N" is not a meaningful question in a
//   document or a data file, where the interesting anchor is a heading or a key
//   and the useful check would be a different one.
// 🔴 docs/** and CLAUDE.md are DELIBERATELY OUT OF SCOPE — as referrers.
//   Two reasons, both load-bearing:
//     1. This repo forbids mass-editing them (CLAUDE.md "never run a global regex over the document surface"):
//        decision logs and handoff reports are historical records, and a stale
//        coordinate inside a record of what was true in July is not a defect,
//        it is the record. A gate that demands they be rewritten would be
//        demanding the falsification of the archive.
//     2. Both measured failures this card came from were in CODE. Widening the
//        surface to docs would bury 2 real hits under a documentation backlog
//        nobody has agreed to pay, which is how a gate becomes noise and then
//        becomes ignored (see verify/lint/run-all.mjs on G12 going red for a
//        whole day without anyone looking).
//   This is a scoping DECISION with a stated cost, not an oversight. Anyone
//   widening it should say which of those two reasons stopped being true.
// Test files are NOT excluded: a rotten anchor in a test misleads exactly as
//   much as one in production code, and tests are where "MEASURED by X" cites
//   most often point.
//
// 🔴 A COORDINATE INTO AN EXCLUDEd TREE MUST USE THE SYMBOL-ONLY FORM
// -------------------------------------------------------------------
// `scripts/opensource-manifest.mjs`'s EXCLUDE removes whole paths from the
// public export tree (e.g. `packages/stt-cloud/`, individual `scripts/*.mjs`
// files). A `:NNN` coordinate pointing INTO one of those paths cannot resolve
// in an exported checkout no matter how carefully it is kept in sync HERE —
// the target file simply does not exist there. That makes the escape hatch
// above (drop `:NNN`, keep path + symbol) not just an option but the only
// correct form for such a citation. IT-52 (2026-08-06) found one case:
// apps/server-core/src/stt/flush-final.ts cited `soniox.ts` in the
// `packages/stt-cloud/` tree at a specific line number — green in THIS repo
// (the file is here) and a hard FAIL in the exported public tree (the file is
// not) — a coordinate whose pass/fail depends on which tree runs it is worse
// than an ordinary rotted one, because nobody in this repo ever sees it fail.
// It was rewritten to `packages/stt-cloud/src/engines/soniox.ts`'s
// `SonioxEngine.push` (no line number), which this lint cannot see at all —
// exactly the intended effect.
// 🔴 THIS LINT DOES NOT ITSELF CHECK EXCLUDE, ON PURPOSE. It deliberately does
// NOT import `scripts/opensource-manifest.mjs` to cross-check referenced
// paths against it: that manifest EXCLUDEs itself (see the EXCLUDE.push at
// its own foot) precisely because it never ships in the public tree — so a
// lint that DOES ship there and imports it would crash on arrival, not
// merely rot quietly. That exact trap already bit `CLAUDE.public.md` once
// (IT-32, see `verify/lint/version-sync.mjs`'s header). So EXCLUDE-vs-
// coordinate correctness here is enforced by the reviewer reading a diff, the
// same way this one case was found — not by machinery. No EXCLUDE-aware
// mechanism was added for this; adding one is future scope, not this round's.
//
// BASELINE
// --------
// The pre-existing multiset is pinned in ./coordinate-anchors-baseline.mjs
// (data module, imported here, never run as a lint — run-all.mjs registers
// lints by explicit import, not by directory glob). Only NEW hits fail.
// Pinned + current counts print on EVERY run, pass or fail: a silent allowlist
// is the failure mode this suite already legislated against. Every entry is a
// DEBT, not an endorsement — baselined means known-rotted, not approved.
// Entry format and the reason its separator is `#` not `:` are documented at
// the top of that file.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, walk, readText, DEFAULT_SKIP_DIRS, countLines } from './_util.mjs';
import { ALLOWLIST } from './coordinate-anchors-baseline.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/coordinate-anchors.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'coordinate-anchors';

/** ± this many lines around NNN (target side) is where an anchor must appear.
 *  Small on purpose: a wide window (or a whole-file search) would go GREEN on
 *  the very reference that motivated this lint — `CLAUDE.md` occurs seven
 *  times in version-sync.mjs, so "is the symbol somewhere in the file" cannot
 *  tell a live coordinate from a rotted one. That discrimination is pinned by
 *  a probe in scripts/coordinate-anchors-lint.test.mjs (grep `Wide-window
 *  control` there): the same claim goes red at ±3 and would pass a whole-file
 *  search. */
const ANCHOR_WINDOW = 3;

/** Referrer side: anchors are collected within ± this many NORMALIZED chars of
 *  the reference (comment leaders stripped, whitespace collapsed, newlines
 *  joined — see the REWRAP INSENSITIVITY header section). 240 was chosen to be
 *  a superset of the previous ±1-physical-line window at this repo's ~100
 *  column limit, measured: switching window shapes turned 0 previously-green
 *  references red on the tree of 2026-08-06. Re-derive, do not cite:
 *  `COORDINATE_ANCHORS_DUMP=1` prints every rotted coordinate. */
const REFERRER_SPAN = 240;

/** ± this many normalized chars around the reference form the CLAIM WINDOW
 *  whose sha256 (12 hex) is pinned in each baseline entry. Narrower than
 *  REFERRER_SPAN on purpose: the digest should invalidate when THE CLAIM
 *  changes, not when a line of code 200 chars away is edited — a baseline
 *  that churns on unrelated edits trains people to refresh it mechanically,
 *  which is how a pinned-claim scheme would quietly degrade back into a
 *  pinned-coordinate scheme. */
const CLAIM_SPAN = 80;

/** Physical lines fed to the normalizer on each side of the referring line.
 *  Only needs to cover REFERRER_SPAN chars in the worst case; 8 lines at this
 *  repo's column limit is several times that. */
const CONTEXT_LINES = 8;

const CODE_EXT = ['ts', 'tsx', 'js', 'mjs', 'cjs', 'rs', 'dart', 'vue'];
const SCAN_ROOTS = ['apps', 'packages', 'scripts', 'verify'];

const SCAN_EXT_RE = new RegExp(`\\.(?:${CODE_EXT.join('|')})$`);

// Generated build artifacts inside a scanned root, by exact path. This is the
// esbuild sidecar bundle (gitignored, rebuilt by build-sidecar.mjs): every
// comment in it is a COPY of a server-core source comment already scanned at
// its real home, so counting it would double-report coordinates and make the
// face depend on whether someone had run a build.
const GENERATED = new Set(['apps/desktop/src-tauri/resources/server.js']);

// Generated files by NAME PATTERN — the IT-60 half of the same exclusion.
// Mirrors the root .gitignore's `*.g.dart` pattern (grep `.g.dart` there):
// these exist only after Dart codegen has run, and a scan face that includes
// them measures a different tree per machine. `*.freezed.dart` is the other
// name shape Dart codegen conventionally emits; none exist in this repo today,
// and excluding the pattern now is what keeps the face identical the day one
// appears.
const GENERATED_NAME_RE = /\.(?:g|freezed)\.dart$/;

// `<dir>/<file>.ts` followed by a colon and a line number. Requires at least one
// `/` (a path, not a bare basename) and an
// in-scope extension (this is what keeps *.md / *.json / *.toml out). The
// leading lookbehind stops a longer path from being matched from its middle.
const REF_RE = new RegExp(
  `(?<![A-Za-z0-9._/-])((?:[A-Za-z0-9._@-]+/)+[A-Za-z0-9._-]+\\.(?:${CODE_EXT.join('|')})):(\\d+)`,
  'g'
);

const QUOTED_RE = /`([^`\n]{1,160})`|'([^'\n]{1,160})'|"([^"\n]{1,160})"/g;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_.:]{2,}/g;

/** A quoted token of this shape is prose, not code: one word, letters only,
 *  nothing after the first char but lowercase. (`path`, `const`, `Path` — but
 *  not `PATH`, `utf8`, `fooBar`, `Foo::bar`, `users.email`.) */
const PROSE_WORD_RE = /^[A-Za-z][a-z]{2,}$/;

/** All-lowercase QUOTED words that are nonetheless real, greppable literals in
 *  this codebase — the InjectMode/status vocabulary. `sendinput` is the
 *  measured reason this list exists (see the header): a predicate that refused
 *  every lowercase quoted word would false-reject a true citation of the line
 *  defining it. Extending this list is a deliberate act with a diff to review;
 *  prose slipping through it is not. */
const QUOTED_LITERAL_ALLOWLIST = new Set([
  'sendinput',
  'clipboard',
  'cached',
  'noted',
  'injected',
  'failed',
  'queued',
  'deferred',
  'live',
]);

/** Dotted Latin abbreviations that survive the trailing-dot strip with an
 *  interior dot intact and would otherwise pass as identifiers (header,
 *  exclusion shape 3 — found by the 2026-08-06 closeout adversarial review:
 *  `e.g.` → `e.g` was accepted as an anchor). Compared lowercase. Closed
 *  list on purpose: extending it is a reviewable diff. */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'a.k.a', 'n.b', 'p.s', 'w.r.t', 'q.e.d', 'et.al', 'i.i.d',
]);

/** Comment leaders stripped at line start before windows are measured, so that
 *  moving a newline through a comment does not move words in or out of any
 *  window. Covers line comments (`//`, `///`, `//!`), block-comment interiors
 *  and edges (`*`, `*/`, `/*`, `/**`), `#`, and HTML/Vue comment brackets. */
const LINE_LEADER_RE = /^\s*(?:\/\*+!?|!?\*+\/?|\/{2,}!?|#+|<!--|-->)\s?/;

function skipDir(basename) {
  return DEFAULT_SKIP_DIRS.has(basename);
}

function relTo(rootAbs, abs) {
  return path.relative(rootAbs, abs).split(path.sep).join('/');
}

/** Normalize a chunk of one physical line: strip a comment leader, collapse
 *  whitespace, drop leading space. Used for both whole lines and the prefix
 *  before a reference, so positions computed from prefixes stay consistent
 *  (which is why it does not trimEnd — callers do that for whole lines only).
 *  This answers ONE question — "which words are here" — and stripping the
 *  leader is right for it on both sides: `//` is the container a claim or a
 *  statement travels in, not part of the words. What the leader IS load-bearing
 *  for is a SECOND question, asked only on the target side; see leaderOf. */
function normalizeChunk(s) {
  return s.replace(LINE_LEADER_RE, '').replace(/\s+/g, ' ').trimStart();
}

/** The target window's SECOND question (IT-65): "is this line commented out,
 *  and what leading punctuation does it carry" — `''` when the line has no
 *  leader. The indent before it and the space after it are trimmed off, so
 *  re-indentation and `//x` vs `// x` cannot move it; the leader token itself
 *  survives, because on the TARGET side a
 *  leading `//` or `*` is meaning: `// export function f()` is a DELETED
 *  function and `*count` is a deref. Asked per line and kept as a positional
 *  vector rather than mixed into the words, which is the whole trick — see the
 *  target-digest section of the header for why mixing them cannot work. */
function leaderOf(s) {
  const m = LINE_LEADER_RE.exec(s);
  return m ? m[0].trim() : '';
}

/** 12 hex of sha256 — the pin's unit on both sides. */
function digest12(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/** Sentinels used in place of a target digest when there is no cited window to
 *  hash. Spelled out rather than hashed so a baseline reader can see at a
 *  glance WHY an entry has no target half. */
const TARGET_MISSING = 'nofile';
const TARGET_PAST_EOF = 'pasteof';

/** The TARGET half of the pin (IT-64, made sound by IT-65): the same
 *  ±ANCHOR_WINDOW lines the anchor predicate reads, hashed as TWO components.
 *
 *    leader vector — one leaderOf() per line, positional, joined on `|`.
 *    words        — the same lines through normalizeChunk, empties dropped,
 *                   joined on single spaces.
 *
 *  Both are needed and neither can be folded into the other. Measured, IT-65:
 *  hashing only the words makes commenting OUT the cited line invisible (that
 *  is the defect this card closes); concatenating the leader INTO each line's
 *  words instead makes the digest position-sensitive, so re-wrapping a comment
 *  inside the window moves it — measured at 28 of 48 pinned entries flipping on
 *  a repo-wide comment reflow, against 7 for genuine content movement. Split
 *  into a vector, a constant-line-count rewrap changes neither component: the
 *  words are the same words, and every line is still exactly as commented as it
 *  was. Empties are dropped from the words half so that a rewrap leaving its
 *  donor line holding only a leader stays invariant too — the join would
 *  otherwise emit a double space, which is what made IT-64's header claim about
 *  that case false. See "…AND IT PINS THE TARGET REGION TOO" in the header. */
function targetWindowText(targetLines, n) {
  const wlo = Math.max(0, n - 1 - ANCHOR_WINDOW);
  const whi = Math.min(targetLines.length, n + ANCHOR_WINDOW);
  const win = targetLines.slice(wlo, whi);
  const words = win
    .map((l) => normalizeChunk(l).trimEnd())
    .filter((l) => l.length > 0)
    .join(' ');
  return win.map(leaderOf).join('|') + '\n' + words;
}

/** Anchor tokens in a normalized claim/anchor window (reference texts already
 *  blanked by the caller). See "THE ANCHOR PREDICATE" in the header for what
 *  is excluded and what is not. */
function anchorsOf(text) {
  const out = new Set();
  QUOTED_RE.lastIndex = 0;
  let m;
  while ((m = QUOTED_RE.exec(text))) {
    const inner = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (inner.length < 3) continue;
    if (PROSE_WORD_RE.test(inner) && !QUOTED_LITERAL_ALLOWLIST.has(inner)) continue;
    if (ABBREVIATIONS.has(inner.replace(/[.:]+$/, '').toLowerCase())) continue;
    out.add(inner);
  }
  IDENT_RE.lastIndex = 0;
  while ((m = IDENT_RE.exec(text))) {
    // Trailing `.`/`:` is sentence punctuation, not an identifier signal.
    const tok = m[0].replace(/[.:]+$/, '');
    if (tok.length < 3) continue;
    if (!(tok.includes('_') || tok.includes('::') || tok.includes('.') || /[a-z0-9][A-Z]/.test(tok)))
      continue;
    if (ABBREVIATIONS.has(tok.toLowerCase())) continue;
    out.add(tok);
  }
  return [...out];
}

/** Candidate absolute paths for a reference, most specific resolution first.
 *
 *  Three shapes are all in live use in this repo and all are legitimate
 *  (examples written WITHOUT their line numbers so this comment is not itself a
 *  hit — which is also the point being made: dropping the number costs nothing):
 *    1. repo-root-relative       `apps/server-core/src/db/schema.ts`
 *    2. relative to some ancestor of the referrer
 *                                `src-tauri/src/sidecar/node_runtime.rs`
 *    3. a bare tail of the path  `db/schema.ts` (as cited from apps/desktop)
 *  Shape 3 is resolved by unique suffix match over the scanned tree. If the tail
 *  is AMBIGUOUS the reference is not resolved here and reports as unresolvable —
 *  which is the honest answer: a coordinate the reader cannot follow to exactly
 *  one file is not a usable coordinate either. */
function candidatePaths(rootAbs, refPath, referrerAbs, suffixIndex) {
  const cands = [path.join(rootAbs, refPath)];
  let dir = path.dirname(referrerAbs);
  const rootResolved = path.resolve(rootAbs);
  for (;;) {
    cands.push(path.join(dir, refPath));
    if (path.resolve(dir) === rootResolved) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const tails = suffixIndex.get(path.basename(refPath));
  if (tails) {
    const matches = tails.filter((r) => r === refPath || r.endsWith('/' + refPath));
    if (matches.length === 1) cands.push(path.join(rootAbs, matches[0]));
  }
  return cands;
}

function multiset(keys) {
  const m = new Map();
  for (const k of keys) m.set(k, (m.get(k) || 0) + 1);
  return m;
}

/** Multiset difference: hits whose pinKey occurs more times than the baseline
 *  allows. Exported for the fixture tests. */
export function findNew(hits, baselineKeys) {
  const base = multiset(baselineKeys);
  const used = new Map();
  const neu = [];
  for (const h of hits) {
    const n = (used.get(h.pinKey) || 0) + 1;
    used.set(h.pinKey, n);
    if (n > (base.get(h.pinKey) || 0)) neu.push(h);
  }
  return neu;
}

/** Scan one tree (SCAN_ROOTS under rootAbs). Returns every reference found and
 *  every failing hit. Exported so the fixture tests can drive the REAL scan
 *  against a disposable tree instead of probing the live repo. */
export async function scanTree(rootAbs) {
  /** target abs -> { lines, total } | null (missing/unreadable). Cached: the
   *  same target is cited many times and re-reading it per citation is the only
   *  way this lint could blow the suite's <5s budget. */
  const targetCache = new Map();
  async function targetOf(abs) {
    if (targetCache.has(abs)) return targetCache.get(abs);
    const text = await readText(abs);
    const val = text == null ? null : { lines: text.split(/\r?\n/), total: countLines(text) };
    targetCache.set(abs, val);
    return val;
  }

  /** @type {{pinKey:string, key:string, digest:string, targetDigest:string, file:string, line:number, ref:string, why:string}[]} */
  const hits = [];
  /** @type {string[]} every reference's coordinate key (green and red alike) */
  const keys = [];

  // Pass 1 — enumerate the code tree once, and index by basename so a bare-tail
  // reference (`db/schema.ts` plus a line number) can be resolved by UNIQUE
  // suffix match.
  /** @type {string[]} */
  const files = [];
  let generatedExcluded = 0;
  for (const root of SCAN_ROOTS) {
    for (const abs of await walk(path.join(rootAbs, root), { skipDir })) {
      if (!SCAN_EXT_RE.test(abs)) continue;
      const r = relTo(rootAbs, abs);
      if (GENERATED.has(r) || GENERATED_NAME_RE.test(r)) {
        generatedExcluded++;
        continue;
      }
      files.push(abs);
    }
  }
  /** @type {Map<string,string[]>} basename -> rel paths */
  const suffixIndex = new Map();
  for (const abs of files) {
    const r = relTo(rootAbs, abs);
    const b = path.basename(r);
    const arr = suffixIndex.get(b);
    if (arr) arr.push(r);
    else suffixIndex.set(b, [r]);
  }
  const fileCount = files.length;

  // Pass 2 — the actual check.
  for (const abs of files) {
    const r = relTo(rootAbs, abs);
    const text = await readText(abs);
    if (text == null) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(':')) continue;
      REF_RE.lastIndex = 0;
      const refs = [];
      let m;
      while ((m = REF_RE.exec(line)))
        refs.push({ text: m[0], p: m[1], n: Number(m[2]), idx: m.index });
      if (refs.length === 0) continue;

      // Normalized context: CONTEXT_LINES physical lines each side, comment
      // leaders stripped, whitespace collapsed, joined on single spaces. The
      // position of each reference inside this string is invariant under
      // re-wrapping (see header).
      const lo = Math.max(0, i - CONTEXT_LINES);
      const hi = Math.min(lines.length, i + 1 + CONTEXT_LINES);
      const norm = [];
      for (let j = lo; j < hi; j++) norm.push(normalizeChunk(lines[j]).trimEnd());
      const joined = norm.join(' ');
      let lineStart = 0;
      for (let j = 0; j < i - lo; j++) lineStart += norm[j].length + 1;
      const blank = (s) => {
        let out = s;
        for (const x of refs) out = out.split(x.text).join(' ');
        return out;
      };

      for (const ref of refs) {
        const at = lineStart + normalizeChunk(line.slice(0, ref.idx)).length;
        const anchorWin = blank(
          joined.slice(Math.max(0, at - REFERRER_SPAN), at + ref.text.length + REFERRER_SPAN)
        );
        const claimWin = blank(
          joined.slice(Math.max(0, at - CLAIM_SPAN), at + ref.text.length + CLAIM_SPAN)
        );
        const digest = digest12(claimWin);
        // `#` not `:` — see the note at the top of coordinate-anchors-baseline.mjs.
        const key = `${r}|${ref.p}#${ref.n}`;
        keys.push(key);

        // The target must be resolved BEFORE the pin exists: half of the pin is
        // a digest of the target's cited window (IT-64).
        let tgt = null;
        for (const cand of candidatePaths(rootAbs, ref.p, abs, suffixIndex)) {
          const t = await targetOf(cand);
          if (t !== null) {
            tgt = t;
            break;
          }
        }
        const pastEof = tgt !== null && (ref.n < 1 || ref.n > tgt.total);
        const targetDigest =
          tgt === null
            ? TARGET_MISSING
            : pastEof
              ? TARGET_PAST_EOF
              : digest12(targetWindowText(tgt.lines, ref.n));

        const pinKey = `${key}|${digest}|${targetDigest}`;
        const hit = (why) =>
          hits.push({ pinKey, key, digest, targetDigest, file: r, line: i + 1, ref: ref.text, why });

        if (tgt === null) {
          hit('target file not found');
          continue;
        }
        if (pastEof) {
          hit(`line ${ref.n} past EOF (${tgt.total} lines)`);
          continue;
        }
        const anchors = anchorsOf(anchorWin);
        if (anchors.length === 0) {
          hit(`no anchor token within ±${REFERRER_SPAN} chars of the reference`);
          continue;
        }
        const wlo = Math.max(0, ref.n - 1 - ANCHOR_WINDOW);
        const whi = Math.min(tgt.lines.length, ref.n + ANCHOR_WINDOW);
        const window = tgt.lines.slice(wlo, whi).join('\n');
        if (!anchors.some((a) => window.includes(a))) {
          hit(`no anchor within ±${ANCHOR_WINDOW} lines (tried: ${anchors.slice(0, 4).join(', ')})`);
        }
      }
    }
  }

  return { hits, keys, fileCount, generatedExcluded };
}

export default async function run() {
  const { hits, keys, fileCount, generatedExcluded } = await scanTree(ROOT);

  // Regenerating / auditing the baseline: `COORDINATE_ANCHORS_DUMP=1 node …`
  // prints every rotted coordinate in baseline-entry form to stderr. The
  // location suffix is written as `@ <file> line N` ON PURPOSE, and any
  // coordinate-shaped token inside the reason (the `tried:` list quotes
  // referring text verbatim) has its `:` rewritten to `#` — the baseline
  // module is itself a scanned file, so a pasted comment must never contain a
  // live `path:NNN` coordinate, or the lint would flag its own baseline.
  // Measured, not hypothetical: the first regeneration WITH reasons pasted
  // four live coordinates in via `tried:` lists, and the lint flagged its own
  // baseline file until they were de-fanged.
  if (process.env.COORDINATE_ANCHORS_DUMP) {
    const defang = (s) => s.replace(new RegExp(REF_RE.source, 'g'), '$1#$2');
    for (const h of hits)
      process.stderr.write(`  '${h.pinKey}', // ${defang(h.why)} @ ${h.file} line ${h.line}\n`);
  }

  const neu = findNew(hits, ALLOWLIST);
  const counts =
    `baseline ${ALLOWLIST.length} pinned, current ${hits.length} rotted of ${keys.length} refs; ` +
    `face ${fileCount} files (${generatedExcluded} generated excluded); ` +
    `target ±${ANCHOR_WINDOW} lines, referrer ±${REFERRER_SPAN} chars`;

  if (neu.length > 0) {
    const sample = neu
      .slice(0, 8)
      .map((h) => `${h.file}:${h.line} -> ${h.ref} (${h.why})`)
      .join('; ');
    return {
      status: 'FAIL',
      detail: `${neu.length} new (${counts}; see coordinate-anchors-baseline.mjs): ${sample}`,
    };
  }
  return { status: 'PASS', detail: `0 new (${counts}; see coordinate-anchors-baseline.mjs)` };
}
