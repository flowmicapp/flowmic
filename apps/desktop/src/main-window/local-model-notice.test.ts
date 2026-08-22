// Component-level: the main-window notice about the built-in speech model
// (docs/strategy/2026-08-19-local-model-onboarding-design.md §5-B; LM-CAT —
// docs/strategy/2026-08-22-per-language-stt-model-catalog-task.md — keyed it
// on `anyModelReady`: ANY ready pack quiets it, because a machine with only
// the French pack downloaded has a working built-in engine and nagging it
// about "the model" would be a true sentence about the wrong subject).
//
// The rule this file is really testing is a NEGATIVE one — WHEN THE NOTICE MUST
// NOT APPEAR — and there are four ways to get that wrong, each of which renders
// fine and is wrong for a different reason:
//   · while we have not heard from the local service (the 「不知道 vs 没有」
//     conflation: a call to action built on a failed HTTP GET);
//   · when the built-in engine is not the one this machine uses;
//   · when a model is ready;
//   · after the reader put it away.
// A `v-if` chain gets one of these wrong quietly, which is why the decision is
// `shouldOfferModelSetup` and why this file renders the real component rather
// than calling that function again.
//
// ⚠️ SSR does not run `onMounted`, so mounting this component here does NOT
// start the poller it owns in production. That is convenient and it is also a
// LIMIT of this file: 「the poll is wired」 is not proved here — the wiring is
// one line in the component and its evidence is that App.vue mounts the
// component unconditionally (asserted below by reading App.vue, the same
// literal-anchor technique prefs-appearance.test.ts uses for its handlers).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import LocalModelNotice from './components/LocalModelNotice.vue';
import { resetModelStoreForTest } from '../lib/model-client';
import {
  BUILTIN_STT_ENGINE_ID,
  asModelsStatus,
  type ModelState,
  type ModelsStatus,
} from '../lib/model-status';
import { model } from './settings-model';
import { setLocale } from '../lib/strings';

/** What 「the notice is silent」 means, measured on the RENDERED output.
 *
 *  🔴 NOT `html === '<!---->'`. SSR emits the component's own template comments
 *  and its fragment anchors, so an empty render is
 *  `<!--[--><!-- role=status… --><!----><!--]-->` — a shape that changes the day
 *  somebody edits a comment. Asserting on the SENTENCES the reader would have
 *  seen is both stabler and closer to the actual question: is there a notice on
 *  this screen? Both halves are checked, the headline and the call to action,
 *  so a half-rendered banner cannot pass as silence. */
function silent(html: string): boolean {
  return !html.includes('The built-in speech model is not ready')
    && !html.includes('内蔵音声モデルの準備ができていません')
    && !html.includes('Open Settings');
}

function useEngine(engineId: string): void {
  model.routings.splice(0, model.routings.length, { language: '*', engine_id: engineId as never });
}

const LEGACY_ID = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';

function wireSnap(state: ModelState, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state,
    model_id: LEGACY_ID,
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
    ...over,
  };
}

/** A full ModelsStatus (LM-CAT wire shape) with the legacy row in `state`,
 *  round-tripped through the real narrowing so the fixture cannot drift. */
function mkStatus(state: ModelState, over: { models?: Record<string, unknown>[] } = {}): ModelsStatus {
  const legacy = wireSnap(state);
  const s = asModelsStatus({
    ...legacy,
    catalog: [{
      model_id: LEGACY_ID,
      spoken: ['en', 'zh', 'ja', 'ko'],
      tier: 'recommended',
      loader: 'sense-voice',
      license_class: 'osi',
      license: 'Apache-2.0',
      attribution: 'SenseVoice by FunAudioLLM',
      streaming: 'quasi',
      bytes_total: 239_549_735,
    }],
    models: over.models ?? [legacy],
    selected_by_lang: {},
    spoken_langs: ['en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru'],
    models_root: { dir: 'C:\\FlowMic\\models', default_dir: 'C:\\FlowMic\\models', configured: false },
    busy_model_id: state === 'downloading' ? LEGACY_ID : null,
  });
  if (s === null) throw new Error('fixture failed the wire narrowing — fix the fixture, not the test');
  return s;
}

