// Card LLM-NOTICE (owner 2026-08-25, D1/D2) — the desktop's sentences about one
// missing language model, plus the first-run card, asserted on the RENDERED
// result in every UI locale.
//
// THE RULE THIS FILE PINS: separate facts get separate sentences, never merged.
// There were three:
//   · Translate / Organize → NOT SUPPORTED     (LlmSettings, `llm_modes_unsupported`)
//   · AI polish            → NOT IN EFFECT     (SttSettings, `polish_no_llm`)
//   · scenario card        → terms STILL WORK  (ScenarioCard, `scenario_terms_still_work`)
//
// 🔴 TWO OF THE THREE LEFT ON 2026-09-03, AND NOT BY BEING MERGED — their SCREENS
// left. owner ruled the AI-polish switch and the scenario card are the phone's,
// so this end has neither control and a sentence about either would be about a
// screen the reader is not on. The MECHANISM is unchanged: the card's terms still
// reach the speech engine as hotwords/replacements (stt/engine-factory.ts), which
// is exactly why the deleted sentence must not be resurrected here as a
// consolation line under the surviving one — 'the card still works' is not this
// screen's news to give.
// ⚠️ What is left of the dependency on THIS page is `llm_hint`, which names AI
// polish as a consumer of `llm.config` and says where its switch now is. Its
// per-locale equality with `polish_title` was pinned by
// polish-capability-notice.test.ts; both went with the card.
//
// 【rendered-result】 Every copy assertion goes through renderToString, never
// through the catalogue alone (0.2.53). Every negative case carries a positive
// control (G13: a zero may be the probe being blind).
//
// 🔴 REVERSE CONTROL (the card's mandatory one): with `usable: true` NONE of the
// three sentences may appear, in any locale — the `usable:true` cases below
// are that control, and they were seen red by flipping the v-if in
// LlmSettings.vue to `v-if="model.llmCapabilityUsable"` (recorded in the commit).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { SETTINGS_KEY_CAPABILITY_LLM } from '@flowmic/protocol';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import LlmSettings from './components/LlmSettings.vue';
import SttSettings from './components/SttSettings.vue';
import LlmSetupCard from './components/LlmSetupCard.vue';
import { applyServerSettings, model } from './settings-model';
import { S_BY_LOCALE, UI_LOCALES, setLocale, type UiLocale } from '../lib/strings';
import {
  K_LLM_SETUP_CARD_DISMISSED,
  readSetupCardDismissed,
  shouldShowLlmSetupCard,
  writeSetupCardDismissed,
} from '../lib/llm-setup-card';
import { SETTINGS_SECTION_DOM, jumpToSettingsSection, sectionFromEvent } from '../lib/settings-section-jump';
import { guideUrl } from '../lib/site-guide';

/** owner 2026-08-25, verbatim, for the mode note on the PHONE; the desktop's
 *  sentence is its own, but the zh-CN one must still be the D1 ruling's claim
 *  ("not supported"), so the claim word is pinned here. */
const MODE_CLAIM_ZH = '不支持';

const DEFAULT_VALUE_CLAIMS: Record<string, readonly string[]> = {
  'zh-CN': ['默认关闭', '默认开启', '缺省关', '缺省开'],
  en: ['off by default', 'on by default'],
};

/** renderToString HTML-escapes text nodes (`'` → `&#39;`, `&` → `&amp;`), so a
 *  catalogue sentence with an apostrophe (fr/es) must be compared in its
 *  escaped form — comparing the raw string would report a French sentence
 *  "missing" that is on screen letter for letter. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function render(component: object, loc: UiLocale): Promise<string> {
  setLocale(loc);
  const html = await renderToString(createSSRApp(component));
  setLocale('zh-CN');
  return html;
}

function usable(v: boolean): void {
  applyServerSettings([{ key: SETTINGS_KEY_CAPABILITY_LLM, value: { usable: v } }]);
}

/** The desktop suite runs in plain Node: no `localStorage`, no `window`. The
 *  SFC reads its dismissal through lib/storage's localKv (which wraps
 *  localStorage), and the section jump rides a window CustomEvent — both are
 *  stubbed here with the smallest faithful doubles, per test, torn down after. */
