// How the two windows learn what the built-in speech models are doing.
//
// SPEC-REF:
//   docs/strategy/2026-08-19-local-model-onboarding-design.md §4 (the routes),
//     §5-A/§5-B (the two surfaces that read this store)
//   docs/strategy/2026-08-22-per-language-stt-model-catalog-task.md (LM-CAT):
//     downloads are per-pack ({model_id}), pressing a pack's button under a
//     language records the selection ({lang}), the models root is movable
//     (owner 2026-08-22), one download machine-wide.
//
// ── WHY A POLL, AND WHY NOT A PUSH ───────────────────────────────────────────
// Unchanged from the pre-LM-CAT file: the probe path already reaches the same
// local server; poll fast while something moves, slow when it does not.
//
// ── ONE STORE, TWO READERS ───────────────────────────────────────────────────
// The settings card (§5-A) and the main-window notice (§5-B) must never
// disagree; one module-level `reactive` store, ONE poller per window,
// started by App.vue / LocalModelNotice.
//
// ── WHAT THIS FILE REFUSES TO DO ─────────────────────────────────────────────
// It never turns a failure into a healthy default. No local server, a fetch
// that throws, a body it does not recognise — each leaves `status` alone and
// moves `reach`, because 「I could not ask」 and 「the model is not there」 are
// two different sentences and only one of them has a Download button under it.

import { reactive } from 'vue';
import { CH, fetchSidecarState, onChannel, type SidecarStatus } from './bridge';
import {
  asModelsStatus, pushRateSample,
  type ModelSnapshot, type ModelsStatus,
} from './model-status';

/** §4's routes. Constants because they are also written down in a test that
 *  reads the server lane's router — a literal at the call site would make that
 *  anchor a coincidence rather than a check. */
export const MODEL_STATUS_PATH = '/api/stt/model/status';
export const MODEL_DOWNLOAD_PATH = '/api/stt/model/download';
export const MODEL_CANCEL_PATH = '/api/stt/model/cancel';
export const MODEL_ROOT_PATH = '/api/stt/model/root';

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

/** Could we ask at all? Deliberately FOUR values — see the pre-LM-CAT header
 *  (owner report 2026-08-20: 「no endpoint yet」 must render as connecting,
 *  never as a problem; a 404 IS an answer and wants a different sentence from
 *  silence). */
export type ModelReach = 'unknown' | 'ok' | 'unreachable' | 'answered_unusable';

/** One probe's budget. Without it a single hung request froze the poller
 *  forever. */
export const MODEL_PROBE_TIMEOUT_MS = 4_000;

export interface ModelStore {
  /** The full catalog status — the card's world. */
  status: ModelsStatus | null;
  /** The legacy single-model view (the SenseVoice row), kept because the
   *  notice's progress fallback and older tests read it. ALWAYS derived from
   *  `status` in [adopt] — never set independently, so the two cannot
   *  disagree (一个值只回答一个问题: this one answers "the SenseVoice row"). */
  snapshot: ModelSnapshot | null;
  reach: ModelReach;
  /** WHY the last status read failed, verbatim — the technical fold shows it. */
  reachReason: string | null;
  /** Which action is in flight, so the buttons can say so instead of looking
   *  ignored. Empty string = none. */
  busy: '' | 'download' | 'cancel' | 'recheck' | 'root';
  /** Which pack the in-flight ACTION names (client-side; the machine-wide
   *  download truth is `status.busy_model_id`). */
  busyActionModelId: string | null;
  /** Set when an ACTION was refused or unreachable — the user pressed
   *  something and nothing happened, which must never be silent. Cleared on
   *  the next press. Raw reason; rendered inside the technical fold. */
  actionError: string | null;
  /** Successive server rate readings for the DOWNLOADING pack; [stableRate]
   *  decides whether they add up to a number we will turn into a time. */
  rateSamples: number[];
  /** §5-B: 「记住本次不提醒」. Module state, not storage — dies with the
   *  WebView, which is what "for this session" means. */
  noticeDismissed: boolean;
}

export const modelStore = reactive<ModelStore>({
  status: null,
  snapshot: null,
  reach: 'unknown',
  reachReason: null,
  busy: '',
  busyActionModelId: null,
  actionError: null,
  rateSamples: [],
  noticeDismissed: false,
});

/** Tests re-arm the module-level store — one copy of the state means one place
 *  to reset. */
export function resetModelStoreForTest(next: Partial<ModelStore> = {}): void {
  Object.assign(modelStore, {
    status: null,
    snapshot: null,
    reach: 'unknown',
    reachReason: null,
    busy: '',
    busyActionModelId: null,
    actionError: null,
    rateSamples: [],
    noticeDismissed: false,
  }, next);
}

export function dismissModelNotice(): void {
  modelStore.noticeDismissed = true;
}

