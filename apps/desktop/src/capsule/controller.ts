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

/** V2-16 — the capsule title. The CONNECTION frame carries NO phone name (pump.rs
 *  build_connection emits connected/registered/room_uuid/mobiles/reason/channel/
 *  primary — that is the whole payload), so the label is derived from pc:list-mobiles
 *  live presence instead: exactly ONE online phone → its pairing name; zero or ≥2 →
 *  the generic default (naming one of several would be a guess).
 *
 *  ⚠️ CORRECTION (卡 D-a, 2026-07-31). This doc used to end "While an utterance is in
 *  flight the title belongs to audio:start's device_label — left alone", and that
 *  sentence was false in a way that hid a dead branch: `AudioStartSchema` has no
 *  `device_label` field at all (protocol-schemas-audio.ts — sample_rate / channels /
 *  encoding / mode / send_policy / delivery / source_lang / target_lang), zod strips
 *  unknown keys, and the server forwards `parsed.data`. `onAudioStart`'s read of it
 *  was therefore unreachable BY CONSTRUCTION, and the mobile had no producer for it
 *  either. The read is deleted; this is the assertion that replaces it.
 *
 *  `speaking` still guards, for the reason that was always the real one: a directory
 *  refresh mid-utterance must not re-label the capsule under the user's eyes. That is
 *  a stability rule about THIS derivation, not a hand-off to another writer. */
export function deriveSessionTitle(online: readonly string[], speaking: boolean, current: string): string {
  if (speaking) return current;
  return online.length === 1 ? online[0]! : (S.cap_session_default as string);
}

const morph = new CapsuleMorph();
const vis = new CapsuleVisibility();
const watchdog = new SpeakingWatchdog();

/** Honest STT engine health for the capsule diagnostic (R6-R2). `known` stays
 *  false until a real stt:engine-status arrives — the row then shows "undetected" (未探测)
 *  rather than a fabricated green "ready · FunASR" (就绪 · FunASR). */
type EngineStatus = 'ready' | 'reconnecting' | 'failed';

