// scripts/i18n/derive-keys.mjs
//
// Give every `_t(...)` call site a STABLE, UNIQUE Dart identifier, so the
// catalogue can move from "four literals at the call site" to "one abstract
// member per string, implemented once per locale" (architecture doc §4.1).
//
// 🔴 WHY THE KEY IS THE MEMBER NAME AND NOT A HASH OR AN INDEX.
// The key becomes a Dart member name that a translator sees next to the text and
// that a reviewer greps for when a sentence looks wrong on a real phone. A hash
// (`_lf7f3a91`) would be stable and useless; a positional index would be neither
// (inserting a string above it renumbers everything below, so every future diff
// would look like the whole catalogue changed). The member name is what the
// product already calls this string, it is already unique per mixin, and it is
// the thing a human can act on.
//
// The only complication is the 155 members that call `_t` more than once — a
// `switch` whose arms each produce a different sentence (686 calls vs 531
// members). Those get `<member>__<n>` and the enclosing logic stays hand-written:
// the SWITCH is language-independent, only its leaves are translated.

import { extractAll, ROOT } from './extract-mobile-strings.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Find the member a call site sits inside, by scanning backwards for the
 *  nearest declaration header. Deliberately a scan and not a Dart parse: the
 *  catalogue's shape is uniform (`String get x =>`, `String x(...)`,
 *  `String get x { … }`) and a wrong answer is caught downstream by the
 *  uniqueness check plus the byte-identity verifier, so a parser would be cost
 *  without extra safety. */
//
// Three details the first cut got wrong, each caught by the validator below
// rather than by reading — recorded so the next person does not re-derive them:
//   · `String?` (nullable return) must be matched, or the 14 call sites inside
//     `injectVerdictNote` / `deliveryRefusalNote` end up with no owner at all;
//   · the declaration must sit at CLASS-MEMBER indentation. Without that, a
//     local `final String head = …` inside a method is mistaken for the member,
//     and since several methods each declare a local called `head`, the keys
//     collide across members (`head__1..5`) — a collision that would have
//     silently merged five unrelated strings into one;
//   · inside a `switch`, the arm's `case` label is a far better key than an
//     ordinal: `injectVerdictNote_INJECT_FOCUS_LOST` tells a translator and a
//     reviewer which refusal they are looking at, while `injectVerdictNote__3`
//     tells them nothing and silently renumbers when an arm is inserted above.
const DECL = /^ {2}(?:@override\s+)?String\??\s+(?:get\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[({=]/gm;
const CASE = /case\s+'([^']+)'\s*:/g;

function memberIndex(src) {
  const decls = [];
  let m;
  DECL.lastIndex = 0;
  while ((m = DECL.exec(src)) !== null) {
    if (m[1] === '_t') continue; // the signature, not a member that owns strings
    decls.push({ name: m[1], at: m.index });
  }
  return decls;
}

/** The `case '<label>':` immediately preceding `offset`, if it is inside the
 *  same member (i.e. after the member's own declaration). */
function caseLabelAt(src, memberAt, offset) {
  let label = null;
  CASE.lastIndex = memberAt < 0 ? 0 : memberAt;
  let m;
  while ((m = CASE.exec(src)) !== null) {
    if (m.index >= offset) break;
    label = m[1];
  }
  return label;
}

/** A case label such as `INJECT_FOCUS_LOST` or `terms_violation` is already a
 *  fine identifier fragment; anything else is folded to one. */
function idFragment(s) {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

function ownerOf(decls, offset) {
  let best = null;
  for (const d of decls) {
    if (d.at < offset) best = d;
    else break;
  }
  return best?.name ?? null;
}

export function deriveKeys() {
  const { entries, problems } = extractAll();
  const byFile = new Map();
  for (const e of entries) {
    if (!byFile.has(e.file)) {
      byFile.set(e.file, memberIndex(readFileSync(path.join(ROOT, e.file), 'utf8')));
    }
  }
  // Group by owning member so a member with several calls can be numbered.
  const srcCache = new Map();
  const perMember = new Map();
  for (const e of entries) {
    const decls = byFile.get(e.file);
    e.member = ownerOf(decls, e.callStart);
    if (!srcCache.has(e.file)) srcCache.set(e.file, readFileSync(path.join(ROOT, e.file), 'utf8'));
    const memberAt = decls.filter((d) => d.at < e.callStart).pop()?.at ?? -1;
    e.caseLabel = caseLabelAt(srcCache.get(e.file), memberAt, e.callStart);
    const k = `${e.file}::${e.member}`;
    if (!perMember.has(k)) perMember.set(k, []);
    perMember.get(k).push(e);
  }
  for (const [, group] of perMember) {
    group.sort((a, b) => a.callStart - b.callStart);
    const labels = group.map((e) => e.caseLabel);
    const labelsUsable =
      group.length > 1 &&
      labels.every((l) => l) &&
      new Set(labels).size === labels.length;
    group.forEach((e, i) => {
      e.multi = group.length > 1;
      if (!e.multi) e.key = e.member;
      else if (labelsUsable) e.key = `${e.member}_${idFragment(e.caseLabel)}`;
      // Fall back to an ordinal only when the arms are NOT distinctly labelled
      // (an if/else chain, or a switch where two arms share a label). Recorded
      // per entry so a later reader can tell a meaningful key from a positional
      // one instead of assuming all of them are meaningful.
      else e.key = `${e.member}__${i + 1}`;
      e.keyFromLabel = e.multi && labelsUsable;
    });
  }
  return { entries, problems };
}

function main() {
  const { entries } = deriveKeys();
  const noOwner = entries.filter((e) => !e.member);
  const keys = entries.map((e) => e.key);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  const multi = entries.filter((e) => e.multi);
  console.log(`call sites      : ${entries.length}`);
  console.log(`distinct members: ${new Set(entries.map((e) => e.member)).size}`);
  console.log(`multi-call sites: ${multi.length} (in members with a switch/if)`);
  console.log(`  keyed by case  : ${entries.filter((e) => e.keyFromLabel).length}`);
  console.log(`  keyed by index : ${multi.length - entries.filter((e) => e.keyFromLabel).length}`);
  console.log(`without an owner: ${noOwner.length}`);
  for (const e of noOwner.slice(0, 10)) console.log(`  ! ${e.file}:${e.line}`);
  console.log(`duplicate keys  : ${new Set(dupes).size}`);
  for (const d of [...new Set(dupes)].slice(0, 10)) console.log(`  ! ${d}`);
  const bad = entries.filter((e) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key));
  console.log(`invalid dart ids: ${bad.length}`);
  for (const e of bad.slice(0, 5)) console.log(`  ! ${e.key}`);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('derive-keys.mjs')) main();
