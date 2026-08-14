// Ported from legacy @flowmic/shared dictionary-packs.test.ts (node:test →
// vitest). Behavior assertions are unchanged.
//   F-3073 (track A) / D-4C-2
import { describe, it, expect } from 'vitest';
import {
  DICTIONARY_PACKS,
  DICTIONARY_PACK_MAX_ENTRIES,
  composeDictionary,
  type DictionaryPack,
} from '../src/dictionary-packs';

describe('dictionary packs (F-3073 track A / D-4C-2)', () => {
  it('every curated pack has non-empty, well-shaped entries', () => {
    expect(DICTIONARY_PACKS.length).toBeGreaterThanOrEqual(5);
    for (const pack of DICTIONARY_PACKS) {
      expect(pack.source).toBe('curated');
      expect(pack.entries.length).toBeGreaterThan(0);
      for (const e of pack.entries) {
        expect(e.term.trim().length).toBeGreaterThan(0);
        if (e.weight !== undefined) {
          expect(e.weight).toBeGreaterThanOrEqual(10);
          expect(e.weight).toBeLessThanOrEqual(50);
        }
      }
    }
  });

  it('composeDictionary unions selected packs, deduping by term', () => {
    const merged = composeDictionary(['tech-dev', 'proper-noun']);
    const terms = merged.map((e) => e.term);
    expect(terms).toContain('API');
    expect(terms).toContain('FlowMic');
    // GitHub appears in both tech-dev and proper-noun — must be single deduped.
    expect(terms.filter((t) => t === 'GitHub').length).toBe(1);
  });

  it('conflict resolution keeps the higher weight + unions aliases', () => {
    const packs: DictionaryPack[] = [
      { id: 'a', label: 'A', category: 'proper-noun', source: 'curated', entries: [{ term: 'X', weight: 15, aliases: ['x1'] }] },
      { id: 'b', label: 'B', category: 'proper-noun', source: 'curated', entries: [{ term: 'X', weight: 30, aliases: ['x2'] }] },
    ];
    const merged = composeDictionary(['a', 'b'], packs);
    expect(merged.length).toBe(1);
    expect(merged[0]!.weight).toBe(30);
    expect(new Set(merged[0]!.aliases)).toEqual(new Set(['x1', 'x2']));
  });

  it('unknown pack ids are ignored, empty selection yields empty array', () => {
    expect(composeDictionary([])).toEqual([]);
    expect(composeDictionary(['does-not-exist'])).toEqual([]);
  });

  it('composeDictionary caps at the 300-entry server limit', () => {
    const bigPack: DictionaryPack = {
      id: 'big',
      label: 'Big',
      category: 'domain-term',
      source: 'curated',
      entries: Array.from({ length: DICTIONARY_PACK_MAX_ENTRIES + 50 }, (_, i) => ({ term: `term-${i}` })),
    };
    const merged = composeDictionary(['big'], [bigPack]);
    expect(merged.length).toBe(DICTIONARY_PACK_MAX_ENTRIES);
  });
});
