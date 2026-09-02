// WP-R2-2 capsule HUD controller. Owns the two orthogonal capsule state spaces
// (capsule-morph FORM + capsule-visibility FSM) and drives the transparent window
// through the Rust shell commands (resize / click-through / non-activating
// surface / hide). Consumes the forwarded stt:* / audio:* / inject:result bridge
// channels, plus flowmic://focus-changed (GA-25) for the live "inject target" (注入目标). Reactive `state` is what CapsuleApp.vue renders.
//
// WP-R2-3: the capsule "speaking" latch is closed by a REMOTE event (inject:result).
// Per the CLAUDE.md red line every remote-closed latch carries a LOCAL watchdog —
// SpeakingWatchdog force-clears the latch after 6 s with no stt:interim/final/level
// so a dropped link / lost final never wedges the HUD in "speaking" (07 §3). Key
// capsule migrations (surface / dismiss / settled / latch force-clear) are mirrored
// to window-forensics.log via appendForensic (07 §10).

import { reactive } from 'vue';
import { CAPSULE_WIDTH, CapsuleMorph, type Morph } from '../lib/capsule-morph';
import { CapsuleVisibility } from '../lib/capsule-visibility';
import { SpeakingWatchdog } from '../lib/speaking-watchdog';
import {
  CH,
  appendForensic,
  capsule,
  fetchCloudStatus,
  fetchConnectionSnapshot,
  fetchPairedMobiles,
  fetchSidecarState,
  onChannel,
  UI_TIMELINE_ROW_GONE,
  type SidecarStatus,
} from '../lib/bridge';
import type { PairedMobile } from '../lib/paired-mobiles';
import { asCloudStatus, EMPTY_CLOUD_STATUS, type CloudStatus } from '../lib/channel';
import { nextFocusTarget } from '../lib/focus-target';
import { INJECT_FAIL_REASON, S } from '../lib/strings';
import { CACHED_CAUSE_CODES } from '../lib/strings/capsule';
import { asChannelTag } from '../lib/timeline-store';
import type { ChannelTag, ConnectionState, InjectResult, WireHistoryItem } from '../lib/types';

// ── "delivered-in record" (转入记录) row model —— `RecentLine` / `RecentStatus` / `toRecentLine` /
//    `upsertRecentLine` (and the deleted-`mergeRecentSeed` note) moved VERBATIM to
//    recent-line.ts (800-line cap). Re-exported here so no import site moved.
import { toRecentLine, upsertRecentLine, type RecentLine } from './recent-line';
export { toRecentLine, upsertRecentLine } from './recent-line';
export type { RecentLine, RecentStatus } from './recent-line';

// V2-16 — `deriveSessionTitle` and its doc moved VERBATIM to session-title.ts
// (800-line cap). Re-exported here so no import site moved.
import { deriveSessionTitle } from './session-title';
export { deriveSessionTitle } from './session-title';

// CONNECTION admission + phone-name directory (`onConnection` / `seedConnection` /
// `refreshMobileDirectory` / `acceptRecentChannel` / the two primaryChannel test hooks)
// moved VERBATIM to connection-directory.ts (800-line cap). Re-exported here so no
// import site moved.
import {
  acceptRecentChannel,
  onConnection,
  primaryChannelForTest,
  refreshMobileDirectory,
  resetDirectoryEdgeForTest,
  resetPrimaryChannelForTest,
  seedConnection,
  setConnectionSnapshotFetcher,
  setDirectoryFetcher,
} from './connection-directory';
export {
  acceptRecentChannel,
  onConnection,
  primaryChannelForTest,
  refreshMobileDirectory,
  resetDirectoryEdgeForTest,
  resetPrimaryChannelForTest,
  seedConnection,
  setConnectionSnapshotFetcher,
  setDirectoryFetcher,
} from './connection-directory';




// Shared runtime instances (`morph`/`vis`/`watchdog`) and the reactive `state`
// moved VERBATIM to capsule-state.ts (800-line cap; also breaks the import cycle
// connection-directory.ts would otherwise create — see that file's header).
// Re-exported here so no import site moved.
import { morph, state, vis, watchdog } from './capsule-state';
export { morph, state, vis, watchdog } from './capsule-state';

