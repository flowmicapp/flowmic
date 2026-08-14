<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import Icon from '../main-window/components/Icon.vue';
import { MODE_BADGE, S } from '../lib/strings';
import { appendForensic, capsule, fetchCaretRect, navigateMain, showMainWindow } from '../lib/bridge';
import { CAPSULE_HEIGHT, CAPSULE_WIDTH, windowHeightFor } from '../lib/capsule-morph';
import {
  anchorToCaret,
  clampToWork,
  defaultTopCenter,
  loadPos,
  savePos,
  shouldPersistDrag,
} from '../lib/capsule-position';
import type { CapsulePos } from '../lib/capsule-position';
import { connChannelLabel, deriveConnDot } from '../lib/conn-dot';
// owner 2026-08-01 channel visual identity: consume, do not reinvent.
// CHANNEL_VISUAL (icon path + css class suffix) is the ONE definition — see
// its own header in lib/channel.ts — already used by main-window/
// TimelinePage.vue's `.chan-badge`. The COLOUR pair lives only in
// styles/tokens.css (`--channel-lan-ink`/`-soft`, `--channel-cloud-ink`/
// `-soft`), already loaded into this window by capsule/main.ts. Nothing new
// is defined here — capsule.css only maps the EXISTING `.chan` element onto
// these same tokens at the capsule's own (smaller) size.
import { CHANNEL_VISUAL } from '../lib/channel';
import type { KvStore } from '../lib/types';
import { dismiss, initCapsule, setFirstSurfaceAnchor, state, toggleDiag, type RecentLine } from './controller';
import { canCopyLine, copyPayload } from './capsule-copy';
import { hasSourceLine } from '../lib/source-line';

