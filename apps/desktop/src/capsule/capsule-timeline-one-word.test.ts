// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0 (two-segment terminology table)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5c (PC-side same source)
//   docs/decisions/2026-08-02-delivery-vs-injection-terminology-contract.md
//
// 🔴 卡 L7 — ONE WORD FOR ONE STATE, ON THIS END, IN ALL FOUR LOCALES.
//
// The defect this file exists to make impossible (owner 2026-08-02, real device):
// the timeline said "not injected · cached" and the capsule said "not delivered" for the SAME
// `inject:result{mode:'cached'}` — on the same machine, in the same product. The
// second one was also the WRONG SEGMENT: a frame the capsule can see has already
// reached this PC, so calling it "not delivered" reported a successful delivery as a
// failed one (docs/rebuild/15 §2.0, rule 1).
//
// ⚠️ WHY THIS ASSERTS `===` AND NOT "both say 'not injected · cached'". Two catalogues
// spelling the same characters is exactly the state the product was already in
// once (both said "not delivered" in 0.2.1) and it drifted anyway. The machine-checkable
// property is SAME SOURCE, and `toBe` on the resolved value is the closest a test
// can get to it without reading the AST — so the grep for `TIMELINE_STRINGS` in
// capsule.ts below is the other half, and the two together say "a reference, not a copy".

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CAPSULE_STRINGS, INJECT_FAIL_REASON_CATALOGUES } from '../lib/strings/capsule';
import { TIMELINE_STRINGS } from '../lib/strings/timeline';
import { UI_LOCALES, type UiLocale } from '../lib/strings/locale';

// 🔴 DERIVED, NOT LISTED (2026-08-14). This was `['zh-CN', 'en', 'ja', 'ko']`,
// and a fifth language would have been guarded by nothing while every assertion
// below stayed green — the shape "the set a gate covers ≠ the set it claims to protect" this file
// already warns about one level down. The registry is the list.
const LOCALES: readonly UiLocale[] = UI_LOCALES;

/** The leaf contract — the file that now DECLARES the same-source pairs. */
const leaves = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../i18n/desktop/leaves.json', import.meta.url)), 'utf8'),
).leaves as { key: string; sameAs?: string }[];

