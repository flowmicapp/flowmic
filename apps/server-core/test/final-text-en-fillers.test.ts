// ML-2 EN-1: standalone English hesitation sounds are stripped from an English
// session's finals (src/stt/final-text-en-fillers.ts, called from
// normalizeFinalText). Inputs are Soniox finals from the EVAL-1 base run.
import { describe, expect, it } from 'vitest';
import { normalizeFinalText } from '../src/stt/final-text-normalizer';

const en = (t: string): string => normalizeFinalText(t, { language: 'en', ensureTerminalPunctuation: true });

describe('English filler strip (EN-1)', () => {
  it.each([
    ['Um, I think we should, uh, push the release to next week.', 'I think we should, push the release to next week.'],
    ['The umbrella is here, er, there.', 'The umbrella is here, there.'],
    ['So, um, the build is green.', 'So, the build is green.'],
    ['We should uh push it.', 'We should push it.'],
    ['So, uh, the build is "Green Bird," um, the deploy is still stuck.', 'So, the build is "Green Bird," the deploy is still stuck.'],
    ['Uh, can you— um— check whether the cache is warm?', 'Can you check whether the cache is warm?'],
    ['Uh, let me think... um, maybe we just roll back.', 'Let me think... maybe we just roll back.'],
    ['Yes, ummm, I agree. Hmm, interesting.', 'Yes, I agree. Interesting.'],
    ['Roll it back, erm.', 'Roll it back.'],
  ])('%s', (input, want) => {
    expect(en(input)).toBe(want);
  });

  it('keeps words that only contain the letters, and the yes-answers', () => {
    expect(en('The umbrella and the hummus are here.')).toBe('The umbrella and the hummus are here.');
    expect(en('Uh-huh, that works. Mm-hmm.')).toBe('Uh-huh, that works. Mm-hmm.');
    expect(en("Him, I'm not sure.")).toBe("Him, I'm not sure.");
  });

  it('never strips "like" or "you know"', () => {
    expect(en('It was like, you know, really slow.')).toBe('It was like, you know, really slow.');
  });

  it('leaves a final that is only a hesitation as it was (no empty final)', () => {
    expect(en('Um.')).toBe('Um.');
  });

  it('only in an English session: "er" is German for "he"', () => {
    expect(normalizeFinalText('Ja, er kommt morgen.', { language: 'de', ensureTerminalPunctuation: true })).toBe('Ja, er kommt morgen.');
    expect(normalizeFinalText('Um, ok.', { language: '', ensureTerminalPunctuation: true })).toBe('Um, ok.');
    expect(normalizeFinalText('Um, ok.', { language: 'en-US', ensureTerminalPunctuation: true })).toBe('Ok.');
  });
});

// ML-2 review (2026-10-14): real words, quotes, casing, dictionary terms.
describe('English filler strip keeps real words (review)', () => {
  it.each([
    'To err is human.',
    'Take him to the ER now.',
    'Train an HMM on the corpus.',
    'UM beat Ohio State.',
    'Element Er is rare.',
    'He wrote "hmm" in the margin.',
    'She said “um” twice.',
  ])('%s', (t) => {
    expect(en(t)).toBe(t);
  });

  it('does not re-case a word that is not all lowercase', () => {
    expect(en('Um, iPhone sales are up.')).toBe('iPhone sales are up.');
    expect(en('Uh, eBay is down.')).toBe('eBay is down.');
    expect(en('Uh, the build is green.')).toBe('The build is green.');
  });

  it('never strips a user dictionary term', () => {
    const out = normalizeFinalText('We met at um yesterday.', { language: 'en', ensureTerminalPunctuation: true, keepTerms: ['um'] });
    expect(out).toBe('We met at um yesterday.');
  });
});

describe('the production pipeline hands the dictionary terms to the filler strip', () => {
  it('a user term "UM" (University of Miami) and "um" spoken as a term both survive', async () => {
    const { makeFinalTextPipeline } = await import('../src/stt/final-text-pipeline');
    const { buildDictionaryReplacer } = await import('../src/compose/dictionary-replace');
    const withTerm = makeFinalTextPipeline(buildDictionaryReplacer([{ canonical: 'um', aliases: [] }]));
    expect(withTerm('We met at um yesterday', { isSegment: false, language: 'en' })).toBe('We met at um yesterday.');
    const none = makeFinalTextPipeline(buildDictionaryReplacer([]));
    expect(none('We met at um yesterday', { isSegment: false, language: 'en' })).toBe('We met at yesterday.');
  });
});