// ── V2-15 structured recent rows ──
// Which rows have their original text (原文) expanded. Purely a view concern, so it lives here
// and not in the controller state — the original is one click away, inline,
// never a new window.
const expandedSrc = ref<ReadonlySet<string>>(new Set());
function toggleSource(id: string): void {
  const next = new Set(expandedSrc.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedSrc.value = next;
}
/** 🔴 T-7: the SAME gate as the timeline's canExpandSource — now literally the
 *  same function (`hasSourceLine`), not a second copy claiming to be.
 *
 *  ⚠️ What changed here is not only the mode test. This copy's own comment used
 *  to assert what the OTHER file did, which made it exactly the kind of claim
 *  that rots silently: the day T-7 let a realtime row carry an original, this
 *  capsule would have kept hiding it while the timeline showed it, and the
 *  comment would still have read 「same gate」. */
function canShowSource(l: RecentLine): boolean {
  return hasSourceLine({ source: l.source, face: l.text });
}
// ── V2-19 per-row copy (owner 2026-08-01 §4b-7: "each row in the capsule's
//    history list gets a 'copy' button — when injection doesn't succeed, the
//    user copies it directly for themselves") ──
//
// ⚠️ 2026-08-02 escalation: this does NOT call `navigator.clipboard`, unlike
// main-window/TimelinePage.vue's `copy()`. The capsule's window carries
// WS_EX_NOACTIVATE for the never-steal-focus red line, which could ALSO mean
// its WebView2 document never registers as Chromium-"focused" — and the
// browser Clipboard API requires `document.hasFocus()`. Rather than ship a
// button that might reject on every click regardless of what the user does
// (R8 façade), the write goes through `capsule.copyText` (lib/bridge.ts),
// which calls `capsule_copy_text` — a NEW Tauri command
// (src-tauri/src/shell/clipboard_copy.rs) that calls Win32
// `SetClipboardData` directly — no concept of document focus exists at that
// layer, so this path is structurally immune to the hazard, not merely
// likely to dodge it. See that file's header for why it does not interfere
// with the injection path's own clipboard snapshot/restore sequence.
//
// 2026-08-02 second pass (RV-97 precedent — a funnel with a second entry
// point is not a funnel): the first cut of this imported the Tauri `invoke`
// binding directly INTO THIS FILE, making it the second production import
// site of the Tauri JS API package in this app (lib/bridge.ts being the
// first). Folded into `capsule.copyText` instead — this file now has no
// direct Tauri-package import at all, same as every other command here.
//
// Feedback is a per-row ICON swap (copy → check/✗), never a growing banner:
// the capsule's form height is a fixed budget per form (07 §1,
// idle_with_history=120, CAPSULE_HEIGHT in lib/capsule-morph.ts, outside this
// card's edit scope) and a strip row must stay one line however the copy
// resolves.
const copyStatus = ref<Record<string, 'copied' | 'error'>>({});
const copyTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearCopyStatus(id: string): void {
  if (!(id in copyStatus.value)) return;
  const next = { ...copyStatus.value };
  delete next[id];
  copyStatus.value = next;
}

/** Click → write `copyPayload(l)` (== `l.text`, the same string `.rtext`
 *  renders) to the clipboard via `capsule.copyText` (lib/bridge.ts →
 *  `capsule_copy_text`). `canCopyLine` already gates the button out of the
 *  template for a row with nothing to copy; the guard here is the belt to
 *  those suspenders, not a second source of truth. A refused write is NEVER
 *  silent (red line): the icon still changes (to ✗) and the tooltip swaps to
 *  S.op_copy_failed, and the attempt is on the forensic record — same 「stated,
 *  never swallowed」pattern seedConnection uses above. */
async function copyLine(l: RecentLine): Promise<void> {
  if (!canCopyLine(l)) return;
  const prior = copyTimers.get(l.id);
  if (prior) clearTimeout(prior);
  const result = await capsule.copyText(copyPayload(l));
  if (result.ok) {
    copyStatus.value = { ...copyStatus.value, [l.id]: 'copied' };
  } else {
    copyStatus.value = { ...copyStatus.value, [l.id]: 'error' };
    appendForensic('capsule', `copy row ${l.id} FAILED: ${result.reason}`);
  }
  copyTimers.set(
    l.id,
    setTimeout(() => {
      copyTimers.delete(l.id);
      clearCopyStatus(l.id);
    }, 1200),
  );
}

/** v0.2.2 — open the picture where a picture can actually be looked at.
 *
 *  The capsule is a 56px ambient HUD; a real viewer does not fit in it, and the
 *  main window already HAS one (double-click → fullscreen, built 0.1.9). A click
 *  here goes there rather than growing a sixth capsule form that would duplicate
 *  a tested surface. Showing the window is a USER GESTURE, which is the one case
 *  the never-steal-focus red line admits. */
function openImage(): void {
  navigateMain('timeline'); // set the page first so the window never flashes another
  showMainWindow();
  appendForensic('capsule', 'image row → main window timeline');
}

/** Sender name: the directory-resolved pairing name first (a renamed phone reads
 *  correctly on old rows), then the label the phone stamped on the delivery frame
 *  (卡 P/D — the only sender identity a minted row can carry). Same order and same
 *  reason as the timeline's `senderLabel`. null → the device cell is OMITTED
 *  (V2-15 red line: a missing field vanishes, it is never back-filled). */
function deviceName(l: RecentLine): string | null {
  return (l.mobileId ? (state.mobileNames[l.mobileId] ?? null) : null) ?? l.deviceLabel;
}

/** 🔴 卡 L7 / owner 2026-08-02 "on the PC-side capsule window, the row for a
 *  message that wasn't injected should use a different background or style
 *  to set it apart" — docs/rebuild/15 §2.5c-2.
 *
 *  ONE function decides both WHETHER a row is decorated and WITH WHAT, for the same
 *  reason chat_message_tile's `_reasonLineFor` is one function: two separately
 *  maintained conditions drift apart.
 *
 *  🔴 Three rules, each of them a red line rather than taste:
 *   ① `noted` (record-only) is NOT "not injected" — it is never offered for injection at all
 *      (R9 "unconditionally never synced to the PC"). Dressing it in a failure style would manufacture a
 *      fault the user does not have;
 *   ② a row whose `status` the wire did not carry (or carried unknown) gets the
 *      BASELINE style — never a guessed one (V2-15's own rule: a missing field
 *      vanishes, it is never back-filled);
 *   ③ the colours are the SAME two the ✗/📥 faces already use (`--red`/`--amber`
 *      via .caps-fail), because "same status, one colour" — see the css below, which adds
 *      a LEFT BAR as well so the distinction survives greyscale (the channel-badge
 *      principle: never colour alone). */
function rowStatusClass(l: RecentLine): string {
  if (l.status === 'cached') return 'st-cached';
  if (l.status === 'failed') return 'st-failed';
  return '';
}

// localStorage seam for the persisted drag position (C3). Guarded so a private-mode
// / unavailable store degrades to "no persisted position" (→ top-center default).
const kv: KvStore = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* noop */
    }
  },
};

