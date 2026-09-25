// Component-level: what the built-in-model card ACTUALLY RENDERS
// (docs/strategy/2026-08-19-local-model-onboarding-design.md §5-A, as reshaped
// by LM-CAT — docs/archive/strategy/2026-08-22-per-language-stt-model-catalog-task.md:
// the card now lists PER-LANGUAGE PACK ROWS from `status.catalog`/`models`,
// with one global progress block for the busy pack, a licence label rendered
// from `license_class` DATA, and a movable download folder row).
//
// ── WHY THESE ASSERTIONS ARE AGAINST HTML AND NOT AGAINST `S.model_*` ────────
// 0.2.53's rule, paid for on a phone screen: a test that asserts a catalogue
// constant is green while the user reads three letters. Every expectation below
// reads the string out of `renderToString`'s output, so a key that is never
// mounted, a `v-if` that hides the wrong branch, or a number composed in the
// template rather than the module is caught here and nowhere else.
//
// Render path = `vue/server-renderer`, the same choice and the same reason as
// prefs-appearance.test.ts: vitest compiles SFCs in their SSR form.
//
// ⚠️ KNOW YOUR RULER: SSR output CONTAINS THE TEMPLATE'S HTML COMMENTS. So a
// `not.toContain` here is asserting against the component's prose as well as its
// copy, and a comment in LocalModelCard.vue that happened to quote a banned
// phrase would redden a test about the screen. That is a real trap and it is
// written down rather than discovered: the env-var count test below would read
// 2 the day someone mentions the variable in a comment.
//
// ── 🔴 NEGATIVE CONTROL, ACTUALLY RUN ───────────────────────────────────────
// The assertion this whole file exists for is 「an unknown total never renders as
// a percentage」. To prove the test can SEE that, `percentDone`'s null arm in
// lib/model-status.ts was temporarily changed to
//     if (total === null || total <= 0) return 0;      // was: return null
// and the suites were re-run. VERBATIM READINGS, 2026-08-19, machine
// dev-pc-a:
//
//   × the built-in speech model card > 🔴 an unknown total renders as words,
//     never as 0% / 100% / NaN
//   AssertionError: an unknown total must not be rendered as a percentage:
//   expected '<!--[--><div class="sub-h" data-v-8f7…' not to contain '0%'
//     + Received: … <div class="bar"><div class="fill" style="width:0%;"></div>
//       </div><div class="row nums"><span class="pctv">0%</span><span class="sub">
//       Downloaded 98.1 MB / total size unknown</span> …
//
//   × the built-in speech model card > partial with no total — resumes without
//     inventing a percentage
//   AssertionError: expected '<!--[--><div class="sub-h" data-v-8f7…' not to
//   contain '% done'
//     + Received: … <button class="btn pri">Resume the download (0% done)</button> …
//
//   Tests  2 failed | 14 passed (16)
//
// and, one layer down, the arithmetic test saw it too:
//   × percentDone > is null when the total is unknown — not 0, not 100
//   AssertionError: expected +0 to be null      Tests  1 failed | 21 passed (22)
//
// Look at what the first reading actually rendered: a ZERO-WIDTH bar and a
// confident 「0%」 sitting on the same line as 「Downloaded 98.1 MB」 — the screen
// contradicting itself, for a download that was in fact 98 MB in. That is the
// exact face §4 wrote `null` into the contract to prevent, and it is why one
// `> 0` in `asModelSnapshot` and one `null` here are load-bearing.
//
// [LM-CAT note, 2026-08-22: those readings were taken on the pre-catalog
// single-model card. The contract MOVED — the progress block now hangs off the
// busy pack's `models[]` row — but the property is the same `percentDone` null
// arm, and the unknown-total case below still pins it at HTML level, so the
// history above is kept rather than re-run.]
//
// The file was restored from a copy taken before the edit; `grep -rn
// REVERSE-CONTROL apps/desktop/src` returns only an unrelated pre-existing line
// in cloud-signout-confirm.test.ts, and the suites are green again.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

// bridge.ts is on the import path (model-client → bridge) and loads these at
// module scope; nothing here invokes anything.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import LocalModelCard from './components/LocalModelCard.vue';
import { resetModelStoreForTest, type ModelStore } from '../lib/model-client';
import { asModelsStatus, type ModelsStatus } from '../lib/model-status';
import { S, setLocale } from '../lib/strings';
import { UI_LOCALES, type UiLocale } from '../lib/strings/locale';