let speakStart = 0;
/** E2 (2026-09-02) — true only between an onAudioStart and the inject:result that
 *  settles it. An image send or a manual-text inject never calls onAudioStart, so
 *  `speakStart` stays at whatever the PREVIOUS utterance left it (or 0) and
 *  `state.finalText`/`interim` likewise still hold the previous spoken text — before
 *  this flag existed, onInjectResult built `chars`/`seconds` from those stale values
 *  unconditionally: an image inject showed the last utterance's char count, and a
 *  manual-text inject with `speakStart` still 0 showed the elapsed-since-epoch
 *  duration, roughly 1.7e9 seconds. This is reset to false every time onInjectResult
 *  consumes it, so it answers "did AUDIO happen for the utterance this result is
 *  settling" and nothing carries over to the next one. */
let utteranceHadAudio = false;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
function pick(obj: unknown, ...keys: string[]): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

function onAudioStart(_p: unknown): void {
  const now = Date.now();
  morph.onSpeakingStart();
  vis.onAudioStart(now);
  watchdog.start(now);
  state.interim = '';
  state.finalText = '';
  state.segs = 0;
  state.injected = null;
  state.injectFailed = null;
  state.locked = true;
  speakStart = now;
  utteranceHadAudio = true;
  // 卡 D-a — the `device_label` read that used to live here is GONE. It was a dead
  // branch defended by a false comment (see deriveSessionTitle): `AudioStartSchema`
  // (packages/protocol/src/protocol-schemas-audio.ts) declares no such key, zod strips
  // unknown keys, and the server fans out `parsed.data` (audio.handler.ts) — so the
  // read was unreachable BY CONSTRUCTION, whatever any sender did. `recent.test.ts`
  // was green because it assigned `state.session` directly instead of going through
  // this payload. The title comes from `deriveSessionTitle` (pc:list-mobiles live
  // presence), which is a real source.
  //
  // ⚠️ The phone DOES stamp a `device_label` — on `inject:request` (卡 P/M), where it
  // names the sender of a ROW, not the owner of the capsule title. Do not reconnect
  // this branch to it: it arrives at the END of an utterance, so it could not title a
  // capsule that is already up, and the two answer different questions.
}
function onAudioStop(_p: unknown): void {
  // Speak ended; the inject:result (or the latch watchdog) moves the form on. The
  // lock is retained until an inject resolves (mirrors the Rust SPEAKING-lock
  // ruling), and audio:stop is NOT a watchdog heartbeat — if the final never
  // arrives, the 6 s silence from the last real signal must still trip it.
}

/** 卡 F1 — the phone went to background (`audio:pause`, S→PC via
 *  socket/client.rs). owner ruling ①: "the computer should consider the phone
 *  'paused' (still paired, just with the capsule collapsed)".
 *
 *  🔴 The list of things this deliberately does NOT do IS the ruling, and every
 *  one of them is asserted in controller.test.ts:
 *    · `state.mobiles` / `state.phonePresent` / `state.mobileNames` — untouched.
 *      They are the presence surface; moving them is "the phone left", which would make the
 *      device page say "no phone currently connected" because the user switched windows.
 *    · `state.connected` / `state.registered` / `state.channel` — untouched. The
 *      pairing and the room are not a function of which app is in front on a phone.
 *    · `state.recent` — untouched. Collapsing is not forgetting.
 *    · the SPEAKING latch (`state.locked`, `watchdog`) — untouched. A phone that
 *      backgrounds mid-utterance still owns the window it locked; the utterance is
 *      paused, not cancelled, and audio:resume continues it.
 *  The ONE thing that moves is the visibility FSM. */
function onAudioPause(_p: unknown): void {
  vis.onPhonePaused();
  appendForensic('capsule', 'audio:pause → capsule retreats (phone paused, still paired)');
}

/** 卡 F1 — the phone is back in the foreground (`audio:resume`). The capsule
 *  returns to whatever the visibility FSM says it should be — not forced visible;
 *  see CapsuleVisibility.onPhoneResumed. */
function onAudioResume(_p: unknown): void {
  vis.onPhoneResumed();
  appendForensic('capsule', 'audio:resume → capsule restored (phone foregrounded)');
}

