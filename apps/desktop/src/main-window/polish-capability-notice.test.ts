// Card POLISH-CFG — "the capability AI polish needs is not configured, and it
// is not in effect" (「AI优化所需的能力未配置，未生效」) beside the AI-polish switch.
//
// WHAT THIS CARD IS ABOUT, IN ONE SENTENCE: the server derives `stt.polish`'s
// default from "is there a usable language model," so an account with no model
// gets a switch that reads ON and does nothing — a state word that cannot
// answer "on what grounds" (book 15 R11). This sentence is the answer, and the
// fact behind it comes from the SERVER (`capability.llm`), because this side
// cannot work it out: it sees only the `llm.config` ROW, while the platform's
// managed default is env-gated and is never a row. A desktop that inferred
// "not configured" from an empty endpoint would say it to every working
// flowmic.app account.
//
// 【rendered-result】 EVERY copy assertion below goes through renderToString, not
// through the catalogue. 0.2.53 is the reason: a sentence that exists in the
// string table and never reaches the screen (or reaches it clipped) passes every
// `Text.data`-shaped assertion while the user reads nothing. Asserting the table
// as well is fine — asserting ONLY the table is the failure mode.
//
// ⚠️ Each render case carries a POSITIVE CONTROL (the polish toggle label). The
// central assertion here is a NEGATIVE one — "usable:true ⇒ the sentence is
// absent" — and a component that rendered nothing at all, or a selector that
// silently produced an empty string, would satisfy it without a character on
// screen (G13's rule: a negative assertion needs a positive control or the zero
// may be the probe being blind).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { SETTINGS_KEY_CAPABILITY_LLM } from '@flowmic/protocol';
import SttSettings from './components/SttSettings.vue';
import LlmSettings from './components/LlmSettings.vue';
import { applyServerSettings, model } from './settings-model';
import { S_BY_LOCALE, setLocale } from '../lib/strings';

const LOCALES = ['zh-CN', 'en', 'ja', 'ko'] as const;
type Loc = (typeof LOCALES)[number];

/** Phrasings that would encode ONE value of a server-side default into a string
 *  compiled into this binary — the same rule data-flow-disclosure.test.ts states.
 *  Module-scope because TWO sentences are now bound by it: `polish_no_llm` (the
 *  notice) and `llm_hint` (which had to start naming polish for REQ-13-09, and
 *  must name the FEATURE without asserting whether it is switched on). */
const DEFAULT_VALUE_CLAIMS: Record<Loc, readonly string[]> = {
  'zh-CN': ['默认关闭', '默认开启', '缺省关', '缺省开'],
  en: ['off by default', 'on by default'],
  ja: ['デフォルトはオフ', 'デフォルトはオン', '既定ではオフ'],
  ko: ['기본 꺼짐', '기본 켜짐', '기본값은 꺼'],
};

/** owner 2026-08-09, verbatim. Written out as a literal rather than read from the
 *  catalogue: comparing the catalogue against itself would pass for ANY sentence,
 *  including one somebody rewrote. This is the ruling, not a copy of the code. */
const OWNER_SENTENCE = 'AI优化所需的能力未配置，未生效';

async function renderIn(loc: Loc): Promise<string> {
  setLocale(loc);
  const html = await renderToString(createSSRApp(SttSettings));
  setLocale('zh-CN');
  return html;
}

beforeEach(() => {
  // The field's own default (see settings-model.ts): "still nothing to assert."
  model.llmCapabilityUsable = true;
});

