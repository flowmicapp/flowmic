// The store behind the built-in-model card: what it does with an answer, and —
// the half that matters — what it does with a NON-answer.
//
// SPEC-REF: docs/strategy/2026-08-19-local-model-onboarding-design.md §4;
//   docs/strategy/2026-08-22-per-language-stt-model-catalog-task.md (LM-CAT):
//   the wire body is now the full per-language catalog status (legacy snapshot
//   at top level, plus catalog/models/selected_by_lang/spoken_langs/models_root/
//   busy_model_id), actions name a pack ({model_id, lang}), and the folder is
//   movable (POST /api/stt/model/root).
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
  MODEL_ROOT_PATH,
  MODEL_STATUS_PATH,
  POLL_FAST_MS,
  POLL_IDLE_MS,
  applyModelsRoot,
  cancelModelDownload,
  dismissModelNotice,
  modelStore,
  onSidecarPhaseForModel,
  recheckModel,
  refreshModelStatus,
  resetModelStoreForTest,
  resetModelsRoot,
  startModelDownload,
  startModelPolling,
  type ModelTransport,
} from './model-client';

const BASE = 'http://127.0.0.1:34567';
/** The pack every single-pack fixture is about. */
const PACK = 'm';

interface Call { url: string; method: string; headers?: unknown; body?: unknown }

function transport(reply: (url: string) => unknown, calls: Call[] = []): ModelTransport & { calls: Call[] } {
  return {
    calls,
    baseUrl: async () => BASE,
    fetch: (async (url: string, init?: { method?: string; headers?: unknown; body?: unknown }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers, body: init?.body });
      const body = reply(String(url));
      if (body instanceof Error) throw body;
      return { status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof globalThis.fetch,
  };
}

/** One five-state disk snapshot, wire-shaped (the legacy top-level fields and
 *  every `models[]` entry share this exact shape). */
function snap(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'downloading',
    model_id: PACK,
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

/** One catalog row (facts about the PACK, not about this machine's disk). */
function catEntry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_id: id,
    spoken: ['en'],
    tier: 'recommended',
    loader: 'sense-voice',
    license_class: 'osi',
    license: 'Apache-2.0',
    attribution: 'fixture attribution',
    streaming: 'quasi',
    bytes_total: 1000,
    ...over,
  };
}

/**
 * The full LM-CAT status body from partial overrides, mirroring
 * apps/server-core/src/http/stt-model-routes.ts fullStatusBody: the legacy
 * snapshot spread at TOP LEVEL, plus the catalog surface. `legacyOver` edits
 * the one-pack snapshot (which doubles as models[0]); `topOver` edits the
 * catalog-level fields. `busy_model_id` follows the snapshot's state by
 * default, because that is the invariant the real server keeps (a download
 * in flight IS the busy pack).
 */
function body(
  legacyOver: Record<string, unknown> = {},
  topOver: Record<string, unknown> = {},
): Record<string, unknown> {
  const legacy = snap(legacyOver);
  return {
    ...legacy,
    catalog: [catEntry(PACK)],
    models: [legacy],
    selected_by_lang: {},
    spoken_langs: ['en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru'],
    models_root: { dir: 'C:\\models', default_dir: 'C:\\models', configured: false },
    busy_model_id: legacy.state === 'downloading' ? legacy.model_id : null,
    ...topOver,
  };
}