/** Test seams for the two above. The handlers themselves stay module-private like
 *  their audio:start/stop siblings — production reaches them through `onChannel`
 *  in [[initCapsule]], which is the grep-able producer↔consumer pair. The
 *  visibility reader exists because `state.visible` is only refreshed by [[tick]]
 *  (its single owner), and a test must not have to run the render loop to ask
 *  "has the capsule been collapsed". Naming follows primaryChannelForTest / resetDirectoryEdgeForTest. */
export function firePhonePausedForTest(p: unknown = {}): void {
  onAudioPause(p);
}
export function firePhoneResumedForTest(p: unknown = {}): void {
  onAudioResume(p);
}
export function capsuleVisibleForTest(): boolean {
  return vis.visible;
}


function onInterim(p: unknown): void {
  morph.onSpeakingStart();
  state.interim = str(pick(p, 'text'));
  watchdog.signal(Date.now());
}
function onFinal(p: unknown): void {
  state.finalText = str(pick(p, 'text'));
  state.segs += 1;
  watchdog.signal(Date.now());
}
function onLevel(p: unknown): void {
  const raw = num(pick(p, 'level', 'rms', 'value'));
  state.level = Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
  watchdog.signal(Date.now());
}
export function onInjectResult(p: unknown): void {
  const now = Date.now();
  const r = p as InjectResult;
  watchdog.stop(); // latch closed normally by the remote inject:result
  vis.onSettled(); // injected | cached | inject_failed are ALL settled (INV-4)
  appendForensic('capsule', `settled ok=${r?.ok === true} mode=${r?.mode ?? '?'}`);
  state.locked = false;
  // Target only from THIS result. Never reuse a stale prior-success target — that
  // would falsely claim a focus-lost/cached utterance landed somewhere it did not.
  //
  // ⚠️ CORRECTED 2026-08-07 (IJ-01). This line's own comment used to end 「(absent on
  // any non-injected outcome per the wire)」 — TRUE when written, and it is why the
  // failure face's `v-if="state.injectFailed?.target"` in CapsuleApp.vue was
  // permanently false (the design doc §1.4 lists it as a gap, not as a design). `focus_window`
  // now answers the non-injected case, so the slot that was always there fills.
  const resultTarget = str(pick(r.inject_target, 'window_title')) || str(r.target_window);
  // 🔴 THE FAILURE FACE'S TARGET, AND WHY IT MAY USE THE WINDOW TITLE.
  // This is the THIS-TIME display owner ruling (c) explicitly permits: the capsule flash
  // lasts 1.5 s and the capsule persists nothing, so no title lands in a table. The
  // durable half — the timeline row — takes `process_name` only (TimelineRow
  // .focus_process). Do not implement "not persisted to the DB" as "not shipped" (design doc §4-5, implementation boundary 1).
  //
  // 🔴 DELIBERATELY NOT USED ON THE ok:true PATH BELOW. That path's 「NO FALLBACK」
  // rule (F1a) is about not naming a place we did not observe, and §A-1 keeps
  // `focus_window` off the two ok:true branches that observe nothing (RV-83 replay,
  // admission refusal) — but a fallback here would be a SECOND source for one field
  // and "injected → X" must keep exactly one author. Success-path behaviour: unchanged.
  const focusTarget = str(pick(r.focus_window, 'window_title'))
    || str(pick(r.focus_window, 'process_name'));
  if (r.ok) {
    // ── delivered → the truthful green "injected" (已注入) flash ──
    morph.onInjected(now);
    state.injectFailed = null;
    if (resultTarget) state.target = resultTarget;
    state.injected = {
      // 🔴 NO FALLBACK TO `state.target` (F1a). That holds the last EXTERNAL
      // foreground; a verdict naming no window did not land in it. Both producers of
      // a target-less ok:true would have been misreported by `|| state.target`: a
      // self-window injection (would read "injected → Cursor" for text typed into
      // FlowMic) and RV-83's disk replay, whose own doc forbids re-claiming a place
      // it never observed. '' renders as no arrow — never a fabricated destination.
      target: resultTarget,
      // E2 (2026-09-02) — `null` for an image send or a manual-text inject: neither
      // ever ran onAudioStart, so there is no spoken text and no speech-start clock
      // to measure against. Before this guard the sub-line still rendered — with
      // whatever `state.finalText`/`interim` a PRIOR utterance had left behind for
      // "chars", and `(now - speakStart)/1000` for "seconds" (≈1.7e9 s when
      // `speakStart` was still its initial 0).
      metrics: utteranceHadAudio
        ? {
            chars: [...(state.finalText || state.interim)].length,
            seconds: Math.max(0, (now - speakStart) / 1000),
          }
        : null,
      // `=== 'editable'` and nothing looser: absent and 'unknown' and 'not_editable'
      // all mean we cannot claim confirmation (see the field's doc above).
      confirmed: r.focus_evidence === 'editable',
    };
    // V2-15: NO recent-line append here any more. The strip is driven by the
    // history wire (onHistoryItem below), whose rows carry content-status/original-text/
    // timestamp/sending-device (内容状态/原文/时间戳/发送设备) that this payload does not — and the phone lands history:create
    // BEFORE the inject:request, so the structured line is already up by the
    // time this result arrives.
  } else {
    // ── NOT delivered (R6-R1, red line: no silent failure) → the truthful failure flash.
    // cached (mode:'cached', INJECT_FOCUS_LOST) = preserved to the timeline (amber);
    // any other non-ok = a hard delivery failure (red). Never the green lie. ──
    morph.onInjectFailed(now);
    state.injected = null;
    const cached = r.mode === 'cached';
    const code = str(r.error);
    state.injectFailed = {
      // `resultTarget` first only for symmetry with the green face; on this branch the
      // wire never fills it, so `focusTarget` is what actually shows. '' → no arrow.
      target: resultTarget || focusTarget,
      cached,
      // The ✗ face has always shown this. 🔴 The 📥 face now shows it TOO, but only
      // for a NAMED cause — see `cachedCause` below and docs/rebuild/15 §2.5e-4.
      reason: INJECT_FAIL_REASON[code] ?? S.cap_reason_unknown,
      // 🔴 WHY 📥 GOT A REASON LINE BACK (F1a). 卡 L7 removed it when `cached` had
      // ONE cause and "not injected · cached" + "no input focus found" was one sentence twice.
      // It now has THREE, two of which the badge cannot convey: ② this is a deferred
      // auto-redelivery deliberately not injected (nothing done to the window would help)
      // ③ focus is on FlowMic's own window (clicking into its own input box would let it land).
      // `INJECT_FOCUS_LOST` stays OUT of the set — L7's reasoning still holds for it.
      cachedCause: cached && CACHED_CAUSE_CODES.has(code)
        ? (INJECT_FAIL_REASON[code] ?? null)
        : null,
    };
  }
  // E2 — this result is settled; the NEXT one (which may be an image send or a
  // manual-text inject with no onAudioStart of its own) must not inherit "yes,
  // there was audio" from this utterance.
  utteranceHadAudio = false;
}
// The two writers of `state.target` are exported (GA-25) so the ordering contract
// between them — live focus vs. delivered truth — is unit-testable against the real
// reactive state; `initCapsule` below is still the only place that wires them to a
// channel. Nothing else in production calls them directly.
/** Live foreground target (GA-25). Grain = the foreground WINDOW/PROCESS; a caret
 *  move between two fields of the SAME window raises no foreground event (F-2344)
 *  and correctly leaves the display alone. Frozen while `locked` (see
 *  nextFocusTarget) — the view already shows 🔒 off that same flag. */
