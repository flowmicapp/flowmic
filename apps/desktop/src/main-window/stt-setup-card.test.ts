// Card STT-SETUP (owner ruling 2026-08-28 item 1) — asserted on the RENDERED
// result, in every UI locale.
//
// 【rendered-result】 0.2.53: what the reader can read is what the DOM contains,
// never what the catalogue holds. Every negative case here carries a positive
// control (G13: a zero can be the probe being blind rather than the code being
// right).
//
// 🔴 REVERSE CONTROL, RUN RED AND RESTORED (the suppression guard, which is the
// one piece of wiring no other test could notice). Removing `!props.suppressed &&`
// from LocalModelNotice.vue's `show` computed and re-running this file:
//
//   FAIL  src/main-window/stt-setup-card.test.ts > the setup card and the amber
//         strip never speak at once > 🔴 while the setup card is up,
//         LocalModelNotice is suppressed
//   AssertionError: expected '<!--[--><!-- role=status, not alert: …' not to
//   contain 'The built-in speech model is not ready'
//   Test Files  1 failed (1) | Tests  1 failed | 16 passed (17)
//
// The line was put back and the file is green. The other direction — the
// positive control in the same case — is what proves the strip still speaks
// when it is not suppressed, so the silence above cannot be a broken fixture.
//
// ⚠️ EVERY CASE STUBS `navigator`. Node 22 has a real `navigator.language`
// (`zh-CN` on the machine this was written on), so an unstubbed test would be
// measuring the developer's OS rather than the card.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import SttSetupCard from './components/SttSetupCard.vue';
import LocalModelNotice from './components/LocalModelNotice.vue';
import { model } from './settings-model';
import { resetModelStoreForTest } from '../lib/model-client';
import {
  BUILTIN_STT_ENGINE_ID,
  asModelsStatus,
  recommendedPackForLang,
  type ModelsStatus,
} from '../lib/model-status';
import {
  K_STT_SETUP_CARD_DISMISSED,
  hydrateSttSetupCardDismissal,
  readSttSetupCardDismissed,
  shouldShowSttSetupCard,
  sttSetupCardView,
  writeSttSetupCardDismissed,
} from '../lib/stt-setup-card';
import { S_BY_LOCALE, UI_LOCALES, setLocale, type UiLocale } from '../lib/strings';

const RECOMMENDED_ID = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const MULTILINGUAL_ID = 'sherpa-onnx-whisper-multilingual-2026-01';

/** renderToString escapes text nodes, so a sentence with an apostrophe (fr) has
 *  to be compared in its escaped form or a line that is on screen letter for
 *  letter reports as missing. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function snap(modelId: string, state: string): Record<string, unknown> {
  return {
    state,
    model_id: modelId,
    dir: 'C:\\FlowMic\\models',
    bytes_done: 0,
    bytes_total: 239_549_735,
    files_done: 0,
    files_total: 2,
    current_file: null,
    source: null,
    resumed_from_bytes: 0,
    rate_bytes_per_sec: null,
    error: null,
  };
}

/** A two-pack catalog, round-tripped through the REAL narrowing so the fixture
 *  cannot drift from the wire shape.
 *
 *  Two rows on purpose: `en` has a `recommended` pack and `fr` has only the
 *  multilingual one, which is the catalog's honest answer for French and the
 *  case the ruling calls out by name. */
function mkStatus(over: {
  ready?: readonly string[];
  busy?: string | null;
} = {}): ModelsStatus {
  const ready = new Set(over.ready ?? []);
  const face = (id: string): string => (ready.has(id) ? 'ready' : 'absent');
  const s = asModelsStatus({
    ...snap(RECOMMENDED_ID, face(RECOMMENDED_ID)),
    catalog: [
      {
        model_id: RECOMMENDED_ID,
        spoken: ['en', 'zh', 'ja', 'ko'],
        tier: 'recommended',
        loader: 'sense-voice',
        license_class: 'funasr-model',
        license: 'Model License',
        attribution: 'SenseVoice by FunAudioLLM',
        streaming: 'quasi',
        bytes_total: 239_549_735,
      },
      {
        model_id: MULTILINGUAL_ID,
        spoken: ['en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru'],
        tier: 'multilingual',
        loader: 'whisper',
        license_class: 'osi',
        license: 'Apache-2.0',
        attribution: 'Whisper by OpenAI',
        streaming: 'offline',
        bytes_total: 1_073_741_824,
      },
    ],
    models: [snap(RECOMMENDED_ID, face(RECOMMENDED_ID)), snap(MULTILINGUAL_ID, face(MULTILINGUAL_ID))],
    selected_by_lang: {},
    spoken_langs: ['en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru'],
    models_root: { dir: 'C:\\FlowMic\\models', default_dir: 'C:\\FlowMic\\models', configured: false },
    busy_model_id: over.busy ?? null,
  });
  if (s === null) throw new Error('fixture failed the wire narrowing — fix the fixture, not the test');
  return s;
}