/** The real manifest total (model-manifest.ts), so every figure below is one a
 *  user will see: 239,233,841 + 315,894 = 228.5 MiB. */
const REAL_TOTAL = 239_233_841 + 315_894;
const PACK_ID = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
/** LM-CAT: the path on the card is the models ROOT (`models_root.dir`), not the
 *  legacy snapshot's per-pack dir — the folder row is the user-movable root. */
const ROOT_DIR = 'C:\\Users\\owner\\AppData\\Roaming\\FlowMic\\models';

function wireSnap(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'absent',
    model_id: PACK_ID,
    dir: `${ROOT_DIR}\\sense-voice`,
    bytes_done: 0,
    bytes_total: REAL_TOTAL,
    files_done: 0,
    files_total: 2,
    current_file: null,
    source: null,
    resumed_from_bytes: 0,
    rate_bytes_per_sec: null,
    // NR-7: the MEASURED occupancy of the pack folder. 0 by default, matching
    // the default `absent` state — nothing on disk, nothing to delete.
    disk_bytes: 0,
    error: null,
    ...over,
  };
}

/** A catalog row. The attribution text is deliberately free of every phrase
 *  asserted below, so a fixture cannot green a copy assertion by accident. */
function wireEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_id: PACK_ID,
    spoken: ['en', 'zh', 'ja', 'ko'],
    tier: 'recommended',
    loader: 'sense-voice',
    license_class: 'osi',
    license: 'Apache-2.0',
    attribution: 'SenseVoice by FunAudioLLM',
    streaming: 'quasi',
    bytes_total: REAL_TOTAL,
    ...over,
  };
}

/** A full ModelsStatus from partial overrides, built by round-tripping the
 *  SERVER body shape through the real narrowing — so a fixture that drifts
 *  from the wire contract fails loudly here instead of quietly rendering. */
function mkStatus(over: {
  legacy?: Record<string, unknown>;
  catalog?: Record<string, unknown>[];
  models?: Record<string, unknown>[];
  selected?: Record<string, string>;
  busy?: string | null;
  rootDir?: string;
  inUse?: string[];
} = {}): ModelsStatus {
  const legacy = wireSnap(over.legacy);
  const body = {
    ...legacy,
    catalog: over.catalog ?? [wireEntry()],
    models: over.models ?? [legacy],
    selected_by_lang: over.selected ?? {},
    spoken_langs: ['en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru'],
    models_root: { dir: over.rootDir ?? ROOT_DIR, default_dir: ROOT_DIR, configured: false },
    busy_model_id: over.busy !== undefined
      ? over.busy
      : (legacy.state === 'downloading' ? (legacy.model_id as string) : null),
    in_use_model_ids: over.inUse ?? [],
  };
  const s = asModelsStatus(body);
  if (s === null) throw new Error('fixture failed the wire narrowing — fix the fixture, not the test');
  return s;
}

/** One pack in one state — the shape most cases need. */
function st(over: Record<string, unknown> = {}): ModelsStatus {
  return mkStatus({ legacy: over });
}

async function render(state: Partial<ModelStore>): Promise<string> {
  const status = (state.status ?? null) as ModelsStatus | null;
  // `snapshot` mirrors what adopt() does: always derived from status.legacy.
  resetModelStoreForTest({ reach: 'ok', snapshot: status?.legacy ?? null, ...state });
  return renderToString(createSSRApp(LocalModelCard));
}

/** A settled rate history: three readings inside a factor of two ⇒ [stableRate]
 *  answers and the card is allowed to name a time. 1 MiB/s. */
const SETTLED = [1_048_576, 1_100_000, 1_000_000];

/** Every <button> element in the render, as [fullTag+innerHTML, innerHTML]. */
function buttons(html: string): { outer: string; inner: string }[] {
  return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
    .map((m) => ({ outer: m[0] ?? '', inner: m[1] ?? '' }));
}