export function onFocusChanged(p: unknown): void {
  const next = nextFocusTarget(state.target, state.locked, p);
  if (next !== state.target) state.target = next;
}
/** Real STT engine health (R6-R2). Only a genuine stt:engine-status marks the
 *  engine "known"; before the first one the diagnostic honestly reads "undetected" (未探测). */
function onEngineStatus(p: unknown): void {
  const provider = str(pick(p, 'provider'));
  const status = str(pick(p, 'status'));
  if (provider) state.engineProvider = provider;
  if (status === 'ready' || status === 'reconnecting' || status === 'failed') {
    state.engineStatus = status;
    state.engineKnown = true;
  }
}
/** ✅ HAS A PRODUCER AGAIN (卡 P + 卡 D). Between 0.2.27 and the row-transit round no
 *  frame could reach this and the strip was permanently empty; the replacement arrival
 *  path has landed and it is the DELIVERY FRAME. `inject:request` now carries the six
 *  additive fields a row is made of, and this machine's own `socket::row_transit` mints
 *  `{item, channel}` onto the same bridge channel the server's retired broadcast used.
 *  So the strip refills from real deliveries — but note WHAT CHANGED for a RecentLine:
 *  the item carries `device_label` and NOT `mobile_id` (the relay forwards the inject
 *  frame verbatim and it has no pairing id), which is why [[RecentLine.deviceLabel]]
 *  exists and why the sender cell resolves in that order.
 *
 *  Exported so the channel filter is unit-testable against the real reactive
 *  state (same reason onConnection / onInjectResult are exported). */
