// WP-R2-2 Tauri IPC adapter — the ONLY frontend module that imports @tauri-apps
// and the concrete implementation of the injectable transports the stores use
// (so the stores stay Tauri-free + unit-testable). The bridge channel names are
// the exact `flowmic://…` strings the Rust `socket::bridge::channel` module emits;
// the command names + args match the shell commands (single-word args to avoid
// any camelCase↔snake_case ambiguity across the boundary).
//
// Everything degrades gracefully outside Tauri (a plain `vite dev` browser): the
// invoke/listen calls no-op so the UI can be inspected without the desktop shell.

import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { InjectResult, ServerSettingItem, SettingsTransport, TimelineTransport, ConnectionState} from './types';
import type { PairingInfo } from './pairing';
import {
  asPairedMobiles,
  asPairedMobilesView,
  type PairedMobile,
  type PairedMobilesView,
} from './paired-mobiles';
import { asCloudStatus, cloudEndpointSsot, type ChannelId, type CloudStatus } from './channel';
import { asCloudAccountRaw, type CloudAccountRaw } from './cloud-account';

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

/** Broadcast that a local appearance pref changed so the OTHER window
 *  rehydrates. No-op outside Tauri; an emit failure only delays the other
 *  window until its next launch (the shared store is already correct). */
export function notifyPrefsChanged(): void {
  if (!hasTauri()) return;
  void emit(UI_PREFS_SYNC, {}).catch((e) => console.warn('[flowmic] prefs-sync emit failed', e));
}

/** U6 — mirror the persisted UI locale into the Rust shell (`ui_locale_set`,
 *  src-tauri/src/shell/locale_sync.rs), which renders the tray menu, the tray
 *  status/tooltip, the exit-confirmation dialog and the autostart error strings.
 *  localStorage is unreachable from Rust, so without this mirror those surfaces
 *  are stuck on the product default forever. Called from main-window/main.ts on
 *  boot-hydrate (migrates a pre-existing choice) and from its UI_PREFS_SYNC
 *  handler (a change made in the settings page reaches the tray immediately).
 *  Fire-and-forget via invokeSafe: outside Tauri there is no Rust surface to
 *  localize, and the Rust side re-reads its own persisted copy next launch. */
export function reportUiLocale(locale: string): void {
  void invokeSafe('ui_locale_set', { locale });
}

/** Frontend-only Tauri event (0.2.27): the user DELETED a timeline row in the main
 *  window, so any other window still showing it must drop it.
 *
 *  WHY IT HAD TO EXIST. The capsule's "delivered-in record" (转入记录) strip keeps its own copies of the newest
 *  rows, and it used to learn about a removal from the server's `history:deleted`
 *  broadcast. That broadcast is gone (the server stores no transcripts) — but note what
 *  it never covered: the server excludes the EMITTER from a room broadcast, and both
 *  windows share one socket, so a delete made HERE never came back here. The strip has
 *  therefore always kept locally-deleted rows on screen; what changes in 0.2.27 is that
 *  a local delete is now the ONLY kind, so a latent gap became every case. Deleting the
 *  peer handler without this would have been fixing one fault by creating another (修一个故障造出另一个) — a HUD claiming a
 *  record the user just destroyed.
 *
 *  Deliberately NOT in `CH` (both ends are Vue, no Rust producer or consumer), same as
 *  UI_NAVIGATE / UI_PREFS_SYNC, and the same `flowmic://` shape so the protocol
 *  whitelist lint never mistakes it for a wire event. The payload IS the row address
 *  `(channel, id)` — an id alone names two rows once both servers are in one list. */
export const UI_TIMELINE_ROW_GONE = 'flowmic://ui-timeline-row-gone';

/** Tell the other window a row is gone. Best-effort: a failed emit leaves a stale line
 *  on the capsule strip until its next seed, which is why it is logged rather than
 *  swallowed. */
export function notifyRowRemoved(id: string, channel: ChannelId): void {
  if (!hasTauri()) return;
  void emit(UI_TIMELINE_ROW_GONE, { id, channel }).catch((e) =>
    console.warn('[flowmic] timeline-row-gone emit failed', e),
  );
}

/** The pages the main window sidebar can show (mirrors main-window/App.vue). */
// 'diag' (owner 2026-07-26 ①): the connection-diagnostic page. Reachable from
// the sidebar footer status, deliberately NOT from the nav list — it is a
// place you are TAKEN when you ask "how's the connection right now", not a place you live.
export type MainPage = 'devices' | 'timeline' | 'settings' | 'diag';

