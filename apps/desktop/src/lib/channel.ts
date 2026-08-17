// SPEC-REF:
//   docs/ui-design/REDESIGN-PLAN.md §5.2 (device page channel dual-card: local LAN / cloud relay, 设备页通道双卡: 本地局域网 / 云端中继)
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (connection layer — dual channels always resident, 连接层——双通道常驻)
//   docs/decisions/2026-07-26-dual-channel-spec-misref.md (GA-28: this header
//     used to cite 07 §6 for "only one active connection at a time", a sentence that section
//     does not contain — it is REDESIGN A-5 and it is about the MOBILE side)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md T-2
//
// Pure, Tauri-free, DOM-free decision core for the two-channel device page and
// the capsule's channel label. The Vue components only render what these
// functions return, so the honesty rules are unit-testable in isolation:
//
//   • the CONNECTED dot belongs to the ACTIVE channel only. The other card can
//     never show green off a connection that is not its own (the socket is
//     channel-agnostic — mislabelling it would be the first lie on this page);
//   • a cloud channel that cannot dial is LOUD (its own reason line), never a
//     quiet "waiting" that hides an expired Cloud Key;
//   • the account email is NOT displayed: the Cloud Key only asserts a user id
//     and a plan, and this build does not call `/api/me`, so the card shows what
//     the key actually carries and says where the rest lives.
//
// Terminology iron rule (术语军规) (T-2): the two channels are named ONLY "local LAN" (本地局域网) and "cloud relay" (云端中继).

import { DEFAULT_SAAS_ENDPOINT, LEGACY_SAAS_ENDPOINTS, type ErrorCode } from '@flowmic/protocol';
import { S } from './strings';
import type { ChannelTag } from './types';

/** The server's refusal code for "this account's PC count has reached the plan's limit" (这个账号的电脑数量已达套餐上限) (room/registry.ts).
 *
 *  Typed as `ErrorCode` on purpose rather than compared as a bare literal: the
 *  neighbouring `auth_error` comparisons in [cloudLoudReason] are free-form
 *  strings, so renaming or deleting a code on the protocol side would leave a
 *  branch here that can never be true — a façade that compiles. This annotation
 *  turns that drift into a build failure instead of a quiet lie on screen. */
const PC_LIMIT_EXCEEDED: ErrorCode = 'PCS_LIMIT_EXCEEDED';

/** RV-01: ONE declaration of the two tags, in lib/types.ts — a timeline row now
 *  carries one, so the type had to live where the row's type lives (types.ts imports
 *  nothing local, which keeps the import graph acyclic). `ChannelId` stays as the
 *  name the device page and the capsule already use. */
export type ChannelId = ChannelTag;

/** The ONLY labels for the two channels (capsule + device page share them).
 *  V2-07.8a: getters, not snapshots — a plain `S.dev_chan_lan` here would freeze
 *  the label at module load, the exact stale-after-language-switch bug class.
 *  Reading the reactive S inside a getter keeps every consumer live. */
export const CHANNEL_LABEL: Record<ChannelId, string> = {
  get lan() { return S.dev_chan_lan; },
  get cloud() { return S.dev_chan_cloud; },
};

/** The relay endpoint a fresh install proposes. SSOT = @flowmic/protocol, never a
 *  literal on this side (a self-hosted relay is just a different saved value). */
export const DEFAULT_CLOUD_ENDPOINT = DEFAULT_SAAS_ENDPOINT;

/** Relay addresses this product has RETIRED. Same SSOT rule as the line above:
 *  mirrored from @flowmic/protocol, never a literal on this side. */
export const LEGACY_CLOUD_ENDPOINTS: readonly string[] = LEGACY_SAAS_ENDPOINTS;

