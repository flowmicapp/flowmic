// GA-12 — the desktop 「测试连接」("test connection") client: transport, the four-dimension → view
// mapping, and the one-shot store.
//
// These are the tests the card asks for, minus the markup (the desktop vitest is
// node-env by design): a button-click runs the probe and renders all four
// dimensions; a failure shows ✗ + an expandable raw reason; the reading is never
// persisted and is wiped when the page stops being displayed. Nothing here needs
// a reachable LAN endpoint — the transport's fetch is injected.

import { describe, expect, it, vi } from 'vitest';
import {
  configMissingRow,
  createProbeStore,
  emptySampleNote,
  isCollapsed,
  isLlmEndpointConfigured,
  pickSttDiagResult,
  PROBE_LLM_PATH,
  PROBE_STT_PATH,
  runProbe,
  toRowView,
  watchHidden,
  type ObserverCtor,
  type ProbeResult,
  type ProbeTransport,
} from './probe-client';
import { S } from './strings';

function transportOf(body: unknown, status = 200): ProbeTransport & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    baseUrl: () => Promise.resolve('http://127.0.0.1:41879'),
    fetch: ((url: string, init: { body: string }) => {
      calls.push([url, JSON.parse(init.body)]);
      return Promise.resolve({ status, json: () => Promise.resolve(body) } as Response);
    }) as unknown as typeof globalThis.fetch,
  };
}

const LIVE: ProbeResult = {
  ok: true, latency_ms: 128.4, sample_output: 'OK', model_echoed: 'qwen3.5-served',
  probe_kind: 'completion', byok: false,
};

describe('runProbe transport', () => {
  it('POSTs the config to the local server and parses the four dimensions', async () => {
    const t = transportOf(LIVE);
    const r = await runProbe(PROBE_LLM_PATH, { model: 'qwen3.5' }, t);
    expect(t.calls[0]?.[0]).toBe('http://127.0.0.1:41879/api/probe/llm');
    expect(t.calls[0]?.[1]).toEqual({ model: 'qwen3.5' }); // the config travels in the body
    expect(r).toEqual(LIVE);
  });

  it('no local server → a rendered failure, never a throw and never a fake ok', async () => {
    const r = await runProbe(PROBE_STT_PATH, {}, { baseUrl: () => Promise.resolve(null) });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('STT_PROBE_FAIL');
    expect(r.ok === false && r.message).toBe(S.probe_no_server);
  });

  it('a transport error is a failure row, not an exception', async () => {
    const r = await runProbe(PROBE_LLM_PATH, {}, {
      baseUrl: () => Promise.resolve('http://127.0.0.1:1'),
      fetch: (() => Promise.reject(new Error('fetch failed'))) as unknown as typeof globalThis.fetch,
    });
    expect(r.ok === false && r.message).toBe('fetch failed');
  });

  it('a body that is not a probe result is refused (no silent default)', async () => {
    const r = await runProbe(PROBE_LLM_PATH, {}, transportOf({ hello: 'world' }, 502));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('502');
  });
});

describe('four-dimension rendering', () => {
  it('renders ok / latency / model_echoed / sample_output', () => {
    const v = toRowView('语言模型', LIVE);
    expect(v.ok).toBe(true);
    expect(v.latency).toBe('128 ms');
    expect(v.model).toBe('qwen3.5-served');
    expect(v.sample).toBe('OK');
    expect(v.sampleIsNote).toBe(false);
    expect(v.headline).toBe(S.probe_ok);
    expect(v.byok).toBe(S.probe_managed);
    expect(v.detail).toBe(''); // nothing to expand on success
  });

  it('an absent model_echoed shows 「未提供」 — never blank, never invented', () => {
    expect(toRowView('x', { ...LIVE, model_echoed: null }).model).toBe(S.probe_none);
    expect(toRowView('x', { ...LIVE, model_echoed: '' }).model).toBe(S.probe_none);
  });

  it('a handshake probe SAYS it did not transcribe', () => {
    const v = toRowView('zh-CN · funasr', {
      ok: true, latency_ms: 40, sample_output: '', model_echoed: null, probe_kind: 'handshake', byok: false,
    });
    expect(v.sample).toBe(S.probe_note_handshake);
    expect(v.sampleIsNote).toBe(true);
    expect(emptySampleNote('handshake')).toBe(S.probe_note_handshake);
    expect(emptySampleNote('local-model')).toBe(S.probe_note_local);
    expect(emptySampleNote('transcribe')).toBe(S.probe_note_silent);
    expect(emptySampleNote(undefined)).toBe(S.probe_note_empty);
  });

  it('BYOK is surfaced with the engine-layer verdict', () => {
    expect(toRowView('x', { ...LIVE, byok: true }).byok).toBe(S.probe_byok);
  });

  it('a failure renders ✗ + the bilingual protocol copy + an expandable raw reason', () => {
    const v = toRowView('语言模型', {
      ok: false, code: 'LLM_PROBE_FAIL', message: 'fetch failed', latency_ms: 12, probe_kind: 'completion',
    });
    expect(v.ok).toBe(false);
    expect(v.headline).toBe('大模型连接测试失败。'); // straight from ERROR_CODES (zh-CN)
    expect(v.detail).toBe('LLM_PROBE_FAIL: fetch failed');
    expect(v.model).toBe(S.probe_none);
    expect(v.latency).toBe('12 ms');
  });

  it('an unknown code degrades to the code itself rather than a blank headline', () => {
    expect(toRowView('x', { ok: false, code: 'WAT_IS_THIS', message: 'm', latency_ms: 0 }).headline).toBe('WAT_IS_THIS');
  });
});

