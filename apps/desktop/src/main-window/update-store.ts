// UP-3c — the app-scope owner of the update state (one owner, two render sites).
//
// SPEC-REF:
//   docs/decisions/2026-08-02-in-app-update-both-ends.md — the PC reminder is
//   the settings line PLUS 「主窗口一个不抢焦点的角标」 (a non-focus-stealing
//   main-window badge);
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §5.2 — the badge is a
//   dot, not a word.
//
// ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
// Until UP-3c the whole update state lived in a component-local ref inside
// UpdateCard.vue, and the automatic check fired from that component's
// onMounted. That worked as a trigger — SettingsPage is v-show-mounted, so the
// card mounts with the main window — but it left the ruled main-window badge
// with nothing to read: a second surface would have had to invoke
// `update_state` again and keep its own copy, and two independently-updated
// copies of one fact is this repo's named #1 bug shape. So the state is lifted
// here, mirroring the shape the mobile app already proved: one owner
// (UpdateController.hasUpdate), two render sites (the settings card says it in
// words, the header dot only points at it).
//
// 🔴 The automatic-check trigger MOVES here whole; UpdateCard no longer fires
// one on mount. Keeping the old edge as a safety net would mean "why did this
// check go out" has two answers — the exact shape the 0.2.52 F-1 fix wrote
// down when it deleted the old drain edge instead of keeping both.
//
// 🔴 The check is issued against UPDATE_MANIFEST_BASE (a protocol constant),
// never a cloud-config value — "which relay am I paired with" and "what is
// the latest FlowMic" are two different questions (design §1.1).
// update-block.test.ts pins the literal in THIS file.
//
// 🔴 A dev build never checks (design §4.2): `form === 'dev'` returns before
// any network is touched — at boot and at every recheck tick alike.

import { computed, ref } from 'vue';
import { listen } from '@tauri-apps/api/event';
import { invokeSafe } from '../lib/bridge';
import {
  UPDATE_MANIFEST_BASE,
  verdict,
  type UpdateActivity,
  type UpdateStateDto,
} from '../lib/update-view';

/** `form: 'dev'` as the pre-load value, so nothing renders and nothing checks
 *  until Rust has answered. Defaulting to a real form would flash a verdict
 *  assembled from placeholders — a sentence with no evidence behind it, which
 *  is the exact shape R11 forbids. A factory, not a shared constant: the DTO
 *  nests `download`, and a shared mutable default is a bug waiting for its
 *  first writer. */
function emptyState(): UpdateStateDto {
  return {
    current_version: '',
    form: 'dev',
    auto_check: true,
    last_success_check: null,
    checking: false,
    plan: null,
    latest: null,
    notes_url: null,
    manual_reason: null,
    failure: null,
    download: { active: false, received: 0, total: 0 },
    verified_filename: null,
    verified_sha256: null,
    verified_size: null,
    can_swap_in_place: null,
    pending: null,
  };
}

export const updateState = ref<UpdateStateDto>(emptyState());

/**
 * What this card is doing right now — `null` when it is doing nothing.
 *
 * 🔴 It carries the VERB rather than a boolean because the card must say WHICH
 * thing is running (「正在检查…」 vs 「正在下载」), and because that is the only
 * signal a renderer can have: see `UpdateActivity`'s note on why
 * `UpdateStateDto.checking` can never be observed as true from here.
 *
 * ⚠️ One in-flight call at a time is assumed — the buttons are disabled while
 * this is non-null, and the commands themselves are serialised on Rust's side.
 * If two ever overlapped, the first to finish would clear the second's verb;
 * that is not a new risk (the boolean this replaced had it too) but it is the
 * thing to fix if a second concurrent entry point is ever added.
 */
export const updateBusy = ref<UpdateActivity>(null);

/**
 * Which verb each command shows.
 *
 * 🔴 `update_state` maps to `null` ON PURPOSE: the boot snapshot is not
 * something the user asked for, and putting a spinner on the card every time
 * the window opens would make the indicator mean "the app is alive" instead of
 * "your click is being worked on".
 */
const ACTIVITY: Record<string, UpdateActivity> = {
  update_state: null,
  update_check: 'checking',
  update_download: 'downloading',
  update_apply: 'installing',
  update_dismiss_pending: 'saving',
  update_set_auto_check: 'saving',
};

/** True while a newer version than this build is known to exist — the ONLY
 *  question the header dot answers. Both `available` (we can fetch it) and
 *  `manual_only` (we can only point at the download page — today's mac shape)
 *  light it: the dot says "there is news", not "I can install it for you".
 *  A failed check never lights it — `verdict` already folds any failure to
 *  `unknown`, and unknown ≠ new-version-exists. */