export const state = reactive({
  form: 'idle' as Morph,
  visible: false,
  /** An utterance is in flight (owner 2026-07-27) — the × is disabled, because a
   *  capsule that vanishes mid-transcription takes away the only view of what is
   *  being typed. Mirrors CapsuleVisibility.isSpeaking(). */
  speaking: false,
  /** Desktop socket-to-sidecar transport (the "Socket transport" (Socket 传输) diag row). */
  connected: false,
  /** `Credentials::is_registered()` — survives socket drop (T-5b). */
  registered: false,
  mobiles: 0,
  /** Real phone presence, mobiles>0 (R6-C1 — drives surfacing + the "phone present" (手机在场) row).
   *  Distinct from `connected`: the socket is up from boot before any phone pairs. */
  phonePresent: false,
  // `as string` is load-bearing: strings.ts is `as const`, so the catalog value is
  // the literal type '手机' (phone) and would narrow this field — but `deriveSessionTitle`
  // overwrites it with an arbitrary pairing name from pc:list-mobiles. Do not "clean
  // up". (卡 D-a: the reason used to be cited as audio:start's device_label, a field
  // that does not exist on AudioStartSchema — the annotation is still needed, its
  // justification was not.)
  session: S.cap_session_default as string,
  /** RV-01 / RV-新B — the channel currently carrying the runtime, learned from the
   *  CONNECTION frames/seed (which is where `primary` / admission lives). THE one
   *  answer to "which channel is current" on this window, used for three things:
   *  (1) the "current channel" diag label; (2) which endpoint that diag row shows;
   *  (3) the "delivered-in record" (转入记录) strip filter — the main window now accepts both channels
   *  (owner: timeline = all messages for this PC), so without a capsule-side filter the strip
   *  would interleave two servers.
   *
   *  It used to be `state.cloud.channel`, the device-page PREFERENCE — a flag with no
   *  writer since owner 2026-07-30 ②, hence a constant 'lan' (RV-新B). */
  channel: 'lan' as ChannelTag,
  /** Full cloud status for deriveConnDot (T-5b four-state connection dot). */
  cloud: { ...EMPTY_CLOUD_STATUS } as CloudStatus,
  /** Sidecar lifecycle phase for LAN loud-fault red (null = not yet probed). */
  sidecarPhase: null as string | null,
  /** The LAN sidecar's address when it has resolved one ('' = not yet). The diag row
   *  picks between this and `cloud.endpoint` by `channel` AT RENDER TIME — it used to
   *  be one latched `endpoint` field written by whichever of the two pushes arrived
   *  last, which now that `channel` really does move at runtime would show the other
   *  channel's address until one of those pushes happened to fire again. */
  sidecarEndpoint: '' as string,
  /** The window the NEXT utterance would land in (GA-25). Live from
   *  `flowmic://focus-changed` while unlocked, frozen while `locked`, and
   *  overwritten by `inject:result` (delivered truth outranks observation).
   *  `''` → the view renders "—"; we never fabricate a destination. */
  target: '',
  locked: false,
  interim: '',
  finalText: '',
  level: 0,
  segs: 0,
  /** 🔴 `confirmed` = 甲-3's ③evidence, reduced to the one bit this face needs
   *  (owner 2026-08-07). `true` ⇒ the green card says "injected" (已注入); anything else ⇒ "delivered" (已送入).
   *  A BOOLEAN, not the raw three-value reading, because this face asks exactly one
   *  question ("which word") — the three-way fact lives on the row (TimelineRow
   *  .focus_evidence) where the tooltip/parenthetical can tell "asked but couldn't answer" (问了答不出来)
   *  from "never asked" (没问). ⚠️ It must default to `false`: "we never asked" (我们没问过) may not license "confirmed" (已确认). */
  injected: null as { target: string; chars: number; seconds: number; confirmed: boolean } | null,
  /** The truthful non-injected outcome (R6-R1 / RV-43 §4).
   *  cached = ok:false+mode:cached → 📥 "not injected · cached" (amber); otherwise
   *  ✗ not injected (red; the word was "unsuccessful" until owner deleted "failed"-class wording on
   *  2026-08-07 — `cap_inject_failed` now references `st_failed`).
   *  The retired readback-uncertain face is gone (0.2.22).
   *  ⚠️ 卡 L7 — this line originally read "📥 not delivered …… and it matches the phone",
   *  **both halves were the defect itself**: this PC had already received that frame
   *  (otherwise this face would not appear), so saying "not delivered" used a
   *  segment-① word on segment ②; and "matches the phone" was exactly the reason
   *  it got copied over here in the first place. See
   *  lib/strings/capsule.ts's file header and docs/rebuild/15 §2.0. */
  injectFailed: null as {
    target: string;
    cached: boolean;
    reason: string;
    /** 🔴 book 15 §2.5e-4 — WHICH of `cached`'s three causes, in words; `null` when the
     *  cause adds nothing the badge does not say. A SEPARATE field from `reason`, not
     *  "reason, but also shown when cached": they answer different questions ("why did this
     *  attempt fail" vs "why didn't this one get injected") and their code sets differ on purpose —
     *  `INJECT_FOCUS_LOST` is a reason and is NOT a named cached cause. One value, one question. */
    cachedCause: string | null;
  } | null,
  diagOpen: false,
  /** V2-15: structured "delivered-in record" (转入记录) rows (was string[]). Written ONLY by the
   *  history wire handlers below — never by inject:result, whose `mode` is the
   *  DELIVERY mode (sendinput|clipboard|cached), not the content state. */
  recent: [] as RecentLine[],
  /** pairing_id → phone name (手机名) (V2-15 row sender / V2-16 pre-utterance title). A
   *  FAILED refresh keeps the previous map: "we could not ask" is not "the
   *  phone has no name" (paired-mobiles.ts honesty rule). */
  mobileNames: {} as Record<string, string>,
  engineProvider: '',
  engineStatus: '' as '' | EngineStatus,
  engineKnown: false,
  /** Last non-null loud reason observed (diag "most recent fault" (最近一次故障); omit until first).
   *  Latched on purpose — the row outlives recovery so the card can explain what
   *  happened, which is why the label says "most recent" (最近一次) and not "fault reason" (故障原因). */
  lastLoudReason: null as string | null,
});