function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** ⚠️ EXPORTED ONLY FOR `bridge-portable.ts` (the 800-line-cap split). It is not a
 *  general-purpose escape hatch: every rejection it sees becomes one `undefined`,
 *  which is why the portable file's own doors answer with verdict objects instead.
 *  A new caller outside this pair should be adding a door HERE, not invoking by
 *  hand — that is what keeps 「the only module that imports @tauri-apps」 true. */
export async function invokeSafe<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!hasTauri()) return undefined;
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    console.warn(`[flowmic] invoke ${cmd} failed`, e);
    return undefined;
  }
}

// ── transports consumed by SettingsClient / TimelineStore ──
export const settingsTransport: SettingsTransport = {
  async settingsUpdate(key, value, updatedAt) { // C3: IPC arg is `stamp` (single-word, per this file's header); the wire field is `updated_at`
    return (await invokeSafe<boolean>('settings_update', { key, value, stamp: updatedAt })) === true;
  },
};

/** Pull the server settings snapshot (settings:list) so the desktop can adopt it
 *  into the local display cache on the connected rising edge (07 §8, WP-R3.5). The
 *  Rust `settings_list` command awaits the ack and returns the `items` array (or
 *  null on a down socket / timeout). Outside Tauri or on failure → [] (keep the
 *  local cache; never a blank overwrite). */
export async function fetchServerSettings(): Promise<ServerSettingItem[]> {
  const items = await invokeSafe<ServerSettingItem[]>('settings_list');
  return Array.isArray(items) ? items : [];
}

// 0.2.27 — ONE verb where there were four. `history_list` / `history_update` /
// `history_delete` / `history_inject` and their Rust commands are gone with the
// server's transcript store (owner architecture ruling); edit and delete are local writes now and
// need no bridge call, and deferred redelivery (补投) keeps a command because typing into a window is a
// native act — it just no longer leaves the machine.
//
// No `channel` argument, and that is the point rather than an omission: RV-01's
// `channel` named the SERVER a row op had to travel to, and this call travels to no
// server. What it needs is the machine's inject state, which the Rust side resolves
// itself (shell::reinject). The row's channel is still needed to ADDRESS the row — the
// store holds it and stamps the returned result with it.
export const timelineTransport: TimelineTransport = {
  async reInjectLocally(text, entryId) {
    // Both args are SINGLE WORDS on the wire (`text`, `id`) — this boundary's standing
    // rule, so no camelCase↔snake_case mapping can be involved. `undefined` from
    // invokeSafe (outside Tauri, or an invoke that threw) and a `null` from Rust (no
    // resident session / deduped) mean the same user-visible thing — nothing was typed
    // — and both become `null`.
    const r = await invokeSafe<InjectResult | null>('timeline_reinject', { text, id: entryId });
    return r ?? null;
  },
  async rowImage(id) {
    // RV-93. `undefined` (outside Tauri / an invoke that threw) and `null` (this row
    // has no picture) collapse to `null` on purpose: the caller's response to both is
    // the same and is not an error — draw the thumbnail. A row whose picture is
    // missing is a smaller picture, not a broken one.
    return (await invokeSafe<string | null>('timeline_image', { id })) ?? null;
  },
  dropRowImages(ids) {
    // Fire-and-forget, and that is the honest shape: the caller is `persist`, which
    // has already removed the rows in memory and on disk. Blocking a synchronous
    // eviction on a filesystem round trip would buy nothing — a picture whose delete
    // failed is a stray file, not a wrong row, and `timeline_images_drop` records
    // what it really removed.
    void invokeSafe<number>('timeline_images_drop', { ids: [...ids] });
  },
};

// ── device page: pairing code + endpoint (WP-R23-1) ──
const EMPTY_PAIRING: PairingInfo = {
  short_code: null,
  endpoint: '',
  pc_name: '',
  connected: false,
  mobiles: 0,
};

/** Narrow a `pairing_code` ack to the PairingInfo contract.
 *
 *  owner 2026-07-27: `?? EMPTY_PAIRING` only covers a WHOLE missing snapshot. An
 *  ack that is an object but lacks `endpoint` (an older shell, a serde rename)
 *  sailed through the cast, and the device page then called `endpoint.trim()` on
 *  undefined — a render throw that blanks the page, the same defect the timeline
 *  had. Field-by-field narrowing is the only thing a runtime cast never gives. */
