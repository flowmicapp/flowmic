// SPEC-REF:
//   apps/desktop/src-tauri/src/socket/bridge.rs (`socket::bridge::channel` — the
//     producer of every `flowmic://…` name below; this file is its mirror)
//
// THE NAMES ONLY. Split out of bridge.ts VERBATIM when card MP-3 pushed that
// file over the 800-line cap (the repo's rule for the cap is a structural split,
// never deleting the reasoning: 0.2.52's precedent).
//
// 🔴 IT IS A GOOD SPLIT RATHER THAN AN EXPEDIENT ONE, and the reason is what
// bridge.ts's own header pins: bridge.ts's invariant is 「the only module that
// imports `invoke`」. A table of event NAMES dispatches no command, so it never
// belonged inside that funnel — and keeping it here means a window that only
// needs to know what a channel is called does not have to import the module that
// can talk to Rust.
//
// ⚠️ Every name is re-exported from bridge.ts, so no call site changed and none
// needs to: `import { CH } from './bridge'` still resolves.

/** Bridge channel names — must equal apps/desktop/src-tauri/src/socket/bridge.rs. */
export const CH = {
  sttInterim: 'flowmic://stt-interim',
  sttFinal: 'flowmic://stt-final',
  sttLevel: 'flowmic://stt-level',
  /** Real STT engine health (R6-R2): provider + ready|reconnecting|failed. The
   *  desktop forwards the server's stt:engine-status so the capsule diagnostic
   *  shows a truthful engine state instead of a hard-coded green "ready" (就绪). */
  sttEngineStatus: 'flowmic://stt-engine-status',
  audioStart: 'flowmic://audio-start',
  audioStop: 'flowmic://audio-stop',
  /** 卡 F1 — the phone left / re-entered the FOREGROUND (owner ruling ①:
   *  "the computer should consider the phone 'paused' (still paired, just with the capsule collapsed)"). The capsule collapses
   *  on pause and comes back on resume; the pairing, the room and "paired phones" (已配对手机) are
   *  deliberately untouched — a paused phone has NOT left, and reusing the
   *  phone-left path would make the device page say "no phone currently connected" because the user
   *  switched windows. Producer = socket/fanout.rs (`on_forward` maps
   *  `crate::events::AUDIO_PAUSE`/`AUDIO_RESUME` onto `bridge::channel::*`; it
   *  🔴 used to say client.rs here — grep found zero, measured 2026-08-06 while
   *  ruling IT-49); consumer = capsule/controller.ts `onAudioPause`/`onAudioResume`. */
  audioPause: 'flowmic://audio-pause',
  audioResume: 'flowmic://audio-resume',
  injectResult: 'flowmic://inject-result',
  /** Tray user-gesture summon (R6-C2): the Rust tray path emits this so the Vue
   *  visibility FSM re-syncs to persistent (previously the tray only moved the
   *  native window, leaving the frontend FSM out of step). */
  traySummon: 'flowmic://tray-summon',
  /** A row for the timeline. ⚠️ ITS PRODUCER IS LOCAL, NOT THE SERVER (owner architecture ruling
   *  transit-not-storage, 卡 P + 卡 D): `socket::row_transit::mint_row` builds a row
   *  from each `inject:request` this machine handles — carrying the delivery's real (真)
   *  verdict — and forwards it here. The server stores no transcripts and broadcasts
   *  nothing; the name and envelope are shared with its retired broadcast so the
   *  frontend keeps ONE "inbound row → timeline row / capsule row" (入站行 → 时间线行 / 胶囊行) implementation. */
  historyUpdated: 'flowmic://history-updated',
  /** ⚠️ NO PRODUCER — a delete has no delivery frame to ride, and owner ⑦ is explicit
   *  that a PC-side delete does not travel and a phone cannot delete a PC row. Kept
   *  wired only so the LOCAL cross-window notice (uiTimelineRowGone) shares its
   *  handler; `history-list-result` was removed outright with its pull. */
  historyDeleted: 'flowmic://history-deleted',
  settingsUpdated: 'flowmic://settings-updated',
  connection: 'flowmic://connection',
  sidecarState: 'flowmic://sidecar-state',
  /** Foreground focus changed (GA-25): `{window_title, process_name}` pushed by
   *  the Rust pump on the SAME change-only sample that mirrors `focus:state` to
   *  the phone. The capsule takes its live "inject target" (注入目标) from it — before GA-25 the
   *  only writer of `state.target` was `inject:result`, so the capsule showed
   *  where the LAST utterance landed, not where the next one would go.
   *  Unlike the wire mirror this channel is NOT mobile-gated (Tauri IPC never
   *  leaves the machine — see bridge.rs FOCUS_CHANGED). */
  focusChanged: 'flowmic://focus-changed',
  /** Cloud-relay channel state (R6 T-2): active channel + Cloud Key presence +
   *  the fail-loud readiness verdict. Both windows listen — the device page
   *  renders the cloud relay (云端中继) card, the capsule takes its channel label from it. */
  cloudState: 'flowmic://cloud-state',
  /** Card MP-3 — the relay's `billing:budget` frame, forwarded verbatim by
   *  socket/client.rs (producer: `bridge::channel::BILLING_BUDGET`).
   *
   *  🔴 THE MAIN WINDOW READS EXACTLY ONE FIELD OFF IT: `payer`. The account
   *  card's numbers are an HTTP read and stay one; what only this frame can say
   *  is 「the account being spent right now is the OTHER end's」 — which since
   *  card MP-0 is the ordinary case for a phone signed into its own account, and
   *  is why this computer's meter correctly does not move while words appear on
   *  screen. Consumer: lib/use-cloud-account.ts via lib/billing-payer.ts. */
  billingBudget: 'flowmic://billing-budget',
  /** P7 (0.3.1) — the manual offline switch flipped (`shell::offline::apply`,
   *  its only emitter). The store marks both channel rows disconnected off it:
   *  going offline JOINS the pump threads, so no CONNECTION frame will ever
   *  arrive to say the sockets are gone — this event is that sentence. */
  offlineState: 'flowmic://offline-state',
} as const;

/** Frontend-only Tauri event, capsule window → main window (R6 T-5c): switch the
 *  main window to a page. Deliberately NOT in `CH` — `CH` mirrors bridge.rs, and
 *  this one has no Rust producer or consumer (both ends are Vue), so adding a Rust
 *  constant for it would be a dead façade. Same `flowmic://` shape so the
 *  protocol-whitelist lint never mistakes it for a socket wire event. */
export const UI_NAVIGATE = 'flowmic://ui-navigate';

/** Frontend-only Tauri event (V2-07.8a): one window changed a LOCAL appearance
 *  pref (UI locale / theme mode). The prefs themselves live in the localStorage
 *  both windows SHARE (same origin, same user-data folder — the capsule-position
 *  clearPos path already relies on that), so the payload is empty on purpose:
 *  the event is just「go re-read」(hydrateLocale + hydrateTheme). Deliberately
 *  NOT in `CH`, same as UI_NAVIGATE — both ends are Vue, no Rust producer or
 *  consumer. */
export const UI_PREFS_SYNC = 'flowmic://ui-prefs-sync';
