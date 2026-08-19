// Component-level: the main-window notice about the built-in speech model
// (docs/strategy/2026-08-19-local-model-onboarding-design.md §5-B).
//
// The rule this file is really testing is a NEGATIVE one — WHEN THE NOTICE MUST
// NOT APPEAR — and there are four ways to get that wrong, each of which renders
// fine and is wrong for a different reason:
//   · while we have not heard from the local service (the 「不知道 vs 没有」
//     conflation: a call to action built on a failed HTTP GET);
//   · when the built-in engine is not the one this machine uses;
//   · when the model is ready;
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
import { BUILTIN_STT_ENGINE_ID, type ModelState } from '../lib/model-status';
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

async function render(state: ModelState | null): Promise<string> {
  resetModelStoreForTest(
    state === null
      ? { reach: 'unreachable' }
      : {
          reach: 'ok',
          snapshot: {
            state,
            model_id: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
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
          },
        },
  );
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
    resetModelStoreForTest({
      reach: 'ok',
      noticeDismissed: true,
      snapshot: {
        state: 'absent', model_id: '', dir: '', bytes_done: 0, bytes_total: null,
        files_done: 0, files_total: 0, current_file: null, source: null,
        resumed_from_bytes: 0, rate_bytes_per_sec: null, error: null,
      },
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