export function asPairingInfo(v: unknown): PairingInfo {
  if (v === null || typeof v !== 'object') return { ...EMPTY_PAIRING };
  const o = v as Record<string, unknown>;
  // owner 2026-07-30 ② "the LAN card must list all the IPs it's listening on" — and they were all being thrown
  // away right here. `lan_candidates` is `string[]` (Rust `Vec<String>`), but the
  // filter asserted `c is string` while TESTING `typeof c === 'object'`, so every
  // address failed it and the field arrived as `[]` on every machine. A type
  // predicate is an assertion the compiler does not check, which is exactly why the
  // façade rule says to grep the production reader: the GA-21 multi-NIC picker has
  // never once had a candidate to show.
  const candidates = Array.isArray(o.lan_candidates)
    ? o.lan_candidates.filter((c): c is string => typeof c === 'string' && c !== '')
    : undefined;
  return {
    ...EMPTY_PAIRING,
    short_code: typeof o.short_code === 'string' ? o.short_code : null,
    endpoint: typeof o.endpoint === 'string' ? o.endpoint : '',
    pc_name: typeof o.pc_name === 'string' ? o.pc_name : '',
    connected: o.connected === true,
    mobiles: typeof o.mobiles === 'number' && Number.isFinite(o.mobiles) ? o.mobiles : 0,
    ...(candidates !== undefined ? { lan_candidates: candidates } : {}),
    // Three more fields the Rust side has been sending and this narrowing DROPPED,
    // found while wiring the LAN card's address list (same class as the filter
    // above — a field absent from the literal is a field the caller can never see):
    //   · lan_endpoint — the LAN card's OWN address (v0.2.4). Without it the card
    //     falls back to the pairing endpoint, the very conflation 0.2.4 split apart.
    //   · expires_in_ms — GA-18's code TTL. PairingModal computes a deadline from it
    //     and has therefore always shown the static "valid within 5 minutes" (5 分钟内有效) line instead of the
    //     countdown lib/pair-countdown.ts implements and tests.
    //   · machine_uid — v0.2.4's cross-channel machine identity; ConnDiagPage has
    //     always printed "unreadable" (读不到) for it.
    ...(typeof o.lan_endpoint === 'string' ? { lan_endpoint: o.lan_endpoint } : {}),
    ...(typeof o.expires_in_ms === 'number' && Number.isFinite(o.expires_in_ms)
      ? { expires_in_ms: o.expires_in_ms }
      : {}),
    ...(typeof o.machine_uid === 'string' && o.machine_uid !== '' ? { machine_uid: o.machine_uid } : {}),
    // N5 — WHICH channel this snapshot describes. Narrowed to the two known tags
    // and otherwise left ABSENT rather than defaulted: a snapshot from a shell that
    // does not report it must not claim to be 'lan', or the modal's cross-channel
    // gate would compare against a value nobody sent.
    ...(o.channel === 'lan' || o.channel === 'cloud' ? { channel: o.channel } : {}),
    // D2LAN-B2b — the LAN TLS fingerprint the QR carries as `fp=`.
    //
    // 🔴 THIS LINE IS THE WHOLE REASON THE FIELD ARRIVES. Everything upstream of
    // it can be perfect — the server publishing `lan_tls_fp`, the Rust snapshot
    // serializing it — and a field missing from this literal is a field the caller
    // can never see (the exact defect the three fields above were added for, and
    // the `lan_candidates` filter before them). A wired chain with a hole here
    // fails EXACTLY like an unwired one: no `fp=`, no error, all tests green.
    //
    // Absent / empty / not-a-string ⇒ left ABSENT rather than defaulted, so the
    // payload builder's 「no fingerprint」 branch is reached and the QR keeps its
    // pre-D2-LAN bytes.
    ...(typeof o.lan_tls_fp === 'string' && o.lan_tls_fp !== '' ? { lan_tls_fp: o.lan_tls_fp } : {}),
    // 0.2.66 — the relay's PCID. SIXTH field to be added to this literal, and the
    // block above says why that keeps happening: everything upstream can be perfect
    // and a field missing from HERE is a field the caller can never see. The proof
    // that this line is load-bearing is `pairing-pcid.test.ts`, which feeds a
    // Rust-SHAPED object in (serde key names, not a hand-built PairingInfo) and
    // asserts the id comes out non-empty — "it compiled" proves nothing.
    //
    // Only "whether it's a non-empty string" is decided here. The nine-digit SHAPE is the wire
    // parser's call (`socket/wire.rs`, symbol `parse_pcid`), and re-deciding it in a
    // second place would be two answers to one question — the drift that outlives
    // whichever of the two someone remembers to change.
    ...(typeof o.pcid === 'string' && o.pcid !== '' ? { pcid: o.pcid } : {}),
  };
}

/** Read the current pairing snapshot (code + endpoint + presence) for the device
 *  page. Outside Tauri it degrades to an empty (disconnected) snapshot.
 *
 *  N5 — `channel` names the channel the phone is being told to dial (the pairing
 *  modal's own local LAN / cloud relay (本地局域网／云端中继) switch). The code, the endpoint and the presence
 *  in the answer all describe THAT channel, and the answer carries the tag back so
 *  the caller can tell whether it is looking at what it asked for. Omitted ⇒ the
 *  Rust side falls back to the stored channel preference (pre-N5 behaviour). */