export function onHistoryItem(p: unknown): void {
  const envelope = p as { item?: WireHistoryItem; channel?: string } | null;
  const item = envelope?.item;
  if (!item) return;
  if (!acceptRecentChannel(envelope?.channel)) return;
  // The stamp the sieve just accepted is the one the row keeps — not `state.channel`
  // read again later (owner 2026-07-31: an item carries its own address).
  const line = toRecentLine(item, state.channel);
  if (!line) return;
  state.recent = upsertRecentLine(state.recent, line);
  // A sender the directory has never seen (paired while we were not looking) →
  // refresh so the row can NAME it; until then its device cell stays omitted.
  if (line.mobileId && !(line.mobileId in state.mobileNames)) void refreshMobileDirectory();
}
/** A row is GONE from the timeline — drop it from the strip, so the HUD never claims a
 *  record that no longer exists (X3).
 *
 *  TWO SOURCES, ONE ANSWER, and the second one is why this survived 0.2.27:
 *   · `history:deleted` (a PEER delete). NO PRODUCER any more — the server stores no
 *     transcripts, and a phone can no longer delete a PC row at all.
 *   · `flowmic://ui-timeline-row-gone`, emitted by the main window when the USER
 *     deletes a row (lib/bridge.ts notifyRowRemoved). This is the case X3's fix never
 *     actually covered: a room broadcast excludes the emitter, and both windows share
 *     one socket, so a delete made in the main window never came back to us. The strip
 *     has therefore always kept locally-deleted rows on screen — and since a local
 *     delete is now the ONLY kind, that latent gap would have become every case. Wiring
 *     it here is what keeps the retirement from fixing one fault by creating another (修一个故障造出另一个).
 *
 *  Same channel sieve either way — no stamp → drop (0.2.18); wrong channel → drop —
 *  because `(channel, id)` is a row's address and the strip shows one channel's rows. */
export function onHistoryDeleted(p: unknown): void {
  const envelope = p as { id?: string; channel?: string } | null;
  const id = typeof envelope?.id === 'string' ? envelope.id : '';
  if (id === '') return;
  if (!acceptRecentChannel(envelope?.channel)) return;
  state.recent = state.recent.filter((r) => r.id !== id);
}
/** Cloud KEY status for deriveConnDot's loud reason + the relay's address (R6 T-2 /
 *  T-5b). RV-新B: it no longer carries "which channel is current" — that is `state.channel`, off
 *  the CONNECTION frame, and this payload is pushed only when the cloud CONFIG changes
 *  (i.e. never on the join/leave edge that moves the answer). */
function onCloudState(p: unknown): void {
  state.cloud = asCloudStatus(p);
}
function onSidecarState(p: unknown): void {
  const s = p as SidecarStatus;
  state.sidecarPhase = typeof s?.phase === 'string' ? s.phase : null;
  // The LAN address is honest only when the sidecar reports one. Stored unconditionally
  // (no channel test): "what is the local service's address" does not depend on which channel is
  // current — whether it is the one on SHOW does, and that is the view's question.
  if (typeof s?.endpoint === 'string' && s.endpoint) state.sidecarEndpoint = s.endpoint;
}
/** Tray user-gesture summon (R6-C2): re-sync the visibility FSM to persistent so
 *  the frontend and the native (already-surfaced) window agree — and so a later
 *  utterance settle does not retreat a tray-summoned capsule. */
function onTraySummon(): void {
  vis.onTraySummon();
  appendForensic('capsule', 'tray summon → persistent (FSM re-sync)');
}

