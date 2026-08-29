// Owner ruling 2026-08-27 §2-1 / §2-3: the routing table's language cell is a
// fixed list, and every row says whether the built-in engine can actually
// serve it.
//
// ── WHAT THE OWNER MET ──────────────────────────────────────────────────────
// A free-text box, and two rows (`zh` and `*`, both on the built-in engine)
// that looked configured on a machine that had downloaded nothing and could not
// transcribe a word. Neither half of that is a rendering bug on its own; the
// pair is the product telling somebody it was ready when it was not.
//
// ── 🔴 EVERY ASSERTION READS renderToString'S OUTPUT ────────────────────────
// 0.2.53's law, and this file is squarely in its territory: the whole delivery
// is 「what does the user SEE in this cell」. A test that asserted `S.*` or
// `model.routings` would be green for a screen showing a raw asterisk.
//
// ⚠️ KNOW YOUR RULER (inherited from local-model-card.test.ts's header): SSR
// output CONTAINS the template's HTML comments. `not.toContain` here is
// asserting against SttSettings.vue's prose as well as its copy — hence the
// asterisk case below tests for a rendered OPTION rather than for the absence
// of the character, which appears in comments and in `'*'` literals.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import SttSettings from './components/SttSettings.vue';
import { addRouting, model, type Routing } from './settings-model';
import { resetModelStoreForTest } from '../lib/model-client';
import { asModelsStatus, type ModelsStatus } from '../lib/model-status';
import { S, setLocale } from '../lib/strings';
import { SETTINGS_MSG } from '../lib/strings/settings';

const PACK_ID = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const ROOT_DIR = 'C:\\Users\\owner\\AppData\\Roaming\\FlowMic\\models';

