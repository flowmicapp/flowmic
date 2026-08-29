// Owner ruling 2026-08-27 §2-4: the local-model card gets LAYERS.
//
// The owner's words about the previous version were 「全是文字、很乱、不知道点
// 哪」— all prose, no structure, nowhere obvious to click. The five-state
// behaviour is unchanged and is pinned next door in local-model-card.test.ts;
// what this file pins is the STRUCTURE, and one new fact the card did not
// state before: whether this language can be transcribed right now.
//
// ── 🔴 EVERY ASSERTION READS renderToString'S OUTPUT ────────────────────────
// 0.2.53. A card whose new strip exists in the catalogue and never mounts is
// exactly the shipping defect this repo has paid for twice.
//
// ⚠️ KNOW YOUR RULER, again: SSR output CONTAINS the template's HTML comments,
// so `not.toContain` here is asserting against the component's prose too. The
// negative cases below are therefore written against RENDERED ELEMENTS (a
// class, an option) rather than against phrases that a comment might quote.
//
// ── 🔴 REVERSE CONTROL, ACTUALLY RUN ────────────────────────────────────────
// The claim these cases and their twin in stt-language-select.test.ts exist to
// defend is the owner's: 「已配好/已下载引擎 ⇒ 指向本地默认引擎；什么都没有 ⇒
// 显式空态 + 红字提醒」. The tempting wrong implementation is to answer
// 「what is in use」 from the CATALOG or the SELECTION instead of from what is
// on disk — a preference rendered as a fact. So `readyPackForLang`'s readiness
// test in lib/model-status.ts was temporarily replaced with
//     const isReady = (_e: CatalogEntry): boolean => true;   // was: state === 'ready'
// and the two suites re-run. VERBATIM READINGS, 2026-08-27, machine dev-pc-a:
//
//   × the local model card is layered (owner 2026-08-27 §2-4) > ② 🔴
//     「currently in use」 says NOTHING IS when nothing is ready
//   AssertionError: expected '<!--[--><div class="sub-h" data-v-8f7…' to contain
//   'No local model for this language yet …'
//
//   × the local model card is layered (owner 2026-08-27 §2-4) > ② 🔴 a SELECTED
//     but not-downloaded pack is NOT reported as in use
//   AssertionError: expected '<!--[--><div class="sub-h" data-v-8f7…' to contain
//   'class="none inuse-strip"'
//
//   × every built-in row says whether it can serve its language > 🔴 owner empty
//     state: a fresh install shows the red guidance and the way out
//   AssertionError: expected '<div class="set-sec" data-v-d4d501ee>…' to contain
//   'No local model for this language yet …'
//
//   Tests  3 failed | 18 passed (21)
//
// Both surfaces went red together, which is the point: one broken fact, two
// screens, and the owner meets both in one sitting. The file was restored from
// a copy taken before the edit; `grep -rn REVERSE-CONTROL apps/desktop/src`
// returns only two unrelated pre-existing lines, and 21/21 are green again.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import LocalModelCard from './components/LocalModelCard.vue';
import { resetModelStoreForTest } from '../lib/model-client';
import { asModelsStatus, type ModelsStatus } from '../lib/model-status';
import { LOCAL_MODEL_CARD_ID, resetModelCardFocusForTest } from '../lib/model-card-focus';
import { S, setLocale } from '../lib/strings';

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

function wireEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_id: PACK_ID,
    // ⚠️ MUST INCLUDE 'en'. The card defaults its picker to the reader's UI
    // language and `setLocale('en')` is what every case here runs under, so a
    // catalog row that does not claim `en` renders ZERO pack rows and four of
    // the assertions below go red against a correct component. (That is how
    // this fixture was first written, and how it first failed — the ruler, not
    // the subject.) The zero-row case overrides `spoken` explicitly.
    spoken: ['en', 'zh', 'ja', 'ko'],
    tier: 'recommended',
    loader: 'sense-voice',
    license_class: 'osi',
    license: 'Apache-2.0',
    attribution: 'SenseVoice by FunAudioLLM',
    streaming: 'quasi',
    bytes_total: 239_549_735,
    ...over,
  };
}

function mkStatus(over: {
  legacy?: Record<string, unknown>;
  catalog?: Record<string, unknown>[];
  models?: Record<string, unknown>[];
  selected?: Record<string, string>;
} = {}): ModelsStatus {
  const legacy = wireSnap(over.legacy);
  const s = asModelsStatus({
    ...legacy,
    catalog: over.catalog ?? [wireEntry()],
    models: over.models ?? [legacy],
    selected_by_lang: over.selected ?? {},
    spoken_langs: ['en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru'],
    models_root: { dir: ROOT_DIR, default_dir: ROOT_DIR, configured: false },
    busy_model_id: legacy.state === 'downloading' ? (legacy.model_id as string) : null,
  });
  if (s === null) throw new Error('fixture failed the wire narrowing — fix the fixture, not the test');
  return s;
}

async function render(status: ModelsStatus | null): Promise<string> {
  resetModelStoreForTest({ reach: status === null ? 'unknown' : 'ok', status, snapshot: status?.legacy ?? null });
  return renderToString(createSSRApp(LocalModelCard));
}