/** The models[] entry that is downloading right now, or null. */
export function downloadingSnapshot(status: ModelsStatus | null): ModelSnapshot | null {
  if (status === null || status.busy_model_id === null) return null;
  return status.models.find((m) => m.model_id === status.busy_model_id) ?? null;
}

/** Apply a status the server just handed us.
 *
 *  The rate history is kept ONLY across a continuous download of the SAME
 *  pack: anything else clears it, so a resumed or switched download measures
 *  the link it has now. */
let rateModelId: string | null = null;
function adopt(status: ModelsStatus): void {
  modelStore.status = status;
  modelStore.snapshot = status.legacy;
  modelStore.reach = 'ok';
  // An answer landing — from the poll OR from an action's response — ends the
  // failure the reason was quoting (2026-08-20 no-download logic review).
  modelStore.reachReason = null;
  const dl = downloadingSnapshot(status);
  if (dl !== null && dl.state === 'downloading') {
    if (rateModelId !== dl.model_id) {
      modelStore.rateSamples = [];
      rateModelId = dl.model_id;
    }
    modelStore.rateSamples = pushRateSample(modelStore.rateSamples, dl.rate_bytes_per_sec);
  } else {
    modelStore.rateSamples = [];
    rateModelId = null;
  }
}

/** The ways an ask can end, kept apart because the user's next move differs. */
type CallOutcome =
  | { ok: true; status: ModelsStatus }
  | { ok: false; kind: 'no-endpoint'; reason: string }
  | { ok: false; kind: 'no-answer'; reason: string }
  | { ok: false; kind: 'bad-answer'; reason: string }
  /** The server ANSWERED with a named refusal ({ok:false,error:…}) — a 400 on
   *  a bad folder, a 409 while another pack downloads. Not a reach problem:
   *  the service is healthy, it said no, and the card shows the reason. */
  | { ok: false; kind: 'refused'; reason: string; error: string };

async function call(
  path: string,
  method: 'GET' | 'POST',
  t: ModelTransport,
  body?: unknown,
): Promise<CallOutcome> {
  const base = await t.baseUrl().catch(() => null);
  if (base === null || base.length === 0) {
    // 🔴 NOT an ask. Nothing was sent, so nothing gets to claim 「it did not
    // answer」.
    return { ok: false, kind: 'no-endpoint', reason: 'no local service endpoint' };
  }
  const doFetch = t.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    // 🔴 NO custom headers, deliberately (2026-08-20 live failure): this fetch
    // crosses origins (tauri.localhost → 127.0.0.1) and a `content-type`
    // header made even the GET preflighted — the sidecar answered the OPTIONS
    // with 405 and every card on every real install read 「Failed to fetch」.
    // The POST body is a JSON string sent as text/plain; the server parses
    // the bytes and never consults the content type. Keeping the request
    // SIMPLE is load-bearing.
    res = await doFetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS),
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch (err) {
    return { ok: false, kind: 'no-answer', reason: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    // A body that is not even JSON is still an ANSWER — a 404 page, a proxy's
    // HTML. Same class as a wrong shape, not the same as silence.
    return { ok: false, kind: 'bad-answer', reason: err instanceof Error ? err.message : String(err) };
  }
  const status = asModelsStatus(parsed);
  if (status !== null) return { ok: true, status };
  const o = parsed as Record<string, unknown> | null;
  if (o !== null && typeof o === 'object' && typeof o.error === 'string') {
    const msg = typeof o.message === 'string' ? o.message : '';
    return { ok: false, kind: 'refused', error: o.error, reason: msg === '' ? o.error : `${o.error}: ${msg}` };
  }
  return { ok: false, kind: 'bad-answer', reason: `unexpected model response (http ${res.status})` };
}

/** One status read. Never throws; a failure moves `reach` and LEAVES the last
 *  status in place — a download that is 60 % done does not become unknown
 *  because one poll missed. */
export async function refreshModelStatus(
  t: ModelTransport = defaultModelTransport,
  opts: { verify?: boolean; verifyModelId?: string } = {},
): Promise<void> {
  const q = opts.verify === true
    ? `?verify=1${opts.verifyModelId ? `&model_id=${encodeURIComponent(opts.verifyModelId)}` : ''}`
    : '';
  const r = await call(`${MODEL_STATUS_PATH}${q}`, 'GET', t);
  if (r.ok) {
    adopt(r.status);
    return;
  }
  if (r.kind === 'no-endpoint') {
    if (modelStore.status !== null) {
      modelStore.reach = 'unreachable';
      modelStore.reachReason = r.reason;
    }
    return;
  }
  modelStore.reach = r.kind === 'no-answer' ? 'unreachable' : 'answered_unusable';
  modelStore.reachReason = r.reason;
}

/** §5-A's 「重新校验文件」 — the status read WITH `verify=1`, so the button
 *  does what its label says (the server re-hashes rather than answering from
 *  its stat memo). With a modelId it narrows the re-hash to that pack. */