/** The `cloud_status` IPC arguments — the endpoint SSOT, packed for the boundary.
 *
 *  🔴 WHY A READ CARRIES THIS. `CloudConfig.endpoint` is a STORED value that
 *  only falls back to the default when it is empty, so an install configured
 *  while a now-retired address was canonical keeps that address forever. The fix is a
 *  one-time migration, and it has to RUN in Rust — the Cloud Key never crosses
 *  back to this side, so the frontend cannot re-save the config by itself —
 *  while the LITERALS have to stay on this side, because src-tauri's standing
 *  rule (socket/channel.rs) is that no endpoint literal is hardcoded in that
 *  crate. Handing both values inward on every status read is what satisfies
 *  both halves.
 *
 *  It is folded into `fetchCloudStatus` rather than given its own command on
 *  purpose: there is exactly ONE funnel through which the frontend can learn the
 *  cloud endpoint, so no call site can forget to bring the SSOT along, and the
 *  status that comes back is post-migration by construction (a separate call
 *  would leave a window in which the card renders the value we just decided to
 *  replace).
 *
 *  🔴 THIS IS A REQUIRED ARGUMENT OF THE `cloud_status` COMMAND, not a decoration
 *  on the call in bridge.ts. Dropping it there makes every cloud-status invoke
 *  fail argument deserialisation, and `invokeSafe` turns that into `undefined` +
 *  a console warning — i.e. the cloud card blanks on both windows and nothing in
 *  the type system says why. (The note lives here rather than at the call site
 *  because bridge.ts is at the 800-line cap.) */
export function cloudEndpointSsot(): { canonical: string; legacy: string[] } {
  return { canonical: DEFAULT_CLOUD_ENDPOINT, legacy: [...LEGACY_CLOUD_ENDPOINTS] };
}

/** Channel visual identity (owner 2026-08-01: colour + icon combination, cannot rely
 *  on colour alone; define once,
 *  unify across the whole product (颜色+图标组合，不能只靠颜色；一处定义，全产品统一) — see styles/tokens.css's `--channel-*-ink` / `--channel-*-soft` and
 *  `.chan-badge.*`, which is the ONE colour definition every consumer reads).
 *
 *  This file deliberately carries ZERO colour hex — that lives only in tokens.css,
 *  same as every other colour token in this app (grep this file to check: a second
 *  copy here would be exactly the drift "define once" (一处定义) was written to prevent). What
 *  belongs here is the ICON (a real, different silhouette per channel — colour alone
 *  was the owner's stated complaint) and the CSS class suffix that selects the colour.
 *
 *  apps/mobile/lib/src/ui/tokens.dart's `FlowMicChannelColors` carries the
 *  BYTE-IDENTICAL hex pair-for-pair (see that file's header for the side-by-side
 *  table) — the two apps must read as one product, not two skins that happen to
 *  agree today. */
export interface ChannelVisual {
  /** `.chan-badge.<css>` in tokens.css selects this channel's ink/soft colour pair. */
  css: 'lan' | 'cloud';
  /** Inline SVG body, viewBox `0 0 24 24`, stroke paths that inherit `currentColor`
   *  (the shared `.icon` rule in tokens.css) — meant to be rendered with `v-html` on
   *  a bare `<svg>`, NOT through main-window/components/Icon.vue's registry: this
   *  file is imported from places that do not have that page-local component in
   *  scope (and importing it would go against Icon.vue being that page's own icon
   *  set, not a shared one). Two REAL shapes — concentric wifi arcs vs a cloud
   *  outline — never the same glyph recoloured; both read at 11px and in grayscale. */
  iconPath: string;
}

export const CHANNEL_VISUAL: Record<ChannelId, ChannelVisual> = {
  lan: {
    css: 'lan',
    iconPath:
      '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/>' +
      '<path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/>',
  },
  cloud: {
    css: 'cloud',
    iconPath: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
  },
};

/** Rust `CloudReadiness::tag()` — the fail-loud verdict for the cloud channel. */
export type CloudReadiness = 'ready' | 'rejected' | 'no_endpoint' | 'no_key' | 'key_expired';

/** Mirrors the Rust `CloudStatusDto` (shell/cloud.rs). The Cloud Key itself is
 *  deliberately absent — only `key_set` + a 6-char head ever cross the boundary.
 *
 *  RV-新B: there is NO `channel` here any more. It used to carry "which channel is current" off
 *  the Rust `CloudConfig.active` flag, whose only writer ("set as primary channel") owner
 *  2026-07-30 ② deleted — so it was a constant `'lan'` that six surfaces rendered as
 *  live state. That question is answered by the CONNECTION payload's own `channel`
 *  (main window: `store.currentChannel`; capsule: `state.channel`), which is the one
 *  thing pushed on the edge where the answer actually changes. */