function wireSnap(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'absent',
    model_id: PACK_ID,
    dir: `${ROOT_DIR}\\sense-voice`,
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

/** Built through the REAL narrowing, so a fixture that drifts from the wire
 *  contract fails here instead of quietly rendering. */
function mkStatus(state: 'absent' | 'ready'): ModelsStatus {
  const legacy = wireSnap({ state });
  const s = asModelsStatus({
    ...legacy,
    catalog: [{
      model_id: PACK_ID,
      spoken: ['en', 'zh', 'ja', 'ko'],
      tier: 'recommended',
      loader: 'sense-voice',
      license_class: 'osi',
      license: 'Apache-2.0',
      attribution: 'SenseVoice by FunAudioLLM',
      streaming: 'quasi',
      bytes_total: 239_549_735,
    }],
    models: [legacy],
    selected_by_lang: {},
    spoken_langs: ['en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru'],
    models_root: { dir: ROOT_DIR, default_dir: ROOT_DIR, configured: false },
    busy_model_id: null,
  });
  if (s === null) throw new Error('fixture failed the wire narrowing — fix the fixture, not the test');
  return s;
}

const R = (language: string, engine_id: Routing['engine_id'] = 'sherpa-local'): Routing => ({ language, engine_id });

async function render(routings: Routing[], status: ModelsStatus | null): Promise<string> {
  model.routings = routings;
  resetModelStoreForTest({ reach: status === null ? 'unknown' : 'ok', status, snapshot: status?.legacy ?? null });
  return renderToString(createSSRApp(SttSettings));
}

/** Every `<option>` in the render, as `[value, label]`. */
function options(html: string): [string, string][] {
  return [...html.matchAll(/<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)]
    .map((m) => [m[1] ?? '', (m[2] ?? '').trim()]);
}

describe('the routing table language cell is a fixed list', () => {
  beforeEach(() => {
    setLocale('en');
    resetModelStoreForTest();
  });

  it('🔴 the cell is a select, and the old free-text input is gone', async () => {
    const html = await render([R('zh')], mkStatus('ready'));
    // Positive control first: the section really rendered.
    expect(html).toContain(S.stt_title);
    // The eight spoken languages arrive as options with their own names.
    const opts = options(html);
    for (const [code, endonym] of [['en', 'English'], ['zh', '中文'], ['ja', '日本語'], ['ru', 'Русский']] as const) {
      expect(opts, `${code} is not offered`).toContainEqual([code, endonym]);
    }
    // 🔴 And the input that used to hold the language is gone. Scoped to the
    // ROUTING TABLE, because the section also carries the dictionary's own
    // `class="input"` box — counting inputs across the whole render measured
    // that one too and read 2 for a correct table (know your ruler; caught on
    // the first run of this very assertion).
    const table = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
    expect(table, 'the routing table did not render').toContain('<select');
    const inputs = [...table.matchAll(/<input\b/g)];
    expect(inputs.length, 'a text input still holds a language').toBe(1);
  });

  it('🔴 the wildcard row renders a SENTENCE, never a raw asterisk', async () => {
    const html = await render([R('*')], mkStatus('ready'));
    const opts = options(html);
    // The option exists, carries the '*' VALUE (it is what gets stored) and a
    // human label. A user reading 「*」 has been handed our storage format.
    expect(opts).toContainEqual(['*', S.stt_lang_fallback]);
    expect(opts.some(([v, label]) => v === '*' && label === '*')).toBe(false);
  });

  it('an unknown stored code is shown RAW, badged, and not rewritten', async () => {
    const html = await render([R('klingon')], mkStatus('ready'));
    expect(html).toContain('klingon');
    expect(html).toContain(S.stt_lang_unsupported);
    expect(html).toContain(S.stt_lang_unsupported_note);
    // The stored value is still selectable — the user replaces it, we do not.
    expect(options(html)).toContainEqual(['klingon', 'klingon']);
    expect(model.routings[0]!.language, 'the stored value was rewritten').toBe('klingon');
  });

  it('🔴 CONTROL — a regional code that WORKS is not badged as unsupported', async () => {
    // Every install that ever opened this page owns a `zh-CN` row, and since
    // the router's region normalisation it routes. Painting it red would be a
    // fresh lie in the opposite direction. It gets its language's name and its
    // raw code, and no badge.
    const html = await render([R('zh-CN')], mkStatus('ready'));
    expect(html).not.toContain(S.stt_lang_unsupported_note);
    expect(options(html)).toContainEqual(['zh-CN', '中文 (zh-CN)']);
  });
});

describe('every built-in row says whether it can serve its language', () => {
  beforeEach(() => {
    setLocale('en');
    resetModelStoreForTest();
  });

  it('🔴 owner empty state: a fresh install shows the red guidance and the way out', async () => {
    // Nothing downloaded. This is the machine the owner reported: two seeded
    // rows on the built-in engine, and a phone that gets 「no transcription
    // engine」 the moment anybody speaks.
    const html = await render([R('zh'), R('*')], mkStatus('absent'));
    expect(html).toContain(S.stt_model_missing);
    expect(html).toContain(S.stt_model_missing_action);
    // It must NOT also claim a model is ready — the two sentences are the two
    // arms of one question.
    expect(html).not.toContain('Local model ready');
  });

  it('a ready pack turns the line green AND names the pack', async () => {
    const html = await render([R('zh')], mkStatus('ready'));
    expect(html).toContain(SETTINGS_MSG.sttModelReady(PACK_ID));
    expect(html).not.toContain(S.stt_model_missing);
  });

  it('🔴 「we could not ask」 renders NEITHER sentence', async () => {
    // The knowledge face. A local service that has not answered is not a
    // machine without a model, and only one of those two has a red call to
    // action under it.
    const html = await render([R('zh')], null);
    expect(html).toContain(S.stt_title); // positive control: it did render
    expect(html).not.toContain(S.stt_model_missing);
    expect(html).not.toContain('Local model ready');
  });

  it('a row on a CLOUD engine is not nagged about a local model', async () => {
    // Same rule §5-B keeps for the main-window notice: a standing warning about
    // an engine this row does not use is how a product teaches people to ignore
    // warnings.
    const html = await render([R('zh', 'deepgram')], mkStatus('absent'));
    expect(html).toContain(S.stt_title);
    expect(html).not.toContain(S.stt_model_missing);
  });

  it('a language with no pack at all is still told, not left blank', async () => {
    // French has no row in this fixture's catalog. 「Nothing is ready」 is the
    // true sentence and the card below is where the reader finds out that
    // nothing CAN be — the table does not have to guess which it is.
    const html = await render([R('fr')], mkStatus('ready'));
    expect(html).toContain(S.stt_model_missing);
  });
});

describe('adding a language', () => {
  beforeEach(() => {
    setLocale('en');
    model.routings = [];
  });

  it('🔴 defaults to English, not to a second wildcard (owner §2-1)', async () => {
    addRouting();
    expect(model.routings[0]!.language).toBe('en');
    // …and it renders as the endonym, selected.
    const html = await render(model.routings as Routing[], mkStatus('ready'));
    expect(html).toMatch(/<option value="en"[^>]*selected>English<\/option>/);
  });
});
