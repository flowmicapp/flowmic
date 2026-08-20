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
import { CH, fetchSidecarState, onChannel, type SidecarStatus } from './bridge';
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

/** Could we ask at all? Deliberately FOUR values.
 *  · `unknown`     — we have not been able to ASK yet (the local service has
 *                    not published an endpoint — typically the first seconds
 *                    after launch). Renders as 「connecting」, never as a
 *                    problem; a card that flashes 「not answering」 on every
 *                    launch teaches the reader to distrust it. 🔴 The first
 *                    version of this file wrote that rule in this comment and
 *                    then broke it two screens down: 「no endpoint yet」 was
 *                    collapsed into `unreachable`, so every cold start opened
 *                    on an orange warning (owner report, 2026-08-20).
 *  · `ok`          — the last read succeeded; `snapshot` is that read.
 *  · `unreachable` — we ASKED and nobody answered (refused / timed out), or a
 *                    service we had reached disappeared.
 *  · `answered_unusable` — somebody answered and we could not use the answer
 *                    (404 from an older service, 403, 500, a body of another
 *                    shape). A different sentence from `unreachable` because
 *                    the reader's next move differs: nothing to wait for here —
 *                    the running pieces do not match, and a restart usually
 *                    re-pairs them. */
export type ModelReach = 'unknown' | 'ok' | 'unreachable' | 'answered_unusable';

/** One probe's budget. Without it a single hung request froze the poller
 *  forever (the tick awaits the read before rescheduling), and `reach` kept
 *  whatever it last said — a stuck sentence indistinguishable from a fresh
 *  one. */
export const MODEL_PROBE_TIMEOUT_MS = 4_000;

export interface ModelStore {
  snapshot: ModelSnapshot | null;
  reach: ModelReach;
  /** WHY the last status read failed, verbatim — the technical fold shows it.
   *  The first version computed this and threw it away, so a failing card had
   *  nothing diagnosable on it anywhere (owner report, 2026-08-20). Null while
   *  `reach` is `unknown`/`ok`. */
  reachReason: string | null;
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
  reachReason: null,
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
    reachReason: null,
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
  // An answer landing — from the poll OR from an action's response — ends the
  // failure the reason was quoting. The first version cleared this only on the
  // poll's success path, so a download started right after a missed poll kept
  // the dead failure text in the technical fold while everything was healthy
  // (2026-08-20 no-download logic review).
  modelStore.reachReason = null;
  modelStore.rateSamples =
    snap.state === 'downloading' ? pushRateSample(modelStore.rateSamples, snap.rate_bytes_per_sec) : [];
}

/** The three ways an ask can fail, kept apart because the user's next move
 *  differs for each — see [ModelReach]. */
type CallFailure =
  | { ok: false; kind: 'no-endpoint'; reason: string }
  | { ok: false; kind: 'no-answer'; reason: string }
  | { ok: false; kind: 'bad-answer'; reason: string };