// ── first-surface anchor seam (R6 T-1, owner ruling D1) ──
// CapsuleApp registers the caret-anchoring routine here; the drive loop runs it
// ONCE, on the first hidden→visible edge, BEFORE surfacing (so the capsule never
// appears at a stale position and then jumps). Running it on the surface edge —
// rather than at mount — is what makes the caret reading fresh; clearing the slot
// after the first run is what implements "never re-anchor to focus mid-session". Not registered at
// all when a persisted drag position exists (explicit intent wins forever).
let firstSurfaceAnchor: (() => Promise<void>) | null = null;

export function setFirstSurfaceAnchor(fn: () => Promise<void>): void {
  firstSurfaceAnchor = fn;
}

async function surfaceWithAnchor(): Promise<void> {
  if (firstSurfaceAnchor) {
    const anchor = firstSurfaceAnchor;
    firstSurfaceAnchor = null; // anchor only once; even if this position read fails, do not retry
    try {
      await anchor();
    } catch {
      // Anchoring is best-effort observation of the OS — a failure must never
      // block the surface (the capsule then shows wherever it already is).
    }
    // The FSM may have retreated during the (sub-tick) caret round-trip; surfacing
    // then would resurrect a capsule the user just dismissed. The next tick sees
    // the visible→hidden edge and hides the native window.
    if (!vis.visible) {
      appendForensic('capsule', 'surface aborted — retreated while anchoring');
      return;
    }
  }
  capsule.surface();
  appendForensic('capsule', 'surface (ambient, non-activating)');
}

// ── the render/drive loop ──
let lastHeight = -1;
let lastClickThrough = false;
let lastVisible = false;
/** How often a VISIBLE capsule re-asserts itself against the OS (ms). */
const REASSERT_MS = 2000;
let reassertAt = 0;

/** Local latch watchdog (07 §3) clear block — ONE author for tick() and the
 *  test. 6 s of no interim/final/level → force-clear the wedged "speaking"
 *  latch back to idle + forensic point; the normal path still closes the latch
 *  via inject:result (watchdog.stop), this is the jammed-latch (楔死) backstop only.
 *
 *  🔴 WP8-acceptance (owner hit it live): this must clear BOTH holders of the
 *  speaking fact — `morph`'s form latch AND `vis.speaking`, the × gate. It
 *  used to clear only the morph half, so every utterance that legitimately
 *  ends WITHOUT an inject:result (silence-empty, swipe-up cancel, a manual
 *  draft awaiting confirm, record-only) left the × grey until the phone left
 *  the room — the WP-R2-3 header promised 「a lost final never wedges the HUD
 *  in speaking」 and delivered it to one holder only. Starvation IS
 *  settlement: `vis.onSettled()` also retreats a talk_triggered capsule,
 *  which is what a settled utterance does. */
function onLatchStarved(): void {
  morph.onSpeakingEnd();
  vis.onSettled();
  state.locked = false;
  state.interim = '';
  appendForensic('capsule', 'latch-watchdog force-clear (6s signal starvation)');
}

/** Test hooks (same precedent as [firePhonePausedForTest]): the watchdog-clear
 *  glue and the × gate it must release are otherwise private to this module. */
export function fireLatchStarvedForTest(): void {
  onLatchStarved();
}
export function fireAudioStartForTest(): void {
  vis.onAudioStart(Date.now());
}
/** E2 test seam — drives the REAL private onAudioStart handler (not just the
 *  visibility half `fireAudioStartForTest` above touches), so a test can put
 *  `utteranceHadAudio` into its true production-only state before asserting on
 *  `state.injected.metrics`. */
export function fireRealAudioStartForTest(): void {
  onAudioStart({});
}
export function speakingForTest(): boolean {
  return vis.isSpeaking();
}