export const updateAvailable = computed(() => {
  const kind = verdict(updateState.value).kind;
  return kind === 'available' || kind === 'manual_only';
});

async function updatePull(cmd: string, args?: Record<string, unknown>): Promise<void> {
  // 🔴 An unregistered command gets `saving`, never `null`. A command nobody
  // added to the table above must not be able to run with the card showing
  // nothing at all — the buttons would stay live during it, which is the state
  // this ref exists to prevent.
  updateBusy.value = cmd in ACTIVITY ? (ACTIVITY[cmd] ?? null) : 'saving';
  try {
    const next = await invokeSafe<UpdateStateDto>(cmd, args);
    if (next) updateState.value = next;
  } finally {
    updateBusy.value = null;
  }
}

export const updateCheckNow = (): Promise<void> =>
  updatePull('update_check', { base: UPDATE_MANIFEST_BASE });
export const updateDownload = (): Promise<void> => updatePull('update_download');
export const updateApply = (): Promise<void> => updatePull('update_apply');
export const updateDismissPending = (): Promise<void> => updatePull('update_dismiss_pending');
export const updateSetAutoCheck = (enabled: boolean): Promise<void> =>
  updatePull('update_set_auto_check', { enabled });

/** How often a long-running window re-asks. 24 h mirrors the mobile staleness
 *  budget (`kUpdateCheckInterval`); the desktop needs the timer MORE than the
 *  phone does — a tray-resident PC app plausibly runs for weeks, and a
 *  launch-only check would leave the badge dark that whole time. */
export const UPDATE_RECHECK_MS = 24 * 60 * 60 * 1000;

function autoCheckDue(s: UpdateStateDto): boolean {
  return (
    s.auto_check &&
    s.form !== 'dev' &&
    !s.checking &&
    !s.download.active &&
    // A verified package is a decision waiting on the user; a recheck here
    // could discard bytes that already passed the hash gate.
    s.verified_sha256 === null
  );
}

let started = false;

/** Boot the store: exactly once, from App.vue's onMounted.
 *
 *  Order: register the push listener FIRST, then pull the snapshot — RV-24's
 *  rule (a frame arriving between a pull and a listen is lost for good). The
 *  old card did it the other way around, and the window was harmless there
 *  only because Rust happens to push nothing unprompted at boot — a fact
 *  about today's Rust, not a contract. */
export async function initUpdateStore(): Promise<void> {
  if (started) return;
  started = true;
  void listen<unknown>('update:state', (e) => {
    // A pushed payload may be a throttled progress fragment rather than a
    // whole state, so the shape is checked before it is adopted wholesale.
    const next = e.payload;
    if (!next || typeof next !== 'object') return;
    if ('current_version' in next) {
      updateState.value = next as UpdateStateDto;
      return;
    }
    // 🔴 THE FRAGMENT BRANCH (0.3.33). Until this existed the shape check above
    // was the whole handler, so every throttled `{ progress: {...} }` frame
    // `update_download` emits was dropped — recognised as "not a whole state"
    // and then acted on by nobody. The download's numbers therefore only ever
    // moved on the two FULL states around it (active=true, received=0 at the
    // start; the finished state at the end), and the card sat at
    // 「正在下载 0%」("downloading 0%") for the entire transfer. A ~48 MB MSI on
    // a slow line spends minutes there, and a progress bar frozen at 0 is
    // indistinguishable from a hang — the user's only reading is 「点了没反应」
    // ("I clicked it and nothing happened").
    //
    // 🔴 A fragment UPDATES a download; it never STARTS one. `active` is left
    // to the full states that own it, and a fragment arriving when nothing is
    // downloading is discarded rather than used to invent a transfer — the
    // final full state is emitted from a different thread than the progress
    // frames, so "a late fragment overtakes the finish" is a real ordering, not
    // a hypothetical, and resurrecting `active` there would leave the card
    // showing a download that has already completed.
    const frag = (next as { progress?: { received?: unknown; total?: unknown } }).progress;
    if (!frag || typeof frag.received !== 'number' || typeof frag.total !== 'number') return;
    if (!updateState.value.download.active) return;
    updateState.value = {
      ...updateState.value,
      download: { active: true, received: frag.received, total: frag.total },
    };
  }).catch(() => {
    /* Not inside Tauri (component tests / browser preview): no event source. */
  });
  await updatePull('update_state');
  if (autoCheckDue(updateState.value)) void updateCheckNow();
  setInterval(() => {
    if (autoCheckDue(updateState.value)) void updateCheckNow();
  }, UPDATE_RECHECK_MS);
}
