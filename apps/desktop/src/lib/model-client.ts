// How the two windows learn what the built-in speech model is doing.
//
// SPEC-REF: docs/strategy/2026-08-19-local-model-onboarding-design.md §4 (the
// three routes), §5-A/§5-B (the two surfaces that read this store).
//
// ── WHY A POLL, AND WHY NOT A PUSH ───────────────────────────────────────────
//
// There is no push channel for this and inventing one would mean a new
// `flowmic://…` bridge channel plus a Rust producer plus a socket event — three
// new pieces of contract for a fact that is a local HTTP GET away. The probe
// (`lib/probe-client.ts`) already reaches the same local server the same way,
// through `fetchSidecarState().endpoint`, and that is a shipped path rather than
// a new one. So: poll, fast while something is moving and slow when it is not.
//
// ── ONE STORE, TWO READERS ───────────────────────────────────────────────────
//
// The settings card (§5-A) and the main-window notice (§5-B) must never disagree
// about whether the model is there, and the cheapest way to guarantee that is
// for there to be one copy of the answer. The precedent is `settings-model.ts`'s
// `model` — a module-level `reactive` that components read directly — and the
// same rule applies: ONE poller per window, started by App.vue.
//
// ── WHAT THIS FILE REFUSES TO DO ─────────────────────────────────────────────
//
// It never turns a failure into a healthy default. No local server, a fetch that
// throws, a body it does not recognise — each of those leaves `snapshot` alone
// and moves `reach`, because 「I could not ask」 and 「the model is not there」
// are two different sentences and only one of them has a Download button under
// it. That is `asAccessibilityStatus`'s rule ported to a network read.

import { reactive } from 'vue';
import { fetchSidecarState } from './bridge';
import { asModelSnapshot, pushRateSample, type ModelSnapshot } from './model-status';

/** §4's three routes. Constants because two of them are also written down in a
 *  test that reads the server lane's router — a literal at the call site would
 *  make that anchor a coincidence rather than a check. */
export const MODEL_STATUS_PATH = '/api/stt/model/status';
export const MODEL_DOWNLOAD_PATH = '/api/stt/model/download';
export const MODEL_CANCEL_PATH = '/api/stt/model/cancel';

/** Injectable so the store is testable with no Tauri and no server. Same shape
 *  and same reason as `ProbeTransport`. */
export interface ModelTransport {
  /** `http://127.0.0.1:PORT` of the local FlowMic server, or null when there is
   *  none (the sidecar is still starting, failed, or this build is cloud-only). */
  baseUrl(): Promise<string | null>;
  fetch?: typeof globalThis.fetch;
}

export const defaultModelTransport: ModelTransport = {
  baseUrl: async (): Promise<string | null> => (await fetchSidecarState())?.endpoint ?? null,
};

/** Could we ask at all? Deliberately THREE values.
 *  · `unknown`     — we have not asked yet. Renders as nothing, never as a
 *                    problem; a card that flashes 「not answering」 for 200 ms
 *                    on every launch teaches the reader to distrust it.
 *  · `ok`          — the last read succeeded; `snapshot` is that read.
 *  · `unreachable` — we asked and got nothing usable. */
export type ModelReach = 'unknown' | 'ok' | 'unreachable';

export interface ModelStore {
  snapshot: ModelSnapshot | null;
  reach: ModelReach;
  /** Which action is in flight, so the buttons can say so instead of looking
   *  ignored. Empty string = none. */
  busy: '' | 'download' | 'cancel' | 'recheck';
  /** Set when an ACTION was refused or unreachable — the user pressed something
   *  and nothing happened, which must never be silent. Cleared on the next
   *  press. Holds the raw reason: it is shown inside the technical fold, not as
   *  body copy. */
  actionError: string | null;
  /** Successive server rate readings; [stableRate] decides whether they add up
   *  to a number we are willing to turn into a time. */
  rateSamples: number[];
  /** §5-B: 「记住本次不提醒」. Module state, not storage, and that IS the
   *  session: it dies with the WebView and comes back next launch, which is
   *  what 「for this session」 means. Persisting it would be a promise to stay
   *  quiet about a missing model forever — nobody asked for that. */
  noticeDismissed: boolean;
}

export const modelStore = reactive<ModelStore>({
  snapshot: null,
  reach: 'unknown',
  busy: '',
  actionError: null,
  rateSamples: [],
  noticeDismissed: false,
});

/** Tests re-arm the module-level store the same way `resetPrimaryChannelForTest`
 *  does for the capsule's channel — one copy of the state means one place to
 *  reset. */
export function resetModelStoreForTest(next: Partial<ModelStore> = {}): void {
  Object.assign(modelStore, {
    snapshot: null,
    reach: 'unknown',
    busy: '',
    actionError: null,
    rateSamples: [],
    noticeDismissed: false,
  }, next);
}

export function dismissModelNotice(): void {
  modelStore.noticeDismissed = true;
}

/** Apply a snapshot the server just handed us.
 *
 *  The rate history is kept ONLY across a continuous download: any other state
 *  clears it, so a download that stops and is resumed ten minutes later starts
 *  measuring the link it has now rather than inheriting the one it had then. */
