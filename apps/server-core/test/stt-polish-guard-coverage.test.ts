// The §3.2 closed-class gate's language coverage, as a MEASUREMENT rather than a
// claim.
//
// Until 2026-08-29 the coverage fact lived only in a 40-line comment in
// stt-polish-guard.ts. That comment was honest and it was also unfalsifiable: a
// comment cannot go red, so if someone added `nicht` to EN_NEGATION the prose
// would silently become wrong, and if someone added a language row without terms
// the prose would silently become optimistic.
//
// This file drives the REAL matcher (`closedClassMultiset`) with real negations
// in each of the product's spoken languages and asserts that membership in
// CLOSED_CLASS_GUARDED_LANGS predicts what the matcher actually sees. It is the
// only thing standing between "we check negation in this language" and a wish.
//
// WP8 P1-2 extended the tables to the spoken set. The unguarded half of this
// file now uses Italian (`it`) as the negative control — a language the product
// does not ship as a spoken tag, so a hit there would mean a term leaked into
// the matcher without a coverage row. Spanish was the previous "coincidence is
// not coverage" exhibit (`no` overlapping English); it is now genuinely
// guarded (nunca / nada / ningún, not just `no`).
//
// Refs docs/decisions/2026-08-29-owner-english-as-auxiliary-language.md (R-2乙)
//      docs/strategy/2026-08-28-multilingual-chain-audit.md §3 F3

import { describe, expect, it } from 'vitest';
import {
  CLOSED_CLASS_GUARDED_LANGS,
  closedClassMultiset,
  isClosedClassGuarded,
} from '../src/stt/stt-polish-guard';

/** Does the gate see a negation change between these two texts? */
function negationSeen(withNeg: string, withoutNeg: string): boolean {
  const a = closedClassMultiset(withNeg);
  const b = closedClassMultiset(withoutNeg);
  for (const [term, count] of a) if ((b.get(term) ?? 0) !== count) return true;
  return false;
}

// Each pair is the SAME sentence with its negation removed — the single edit the
// §3.2 gate exists to catch, because it reverses meaning while barely moving the
// edit distance.
const NEGATION_PAIRS: readonly { lang: string; withNeg: string; without: string }[] = [
  { lang: 'zh', withNeg: '这个功能不能用', without: '这个功能能用' },
  { lang: 'en', withNeg: 'the build is not ready', without: 'the build is ready' },
  { lang: 'de', withNeg: 'der Build ist nicht fertig', without: 'der Build ist fertig' },
  { lang: 'fr', withNeg: 'le build ne marche pas', without: 'le build marche' },
  { lang: 'es', withNeg: 'el build no está listo', without: 'el build está listo' },
  { lang: 'ru', withNeg: 'сборка не готова', without: 'сборка готова' },
  { lang: 'ja', withNeg: 'ビルドは終わっていません', without: 'ビルドは終わっています' },
  { lang: 'ko', withNeg: '빌드가 안 됐어요', without: '빌드가 됐어요' },
  // Negative control: Italian is not a spoken tag. `non` is not in the tables.
  { lang: 'it', withNeg: 'il build non è pronto', without: 'il build è pronto' },
];

describe('closed-class gate — the coverage table matches what the matcher does', () => {
  it('every guarded language really does have its negation seen', () => {
    for (const { lang, withNeg, without } of NEGATION_PAIRS) {
      if (!isClosedClassGuarded(lang)) continue;
      expect(negationSeen(withNeg, without), `${lang} is listed as guarded`).toBe(true);
    }
  });

  it('🔴 every UNGUARDED language really does have its negation MISSED', () => {
    // This is the uncomfortable half and it is the half that matters. If someone
    // extends the term sets without extending the table, this reddens and says
    // so — which is the failure mode the old prose-only form could not report.
    for (const { lang, withNeg, without } of NEGATION_PAIRS) {
      if (isClosedClassGuarded(lang)) continue;
      expect(
        negationSeen(withNeg, without),
        `${lang} is NOT listed as guarded, so its negation must not be seen — if this is now seen, add the row`,
      ).toBe(false);
    }
  });

  it('digits are seen in every language — that is the floor the others keep', () => {
    // The honest summary of the gap: unguarded languages are not unguarded, they
    // are guarded down to a number check.
    for (const { lang } of NEGATION_PAIRS) {
      const seen = negationSeen(`${lang} 3 items`, `${lang} 4 items`);
      expect(seen, `${lang} digits`).toBe(true);
    }
  });

  it('es is genuinely guarded — nunca is coverage, coincidental no is not the claim', () => {
    expect(isClosedClassGuarded('es')).toBe(true);
    expect(negationSeen('el build no está listo', 'el build está listo')).toBe(true);
    expect(negationSeen('nunca funciona', 'siempre funciona')).toBe(true);
  });

  it('base-language matching, and an unknown tag is not a claim of coverage', () => {
    expect(isClosedClassGuarded('zh-CN')).toBe(true);
    expect(isClosedClassGuarded('zh-TW')).toBe(true);
    expect(isClosedClassGuarded('en-US')).toBe(true);
    expect(isClosedClassGuarded('EN')).toBe(true);
    expect(isClosedClassGuarded('fr-FR')).toBe(true);
    expect(isClosedClassGuarded(undefined)).toBe(false);
    expect(isClosedClassGuarded('xh')).toBe(false);
    expect(isClosedClassGuarded('it')).toBe(false);
    expect(isClosedClassGuarded('')).toBe(false);
  });

  it('the table lists the spoken set the term tables are built from', () => {
    expect([...CLOSED_CLASS_GUARDED_LANGS].sort()).toEqual(
      ['de', 'en', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'],
    );
  });
});