export async function fetchPairingInfo(channel?: ChannelId): Promise<PairingInfo> {
  return asPairingInfo(await invokeSafe<unknown>('pairing_code', { channel }));
}

/** Mint a fresh 4-digit code via pc:refresh-code. Returns null on failure (socket
 *  down / ack timeout) so the modal shows a loud "refresh failed" (刷新失败) — never a fake code.
 *
 *  N5 — minted ON `channel` with no fallback to the other one (Rust
 *  `with_channel_socket`): a code the phone's server never issued is not a fallback,
 *  it is a wrong answer the phone will act on. Omitted ⇒ the stored preference. */
export async function refreshPairingCode(channel?: ChannelId): Promise<string | null> {
  return (await invokeSafe<string | null>('refresh_pairing_code', { channel })) ?? null;
}

/** The phones PAIRED to this PC via pc:list-mobiles (R6 T-8). `null` means the
 *  read FAILED (socket down / ack timeout / refused) — the page renders that
 *  loudly; it must never be flattened into an empty list, which would read as
 *  「no phones paired」. Rows carry ONLY the public projection (no token). */
export async function fetchPairedMobiles(): Promise<PairedMobile[] | null> {
  return (await fetchPairedMobilesView())?.rows ?? null;
}

/** v0.2.1 — the full two-channel read: rows tagged with their channel, plus the
 *  channels that are resident but did not answer. `fetchPairedMobiles` above
 *  keeps the flat shape for the capsule's name directory, which only needs
 *  "what's this pairing_id called" and does not care which server it came from. */
export async function fetchPairedMobilesView(): Promise<PairedMobilesView | null> {
  return asPairedMobilesView(await invokeSafe<unknown>('list_paired_mobiles'));
}

/** GA-08 — end ONE paired phone's access (pc:release-mobile).
 *  `revoke=false` disconnect (断开): this session ends and the server holds a 60 s
 *  reconnect-suppression window; the pairing stays valid and the phone returns
 *  by itself afterwards. `revoke=true` unpair (撤销): the pairing row is DELETED, so the
 *  phone must be paired again — the caller MUST have taken a second
 *  confirmation first.
 *  Returns the server's `ok`; `false` (socket down / timeout / refusal) so the
 *  page can say the action did not happen instead of re-rendering as if it had. */
export async function releaseMobile(
  id: string,
  revoke: boolean,
  channel?: ChannelId,
): Promise<boolean> {
  // v0.2.7 — `channel` names the server that OWNS this row. The two channels
  // are two servers with two `mobile_pairings` tables (which is why the table
  // has tagged every row since v0.2.1), and this call used to go to whichever
  // channel happened to be primary — so revoking a local-LAN (本地局域网) row while cloud
  // was primary asked the relay to delete a pairing it had never heard of, and
  // the relay answered "ok, revoked 0" (owner 2026-07-29: "showed success, but
  // it's still there" (提示成功，但仍然还在)). Omitted = the pre-v0.2.7 primary-channel behaviour.
  return (await invokeSafe<boolean>('release_mobile', { id, revoke, channel })) === true;
}

/** GA-10 — rename THIS PC (04 §3.7 reserved key `device.pc_name`).
 *  `false` = the server did not ack ok, so the page must say the rename did not
 *  happen rather than show the new label over an unchanged row. There is no
 *  mobile counterpart by design: owner iron rule "naming on the PC side can only be controlled by the PC side" —
 *  the phone renames only its own local alias, which never leaves the device. */
export async function renamePc(name: string): Promise<boolean> {
  return (await invokeSafe<boolean>('pc_rename', { name })) === true;
}

// ── 🔴 self-focus report (owner 2026-08-02 F1a: one's own input box must be able to receive injection (自家输入框必须能注入)) ──
//
// The ONE production sink for lib/self-focus.ts. It lives here because this file is
// the only frontend module that may import @tauri-apps (see the header) — the policy
// itself is Tauri-free and node-testable next door.
//
// FIRE AND FORGET, deliberately: the caller is a focus-event handler on the UI
// thread, and a report that arrives late is worth nothing anyway (the Rust side
// re-checks the live OS foreground on every read and expires a stale report on its
// own). `invokeSafe` already swallows a down bridge, which is the honest degradation
// — outside Tauri there is no injection to gate.
//
// ⚠️ NO HWND ARGUMENT. The window handle is resolved in Rust from the invoking
// `WebviewWindow`; a page that could NAME a handle could name one it does not own,
// and "our own process" is this feature's entire premise.
export function reportSelfFocus(editable: boolean): void {
  void invokeSafe<null>('self_focus_report', { editable });
}

