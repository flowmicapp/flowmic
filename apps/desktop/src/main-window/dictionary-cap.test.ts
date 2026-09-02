// P2 #15 (2026-09-02) — the personal-dictionary card shows "n / 300"
// (SttSettings.vue, SETTINGS_MSG.dictCount) but `addDictEntry` never read that
// number: the box would keep accepting terms past 300, and the server
// (HOTWORDS_MAX_ENTRIES / DICTIONARY_MAX_ENTRIES, apps/server-core/src/stt/
// hotwords.ts) silently truncates from the FRONT once the pushed list exceeds
// it — so a term the user just typed could be the one that gets typed OVER by
// the STT engine, while the card still lists it. This pins the cap using the
// SAME constant (`DICTIONARY_PACK_MAX_ENTRIES`) the "n / 300" label now reads,
// so the two can never drift apart again the way the literal `300` could.
//
// Separate file from settings-model-hydrate.test.ts (module-singleton `model`)
// — same reason settings-model-oss-defaults.test.ts is its own file: Vitest
// isolates modules per file, so this file's `model.dictionary` writes cannot
// bleed into, or be bled into by, another file's assertions.

import { beforeEach, describe, expect, it } from 'vitest';
import { DICTIONARY_PACK_MAX_ENTRIES } from '@flowmic/protocol';
import { addDictEntry, model } from './settings-model';

describe('addDictEntry enforces the same cap the card displays', () => {
  beforeEach(() => {
    model.dictionary = [];
  });

  it('accepts terms up to DICTIONARY_PACK_MAX_ENTRIES', () => {
    for (let i = 0; i < DICTIONARY_PACK_MAX_ENTRIES; i++) {
      expect(addDictEntry(`term-${i}`), `term-${i} should have been accepted`).toBe(true);
    }
    expect(model.dictionary).toHaveLength(DICTIONARY_PACK_MAX_ENTRIES);
  });

  it('🔴 refuses the (cap + 1)th term instead of silently exceeding what the server keeps', () => {
    for (let i = 0; i < DICTIONARY_PACK_MAX_ENTRIES; i++) addDictEntry(`term-${i}`);
    const accepted = addDictEntry('one-too-many');
    expect(accepted, 'the reverse control: without the cap check this is true').toBe(false);
    expect(model.dictionary).toHaveLength(DICTIONARY_PACK_MAX_ENTRIES);
    expect(model.dictionary.some((d) => d.term === 'one-too-many')).toBe(false);
  });

  it('a duplicate is refused the same way whether or not the list is at cap', () => {
    addDictEntry('kubernetes');
    expect(addDictEntry('kubernetes')).toBe(false);
    expect(model.dictionary).toHaveLength(1);
  });
});
