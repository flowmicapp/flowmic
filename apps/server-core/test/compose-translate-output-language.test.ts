// The translate template's OUTPUT-LANGUAGE clause.
//
// 🔴 WHAT THIS FILE IS ABOUT — the failure, not the wording. owner reported, on
// 2026-09-03 from both phones, that saying 「还有一个小问题，就是这个问题要怎么处理呢」
// in translate mode showed him 「AI 生成内容未通过校验」 (COMPOSE_OUTPUT_REJECTED).
//
// The guard was RIGHT. The five production rejections (JP relay
// /opt/flowmic-app/data/server.log, 2026-09-03 03:34:45 → 03:37:08) all carry
// `rule: target_script_absent`, `target_lang: 'en'`, `output_chars: 18|20` — i.e.
// what came back was ~20 characters containing no Latin at all, against a ~19
// character Chinese input. The model had not translated.
//
// The CAUSE is here, in the prompt. owner's scenario card (production settings
// row `scenario.card`) lists professions and preferred terms partly in Chinese,
// and `scenario.ts` renders that block at the HEAD of the system prompt.
// Measured against the deployed managed model (`deepseek-v4-flash`,
// stream:true, temperature 0) with owner's own card, source zh → target en:
//
//     template WITHOUT the output-language clause : 10 of 20 runs untranslated
//     template WITH it                            :  0 of 20
//
// ⚠️ These are unit assertions on the TEMPLATE. They cannot re-measure the model
// — nothing in this repo can, offline — so what they pin is the property the
// measurement was of: the target language is named where the model reads its
// instruction, and the block's own language is explicitly disclaimed. If someone
// removes either, the 10/20 comes back and no other gate would notice.

import { describe, expect, it } from 'vitest';
import { renderTaskTemplate, renderSystemPrompt, buildScenarioBlock } from '../src/compose';

describe('translate template — output language', () => {
  const zhToEn = renderTaskTemplate({ task: 'translate', source_lang: 'zh', target_lang: 'en' });

  it('names the target language as the language to WRITE IN, not only as the destination', () => {
    // "Translate … to English" alone was the shipped template, and it is what
    // produced 10/20. The added sentence is the difference.
    expect(zhToEn).toContain('Write your entire reply in English');
  });

  it('disclaims the background block as a source of output language', () => {
    // 🔴 The wording matters and was measured against alternatives: a bare
    // "reply in {target_lang}" tail still left 1/12 untranslated. Naming the PULL
    // — the block's language — is what reached zero.
    expect(zhToEn).toContain('BACKGROUND CONTEXT block');
    expect(zhToEn).toContain('must not affect the language you write in');
  });

  it('leaves no unsubstituted placeholder — the target is named twice now', () => {
    // 🔴 The reason this assertion exists: the renderer used
    // `String.prototype.replace` with a STRING pattern, which substitutes only
    // the FIRST occurrence. The clause above introduced a second `{target_lang}`,
    // so without `replaceAll` the literal placeholder would have shipped to the
    // model. That is not a cosmetic defect — it is a prompt that names no target.
    expect(zhToEn).not.toContain('{target_lang}');
    expect(zhToEn).not.toContain('{source_lang}');
    const occurrences = zhToEn.split('English').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('substitutes both occurrences for every target, not just for English', () => {
    for (const [tag, name] of [['de', 'German'], ['ja', 'Japanese'], ['ru', 'Russian'], ['zh-TW', 'Traditional Chinese']] as const) {
      const t = renderTaskTemplate({ task: 'translate', source_lang: 'en', target_lang: tag });
      expect(t).not.toContain('{target_lang}');
      expect(t).toContain(`Write your entire reply in ${name}`);
    }
  });

  it('an unknown target tag still passes through verbatim in BOTH places', () => {
    // `promptLanguageName` passes unknown tags through rather than inventing a
    // name; that behaviour must not become "the first one passes through and the
    // second one stays a placeholder".
    const t = renderTaskTemplate({ task: 'translate', source_lang: 'zh', target_lang: 'xx-YY' });
    expect(t).not.toContain('{target_lang}');
    expect(t.split('xx-YY').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('organize and draft_polish are untouched — this clause is translate-only', () => {
    // They have no target language, and the failure measured above is specific
    // to a task whose output language differs from its input's. Widening the
    // change to them would be an unmeasured edit riding along.
    const org = renderTaskTemplate({ task: 'organize', source_lang: 'zh' });
    const pol = renderTaskTemplate({ task: 'draft_polish', source_lang: 'zh' });
    expect(org).not.toContain('Write your entire reply in');
    expect(pol).not.toContain('Write your entire reply in');
  });

  it('the clause survives assembly with a real scenario block in front of it', () => {
    // The whole point is that the block comes FIRST (stable prefix) and the
    // clause has to answer it from behind. Asserting the template alone would
    // not show that the assembled prompt still carries it.
    const block = buildScenarioBlock({
      professions: ['软件开发', '产品设计'],
      domains: ['frontend'],
      terms: ['语流', 'FlowMic'],
    });
    const sys = renderSystemPrompt({ task: 'translate', source_lang: 'zh', target_lang: 'en' }, block);
    expect(sys.indexOf('BEGIN_FLOWMIC_SCENARIO_DATA')).toBeLessThan(sys.indexOf('Write your entire reply in English'));
    expect(sys).toContain('Write your entire reply in English');
  });
});