// ── sidecar (self-hosted server) status + retry (07 §5, WP-R2-4) ──
export interface SidecarStatus {
  /** Machine phase tag: resolving|spawning|awaiting_*|probing|clearing|healthy|
   *  adopted_external|failed. */
  phase: string;
  /** The endpoint the desktop dialed once terminal-healthy (loopback / adopted). */
  endpoint: string | null;
  /** Human failure detail (only present when phase === 'failed'). */
  detail: string | null;
}

/** Read the current sidecar lifecycle status for the device page. Outside Tauri it
 *  degrades to null (the page then hides the sidecar card). */
export async function fetchSidecarState(): Promise<SidecarStatus | null> {
  return (await invokeSafe<SidecarStatus>('sidecar_state')) ?? null;
}

/** Retry the sidecar bring-up (the error-card Retry button, 07 §5). Re-runs
 *  resolve→spawn→handshake→health and, on success, reconnects the socket. Returns
 *  the new status (or null on a down bridge). */
export async function retrySidecar(): Promise<SidecarStatus | null> {
  return (await invokeSafe<SidecarStatus>('sidecar_retry')) ?? null;
}

// ── cloud relay channel (R6 T-2) ──
// The Cloud Key travels ONE WAY only: the paste box hands it to Rust, which DPAPI-
// wraps it. Nothing here ever reads a key back — `CloudStatus` carries `key_set`
// plus a 6-char head, which is why the device page can show "configured" (已设置) without the
// frontend ever holding the secret.

/** Read the cloud-channel status. Outside Tauri → the LAN default (never null,
 *  so the page renders its honest "not configured" state instead of blanking). */
export async function fetchCloudStatus(): Promise<CloudStatus> {
  return asCloudStatus(await invokeSafe<unknown>('cloud_status', cloudEndpointSsot()));
}

/** Store a pasted Cloud Key + relay endpoint. Rust refuses a value that is not
 *  JWT-shaped and returns the status with a loud `KEY_MALFORMED` verdict — the
 *  form shows that, never a silent "saved". */
export async function saveCloudKey(key: string, endpoint: string): Promise<CloudStatus> {
  return asCloudStatus(await invokeSafe<unknown>('cloud_save_key', { key, endpoint }));
}

/** L3 account card (账号卡) — read the LIVE account from the relay (`/api/me` +
 *  `/api/cloud/summary`, both Bearer-authenticated with the Cloud Key **inside
 *  Rust**; the key still never crosses this boundary).
 *
 *  Deliberately NOT folded into `fetchCloudStatus`: that call answers "does this PC have a
 *  key, and what does that key itself claim" and is instant + offline; this one answers "what
 *  does the server say my tier is right now, and how much have I used" and can fail. Merging them would give one value two
 *  questions and would make a network failure look like a missing key.
 *
 *  The Rust command never throws — it returns an outcome in every case — so the
 *  `undefined` from invokeSafe keeps meaning exactly ONE thing: there is no bridge
 *  (we are not running under Tauri). That is `no_bridge`, which is a different
 *  fact from "the server didn't answer" (服务器没答话) and is why it is not mapped onto `unreachable`. */
export async function fetchCloudAccount(): Promise<CloudAccountRaw> {
  const raw = await invokeSafe<unknown>('cloud_account_fetch');
  if (raw === undefined) {
    return { outcome: 'no_bridge', fetched_at: null, detail: null, me: null, summary: null };
  }
  return asCloudAccountRaw(raw);
}

/** Sign out of the relay: deletes the Cloud Key stored on THIS PC and drops the
 *  relay socket. Both halves are local — the Cloud Key itself is a stateless JWT
 *  and stays valid until its exp (the "valid until" (有效期至) the panel shows), because no
 *  server-side revocation exists yet (W4-4). Which is exactly what the confirm
 *  copy promises: delete it here, paste it again to come back. Nothing in this
 *  path may be reworded as revoking or invalidating the key. */
export async function clearCloudKey(): Promise<CloudStatus> {
  return asCloudStatus(await invokeSafe<unknown>('cloud_clear_key'));
}

// `switchChannel` is GONE (owner 2026-07-30 ②) together with the Rust
// `channel_switch` command it called: the device page's "set as primary channel" (设为主通道) select was its
// only caller, and both channels are resident anyway. A binding whose command no
// longer exists is worse than no binding — it fails at runtime only.

