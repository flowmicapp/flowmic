// SPEC-REF:
//   apps/desktop/src-tauri/src/shell/mod.rs — `settings_update` → `with_lan_socket`,
//     `false` fallback: the ONLY reason a settings write fails.
//     🔴 Cited by SYMBOL, not by line. The number rotted on 2026-08-17 when card
//     C3 added a doc block above that command — precisely the hazard the
//     `mod channel_session;` note in that same file was written to avoid, and it
//     came due anyway. A name that moves greps to zero and fails loud at the
//     moment of use; a number that moves lands the reader on the wrong line with
//     no signal at all.
//   apps/desktop/src-tauri/src/shell/sidecar_ctl.rs (bring_up_and_connect / connect_socket
//     — the LAN socket slot `with_lan_socket` reads is populated ONLY on Healthy /
//     AdoptedExternal, and emptied on every other phase)
//   docs/rebuild/07-DESKTOP-SPEC.md §8 (save-on-change + fail-loud offline → saved locally)
//
// RV-94 (B4-11) — owner 2026-08-01 real-device session, verbatim quote:「PC 本地的配置有些是为本地的托管
// SERVER-CORE 服务的, 提示此服务没开起来要如何处理即可」("some of the PC's local config is for the locally-hosted SERVER-CORE service — just prompt what to do when this service hasn't started").
//
// 「已存本地」("saved locally") (SettingsClient.pending) used to be a boolean that could only
// answer 「有没有同步上」("whether it has synced") — it could not answer 「为什么没同步上、我该做什么」
// ("why it hasn't synced, what should I do") — yet another instance of this repo's #1 bug shape
// (one value answering two questions). It is especially easy to miss because lib/conn-dot.ts's
// red dot is already handling 「连接不好」("connection is bad"), which makes it look like this case
// is already covered; but conn-dot answers 「当前活跃通道（Admission::primary()）好不好」
// ("whether the currently active channel (Admission::primary()) is OK"), while settings_scope_lan
// says this page's settings are sent to the LAN server ONLY — a user whose cloud channel is fine
// but whose LAN sidecar just hasn't come up will see a green footer dot, yet every edit on this
// page has nowhere to go. This file answers exactly one question: whether 「已存本地」
// ("saved locally") should or should not point at 「本地服务没起来」("the local service hasn't started").
//
// Pure — no Vue, no Tauri — so it is testable in the desktop's node-env vitest
// without mounting anything (same split as lib/conn-dot.ts / lib/probe-client.ts).

/** Phase tags (Rust `sidecar_state` / `sidecar-state` push) whose slot in
 *  `SocketState` is non-empty — the ONLY two `with_lan_socket` will call `f`
 *  for instead of falling back to `false`. Every other tag, INCLUDING `null`
 *  (no snapshot has arrived yet — e.g. right after launch), means the socket
 *  slot is empty and a settings write has nowhere to go. */
const LAN_SOCKET_LIVE_PHASES = new Set(['healthy', 'adopted_external']);

export type SettingsSyncNotice =
  /** Nothing pending — the header's plain 「已保存」("saved") tick. */
  | 'saved'
  /** Pending while the LAN sidecar IS up: an ordinary transient hiccup (a single
   *  emit lost a race, or the connected-edge flush has not run yet). No action
   *  needed — `flushPending` already re-sends on the next connected rising edge. */
  | 'pending_transient'
  /** Pending because the LAN sidecar has never reached Healthy / AdoptedExternal
   *  (still bringing up, or `Failed`): the write has nowhere to go and will NOT
   *  resolve on its own by waiting on THIS page. This is the case RV-94 asks for
   *  an explicit, actionable notice — 「本地服务未启动」("local service not started") + where to check it. */
  | 'pending_no_service';

/**
 * `pending` — `SettingsClient.pending` (main-window/store.ts `settingsPending`):
 *   true while any settings key has not reached a live wire.
 * `sidecarPhase` — the last `sidecar_state`/`sidecar-state` phase tag, or `null`
 *   before the first snapshot has arrived.
 */
export function settingsSyncNotice(pending: boolean, sidecarPhase: string | null): SettingsSyncNotice {
  if (!pending) return 'saved';
  return LAN_SOCKET_LIVE_PHASES.has(sidecarPhase ?? '') ? 'pending_transient' : 'pending_no_service';
}