describe('model status reads', () => {
  beforeEach(() => resetModelStoreForTest());

  it('adopts a status and says the read landed — and the legacy snapshot is DERIVED, never separate', async () => {
    const t = transport(() => body({ state: 'absent' }));
    await refreshModelStatus(t);
    expect(modelStore.reach).toBe('ok');
    expect(modelStore.status?.catalog).toHaveLength(1);
    expect(modelStore.snapshot?.state).toBe('absent');
    // 一个值只回答一个问题: `snapshot` is `status.legacy` and nothing else, so
    // the card's world and the notice's fallback cannot disagree.
    expect(modelStore.snapshot).toBe(modelStore.status?.legacy);
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
    expect(modelStore.status).not.toBeNull();
  });

  it('🔴 a body it does not recognise is 「answered badly」 — an answer arrived, we could not use it', async () => {
    // A 404 page, a proxy, an older sidecar — all ANSWERS. Printing 「did not
    // answer」 for them was the owner's 2026-08-20 report: the sentence was
    // false, and the reader was told to wait for something that had already
    // spoken.
    await refreshModelStatus(transport(() => ({ state: 'verifying', bytes_done: 1 })));
    expect(modelStore.reach).toBe('answered_unusable');
    expect(modelStore.reachReason).toContain('unexpected model response');
    expect(modelStore.snapshot).toBeNull();
  });

  it('🔴 a pre-LM-CAT body (legacy snapshot only, no catalog) is 「answered badly」 too', async () => {
    // The version-mismatch case in the flesh: an older sidecar answers with the
    // single-model shape. That is an ANSWER we cannot render a catalog from —
    // the store must not half-adopt it (a card showing packs from one build and
    // a snapshot from another would be two servers' truths on one screen).
    await refreshModelStatus(transport(() => snap({ state: 'ready' })));
    expect(modelStore.reach).toBe('answered_unusable');
    expect(modelStore.status).toBeNull();
    expect(modelStore.snapshot).toBeNull();
  });

  it('🔴 no endpoint yet ⇒ still 「connecting」, never a failure face', async () => {
    // The cold-start seconds: the window is up in milliseconds, the sidecar
    // publishes its endpoint seconds later. Nothing was ASKED, so nothing may
    // claim 「it did not answer」 — this exact collapse is what made every
    // healthy launch open on an orange warning.
    const calls: Call[] = [];
    const t: ModelTransport = {
      baseUrl: async () => null,
      fetch: (async () => { calls.push({ url: 'x', method: 'x' }); throw new Error('unreachable'); }) as never,
    };
    await refreshModelStatus(t);
    expect(calls).toEqual([]);
    expect(modelStore.reach).toBe('unknown');
    expect(modelStore.reachReason).toBeNull();
  });

  it('a service we HAD reached disappearing is real news — that one is unreachable', async () => {
    await refreshModelStatus(transport(() => body({ state: 'downloading' })));
    expect(modelStore.reach).toBe('ok');
    const gone: ModelTransport = { baseUrl: async () => null };
    await refreshModelStatus(gone);
    expect(modelStore.reach).toBe('unreachable');
    // The reading it had is kept (the stale rule), only the reach moved.
    expect(modelStore.snapshot?.state).toBe('downloading');
  });

  it('a read landing again clears the failure reason', async () => {
    await refreshModelStatus(transport(() => new Error('ECONNREFUSED')));
    expect(modelStore.reachReason).toContain('ECONNREFUSED');
    await refreshModelStatus(transport(() => body({ state: 'ready' })));
    expect(modelStore.reach).toBe('ok');
    expect(modelStore.reachReason).toBeNull();
  });

  it('🔴 a successful ACTION clears the stale failure reason too — the fold must not quote a failure that is over', async () => {
    // 2026-08-20 no-download review: only the poll's success path cleared the
    // reason, so 「poll missed once, then the user pressed download and it
    // worked」 left the dead failure text in the technical fold indefinitely —
    // a healthy card carrying its own obituary.
    await refreshModelStatus(transport(() => new Error('ECONNREFUSED')));
    expect(modelStore.reachReason).toContain('ECONNREFUSED');
    await startModelDownload(PACK, undefined, transport(() => body({ state: 'downloading' })));
    expect(modelStore.reach).toBe('ok');
    expect(modelStore.reachReason).toBeNull();
  });

  it('🔴 「check the files again」 asks WITH verify=1 — the button does what its label says', async () => {
    // The server answers the plain poll from a (size, mtime) memo; `?verify=1`
    // is the route it built precisely for this button, so it re-hashes every
    // file. Until 2026-08-20 nothing passed it, and the button could say
    // 「checked」 without checking — for exactly the corruption the memo cannot
    // see (same length, same mtime, different bytes).
    const t = transport(() => body({ state: 'ready' }));
    await recheckModel(t);
    expect(t.calls.map((c) => c.url)).toEqual([`${BASE}${MODEL_STATUS_PATH}?verify=1`]);
    expect(modelStore.busy).toBe('');
  });

  it('a recheck can be narrowed to one pack (LM-CAT) — the model_id rides the query', async () => {
    // Re-hashing eight packs to answer a question about one is the 10-second
    // cadence problem again, one press at a time.
    const t = transport(() => body({ state: 'ready' }));
    await recheckModel(t, PACK);
    expect(t.calls.map((c) => c.url)).toEqual([`${BASE}${MODEL_STATUS_PATH}?verify=1&model_id=${PACK}`]);
  });

  it('the plain poll does NOT verify — a 10-second cadence of full re-hashes would be pure heat', async () => {
    const t = transport(() => body({ state: 'ready' }));
    await refreshModelStatus(t);
    expect(t.calls.map((c) => c.url)).toEqual([`${BASE}${MODEL_STATUS_PATH}`]);
  });

  it('🔴 every request is a SIMPLE one — no header may sneak a CORS preflight back in', async () => {
    // The 2026-08-20 live failure: a content-type header on this GET made the
    // browser preflight it, the sidecar answered the OPTIONS with 405, and
    // every real install read 「Failed to fetch」 while the server sat healthy
    // — invisible here because this fake fetch enforces no CORS. So the pin
    // is on the REQUEST SHAPE, the one part of the browser contract a fake
    // can see: no custom headers, on the GET or on any of the POSTs — the
    // POST body is a plain JSON STRING (sent as text/plain), never a shape
    // that would set a content type of its own.
    const t = transport(() => body({ state: 'absent' }));
    await refreshModelStatus(t);
    await startModelDownload(PACK, 'en', t);
    await cancelModelDownload(PACK, t);
    await applyModelsRoot('D:\\FlowMicPacks', t);
    for (const c of t.calls) {
      expect(c.headers, `${c.method} ${c.url} carries headers that would trigger a preflight`).toBeUndefined();
      if (c.method === 'POST') {
        expect(typeof c.body, `${c.url}'s POST body must be a JSON string`).toBe('string');
      }
    }
    expect(t.calls).toHaveLength(4);
  });

  it('the sidecar-ready edge asks immediately; other phases do not', async () => {
    // The wake that turns 「connecting」 into a real answer the moment the
    // service is up, instead of waiting out the 10 s idle interval.
    const t = transport(() => body({ state: 'absent' }));
    onSidecarPhaseForModel('starting', t);
    onSidecarPhaseForModel(null, t);
    await Promise.resolve();
    expect(t.calls).toEqual([]);
    onSidecarPhaseForModel('healthy', t);
    await vi.waitFor(() => expect(modelStore.reach).toBe('ok'));
  });
});