/** Open the desktop diagnostics directory in the system file manager.
 *
 * Deliberately NOT routed through `invokeSafe`: that helper folds every rejection
 * into `undefined` and a console.warn, which would throw away the one thing this
 * call produces on failure — the reason. "the log directory doesn't exist at all" and "the shell won't open"
 * are different problems with different fixes, and this is the forensic path; a
 * forensic feature whose own failure is unreadable is the joke it exists to prevent.
 * The reason goes to the user AND to window-forensics.log. */
export async function openLogDirectory(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!hasTauri()) return { ok: false, reason: 'bridge unavailable (not running under Tauri)' };
  try {
    await invoke<boolean>('open_log_directory');
    return { ok: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    appendForensic('logdir', `open failed: ${reason}`);
    return { ok: false, reason };
  }
}

// ── autostart, "launch at startup" (开机自启) (V2-10) ──
// The toggle in Settings → Preferences (设置→偏好) reads its displayed state from the SYSTEM registry on
// every mount — never from a stored setting (criterion 4: after the user manually
// disables it in Windows Settings, the toggle must show off). All failures travel as a verbatim `reason` the page
// shows in place — like openLogDirectory, these two deliberately bypass
// invokeSafe, which would fold the one thing they produce on failure (the
// reason) into a console.warn.

/** Real-state snapshot from the HKCU Run key + Task-Manager startup switch. */
export interface AutostartInfo {
  /** true only when the Run value exists AND is not Task-Manager-disabled. */
  enabled: boolean;
  /** The running exe's absolute path — what an enable registers. */
  exe_path: string;
  /** The raw registered command line, verbatim (null = nothing registered). */
  registered_cmd: string | null;
  /** Whether the exe the entry points at still exists (null = indeterminate). */
  registered_exe_exists: boolean | null;
}

/** Field-by-field narrowing (2026-07-27 lesson (教训): a runtime cast never gives this). */
export function asAutostartInfo(v: unknown): AutostartInfo | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean' || typeof o.exe_path !== 'string') return null;
  return {
    enabled: o.enabled,
    exe_path: o.exe_path,
    registered_cmd: typeof o.registered_cmd === 'string' ? o.registered_cmd : null,
    registered_exe_exists: typeof o.registered_exe_exists === 'boolean' ? o.registered_exe_exists : null,
  };
}

/** Read the real autostart state. `ok:false` means the READ failed — the page
 *  must say so, not render a guess either way. */
