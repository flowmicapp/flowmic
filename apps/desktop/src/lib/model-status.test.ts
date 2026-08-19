// The arithmetic and the narrowing behind the built-in-model card
// (docs/strategy/2026-08-19-local-model-onboarding-design.md §3/§4).
//
// 🔴 THE ONE CASE THIS FILE EXISTS FOR is `bytes_total: 0`. §4 spells out why
// the server sends `null` instead — 0 renders as `NaN%` or as a triumphant
// `100%` — and the guard that keeps that true on THIS side is one `> 0` inside
// [asModelSnapshot]. Everything else here is ordinary; that line is the card.

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_STT_ENGINE_ID,
  RATE_SAMPLES_NEEDED,
  asModelSnapshot,
  builtinEngineSelected,
  etaFrom,
  formatMb,
  formatMbCoarse,
  formatRate,
  percentDone,
  pushRateSample,
  shouldOfferModelSetup,
  sourceLabel,
  stableRate,
} from './model-status';

/** The real manifest's two files, summed:
 *  239,233,841 (model.int8.onnx) + 315,894 (tokens.txt)
 *  — apps/server-core/src/stt/sherpa/model-manifest.ts SHERPA_MODEL_FILES. Used
 *  so the formatted figures in these expectations are the ones a user will
 *  actually see rather than round numbers that hide a rounding choice. */
const REAL_TOTAL = 239_233_841 + 315_894;

function wire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'downloading',
    model_id: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    dir: 'C:\\Users\\x\\AppData\\Roaming\\FlowMic\\models\\sense-voice',
    bytes_done: 1024,
    bytes_total: REAL_TOTAL,
    files_done: 0,
    files_total: 2,
    current_file: 'model.int8.onnx',
    source: 'hf',
    resumed_from_bytes: 0,
    rate_bytes_per_sec: 1024 * 1024,
    error: null,
    ...over,
  };
}

describe('asModelSnapshot', () => {
  it('🔴 keeps an unknown total as null and NEVER as 0', () => {
    expect(asModelSnapshot(wire({ bytes_total: null }))?.bytes_total).toBeNull();
    expect(asModelSnapshot(wire({ bytes_total: undefined }))?.bytes_total).toBeNull();
    // The value §4 forbids: a server that meant 「I don't know」 and sent 0.
    // Accepting it here is what produces NaN% / 100% two layers up.
    expect(asModelSnapshot(wire({ bytes_total: 0 }))?.bytes_total).toBeNull();
    expect(asModelSnapshot(wire({ bytes_total: -1 }))?.bytes_total).toBeNull();
    expect(asModelSnapshot(wire())?.bytes_total).toBe(REAL_TOTAL);
  });

  it('refuses a shape it does not recognise rather than inventing a face', () => {
    expect(asModelSnapshot(null)).toBeNull();
    expect(asModelSnapshot('ready')).toBeNull();
    expect(asModelSnapshot({})).toBeNull();
    // A sixth state has no face on the card, so the whole snapshot is refused
    // and the card says 「unknown」 — never a random one of the five.
    expect(asModelSnapshot(wire({ state: 'verifying' }))).toBeNull();
  });

  it('degrades every optional field to a STATED value, never to a guess', () => {
    const s = asModelSnapshot({ state: 'absent' });
    expect(s).not.toBeNull();
    expect(s?.bytes_done).toBe(0);
    expect(s?.bytes_total).toBeNull();
    expect(s?.current_file).toBeNull();
    expect(s?.source).toBeNull();
    expect(s?.rate_bytes_per_sec).toBeNull();
    expect(s?.error).toBeNull();
    expect(s?.dir).toBe('');
  });

  it('carries the error through as a pair, and an empty pair is no error', () => {
    const s = asModelSnapshot(wire({ state: 'failed', error: { code: 'ENETUNREACH', message: 'hf: no route' } }));
    expect(s?.error).toEqual({ code: 'ENETUNREACH', message: 'hf: no route' });
    expect(asModelSnapshot(wire({ error: { code: '', message: '' } }))?.error).toBeNull();
  });
});

describe('percentDone', () => {
  it('is null when the total is unknown — not 0, not 100', () => {
    expect(percentDone(12345, null)).toBeNull();
    expect(percentDone(0, null)).toBeNull();
  });
  it('floors, so a bar never reads 100% while bytes are still moving', () => {
    expect(percentDone(999, 1000)).toBe(99);
    expect(percentDone(1000, 1000)).toBe(100);
    expect(percentDone(0, 1000)).toBe(0);
  });
  it('clamps a total that a double-counted resume overshot', () => {
    expect(percentDone(1200, 1000)).toBe(100);
  });
});