describe('the local model card is layered (owner 2026-08-27 §2-4)', () => {
  beforeEach(() => {
    setLocale('en');
    resetModelStoreForTest();
    resetModelCardFocusForTest();
  });

  it('carries the anchor the routing table scrolls to', async () => {
    // 🔴 The id is imported, never retyped. A scroll target that silently
    // misses is indistinguishable from one that works — `getElementById`
    // returning null throws nothing and does nothing — so the only thing that
    // can catch a rename is both sides naming one constant.
    expect(await render(mkStatus())).toContain(`id="${LOCAL_MODEL_CARD_ID}"`);
  });

  it('① the language picker is a labelled control in its own band', async () => {
    const html = await render(mkStatus());
    expect(html).toContain('class="langband"');
    expect(html).toContain(S.model_lang_label);
    // The label is bound to the control, not merely placed near it.
    expect(html).toMatch(/<label[^>]*for="fm-model-lang"/);
    expect(html).toMatch(/<select id="fm-model-lang"/);
  });

  it('② 🔴 「currently in use」 says NOTHING IS when nothing is ready', async () => {
    // The owner's empty-state ruling on this surface. A pack list with no
    // statement about whether the language works at all is the state the card
    // shipped in, and the reader had to assemble the answer from chips.
    const html = await render(mkStatus({ legacy: { state: 'absent' } }));
    expect(html).toContain(S.model_in_use_title);
    expect(html).toContain(S.model_in_use_none);
    expect(html).toContain('inuse-strip');
    expect(html).toContain('class="none inuse-strip"');
  });

  it('② and names the pack when one IS ready', async () => {
    const html = await render(mkStatus({ legacy: { state: 'ready' } }));
    expect(html).toContain('class="have inuse-strip"');
    expect(html).not.toContain(S.model_in_use_none);
    // The strip names WHICH pack — 「a model is ready」 is true of a machine
    // with eight packs and answers a different question.
    const strip = html.slice(html.indexOf('inuse-strip'), html.indexOf('class="pack"'));
    expect(strip).toContain(PACK_ID);
  });

  it('② 🔴 a SELECTED but not-downloaded pack is NOT reported as in use', async () => {
    // A selection is a preference; it can name a pack that was cancelled
    // halfway or failed verification. Rendering the preference under the words
    // 「currently in use」 would put a model name on screen for a language that
    // cannot be transcribed — R11 in one line.
    const html = await render(mkStatus({ legacy: { state: 'partial' }, selected: { en: PACK_ID } }));
    expect(html).toContain('class="none inuse-strip"');
    expect(html).toContain(S.model_in_use_none);
  });

  it('③ each pack row has exactly ONE action button, and the facts are chips', async () => {
    const html = await render(mkStatus({ legacy: { state: 'absent' } }));
    // Sliced to the pack list's own end (the 「place the files by hand」
    // sentence that always follows it), not to a serialiser artefact: an
    // `<!--]-->` marker is Vue's fragment bookkeeping and would move under us.
    const pack = html.slice(html.indexOf('class="pack"'), html.indexOf(S.model_manual));
    const buttons = [...pack.matchAll(/<button\b/g)];
    expect(buttons.length, 'a pack row grew a toolbar').toBe(1);
    // licence / latency / size, as chips rather than a run-on line
    expect(pack).toContain('class="chip meta"');
    expect(pack).toContain(S.model_lic_osi);
    expect(pack).toContain(S.model_stream_quasi);
  });

  it('③ a language the catalog lists no pack for gets an empty state, not silence', async () => {
    // Russian is in `spoken_langs` and in no catalog row here. Rendering
    // nothing would leave a reader waiting for a list that will never arrive.
    const html = await render(mkStatus({ catalog: [wireEntry({ spoken: ['zh'] })] }));
    // The picker defaults to the UI language (en), which this catalog does not
    // cover — so this is the zero-row case without touching the control.
    expect(html).toContain(S.model_no_packs);
    expect(html).not.toContain('class="pack"');
  });

  it('④ the in-flight numbers live in a bounded block, not loose under the row', async () => {
    const html = await render(mkStatus({
      legacy: { state: 'downloading', bytes_done: 100_000_000, current_file: 'model.onnx' },
    }));
    expect(html).toContain('class="dlblock"');
    const block = html.slice(html.indexOf('class="dlblock"'));
    expect(block).toContain(S.model_downloaded);
    expect(block).toContain(S.model_cancel_note);
  });

  it('⑤ storage is demoted into a fold — collapsed, but present and complete', async () => {
    const html = await render(mkStatus());
    expect(html).toContain(S.model_storage_title);
    const fold = html.slice(html.indexOf(S.model_storage_title));
    // 🔴 Collapsed, NOT removed: `model_manual` promises the folder is 「below」
    // and a promise the screen does not keep is the defect this repo names most
    // often. Every control that was on the row is still in the fold.
    expect(fold).toContain(ROOT_DIR);
    expect(fold).toContain(S.model_root_change);
    expect(fold).toContain(S.model_copy);
    expect(fold).toContain(S.model_root_note);
  });

  it('⑥ the technical fold still exists when there is machine truth to fold', async () => {
    const html = await render(mkStatus({
      legacy: { state: 'failed', error: { code: 'HTTP_403', message: 'forbidden' } },
    }));
    expect(html).toContain(S.model_detail);
    expect(html).toContain('HTTP_403');
  });

  it('a card that could not read a status shows none of the layers', async () => {
    // 「We could not ask」 is not 「there is no model」, and only one of them may
    // carry a red empty state.
    const html = await render(null);
    expect(html).toContain(S.model_connecting_note); // positive control
    expect(html).not.toContain('inuse-strip');
    expect(html).not.toContain('class="langband"');
  });
});
