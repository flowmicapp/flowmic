// WP8 P1-2 — each newly guarded language: a realistic closed-class
// violation rejects, a clean polish of the same sentence does not.
//
// The coverage table (CLOSED_CLASS_GUARDED_LANGS) is kept honest by
// stt-polish-guard-coverage.test.ts. This file is the other half: the
// TERMS actually fire through checkMeaningPreserved, which is what the
// product calls. A language whose negation is visible to the multiset
// but whose edit is admitted as "under the distance bound" would pass
// the coverage file and fail this one.
//
// Matching strategy is named per language so a future edit that moves
// Japanese onto the word-boundary path (where ません is glued to kana
// and would go silent) reddens here rather than in a comment.

import { describe, expect, it } from 'vitest';
import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';
import {
  CLOSED_CLASS_ADDED,
  WORD_BOUNDARY_TERMS,
} from '../src/stt/stt-polish-guard-terms';

describe('closed-class extension — each language fires on a violation and admits a clean polish', () => {
  it('fr: dropping pas rejects; punctuating the same sentence admits', () => {
    expect(checkMeaningPreserved('le build ne marche pas', 'le build marche').ok).toBe(false);
    expect(checkMeaningPreserved('le build ne marche pas', 'Le build ne marche pas.').ok).toBe(true);
  });

  it('es: dropping no rejects; punctuating admits — coverage is the Spanish set, not the English coincidence', () => {
    expect(checkMeaningPreserved('el build no está listo', 'el build está listo').ok).toBe(false);
    expect(checkMeaningPreserved('nunca funciona', 'siempre funciona').ok).toBe(false);
    expect(checkMeaningPreserved('el build no está listo', 'El build no está listo.').ok).toBe(true);
  });

  it('de: dropping nicht rejects; punctuating admits', () => {
    expect(checkMeaningPreserved('der Build ist nicht fertig', 'der Build ist fertig').ok).toBe(false);
    expect(checkMeaningPreserved('der Build ist nicht fertig', 'Der Build ist nicht fertig.').ok).toBe(true);
  });

  it('ja: dropping ません rejects; punctuating admits (substring — ません is glued to kana)', () => {
    expect(WORD_BOUNDARY_TERMS.has('ません')).toBe(false);
    expect(checkMeaningPreserved('ビルドは終わっていません', 'ビルドは終わっています').ok).toBe(false);
    expect(checkMeaningPreserved('ビルドは終わっていません', 'ビルドは終わっていません。').ok).toBe(true);
  });

  it('ko: dropping 안 rejects; punctuating admits (word-boundary — 안 inside 안녕 is not a hit)', () => {
    expect(WORD_BOUNDARY_TERMS.has('안')).toBe(true);
    expect(checkMeaningPreserved('빌드가 안 됐어요', '빌드가 됐어요').ok).toBe(false);
    expect(checkMeaningPreserved('빌드가 안 됐어요', '빌드가 안 됐어요.').ok).toBe(true);
    // 안녕 contains 안 as a syllable, not as the negation word. A greeting
    // polish must not look like a dropped negation.
    expect(checkMeaningPreserved('안녕하세요', '안녕하세요.').ok).toBe(true);
  });

  it('ru: dropping не rejects; punctuating admits (Unicode word-boundary; JS \\b is ASCII and would miss)', () => {
    expect(WORD_BOUNDARY_TERMS.has('не')).toBe(true);
    expect(checkMeaningPreserved('сборка не готова', 'сборка готова').ok).toBe(false);
    expect(checkMeaningPreserved('сборка не готова', 'Сборка не готова.').ok).toBe(true);
    // снег contains не as letters, not as the word. Substring would false-hit.
    expect(checkMeaningPreserved('идёт снег', 'Идёт снег.').ok).toBe(true);
  });
});

describe('closed-class extension — English behaviour is unchanged by the Unicode lookaround', () => {
  it('not / n\'t / cannot still reject; a punctuated English sentence still admits', () => {
    expect(checkMeaningPreserved('it is not good', 'it is good').ok).toBe(false);
    expect(checkMeaningPreserved('all users passed', 'some users passed').ok).toBe(false);
    expect(checkMeaningPreserved('it is not good', 'It is not good.').ok).toBe(true);
  });

  it('know does not count as no — word-boundary, not substring', () => {
    expect(checkMeaningPreserved('I know the build', 'I know the build.').ok).toBe(true);
  });
});

describe('closed-class extension — the added tables are the data, not a rewrite', () => {
  it('each new language has negation, quantifier and modal rows', () => {
    for (const lang of ['fr', 'es', 'de', 'ja', 'ko', 'ru'] as const) {
      const row = CLOSED_CLASS_ADDED[lang];
      expect(row.negation.length, `${lang} negation`).toBeGreaterThan(0);
      expect(row.quantifier.length, `${lang} quantifier`).toBeGreaterThan(0);
      expect(row.modal.length, `${lang} modal`).toBeGreaterThan(0);
    }
  });
});
