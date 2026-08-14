// How a shard gets its strings once the strings are data.
//
// A shard file declares WHICH KEYS IT OWNS (`export const NAV_KEYS = [...]`,
// with the reasoning for each key beside it) and hands that list to
// [shardCatalogue]. What comes back is the same shape the hand-written
// `Record<UiLocale, {...}>` had, so every existing reader — `SIDECAR_STRINGS
// [getLocale()].sidecar_starting`, the guards that walk
// `Object.entries(TIMELINE_STRINGS[loc])` — is untouched.
//
// 🔴 THE KEY LIST IS THE CONTRACT, IN ONE DIRECTION ONLY. It is READ by
// scripts/i18n/gen-desktop-ts.mjs, which refuses to emit if a shard's list and
// i18n/desktop/leaves.json disagree. So there is no second enumeration to keep
// in sync: the list here decides which shard a key belongs to, and the gate
// makes a drift between the two impossible to commit.
//
// The throw below is deliberate and is not defensive noise — book 13 §7 F1 ②
// ("a DI default must never be a friendly empty implementation — it's either a
// real implementation or a throw"). A friendly `?? ''`
// would render an empty label on a real screen and nothing anywhere would say
// why.

import { CATALOGUE, type StringKey } from './generated/catalogue.g';
import { UI_LOCALES, type UiLocale } from './generated/locales.g';

export function shardCatalogue<K extends readonly StringKey[]>(
  keys: K,
): Record<UiLocale, Record<K[number], string>> {
  const out = {} as Record<UiLocale, Record<K[number], string>>;
  for (const loc of UI_LOCALES) {
    const table = {} as Record<K[number], string>;
    for (const k of keys) {
      const v = CATALOGUE[loc][k];
      if (typeof v !== 'string') {
        throw new Error(`shardCatalogue: the ${loc} catalogue has no value for '${String(k)}'`);
      }
      table[k as K[number]] = v;
    }
    out[loc] = table;
  }
  return out;
}