function speaks(tag: string): void {
  vi.stubGlobal('navigator', { language: tag });
}

async function render(loc: UiLocale = 'en'): Promise<string> {
  setLocale(loc);
  const html = await renderToString(createSSRApp(SttSetupCard));
  setLocale('en');
  return html;
}

const emptyKv = new Map<string, string>();
const seam = {
  get: (k: string) => emptyKv.get(k) ?? null,
  set: (k: string, v: string) => void emptyKv.set(k, v),
};

beforeEach(() => {
  setLocale('en');
  emptyKv.clear();
  hydrateSttSetupCardDismissal(seam);
  resetModelStoreForTest();
  speaks('en-US');
  model.routings.splice(0, model.routings.length, {
    language: '*',
    engine_id: BUILTIN_STT_ENGINE_ID as never,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what the card says', () => {
  it('names the recommended pack and BOTH limitation sentences, in every locale', async () => {
    resetModelStoreForTest({ reach: 'ok', status: mkStatus() });
    for (const loc of UI_LOCALES) {
      const s = S_BY_LOCALE[loc];
      const html = await render(loc);
      expect(html, `${loc}: card absent`).toContain('data-testid="stt-setup-card"');
      expect(html).toContain(esc(s.stt_setup_title));
      // 🔴 The two sentences the owner forbade merging, both present, in full.
      expect(html, `${loc}: the local-mode limitation is missing`).toContain(esc(s.stt_setup_limit_local));
      expect(html, `${loc}: the cloud-relay clause is missing`).toContain(esc(s.stt_setup_limit_cloud));
      expect(html).toContain(esc(s.stt_setup_download));
      expect(html).toContain(esc(s.stt_setup_dismiss));
      // The pack, by name and by size — not a vague 「a model」.
      expect(html, `${loc}: pack id missing`).toContain(RECOMMENDED_ID);
      expect(html, `${loc}: pack size missing`).toContain('228 MB');
    }
  });

  it('the two limitation sentences are two distinct strings in every language', () => {
    for (const loc of UI_LOCALES) {
      const s = S_BY_LOCALE[loc];
      expect(s.stt_setup_limit_local.trim()).not.toBe('');
      expect(s.stt_setup_limit_cloud.trim()).not.toBe('');
      expect(s.stt_setup_limit_local, `${loc} merged the two`).not.toBe(s.stt_setup_limit_cloud);
      if (loc !== 'en') {
        expect(s.stt_setup_limit_local, `${loc} fell back to en`).not.toBe(S_BY_LOCALE.en.stt_setup_limit_local);
        expect(s.stt_setup_limit_cloud, `${loc} fell back to en`).not.toBe(S_BY_LOCALE.en.stt_setup_limit_cloud);
      }
    }
  });

  it('🔴 French gets the MULTILINGUAL pack, because that is the catalog answer', async () => {
    // The ruling: 「fr 无 offline 专包的现实按目录真实答案给」. No invented fr row,
    // and no silence either — the multilingual pack really does serve French.
    speaks('fr-FR');
    resetModelStoreForTest({ reach: 'ok', status: mkStatus() });
    const html = await render('fr');
    expect(html).toContain(MULTILINGUAL_ID);
    expect(html).not.toContain(RECOMMENDED_ID);
    // Its own name, in its own language — endonyms are data, never translated.
    expect(html).toContain('Français');
  });

  it('a Traditional-Chinese machine is offered the zh pack (one spoken language, one row)', async () => {
    speaks('zh-TW');
    resetModelStoreForTest({ reach: 'ok', status: mkStatus() });
    const html = await render('zh-TW');
    expect(html).toContain('data-testid="stt-setup-card"');
    expect(html).toContain(RECOMMENDED_ID);
  });
});

describe('when the card must say nothing', () => {
  it('🔴 while the local service has not answered — 「不知道」 has no download button', async () => {
    resetModelStoreForTest({ reach: 'unreachable' });
    expect(await render()).not.toContain('data-testid="stt-setup-card"');
    // Positive control: the same render WITH a status does speak.
    resetModelStoreForTest({ reach: 'ok', status: mkStatus() });
    expect(await render()).toContain('data-testid="stt-setup-card"');
  });

  it('once a pack for THIS language is ready', async () => {
    resetModelStoreForTest({ reach: 'ok', status: mkStatus({ ready: [RECOMMENDED_ID] }) });
    expect(await render()).not.toContain('data-testid="stt-setup-card"');
    // …and a ready pack for a DIFFERENT language does not quiet it: a machine
    // whose owner speaks English is not served by a ready French-only pack.
    speaks('ru-RU');
    expect(await render()).toContain('data-testid="stt-setup-card"');
  });

  it('while a download is already running anywhere on the machine', async () => {
    // Downloads are single-flight server-side; a second door to a thing in
    // motion would be refused with a 409 and its progress already has one owner.
    resetModelStoreForTest({ reach: 'ok', status: mkStatus({ busy: MULTILINGUAL_ID }) });
    expect(await render()).not.toContain('data-testid="stt-setup-card"');
  });

  it('after the reader put it away — and the dismissal is REMEMBERED under its own key', async () => {
    resetModelStoreForTest({ reach: 'ok', status: mkStatus() });
    expect(await render()).toContain('data-testid="stt-setup-card"');
    expect(readSttSetupCardDismissed(seam)).toBe(false);
    writeSttSetupCardDismissed(seam);
    expect(emptyKv.get(K_STT_SETUP_CARD_DISMISSED)).toBe('1');
    hydrateSttSetupCardDismissal(seam);
    expect(await render()).not.toContain('data-testid="stt-setup-card"');
  });

  it('when the catalog has no offerable pack for the language at all', async () => {
    // A card whose one button cannot do anything is worse than no card.
    speaks('en-US');
    const status = mkStatus();
    status.catalog.splice(0, status.catalog.length);
    resetModelStoreForTest({ reach: 'ok', status });
    expect(recommendedPackForLang(status, 'en')).toBeNull();
    expect(await render()).not.toContain('data-testid="stt-setup-card"');
  });
});

describe('the pure rule', () => {
  it('null status is refused BEFORE the pack probe is consulted', () => {
    // readyPackForLang answers null for 「unknown」 and for 「none ready」 alike —
    // its own header says so. This is the ordering that keeps the two apart.
    expect(shouldShowSttSetupCard({ status: null, language: 'en', dismissed: false })).toBe(false);
    expect(shouldShowSttSetupCard({ status: mkStatus(), language: 'en', dismissed: false })).toBe(true);
    expect(shouldShowSttSetupCard({ status: mkStatus(), language: 'en', dismissed: true })).toBe(false);
    expect(
      shouldShowSttSetupCard({ status: mkStatus({ ready: [RECOMMENDED_ID] }), language: 'en', dismissed: false }),
    ).toBe(false);
  });

  it('the view the card and App.vue share gives one answer to all three questions', () => {
    speaks('de-DE');
    resetModelStoreForTest({ reach: 'ok', status: mkStatus() });
    const v = sttSetupCardView();
    expect(v.show).toBe(true);
    expect(v.language).toBe('de');
    expect(v.pack?.model_id).toBe(MULTILINGUAL_ID);
  });
});

describe('the setup card and the amber strip never speak at once', () => {
  it('🔴 while the setup card is up, LocalModelNotice is suppressed', async () => {
    // `snapshot` set the way adopt() sets it — derived from status.legacy. The
    // strip reads that row, so leaving it null would make this case silent for
    // a reason that has nothing to do with suppression.
    const status = mkStatus();
    resetModelStoreForTest({ reach: 'ok', status, snapshot: status.legacy });
    const suppressed = await renderToString(
      createSSRApp(LocalModelNotice, { suppressed: true }),
    );
    expect(suppressed).not.toContain('The built-in speech model is not ready');
    // Positive control, same fixture: without the suppression the strip DOES
    // speak, so the silence above is the guard and not a dead component.
    const plain = await renderToString(createSSRApp(LocalModelNotice, { suppressed: false }));
    expect(plain).toContain('The built-in speech model is not ready');
  });

  it('App.vue wires the two together — the card is mounted and the strip is told', () => {
    const app = readFileSync(fileURLToPath(new URL('./App.vue', import.meta.url)), 'utf8');
    expect(app).toContain('<SttSetupCard />');
    expect(app).toContain('<LocalModelNotice :suppressed="sttSetupShown" />');
    expect(app).toContain('sttSetupCardView');
  });
});

describe('the button does the two things the ruling asks for', () => {
  /** Comments stripped first: this file's own header names the mechanisms in
   *  order to explain them, and a guard that cannot tell a rule from its
   *  violation reads its own explanation as a defect. */
  const card = readFileSync(fileURLToPath(new URL('./components/SttSetupCard.vue', import.meta.url)), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  it('starts the download WITH the language — that is what makes it usable when it lands', () => {
    // Passing `lang` records the per-language selection at download start, so
    // no second 「use this one」 press is needed once the files are there.
    expect(card).toContain('startModelDownload(pack.model_id, view.value.language)');
  });

  it('and takes the reader to where the progress is', () => {
    expect(card).toContain("jumpToSettingsSection('stt')");
    expect(card).toContain('focusLocalModelCard(view.value.language)');
  });

  it('a refused start is reported, never claimed as started', () => {
    expect(card).toContain('modelStore.actionError');
    expect(card).toContain('startFailed');
  });

  it('no dead external link mechanism anywhere in it', () => {
    expect(card).not.toContain('window.open');
    expect(card).not.toContain('_blank');
  });
});