const kvBacking = new Map<string, string>();
beforeEach(() => {
  model.llmCapabilityUsable = true;
  kvBacking.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => kvBacking.get(k) ?? null,
    setItem: (k: string, v: string) => void kvBacking.set(k, String(v)),
    removeItem: (k: string) => void kvBacking.delete(k),
  });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('three sentences, three subjects, every locale (rendered)', () => {
  it('usable:false ⇒ the modes sentence is on the LLM section, in every locale', async () => {
    usable(false);
    for (const loc of UI_LOCALES) {
      const s = S_BY_LOCALE[loc];
      const llm = await render(LlmSettings, loc);
      expect(llm, `${loc}: LLM section did not render`).toContain(esc(s.llm_title)); // positive control
      expect(llm, `${loc}: modes sentence missing`).toContain(esc(s.llm_modes_unsupported));
    }
  });

  it('🔴 usable:true ⇒ the sentence does not appear, in any locale (positive control proves the render)', async () => {
    usable(true);
    for (const loc of UI_LOCALES) {
      const s = S_BY_LOCALE[loc];
      const llm = await render(LlmSettings, loc);
      expect(llm).toContain(esc(s.llm_title));
      expect(llm, `${loc}: modes sentence leaked`).not.toContain(esc(s.llm_modes_unsupported));
    }
  });

  // 🔴 THE SPEECH PAGE MAKES NO CLAIM ABOUT THE LANGUAGE MODEL ANY MORE, and the
  // assertion is that it renders with the capability fact set to FALSE and still
  // says nothing about it. A page that quietly grew a replacement sentence for
  // the deleted `polish_no_llm` would be answering for a switch it does not have.
  it('🔴 SttSettings says nothing about the language model, even at usable:false', async () => {
    usable(false);
    const stt = await render(SttSettings, 'en');
    expect(stt, 'the speech page did not render').toContain(esc(S_BY_LOCALE.en.stt_title)); // positive control
    // 🔴 HTML COMMENTS ARE IN THE SSR OUTPUT, and the page's own note NAMES the
    // three deleted cards in order to say they are gone. Asserting on the raw
    // string made this case fail on that explanation — a guard that cannot tell a
    // rule from its violation, which is the failure llm-notice already recorded
    // once for LlmSetupCard.vue. Strip them, then read what a user would read.
    const visible = stt.replace(/<!--[\s\S]*?-->/g, '');
    expect(visible).not.toContain(esc(S_BY_LOCALE.en.llm_modes_unsupported));
    expect(visible.toLowerCase(), 'a polish claim came back onto the speech page').not.toContain('ai polish');
  });

  it('before the first settings:list nothing is claimed either way', async () => {
    expect(model.llmCapabilityUsable).toBe(true);
    const llm = await render(LlmSettings, 'zh-CN');
    expect(llm).not.toContain(esc(S_BY_LOCALE['zh-CN'].llm_modes_unsupported));
  });

  it('the sentence is DISTINCT per locale (no translation wearing a passing test)', () => {
    for (const loc of UI_LOCALES) {
      const s = S_BY_LOCALE[loc];
      expect(s.llm_modes_unsupported.trim()).not.toBe('');
      if (loc !== 'zh-CN') {
        expect(s.llm_modes_unsupported, `${loc} fell back to zh-CN`).not.toBe(S_BY_LOCALE['zh-CN'].llm_modes_unsupported);
      }
    }
    // The claim word: the modes sentence SAYS not supported.
    expect(S_BY_LOCALE['zh-CN'].llm_modes_unsupported).toContain(MODE_CLAIM_ZH);
  });

  // 🔴 `llm_hint` STILL NAMES AI POLISH, and that is a requirement rather than a
  // leftover (REQ-13-09). Polish has no configuration of its own — it resolves
  // through the very `llm.config` this page edits (stt-factory.ts
  // resolvePolishDep) — so emptying these fields turns it off, and after
  // 2026-09-03 this is the ONLY page in the product's desktop end that can say
  // so. The sentence must also say where the switch now lives, or the reader is
  // told about a control with no way to find it.
  it('🔴 llm_hint names AI polish AND points at the phone, in every locale', async () => {
    for (const loc of UI_LOCALES) {
      const html = await render(LlmSettings, loc);
      expect(html, `${loc}: llm_hint is not mounted`).toContain(esc(S_BY_LOCALE[loc].llm_hint));
    }
    // Read on the two locales whose wording this repo owns word for word.
    expect(S_BY_LOCALE.en.llm_hint).toContain('AI polish');
    expect(S_BY_LOCALE.en.llm_hint.toLowerCase()).toContain('phone');
    expect(S_BY_LOCALE['zh-CN'].llm_hint).toContain('AI 润色');
    expect(S_BY_LOCALE['zh-CN'].llm_hint).toContain('手机');
    // ⚠️ It must NOT claim a value for that switch: this binary cannot read it
    // (the phone answers, per session), which is a stronger version of the old
    // 'the server owns the default' rule rather than a weaker one.
    for (const [loc, claims] of Object.entries(DEFAULT_VALUE_CLAIMS)) {
      for (const claim of claims) {
        expect(S_BY_LOCALE[loc as UiLocale].llm_hint, `${loc} claims a default ("${claim}")`).not.toContain(claim);
      }
    }
  });

  it('no sentence asserts a default value of any switch', () => {
    for (const [loc, claims] of Object.entries(DEFAULT_VALUE_CLAIMS)) {
      const s = S_BY_LOCALE[loc as UiLocale];
      for (const claim of claims) {
        for (const text of [s.llm_modes_unsupported, s.llm_setup_body]) {
          expect(text, `${loc} claims a default ("${claim}")`).not.toContain(claim);
        }
      }
    }
  });

  it('the components ask the SERVER fact, never the local llm.config', () => {
    // LlmSettings.vue legitimately BINDS `model.llm.endpoint` — it is the
    // endpoint input box. What must never happen is a GATE on it: the notice and
    // the card are conditioned on the server fact and nothing else.
    for (const file of ['./components/LlmSettings.vue']) {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      const tpl = src.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? '';
      expect(tpl, `${file} gates on the endpoint`).not.toMatch(/v-if="[^"]*llm\.endpoint/);
      expect(tpl, `${file} lost the capability gate`).toContain('v-if="!model.llmCapabilityUsable"');
    }
    // Comments stripped first: the card's header NAMES the endpoint shortcut in
    // order to forbid it, and a guard that cannot tell a rule from its violation
    // reads its own explanation as a defect (polish-capability-notice.test.ts
    // recorded exactly that failure).
    const card = readFileSync(fileURLToPath(new URL('./components/LlmSetupCard.vue', import.meta.url)), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ 	]*\/\/.*$/gm, '');
    expect(card).not.toContain('model.llm.endpoint');
    expect(card).toContain('model.llmCapabilityUsable');
  });
});

