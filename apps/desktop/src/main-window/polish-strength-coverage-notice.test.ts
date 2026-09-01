// R-2乙 (owner 2026-08-29) — the sentence that tells a user who chose `smooth`
// what smooth's meaning check can see.
//
// WHY THE SENTENCE EXISTS. The polish guard has two halves. The cardinality
// bound (§3.1) is language-independent. The closed-class check (§3.2) — the one
// that catches a dropped negation, the edit that reverses meaning while barely
// moving the edit distance — used to be built from Chinese and English term
// sets only. WP8 P1-2 extended those tables to the spoken set, so the sentence
// now states that coverage. `CLOSED_CLASS_GUARDED_LANGS` (server) is that fact
// as data and `stt-polish-guard-coverage.test.ts` keeps it true; this file
// checks that the fact reaches a human.
//
// 【rendered-result】 Every copy assertion goes through renderToString, never the
// catalogue. 0.2.53 is the reason: a sentence that exists in the string table and
// never reaches the screen passes every table-shaped assertion while the user
// reads nothing.
//
// ⚠️ The central assertion here is a NEGATIVE one ("strict ⇒ absent"), so each
// render carries a POSITIVE CONTROL (the strength label). Without it a component
// that rendered nothing at all would satisfy the negative case with no character
// on screen — G13's rule: a zero may be the probe being blind.
//
// Refs docs/decisions/2026-08-29-owner-english-as-auxiliary-language.md (R-2乙)
//      docs/strategy/2026-08-28-multilingual-chain-audit.md §3 F3

import { beforeEach, describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import SttSettings from './components/SttSettings.vue';
import { model, setPolishEnabled, setPolishStrength } from './settings-model';
import { S_BY_LOCALE, setLocale } from '../lib/strings';

const LOCALES = ['zh-CN', 'en', 'de', 'ru'] as const;
type Loc = (typeof LOCALES)[number];

async function renderIn(loc: Loc): Promise<string> {
  setLocale(loc);
  const html = await renderToString(createSSRApp(SttSettings));
  setLocale('zh-CN');
  return html;
}

beforeEach(() => {
  setPolishEnabled(true);
  setPolishStrength('strict');
});

describe('the coverage sentence renders exactly when smooth is the chosen strength', () => {
  it('smooth ⇒ the sentence is on screen', async () => {
    setPolishStrength('smooth');
    const html = await renderIn('zh-CN');
    expect(html).toContain(S_BY_LOCALE['zh-CN'].polish_strength_smooth_coverage);
    // Positive control — the strength section really rendered.
    expect(html).toContain(S_BY_LOCALE['zh-CN'].polish_strength_label);
  });

  it('strict ⇒ it is NOT on screen (with the label proving the render happened)', async () => {
    const html = await renderIn('zh-CN');
    expect(html).toContain(S_BY_LOCALE['zh-CN'].polish_strength_label); // positive control
    expect(html).not.toContain(S_BY_LOCALE['zh-CN'].polish_strength_smooth_coverage);
  });

  it('reaches the screen in every locale, not just the authored ones', async () => {
    // The coverage it describes is for speakers of every locale, so a locale
    // that had the key but never rendered it would fail the people it is for.
    for (const loc of LOCALES) {
      setPolishStrength('smooth');
      const html = await renderIn(loc);
      expect(html, `${loc} renders the sentence`).toContain(
        S_BY_LOCALE[loc].polish_strength_smooth_coverage,
      );
    }
  });

  it('each locale has its own translation — not the English one copied around', async () => {
    // The i18n copy-paste failure: nine keys present, one sentence. Pairwise
    // distinctness is the cheap check that catches it.
    const seen = new Map<string, Loc>();
    for (const loc of LOCALES) {
      const s = S_BY_LOCALE[loc].polish_strength_smooth_coverage;
      expect(s.length, `${loc} is non-empty`).toBeGreaterThan(0);
      const prior = seen.get(s);
      expect(prior, `${loc} duplicates ${String(prior)}`).toBeUndefined();
      seen.set(s, loc);
    }
  });

  it('states what the check sees — and claims nothing about the default', async () => {
    // Same discipline as polish_no_llm / polish_strength_hint: the effective
    // strength comes from the server on every settings:list, so a sentence
    // compiled into this binary must not encode one value of it.
    const claims: Record<Loc, readonly string[]> = {
      'zh-CN': ['默认', '缺省'],
      en: ['by default', 'default is'],
      de: ['standardmäßig', 'Voreinstellung'],
      ru: ['по умолчанию'],
    };
    for (const loc of LOCALES) {
      const s = S_BY_LOCALE[loc].polish_strength_smooth_coverage.toLowerCase();
      for (const bad of claims[loc]) {
        expect(s, `${loc} must not claim a default`).not.toContain(bad.toLowerCase());
      }
    }
    // And it names the coverage the guard actually has, so the sentence stays
    // checkable against CLOSED_CLASS_GUARDED_LANGS rather than being vague.
    expect(S_BY_LOCALE.en.polish_strength_smooth_coverage).toContain('every spoken language');
    expect(S_BY_LOCALE.en.polish_strength_smooth_coverage).toContain('negations');
  });

  it('polish switched off ⇒ still no coverage sentence at strict', async () => {
    setPolishEnabled(false);
    const html = await renderIn('zh-CN');
    expect(html).toContain(S_BY_LOCALE['zh-CN'].polish_strength_label); // positive control
    expect(html).not.toContain(S_BY_LOCALE['zh-CN'].polish_strength_smooth_coverage);
  });
});