function tick(): void {
  const now = Date.now();
  if (watchdog.check(now)) onLatchStarved();
  morph.setHistoryCount(state.recent.length);
  morph.drawerOpen = state.diagOpen;

  state.form = morph.state(now);
  state.visible = vis.visible;
  state.speaking = vis.isSpeaking();

  const h = morph.windowHeight(now);
  if (h !== lastHeight) {
    capsule.resize(CAPSULE_WIDTH, h);
    lastHeight = h;
  }
  const ct = morph.clickThrough(now);
  if (ct !== lastClickThrough) {
    capsule.clickThrough(ct);
    lastClickThrough = ct;
  }
  if (vis.visible !== lastVisible) {
    if (vis.visible) {
      // async only for the FIRST edge (the caret read); lastVisible is updated
      // synchronously below so the edge can never re-fire while it is in flight.
      void surfaceWithAnchor();
    } else {
      capsule.hide();
      appendForensic('capsule', 'retreat to tray');
    }
    lastVisible = vis.visible;
    reassertAt = now + REASSERT_MS;
  } else if (vis.visible && now >= reassertAt) {
    // owner 2026-07-27: the FSM said VISIBLE, the log said `surface`, and the
    // native window was hidden — measured, hwnd vis=False. Surfacing was
    // EDGE-ONLY, so any divergence (a ShowWindow the OS declined — e.g. issued
    // while the session was locked — or an external hide) was permanent: the
    // edge never fires again, and the capsule is gone for the rest of the
    // session with the FSM insisting it is up. Re-assert instead of believing.
    // ShowWindow on an already-visible window is a no-op, so this costs nothing
    // in the normal case; "a latch closed by a remote event must have a local watchdog" applies to the
    // window itself, not only to the latch.
    reassertAt = now + REASSERT_MS;
    capsule.surface();
  }
}

export function dismiss(): void {
  // owner 2026-07-27: refused while transcribing. The button is disabled in that
  // state, so this is the belt to that suspenders — and it is recorded, because a
  // × that silently does nothing is indistinguishable from a broken one.
  if (!vis.onDismiss(Date.now())) {
    appendForensic('capsule', 'dismiss REFUSED — an utterance is in flight');
    return;
  }
  capsule.hide();
  appendForensic('capsule', 'dismiss (× → tray, 3s suppress)');
}
export function toggleDiag(): void {
  state.diagOpen = !state.diagOpen;
}

export async function initCapsule(): Promise<void> {
  await onChannel(CH.audioStart, onAudioStart);
  await onChannel(CH.audioStop, onAudioStop);
  // 卡 F1 — the phone's foreground/background edges. Registered right beside
  // start/stop because they ride the exact same S→PC fan-out leg.
  await onChannel(CH.audioPause, onAudioPause);
  await onChannel(CH.audioResume, onAudioResume);
  await onChannel(CH.sttInterim, onInterim);
  await onChannel(CH.sttFinal, onFinal);
  await onChannel(CH.sttLevel, onLevel);
  await onChannel(CH.sttEngineStatus, onEngineStatus);
  await onChannel(CH.injectResult, onInjectResult);
  await onChannel(CH.focusChanged, onFocusChanged);
  await onChannel(CH.connection, onConnection);
  await onChannel(CH.traySummon, onTraySummon);
  await onChannel(CH.cloudState, onCloudState);
  await onChannel(CH.sidecarState, onSidecarState);
  await onChannel(CH.historyUpdated, onHistoryItem);
  // `history:deleted` is still producer-less (see onHistoryDeleted); the two channels
  // below it are the LOCAL ones — the main window's own delete — and the one above has
  // its producer back (see onHistoryItem).
  await onChannel(CH.historyDeleted, onHistoryDeleted);
  await onChannel(UI_TIMELINE_ROW_GONE, onHistoryDeleted);
  // RV-07: the CONNECTION seed, AFTER the listeners above are registered. Order is
  // the whole point (same rule main-window/store.ts spells out): register first so
  // a frame arriving mid-seed is not lost, then pull so a frame that already fired
  // before this window existed is not lost either — both halves are idempotent.
  await seedConnection();
  // 0.2.27: the "delivered-in record" (转入记录) seed pull is GONE. It asked the server for the newest five
  // rows, and the server stores no transcripts (owner architecture ruling) — so it would have
  // answered empty forever, which on an empty strip is indistinguishable from a seed
  // that worked. Nothing replaces it: the strip shows what arrives WHILE the capsule
  // is up, which since the row-transit round is every genuine delivery, each one (每一次真投递) (see onHistoryItem). The
  // full history lives in the main window, which owns it.
  // Seed once (pushes only fire on CHANGE — a capsule that starts mid-session
  // must ask for the truth, including sidecar phase for LAN red).
  state.cloud = await fetchCloudStatus();
  const side = await fetchSidecarState();
  if (side) {
    state.sidecarPhase = side.phase;
    if (side.endpoint) state.sidecarEndpoint = side.endpoint;
  }
  setInterval(tick, 150);
  tick();
}
