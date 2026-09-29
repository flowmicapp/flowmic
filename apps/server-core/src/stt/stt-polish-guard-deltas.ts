import { closedClassMultiset, CLOSED_CLASS_TERMS } from './stt-polish-guard';
import { CLOSED_CLASS_CATEGORIES } from './stt-polish-guard-terms';

export type ClosedCategory = keyof typeof CLOSED_CLASS_CATEGORIES;

/** Diagnostic only: all category deltas, including categories after the first rejection. */
export function closedClassDeltas(raw: string, polished: string): {
  first_category: ClosedCategory | null;
  d_numeral: number; d_digit: number; d_modal: number; d_negation: number; d_quantifier: number;
} {
  const a = closedClassMultiset(raw), b = closedClassMultiset(polished);
  const out = { first_category: null as ClosedCategory | null, d_numeral: 0, d_digit: 0, d_modal: 0, d_negation: 0, d_quantifier: 0 };
  for (const term of CLOSED_CLASS_TERMS) {
    const delta = Math.abs((a.get(term) ?? 0) - (b.get(term) ?? 0));
    if (!delta) continue;
    for (const category of Object.keys(CLOSED_CLASS_CATEGORIES) as ClosedCategory[]) {
      if ((CLOSED_CLASS_CATEGORIES[category] as readonly string[]).includes(term)) {
        out.first_category ??= category;
        out[`d_${category}`] += delta;
      }
    }
  }
  return out;
}
