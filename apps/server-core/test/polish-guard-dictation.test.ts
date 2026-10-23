// ML-2 — dictated punctuation and layout commands (en / fr / de / es / ja / ko / ru).
//
// Each row is a polish candidate for a dictated input, by kind:
//   · convert        — command words replaced by their symbols / line breaks
//                      (accepted at BOTH strengths: the conversion is not an
//                      edit that spends Strict's budget);
//   · deleted        — a command word gone with no symbol for it (refused);
//   · noun_converted — the word used as part of the sentence ("the period
//                      ended", "le point important", "точка зрения") turned
//                      into a symbol (refused);
//   · noun_kept      — the same sentence left as words (accepted).
// The guard half lives in src/stt/stt-polish-guard-dictation.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';

type Verdict = 'accept' | 'refuse';
interface Row {
  id: string;
  lang: string;
  kind: 'convert' | 'deleted' | 'noun_converted' | 'noun_kept';
  label: 'harmful' | 'neutral';
  input: string;
  output: string;
  expect: { strict: Verdict; smooth: Verdict };
}

const rows: Row[] = readFileSync(join(__dirname, 'fixtures', 'polish-guard-dictation.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Row);

describe('polish guard: dictated punctuation commands (ML-2)', () => {
  it('covers every kind in every language', () => {
    for (const lang of ['en', 'fr', 'de', 'es', 'ja', 'ko', 'ru']) {
      const kinds = new Set(rows.filter((r) => r.lang === lang).map((r) => r.kind));
      expect({ lang, kinds: [...kinds].sort() }).toEqual({ lang, kinds: ['convert', 'deleted', 'noun_converted', 'noun_kept'] });
    }
    for (const r of rows) expect({ id: r.id, label: r.label }).toEqual({ id: r.id, label: r.expect.strict === 'accept' ? 'neutral' : 'harmful' });
  });

  for (const r of rows) {
    for (const strength of ['strict', 'smooth'] as const) {
      it(`${r.id} ${r.kind} ${strength}: ${r.input.slice(0, 40)}`, () => {
        const got = checkMeaningPreserved(r.input, r.output, { strength, language: r.lang });
        expect({ id: r.id, strength, verdict: got.ok ? 'accept' : 'refuse', reason: got.reason })
          .toMatchObject({ id: r.id, strength, verdict: r.expect[strength] });
      });
    }
  }

  it('a converted command is not counted against the budget, but its absence is', () => {
    // ml0-de-21 shape: refused by Strict's fixed budget before ML-2.
    const raw = 'Hallo zusammen Komma das Deployment ist fertig Punkt';
    expect(checkMeaningPreserved(raw, 'Hallo zusammen, das Deployment ist fertig.', { strength: 'strict', language: 'de' }).ok).toBe(true);
    expect(checkMeaningPreserved(raw, 'Hallo zusammen das Deployment ist fertig', { strength: 'strict', language: 'de' }))
      .toMatchObject({ ok: false, reason: 'closed-class-drift:dictation' });
  });

  it('a decimal comma is left to the numbers gate', () => {
    const r = checkMeaningPreserved('Der Wert liegt bei drei Komma fünf Prozent.', 'Der Wert liegt bei drei Komma fünf Prozent', { strength: 'strict', language: 'de' });
    expect(r.ok).toBe(true);
  });
});

// MAIN 2026-10-14 decisions on ML-2.
describe('dictated commands: line breaks only off-PC, symbols at the command\'s place', () => {
  const en = { language: 'en' } as const;
  const raw = 'Dear Anna comma new line thanks for the update';

  it('a PC-bound utterance may not gain a line break (Enter sends in a chat box)', () => {
    for (const strength of ['strict', 'smooth'] as const) {
      expect(checkMeaningPreserved(raw, 'Dear Anna,\nthanks for the update', { ...en, strength, lineBreaks: false }))
        .toMatchObject({ ok: false, reason: 'closed-class-drift:line-break' });
      // The layout command kept as words is what a PC-bound polish should give.
      expect(checkMeaningPreserved(raw, 'Dear Anna, new line thanks for the update', { ...en, strength, lineBreaks: false }).ok).toBe(true);
    }
  });

  it('a Notes utterance (never delivered to a PC) converts it', () => {
    for (const strength of ['strict', 'smooth'] as const) {
      expect(checkMeaningPreserved(raw, 'Dear Anna,\nthanks for the update', { ...en, strength, lineBreaks: true }).ok).toBe(true);
    }
  });

  it('the symbol has to be where the command was', () => {
    for (const strength of ['strict', 'smooth'] as const) {
      expect(checkMeaningPreserved('Dear Anna comma thanks for the update period', 'Dear Anna thanks, for the update.', { ...en, strength }))
        .toMatchObject({ ok: false, reason: 'closed-class-drift:dictation' });
      // A symbol of another class doubled onto the transcript's own one.
      expect(checkMeaningPreserved('みなさん、てん、本番へのデプロイが完了しました。まる、改行確認をお願いします。',
        'みなさん、。本番へのデプロイが完了しました。。改行確認をお願いします。', { language: 'ja', strength }))
        .toMatchObject({ ok: false, reason: 'closed-class-drift:dictation' });
    }
  });
});

// ML-2 review (2026-10-14).
describe('dictated commands: review fixes', () => {
  const both = ['strict', 'smooth'] as const;
  it.each([
    ['es', 'Ganamos por dos puntos.', 'Ganamos por:'],
    ['es', 'La inflación subió dos puntos este mes.', 'La inflación subió: este mes.'],
    ['es', 'Sacó dos puntos en el examen.', 'Sacó: en el examen.'],
    ['fr', 'Il a gagné par deux points.', 'Il a gagné par :'],
    ['fr', 'Le CAC a perdu deux points hier.', 'Le CAC a perdu : hier.'],
    ['fr', "Ils ont deux points d'écart.", "Ils ont : d'écart."],
  ])('%s: a number said with "points" is not a colon: %s', (language, raw, out) => {
    for (const strength of both) expect({ strength, ok: checkMeaningPreserved(raw, out, { strength, language }).ok }).toEqual({ strength, ok: false });
  });

  it('every line-break character counts on the PC path (the desktop types a lone CR as Enter)', () => {
    const raw = 'Dear Anna comma thanks for the update';
    for (const strength of both) {
      for (const br of ['\r', '\r\n', ' ', ' ', '\u0085']) {
        expect({ strength, br, r: checkMeaningPreserved(raw, `Dear Anna,${br}thanks for the update`, { strength, language: 'en', lineBreaks: false }).reason })
          .toEqual({ strength, br, r: 'closed-class-drift:line-break' });
      }
    }
  });

  it.each([
    ['Grace period ends today.', 'Grace. Ends today.'],
    ['There is a big question mark over the budget.', 'There is a big? Over the budget.'],
  ])('a noun use is not converted: %s', (raw, out) => {
    for (const strength of both) expect({ strength, ok: checkMeaningPreserved(raw, out, { strength, language: 'en' }).ok }).toEqual({ strength, ok: false });
  });
});