const localeData = (code: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../../i18n/desktop/${code}.json`, import.meta.url)), 'utf8'),
  ).strings;

// 🔴 IJ-02 §C-3 — THE PAIRS THIS GUARD COVERS, and why the list grew from one to four.
//
// Until 2026-08-07 only `cached` was really same-sourced. The other capsule faces were
// STANDALONE LITERALS, and the two failure modes of that were both live in production
// at the same time:
//   · `cap_injected` was '已注入' and `st_injected` was '已注入' — coincidentally equal (碰巧相等). Nothing was
//     wrong on screen, and nothing would have been until someone changed one of them;
//   · `cap_inject_failed` was '未成功' while `st_failed` was '注入失败' — 🔴 ALREADY
//     DIVERGED. Two PC surfaces, one event, two different words: book 15 §2.5c was being
//     violated the whole time and every test was green.
// ⚠️ The second one is NOT in the design document. It was found by reading the two
// catalogues side by side while implementing the first.
//
// `st_delivered` (甲-3's weak word) is here from birth for the same reason.
const SAME_SOURCE_PAIRS = [
  ['cap_injected', 'st_injected'],
  ['cap_delivered', 'st_delivered'],
  ['cap_cached', 'st_cached'],
  ['cap_inject_failed', 'st_failed'],
] as const;

describe('卡 L7 / IJ-02 §C-3 — the capsule and the timeline say ONE word per state', () => {
  it('every capsule face equals its timeline word in every locale', () => {
    for (const loc of LOCALES) {
      for (const [cap, st] of SAME_SOURCE_PAIRS) {
        expect(CAPSULE_STRINGS[loc][cap], `${loc} ${cap} vs ${st}`).toBe(
          TIMELINE_STRINGS[loc][st],
        );
      }
    }
  });

  // 🔴 anti-façade ④ + THE HALF THAT ACTUALLY CATCHES THE REGRESSION. The assertion
  // above is a VALUE comparison, and the defect this file guards against passes it:
  // paste a literal that happens to equal the timeline's word today and `toBe` stays
  // green — that is precisely the state `cap_injected` was in for a whole version.
  // The machine-checkable property is SAME SOURCE, so it is asserted on the SOURCE.
  // (Reverse control, measured: replacing one reference with its own current literal
  // leaves the test above green and turns THIS one red.)
  //
  // 🔴 THE SOURCE MOVED (2026-08-14, the nine-language migration), so this half
  // moved with it. It used to grep capsule.ts for
  // `cap_injected: TIMELINE_STRINGS['zh-CN'].st_injected` — four hand-written
  // references, one per language. There are no such lines any more: the pairing is
  // DECLARED ONCE in the leaf contract (`sameAs`) and the generator resolves it per
  // language. The property being asserted is unchanged and the guard is stronger in
  // exactly the direction that mattered: with nine languages the old form was nine
  // chances to paste a literal, and now there is nowhere to paste one — a value in
  // ANY locale file for these keys is refused by gen-desktop-ts.mjs and named here.
  it('the same-source pairs are DECLARED once, and no language re-spells them', () => {
    for (const [cap, st] of SAME_SOURCE_PAIRS) {
      const leaf = leaves.find((l) => l.key === cap);
      expect(leaf?.sameAs, `${cap} must be declared sameAs ${st} in i18n/desktop/leaves.json`).toBe(st);
    }
    for (const loc of LOCALES) {
      const strings = localeData(loc);
      for (const [cap, st] of SAME_SOURCE_PAIRS) {
        expect(
          strings[cap],
          `${loc}.json spells out ${cap} — it IS ${st}, and a copy is how the two drifted before`,
        ).toBeUndefined();
      }
    }
  });

  // 🔴 §2.0 rule 1 — a segment-① word may never appear on a segment-② face. The
  // capsule window RUNS ON THE PC: everything it renders is about injection (注入).
  const BANNED_SEGMENT_1_WORDS = [
    '未投递', '投递中', '待投递',            // zh
    'not delivered', 'delivering', 'pending delivery', // en
    '未送信', '送信中',                        // ja
    '미전송', '전송 중',                       // ko
  ];

  // 🔴 IJ-02-b — EVERY STRING THAT CAN LAND ON A CAPSULE CARD, defined once.
  //
  // The scope defect this replaces: the guard listed the five status words and stopped
  // there, while the ✗ and 📥 cards ALSO draw a reason line and a cached-cause line, both
  // of which come from `INJECT_FAIL_REASON` (controller.ts: `INJECT_FAIL_REASON[code] ??
  // S.cap_reason_unknown`, and `cachedCause` from the same table). A segment-① word
  // written into any of those sentences rendered on a segment-② card and the whole suite
  // stayed green — book seven §1-bis-13: the set a gate covers ≠ the set it claims to protect, and the more
  // reliably such a gate is green the more it vouches for a surface it never looks at.
  //
  // ⚠️ The set is built HERE, in one function, rather than being listed inside the `it`.
  // The failure this file guards is a word appearing on a surface nobody enumerated, so
  // a second enumeration is the same defect one level up. `INJECT_FAIL_REASON_CATALOGUES`
  // is the table itself — codes added later are covered without editing this file, which
  // is the property the five hand-listed faces do not have.
  function capsuleSurfaces(loc: UiLocale): { label: string; text: string }[] {
    const c = CAPSULE_STRINGS[loc];
    // Annotated, not inferred: CAPSULE_STRINGS is `as const`, so an inferred literal
    // element type would reject the `string` values coming from the reason catalogue —
    // and the reason catalogue is the half this function was widened to cover.
    const out: { label: string; text: string }[] = [
      { label: 'cap_injected', text: c.cap_injected },
      // 甲-3's weak word is the likeliest place for a segment-① word to sneak back
      // in: the natural English for 已送入 (delivered) is "Delivered" and the natural ja is
      // "送信済み" (delivered), and BOTH are segment-① words. This is the assertion that says no.
      { label: 'cap_delivered', text: c.cap_delivered },
      { label: 'cap_delivering', text: c.cap_delivering },
      { label: 'cap_cached', text: c.cap_cached },
      { label: 'cap_inject_failed', text: c.cap_inject_failed },
      // The fallback sentence for an unmapped code — it renders on the very same
      // reason line, so leaving it out would reopen the hole for exactly the codes
      // nobody wrote a sentence for.
      { label: 'cap_reason_unknown', text: c.cap_reason_unknown },
    ];
    for (const [code, text] of Object.entries(INJECT_FAIL_REASON_CATALOGUES[loc])) {
      out.push({ label: `INJECT_FAIL_REASON.${code}`, text });
    }
    return out;
  }

  it('no capsule surface says a delivery word, in any locale — reason lines included', () => {
    // Measure the ruler (§1-bis-5): a loop over an empty set passes silently, and this
    // guard's whole value is the size of the set it walks. 4 locales × (6 faces + the
    // reason table) — assert it actually grew past the six hand-listed faces.
    for (const loc of LOCALES) {
      const surfaces = capsuleSurfaces(loc);
      expect(surfaces.length, `${loc}: reason catalogue contributed nothing`).toBeGreaterThan(6);
      for (const { label, text } of surfaces) {
        for (const ban of BANNED_SEGMENT_1_WORDS) {
          expect(
            text.toLowerCase().includes(ban.toLowerCase()),
            `${loc} ${label}: 「${text}」 must not contain the segment-① word 「${ban}」`,
          ).toBe(false);
        }
      }
    }
  });

  // ⏳ and 📥 must stay two different words — that distinction predates this card
  // (RV-43) and renaming one of them must not collapse it.
  it('the waiting face and the settled face are still two different words', () => {
    for (const loc of LOCALES) {
      expect(CAPSULE_STRINGS[loc].cap_delivering, loc).not.toBe(
        CAPSULE_STRINGS[loc].cap_cached,
      );
    }
  });
});