export async function recheckModel(
  t: ModelTransport = defaultModelTransport,
  modelId?: string,
): Promise<void> {
  modelStore.busy = 'recheck';
  modelStore.actionError = null;
  try {
    await refreshModelStatus(t, { verify: true, ...(modelId ? { verifyModelId: modelId } : {}) });
  } finally {
    modelStore.busy = '';
  }
}

/** The active poller's 「run the next tick now」 hook (2026-08-20 review: an
 *  action's response moves the state, but the next poll is still scheduled on
 *  the OLD cadence — poke it). */
let pokePoller: (() => void) | null = null;

async function act(
  path: string,
  which: 'download' | 'cancel' | 'root',
  body: Record<string, unknown>,
  t: ModelTransport,
): Promise<void> {
  modelStore.busy = which;
  modelStore.busyActionModelId = typeof body.model_id === 'string' ? body.model_id : null;
  modelStore.actionError = null;
  try {
    const r = await call(path, 'POST', t, body);
    if (r.ok) {
      adopt(r.status);
      pokePoller?.();
    } else {
      modelStore.actionError = r.reason;
      // The reach verdict is NOT touched here. A refused POST says something
      // about the request, not about whether the server is answering — the
      // status poll is the one thing entitled to that verdict.
    }
  } finally {
    modelStore.busy = '';
    modelStore.busyActionModelId = null;
  }
}

/**
 * §2-3: THIS is the consent the disclosure page promises — and it names a
 * pack now (LM-CAT). With `lang`, pressing the button under a language also
 * records "use this pack for that language" (§6-1).
 */
export async function startModelDownload(
  modelId: string,
  lang?: string,
  t: ModelTransport = defaultModelTransport,
): Promise<void> {
  await act(MODEL_DOWNLOAD_PATH, 'download', { model_id: modelId, ...(lang ? { lang } : {}) }, t);
}

/** Stop at a resumable point (§3: cancel ⇒ `partial`, the `.part` stays). */
export async function cancelModelDownload(
  modelId: string,
  t: ModelTransport = defaultModelTransport,
): Promise<void> {
  await act(MODEL_CANCEL_PATH, 'cancel', { model_id: modelId }, t);
}

/** Owner 2026-08-22: re-point where model packs are downloaded. Refused by
 *  the server while a download is running; already-downloaded files are NOT
 *  moved (the card says so beside the control). */
export async function applyModelsRoot(
  dir: string,
  t: ModelTransport = defaultModelTransport,
): Promise<void> {
  await act(MODEL_ROOT_PATH, 'root', { dir }, t);
}

export async function resetModelsRoot(t: ModelTransport = defaultModelTransport): Promise<void> {
  await act(MODEL_ROOT_PATH, 'root', { reset: true }, t);
}

/** While bytes are moving (1 s: three overlapping views of the server's 5 s
 *  rate window). */
export const POLL_FAST_MS = 1_000;
/** While nothing is moving. */
export const POLL_IDLE_MS = 10_000;

/** The sidecar phases on which the model store re-asks immediately. */
export const MODEL_WAKE_PHASES: ReadonlySet<string> = new Set(['healthy', 'adopted_external']);

/** The subscription's body, split out so a test can drive it without Tauri. */
export function onSidecarPhaseForModel(phase: string | null | undefined, t: ModelTransport): void {
  if (MODEL_WAKE_PHASES.has(phase ?? '')) void refreshModelStatus(t);
}

/**
 * Start the ONE poller for this window. Returns a stop function.
 * Self-rescheduling timeout (cadence depends on the last answer), plus the
 * window-focus edge and the sidecar-ready edge (2026-08-20).
 */
export function startModelPolling(t: ModelTransport = defaultModelTransport): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let ticking = false;

  const tick = async (): Promise<void> => {
    // Reentrancy guard: a poke landing while a tick's read is in flight must
    // not start a SECOND self-rescheduling loop.
    if (stopped || ticking) return;
    ticking = true;
    try {
      await refreshModelStatus(t);
    } finally {
      ticking = false;
    }
    if (stopped) return;
    const fast = downloadingSnapshot(modelStore.status) !== null;
    timer = setTimeout(() => void tick(), fast ? POLL_FAST_MS : POLL_IDLE_MS);
  };

  const onVisible = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    void refreshModelStatus(t);
  };

  const poke = (): void => {
    if (stopped) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    void tick();
  };
  pokePoller = poke;

  void tick();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  if (typeof window !== 'undefined') window.addEventListener('focus', onVisible);
  const unlistenSidecar = onChannel<SidecarStatus>(CH.sidecarState, (p) =>
    onSidecarPhaseForModel(p?.phase, t),
  );

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pokePoller === poke) pokePoller = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.removeEventListener('focus', onVisible);
    void unlistenSidecar.then((un) => un());
  };
}