describe('the one-shot store (D3: a reading, never a status light)', () => {
  it('run() populates rows and clears the running flag', async () => {
    const store = createProbeStore(() => Promise.resolve([toRowView('a', LIVE)]));
    const p = store.run();
    expect(store.state.running).toBe(true);
    await p;
    expect(store.state.running).toBe(false);
    expect(store.state.rows).toHaveLength(1);
  });

  it('ignores a re-entrant click so one reading cannot overwrite another', async () => {
    const runner = vi.fn(() => Promise.resolve([toRowView('a', LIVE)]));
    const store = createProbeStore(runner);
    await Promise.all([store.run(), store.run()]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('clears the previous reading before a new run (no stale ✓ mid-flight)', async () => {
    let rows = [toRowView('a', LIVE)];
    const store = createProbeStore(() => Promise.resolve(rows));
    await store.run();
    rows = [toRowView('b', LIVE)];
    const p = store.run();
    expect(store.state.rows).toEqual([]);
    await p;
    expect(store.state.rows[0]?.label).toBe('b');
  });

  it('reset() wipes the reading and the expansion — nothing survives it', async () => {
    const store = createProbeStore(() => Promise.resolve([toRowView('a', LIVE)]));
    await store.run();
    store.toggle(0);
    expect(store.state.expanded).toBe(0);
    store.reset();
    expect(store.state.rows).toEqual([]);
    expect(store.state.expanded).toBe(-1);
  });

  it('toggle() folds the raw error back up', async () => {
    const store = createProbeStore(() => Promise.resolve([toRowView('a', LIVE)]));
    await store.run();
    store.toggle(1);
    expect(store.state.expanded).toBe(1);
    store.toggle(1);
    expect(store.state.expanded).toBe(-1);
  });

  it('a still-running probe leaves no half-state behind if the runner throws', async () => {
    const store = createProbeStore(() => Promise.reject(new Error('boom')));
    await expect(store.run()).rejects.toThrow('boom');
    expect(store.state.running).toBe(false);
    expect(store.state.rows).toEqual([]);
  });

  it('writes NOTHING to localStorage (a probe reading is never persisted)', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem, removeItem: vi.fn() });
    const store = createProbeStore(() => Promise.resolve([toRowView('a', LIVE)]));
    await store.run();
    expect(setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('page-away clearing (the main window uses v-show, so nothing unmounts)', () => {
  it('a zero-size box means display:none — scrolled-out-of-view does NOT', () => {
    expect(isCollapsed({ width: 0, height: 0 })).toBe(true);
    expect(isCollapsed({ width: 320, height: 180 })).toBe(false);
  });

  it('fires onHidden exactly when the element loses its box', () => {
    let cb: ((e: Array<{ boundingClientRect: { width: number; height: number } }>) => void) | null = null;
    const disconnect = vi.fn();
    const Ctor = function (this: unknown, fn: never): unknown {
      cb = fn;
      return { observe: (): void => {}, disconnect };
    } as unknown as ObserverCtor;

    const onHidden = vi.fn();
    const w = watchHidden({} as Element, onHidden, Ctor);
    cb!([{ boundingClientRect: { width: 400, height: 200 } }]); // scrolled away
    expect(onHidden).not.toHaveBeenCalled();
    cb!([{ boundingClientRect: { width: 0, height: 0 } }]); // page switched away
    expect(onHidden).toHaveBeenCalledTimes(1);
    w.disconnect();
    expect(disconnect).toHaveBeenCalled();
  });

  it('degrades to a no-op where there is no IntersectionObserver', () => {
    expect(() => watchHidden({} as Element, () => {}, undefined).disconnect()).not.toThrow();
  });
});

// REQ-12-12 — ConnDiag engine face helpers
describe('REQ-12-12 engine config short-circuit helpers', () => {
  it('empty / whitespace LLM endpoint is unconfigured (must not POST)', () => {
    expect(isLlmEndpointConfigured('')).toBe(false);
    expect(isLlmEndpointConfigured('   ')).toBe(false);
    expect(isLlmEndpointConfigured('http://127.0.0.1:8000')).toBe(true);
  });

  it('configMissingRow puts the catalogue sentence in the headline, not a bare code', () => {
    const row = configMissingRow(S.llm_title, S.probe_no_llm, 'LLM_CONFIG_MISSING');
    expect(row.ok).toBe(false);
    expect(row.headline).toBe(S.probe_no_llm);
    expect(row.detail).toBe('LLM_CONFIG_MISSING');
  });

  it('pickSttDiagResult prefers any failure over a later OK', () => {
    const ok: ProbeResult = {
      ok: true,
      latency_ms: 10,
      sample_output: '',
      model_echoed: null,
      probe_kind: 'handshake',
      byok: false,
    };
    const fail: ProbeResult = {
      ok: false,
      code: 'STT_PROBE_FAIL',
      message: 'down',
      latency_ms: 3,
    };
    expect(pickSttDiagResult([ok, fail])).toEqual(fail);
    expect(pickSttDiagResult([ok, ok])).toEqual(ok);
    expect(pickSttDiagResult([])).toMatchObject({ ok: false, code: 'STT_CONFIG_MISSING' });
  });
});