async function call(
  path: string,
  method: 'GET' | 'POST',
  t: ModelTransport,
): Promise<{ ok: true; snap: ModelSnapshot } | CallFailure> {
  const base = await t.baseUrl().catch(() => null);
  if (base === null || base.length === 0) {
    // 🔴 NOT an ask. Nothing was sent, so nothing gets to claim 「it did not
    // answer」 — the caller decides what no-endpoint means from what it
    // already knows (starting up vs. disappeared).
    return { ok: false, kind: 'no-endpoint', reason: 'no local service endpoint' };
  }
  const doFetch = t.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    // 🔴 NO custom headers, deliberately (2026-08-20 live failure): this fetch
    // crosses origins (tauri.localhost → 127.0.0.1), and a `content-type`
    // header made even the GET a preflighted request — the sidecar answered
    // the OPTIONS with 405 and every card on every real install read
    // 「Failed to fetch」 while the server sat healthy. A body-less GET needs
    // no content type, and the two POSTs' body is drained unread server-side
    // (their own comment: nothing here is parameterised), so text/plain is
    // fine. Keeping the request SIMPLE is load-bearing; the server's route
    // additionally answers preflights now, but not sending one beats
    // surviving one.
    res = await doFetch(`${base}${path}`, {
      method,
      // A hung socket must not hang the poller: the tick awaits this read
      // before rescheduling, so an unbudgeted request froze the card forever.
      signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS),
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
  } catch (err) {
    return { ok: false, kind: 'no-answer', reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const snap = asModelSnapshot(await res.json());
    if (snap === null) {
      return { ok: false, kind: 'bad-answer', reason: `unexpected model response (http ${res.status})` };
    }
    return { ok: true, snap };
  } catch (err) {
    // A body that is not even JSON is still an ANSWER — a 404 page, a proxy's
    // HTML. Same class as a wrong shape, not the same as silence.
    return { ok: false, kind: 'bad-answer', reason: err instanceof Error ? err.message : String(err) };
  }
}

/** One status read. Never throws; a failure moves `reach` and LEAVES the last
 *  snapshot in place — a download that is 60 % done does not become unknown
 *  because one poll missed, and the reach line says the reading is stale.
 *
 *  `verify` ⇒ `?verify=1`: the server bypasses its (size, mtime) memo and
 *  re-hashes every file. The plain poll deliberately does NOT pass it — a
 *  10-second cadence of full re-hashes would be pure heat. */
export async function refreshModelStatus(
  t: ModelTransport = defaultModelTransport,
  opts: { verify?: boolean } = {},
): Promise<void> {
  const r = await call(opts.verify === true ? `${MODEL_STATUS_PATH}?verify=1` : MODEL_STATUS_PATH, 'GET', t);
  if (r.ok) {
    adopt(r.snap); // clears reachReason — adopt owns that, for the action path too
    return;
  }
  if (r.kind === 'no-endpoint') {
    // Never had contact ⇒ still 「connecting」, not a problem (the cold-start
    // seconds before the sidecar publishes its endpoint — the exact flash the
    // owner reported). Had contact ⇒ the service GONE is real news.
    if (modelStore.snapshot !== null) {
      modelStore.reach = 'unreachable';
      modelStore.reachReason = r.reason;
    }
    return;
  }
  modelStore.reach = r.kind === 'no-answer' ? 'unreachable' : 'answered_unusable';
  modelStore.reachReason = r.reason;
}

/** §5-A's 「重新校验文件」 — the status read WITH `verify=1`, so the button
 *  does what its label says: the server re-hashes every file rather than
 *  answering from its (size, mtime) memo. The memo would otherwise let this
 *  button say 「checked」 without checking, precisely for the one corruption
 *  the memo cannot see (same length, same mtime, different bytes) — the
 *  server's route comment names this button as the reason `?verify=1` exists,
 *  and until 2026-08-20 nothing called it (owner report closed that). */
export async function recheckModel(t: ModelTransport = defaultModelTransport): Promise<void> {
  modelStore.busy = 'recheck';
  modelStore.actionError = null;
  try {
    await refreshModelStatus(t, { verify: true });
  } finally {
    modelStore.busy = '';
  }
}

/** The active poller's 「run the next tick now」 hook. Set by [startModelPolling],
 *  cleared by its stop function. [act] pokes it after a successful action: the
 *  action's response has already moved the state (absent → downloading, or
 *  downloading → partial on cancel), but the next poll is still scheduled on the
 *  OLD state's cadence — so 「download」 pressed during an idle gap left the
 *  card's byte counter frozen at the POST-time reading for up to [POLL_IDLE_MS]
 *  before the first fast poll arrived (2026-08-20 no-download logic review). */
let pokePoller: (() => void) | null = null;

async function act(
  path: string,
  which: 'download' | 'cancel',
  t: ModelTransport,
): Promise<void> {
  modelStore.busy = which;
  modelStore.actionError = null;
  try {
    const r = await call(path, 'POST', t);
    if (r.ok) {
      adopt(r.snap);
      pokePoller?.();
    } else {
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
/** The sidecar phases on which the model store re-asks immediately — the same
 *  two `settings-sync-notice.ts` counts as 「the LAN socket is live」. This is
 *  what turns the cold-start 「connecting」 face into a real answer the moment
 *  the service is actually up, instead of waiting out the idle interval. */
export const MODEL_WAKE_PHASES: ReadonlySet<string> = new Set(['healthy', 'adopted_external']);

/** The subscription's body, split out so a test can drive it without Tauri
 *  (onChannel is a no-op outside the shell). */
export function onSidecarPhaseForModel(phase: string | null | undefined, t: ModelTransport): void {
  if (MODEL_WAKE_PHASES.has(phase ?? '')) void refreshModelStatus(t);
}

export function startModelPolling(t: ModelTransport = defaultModelTransport): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let ticking = false;

  const tick = async (): Promise<void> => {
    // The reentrancy guard is for the poke path: a poke landing while a tick's
    // read is in flight must not start a SECOND self-rescheduling loop — two
    // loops each planting timers doubles the cadence forever. The in-flight
    // tick picks its interval from the store AFTER its read, so the state the
    // poke was announcing is what that choice sees anyway.
    if (stopped || ticking) return;
    ticking = true;
    try {
      await refreshModelStatus(t);
    } finally {
      ticking = false;
    }
    if (stopped) return;
    const fast = modelStore.snapshot?.state === 'downloading';
    timer = setTimeout(() => void tick(), fast ? POLL_FAST_MS : POLL_IDLE_MS);
  };

  const onVisible = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    void refreshModelStatus(t);
  };

  /** See [pokePoller]: drop the pending (old-cadence) timer and read now. */
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
  // The ready edge. The first tick almost always runs before the sidecar has
  // published an endpoint (it needs seconds; the window needs milliseconds),
  // and the idle interval would leave the 「connecting」 face up for as long as
  // 10 s after the service was ready. The push channel already exists and a
  // sibling notice already keys on the same two phases — this store just
  // never listened until the owner watched the gap (2026-08-20).
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