export interface CloudStatus {
  endpoint: string;
  key_set: boolean;
  key_head: string | null;
  plan: string | null;
  subject: string | null;
  expires_at: number | null;
  readiness: CloudReadiness;
  auth_error: string | null;
}

export const EMPTY_CLOUD_STATUS: CloudStatus = {
  endpoint: '',
  key_set: false,
  key_head: null,
  plan: null,
  subject: null,
  expires_at: null,
  readiness: 'no_key',
  auth_error: null,
};

/** Normalize an unknown IPC payload into a CloudStatus (outside Tauri / an older
 *  shell → the LAN default, never a half-populated object). */
export function asCloudStatus(raw: unknown): CloudStatus {
  if (raw === null || typeof raw !== 'object') return { ...EMPTY_CLOUD_STATUS };
  const o = raw as Record<string, unknown>;
  const readiness = o.readiness;
  return {
    endpoint: typeof o.endpoint === 'string' ? o.endpoint : '',
    key_set: o.key_set === true,
    key_head: typeof o.key_head === 'string' ? o.key_head : null,
    plan: typeof o.plan === 'string' ? o.plan : null,
    subject: typeof o.subject === 'string' ? o.subject : null,
    expires_at: typeof o.expires_at === 'number' ? o.expires_at : null,
    readiness: isReadiness(readiness) ? readiness : 'no_key',
    auth_error: typeof o.auth_error === 'string' ? o.auth_error : null,
  };
}

function isReadiness(v: unknown): v is CloudReadiness {
  return v === 'ready' || v === 'rejected' || v === 'no_endpoint' || v === 'no_key' || v === 'key_expired';
}

/** Structural check on a pasted Cloud Key, mirroring `channel::is_jwt_shaped`.
 *  It proves nothing about validity — it only catches an obviously wrong paste
 *  (a password, a console URL, half a token) before anything is stored. */
export function isJwtShaped(raw: string): boolean {
  const parts = raw.trim().split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0 && /^[A-Za-z0-9_=-]+$/.test(p));
}

/** Status dot classes — the EXISTING palette in styles/tokens.css:
 *  g = green (live), y = amber (coming up), r = red (loud problem),
 *  o = grey (this channel is not the active one). */
export type Dot = 'g' | 'y' | 'r' | 'o';

export interface ChannelCard {
  /** GA-28: the dot describes THIS CHANNEL'S OWN health, nothing else —
   *  green = its socket is up, amber = coming up, red = loudly broken,
   *  grey = not resident at all (e.g. cloud with no key).
   *
   *  Before GA-28 the dot conflated health with role: the non-selected channel
   *  was drawn grey even when its socket was connected, because only one channel
   *  could be connected at all. With both resident that would be a plain lie
   *  about a working link.
   *
   *  owner 2026-07-30 ②: there is no ROLE half left to keep apart. The card had an
   *  `active` flag (the "primary channel" (主通道) chip + the "set as primary channel" (设为主通道) button) which came from a
   *  user setting that no longer exists — the device page is an INFORMATION panel
   *  now, and "which channel is carrying the runtime" (哪条通道带运行时) is derived from which phone is admitted. */
  dot: Dot;
  /** The one-line status under the title. */
  status: string;
  /** A LOUD problem line (red) — `null` when there is nothing wrong. */
  loud: string | null;
}

/** The local LAN (本地局域网) card. `connected` is THIS channel's own socket (GA-28: the
 *  frontend keeps one snapshot per resident channel). `sidecarPhase === 'suspended'`
 *  is the honest "local service hasn't started" state, not a failure.
 *
 *  A connected channel now reads as READY, full stop. It used to read
 *  "resident, standing by" (常驻待命) whenever it was not the selected one — a status line that answered
 *  "did you select it" while sitting under a heading that asks "is it connected or not". */
export function deriveLanCard(input: {
  connected: boolean;
  sidecarPhase: string | null;
  loopback: boolean;
}): ChannelCard {
  const { connected, sidecarPhase, loopback } = input;
  if (sidecarPhase === 'failed') {
    return { dot: 'r', status: S.sidecar_failed, loud: S.dev_chan_lan_failed };
  }
  if (sidecarPhase === 'suspended') {
    return { dot: 'o', status: S.dev_chan_lan_suspended, loud: null };
  }
  if (!connected) {
    return { dot: 'y', status: S.dev_chan_connecting, loud: null };
  }
  return {
    dot: 'g',
    status: loopback ? S.dev_chan_lan_loopback : S.dev_chan_lan_ready,
    loud: null,
  };
}