describe('the sentence renders exactly when the server says the capability is missing', () => {
  it('usable:false ⇒ the owner sentence is on screen', async () => {
    applyServerSettings([{ key: SETTINGS_KEY_CAPABILITY_LLM, value: { usable: false } }]);
    const html = await renderIn('zh-CN');
    expect(html).toContain(OWNER_SENTENCE);
    expect(html).toContain(S_BY_LOCALE['zh-CN'].polish_no_llm);
    // Positive control — the section itself really rendered.
    expect(html).toContain(S_BY_LOCALE['zh-CN'].polish_toggle);
  });

  it('usable:true ⇒ it is NOT on screen (with the toggle proving the render happened)', async () => {
    applyServerSettings([{ key: SETTINGS_KEY_CAPABILITY_LLM, value: { usable: true } }]);
    const html = await renderIn('zh-CN');
    expect(html).toContain(S_BY_LOCALE['zh-CN'].polish_toggle); // positive control
    expect(html).not.toContain(OWNER_SENTENCE);
  });

  it('before the first settings:list nothing is claimed either way', async () => {
    // A cold start asserts NOTHING about a configuration it has not been told
    // about. Starting the field at `false` would print "not configured" on
    // every launch of a perfectly configured machine, in the window before the
    // snapshot lands.
    expect(model.llmCapabilityUsable).toBe(true);
    expect(await renderIn('zh-CN')).not.toContain(OWNER_SENTENCE);
  });

  it('flips back the moment the server says the model came back', async () => {
    applyServerSettings([{ key: SETTINGS_KEY_CAPABILITY_LLM, value: { usable: false } }]);
    expect(await renderIn('zh-CN')).toContain(OWNER_SENTENCE);
    applyServerSettings([{ key: SETTINGS_KEY_CAPABILITY_LLM, value: { usable: true } }]);
    expect(await renderIn('zh-CN')).not.toContain(OWNER_SENTENCE);
  });

  it('renders in all four UI languages, and each one is the LOCAL sentence', async () => {
    applyServerSettings([{ key: SETTINGS_KEY_CAPABILITY_LLM, value: { usable: false } }]);
    for (const loc of LOCALES) {
      const html = await renderIn(loc);
      expect(html, `${loc} does not render polish_no_llm`).toContain(S_BY_LOCALE[loc].polish_no_llm);
      expect(html, `${loc} lost the polish toggle`).toContain(S_BY_LOCALE[loc].polish_toggle);
      if (loc !== 'zh-CN') {
        // A locale that "has" the key by copying the Chinese sentence is a
        // missing translation wearing a passing test.
        expect(html, `${loc} fell back to the Chinese sentence`).not.toContain(OWNER_SENTENCE);
      }
    }
  });

  it('and disappears in all four languages when the capability is there', async () => {
    applyServerSettings([{ key: SETTINGS_KEY_CAPABILITY_LLM, value: { usable: true } }]);
    for (const loc of LOCALES) {
      const html = await renderIn(loc);
      expect(html, `${loc} lost the polish toggle`).toContain(S_BY_LOCALE[loc].polish_toggle); // control
      expect(html, `${loc} still shows the notice`).not.toContain(S_BY_LOCALE[loc].polish_no_llm);
    }
  });
});

describe('the four-language table', () => {
  it('carries polish_no_llm in every locale, non-empty and distinct', () => {
    const seen = new Set<string>();
    for (const loc of LOCALES) {
      const v = S_BY_LOCALE[loc].polish_no_llm;
      expect(typeof v, `${loc}.polish_no_llm`).toBe('string');
      expect(v.trim(), `${loc}.polish_no_llm is empty`).not.toBe('');
      seen.add(v);
    }
    expect(seen.size, 'two locales share one sentence — a translation is missing').toBe(LOCALES.length);
  });

  it("zh-CN is the owner's sentence, character for character", () => {
    expect(S_BY_LOCALE['zh-CN'].polish_no_llm).toBe(OWNER_SENTENCE);
  });

  it('no locale claims which VALUE the switch defaults to', () => {
    // Same rule as data-flow-disclosure.test.ts's DEFAULT_VALUE_CLAIMS: that default
    // lives in a server-side resolver, and this string is compiled into a binary
    // the server cannot reach. This sentence states a PRECONDITION (there is no
    // model), which stays true whichever way the default goes.
    for (const loc of LOCALES) {
      for (const claim of DEFAULT_VALUE_CLAIMS[loc]) {
        expect(S_BY_LOCALE[loc].polish_no_llm, `${loc} claims a default ("${claim}")`).not.toContain(claim);
      }
    }
  });
});

