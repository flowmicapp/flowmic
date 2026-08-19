// Component-level: what the built-in-model card ACTUALLY RENDERS in each of the
// six faces (docs/strategy/2026-08-19-local-model-onboarding-design.md §5-A).
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
// The file was restored from a copy taken before the edit; `grep -rn
// REVERSE-CONTROL apps/desktop/src` returns only an unrelated pre-existing line
// in cloud-signout-confirm.test.ts, and the suites are green again.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

// bridge.ts is on the import path (model-client → bridge) and loads these at
// module scope; nothing here invokes anything.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import LocalModelCard from './components/LocalModelCard.vue';
import { modelStore, resetModelStoreForTest, type ModelStore } from '../lib/model-client';
import type { ModelSnapshot } from '../lib/model-status';
import { setLocale } from '../lib/strings';

/** The real manifest total (model-manifest.ts), so every figure below is one a
 *  user will see: 239,233,841 + 315,894 = 228.5 MiB. */
const REAL_TOTAL = 239_233_841 + 315_894;
const DIR = 'C:\\Users\\owner\\AppData\\Roaming\\FlowMic\\models\\sherpa-onnx-sense-voice';

function snap(over: Partial<ModelSnapshot> = {}): ModelSnapshot {
  return {
    state: 'absent',
    model_id: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    dir: DIR,
    bytes_done: 0,
    bytes_total: REAL_TOTAL,
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

async function render(state: Partial<ModelStore>): Promise<string> {
  resetModelStoreForTest({ reach: 'ok', ...state });
  return renderToString(createSSRApp(LocalModelCard));
}

/** A settled rate history: three readings inside a factor of two ⇒ [stableRate]
 *  answers and the card is allowed to name a time. 1 MiB/s. */
const SETTLED = [1_048_576, 1_100_000, 1_000_000];

describe('the built-in speech model card', () => {
  beforeEach(() => {
    setLocale('en');
    resetModelStoreForTest();
  });

  it('says WHY there is a download at all, in every state including ready', async () => {
    for (const state of ['absent', 'ready', 'downloading', 'failed', 'partial'] as const) {
      const html = await render({ snapshot: snap({ state }) });
      expect(html, `${state}: the reason the installer does not carry the model went missing`)
        .toContain('The installer does not carry the speech model itself');
    }
  });

  it('absent — offers the download WITH the size taken from the snapshot', async () => {
    const html = await render({ snapshot: snap({ state: 'absent' }) });
    expect(html).toContain('Not downloaded');
    // 228 = REAL_TOTAL / 1024², rounded. Nothing in the catalogue spells it.
    expect(html).toContain('Download the model (about 228 MB, one time)');
    // The second exit is stated on the same screen as the first.
    expect(html).toContain('put the model files into this folder yourself');
    expect(html).toContain(DIR);
  });

  it('absent with no total — the button says nothing about size rather than guessing', async () => {
    const html = await render({ snapshot: snap({ state: 'absent', bytes_total: null }) });
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
      snapshot: snap({ state: 'partial', bytes_done: Math.ceil(REAL_TOTAL * 0.43) }),
    });
    expect(html).toContain('Partly downloaded');
    expect(html).toContain('Resume the download (43% done)');
  });

  it('partial with no total — resumes without inventing a percentage', async () => {
    const html = await render({
      snapshot: snap({ state: 'partial', bytes_done: 50_000_000, bytes_total: null }),
    });
    expect(html).toContain('Resume the download');
    expect(html).not.toContain('% done');
  });

  it('downloading — bytes, percent, rate, which file, WHICH SOURCE', async () => {
    const html = await render({
      snapshot: snap({
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
    const first = await render({ snapshot: snap({ state: 'downloading', source: 'hf' }) });
    expect(first).toContain('Hugging Face');
    expect(first).not.toContain('hf-mirror.com');

    const second = await render({ snapshot: snap({ state: 'downloading', source: 'hf-mirror' }) });
    expect(second).toContain('hf-mirror.com');
    // Positive control for the line above: the note that explains WHY the name
    // changed has to be on screen too, or the reader just sees it change.
    expect(second).toContain('the download moves on to the next one');
  });

  it('🔴 an unknown total renders as words, never as 0% / 100% / NaN', async () => {
    const html = await render({
      snapshot: snap({ state: 'downloading', bytes_done: 102_900_000, bytes_total: null }),
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
      snapshot: snap({
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
      snapshot: snap({ state: 'downloading', bytes_done: 1_000_000, rate_bytes_per_sec: 900_000 }),
      rateSamples: [900_000], // one reading: not a rate yet
    });
    expect(unsettled).toContain('estimating the time left');
    expect(unsettled).not.toContain('min left');

    const settled = await render({
      snapshot: snap({ state: 'downloading', bytes_done: 100_000_000 }),
      rateSamples: [...SETTLED],
    });
    // (239,549,735 − 100,000,000) / 1,048,576 B/s ≈ 133 s ⇒ 2 min.
    expect(settled).toContain('about 2 min left');
  });

  it('ready — certifies the FILES and refuses to certify the engine', async () => {
    const html = await render({ snapshot: snap({ state: 'ready' }) });
    expect(html).toContain('Ready');
    expect(html).toContain('Every file is present and matches its checksum');
    expect(html).toContain('whether the engine loads on this machine is a separate question');
    expect(html).toContain('Check the files again');
    // Nothing to download, so no download offer.
    expect(html).not.toContain('Download the model');
  });

  it('failed — what to DO is body copy, the machine truth is folded but kept', async () => {
    const html = await render({
      snapshot: snap({ state: 'failed', error: { code: 'ENETUNREACH', message: 'hf-mirror: no route to host' } }),
    });
    expect(html).toContain('Download failed');
    expect(html).toContain('Try again — it carries on from where it stopped');
    expect(html).toContain('check the network');
    expect(html).toContain(DIR);
    // The developer sentence was MOVED, not deleted.
    expect(html).toContain('Technical detail');
    expect(html).toContain('ENETUNREACH: hf-mirror: no route to host');
  });

  it('🔴 unknown — no download offer is made on the strength of a failed read', async () => {
    const html = await render({ snapshot: null, reach: 'unreachable' });
    expect(html).toContain('Unknown');
    expect(html).toContain('cannot say whether the model is here');
    expect(html).not.toContain('Download the model');
    expect(html).not.toContain('Resume the download');
    // The one thing that IS offered is asking again.
    expect(html).toContain('Check the files again');
  });

  it('a stale reading is kept on screen and labelled, not blanked', async () => {
    const html = await render({
      snapshot: snap({ state: 'downloading', bytes_done: 140_000_000 }),
      reach: 'unreachable',
    });
    expect(html).toContain('58%');
    expect(html).toContain('cannot say whether the model is here');
  });

  it('the environment variable appears ONCE, inside the advanced fold', async () => {
    const html = await render({ snapshot: snap({ state: 'absent' }) });
    expect(html.match(/FLOWMIC_SHERPA_AUTO_DOWNLOAD/g)?.length).toBe(1);
    // Positive control for that count: the fold it belongs to is really there.
    expect(html).toContain('Machines with nobody at them');
    // …and it is not in the body copy the reader meets first (§5-D).
    const beforeFold = html.slice(0, html.indexOf('Machines with nobody at them'));
    expect(beforeFold).not.toContain('FLOWMIC_SHERPA_AUTO_DOWNLOAD');
  });

  it('renders in the reader language, not in English with a switch flipped', async () => {
    setLocale('zh-CN');
    const html = await render({ snapshot: snap({ state: 'absent' }) });
    expect(html).toContain('内置语音模型');
    expect(html).toContain('下载模型（约 228 MB，一次性）');
    expect(html).not.toContain('Download the model');
    setLocale('en');
  });
});
