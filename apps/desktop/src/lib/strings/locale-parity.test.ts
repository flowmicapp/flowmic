// V2-07.8a key-completeness guard (hard task requirement three):
//   zh-CN is the baseline; every other locale's key set must exactly match
//   it — missing/extra keys both get printed by name. The decision (01 §8
//   item 12) is not to build a runtime fallback chain, so a missing
//   translation can only blow up here, never sit on the UI as a blank.
//
// How to extend (the next card adding ja/ko):
//   ① add an entry to UI_LOCALES in locale.ts;
//   ② each shard gets a matching same-key table added — the compile-time
//      Record<UiLocale, …> forces this step;
//   ③ zero changes to this test: the loop is driven by UI_LOCALES, so it
//      automatically extends to three/four.
//
// 🔴 Correction (2026-08-14, nine-locale migration): ①② no longer hold, ③
// holds and **is paying off** — this file changed **not a single
// character** that round (it was already list-driven), while ①② became
// "add a line to the registry + drop in an i18n/desktop/<code>.json + run
// the generator."
// ⚠️ More importantly, **what this file is guarding has changed**: the ②
// sentence — "the compile-time Record<UiLocale,…> forces every shard to
// hand over all four" — no longer applies (owner ruled the same day that
// missing translations fall back to English, book 17 §0-bis) ⇒ **the
// "key sets are exactly identical" assertion below is now always green**,
// because the generator emits each language as
// `{ ...EN, …whatever it has translated… }`, so the key sets can never
// structurally differ. It's still worth keeping (it catches bugs in the
// generator itself), but **it no longer answers "has this language been
// fully translated"** — that answer lives in i18n/desktop/coverage.json;
// don't read green here as "all nine languages are complete."
//
// Besides the S catalogue there are two "function catalogues" (messages
// with counts/composition, which are functions rather than strings because
// word order differs per locale): TL_BATCH_MSG / SETTINGS_MSG. Their key
// sets are guarded here too.

import { describe, expect, it } from 'vitest';
import { S_BY_LOCALE } from '../strings';
import { TL_BATCH_MSG_CATALOGUES, TL_RETENTION_MSG_CATALOGUES } from './timeline';
import { SETTINGS_MSG_CATALOGUES } from './settings';
import { INJECT_FAIL_REASON, INJECT_FAIL_REASON_CATALOGUES } from './capsule';
import { DEFAULT_LOCALE, UI_LOCALES } from './locale';

/** missing = present in base but not other; extra = present in other but
 *  not base. Both get printed by key name. */