// ── C3 drag — REQ-12-15: the OS moves the window, we only arm it and record ───
//
// WHAT THIS REPLACED, AND WHY. Every `pointermove` used to recompute the
// position from the pointer delta and fire `capsule.move` — one WebView2 IPC
// round trip per frame, with a `tauri://move` coming back for each one. The
// window was therefore always at least one round trip behind the pointer, and
// the DISTANCE that costs is `latency × pointer speed`, which is exactly the
// shape owner reported: the faster you drag, the further the window falls
// behind (a wrong SCALE would instead lose the same FRACTION of the travel at
// any speed). That path also had to decide whether `screenX/Y` were physical
// or logical px — a question whose answer differs per platform, measured on
// Windows and never on macOS, and getting it wrong on either is a silent
// fixed-ratio lag. Handing the drag to the system's own move loop deletes both:
// it tracks the cursor 1:1 by construction and converts no coordinate at all.
//
// `curPos` is the last position we KNOW the capsule to be at — written by
// `commitPos` (placements we command) and by the read-back after a drag. It is
// the「before」half of `shouldPersistDrag`, i.e. how a drag is told from a click
// without any pixel arithmetic.
const curPos = { x: 0, y: 0 };
/** Pointer is down on the header, the OS has not taken the drag yet. */
let armed = false;
let startX = 0;
let startY = 0;
/** True once the OS owns a drag: from then on a `tauri://move` is the USER
 *  moving this window, not us. Cleared by `commitPos`, because that is the only
 *  other thing that can move it. */
let osDragging = false;
/** Where the capsule was when the current OS drag started. */
let dragBase: CapsulePos = { x: 0, y: 0 };
let moveSettle: ReturnType<typeof setTimeout> | null = null;

/** Pointer travel before we hand over. It is a JITTER THRESHOLD, never a
 *  position — which is why the physical-vs-logical question does not apply to
 *  it: at worst a scaled display makes it slightly more or less sensitive.
 *  Keeping it means a press that wobbles by a pixel still delivers its click to
 *  the header instead of entering a modal move loop (execution card §3-3). */
const DRAG_ARM_PX = 3;
/** Quiet time after the last `tauri://move` before we read the position back.
 *  The OS emits one per frame while dragging, so this fires once per drag —
 *  and it still fires correctly on a platform that only reports the move ONCE,
 *  at the end. */
const MOVE_SETTLE_MS = 200;

