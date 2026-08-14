// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md (curated dictionary packs + the
//     client-side scenario-grouping merge layer)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.7 (effective stt.dictionary shipped
//     via settings:update)
//   F-3073 (track A — hotword/dictionary expansion)
//
// F-3073 track A: curated `stt.dictionary` content packs + the D-4C-2
// client-side scenario-grouping merge layer. Both surfaces that read
// `stt.dictionary` (F-2117 FunASR hotwords + F-2118 server dictionary
// pass) are FROZEN by this card — expansion is content + a thin merge
// function, never new server mechanism. Packs are curated (hand-authored),
// not synthetic; NOT auto-installed — a user opts in per scenario group
// (privacy positioning). `composeDictionary` is the D-4C-2 "effective
// stt.dictionary sent via settings:update is the union of the user's enabled
// scenario groups" merge: dedupe by term, keep the higher weight on conflict,
// cap at the same 300-entry limit the server already enforces.
//
// Duplicates a 3-field structural type rather than a shared import (the client
// and server each mirror this shape locally), keeping this package's blast
// radius to itself.

/** One personal-dictionary entry — mirrors the server `SttDictionaryEntry`
 *  shape that F-2117/F-2118 consume. */
export interface SttDictionaryEntry {
  term: string;
  weight?: number;
  aliases?: string[];
}

/** Mirrors the server cap (`HOTWORDS_MAX_ENTRIES` / `DICTIONARY_MAX_ENTRIES`,
 *  R-stt-1: > 300 dilutes the FST / the F-2118 pass). */
export const DICTIONARY_PACK_MAX_ENTRIES = 300;

export type DictionaryPackCategory =
  | 'domain-term'
  | 'proper-noun'
  | 'code-switch';

export interface DictionaryPack {
  id: string;
  /** English label; UI-facing labels are a client concern. */
  label: string;
  category: DictionaryPackCategory;
  /** Curated (hand-authored), never 'synthetic'. */
  source: 'curated';
  entries: readonly SttDictionaryEntry[];
}

/**
 * Curated seed packs: domain-term packs (tech/dev, medical, legal, finance),
 * a proper-noun pack (product/brand names — including FlowMic's own name, the
 * exact T-A1 homophone-fix scenario), and a code-switch pack targeting common
 * zh<->en loanword boundary confusions. Seed content, extendable — adding
 * entries never requires a schema change (server keeps consuming the flat
 * merged array).
 */