export async function fetchAutostartState(): Promise<{ ok: true; info: AutostartInfo } | { ok: false; reason: string }> {
  if (!hasTauri()) return { ok: false, reason: 'bridge unavailable (not running under Tauri)' };
  try {
    const info = asAutostartInfo(await invoke('autostart_state'));
    if (info === null) return { ok: false, reason: 'autostart_state 返回了无法识别的形状' };
    return { ok: true, info };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Change-and-save-immediately (即改即存) write: enable/disable, read-back-verified on the Rust side. On
 *  success the returned info IS the re-read system state; on failure `reason`
 *  is the exact step that failed (registry write / quoted rewrite / verify). */
export async function setAutostartEnabled(enable: boolean): Promise<{ ok: true; info: AutostartInfo } | { ok: false; reason: string }> {
  if (!hasTauri()) return { ok: false, reason: 'bridge unavailable (not running under Tauri)' };
  try {
    const info = asAutostartInfo(await invoke('autostart_set', { enable }));
    if (info === null) return { ok: false, reason: 'autostart_set 返回了无法识别的形状' };
    return { ok: true, info };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── P7 (0.3.1) — the manual offline switch ──

/** Read the current offline flag. `null` = could not ask (no bridge / bad
 *  shape) — the switch renders an unknown state, never a guess. */
export async function fetchOfflineState(): Promise<boolean | null> {
  if (!hasTauri()) return null;
  try {
    const v = (await invoke('offline_state')) as Record<string, unknown> | null;
    return v !== null && typeof v === 'object' && typeof v.offline === 'boolean' ? v.offline : null;
  } catch {
    return null;
  }
}

/** Flip the switch. The returned value is the Rust side's post-apply state —
 *  the caller renders THAT, not its own intention (the OFFLINE_STATE push
 *  will confirm it a moment later; both carry the same fact). */
export async function setOfflineMode(enable: boolean): Promise<boolean | null> {
  if (!hasTauri()) return null;
  try {
    const v = (await invoke('offline_set', { enable })) as Record<string, unknown> | null;
    return v !== null && typeof v === 'object' && typeof v.offline === 'boolean' ? v.offline : null;
  } catch {
    return null;
  }
}

// ── capsule window lifecycle commands ──
export const capsule = {
  resize(width: number, height: number): void {
    void invokeSafe('capsule_resize', { width, height });
  },
  /** Place the capsule at a position WE computed (caret anchor / top-center /
   *  clamped restore of a persisted drag). 🔴 NOT the drag path since
   *  REQ-12-15 — see `startDrag` below. */
  move(x: number, y: number): void {
    void invokeSafe('capsule_move', { x, y });
  },
  /** REQ-12-15 — hand the drag to the OS move loop. Returns whether the OS
   *  actually took it; a `false` must be SAID (the caller records it), because
   *  a drag that never started and a drag that lags look identical to the
   *  user, and telling them apart is the whole point of this change.
   *
   *  After this resolves the WebView stops receiving the pointer: the OS owns
   *  the mouse until the button is released. That is why the end of the drag
   *  is learned from `onMoved` + `position()` rather than from a pointerup. */
  async startDrag(): Promise<boolean> {
    if (!hasTauri()) return false;
    try {
      await invoke('capsule_start_drag');
      return true;
    } catch (e) {
      console.warn('[flowmic] capsule_start_drag failed', e);
      return false;
    }
  },
  /** Where the capsule actually IS, in LOGICAL px, read from the OS (Rust
   *  converts once, by the capsule window's own scale factor — the frontend
   *  never guesses physical vs logical). `null` when unavailable: the caller
   *  then keeps its previous position and persists nothing, rather than
   *  saving a fabricated one. */
  async position(): Promise<{ x: number; y: number } | null> {
    const p = await invokeSafe<{ x: number; y: number }>('capsule_position');
    return p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null;
  },
  /** Subscribe to the capsule window's own move notifications.
   *
   *  `tauri://move` is Tauri's built-in per-window event (emitted from
   *  `WindowEvent::Moved`), NOT one of the `flowmic://…` bridge channels in
   *  `CH` — those must equal socket/bridge.rs and this one is the framework's.
   *  It is the only push signal that survives a native drag: the OS runs a
   *  modal move loop, so no pointermove / pointerup reaches this document
   *  while it is running, and the LAST event of a drag carries the final
   *  resting place. The payload is PHYSICAL px and is deliberately ignored —
   *  callers ask `position()` for the logical answer instead of dividing by a
   *  ratio here (that division is the historical off-screen-capsule bug). */
  async onMoved(cb: () => void): Promise<UnlistenFn> {
    if (!hasTauri()) return () => {};
    return listen('tauri://move', () => cb());
  },
  clickThrough(ignore: boolean): void {
    void invokeSafe('capsule_click_through', { ignore });
  },
  surface(): void {
    void invokeSafe('capsule_surface');
  },
  hide(): void {
    void invokeSafe('capsule_hide');
  },
  /** V2-19 (2026-08-02) — write `text` to the OS clipboard via the native
   *  `capsule_copy_text` command (platform-dispatched since B3 2026-08-11:
   *  Win32 `SetClipboardData` on Windows, NSPasteboard on macOS —
   *  src-tauri/src/shell/clipboard_copy.rs). The capsule's copy button cannot
   *  use `navigator.clipboard` the way main-window/TimelinePage.vue's copy()
   *  does: the capsule's window carries WS_EX_NOACTIVATE for the never-
   *  steal-focus red line, which could ALSO mean its WebView2 document never
   *  registers as Chromium-"focused" — and the Async Clipboard API requires
   *  `document.hasFocus()`. This is `invoke` behind the SAME single funnel
   *  every other Tauri call in this file goes through (RV-97: a funnel with
   *  a second entry point is not a funnel).
   *
   *  Deliberately NOT routed through `invokeSafe` (same reason as
   *  `openLogDirectory` above): that helper folds every rejection into
   *  `undefined` + a console.warn, discarding the one thing a failed copy
   *  needs to report to the user — why. */
  async copyText(text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await invoke('capsule_copy_text', { text });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },
};

/** Foreground caret geometry for the capsule's first-surface anchor (R6 T-1) — the
 *  caret rect plus the work area of the monitor the CARET is on, both already in
 *  LOGICAL px (Rust converts once, see shell::caret_rect). `null` whenever the OS
 *  has no usable caret (no text field focused / GetGUIThreadInfo refused / empty
 *  rect) or we are outside Tauri — the caller then falls back to top-center. */
export interface CaretRect {
  x: number;
  y: number;
  width: number;
  height: number;
  work_x: number;
  work_y: number;
  work_width: number;
  work_height: number;
}

export async function fetchCaretRect(): Promise<CaretRect | null> {
  return (await invokeSafe<CaretRect | null>('caret_rect')) ?? null;
}

export function showMainWindow(): void {
  void invokeSafe('show_main');
}

/** Same-window DOM fallback for `navigateMain` (Settings → Devices). The Tauri
 *  emit covers the capsule→main cross-window path; this covers an already-open
 *  main window (and `vite` browser preview where emit is a no-op). */
export const UI_NAVIGATE_DOM = 'flowmic:ui-navigate';

/** Ask the main window to switch pages (R6 T-5c: the capsule ⚙ opens the L1
 *  settings page, REDESIGN §5.2). A global Tauri emit — the main window's WebView
 *  stays alive while hidden, so its listener is always there to receive it. Pair it
 *  with `showMainWindow()`; page state is set even if the window is already up.
 *  Also dispatches `UI_NAVIGATE_DOM` so a same-window caller (settings account
 *  section (账号区) "go to the device page" (前往设备页)) does not depend on the cross-window emit alone. */
export function navigateMain(page: MainPage): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UI_NAVIGATE_DOM, { detail: { page } }));
  }
  if (!hasTauri()) return;
  void emit(UI_NAVIGATE, { page }).catch((e) => console.warn('[flowmic] navigate emit failed', e));
}