function onHeaderDown(e: PointerEvent): void {
  // Never start a drag on the status dot or a button — those own their own click.
  if ((e.target as HTMLElement).closest('.cbtn, .dot')) return;
  armed = true;
  startX = e.screenX;
  startY = e.screenY;
  // Capture only until hand-over: without it a fast flick can leave the header
  // row inside one frame and we would never see the move that arms the drag.
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onHeaderMove(e: PointerEvent): void {
  if (!armed) return;
  if (Math.hypot(e.screenX - startX, e.screenY - startY) < DRAG_ARM_PX) return;
  armed = false;
  // Release BEFORE handing over: the OS takes the mouse itself (on Windows
  // `start_dragging` calls ReleaseCapture), and a capture we can no longer
  // release is worse than none.
  try {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {
    /* noop */
  }
  void beginNativeDrag();
}
function onHeaderUp(): void {
  armed = false;
  // A drag that really started is ended by the OS, and this handler is usually
  // NOT told: the move loop owns the mouse, so the releasing pointerup goes
  // there. Where it does come back (a platform that returns the event to the
  // page), settling here just makes the persist happen sooner — the debounce
  // makes a second settle harmless.
  if (osDragging) scheduleSettle();
}

/** Hand this drag to the operating system. */
async function beginNativeDrag(): Promise<void> {
  dragBase = { x: curPos.x, y: curPos.y };
  if (!(await capsule.startDrag())) {
    // No silent failure: a refused drag means the window simply does not move, which
    // reads exactly like the lag this change removed — so it must SAY so.
    appendForensic('capsule', 'drag: the OS refused to take it — the capsule will not move');
    return;
  }
  osDragging = true;
}

function scheduleSettle(): void {
  if (moveSettle) clearTimeout(moveSettle);
  moveSettle = setTimeout(() => {
    moveSettle = null;
    void settleDrag();
  }, MOVE_SETTLE_MS);
}

/** The drag has come to rest: ask the OS where the capsule actually IS and
 *  persist that. The read-back is the only honest source — this document never
 *  saw the pointer during the drag, and the value it would have computed is the
 *  value that used to be wrong.
 *
 *  RESIDUAL, stated rather than papered over: on a host that reports no move
 *  event and returns no pointerup, the drag still TRACKS (the OS is doing it),
 *  but the new position is never persisted — the capsule sits where the user
 *  left it until the app restarts, then returns to its old spot. The tell is a
 *  drag with no「drag: settled」line in window-forensics.log, which is exactly
 *  what a device-line run should look for. No recovery path is invented for a
 *  state nobody has observed. */
async function settleDrag(): Promise<void> {
  const p = await capsule.position();
  if (!p) {
    appendForensic('capsule', 'drag: position read-back unavailable — nothing persisted');
    return;
  }
  if (!shouldPersistDrag(dragBase, p)) return; // pressed, never moved → still a click
  curPos.x = p.x;
  curPos.y = p.y;
  dragBase = { x: p.x, y: p.y };
  savePos(kv, p);
  appendForensic('capsule', `drag: settled at ${Math.round(p.x)},${Math.round(p.y)} — persisted`);
}

/** Commit a logical-px position: remember it AND command the window. This is
 *  the placement path (caret anchor / top-center / clamped restore), never the
 *  drag path — so it also takes manual control back, otherwise the move it is
 *  about to cause would be persisted as if the user had dragged there. */
function commitPos(p: CapsulePos): void {
  osDragging = false;
  if (moveSettle) {
    clearTimeout(moveSettle);
    moveSettle = null;
  }
  curPos.x = p.x;
  curPos.y = p.y;
  capsule.move(p.x, p.y);
}

/** First-surface caret anchoring (R6 T-1, owner ruling D1) — runs at most once, on
 *  the first hidden→visible edge, and only when there is NO persisted drag
 *  position. `fetchCaretRect()` returning null (no text field focused, an app that
 *  exposes no Win32 caret, GetGUIThreadInfo refused) is the honest fallback path →
 *  top-center; both outcomes are recorded to window-forensics.log so a real-machine
 *  run shows WHICH branch was taken. */
async function anchorFirstSurface(): Promise<void> {
  const c = await fetchCaretRect();
  if (!c) {
    const fallback = defaultTopCenter(window.screen?.width ?? 1920, CAPSULE_WIDTH);
    commitPos(fallback);
    appendForensic('capsule', `anchor: no caret → top-center ${fallback.x},${fallback.y}`);
    return;
  }
  // Reserve the tallest AMBIENT form (speaking, 200) rather than the current idle
  // height: the capsule grows downward from its top-left on morph resize, so
  // reserving the growth is what guarantees a flipped-above capsule can never
  // expand over the caret (red line: never obscure the caret). Through windowHeightFor because
  // what actually occupies the screen is the WINDOW, chrome included.
  const size = { width: CAPSULE_WIDTH, height: windowHeightFor(CAPSULE_HEIGHT.speaking) };
  const target = anchorToCaret(
    { x: c.x, y: c.y, width: c.width, height: c.height },
    { x: c.work_x, y: c.work_y, width: c.work_width, height: c.work_height },
    size,
  );
  commitPos(target);
  appendForensic(
    'capsule',
    `anchor: caret ${Math.round(c.x)},${Math.round(c.y)} ${Math.round(c.width)}x${Math.round(c.height)} ` +
      `work ${Math.round(c.work_x)},${Math.round(c.work_y)} ${Math.round(c.work_width)}x${Math.round(c.work_height)} ` +
      `→ ${target.x},${target.y}`,
  );
}

/** ⚙ (R6 T-5c, REDESIGN §5.2): open the L1 main-window SETTINGS page. The
 *  diagnostics card stays on the status dot ("clicking the status dot =
 *  diagnostics detail") — before this
 *  both controls opened the diag card and the settings entry point was zero. */
function openSettings(): void {
  navigateMain('settings'); // set the page first so the window never flashes the device page
  showMainWindow();
  appendForensic('capsule', 'gear → main window settings page');
}

onMounted(() => {
  // REQ-12-15: the only signal that survives a native drag. The OS runs a modal
  // move loop, so no pointermove / pointerup reaches this document while the
  // user is dragging — `tauri://move` is what tells us it happened, and its
  // quiet tail is where we read the final position back. Never unlistened: this
  // window is created once and only ever hidden, so its lifetime is the app's.
  void capsule.onMoved(() => {
    if (osDragging) scheduleSettle();
  });
  // First-surface placement chain (owner ruling D1):
  //   ① persisted drag position → applied now and wins FOREVER (no caret anchoring);
  //   ② otherwise → caret anchoring on the first surface edge (controller seam);
  //   ③ caret unavailable → top-center (inside anchorFirstSurface).
  const saved = loadPos(kv);
  if (saved) {
    // Clamp before committing: a point saved under a different scale factor, or on a
    // monitor since disconnected, must never strand the capsule where no one can
    // reach it. screen.avail* is CSS px = the logical space commitPos speaks.
    const work = {
      x: 0,
      y: 0,
      width: window.screen?.availWidth ?? window.screen?.width ?? 1920,
      height: window.screen?.availHeight ?? window.screen?.height ?? 1080,
    };
    const size = { width: CAPSULE_WIDTH, height: windowHeightFor(CAPSULE_HEIGHT.speaking) };
    const target = clampToWork(saved, work, size);
    commitPos(target);
    const note =
      target.x === saved.x && target.y === saved.y
        ? `anchor: persisted drag position ${saved.x},${saved.y} (caret skipped)`
        : `anchor: persisted ${saved.x},${saved.y} was OUTSIDE the work area → clamped to ${target.x},${target.y}`;
    appendForensic('capsule', note);
  } else {
    // Registered BEFORE initCapsule so the very first tick's visible edge sees it.
    setFirstSurfaceAnchor(anchorFirstSurface);
  }
  void initCapsule();
});

const BAR_WEIGHTS = [0.4, 0.7, 1, 0.6, 0.9, 0.5, 1, 0.85, 0.6, 1, 0.7, 0.9, 0.5, 0.8, 0.6, 0.45];
const bars = computed(() =>
  BAR_WEIGHTS.map((w) => Math.max(3, Math.min(26, 4 + state.level * 26 * w))),
);
// GA-25: the header slot shows the LIVE foreground target, or「—」when there is
// no injectable one. (The ministat row below keeps `cap_target_none` — that row
// reports the LOCK, not the destination.)
const targetText = computed(() => state.target || S.cap_target_dash);

// owner 2026-07-27: keep the live transcript scrolled to its newest line. The
// element only exists in the `speaking` form, so the ref is null the rest of the
// time — hence the guard rather than a bare assignment.
const interimEl = ref<HTMLElement | null>(null);
watch(
  () => `${state.finalText}${state.interim}`,
  async () => {
    await nextTick();
    const el = interimEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);

// R6-R2: honest STT engine diagnostic — gray "undetected" (未探测) until a real engine-status
// arrives, then provider + ready(g)/reconnecting(y)/failed(r).
const engineDot = computed(() =>
  !state.engineKnown
    ? 'o'
    : state.engineStatus === 'ready'
      ? 'g'
      : state.engineStatus === 'reconnecting'
        ? 'y'
        : 'r',
);
const engineLabel = computed(() =>
  !state.engineKnown
    ? S.cap_stt_unknown
    : state.engineStatus === 'ready'
      ? S.cap_stt_ready
      : state.engineStatus === 'reconnecting'
        ? S.cap_stt_reconnecting
        : S.cap_stt_failed,
);

// T-5b: same deriveConnDot as the main-window sidebar (one truth).
const connView = computed(() =>
  deriveConnDot({
    connected: state.connected,
    registered: state.registered,
    // RV-新B — the channel of the very CONNECTION frame `connected`/`registered` came
    // from, not the deleted `cloud.channel` preference (a constant 'lan', which meant a
    // pure-cloud user's red relay fault was never even asked about here).
    channel: state.channel,
    sidecarPhase: state.sidecarPhase,
    cloud: state.cloud,
  }),
);
/** The address of the channel currently carrying the runtime — derived, so a primary
 *  flip cannot leave the other channel's address on screen. '' ⇒ the row is omitted
 *  (never a guessed address). */
const endpointLine = computed(() =>
  state.channel === 'cloud' ? state.cloud.endpoint : state.sidecarEndpoint,
);
/** Speaking form keeps the red pulse (utterance latch), not a connection colour. */
const headerDot = computed(() => (state.form === 'speaking' ? 'r pulse' : connView.value.dot));
watch(
  () => connView.value.detail,
  (d) => {
    if (d) state.lastLoudReason = d;
  },
);
</script>

<template>
  <div class="wrap">
    <!-- just injected (0.8s, click-through) -->
    <div v-if="state.form === 'just_injected'" class="caps-ok">
      <div class="crow">
        <span class="okic"><Icon name="check" /></span>
        <!-- 🔴 owner 2026-08-07 甲-3 — ONE verdict, ONE word across both PC surfaces.
             The green card splits on ③evidence exactly as the timeline row does
             (lib/status.ts): confirmed ⇒ "injected" (已注入), otherwise ⇒ "delivered"
             (已送入). Same idiom as the
             failure card below (`cached ? S.cap_cached : S.cap_inject_failed`), and
             both words are REFERENCES to the timeline catalogue, not copies
             (lib/strings/capsule.ts, doc 15 §2.5c).
             ⚠️ The "(not confirmed)" parenthetical is deliberately NOT drawn here: this
             card is one CSS-forced fixed-height row (lib/capsule-morph.ts
             CAPSULE_HEIGHT.just_injected is EXACT, not a model). Same word, consistent
             in both places; a difference in verbosity is not drift. -->
        <span class="oktxt">{{ state.injected?.confirmed ? S.cap_injected : S.cap_delivered }} {{ S.to }} {{ state.injected?.target || targetText }}</span>
        <span class="oksub" v-if="state.injected">{{ state.injected.chars }} {{ S.cap_chars }} · {{ state.injected.seconds.toFixed(1) }} {{ S.cap_secs }}</span>
      </div>
    </div>

    <!-- inject failed / cached (1.5s, spec E-5 / RV-43 §4) — never the green lie.
         Two sentences over two colours, both of them SEGMENT ② words (卡 L7,
         docs/rebuild/15 §2.0):
         amber 📥 "not injected · cached" (mode:cached — this PC got the frame and could
         not type it anywhere; it is kept on the timeline and can be re-injected);
         red ✗ "not injected" + reason (hard failure — the word was "unsuccessful"
         until owner deleted "failed"/"unsuccessful"-class wording on 2026-08-07; it now
         REFERENCES
         st_failed, so the timeline and this card cannot drift). The retired readback-uncertain
         face left with the 0.2.22 readback gate.
         ⚠️ This comment originally read "same four faces as the phone / not delivered" —
         that was the defect itself, kept here as a correction record: the frame had
         already reached this PC; it is injection that failed, not delivery. -->
    <div v-else-if="state.form === 'inject_failed'" class="caps-fail" :class="{ cached: state.injectFailed?.cached }">
      <div class="crow">
        <!-- inbox = 📥 not injected · cached; x = ✗ not injected. The GLYPHS still match the
             phone's; the WORDS deliberately no longer do (卡 L7 — the phone
             speaks segment ①, this window speaks segment ②). -->
        <span class="failic"><Icon :name="state.injectFailed?.cached ? 'inbox' : 'x'" /></span>
        <span class="failtxt">
          {{ state.injectFailed?.cached ? S.cap_cached : S.cap_inject_failed }}
          <template v-if="state.injectFailed?.target"> {{ S.to }} {{ state.injectFailed.target }}</template>
        </span>
        <!-- ✗ has always had a reason line. 🔴 📥 now has one too, but only under
             **named causes** (owner 2026-08-02
             F1a): when 卡 L7 removed it, `cached` had only one cause — "not injected ·
             cached" + "no input
             focus found" was the same sentence said twice; now it has three, two of
             which the user could never guess from the badge alone
             (② this is a deferred auto-redelivery deliberately not injected
             ③ focus is on FlowMic's own window).
             The criterion is `cachedCause` (controller.ts, reading the shared CACHED_CAUSE_CODES),
             not "show the reason too whenever cached" — `INJECT_FOCUS_LOST` is deliberately not in the set.
             The wording shares **one source** with the timeline (lib/strings/capsule.ts INJECT_FAIL_REASON, doc 15 §2.5c). -->
        <span class="failsub" v-if="!state.injectFailed?.cached && state.injectFailed?.reason">{{ state.injectFailed.reason }}</span>
        <span class="failsub" v-else-if="state.injectFailed?.cachedCause">{{ state.injectFailed.cachedCause }}</span>
      </div>
    </div>

    <!-- speaking / idle / idle_with_history -->
    <div v-else class="caps">
      <div class="crow" @pointerdown="onHeaderDown" @pointermove="onHeaderMove" @pointerup="onHeaderUp" @pointercancel="onHeaderUp">
        <span class="dot" :class="headerDot" :title="connView.detail ?? connView.label" @click="toggleDiag"></span>
        <!-- v0.2.1: the phone name is its OWN element. It used to be a bare text
             node, and `.crow .sess > span:first-child` (capsule.css) — the rule
             written to keep it on one line — therefore landed on the CHANNEL CHIP
             instead, because `:first-child` only ever matches elements. owner's
             screenshot showed both halves of that: "Cloud Relay" (云端中继) truncated to
             "Cloud…" (云端…) while the phone name wrapped the header to two lines. -->
        <span class="sess"
          ><span class="sess-name" :title="state.session">{{ state.session }}</span
          ><span class="chan" :class="CHANNEL_VISUAL[state.channel].css"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" v-html="CHANNEL_VISUAL[state.channel].iconPath"></svg>{{ connChannelLabel(state.channel) }}</span></span
        >
        <!-- owner 2026-07-27: the full title lives in the tooltip; the chip
             itself stays one line so it cannot push the header to two. -->
        <span class="tgt" :title="targetText">
          <Icon :name="state.locked ? 'lock' : 'target'" /><span class="tgt-text">{{ targetText }}</span>
        </span>
        <button class="cbtn" :title="S.cap_settings" @click="openSettings"><Icon name="gear" /></button>
        <!-- owner 2026-07-27: not closable while transcribing. Disabled rather
             than hidden, so the control does not move under the cursor and the
             tooltip can say WHY the click is refused. -->
        <button
          class="cbtn"
          :class="{ inert: state.speaking }"
          :disabled="state.speaking"
          :title="state.speaking ? S.cap_dismiss_busy : S.cap_dismiss"
          @click="dismiss"
        ><Icon name="x" /></button>
      </div>

      <!-- diagnostics (T-5b: real fields only — omit when absent) -->
      <div v-if="state.diagOpen" class="diag">
        <h4>{{ S.cap_diag }}</h4>
        <div class="drow"><span class="dot" :class="connView.dot"></span>{{ connView.label }}<span class="chan chan-diag" :class="CHANNEL_VISUAL[state.channel].css"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" v-html="CHANNEL_VISUAL[state.channel].iconPath"></svg>{{ connChannelLabel(state.channel) }}</span></div>
        <div v-if="endpointLine" class="drow">{{ S.diag_endpoint }}<span class="v">{{ endpointLine }}</span></div>
        <div class="drow"><span class="dot" :class="connView.dot"></span>{{ S.cap_socket }}<span class="v">{{ state.connected ? S.cap_socket_ok : S.cap_socket_down }} · {{ state.registered ? S.diag_registered_yes : S.diag_registered_no }}</span></div>
        <div class="drow"><span class="dot" :class="state.phonePresent ? 'g' : 'o'"></span>{{ S.cap_phone_present }}<span class="v">{{ state.phonePresent ? S.cap_online : S.cap_offline }} · {{ state.mobiles }}</span></div>
        <div class="drow"><span class="dot" :class="engineDot"></span>{{ S.cap_stt_label }}<span v-if="state.engineProvider">&nbsp;{{ state.engineProvider }}</span><span class="v">{{ engineLabel }}</span></div>
        <div v-if="state.lastLoudReason" class="drow">{{ S.diag_loud }}<span class="v">{{ state.lastLoudReason }}</span></div>
      </div>

      <!-- speaking preview -->
      <div v-else-if="state.form === 'speaking'" class="preview">
        <!-- owner 2026-07-27: pinned to the BOTTOM. The box only ever showed its
             first three lines, so on a long utterance the words arriving right
             now were exactly the ones hidden. -->
        <div ref="interimEl" class="interim"><span class="fin">{{ state.finalText }}</span>{{ state.interim }}</div>
        <div class="meter"><i v-for="(h, i) in bars" :key="i" :style="{ height: h + 'px' }"></i></div>
        <div class="ministat">
          <!-- ⏳ waiting to inject (等待注入) — the speaking latch is still open, no inject:result yet.
               Distinct from 📥 not injected · cached (a verdict already came back).
               卡 L7: the word used to be "delivering" (投递中), a segment-① word on a face that
               is entirely about segment ② — this window IS the PC. -->
          <span><Icon name="clock" /> {{ S.cap_delivering }}</span>
          <span><Icon name="lock" /> {{ state.locked ? S.cap_locked : S.cap_target_none }}</span>
          <span><Icon name="seg" /> {{ S.cap_seg }} {{ state.segs }}</span>
        </div>
      </div>

      <!-- idle with recent history — V2-15 structured rows: content-status (内容状态) badge
           (MODE_BADGE, the V2-17 table this component was meant to reuse) +
           HH:mm + sender + the PROCESSED text by default; translate/organize
           rows offer the original one click away, inline. A missing field
           OMITS its cell (v-if) — nothing here is ever back-filled. -->
      <div v-else-if="state.form === 'idle_with_history'" class="recent">
        <div v-for="l in state.recent" :key="l.id" class="r" :class="rowStatusClass(l)">
          <div class="rline">
            <!-- v0.2.2 — an IMAGE row is a different kind of row, not a transcript
                 with a picture in it. It used to render the MODE badge, so a
                 photo wore the realtime waveform and read as something that had
                 been said. The picture itself is the best badge a 16px slot can
                 carry (you can tell WHICH image at a glance); a row whose phone
                 could not build a preview falls back to a generic icon rather
                 than showing a blank or inventing one. -->
            <button
              v-if="l.entryType === 'image'"
              type="button"
              class="rimg"
              :title="S.cap_image_open"
              @click="openImage()"
            >
              <img v-if="l.thumb" :src="`data:image/png;base64,${l.thumb}`" alt="" />
              <Icon v-else name="image" />
            </button>
            <span v-else-if="l.mode" class="mbadge rbadge" :class="MODE_BADGE[l.mode]?.cls" :title="MODE_BADGE[l.mode]?.label"><Icon :name="MODE_BADGE[l.mode]?.icon ?? ''" /></span>
            <span v-if="l.time" class="rtime">{{ l.time }}</span>
            <span v-if="deviceName(l)" class="rdev" :title="S.tl_sender_tip">{{ deviceName(l) }}</span>
            <span class="rtext" :title="l.text">{{ l.text }}</span>
            <button v-if="canShowSource(l)" type="button" class="rsrc" @click="toggleSource(l.id)">
              {{ expandedSrc.has(l.id) ? S.tl_hide_source : S.tl_show_source }}
            </button>
            <!-- V2-19 (owner 2026-08-01 §4b-7): omitted, not disabled, when the row has
                 nothing to copy (canCopyLine — the R8 gate, see capsule-copy.ts). -->
            <button
              v-if="canCopyLine(l)"
              type="button"
              class="rcopy"
              :class="{ err: copyStatus[l.id] === 'error', ok: copyStatus[l.id] === 'copied' }"
              :title="copyStatus[l.id] === 'error' ? S.op_copy_failed : S.op_copy"
              @click="copyLine(l)"
            ><Icon :name="copyStatus[l.id] === 'copied' ? 'check' : copyStatus[l.id] === 'error' ? 'x' : 'copy'" /></button>
          </div>
          <div v-if="canShowSource(l) && expandedSrc.has(l.id)" class="ropen">{{ S.tl_source_label }}{{ l.source }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* V2-15 structured recent rows. The form height (07 §1, idle_with_history=120)
   is owned by src/lib/capsule-morph.ts — outside this card's edit scope — so
   the strip SCROLLS inside the ~56px region the form leaves after the header,
   instead of letting .caps' overflow:hidden clip rows mid-line. */
.recent { max-height: 56px; overflow-y: auto; scrollbar-width: thin; }
/* Neutralise the legacy single-line ellipsis on .r (capsule.css): the flex
   .rline owns the one-line truncation now, and .ropen must be allowed to wrap. */
.recent .r { padding: 1px 0; white-space: normal; overflow: visible; text-overflow: clip; }
.rline { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
/* tokens.css' .mbadge is a 24px chip for the timeline card; the strip gets a
   16px one. .b1/.b2/.b3 colours come from tokens.css unchanged. */
.rbadge { width: 16px; height: 16px; border-radius: 5px; }
/* v0.2.2 — the image row's badge IS the picture. Same 16px slot the mode badge
   occupies so the strip's columns stay aligned whichever kind of row it is. */
.rimg { flex: none; width: 16px; height: 16px; border-radius: 5px; overflow: hidden; display: grid; place-items: center; background: var(--caps-hover); color: var(--t2); padding: 0; cursor: pointer; }
.rimg img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rimg .icon { width: 11px; height: 11px; }
.rimg:hover { outline: 1px solid var(--brand); outline-offset: 1px; }
.rbadge .icon { width: 11px; height: 11px; }
.rtime { flex: none; font-variant-numeric: tabular-nums; }
.rdev { flex: none; max-width: 32%; overflow: hidden; text-overflow: ellipsis; color: var(--t1); font-weight: 600; }
.rtext { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.rsrc { flex: none; font-size: 11px; color: var(--brand); padding: 0 2px; }
/* V2-19 per-row copy (owner 2026-08-01 §4b-7) — same 16px slot as .rbadge/.rimg
   so adding the button never grows the row (and with it the fixed-height
   idle_with_history form, 07 §1). */
.rcopy { flex: none; width: 16px; height: 16px; border-radius: 5px; display: grid; place-items: center; color: var(--t2); background: none; padding: 0; cursor: pointer; }
.rcopy:hover { background: var(--caps-hover); color: var(--t1); }
.rcopy .icon { width: 11px; height: 11px; }
.rcopy.ok { color: var(--green); }
.rcopy.err { color: var(--red); }
.ropen { padding: 1px 0 3px 22px; font-size: 11.5px; color: var(--t3); white-space: normal; word-break: break-all; }
/* 🔴 卡 L7 / owner 2026-08-02 — "a row for a message that wasn't injected
   should use a different background or style to distinguish it"
   (docs/rebuild/15 §2.5c-2). Two channels, deliberately, because ONE would be
   colour alone:
     · a LEFT BAR (3px) — a shape, so the row is still distinguishable in
       greyscale / for a colour-blind reader (the channel-badge principle);
     · a soft background — the fast read at a glance.
   The tokens are the SAME ones the 📥/✗ capsule faces use (--amber* / --red*),
   which is what "same status, one colour" means in practice. Both are theme-aware
   (tokens.css defines a dark variant of every one of them).
   ⚠️ `.r` already carries `padding: 1px 0` from the rule above; the padding-left
   here is what keeps the text from touching the bar. `noted` and an unknown /
   absent status get NO class at all (see rowStatusClass) — no rule fires. */
.recent .r.st-cached { border-left: 3px solid var(--amber); background: var(--amber-soft); padding-left: 5px; border-radius: 3px; }
.recent .r.st-failed { border-left: 3px solid var(--red); background: var(--red-soft); padding-left: 5px; border-radius: 3px; }
</style>