async function render(state: ModelState | null): Promise<string> {
  if (state === null) {
    resetModelStoreForTest({ reach: 'unreachable' });
  } else {
    const status = mkStatus(state);
    // `snapshot` set the way adopt() sets it: derived from status.legacy.
    resetModelStoreForTest({ reach: 'ok', status, snapshot: status.legacy });
  }
  return renderToString(createSSRApp(LocalModelNotice));
}

describe('the main-window built-in-model notice', () => {
  beforeEach(() => {
    setLocale('en');
    resetModelStoreForTest();
    useEngine(BUILTIN_STT_ENGINE_ID);
  });

  it('appears when the built-in engine is selected and its model is absent', async () => {
    const html = await render('absent');
    expect(html).toContain('The built-in speech model is not ready');
    // 🔴 The WHY is in the notice itself, not only in Settings: the owner's
    // point was that a user must not be surprised by a network request.
    expect(html).toContain('the installer does not carry its speech model');
    expect(html).toContain('Open Settings');
    // It can be put away. §5-B: 不是模态.
    expect(html).toContain('Not now');
  });

  it('🔴 says nothing while the local service has not answered', async () => {
    expect(silent(await render(null))).toBe(true);
  });

  it('says nothing when the model is ready', async () => {
    expect(silent(await render('ready'))).toBe(true);
  });

  it('🔴 says nothing when ANY pack is ready, even though the legacy row is absent (LM-CAT)', async () => {
    // The French-pack machine: the legacy SenseVoice row is `absent`, but a
    // ready pack exists, so the built-in engine works. 「The model is missing」
    // would be a true sentence about the wrong subject.
    const anyReady = mkStatus('absent', {
      models: [wireSnap('absent'), wireSnap('ready', { model_id: 'fr-pack' })],
    });
    resetModelStoreForTest({ reach: 'ok', status: anyReady, snapshot: anyReady.legacy });
    expect(silent(await renderToString(createSSRApp(LocalModelNotice)))).toBe(true);

    // Positive control: the same fixture minus the ready pack DOES speak — so
    // the silence above came from anyModelReady, not from a broken fixture.
    const noneReady = mkStatus('absent');
    resetModelStoreForTest({ reach: 'ok', status: noneReady, snapshot: noneReady.legacy });
    expect(await renderToString(createSSRApp(LocalModelNotice)))
      .toContain('The built-in speech model is not ready');
  });

  it('says nothing to a machine that uses a different engine', async () => {
    useEngine('funasr');
    expect(silent(await render('absent'))).toBe(true);
    // Positive control for the line above: with the built-in engine back, the
    // SAME snapshot does render — so the silence was the engine gate and not a
    // broken fixture.
    useEngine(BUILTIN_STT_ENGINE_ID);
    expect(await render('absent')).toContain('The built-in speech model is not ready');
  });

  it('stays away for the session once put away', async () => {
    expect(await render('absent')).toContain('The built-in speech model is not ready');
    const status = mkStatus('absent');
    resetModelStoreForTest({
      reach: 'ok',
      noticeDismissed: true,
      status,
      snapshot: status.legacy,
    });
    expect(silent(await renderToString(createSSRApp(LocalModelNotice)))).toBe(true);
  });

  it('keeps speaking while the download runs — that state is not ready either', async () => {
    expect(await render('downloading')).toContain('The built-in speech model is not ready');
    expect(await render('partial')).toContain('The built-in speech model is not ready');
    expect(await render('failed')).toContain('The built-in speech model is not ready');
  });

  it('renders in the reader language', async () => {
    setLocale('ja');
    const html = await render('absent');
    expect(html).toContain('内蔵音声モデルの準備ができていません');
    expect(html).not.toContain('The built-in speech model is not ready');
    setLocale('en');
  });

  it('🔴 is mounted ABOVE the pages, unconditionally — so it can speak before anyone goes looking', () => {
    const app = readFileSync(fileURLToPath(new URL('./App.vue', import.meta.url)), 'utf8');
    // Unconditional: no v-if / v-show on the tag itself. The component decides
    // for itself whether to draw anything, and it also owns this window's
    // poller — a `v-if` here would silence the poll along with the notice.
    expect(app).toContain('<LocalModelNotice />');
    // Above the pages, beside the accessibility strip, not inside a page.
    expect(app.indexOf('<LocalModelNotice />')).toBeLessThan(app.indexOf('<DevicesPage'));
  });
});
