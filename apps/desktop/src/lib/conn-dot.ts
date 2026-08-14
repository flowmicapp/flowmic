// SPEC-REF:
//   docs/strategy/R2-R3-TASK-CARDS.md T-5b (四态连接点 — 真实信号推导)
//   apps/desktop/src/lib/channel.ts (Dot 调色板 / cloudLoudReason)
//
// Pure decision core for the sidebar / devices / capsule connection status dot.
// Every colour is derived from a real bridge/sidecar/cloud signal — never a
// façade "connecting" invented without evidence. Dot palette is the EXISTING
// g|y|r|o set in styles/tokens.css (T-2); this module does not invent colours.

import {
  CHANNEL_LABEL,
  cloudLoudReason,
  type ChannelId,
  type CloudStatus,
  type Dot,
} from './channel';
import { S } from './strings';

export interface ConnDotInput {
  connected: boolean;
  /** `Credentials::is_registered()` — token present. NOT cleared on socket drop
   *  (only on auth:expired / dead-token recovery), so `!connected && registered`
   *  honestly means "was previously registered, the link dropped, retrying now". */
  registered: boolean;
  /** Active delivery channel (exactly one live connection, 07 §6). */
  channel: ChannelId;
  /** Rust sidecar lifecycle tag; only `'failed'` is a loud LAN fault. */
  sidecarPhase: string | null;
  cloud: CloudStatus;
}

export interface ConnDotView {
  dot: Dot;
  label: string;
  /** Loud reason line — non-null ONLY for red. Must be visible wherever the
   *  red dot is shown (没有静默失败). */
  detail: string | null;
}

/** Resolve the active-channel loud fault, or null when there is none. */
export function connLoudReason(input: Pick<ConnDotInput, 'channel' | 'sidecarPhase' | 'cloud'>): string | null {
  if (input.channel === 'cloud') return cloudLoudReason(input.cloud);
  if (input.sidecarPhase === 'failed') return S.dev_chan_lan_failed;
  return null;
}

/**
 * Four-state connection dot from real signals.
 *
 *  g — socket up AND pc:register ack'd
 *  y — socket up but not yet registered, OR registered-but-disconnected
 *      (reconnect in flight; token survives the drop)
 *  r — active-channel loud fault (cloudLoudReason / sidecar failed); carries detail
 *  o — down, never registered, no loud fault
 */
export function deriveConnDot(input: ConnDotInput): ConnDotView {
  const loud = connLoudReason(input);
  if (loud !== null) {
    return { dot: 'r', label: S.conn_fault, detail: loud };
  }
  if (input.connected && input.registered) {
    return { dot: 'g', label: S.conn_online, detail: null };
  }
  if (input.connected && !input.registered) {
    // Socket open, register not yet ack'd — was previously painted green by the
    // binary `connected ? g : o` lie. Reuse the dormant conn_reconnecting string
    // so that façade finally gains a production caller.
    return { dot: 'y', label: S.conn_reconnecting, detail: null };
  }
  if (!input.connected && input.registered) {
    return { dot: 'y', label: S.conn_reconnecting, detail: null };
  }
  return { dot: 'o', label: S.conn_offline, detail: null };
}

/** Active-channel display name (diagnostics card's "current channel" row). */
export function connChannelLabel(channel: ChannelId): string {
  return CHANNEL_LABEL[channel];
}