// ── forensics frontend mirror (07 §10) ──
// Each domain keeps its own monotonically increasing sequence so the log reads
// `fe.<domain>#<seq> <msg>` — the Rust `append_forensic` command prepends the
// timestamp and appends to the same window-forensics.log. No-op outside Tauri
// (invokeSafe returns undefined); a write failure is silently tolerated (the
// observation layer never bites back at (反噬) the main flow).
const forensicSeq = new Map<string, number>();
export function appendForensic(domain: string, msg: string): void {
  const seq = (forensicSeq.get(domain) ?? 0) + 1;
  forensicSeq.set(domain, seq);
  void invokeSafe('append_forensic', { line: `fe.${domain}#${seq} ${msg}` });
}

/** v0.2.4 — every resident channel's CURRENT connection state, as a PULL.
 *
 *  The `flowmic://connection` push fires only when the state CHANGES, which made
 *  it a one-shot the UI had to already be listening for. It was not: the
 *  instrumented forensic log timed both channels reaching connected at
 *  02:07:05.9 and this window registering its listener at 02:07:07.0 — 1.1 s
 *  late, every launch, because Rust opens sockets faster than a WebView boots.
 *  The page then sat at "connecting…" / "not connected" for the whole session while both
 *  sockets were fine (owner 2026-07-29: "it's always been like this").
 *
 *  Empty array = no channel is resident (never "disconnected"). */
export async function fetchConnectionSnapshot(): Promise<ConnectionState[]> {
  const rows = await invokeSafe<unknown>('connection_snapshot');
  return Array.isArray(rows) ? (rows as ConnectionState[]) : [];
}

/** Subscribe to a bridge channel; returns an unlisten fn (no-op outside Tauri). */
export async function onChannel<T>(channel: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (!hasTauri()) return () => {};
  return listen<T>(channel, (e) => cb(e.payload as T));
}

/** V2-01 focus diagnostic snapshot (焦点诊断快照). Every field is an observed value — absence is 0/false, never a guess (字段全是观测值——缺失是 0/false，不是猜的).
 *
 *  `verdict` (0.2.22+): Rust emits `'Input' | 'NotInput' | 'Unknown'`.
 *  Not a rename of the retired UIA Editable/NotEditable pair —
 *  `NotInput` means "provably not an input location" (only two cases: no window holds
 *  keyboard focus, or the thread is in menu/move/size mode). Do not map the
 *  new words back onto the old ones. */
export interface FocusDiagnostic {
  verdict: 'Input' | 'NotInput' | 'Unknown';
  would_refuse: string | null;
  foreground_hwnd: number;
  foreground_title: string;
  foreground_process: string;
  focus_hwnd: number;
  caret_hwnd: number;
  gui_info_ok: boolean;
  focus_is_foreground: boolean;
}

/** Take ONE read-only focus snapshot. Injects nothing, activates nothing.
 *
 * The caller MUST run its countdown first: sampling has to happen after the
 * user has switched to the target window, or the answer is always FlowMic
 * itself — a diagnostic that runs fine and tells you nothing.
 *
 * ⚠️ ZERO CALLERS since owner 2026-08-02 UI batch one (批一) ④, and that is stated rather than
 * left to be discovered: the one caller (ConnDiagPage.vue's focus-probe (焦点探测) block) is
 * **commented out in place, not deleted**, together with the restoration condition (恢复条件). This is
 * deliberately NOT the façade shape the repo hunts — a façade is "a capability is
 * defined but nobody calls it, while the UI still promises it", and there is no longer any UI promising this. Do not "clean up"
 * this function or the Rust `focus_diagnostic` command it calls; putting the probe
 * back must not mean re-writing the bridge. */
export async function focusDiagnostic(): Promise<FocusDiagnostic | null> {
  return (await invokeSafe<FocusDiagnostic>('focus_diagnostic')) ?? null;
}