function adopt(snap: ModelSnapshot): void {
  modelStore.snapshot = snap;
  modelStore.reach = 'ok';
  modelStore.rateSamples =
    snap.state === 'downloading' ? pushRateSample(modelStore.rateSamples, snap.rate_bytes_per_sec) : [];
}

async function call(
  path: string,
  method: 'GET' | 'POST',
  t: ModelTransport,
): Promise<{ ok: true; snap: ModelSnapshot } | { ok: false; reason: string }> {
  const base = await t.baseUrl().catch(() => null);
  if (base === null || base.length === 0) return { ok: false, reason: 'no local service endpoint' };
  const doFetch = t.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    const snap = asModelSnapshot(await res.json());
    if (snap === null) return { ok: false, reason: `unexpected model response (http ${res.status})` };
    return { ok: true, snap };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** One status read. Never throws; a failure moves `reach` and LEAVES the last
 *  snapshot in place — a download that is 60 % done does not become unknown
 *  because one poll missed, and the reach line says the reading is stale. */
export async function refreshModelStatus(t: ModelTransport = defaultModelTransport): Promise<void> {
  const r = await call(MODEL_STATUS_PATH, 'GET', t);
  if (r.ok) adopt(r.snap);
  else modelStore.reach = 'unreachable';
}

/** §5-A's 「重新校验」. There is no fourth route: §3 defines `ready` as
 *  `isModelComplete(dir)` — every file's size AND SHA-256 — so the status read
 *  IS the verification and a separate verb would be a second answer to one
 *  question.
 *  ⚠️ HALF OF THAT IS AN ASSERTION ABOUT SOMEBODY ELSE'S CODE, and only our
 *  half is pinned: model-client.test.ts proves this verb calls the STATUS route
 *  and no other. Whether the server RE-VERIFIES on each GET or answers from a
 *  cached verdict is the server lane's contract, and if it ever caches, this
 *  button stops meaning what its label says — reported as a coordination item
 *  rather than asserted here, because a test that cannot see the mechanism
 *  would only be a comment wearing a test's clothes. */
export async function recheckModel(t: ModelTransport = defaultModelTransport): Promise<void> {
  modelStore.busy = 'recheck';
  modelStore.actionError = null;
  try {
    await refreshModelStatus(t);
  } finally {
    modelStore.busy = '';
  }
}

async function act(
  path: string,
  which: 'download' | 'cancel',
  t: ModelTransport,
): Promise<void> {
  modelStore.busy = which;
  modelStore.actionError = null;
  try {
    const r = await call(path, 'POST', t);
    if (r.ok) adopt(r.snap);
    else {
      modelStore.actionError = r.reason;
      // The reach verdict is NOT touched here. A refused POST says something
      // about the request, not about whether the server is answering — and the
      // status poll is the one thing entitled to that verdict.
    }
  } finally {
    modelStore.busy = '';
  }
}

/** §2-3: THIS is the consent the disclosure page promises. The button is the
 *  agreement to fetch 228 MB; the environment variable is the second path, for
 *  machines with nobody sitting at them. */
export async function startModelDownload(t: ModelTransport = defaultModelTransport): Promise<void> {
  await act(MODEL_DOWNLOAD_PATH, 'download', t);
}

/** Stop at a resumable point (§3: cancel ⇒ `partial`, the `.part` stays). */
export async function cancelModelDownload(t: ModelTransport = defaultModelTransport): Promise<void> {
  await act(MODEL_CANCEL_PATH, 'cancel', t);
}

/** While bytes are moving. One second is chosen against the SERVER's window,
 *  not against taste: `rate_bytes_per_sec` is a 5-second average, so three
 *  readings a second apart are three overlapping views of a real measurement —
 *  fast enough that the byte counter visibly moves, slow enough that we are not
 *  asking a question whose answer cannot have changed. */
export const POLL_FAST_MS = 1_000;
/** While nothing is moving. The state can still change without us (a user
 *  deleting the folder, the env-var path downloading it on a headless machine),
 *  so this never stops — but it costs one loopback GET every ten seconds. */
export const POLL_IDLE_MS = 10_000;

/**
 * Start the ONE poller for this window. Returns a stop function.
 *
 * A self-rescheduling timeout rather than `setInterval`: the interval depends on
 * the answer we just got, and an interval fixed at start-up would either poll a
 * finished install every second forever or make a live download look frozen.
 *
 * The window-focus edge is here for the same reason `AccessibilityNotice` has
 * one — the user may have fixed the fact somewhere else (put the files in the
 * folder by hand, or run the headless path) — and it is the moment they are
 * looking at us, which is exactly when a stale answer is most expensive.
 */
export function startModelPolling(t: ModelTransport = defaultModelTransport): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    await refreshModelStatus(t);
    if (stopped) return;
    const fast = modelStore.snapshot?.state === 'downloading';
    timer = setTimeout(() => void tick(), fast ? POLL_FAST_MS : POLL_IDLE_MS);
  };

  const onVisible = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    void refreshModelStatus(t);
  };

  void tick();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  if (typeof window !== 'undefined') window.addEventListener('focus', onVisible);

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.removeEventListener('focus', onVisible);
  };
}