describe('the actions', () => {
  beforeEach(() => resetModelStoreForTest());

  it('POSTs the download NAMING the pack and the language, and renders the answer', async () => {
    // LM-CAT §6-1: pressing a pack's button under a language is also the
    // selection — the {lang} in the body is what records it.
    const t = transport(() => body({ state: 'downloading', bytes_done: 5 }));
    await startModelDownload(PACK, 'en', t);
    expect(t.calls.map((c) => ({ url: c.url, method: c.method })))
      .toEqual([{ url: `${BASE}${MODEL_DOWNLOAD_PATH}`, method: 'POST' }]);
    expect(JSON.parse(String(t.calls[0]?.body))).toEqual({ model_id: PACK, lang: 'en' });
    expect(modelStore.snapshot?.state).toBe('downloading');
    expect(modelStore.actionError).toBeNull();
  });

  it('a download with no language names only the pack — it must not invent a selection', async () => {
    const t = transport(() => body({ state: 'downloading' }));
    await startModelDownload(PACK, undefined, t);
    expect(JSON.parse(String(t.calls[0]?.body))).toEqual({ model_id: PACK });
  });

  it('POSTs the cancel, naming the pack', async () => {
    const t = transport(() => body({ state: 'partial' }));
    await cancelModelDownload(PACK, t);
    expect(t.calls.map((c) => ({ url: c.url, method: c.method })))
      .toEqual([{ url: `${BASE}${MODEL_CANCEL_PATH}`, method: 'POST' }]);
    expect(JSON.parse(String(t.calls[0]?.body))).toEqual({ model_id: PACK });
    expect(modelStore.snapshot?.state).toBe('partial');
  });

  it('the folder move POSTs the dir, and the reset POSTs {reset:true} (owner 2026-08-22)', async () => {
    const t = transport(() => body({ state: 'absent' }));
    await applyModelsRoot('D:\\FlowMicPacks', t);
    await resetModelsRoot(t);
    expect(t.calls.map((c) => ({ url: c.url, method: c.method }))).toEqual([
      { url: `${BASE}${MODEL_ROOT_PATH}`, method: 'POST' },
      { url: `${BASE}${MODEL_ROOT_PATH}`, method: 'POST' },
    ]);
    expect(JSON.parse(String(t.calls[0]?.body))).toEqual({ dir: 'D:\\FlowMicPacks' });
    expect(JSON.parse(String(t.calls[1]?.body))).toEqual({ reset: true });
    expect(modelStore.reach).toBe('ok');
  });

  it('🔴 a refused action is SAID, and does not become a verdict about the service', async () => {
    await refreshModelStatus(transport(() => body({ state: 'absent' })));
    expect(modelStore.reach).toBe('ok');

    await startModelDownload(PACK, undefined, transport(() => new Error('EBUSY: another download is running')));
    // Said: a pressed button that did nothing is indistinguishable from one
    // that worked.
    expect(modelStore.actionError).toContain('EBUSY');
    // NOT a reachability verdict: 「this request was refused」 and 「the service
    // is not answering」 are two facts, and only the poll may answer the second.
    expect(modelStore.reach).toBe('ok');
    expect(modelStore.busy).toBe('');
  });

  it('🔴 a NAMED refusal ({ok:false,error,message}) lands in actionError with both halves, reach untouched', async () => {
    // The server saying no is the healthiest possible answer — a 409 while
    // another pack downloads, a 400 on a bad folder. The card shows the
    // reason; the reach verdict belongs to the poll alone.
    await refreshModelStatus(transport(() => body({ state: 'absent' })));
    const before = modelStore.status;

    await applyModelsRoot('D:\\x', transport(() => ({
      ok: false, error: 'MODEL_ROOT_BUSY', message: 'a download is running',
    })));
    expect(modelStore.actionError).toContain('MODEL_ROOT_BUSY');
    expect(modelStore.actionError).toContain('a download is running');
    expect(modelStore.reach).toBe('ok');
    // The refusal carries no status, so the one we had stays — a said-no must
    // not blank the screen either.
    expect(modelStore.status).toBe(before);
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

  it('🔴 the history is per PACK — a different download starting must not inherit another link\'s readings', async () => {
    // LM-CAT: the busy pack can change without the store ever seeing a
    // non-downloading gap (cancel a, start b, one poll apart). An ETA for b
    // computed from a's samples is the stale-network lie with a new alias.
    const a = snap({ model_id: 'a', state: 'downloading', rate_bytes_per_sec: 500 });
    const bIdle = snap({ model_id: 'b', state: 'absent', rate_bytes_per_sec: null });
    const withA = body({}, {
      catalog: [catEntry('a'), catEntry('b')],
      models: [a, bIdle], busy_model_id: 'a',
    });
    await refreshModelStatus(transport(() => withA));
    await refreshModelStatus(transport(() => withA));
    expect(modelStore.rateSamples).toEqual([500, 500]);

    const aStopped = snap({ model_id: 'a', state: 'partial', rate_bytes_per_sec: null });
    const bDl = snap({ model_id: 'b', state: 'downloading', rate_bytes_per_sec: 700 });
    await refreshModelStatus(transport(() => body({}, {
      catalog: [catEntry('a'), catEntry('b')],
      models: [aStopped, bDl], busy_model_id: 'b',
    })));
    expect(modelStore.rateSamples).toEqual([700]);
  });
});

describe('the poller', () => {
  beforeEach(() => {
    resetModelStoreForTest();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('polls fast while bytes move and slowly when they do not', async () => {
    // The cadence keys on downloadingSnapshot(status) — the busy pack's row —
    // not on the legacy snapshot's state (LM-CAT: any pack downloading is
    // bytes moving, whichever pack it is).
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

  it('🔴 a successful action re-arms the poller NOW — 「download」 pressed mid-idle-gap must not freeze the numbers for 10 s', async () => {
    // 2026-08-20 no-download review: the next tick's interval was chosen from
    // the PREVIOUS answer, so pressing download while the poller idled left the
    // byte counter frozen at the POST-time reading for up to POLL_IDLE_MS.
    const calls: Call[] = [];
    let state = 'absent';
    const t = transport(() => body({ state }), calls);

    const stop = startModelPolling(t);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(1); // first read: absent ⇒ idle cadence scheduled

    state = 'downloading';
    await startModelDownload(PACK, undefined, t); // the POST (call 2) adopts `downloading` and pokes
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(3); // the poked status read, not a 10 s wait

    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(calls.length).toBe(4); // and the cadence is FAST from here on

    stop();
    await vi.advanceTimersByTimeAsync(POLL_IDLE_MS * 3);
    expect(calls.length).toBe(4);
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