describe('formatting', () => {
  it('renders the real model size the way the folder does (MiB, labelled MB)', () => {
    expect(formatMb(REAL_TOTAL)).toBe('228.5 MB');
    expect(formatMbCoarse(REAL_TOTAL)).toBe('228 MB');
  });
  it('keeps one decimal so a slow link visibly moves', () => {
    // 20 KB/s: a whole-MB readout would sit still for ~50 s.
    expect(formatMb(419_430)).toBe('0.4 MB');
    expect(formatMb(524_288)).toBe('0.5 MB');
  });
  it('picks a unit that leaves a number rather than a row of zeros', () => {
    expect(formatRate(1024 * 1024 * 1.5)).toBe('1.5 MB/s');
    expect(formatRate(1024 * 820)).toBe('820 KB/s');
    expect(formatRate(640)).toBe('640 B/s');
  });
  it('names the three sources, and passes an unknown one through verbatim', () => {
    expect(sourceLabel('hf')).toBe('Hugging Face');
    expect(sourceLabel('hf-mirror')).toBe('hf-mirror.com');
    expect(sourceLabel('github-tarball')).toBe('GitHub release');
    expect(sourceLabel('s3-somewhere')).toBe('s3-somewhere');
    expect(sourceLabel(null)).toBeNull();
  });
});

describe('the rate we are willing to turn into a promise (§2-6)', () => {
  it('says nothing until there are enough readings', () => {
    expect(stableRate([])).toBeNull();
    expect(stableRate([1_000_000])).toBeNull();
    expect(stableRate([1_000_000, 1_000_000])).toBeNull();
    expect(RATE_SAMPLES_NEEDED).toBe(3);
  });
  it('refuses a set that disagrees with itself by more than a factor of two', () => {
    // A link that just failed over: the ETA computed across these would swing
    // from two minutes to forty between polls.
    expect(stableRate([100_000, 2_000_000, 150_000])).toBeNull();
  });
  it('takes the median, so one spike cannot move the answer', () => {
    expect(stableRate([1_000_000, 1_800_000, 1_200_000])).toBe(1_200_000);
  });
  it('keeps only what it can use, and drops the nulls the server sends early', () => {
    let s: number[] = [];
    s = pushRateSample(s, null);
    expect(s).toEqual([]);
    s = pushRateSample(s, 100);
    s = pushRateSample(s, 200);
    s = pushRateSample(s, 300);
    s = pushRateSample(s, 400);
    expect(s).toEqual([200, 300, 400]);
  });
});

describe('etaFrom', () => {
  it('distinguishes 「no total」 from 「still measuring」 — they resolve differently', () => {
    expect(etaFrom(1000, null, [1_000_000, 1_000_000, 1_000_000])).toEqual({ kind: 'no-total' });
    expect(etaFrom(1000, 100_000, [])).toEqual({ kind: 'estimating' });
  });
  it('names a time only from a settled rate', () => {
    const v = etaFrom(0, 120_000_000, [1_000_000, 1_000_000, 1_000_000]);
    expect(v.kind).toBe('seconds');
    expect(v.kind === 'seconds' && Math.round(v.seconds)).toBe(120);
  });
  it('never goes negative when a resume overshoots the total', () => {
    const v = etaFrom(200, 100, [1000, 1000, 1000]);
    expect(v).toEqual({ kind: 'seconds', seconds: 0 });
  });
});

describe('who the notice is for', () => {
  it('recognises the built-in engine by the protocol id, in any routing', () => {
    expect(BUILTIN_STT_ENGINE_ID).toBe('sherpa-local');
    expect(builtinEngineSelected([{ engine_id: 'funasr' }])).toBe(false);
    expect(builtinEngineSelected([])).toBe(false);
    expect(builtinEngineSelected([{ engine_id: 'funasr' }, { engine_id: 'sherpa-local' }])).toBe(true);
  });

  it('🔴 stays silent when we do not KNOW — that is not the same as 「missing」', () => {
    expect(shouldOfferModelSetup({ builtinSelected: true, state: null, dismissed: false })).toBe(false);
  });

  it('stays silent for an engine this machine does not use, and when ready, and when put away', () => {
    expect(shouldOfferModelSetup({ builtinSelected: false, state: 'absent', dismissed: false })).toBe(false);
    expect(shouldOfferModelSetup({ builtinSelected: true, state: 'ready', dismissed: false })).toBe(false);
    expect(shouldOfferModelSetup({ builtinSelected: true, state: 'absent', dismissed: true })).toBe(false);
  });

  it('speaks for every non-ready state, downloading included', () => {
    for (const state of ['absent', 'partial', 'downloading', 'failed'] as const) {
      expect(shouldOfferModelSetup({ builtinSelected: true, state, dismissed: false })).toBe(true);
    }
  });
});
