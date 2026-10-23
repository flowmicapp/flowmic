// R1 — the sound-alike excuse of the content rule (stt-polish-guard-soundalike.ts).
//
// Fixture rows, judged at both strengths with the session language set:
//   · sa-fix-*  correct repairs the NR-245 content rule refused in the
//     PRE-0.3.111 A/B (pool -> pull, Looks -> Logs, blocks -> blogs,
//     Dupin -> du pain) and two non-phonetic refusals (French "hum",
//     German "neue Absatz");
//   · sa-cost-* correct repairs still refused (known_cost: true);
//   · sa-harm-* sound-alike meaning changes: antonyms and polar prefixes,
//     negation, modal / quantifier / number words, plural, names, terms;
//     46-68 from the R1 review (other vowels, soft g, devoicing, capitals).
// sa-fix-07 / -08 (English looks -> logs, blocks -> blogs) became costs in
// that round: only devoicing explained them, and English no longer devoices.
// A harmful row the guard accepts carries known_hole: true. Both open holes
// (Jean -> Jeanne, cloud -> Claude) are accepted identically by the guard
// before R1, through the near-spelling excuse; this card does not open them.
// GUARD-CJK (2026-10-15) closed Jean -> Jeanne (a name for a name,
// stt-polish-guard-names.ts); cloud -> Claude stays open.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppCategory } from '../src/compose/app-category';
import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';
import { polarPair, soundKey } from '../src/stt/stt-polish-guard-soundalike';

type Verdict = 'accept' | 'refuse';
interface Row {
  id: string;
  lang: string;
  kind: string;
  label: 'harmful' | 'neutral';
  input: string;
  output: string;
  appCategory?: AppCategory;
  expect: { strict: Verdict; smooth: Verdict };
  known_hole: boolean;
  known_cost: boolean;
}

const rows: Row[] = readFileSync(join(__dirname, 'fixtures', 'polish-guard-soundalike.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Row);

describe('sound-alike fixture (R1)', () => {
  it('has the repairs and at least 30 harmful sound-alikes', () => {
    expect(rows.length).toBe(82);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.filter((r) => r.label === 'harmful').length).toBeGreaterThanOrEqual(30);
  });

  it('known_hole / known_cost say exactly what the verdicts say', () => {
    for (const r of rows) {
      const accepted = r.expect.strict === 'accept' || r.expect.smooth === 'accept';
      const both = r.expect.strict === 'accept' && r.expect.smooth === 'accept';
      expect({ id: r.id, hole: r.known_hole, cost: r.known_cost })
        .toEqual({ id: r.id, hole: r.label === 'harmful' && accepted, cost: r.label === 'neutral' && !both });
    }
  });

  it('only the hole the near-spelling excuse already had stays open', () => {
    expect(rows.filter((r) => r.known_hole).map((r) => r.id)).toEqual(['sa-harm-42']);
  });

  for (const r of rows) {
    for (const strength of ['strict', 'smooth'] as const) {
      it(`${r.id} ${r.kind} ${r.lang} ${strength}: ${r.input.slice(0, 40)} -> ${r.output.slice(0, 40)}`, () => {
        const got = checkMeaningPreserved(r.input, r.output, {
          strength, language: r.lang, ...(r.appCategory !== undefined ? { appCategory: r.appCategory } : {}),
        });
        expect({ id: r.id, strength, verdict: got.ok ? 'accept' : 'refuse', reason: got.reason })
          .toMatchObject({ id: r.id, strength, verdict: r.expect[strength] });
      });
    }
  }
});

describe('the sound-alike excuse is language-bound', () => {
  it('needs a known session language', () => {
    const raw = 'Merge the pool request before lunch.';
    const pol = 'Merge the pull request before lunch.';
    expect(checkMeaningPreserved(raw, pol, { strength: 'strict', language: 'en' }).ok).toBe(true);
    expect(checkMeaningPreserved(raw, pol, { strength: 'strict' }).ok).toBe(false);
    expect(checkMeaningPreserved(raw, pol, { strength: 'strict', language: 'it' }).ok).toBe(false);
  });

  it('keys one word pair with one language rule set', () => {
    // German / Spanish devoicing, one way: the voiced spelling may be meant.
    expect(soundKey('log', 'de', true)).toBe(soundKey('look', 'de'));
    expect(soundKey('blog', 'es', true)).toBe(soundKey('block', 'es'));
    expect(soundKey('buck', 'de', true)).not.toBe(soundKey('bug', 'de'));
    // English keeps b/d/g voiced, and a soft g is not a k.
    expect(soundKey('log', 'en', true)).not.toBe(soundKey('lock', 'en'));
    expect(soundKey('page', 'en', true)).not.toBe(soundKey('pack', 'en'));
    expect(soundKey('dupin', 'fr')).toBe(soundKey('dupain', 'fr'));
    expect(soundKey('pool', 'en')).toBe(soundKey('pull', 'en'));
    // The first letter is kept as written.
    expect(soundKey('accept', 'en')).not.toBe(soundKey('except', 'en'));
    expect(soundKey('hire', 'en')).not.toBe(soundKey('fire', 'en'));
  });

  it('polarPair finds polar and negating prefixes, not ordinary near spellings', () => {
    for (const [a, b] of [['import', 'export'], ['include', 'exclude'], ['increase', 'decrease'], ['hire', 'fire'],
      ['accept', 'except'], ['lock', 'unlock'], ['legal', 'illegal'], ['prescribe', 'proscribe'], ['maximum', 'minimum'],
      ['verlegen', 'vorlegen'], ['montar', 'desmontar'], ['monter', 'démonter'], ['erlaubt', 'unerlaubt'],
      ['ascend', 'descend'], ['affect', 'effect'], ['attach', 'detach'], ['accelerate', 'decelerate'],
      ['inject', 'eject'], ['emigrate', 'immigrate'], ['majority', 'minority'], ['zumachen', 'aufmachen'],
      ['anschalten', 'ausschalten']]) {
      expect({ a, b, polar: polarPair(a!, b!) }).toEqual({ a, b, polar: true });
    }
    for (const [a, b] of [['meat', 'meet'], ['pool', 'pull'], ['deploy', 'deployed'], ['block', 'blog'], ['looks', 'logs']]) {
      expect({ a, b, polar: polarPair(a!, b!) }).toEqual({ a, b, polar: false });
    }
  });
});