describe('the first-run card (owner D2)', () => {
  it('usable:false + not dismissed ⇒ title, body and BOTH jump buttons render, in every locale', async () => {
    usable(false);
    for (const loc of UI_LOCALES) {
      const s = S_BY_LOCALE[loc];
      const html = await render(LlmSetupCard, loc);
      expect(html, `${loc}: card absent`).toContain('data-testid="llm-setup-card"');
      expect(html).toContain(esc(s.llm_setup_title));
      expect(html).toContain(esc(s.llm_setup_body));
      expect(html).toContain(esc(s.llm_setup_go_stt));
      expect(html).toContain(esc(s.llm_setup_go_llm));
      expect(html).toContain(esc(s.llm_setup_dismiss));
      expect(html).toContain('data-jump="stt"');
      expect(html).toContain('data-jump="llm"');
      // 🔴 THE GUIDE LINK, AND WHY THIS ASSERTION CHANGED SHAPE (2026-08-28).
      // It used to read 「no anchor, no guide URL, no href at all」, which was
      // the right assertion while the web chapter did not exist. Left as it
      // was, it would have gone on passing for the WRONG reason: the address is
      // not in the DOM either way, because the door is a BUTTON — so the old
      // line could never have told a live link from a missing one. It now pins
      // the affordance, and the anchor ban stays as the thing it always really
      // meant: an anchor asking for a new window opens nothing in this WebView
      // (the literal attribute is not spelled here — verify:lint
      // external-link-door reads source text and cannot tell a citation from a
      // use, and it flagged this very line when it was).
      expect(html, `${loc}: the guide affordance is missing`).toContain('data-testid="llm-setup-guide"');
      expect(html).toContain(esc(s.llm_setup_guide));
      expect(html).not.toMatch(/<a[\s>]/);
    }
  });

  it('🔴 the guide link goes through the ONE external door, at the address the site actually serves', () => {
    // `openExternalUrl` is the app's only working route to a browser
    // (verify:lint external-link-door). A refusal must leave the address on
    // screen — a button that opened nothing and said nothing is the defect
    // 0.3.24 was about.
    // Comments stripped first, same reason as the case above: the card's own
    // notes NAME the broken mechanisms in order to forbid them, and a guard
    // that cannot tell a rule from its violation reads its own explanation as
    // a defect (this assertion was seen failing on the card's comment before
    // the strip was added).
    const card = readFileSync(fileURLToPath(new URL('./components/LlmSetupCard.vue', import.meta.url)), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    expect(card).toContain('openExternalUrl');
    expect(card).not.toContain('window.open');
    expect(card).toContain('openFailed');
    expect(card).toContain('S.ext_open_failed');
    // en has NO locale prefix on the site (its default locale), every other
    // language has a lowercase one. Getting that wrong 404s in nine languages.
    expect(guideUrl('model', 'en')).toBe('https://flowmic.app/guide/model');
    expect(guideUrl('model', 'zh-CN')).toBe('https://flowmic.app/zh-cn/guide/model');
    expect(guideUrl('model', 'zh-TW')).toBe('https://flowmic.app/zh-tw/guide/model');
    for (const loc of UI_LOCALES) {
      const url = guideUrl('model', loc);
      expect(url.startsWith('https://flowmic.app/'), `${loc}: ${url}`).toBe(true);
      expect(url.endsWith('/guide/model'), `${loc}: ${url}`).toBe(true);
      expect(url, `${loc} invented an /en prefix`).not.toContain('/en/guide');
    }
  });

  it('usable:true ⇒ no card (reverse control, with the fact flipped back on)', async () => {
    usable(false);
    expect(await render(LlmSetupCard, 'en')).toContain('data-testid="llm-setup-card"'); // positive control
    usable(true);
    expect(await render(LlmSetupCard, 'en')).not.toContain('data-testid="llm-setup-card"');
  });

  it('dismissed ⇒ no card, and the dismissal is REMEMBERED under its own key', async () => {
    usable(false);
    const kv = new Map<string, string>();
    const seam = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => kv.set(k, v) };
    expect(readSetupCardDismissed(seam)).toBe(false);
    writeSetupCardDismissed(seam);
    expect(readSetupCardDismissed(seam)).toBe(true);
    expect(kv.get(K_LLM_SETUP_CARD_DISMISSED)).toBe('1');
    // The SFC reads the same key through localKv.
    localStorage.setItem(K_LLM_SETUP_CARD_DISMISSED, '1');
    expect(await render(LlmSetupCard, 'en')).not.toContain('data-testid="llm-setup-card"');
  });

  it('the pure rule: shown iff !usable && !dismissed', () => {
    expect(shouldShowLlmSetupCard({ usable: false, dismissed: false })).toBe(true);
    expect(shouldShowLlmSetupCard({ usable: true, dismissed: false })).toBe(false);
    expect(shouldShowLlmSetupCard({ usable: false, dismissed: true })).toBe(false);
    expect(shouldShowLlmSetupCard({ usable: true, dismissed: true })).toBe(false);
  });

  it('a jump switches the page AND names the section; an off-contract event names nothing', () => {
    const seen: string[] = [];
    const onSection = (ev: Event): void => {
      const s = sectionFromEvent(ev);
      if (s !== null) seen.push(s);
    };
    window.addEventListener(SETTINGS_SECTION_DOM, onSection);
    try {
      jumpToSettingsSection('llm');
      jumpToSettingsSection('stt');
      window.dispatchEvent(new CustomEvent(SETTINGS_SECTION_DOM, { detail: { section: 'about' } }));
      expect(seen).toEqual(['llm', 'stt']);
    } finally {
      window.removeEventListener(SETTINGS_SECTION_DOM, onSection);
    }
    // SettingsPage listens for exactly this event name (anti-façade: a dispatch
    // nobody listens to is a jump to nowhere).
    const page = readFileSync(fileURLToPath(new URL('./SettingsPage.vue', import.meta.url)), 'utf8');
    expect(page).toContain('SETTINGS_SECTION_DOM');
    expect(page).toContain('sectionFromEvent');
    const app = readFileSync(fileURLToPath(new URL('./App.vue', import.meta.url)), 'utf8');
    expect(app).toContain('<LlmSetupCard />');
  });
});