describe('the built-in speech model card', () => {
  beforeEach(() => {
    setLocale('en');
    resetModelStoreForTest();
  });

  it('says WHY there is a download at all, in every state including ready', async () => {
    for (const state of ['absent', 'ready', 'downloading', 'failed', 'partial'] as const) {
      const html = await render({ status: st({ state }) });
      expect(html, `${state}: the reason the installer does not carry the model went missing`)
        .toContain('The speech model is large, so the installer does not include it');
    }
  });

  it('absent — offers the download WITH the size taken from the catalog entry', async () => {
    const html = await render({ status: st({ state: 'absent' }) });
    expect(html).toContain('Not downloaded');
    // 228 = REAL_TOTAL / 1024², rounded. Nothing in the catalogue spells it.
    // LM-CAT: the figure now comes from the CATALOG row's bytes_total (a fact
    // about the pack), no longer from the disk snapshot.
    expect(html).toContain('Download the model (about 228 MB, one time)');
    // The second exit is stated on the same screen as the first.
    expect(html).toContain('connect your own model or API in the table above');
    // The folder on the card is the movable models root now.
    expect(html).toContain(ROOT_DIR);
  });

  it('absent with no total — the button says nothing about size rather than guessing', async () => {
    const html = await render({
      status: mkStatus({
        legacy: { state: 'absent', bytes_total: null },
        catalog: [wireEntry({ bytes_total: null })],
      }),
    });
    expect(html).toContain('Download the model (one time)');
    expect(html).not.toContain('about');
    expect(html).not.toContain('MB,');
  });

  it('partial — names how far along it is, because that is why resuming is cheap', async () => {
    // `ceil`, not `round`, and the difference is the point: [percentDone]
    // FLOORS, so `round(0.43 × total)` lands a hair under the boundary and
    // renders 42 %. That is the correct behaviour (a bar must never round UP
    // into a number it has not reached) and it is why the fixture asks for a
    // byte count that is genuinely at 43 %.
    const html = await render({
      status: st({ state: 'partial', bytes_done: Math.ceil(REAL_TOTAL * 0.43) }),
    });
    expect(html).toContain('Partly downloaded');
    expect(html).toContain('Resume the download (43% done)');
  });

  it('partial with no total — resumes without inventing a percentage', async () => {
    const html = await render({
      status: mkStatus({
        legacy: { state: 'partial', bytes_done: 50_000_000, bytes_total: null },
        catalog: [wireEntry({ bytes_total: null })],
      }),
    });
    expect(html).toContain('Resume the download');
    expect(html).not.toContain('% done');
  });

  it('downloading — bytes, percent, rate, which file, WHICH SOURCE', async () => {
    const html = await render({
      status: st({
        state: 'downloading',
        bytes_done: 102_900_000,
        files_done: 0,
        files_total: 2,
        current_file: 'model.int8.onnx',
        source: 'hf',
        rate_bytes_per_sec: 1_048_576,
      }),
      rateSamples: [...SETTLED],
    });
    expect(html).toContain('Downloading');
    expect(html).toContain('42%');
    expect(html).toContain('98.1 MB / 228.5 MB');
    expect(html).toContain('1.0 MB/s');
    expect(html).toContain('File 1 of 2');
    expect(html).toContain('model.int8.onnx');
    expect(html).toContain('Hugging Face');
    // Stopping must say what it keeps, or nobody on a slow link would press it.
    expect(html).toContain('the next attempt carries on from there');
  });

  it('downloading — the source label FOLLOWS the failover, so a move is visible', async () => {
    const first = await render({ status: st({ state: 'downloading', source: 'hf' }) });
    expect(first).toContain('Hugging Face');
    expect(first).not.toContain('hf-mirror.com');

    const second = await render({ status: st({ state: 'downloading', source: 'hf-mirror' }) });
    expect(second).toContain('hf-mirror.com');
    // Positive control for the line above: the note that explains WHY the name
    // changed has to be on screen too, or the reader just sees it change.
    expect(second).toContain('the download moves on to the next one');
  });

  it('🔴 an unknown total renders as words, never as 0% / 100% / NaN', async () => {
    const html = await render({
      status: mkStatus({
        legacy: { state: 'downloading', bytes_done: 102_900_000, bytes_total: null },
        catalog: [wireEntry({ bytes_total: null })],
      }),
      rateSamples: [...SETTLED],
    });
    expect(html).toContain('total size unknown');
    // The measured half is still shown: 「I don't know the total」 is not
    // 「I don't know anything」.
    expect(html).toContain('98.1 MB');
    expect(html, 'an unknown total must not be rendered as a percentage').not.toContain('0%');
    expect(html).not.toContain('100%');
    expect(html).not.toContain('NaN');
    // And the time is refused for the RIGHT reason — this one never resolves,
    // unlike 「estimating」, so it must not borrow that word.
    expect(html).toContain('the time left cannot be worked out without the total size');
    expect(html).not.toContain('estimating');
  });

  it('🔴 a resumed download says so, and says from where', async () => {
    const html = await render({
      status: st({
        state: 'downloading',
        bytes_done: 60_000_000,
        resumed_from_bytes: 51_200_000,
        source: 'hf',
      }),
      rateSamples: [...SETTLED],
    });
    // 51,200,000 / 1024² = 48.8. Without this line a bar that starts at 21%
    // reads as a broken progress bar rather than as work already done.
    expect(html).toContain('resumed — 48.8 MB was already on disk');
  });

  it('does not promise a time it has not measured — and says which kind of no', async () => {
    const unsettled = await render({
      status: st({ state: 'downloading', bytes_done: 1_000_000, rate_bytes_per_sec: 900_000 }),
      rateSamples: [900_000], // one reading: not a rate yet
    });
    expect(unsettled).toContain('estimating the time left');
    expect(unsettled).not.toContain('min left');

    const settled = await render({
      status: st({ state: 'downloading', bytes_done: 100_000_000 }),
      rateSamples: [...SETTLED],
    });
    // (239,549,735 − 100,000,000) / 1,048,576 B/s ≈ 133 s ⇒ 2 min.
    expect(settled).toContain('about 2 min left');
  });

  it('ready — says downloaded, offers the recheck, and never a download', async () => {
    // [LM-CAT re-expression] The old card's 「the built-in engine uses it by
    // default / Every file has been verified」 sentence (model_verified) is no
    // longer rendered anywhere on the per-language card — 「default」 stopped
    // being a fact when selection became per-language. The closest true
    // properties are pinned instead: the ready chip, the recheck action, no
    // download offer, and the selection chip driven by selected_by_lang below.
    const html = await render({ status: st({ state: 'ready' }) });
    expect(html).toContain('Downloaded');
    expect(html).toContain('Check the files again');
    // Nothing to download, so no download offer — but a not-selected ready
    // pack can be put to use for the visible language.
    expect(html).not.toContain('Download the model');
    expect(html).toContain('Use for this language');

    const selected = await render({
      status: mkStatus({ legacy: { state: 'ready' }, selected: { en: PACK_ID } }),
    });
    expect(selected).toContain('In use for this language');
    expect(selected).not.toContain('Use for this language');
  });

  it('failed — what to DO is body copy, the machine truth is folded but kept', async () => {
    const html = await render({
      status: st({ state: 'failed', error: { code: 'ENETUNREACH', message: 'hf-mirror: no route to host' } }),
    });
    expect(html).toContain('Download failed');
    expect(html).toContain('Try again — it carries on from where it stopped');
    expect(html).toContain('check the network');
    expect(html).toContain(ROOT_DIR);
    // The developer sentence was MOVED, not deleted — LM-CAT prefixes it with
    // the pack it belongs to, because eight packs can fail independently.
    expect(html).toContain('Technical detail');
    expect(html).toContain(`${PACK_ID} — ENETUNREACH: hf-mirror: no route to host`);
  });

  it('🔴 unknown — no download offer is made on the strength of a failed read', async () => {
    const html = await render({ status: null, reach: 'unreachable' });
    // [LM-CAT re-expression] The standalone 「Unknown」 chip is gone: with no
    // status at all there are no pack rows to wear it, and the face is the
    // unreachable sentence itself.
    expect(html).toContain('not responding, so the model status cannot be read');
    expect(html).not.toContain('Download the model');
    expect(html).not.toContain('Resume the download');
    // ⚠️ Unlike the single-model card, NO action is offered here any more —
    // the recheck button now lives inside the status-bearing block, so a card
    // that has never read a status offers nothing (reported upstream: the
    // unreachable copy still tells the reader to press 「Re-check files」).
  });

  it('🔴 connecting — the launch seconds are QUIET, not a failure wearing orange', async () => {
    // The owner's 2026-08-20 report in one render: never-asked used to wear
    // the unreachable face, so every healthy cold start opened on a warning.
    // [LM-CAT note] The 「Connecting…」 chip itself is no longer rendered —
    // the quiet sentence below is the whole face now.
    const html = await render({ status: null, reach: 'unknown' });
    expect(html).toContain('starting up — the model status will appear in a moment');
    expect(html).not.toContain('not responding');
    expect(html).not.toContain('class="sub warn"');
    expect(html).not.toContain('Download the model');
  });

  // E5 (2026-09-02) — before `modelStore.sidecarPhase` existed, this exact
  // fixture (`status: null, reach: 'unknown', sidecarPhase: 'failed'`) rendered
  // the QUIET connecting sentence forever (reach never had reason to leave
  // 'unknown': `refreshModelStatus`'s `no-endpoint` branch only sets `reach` once
  // a status had already been read once) and hid the recheck button, which is
  // gated on `knowledge !== 'connecting'`.
  it('🔴 sidecar failed — its own sentence, not the quiet connecting one, and recheck is visible', async () => {
    const html = await render({ status: null, reach: 'unknown', sidecarPhase: 'failed' });
    expect(html).toContain('failed to start, so the model status cannot be read');
    expect(html).not.toContain('starting up — the model status will appear in a moment');
    expect(html).toContain('class="sub warn"'); // it is a loud fact, not the quiet one
    expect(buttons(html).some((b) => b.inner.includes('Check the files again'))).toBe(true);
  });

  it('a failed sidecar detail lands in the technical fold, same sink as any other reachReason', async () => {
    const html = await render({
      status: null,
      reach: 'unknown',
      sidecarPhase: 'failed',
      reachReason: 'listen EADDRINUSE: address already in use 127.0.0.1:34567',
    });
    expect(html).toContain('Technical detail');
    expect(html).toContain('listen EADDRINUSE: address already in use 127.0.0.1:34567');
  });

  it('🔴 answered-badly is its own sentence — a 404 is an answer, not silence', async () => {
    const html = await render({
      status: null,
      reach: 'answered_unusable',
      reachReason: 'unexpected model response (http 404)',
    });
    expect(html).toContain('responded, but could not report the model status');
    expect(html).not.toContain('not responding');
    // The machine truth is folded but kept — a failing card must carry
    // something diagnosable (the reason used to be computed and discarded).
    expect(html).toContain('unexpected model response (http 404)');
  });

  it('a stale reading is kept on screen and labelled, not blanked', async () => {
    const html = await render({
      status: st({ state: 'downloading', bytes_done: 140_000_000 }),
      reach: 'unreachable',
    });
    expect(html).toContain('58%');
    expect(html).toContain('not responding, so the model status cannot be read');
  });

  it('🔴 a pack the server listed no snapshot for is 「Unknown」, never an invented download offer', async () => {
    // 「不知道」 and 「没有」 must not share a face: a catalog row with no
    // models[] entry means the server did not answer for that pack's disk,
    // and a Download button under it would be a consent built on a guess.
    const html = await render({ status: mkStatus({ models: [] }) });
    expect(html).toContain('Unknown');
    expect(html).not.toContain('Download the model');
    expect(html).not.toContain('Resume the download');
  });

  it('🔴 the funasr licence class NEVER wears the open-source label; the OSI class does (HTML level)', async () => {
    // task §3-6: the label is keyed by `license_class` DATA. The funasr label
    // deliberately contains the lowercase 「not open source」 — the banned
    // rendering is the OSI wording, so the pin is case-sensitive on the
    // affirmative 「Open source」 (which only the OSI label carries).
    const funasr = await render({
      status: mkStatus({
        catalog: [wireEntry({ model_id: 'paraformer-zh', license_class: 'funasr-model', license: 'FunASR Model License' })],
        models: [wireSnap({ model_id: 'paraformer-zh' })],
      }),
    });
    expect(funasr).toContain('FunASR Model License (not open source)');
    expect(funasr, 'the funasr row must never be labelled as open source').not.toContain('Open source');

    // Positive control: the OSI class DOES render the affirmative label, so
    // the line above cannot pass by the label being missing everywhere.
    const osi = await render({ status: st({ state: 'absent' }) });
    expect(osi).toContain('Open source (OSI)');
  });

  it('🔴 one download machine-wide — the busy pack disables every OTHER row\'s download button, with the reason', async () => {
    const twoPacks = {
      catalog: [
        wireEntry(), // recommended, sorts first
        wireEntry({ model_id: 'whisper-multi', tier: 'multilingual', bytes_total: 500_000_000 }),
      ],
    };
    const busy = await render({
      status: mkStatus({
        ...twoPacks,
        models: [
          wireSnap({ state: 'downloading', bytes_done: 10_000_000 }),
          wireSnap({ model_id: 'whisper-multi', state: 'absent' }),
        ],
        busy: PACK_ID,
      }),
    });
    const dlBtn = buttons(busy).find((b) => b.inner.includes('Download the model'));
    expect(dlBtn, 'the other pack\'s download button went missing').toBeDefined();
    expect(dlBtn?.outer, 'the other row must stand down while one pack downloads').toContain(' disabled');
    // The refusal is SAID on the row, not silently greyed.
    expect(dlBtn?.outer).toContain('Another pack is downloading — one at a time.');

    // Negative control: with nothing busy, the same button is live — so the
    // assertion above is seeing the busy gate and not a button that is always
    // disabled.
    const idle = await render({
      status: mkStatus({
        ...twoPacks,
        models: [
          wireSnap({ state: 'partial', bytes_done: 10_000_000 }),
          wireSnap({ model_id: 'whisper-multi', state: 'absent' }),
        ],
        busy: null,
      }),
    });
    const liveBtn = buttons(idle).find((b) => b.inner.includes('Download the model'));
    expect(liveBtn).toBeDefined();
    expect(liveBtn?.outer).not.toContain(' disabled');
  });

  it('a streaming pack is a visible row with the truthful refusal, not a hidden one and not a button', async () => {
    const html = await render({
      status: mkStatus({
        catalog: [wireEntry({ model_id: 'zipformer-stream', streaming: 'streaming', tier: 'lite' })],
        models: [wireSnap({ model_id: 'zipformer-stream' })],
      }),
    });
    expect(html).toContain('Streaming pack — this version cannot use it yet');
    expect(html).not.toContain('Download the model');
  });

  it('the language picker and the movable folder row are on the card (owner 2026-08-22)', async () => {
    const html = await render({ status: st({ state: 'absent' }) });
    expect(html).toContain('Speaking language');
    expect(html).toContain('<select');
    expect(html).toContain('Download folder');
    expect(html).toContain(ROOT_DIR);
    expect(html).toContain('Change');
    // The load-bearing note: changing the folder does NOT move existing files.
    expect(html).toContain('Files already downloaded stay where they are');

    // A configured custom root renders VERBATIM — the row answers 「where do
    // my gigabytes go」, so it must show the real answer, not the default.
    const custom = await render({ status: mkStatus({ rootDir: 'D:\\FlowMicPacks' }) });
    expect(custom).toContain('D:\\FlowMicPacks');
  });

  it('the row buttons are wired to the pack-naming actions (source anchor — SSR serialises no handlers)', () => {
    // renderToString drops @click handlers, so the HTML half above cannot see
    // WHAT a press sends. The two halves together close the loop: this anchor
    // pins the wiring (pack id + language key), and model-client.test.ts pins
    // that those actions POST {model_id, lang} / {model_id} / {dir}.
    const src = readFileSync(
      fileURLToPath(new URL('./components/LocalModelCard.vue', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('startModelDownload(row.entry.model_id, langKey)');
    expect(src).toContain('cancelModelDownload(row.entry.model_id)');
    expect(src).toContain('applyModelsRoot(rootInput.value)');
    expect(src).toContain('resetModelsRoot()');
  });

  it('🔴 no environment variable, no parameter instructions, anywhere on the card (owner 2026-08-20)', async () => {
    // The fold that used to hold FLOWMIC_SHERPA_AUTO_DOWNLOAD is gone — an
    // env-var name is operator documentation, not product copy. Asserted over
    // every face, because the fold rendered unconditionally and a revert
    // would too.
    for (const state of ['absent', 'ready', 'downloading', 'failed', 'partial'] as const) {
      const html = await render({ status: st({ state }) });
      expect(html, `${state}: env var leaked back onto the card`).not.toContain(
        'FLOWMIC_SHERPA_AUTO_DOWNLOAD',
      );
      expect(html, `${state}: the unattended fold came back`).not.toContain(
        'Machines with nobody at them',
      );
    }
    // Positive control: the same render still carries real copy, so an empty
    // page cannot pass this by saying nothing at all.
    const html = await render({ status: st({ state: 'absent' }) });
    expect(html).toContain('Download the model');
  });

  // ── NR-7: deleting a pack (owner ruling 2026-09-02 §5) ────────────────────
  //
  // Every assertion below reads the RENDER, per this file's opening rule: the
  // 0.2.53 lesson is that a test which asserts a catalogue constant is green
  // while the user reads something else.

  /** The row's delete control, or undefined. Found by its label rather than by
   *  a class, because the label is what a user looks for. */
  function deleteButton(html: string): { outer: string; inner: string } | undefined {
    return buttons(html).find((b) => b.inner.includes('Delete'));
  }

  it('NR-7: a downloaded pack shows the MEASURED size on disk and a delete control', async () => {
    const html = await render({
      status: mkStatus({ legacy: { state: 'ready', bytes_done: REAL_TOTAL, disk_bytes: REAL_TOTAL } }),
    });
    // 「删除前提示大小」 — the size is on screen BEFORE the press, not inside a
    // confirmation nobody has seen yet.
    expect(html).toContain('Downloaded 228 MB');
    const del = deleteButton(html);
    expect(del, 'a downloaded pack must offer a way to remove it').toBeDefined();
    expect(del?.outer).not.toContain('disabled');
  });

  it('NR-7: the size beside the delete control is the one ON DISK, not the declared one', async () => {
    // The pack's catalog row still declares 228 MB; the disk holds half of it
    // (a cancelled download's remainder). A control that freed 「228 MB」 and
    // recovered 114 would be the same class of lie as a 100% bar over moving
    // bytes — §4's reason for `bytes_total: null` in one sentence.
    const half = Math.round(REAL_TOTAL / 2);
    const html = await render({
      status: mkStatus({ legacy: { state: 'partial', bytes_done: half, disk_bytes: half } }),
    });
    expect(html).toContain('Downloaded 114 MB');
    expect(html).toContain('228 MB'); // the declared size is still shown beside it
  });

  it('NR-7: a pack with nothing on disk has NO delete control at all', async () => {
    const html = await render({ status: st({ state: 'absent' }) });
    expect(deleteButton(html), 'a control that cannot do anything is worse than none').toBeUndefined();
    // Positive control: the same render DOES carry the row's real action, so
    // an empty page cannot green this by rendering nothing.
    expect(html).toContain('Download the model');
  });

  it('🔴 NR-7: the pack IN USE has the control DISABLED — and says why beside it', async () => {
    const html = await render({
      status: mkStatus({
        legacy: { state: 'ready', bytes_done: REAL_TOTAL, disk_bytes: REAL_TOTAL },
        inUse: [PACK_ID],
      }),
    });
    const del = deleteButton(html);
    // Disabled, not hidden: 「why can I delete that one and not this one」 is
    // answered by a refused control, never by an absent one.
    expect(del, 'the in-use pack still shows the control').toBeDefined();
    expect(del?.outer).toContain('disabled');
    // 🔴 The sentence that says WHY shipped with card WP2-COPY-1 (authored
    // through the rewrite pipeline, owner ruling 2026-09-01), so what used to be
    // asserted here — that the slot stays empty — is now its opposite: the
    // refusal is explained where it is refused.
    // The two things that must still NOT be on screen are the internals: the
    // catalogue identifier and the server's error code are both developer
    // vocabulary, and putting either in front of a user is the 0.2.53 defect.
    expect(html).toContain(S.model_delete_in_use);
    expect(html).not.toContain('model_delete_in_use');
    expect(html).not.toContain('MODEL_IN_USE');
  });

  it('NR-7: the same pack becomes deletable the moment the server stops calling it in use', async () => {
    // The pair is the point: the ONLY difference between these two renders is
    // `in_use_model_ids`, so the disabled state is proven to come from the
    // server's verdict and not from the state word, the selection, or the tier.
    const legacy = { state: 'ready', bytes_done: REAL_TOTAL, disk_bytes: REAL_TOTAL };
    const locked = await render({ status: mkStatus({ legacy, inUse: [PACK_ID] }) });
    resetModelStoreForTest();
    const free = await render({ status: mkStatus({ legacy, inUse: [] }) });
    expect(deleteButton(locked)?.outer).toContain('disabled');
    expect(deleteButton(free)?.outer).not.toContain('disabled');
  });

  // ── NR-49b · 「and these other languages lost their pack too」 ─────────────
  // A delete can empty SEVERAL pairings while the rows above are about one
  // language at a time. These cases mount the CARD, not the model: what is
  // being delivered is a line on that screen, and a store field with the right
  // contents and a screen that never renders it are both green under an
  // assertion about the model (anti-façade ⑥).

  /** The rendered NR-49b line's own text, or null when the card did not draw
   *  it.
   *
   *  🔴 KNOW YOUR RULER — this helper exists because the first version of these
   *  cases asserted the endonyms against the WHOLE page and passed with the
   *  line deleted: the language PICKER above renders 「中文」 and 「日本語」 as
   *  option labels, so a page-level `toContain` was measuring the select
   *  element, not the sentence. The assertions below read the one element the
   *  card is being judged on. */
  function clearedLine(html: string): string | null {
    const m = /<p class="sub cleared-langs"[^>]*>([\s\S]*?)<\/p>/.exec(html);
    return m ? (m[1] ?? '') : null;
  }

  /** The card after a delete that emptied `langs`, in `locale`. */
  async function afterDeleteClearing(langs: string[], locale: UiLocale = 'en'): Promise<string> {
    setLocale(locale);
    return render({
      status: mkStatus({ legacy: { state: 'absent', bytes_done: 0, disk_bytes: 0 } }),
      clearedLangs: langs,
    });
  }

  it('🔴 NR-49b: names the OTHER languages the delete emptied, by their own names', async () => {
    const line = clearedLine(await afterDeleteClearing(['zh', 'ja']));
    expect(line, 'the card drew no line for the emptied languages').not.toBeNull();
    // Their endonyms, because 「zh」 is our data model and the owner's 2026-08-22
    // rule is that no internal word reaches the screen.
    expect(line).toContain('中文');
    expect(line).toContain('日本語');
    expect(line).not.toContain('zh');
    expect(line).not.toContain('ja');
    // The sentence itself is mounted, not only the names.
    expect(line).toContain(S.model_cleared_langs.split('{langs}')[0]);
  });

  it('🔴 NR-49b: with nothing cleared the line does not exist', async () => {
    const html = await afterDeleteClearing([]);
    expect(clearedLine(html), 'a report of a delete that emptied nothing').toBeNull();
    expect(html).not.toContain(S.model_cleared_langs.split('{langs}')[0]);
    // Positive control: this render is a real card, so 「nothing on screen」
    // cannot be what greens the assertion above.
    expect(html).toContain('Download the model');
  });

  it('🔴 NR-49b: every locale keeps the hole the names go into', async () => {
    // The rewrite pipeline authors these nine sentences and nothing in it
    // enforces `{langs}` — `PLACEHOLDER_RE` in copy-scent-context.mjs only
    // knows `$name` / `${name}`, so a locale that dropped the brace would land
    // green through the whole copy gate and render a sentence naming no
    // language at all. This is the check that would see it, and it is written
    // as the SCREEN rather than as the catalogue: both failure shapes — a lost
    // hole and a literal one — are visible there.
    for (const loc of UI_LOCALES) {
      const line = clearedLine(await afterDeleteClearing(['zh', 'ja'], loc));
      expect(line, `${loc}: no line at all`).not.toBeNull();
      expect(line, `${loc}: the placeholder was rendered instead of filled`).not.toContain('{langs}');
      expect(line, `${loc}: the emptied languages are not named`).toContain('中文');
      expect(line, `${loc}: the emptied languages are not named`).toContain('日本語');
      resetModelStoreForTest();
    }
    setLocale('en');
  });

  it('NR-49b: a language the registry does not know renders as its code, not as a blank', async () => {
    // `endonymFor`'s verbatim arm. A selection file can hold a code an older
    // build accepted; under-reporting which pairings were emptied would be
    // worse than showing the raw code, because the reader would go looking for
    // a language that was never named.
    expect(clearedLine(await afterDeleteClearing(['xx']))).toContain('xx');
  });

  it('NR-7: the control is wired to the delete caller, naming the pack', async () => {
    const src = readFileSync(
      fileURLToPath(new URL('./components/LocalModelCard.vue', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('deleteModel(row.entry.model_id)');
  });

  it('renders in the reader language, not in English with a switch flipped', async () => {
    setLocale('zh-CN');
    const html = await render({ status: st({ state: 'absent' }) });
    expect(html).toContain('内置语音模型');
    expect(html).toContain('下载模型（约 228 MB，一次性）');
    expect(html).not.toContain('Download the model');
    setLocale('en');
  });
});