export const DICTIONARY_PACKS: readonly DictionaryPack[] = [
  {
    id: 'tech-dev',
    label: 'Tech / Dev terms',
    category: 'domain-term',
    source: 'curated',
    entries: [
      { term: 'API', weight: 25 },
      { term: 'SDK', weight: 25 },
      { term: 'GitHub', weight: 25, aliases: ['吉特哈布', '给他好'] },
      { term: 'Docker', weight: 25, aliases: ['多克'] },
      { term: 'Kubernetes', weight: 20, aliases: ['库伯耐提斯'] },
      { term: 'TypeScript', weight: 25, aliases: ['太不思库锐谱特'] },
      { term: 'JavaScript', weight: 25 },
      { term: 'Python', weight: 25, aliases: ['拍森', '拍神'] },
      { term: 'npm', weight: 20 },
      { term: 'pnpm', weight: 20 },
      { term: 'Git', weight: 20 },
      { term: 'JSON', weight: 20 },
      { term: 'HTTP', weight: 20 },
      { term: 'CPU', weight: 20 },
      { term: 'GPU', weight: 20 },
    ],
  },
  {
    id: 'medical',
    label: 'Medical terms',
    category: 'domain-term',
    source: 'curated',
    entries: [
      { term: '心电图', weight: 25 },
      { term: '核磁共振', weight: 25 },
      { term: 'CT', weight: 20 },
      { term: '血常规', weight: 25 },
      { term: '抗生素', weight: 25 },
      { term: '处方', weight: 20 },
      { term: '门诊', weight: 20 },
      { term: '住院', weight: 20 },
      { term: '麻醉', weight: 25 },
      { term: '病理', weight: 20 },
    ],
  },
  {
    id: 'legal',
    label: 'Legal terms',
    category: 'domain-term',
    source: 'curated',
    entries: [
      { term: '合同', weight: 20 },
      { term: '诉讼', weight: 25 },
      { term: '仲裁', weight: 25 },
      { term: '律师', weight: 20 },
      { term: '被告', weight: 20 },
      { term: '原告', weight: 20 },
      { term: '侵权', weight: 25 },
      { term: '知识产权', weight: 25 },
      { term: '专利', weight: 20 },
      { term: '商标', weight: 20 },
    ],
  },
  {
    id: 'finance',
    label: 'Finance terms',
    category: 'domain-term',
    source: 'curated',
    entries: [
      { term: '财报', weight: 20 },
      { term: '估值', weight: 20 },
      { term: '融资', weight: 20 },
      { term: '并购', weight: 25 },
      { term: '股权', weight: 20 },
      { term: '现金流', weight: 25 },
      { term: '资产负债表', weight: 25 },
      { term: '利率', weight: 20 },
      { term: '通胀', weight: 20 },
      { term: '汇率', weight: 20 },
    ],
  },
  {
    id: 'proper-noun',
    label: 'Product / brand names',
    category: 'proper-noun',
    source: 'curated',
    entries: [
      // The T-A1 homophone-fix scenario: FlowMic mis-heard as
      // Chinese-transliteration nonsense syllables.
      { term: 'FlowMic', weight: 30, aliases: ['飞麦克', '佛罗麦克', '福楼麦克'] },
      { term: 'GitHub', weight: 25 },
      { term: 'OpenAI', weight: 25, aliases: ['欧盘AI'] },
      { term: 'Anthropic', weight: 25, aliases: ['安思罗皮克'] },
      { term: 'Claude', weight: 25, aliases: ['克劳德'] },
      { term: 'ChatGPT', weight: 25, aliases: ['聊天GPT'] },
      { term: 'Qwen', weight: 25, aliases: ['千问'] },
      { term: 'DeepSeek', weight: 25, aliases: ['深度求索'] },
      { term: 'Vue', weight: 20, aliases: ['维尤'] },
      { term: 'Tauri', weight: 20, aliases: ['涛瑞'] },
      { term: 'FunASR', weight: 20 },
      { term: 'Whisper', weight: 20, aliases: ['威斯珀'] },
    ],
  },
  {
    id: 'code-switch',
    label: 'zh<->en code-switch loanwords',
    category: 'code-switch',
    source: 'curated',
    entries: [
      { term: 'WiFi', weight: 25, aliases: ['歪fi', '歪服'] },
      { term: 'App', weight: 20, aliases: ['癌普'] },
      { term: 'Email', weight: 20, aliases: ['伊妹儿'] },
      { term: 'USB', weight: 20 },
      { term: 'Bug', weight: 25, aliases: ['巴哥'] },
      { term: 'Update', weight: 20 },
      { term: 'Login', weight: 20 },
      { term: 'Password', weight: 20 },
      { term: 'Online', weight: 20 },
      { term: 'Offline', weight: 20 },
    ],
  },
] as const;

/**
 * D-4C-2 merge: compose the flat `stt.dictionary` array from the user's
 * enabled scenario-group pack ids. Dedupes by `term` (exact match,
 * case-sensitive — mirrors the server's own case-sensitive CJK / literal
 * matching); on conflict keeps the entry with the HIGHER weight (falls back to
 * the earlier-selected pack's entry when weights tie) and unions its
 * `aliases`. Caps at `DICTIONARY_PACK_MAX_ENTRIES` (first-selected-first-kept
 * once at cap, matching the server's own "entries beyond the cap are dropped"
 * rule). Pure — no network / storage; the caller (client settings layer) is
 * responsible for persisting the result via `settings:update`.
 */
export function composeDictionary(
  selectedPackIds: readonly string[],
  packs: readonly DictionaryPack[] = DICTIONARY_PACKS,
): SttDictionaryEntry[] {
  const byId = new Map(packs.map((p) => [p.id, p] as const));
  const merged = new Map<string, SttDictionaryEntry>();

  for (const id of selectedPackIds) {
    const pack = byId.get(id);
    if (!pack) continue;
    for (const entry of pack.entries) {
      const existing = merged.get(entry.term);
      if (!existing) {
        merged.set(entry.term, { ...entry });
        continue;
      }
      const existingWeight = existing.weight ?? 0;
      const incomingWeight = entry.weight ?? 0;
      const aliases = mergeAliases(existing.aliases, entry.aliases);
      const winner: SttDictionaryEntry = incomingWeight > existingWeight
        ? { ...entry, ...(aliases.length > 0 ? { aliases } : {}) }
        : { ...existing, ...(aliases.length > 0 ? { aliases } : {}) };
      merged.set(entry.term, winner);
    }
  }

  return [...merged.values()].slice(0, DICTIONARY_PACK_MAX_ENTRIES);
}

function mergeAliases(a: string[] | undefined, b: string[] | undefined): string[] {
  const set = new Set<string>([...(a ?? []), ...(b ?? [])]);
  return [...set];
}
