// verify/lint/changelog-release-sections-baseline.mjs
// Baseline DATA for verify/lint/changelog-release-sections.mjs — nothing else
// imports this, and run-all.mjs never runs it (lints are registered there by
// explicit import, not by a directory glob). Same shape as
// verify/lint/coordinate-anchors-baseline.mjs.
//
// 🔴🔴 THIS IS NOT A DEBT REGISTER. The other two baselines in this directory
// list things that are WRONG and may not get worse. This one lists things that
// are RIGHT and may not change: one entry per released version, fingerprinting
// the CHANGELOG.md section that version actually shipped with. An entry is a
// statement that this text is history.
//
// ENTRY FORMAT — `<version>|<sha256-12 of the section>|<line count>`:
//   · the section is its `## ` heading line through the line before the next
//     `## `, trailing whitespace stripped per line, trailing blank lines
//     dropped. The heading line is inside the digest, so re-spelling
//     `## 0.3.9` as `## 0.3.9（含 …）` is an edit like any other.
//   · the line count is redundant with the digest ON PURPOSE and is CHECKED,
//     so it cannot rot into decoration. It exists to make the failure legible:
//     "pinned 22 lines, now 24" says entries were folded in; the same count on
//     both sides says words were changed in place.
//   · malformed or duplicated entries FAIL rather than being skipped. A pin
//     that quietly does not parse is a slot, and a slot absorbs the edit it
//     was supposed to catch.
//
// SEEDED 2026-08-19 from the tree as it stood — 42 released versions, every one
// with a section, sha256 of CHANGELOG.md d227af5637eb…. ⚠️ The seed certifies
// only that this is what the file said that day; it cannot certify that what
// the file said was already correct. One thing IS known to be wrong inside a
// pinned section and is pinned anyway: the HTML comment above the restored
// `## 0.3.7` heading blames `bump-version.mjs` for renaming headings, and that
// script has never touched CHANGELOG.md (`grep -i changelog
// scripts/bump-version.mjs` = 0 hits). Fixing it is a deliberate edit followed
// by a deliberate re-pin — which is exactly the ceremony this file exists to
// impose, so the wrong sentence is left pinned rather than quietly corrected
// while seeding.
//
// REGENERATE with `CHANGELOG_PIN_DUMP=1 pnpm verify:lint` (paste-ready lines to
// stderr) and paste them over the array below. Hand-editing an entry is how a
// baseline silently stops describing reality. There is no --fix flag: re-pinning
// has to appear in a diff that someone reads, because the whole failure this
// gate exists for looked like housekeeping at the time.
//
// A VERSION WITH NO ENTRY IS A FAILURE, NOT A GAP. Every `chore(release)` commit
// puts its version in scope the moment it lands; the run right after a release
// is red until the pin is added. That is the intended cost, and it is stated in
// the lint's header under "RELEASED vs IN PROGRESS".

export const SHIPPED_SECTIONS = [
  '0.1.5|274c3256fb14|16',
  '0.1.7|e5b738b7ba57|15',
  '0.1.8|e0602c665337|17',
  '0.1.9|fbcb619c68ef|16',
  '0.1.10|725020c0c4ab|16',
  '0.1.11|7011d09663fa|12',
  '0.2.0|0a65366d4d27|40',
  '0.2.1|ab0eeca4d638|47',
  '0.2.2|1264d2390b07|20',
  '0.2.4|adb2606d63a5|32',
  '0.2.5|9c29df9b8509|23',
  '0.2.6|100574c8542d|31',
  '0.2.7|b9f82a10c02d|16',
  '0.2.8|842e740b8796|21',
  '0.2.9|2c99f6b36654|17',
  '0.2.10|b7b13d07bc83|16',
  '0.2.11|3fd6cee73a13|26',
  '0.2.47|24657a12aa5b|55',
  '0.2.48|4dfe5c5bfb7b|63',
  '0.2.49|a0217a29e777|58',
  '0.2.50|04576a80442f|26',
  '0.2.54|ef23a5aafec9|37',
  '0.2.55|d67f5dfbac0c|27',
  '0.2.56|8e92b12f59fa|55',
  '0.2.57|38cfb4807d95|36',
  '0.2.58|b22dc4188810|29',
  '0.2.59|1e03770507d5|17',
  '0.2.60|1e6c3c615304|149',
  '0.2.62|4e982bb11728|40',
  '0.2.63|758070d1cb24|43',
  '0.2.64|ca1ee49221f9|28',
  '0.2.65|d9c669c517db|29',
  '0.3.0|75a50af86cc6|28',
  '0.3.1|5f13bb3eca47|52',
  '0.3.2|9a2c7f17b208|29',
  '0.3.3|65bc3d91dc8c|30',
  '0.3.4|e63f416792b5|33',
  '0.3.5|cf501994f8cb|32',
  '0.3.6|6115410835c8|65',
  '0.3.7|979ea471a917|44',
  '0.3.8|918e8f768b71|93',
  '0.3.10|1fc0eb0a5f03|50',
  '0.3.11|d405a3f20f9d|33',
  '0.3.12|646a0a6a5764|24',
  '0.3.13|ea37118550ad|9',
  '0.3.14|e90b3e7ed171|10',
  '0.3.15|ef9efb467887|5',
  '0.3.16|a9eaf0dc49d9|11',
  '0.3.17|7cd5dfaca828|7',
  '0.3.18|bc08b2708cd0|10',
  '0.3.19|a22c911237cb|10',
  // 0.3.20 re-pinned 2026-08-21 evening: the section was EXTENDED (brand 2.0
  // icon redesign bullets) after its chore(release) commit but BEFORE the
  // version's first publication anywhere — 0.3.20 had not reached the download
  // center yet, so no published copy is being rewritten. Same-commit re-pin,
  // per this gate's own rule.
  '0.3.20|cd7549fb4a6b|46',
  '0.3.21|759a83df631e|21',
  '0.3.22|3ce34deba73f|17',
  '0.3.23|689b1ec2d21a|23',
  // 0.3.26 carries 0.3.24 and 0.3.25 as well: both were written and gated, and
  // neither was ever built, so neither number became a release and neither gets
  // a pin. Their sections stay in the file — they describe things that reach a
  // user for the first time in this build.
  '0.3.26|1b0651fa1720|51',
  // 0.3.26 reached the LAN download center and stopped there — the taskbar-icon
  // defect was found before it went out. 0.3.27 is the same payload plus that
  // fix, and it carries 0.3.24/0.3.25/0.3.26 outward for the first time.
  // Re-pinned 2026-08-22 (40→77 lines): the 0.3.27 release POINT was marked on
  // 08-22 morning but its artifacts were never built (the window closed on a
  // broken `run()` cfg — see d2572723); LM-CAT (the per-language model catalog)
  // landed the same day and ships in the FIRST 0.3.27 bytes, so its user-facing
  // entries belong in this section. This is a before-first-artifact extension,
  // not an edit of published history — no 0.3.27 bytes exist anywhere.
  // Re-pinned 2026-08-23 (71→73 lines): owner ruled console-related info must
  // not appear in the open-source repo — the 0.3.25 console bullet and the
  // paid-plans quote line came OUT of the public lead (an internal-ledger note
  // records the removal). This edits published copy on purpose, by owner order;
  // the GitHub release body and public-repo CHANGELOG are updated in the same
  // round so all outward copies say the same thing.
  '0.3.27|78794b3328ae|73',
  '0.3.9|0a6d6f8fb40d|26',
];