let speakStart = 0;

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
      chars: [...(state.finalText || state.interim)].length,
      seconds: Math.max(0, (now - speakStart) / 1000),
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
// Exported (like the state.target writers above) so the GA-28 primary-gate — a
// non-primary presence frame must NOT surface the HUD — is unit-testable against
// the real reactive state. initCapsule is still the only place that wires it.
/** Test hooks for the current channel. It lives on `state` (see `state.channel`) rather
 *  than in a module `let`, so there is exactly ONE copy of "which channel is current" in this
 *  window; specs re-arm it here (same reason resetDirectoryEdgeForTest exists). */
export function primaryChannelForTest(): ChannelTag {
  return state.channel;
}
export function resetPrimaryChannelForTest(ch: ChannelTag = 'lan'): void {
  state.channel = ch;
}

export function onConnection(p: unknown): void {
  const c = p as ConnectionState;
  // GA-28 (owner UAT 2026-07-26): BOTH resident channels push a CONNECTION frame,
  // and connection frames only fire on CHANGE. The capsule must key off the
  // PRIMARY channel alone — exactly like the main-window store (store.ts) and the
  // "phones online" (在线手机) diag row. A lingering phone on the NON-primary (presence) channel was
  // surfacing the HUD for a PC whose active instance had no phone: the capsule
  // floated on the cloud relay (云端中继) (primary, phones online (在线手机) = 0) because a stale LAN presence frame
  // carried mobiles>0 and was the last frame it received. `primary` absent = a
  // pre-GA-28 single-socket shell, which is by definition the primary one.
  if (c.primary === false) return;
  // Past the gate ⇒ this frame IS the primary channel's. An absent tag = a
  // pre-GA-28 single-socket shell, which was LAN.
  const next = asChannelTag(c.channel) ?? 'lan';
  // Primary flipped → the strip's rows belong to a different server. Clear and
  // re-seed; keeping the old list would show the wrong channel's "delivered-in record" (转入记录).
  if (next !== state.channel) {
    state.channel = next;
    // Cleared, but NOT re-seeded — the seed pull is gone with the server's transcript
    // store and nothing replaces it (there is no elsewhere to read rows from). The
    // strip refills from whatever arrives next, which since the row-transit round is
    // a real stream again: each delivery on the new primary mints a row.
    state.recent = [];
  }
  // `connected` = desktop socket transport; `phonePresent` = a real phone in the
  // room (mobiles>0). R6-C1: surfacing keys off phone presence, NOT the socket.
  state.connected = c.connected;
  state.registered = c.registered === true;
  state.mobiles = typeof c.mobiles === 'number' ? c.mobiles : 0;
  state.phonePresent = state.mobiles > 0;
  // V2-16: join/leave edges are exactly the mobiles-count changes — refresh the
  // name directory (and with it the pre-utterance session title) then. The boot
  // frame always fires (lastDirectoryMobiles starts at -1), warming the map for
  // the history rows that arrive before any phone change.
  if (state.mobiles !== lastDirectoryMobiles) {
    lastDirectoryMobiles = state.mobiles;
    void refreshMobileDirectory();
  }
  vis.onConnection(state.phonePresent, c.room_uuid ?? null);
}

// ── RV-07 CONNECTION seed (pull) ──
// Injectable read, same transport-seam culture as fetchDirectory below: production
// uses the REAL bridge command, tests swap it.
let fetchConnSnapshot: () => Promise<ConnectionState[]> = fetchConnectionSnapshot;
export function setConnectionSnapshotFetcher(fn: () => Promise<ConnectionState[]>): void {
  fetchConnSnapshot = fn;
}