/** The cloud relay (云端中继) card. Every non-ready readiness produces a LOUD line — the T-2 ⑤
 *  red line is that an expired / refused Cloud Key is stated, never swallowed. */
export function deriveCloudCard(input: { status: CloudStatus; connected: boolean }): ChannelCard {
  const { status, connected } = input;
  const loud = cloudLoudReason(status);
  if (loud !== null) {
    // A broken key is LOUD on either card — the user needs to know why the
    // channel is down, not only when it happens to be the primary one.
    return { dot: 'r', status: S.dev_chan_cloud_signed_out, loud };
  }
  if (!status.key_set) {
    // Not resident at all: without a key there is nothing to dial. Grey here is
    // a fact, not a role judgement.
    return { dot: 'o', status: S.dev_chan_cloud_no_key, loud: null };
  }
  if (!connected) {
    return { dot: 'y', status: S.dev_chan_connecting, loud: null };
  }
  return { dot: 'g', status: S.dev_chan_cloud_ready, loud: null };
}

/** The loud reason for a cloud channel that cannot be used, or null when it can. */
export function cloudLoudReason(status: CloudStatus): string | null {
  switch (status.readiness) {
    // The reason must match the ACTUAL code: a rejected registration is not
    // automatically an expired login (a registry/payload refusal keeps the key),
    // and saying "please re-paste the Cloud Key" for it would send the user down a dead end.
    case 'rejected':
      if (status.auth_error === 'KEY_MALFORMED') return S.cloud_err_malformed;
      if (status.auth_error === 'AUTH_TOKEN_EXPIRED' || status.auth_error === 'AUTH_TOKEN_INVALID') {
        return S.cloud_err_expired;
      }
      if (status.auth_error === 'auth:expired') return S.cloud_err_expired;
      // 🔴 M4-5 —— fills in the half that was "visible before you buy, invisible
      // the moment you hit the wall" (买之前看得到、撞墙那一刻看不到).
      //
      // The production caller is real, not an untraveled branch (anti-façade ①,
      // already grepped to its endpoint, 反 façade ①，已 grep 到端):
      //   room/registry.ts `ensurePcSlot` → `ServerError('PCS_LIMIT_EXCEEDED')`
      //   → socket/handlers/pc.handler.ts's `safeAck(ack, errorPayload(err))`
      //   → desktop socket/pairing.rs `report_refusal` → shell/cloud.rs `auth_failure_hook`
      //   → not account-level ⇒ `c.auth_error = Some(code)` → this function.
      // Before reaching here it always fell onto the generic string below
      // ("see the diagnostic log for details", 详见诊断日志), so someone who really
      // hits the limit knows neither what they hit nor what to do.
      //
      // ⚠️ Only recognizes `PCS_LIMIT_EXCEEDED`. `MOBILES_LIMIT_EXCEEDED` is the
      // refusal the **phone** receives during pairing (registry.pairMobile ←
      // mobile.handler's ack), and it never reaches the PC's auth_error —
      // adding it here would create a branch that is forever false.
      if (status.auth_error === PC_LIMIT_EXCEEDED) return S.cloud_err_pc_limit;
      return S.cloud_err_refused;
    case 'key_expired':
      return S.cloud_err_expired;
    case 'no_endpoint':
      return status.key_set ? S.cloud_err_no_endpoint : null;
    case 'no_key':
    case 'ready':
    default:
      return null;
  }
}

/** Plan badge text, or null when the key asserts no plan (never invent one). */
export function planBadge(plan: string | null): string | null {
  if (plan === null || plan.trim() === '') return null;
  return plan.toUpperCase();
}

/** `YYYY-MM-DD HH:mm` in local time, built by hand so the desktop's fixed zh-CN
 *  surface never picks up an OS locale format (red line: UI does not follow OS locale, UI 不跟随 OS locale 红线). */
export function formatExpiry(unixSeconds: number | null): string | null {
  if (unixSeconds === null || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