function diffKeys(base: readonly string[], other: readonly string[]): string {
  const o = new Set(other);
  const b = new Set(base);
  const missing = base.filter((k) => !o.has(k));
  const extra = other.filter((k) => !b.has(k));
  return [
    missing.length ? `missing keys: ${missing.join(', ')}` : '',
    extra.length ? `extra keys: ${extra.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

describe('locale parity guard (V2-07.8a)', () => {
  const baseKeys = Object.keys(S_BY_LOCALE[DEFAULT_LOCALE]).sort();

  it(`base catalogue ${DEFAULT_LOCALE} is non-empty`, () => {
    expect(baseKeys.length).toBeGreaterThan(0);
  });

  for (const loc of UI_LOCALES) {
    if (loc === DEFAULT_LOCALE) continue;
    it(`${loc} has EXACTLY the ${DEFAULT_LOCALE} key set (${baseKeys.length} keys)`, () => {
      const otherKeys = Object.keys(S_BY_LOCALE[loc]).sort();
      const report = diffKeys(baseKeys, otherKeys);
      // Key counts go into the assertion message: when it turns red you see
      // both key counts + the specific key names at a glance.
      expect(report, `${DEFAULT_LOCALE}=${baseKeys.length} keys, ${loc}=${otherKeys.length} keys`).toBe('');
    });

    it(`${loc} values are all non-empty strings`, () => {
      const empties = Object.entries(S_BY_LOCALE[loc])
        .filter(([, v]) => typeof v !== 'string' || v.trim().length === 0)
        .map(([k]) => k);
      expect(empties, `empty values in ${loc}: ${empties.join(', ')}`).toEqual([]);
    });
  }

  it('function catalogues TL_BATCH_MSG / TL_RETENTION_MSG / SETTINGS_MSG cover every locale with the same methods', () => {
    const tables = [
      ['TL_BATCH_MSG', TL_BATCH_MSG_CATALOGUES],
      // owner 2026-07-31 ②: the retention-policy pair of sentences are also
      // composed messages, guarded the same way. Missing a locale = the
      // user sees `undefined` after switching languages, and these two
      // sentences are exactly the answer to 「被裁掉的行去哪了」("where did
      // the trimmed rows go").
      ['TL_RETENTION_MSG', TL_RETENTION_MSG_CATALOGUES],
      ['SETTINGS_MSG', SETTINGS_MSG_CATALOGUES],
    ] as const;
    for (const [name, cat] of tables) {
      const baseMethods = Object.keys(cat[DEFAULT_LOCALE]).sort();
      for (const loc of UI_LOCALES) {
        const methods = Object.keys(cat[loc]).sort();
        const report = diffKeys(baseMethods, methods);
        expect(report, `${name}[${loc}] methods`).toBe('');
      }
    }
  });

  // INJECT_FAIL_REASON is a THIRD catalogue (inject error code → capsule reason
  // line). capsule.ts has always described it as guarded here; it was not — its
  // type is Record<UiLocale, Record<string, string>>, so a reason added to zh only
  // compiles clean and renders `undefined!` on a language switch. Wired so a
  // new reason row cannot ship with a missing locale or a missing getter.
  it('INJECT_FAIL_REASON covers every locale with the same codes, and every code is EXPOSED', () => {
    const baseCodes = Object.keys(INJECT_FAIL_REASON_CATALOGUES[DEFAULT_LOCALE]).sort();
    for (const loc of UI_LOCALES) {
      const codes = Object.keys(INJECT_FAIL_REASON_CATALOGUES[loc]).sort();
      expect(diffKeys(baseCodes, codes), `INJECT_FAIL_REASON[${loc}] codes`).toBe('');
      const empties = Object.entries(INJECT_FAIL_REASON_CATALOGUES[loc])
        .filter(([, v]) => typeof v !== 'string' || v.trim().length === 0)
        .map(([k]) => k);
      expect(empties, `empty reasons in ${loc}: ${empties.join(', ')}`).toEqual([]);
    }
    // 反 façade: the exported object is a hand-written getter list, so a catalogue
    // entry with no getter is copy that production can never reach.
    expect(diffKeys(baseCodes, Object.keys(INJECT_FAIL_REASON).sort()), 'exposed getters').toBe('');
  });

  it('placeholder integrity: every {…} placeholder in zh appears verbatim in en', () => {
    const zh = S_BY_LOCALE[DEFAULT_LOCALE];
    for (const loc of UI_LOCALES) {
      if (loc === DEFAULT_LOCALE) continue;
      const bad: string[] = [];
      for (const [k, v] of Object.entries(zh)) {
        // The main guard is already red when a key is missing; downgrade to
        // a report entry here instead of throwing a TypeError that would
        // clutter the output.
        const lv = S_BY_LOCALE[loc][k as keyof typeof zh] as string | undefined;
        if (typeof lv !== 'string') {
          bad.push(`${k} missing in ${loc}`);
          continue;
        }
        const zhPh = (v.match(/\{[^}]+\}/g) ?? []).sort();
        const locPh = (lv.match(/\{[^}]+\}/g) ?? []).sort();
        if (zhPh.join('|') !== locPh.join('|')) bad.push(`${k} (zh ${zhPh} vs ${loc} ${locPh})`);
      }
      expect(bad, `placeholder drift in ${loc}: ${bad.join('; ')}`).toEqual([]);
    }
  });
});