/** Seed the CONNECTION state from a PULL — the half the v0.2.4 fix never gave the
 *  capsule.
 *
 *  `flowmic://connection` fires only on CHANGE, and Rust has both sockets up ~1.1 s
 *  before a WebView finishes booting (measured, see main-window/connection-seed
 *  .test.ts). The main window got a snapshot seed then; `initCapsule` got three
 *  seeds (cloud / sidecar / history) and no connection seed. So in the common cloud-leg
 *  (云端腿) case — desktop restarted while the phone is already in the room — nothing ever
 *  told the capsule a phone was there: `phonePresent` stayed false for the whole
 *  session, ambient surfacing (浮现) never fired, the tray's "show capsule" (显示胶囊) read that same false state
 *  (lib/capsule-visibility.ts) and the diagnostic's three rows were all wrong.
 *
 *  Every row is handed to the SAME `onConnection` the push uses — including its
 *  GA-28 primary gate — because one payload with two readers is how this repo grows
 *  "one value answers two questions" defects. */
export async function seedConnection(): Promise<void> {
  try {
    const rows = await fetchConnSnapshot();
    for (const row of rows) onConnection(row);
    appendForensic(
      'capsule',
      `connection seed: ${
        rows.length === 0
          ? '(no resident channel)'
          : rows.map((r) => `${r.channel ?? '(untagged)'}=${r.connected}/${r.mobiles}`).join(' ')
      }`,
    );
  } catch (e) {
    // Stated, never swallowed: a silent failure here degrades back to exactly the
    // push-only behaviour this replaces (red line: no silent failure).
    appendForensic('capsule', `connection seed FAILED: ${String(e)}`);
  }
}

// ── V2-15/V2-16 phone-name directory (手机名目录) (pc:list-mobiles) ──
// Injectable directory read, the stores' transport-seam culture: production
// uses the REAL bridge command; tests swap it to drive the V2-16 title and the
// V2-15 sender map without the Tauri IPC layer.
let fetchDirectory: () => Promise<PairedMobile[] | null> = fetchPairedMobiles;
export function setDirectoryFetcher(fn: () => Promise<PairedMobile[] | null>): void {
  fetchDirectory = fn;
}
let lastDirectoryMobiles = -1;
let directoryInFlight = false;

/** Test hook: the mobiles-change edge is module state, so specs re-arm it here
 *  (same reason onConnection/onFocusChanged are exported — the wiring itself is
 *  unit-testable against the real reactive state, never re-implemented). */
export function resetDirectoryEdgeForTest(): void {
  lastDirectoryMobiles = -1;
}

/** Refresh pairing_id→name AND the pre-utterance session title from one read.
 *  A FAILED read (null) keeps both untouched — a slightly stale name is honest;
 *  a blanked map would manufacture「unknown device」rows. */
export async function refreshMobileDirectory(): Promise<void> {
  if (directoryInFlight) return;
  directoryInFlight = true;
  try {
    const rows = await fetchDirectory();
    if (rows === null) return;
    const map: Record<string, string> = {};
    const online: string[] = [];
    for (const r of rows) {
      map[r.pairing_id] = r.mobile_name;
      if (r.online) online.push(r.mobile_name);
    }
    state.mobileNames = map;
    state.session = deriveSessionTitle(online, state.speaking, state.session);
  } finally {
    directoryInFlight = false;
  }
}

// V2-15 — the structured "delivered-in record" (转入记录) strip is driven by the history wire: the ONLY
// capsule-reachable channel carrying content-status (内容状态) (mode), processed-body-text
// (处理后正文) (output_text), original-text (原文) (source_text), timestamp (时间戳) (created_at)
// and sending-device (发送设备) (mobile_id) in one truthful
// payload. stt:final carries NONE of them; inject:result's `mode` is the
// DELIVERY mode — labeling rows from either would be fabricating data (编数据).
//
// W2: the envelope carries the bridge channel stamp (socket::bridge::tag_channel).
// Main-window now accepts BOTH channels; the capsule still shows ONE server's
// recent strip — filter here. No stamp → drop (0.2.18: unstamped rows cannot be
// addressed; guessing `lan` is how that bug was born). Wrong channel → drop.
/** True when the envelope stamp matches the admission-derived current channel. */
export function acceptRecentChannel(stamp: unknown): boolean {
  const ch = asChannelTag(stamp);
  return ch !== null && ch === state.channel;
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
  const line = toRecentLine(item);
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
