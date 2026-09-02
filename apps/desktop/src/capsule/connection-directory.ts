// Capsule CONNECTION admission + phone-name directory — moved VERBATIM out of
// controller.ts on 2026-09-02 (WP-7d), same rule and same precedent as
// recent-line.ts / session-title.ts (800-line cap, verify/lint/file-size.mjs
// SRC_MAX=800; the cap was hit again once E2 added the utteranceHadAudio guard).
//
// 🔴 UNLIKE the two prior splits, this family DOES touch the reactive `state`
// (and the visibility FSM `vis`) — it is the GA-28 primary-channel gate and the
// V2-15/V2-16 phone-name directory, not a pure narrower. `state`/`vis` come from
// capsule-state.ts, a LEAF module with no import from either controller.ts or
// this file — NOT from controller.ts directly. The first cut of this split did
// import them from controller.ts, which imports this module's functions in
// return, and `verify:lint circular` failed it: a real import cycle, not a
// hypothetical one. Routing both through the shared leaf module keeps the
// dependency graph one-directional (capsule-state.ts <- this file,
// capsule-state.ts <- controller.ts, this file <- controller.ts).
//
// controller.ts re-exports every name here, so every existing import site
// (CapsuleApp.vue, DevicesPage, controller.test.ts, initCapsule) is untouched.

import { appendForensic, fetchConnectionSnapshot, fetchPairedMobiles } from '../lib/bridge';
import type { PairedMobile } from '../lib/paired-mobiles';
import { asChannelTag } from '../lib/timeline-store';
import type { ChannelTag, ConnectionState } from '../lib/types';
import { deriveSessionTitle } from './session-title';
import { state, vis } from './capsule-state';

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
  // 🔴 CORRECTED 2026-08-26. The line that used to be here read 「V2-16:
  // join/leave edges are EXACTLY the mobiles-count changes」 — FALSE, and two
  // things were built on it. The full account (what was measured, why the count
  // cannot answer it) lives once, in `socket/reconcile.rs::epoch` and in
  // `capsule-visibility.onConnection`; repeating it here would be a third copy
  // that can rot on its own.
  //
  // In one line: the presence set is keyed by mobile_id, so a phone re-entering
  // the transcription page moves nothing the pump forwards. `presence_epoch` is
  // the missing fact — watch it for CHANGE, never read meaning into its value.
  const epoch = typeof c.presence_epoch === 'number' ? c.presence_epoch : null;
  const presenceEvent = epoch !== null && epoch !== lastPresenceEpoch;
  if (epoch !== null) lastPresenceEpoch = epoch;
  // The directory refresh now hangs off the EVENT as well as the count, so a
  // returning phone re-reads its own name too.
  if (state.mobiles !== lastDirectoryMobiles || presenceEvent) {
    lastDirectoryMobiles = state.mobiles;
    void refreshMobileDirectory();
  }
  // The event rides INTO the FSM, not around it: `onConnection` still owns every
  // rule about whether the capsule may show.
  if (presenceEvent) {
    appendForensic('capsule', `presence event (epoch=${epoch}) phonePresent=${state.phonePresent}`);
  }
  vis.onConnection(state.phonePresent, c.room_uuid ?? null, presenceEvent);
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
/** Card PRESENCE-EPOCH: the last presence-event counter seen. Starts below any
 *  real value so the boot frame counts as an event exactly once. */
let lastPresenceEpoch = -1;
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
