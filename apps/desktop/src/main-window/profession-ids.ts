// Profession chip ids for the desktop scenario card.
//
// 🔴 ALPHABET ORIGIN = the phone's kProfessionPresets
// (apps/mobile/lib/src/ui/settings_widgets.dart). PROFESSION_OPTIONS here is a
// cross-language mirror of that list, kept in agreement by discipline — when
// one file changes, change the other. The stored value IS the id (a bare
// string[] on scenario.card.professions); compose injects it verbatim
// (apps/server-core/src/compose/scenario.ts). Until this file, the desktop
// stored Chinese labels as ids while the phone stored these English slugs, so
// the same KV used two alphabets: chips did not light across ends, and the
// prompt received raw Chinese.
//
// DISPLAY is the overlay below (PROFESSION_LABELS), same GETTERS-reading-S
// split PACK_LABELS uses for dictionary packs. Do not render the stored id.
//
// ── DOMAINS ──────────────────────────────────────────────────────────────────
// Packet D (p1-packet-D-i18n.md §D3) said the desktop has no domain-chip row.
// Verified 2026-08-31: ScenarioCard.vue iterates PROFESSIONS / PACKS / terms
// only. `settings-model.ts`'s `toggleDomain` (a caller-less write helper for
// this same field) was deleted 2026-09-02 on the strength of that finding —
// `model.card.domains` is still read and preserved (settings-cache-narrow.ts),
// mobile is the only end that writes it. Mapping is professions only.

import { S } from '../lib/strings';

/** Stored profession ids. Byte-identical to kProfessionPresets. */
export const PROFESSION_OPTIONS = [
  'software development',
  'product design',
  'devops / SRE',
  'research',
  'writing / editing',
  'teaching',
  'medicine',
  'law',
  'finance',
] as const;

/**
 * Read-side map: Chinese ids the desktop stored through 0.3.54 → the phone
 * slug they mean. ONE table, ONE author. Lookup is exact string equality.
 *
 *  - Known Chinese → slug (so a stored `软件开发` lights `software development`).
 *  - A slug already in this alphabet → itself (idempotent).
 *  - Anything else (custom / unknown / typo) → itself. Never dropped, never
 *    translated. A value we do not recognise is the user's data.
 *
 * Applied on READ (local cache + settings:list). The next save writes slugs
 * because the in-memory card already holds them. Not a DB migration.
 */
export const PROFESSION_LEGACY_ZH_TO_SLUG: Readonly<Record<string, string>> = {
  '软件开发': 'software development',
  '云原生 / 运维': 'devops / SRE',
  '产品设计': 'product design',
  '金融': 'finance',
  '医疗': 'medicine',
  '法律': 'law',
  '教育': 'teaching',
  '科研': 'research',
};

/** Map one stored profession string. Identity for slugs and unknowns. */
export function migrateProfessionId(id: string): string {
  return PROFESSION_LEGACY_ZH_TO_SLUG[id] ?? id;
}

/** Map a professions array. Idempotent; preserves order; dedupes after map
 *  so `['软件开发', 'software development']` becomes one chip, not two. */
export function migrateProfessionList(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const mapped = migrateProfessionId(id);
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
  }
  return out;
}

/** Localized display labels for PROFESSION_OPTIONS. GETTERS reading S — an
 *  init-time literal table would freeze the boot locale and never switch. */
export const PROFESSION_LABELS: Record<string, string> = {
  get 'software development'() { return S.profession_swdev; },
  get 'product design'() { return S.profession_product_design; },
  get 'devops / SRE'() { return S.profession_cloud_ops; },
  get 'research'() { return S.profession_research; },
  get 'writing / editing'() { return S.profession_writing; },
  get 'teaching'() { return S.profession_education; },
  get 'medicine'() { return S.profession_healthcare; },
  get 'law'() { return S.profession_law; },
  get 'finance'() { return S.profession_finance; },
};

/** `{id, label}` pairs the chip row iterates — `id` is the stored value,
 *  `label` is what the user reads. Same shape as PACKS. */
export const PROFESSIONS = PROFESSION_OPTIONS.map((id) => ({
  id,
  get label() { return PROFESSION_LABELS[id] ?? id; },
}));
