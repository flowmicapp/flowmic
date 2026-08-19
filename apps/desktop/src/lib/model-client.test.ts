// The store behind the built-in-model card: what it does with an answer, and —
// the half that matters — what it does with a NON-answer.
//
// SPEC-REF: docs/strategy/2026-08-19-local-model-onboarding-design.md §4.
//
// 🔴 THE ASSERTIONS THAT EARN THIS FILE are the ones about failure. Every one of
// them is a shape this repo has shipped before: a read that failed being folded
// into a healthy default (「不知道」 rendered as 「没有」), a button that did
// nothing and said nothing, and a verdict about the whole service being drawn
// from one refused request.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import {
  MODEL_CANCEL_PATH,
  MODEL_DOWNLOAD_PATH,
  MODEL_STATUS_PATH,
  POLL_FAST_MS,
  POLL_IDLE_MS,
  cancelModelDownload,
  dismissModelNotice,
  modelStore,
  recheckModel,
  refreshModelStatus,
  resetModelStoreForTest,
  startModelDownload,
  startModelPolling,
  type ModelTransport,
} from './model-client';

const BASE = 'http://127.0.0.1:34567';

interface Call { url: string; method: string }

function transport(reply: (url: string) => unknown, calls: Call[] = []): ModelTransport & { calls: Call[] } {
  return {
    calls,
    baseUrl: async () => BASE,
    fetch: (async (url: string, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      const body = reply(String(url));
      if (body instanceof Error) throw body;
      return { status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof globalThis.fetch,
  };
}

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'downloading',
    model_id: 'm',
    dir: 'C:\\models',
    bytes_done: 100,
    bytes_total: 1000,
    files_done: 0,
    files_total: 2,
    current_file: 'model.int8.onnx',
    source: 'hf',
    resumed_from_bytes: 0,
    rate_bytes_per_sec: 500,
    error: null,
    ...over,
  };
}

describe('model status reads', () => {
  beforeEach(() => resetModelStoreForTest());

  it('adopts a snapshot and says the read landed', async () => {
    const t = transport(() => body({ state: 'absent' }));
    await refreshModelStatus(t);
    expect(modelStore.reach).toBe('ok');
    expect(modelStore.snapshot?.state).toBe('absent');
    expect(t.calls).toEqual([{ url: `${BASE}${MODEL_STATUS_PATH}`, method: 'GET' }]);
  });

  it('🔴 a failed poll does NOT blank a download that is in progress', async () => {
    await refreshModelStatus(transport(() => body({ bytes_done: 600 })));
    expect(modelStore.snapshot?.bytes_done).toBe(600);

    await refreshModelStatus(transport(() => new Error('ECONNREFUSED')));
    // The reading is kept and LABELLED stale by `reach`. Dropping it would make
    // the product forget a 60 %-complete download because one loopback GET
    // missed — and the download is almost certainly still running.
    expect(modelStore.reach).toBe('unreachable');
    expect(modelStore.snapshot?.bytes_done).toBe(600);
  });

  it('🔴 a body it does not recognise is a failed read, not an empty model', async () => {
    await refreshModelStatus(transport(() => ({ state: 'verifying', bytes_done: 1 })));
    expect(modelStore.reach).toBe('unreachable');
    expect(modelStore.snapshot).toBeNull();
  });

  it('does not invent a request when there is no local service to ask', async () => {
    const calls: Call[] = [];
    const t: ModelTransport = {
      baseUrl: async () => null,
      fetch: (async () => { calls.push({ url: 'x', method: 'x' }); throw new Error('unreachable'); }) as never,
    };
    await refreshModelStatus(t);
    expect(calls).toEqual([]);
    expect(modelStore.reach).toBe('unreachable');
  });

  it('🔴 「check the files again」 is the status read, not a fourth verb', async () => {
    // §3 defines `ready` as isModelComplete(dir) — size AND SHA-256 per file —
    // so the status route IS the verification. A second endpoint would be two
    // answers to one question.
    // ⚠️ WHAT THIS PINS IS OUR HALF: that no other path is called. Whether the
    // server RE-verifies on each GET rather than answering from a cache is the
    // server lane's contract and cannot be asserted from here.
    const t = transport(() => body({ state: 'ready' }));
    await recheckModel(t);
    expect(t.calls.map((c) => c.url)).toEqual([`${BASE}${MODEL_STATUS_PATH}`]);
    expect(modelStore.busy).toBe('');
  });
});

describe('the two actions', () => {
  beforeEach(() => resetModelStoreForTest());

  it('POSTs the download and renders the snapshot the server answered with', async () => {
    const t = transport(() => body({ state: 'downloading', bytes_done: 5 }));
    await startModelDownload(t);
    expect(t.calls).toEqual([{ url: `${BASE}${MODEL_DOWNLOAD_PATH}`, method: 'POST' }]);
    expect(modelStore.snapshot?.state).toBe('downloading');
    expect(modelStore.actionError).toBeNull();
  });

  it('POSTs the cancel', async () => {
    const t = transport(() => body({ state: 'partial' }));
    await cancelModelDownload(t);
    expect(t.calls).toEqual([{ url: `${BASE}${MODEL_CANCEL_PATH}`, method: 'POST' }]);
    expect(modelStore.snapshot?.state).toBe('partial');
  });

  it('🔴 a refused action is SAID, and does not become a verdict about the service', async () => {
    await refreshModelStatus(transport(() => body({ state: 'absent' })));
    expect(modelStore.reach).toBe('ok');

    await startModelDownload(transport(() => new Error('EBUSY: another download is running')));
    // Said: a pressed button that did nothing is indistinguishable from one
    // that worked.
    expect(modelStore.actionError).toContain('EBUSY');
    // NOT a reachability verdict: 「this request was refused」 and 「the service
    // is not answering」 are two facts, and only the poll may answer the second.
    expect(modelStore.reach).toBe('ok');
    expect(modelStore.busy).toBe('');
  });
});

describe('the rate history', () => {
  beforeEach(() => resetModelStoreForTest());

  it('accumulates while the download runs and is dropped when it stops', async () => {
    const t = transport(() => body({ rate_bytes_per_sec: 500 }));
    await refreshModelStatus(t);
    await refreshModelStatus(t);
    expect(modelStore.rateSamples).toEqual([500, 500]);

    // 🔴 Cleared on ANY non-downloading state: a download resumed ten minutes
    // later must measure the link it has NOW. Carrying the old readings over is
    // how an ETA ends up computed from a network that no longer exists.
    await refreshModelStatus(transport(() => body({ state: 'partial' })));
    expect(modelStore.rateSamples).toEqual([]);
  });
});

describe('the poller', () => {
  beforeEach(() => {
    resetModelStoreForTest();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('polls fast while bytes move and slowly when they do not', async () => {
    const calls: Call[] = [];
    let state = 'downloading';
    const t = transport(() => body({ state }), calls);

    const stop = startModelPolling(t);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(calls.length).toBe(2);

    state = 'ready';
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(calls.length).toBe(3);
    // Now idle: one fast interval buys nothing more.
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(calls.length).toBe(3);
    await vi.advanceTimersByTimeAsync(POLL_IDLE_MS);
    expect(calls.length).toBe(4);

    stop();
    await vi.advanceTimersByTimeAsync(POLL_IDLE_MS * 3);
    expect(calls.length, 'a stopped poller must stop').toBe(4);
  });
});

describe('the session dismissal', () => {
  it('is remembered in memory, which is exactly what 「this session」 means', () => {
    resetModelStoreForTest();
    expect(modelStore.noticeDismissed).toBe(false);
    dismissModelNotice();
    expect(modelStore.noticeDismissed).toBe(true);
    // A fresh module state — i.e. the next launch — starts over. Persisting it
    // would be a promise to stay quiet about a missing model forever.
    resetModelStoreForTest();
    expect(modelStore.noticeDismissed).toBe(false);
  });
});