describe('capability.llm is READ-ONLY on this side', () => {
  const modelSrc = readFileSync(fileURLToPath(new URL('./settings-model.ts', import.meta.url)), 'utf8');

  /** 🔴 EVERY structural guard below runs on the CODE, not on the prose.
   *
   *  Written after the first run of this file went red twice on its own comments:
   *  the branch comment says "there is no `save(...)`" and the key's header quotes
   *  `'capability.llm'` to name the literal it is forbidding. Both greps saw those
   *  strings and reported a defect that does not exist. That is the same mistake
   *  in reverse as scenario-inference-consent.test.ts's stripped SSR comments, and
   *  a guard that cannot tell a rule from its violation eventually gets deleted
   *  along with what it was protecting — so it is fixed here rather than worked
   *  around by rewording the comments. */
  const code = modelSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('the key is referenced through the protocol CONSTANT, never as a literal', () => {
    // verify/lint/settings-key-drift.mjs greps the constant NAME under apps/* to
    // prove the synthesised fact has a consumer. A `'capability.llm'` literal here
    // would leave the lint reading "no UI consumer ⇒ façade" while the screen
    // looks perfectly fine — so the spelling is load-bearing and is pinned here.
    expect(code).toContain('SETTINGS_KEY_CAPABILITY_LLM');
    expect(code.match(/['"]capability\.llm['"]/g)).toBeNull();
    expect(SETTINGS_KEY_CAPABILITY_LLM).toBe('capability.llm');
  });

  it('no write path exists — the key never reaches a settings:update call', () => {
    // The other half of the same lint rule: a capability key the UI WRITES is a
    // hard failure, because there is no row to write. Asserted rather than
    // described in a comment (anti-façade ④).
    let sawTheKeyAtLeastOnce = false;
    for (const line of code.split('\n')) {
      if (!line.includes('CAPABILITY_LLM')) continue;
      sawTheKeyAtLeastOnce = true;
      expect(line, 'capability.llm must never be written').not.toMatch(
        /updateSetting|settings\.set|setSetting/,
      );
    }
    // Reverse-control anchor: with comments stripped, a rename would leave this
    // loop iterating over nothing and passing in silence.
    expect(sawTheKeyAtLeastOnce, 'the guard scanned no code at all').toBe(true);
    const clientSrc = readFileSync(fileURLToPath(new URL('../lib/settings-client.ts', import.meta.url)), 'utf8');
    expect(clientSrc).not.toContain('capability');
  });

  it('adopting the value writes no display cache — a fact is not a setting', () => {
    // The neighbouring cases all `save(K_…)`; this one deliberately does not. A
    // cached copy of "the server has no model right now" would outlive the
    // configuration it described and become an expired-but-still-true statement
    // (过期的真话) with a persistence layer.
    const branch = code.slice(
      code.indexOf('case CAPABILITY_LLM_KEY'),
      code.indexOf('case SETTINGS_ANCHOR_KEYS.llmConfig'),
    );
    expect(branch.length, 'the capability branch moved — this guard is measuring nothing').toBeGreaterThan(0);
    // 🔴 COMMENTS ARE STRIPPED FIRST, and the reason is that this exact assertion
    // failed on its own explanation: the branch carries a comment saying "there is
    // no `save(...)` here," and a raw text scan read that sentence as the thing it
    // forbids. The property under test is about CODE; prose that NAMES a construct
    // is not that construct. verify/lint/settings-key-drift.mjs strips for the same
    // reason, in the same words: "this repo names its seams in prose constantly."
    // ⚠️ Do not "fix" this by rewording the comment — the next person to describe
    // the rule accurately would redden the gate again, and the lesson would be
    // "don't explain your code."
    const branchCode = branch
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    expect(branchCode, 'the capability branch must not persist a server-computed fact').not.toContain('save(');
    // Positive control: stripping must not have eaten the branch itself, or this
    // assertion would pass against an empty string.
    expect(branchCode).toContain('llmCapabilityUsable');
  });

  it('a malformed value leaves the last known answer alone', () => {
    applyServerSettings([{ key: SETTINGS_KEY_CAPABILITY_LLM, value: { usable: false } }]);
    for (const bad of [null, 42, 'nope', [], {}, { usable: 'yes' }]) {
      applyServerSettings([{ key: SETTINGS_KEY_CAPABILITY_LLM, value: bad }]);
      expect(model.llmCapabilityUsable, `clobbered by ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe('anti-façade: the notice is mounted where owner put it', () => {
  const src = readFileSync(fileURLToPath(new URL('./components/SttSettings.vue', import.meta.url)), 'utf8');

  it('lives in the STT section, inside the polish card, gated on the capability', () => {
    // owner's landing spot: the "speech recognition" (语音识别) section, next to
    // the AI-polish toggle — not the "language model" (语言模型) section, where a
    // user who never opens it would never see why the switch above did nothing.
    const tpl = src.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? '';
    expect(tpl).toContain('S.polish_no_llm');
    expect(tpl).toContain('v-if="!model.llmCapabilityUsable"');
    const polishCard = tpl.slice(tpl.indexOf('S.polish_title'), tpl.indexOf('S.refine_title'));
    expect(polishCard, 'the notice drifted out of the polish card').toContain('S.polish_no_llm');
  });

  it('🔴 REQ-13-09: the "language model" (语言模型) page says polish depends on it, and names the feature', async () => {
    // THE DEFECT. `llm_hint` enumerated the consumers of this configuration as
    // "organize / translate" (整理 / 翻译) — and AI polish was missing from that list while resolving
    // through the very same row: apps/server-core/src/engine/stt-factory.ts
    // resolvePolishDep() calls resolveLlmConfigWithSource(), the same resolver
    // the compose turn uses, and never reads `mode`. Polish has no configuration
    // of its own. So the dependency existed in exactly ONE place a user could
    // read it — `polish_no_llm`, on the OTHER page, which only appears after the
    // capability is already missing and deliberately carries no imperative.
    // Emptying these four fields silently turns polish off, and nothing on this
    // page said so. That is REQ-13-09's shape: the speech leg and the language
    // model leg told as one, or one riding invisibly on the other's page.
    //
    // ⚠️ ANCHORED TO `polish_title`, NOT TO A LITERAL. The rule this file already
    // enforces elsewhere shares its origin: the guide/hint quotes the string the
    // real control owns, so renaming the feature reddens a test instead of
    // orphaning a sentence that quotes a name nothing on screen uses any more.
    // ⚠️ It must name the FEATURE and not a value of its switch — whether polish
    // is on lives in a server-side default this binary cannot read (the same
    // rule the `no locale claims which VALUE the switch defaults to` case above states).
    for (const loc of LOCALES) {
      const hint = S_BY_LOCALE[loc].llm_hint;
      expect(
        hint,
        `${loc}: the language-model page still lists its consumers without "${S_BY_LOCALE[loc].polish_title}", which resolves through this same llm.config (stt-factory.ts resolvePolishDep)`,
      ).toContain(S_BY_LOCALE[loc].polish_title);
      for (const claim of DEFAULT_VALUE_CLAIMS[loc]) {
        expect(hint, `${loc}: llm_hint claims a default ("${claim}")`).not.toContain(claim);
      }
    }
    // 【rendered-result】 — the catalogue is not the screen (0.2.53). The hint has
    // to survive onto the LLM section, which is a different component from the
    // one every other case in this file renders.
    for (const loc of LOCALES) {
      setLocale(loc);
      const html = await renderToString(createSSRApp(LlmSettings));
      setLocale('zh-CN');
      // Positive control first: the section really rendered, so the assertion
      // below cannot pass against an empty string.
      expect(html, `${loc}: the LLM section did not render`).toContain(S_BY_LOCALE[loc].llm_title);
      expect(
        html,
        `${loc}: llm_hint is in the catalogue but not on screen`,
      ).toContain(S_BY_LOCALE[loc].polish_title);
    }
  });

  it('the component asks the SERVER-supplied fact, not the local llm.config', () => {
    // The tempting shortcut, named so it is not re-invented: an empty endpoint
    // means 「this PC stores no row」, which is a different question from 「is a
    // model reachable」 — the platform's managed default is not a row at all.
    const tpl = src.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? '';
    expect(tpl).not.toContain('model.llm.endpoint');
    model.llm = { preset_id: '', protocol: 'openai-compatible', endpoint: '', api_key: '', model: '' };
    model.llmCapabilityUsable = true;
    return renderToString(createSSRApp(SttSettings)).then((html) => {
      // Empty llm.config + server says usable ⇒ SILENCE. This is the flowmic.app
      // account whose model comes from the platform.
      expect(html).not.toContain(OWNER_SENTENCE);
    });
  });
});
