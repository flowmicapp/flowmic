// String catalogue shard: sidecar (self-hosted local service) status. Merged and exported by ../strings.ts.
// V2-07.8a: per-locale catalogue (zh-CN baseline + en).
import { DEVICES_STRINGS } from './devices';
import { getLocale } from './locale';
import { shardCatalogue } from './shard';

export const SIDECAR_KEYS = [
  // sidecar (self-hosted server) status — 07 §5, WP-R2-4
  'sidecar_title',
  'sidecar_healthy',
  'sidecar_adopted',
  'sidecar_starting',
  'sidecar_failed',
  'sidecar_retry',
  'sidecar_retrying',
  // U11: the local service binds all network interfaces, but the Windows
  // authorization prompt that pops up identifies the process by name —
  // "node.exe" rather than "FlowMic" — which makes it easy to reject as an
  // unrecognized program. After rejection the LAN channel fails silently,
  // while the loopback health probe here still passes — "ready" answers
  // "this machine can reach itself", not "other devices can reach in";
  // the two are not the same sentence and must be stated separately.
  'sidecar_firewall_note',
] as const;

export const SIDECAR_STRINGS = shardCatalogue(SIDECAR_KEYS);

/** Sidecar phase tag → device-page status label (07 §5). Transient phases fold
 *  into one "starting" line; terminal phases get their own copy.
 *
 *  V2-07.8a: values are GETTERS resolving the CURRENT locale at read time
 *  (getLocale() is a Vue ref — templates rendering SIDECAR_LABEL[phase]
 *  re-render on a language switch, no call-site change). */
export const SIDECAR_LABEL: Record<string, string> = {
  get resolving() { return SIDECAR_STRINGS[getLocale()].sidecar_starting; },
  get spawning() { return SIDECAR_STRINGS[getLocale()].sidecar_starting; },
  get awaiting_handshake() { return SIDECAR_STRINGS[getLocale()].sidecar_starting; },
  get awaiting_health() { return SIDECAR_STRINGS[getLocale()].sidecar_starting; },
  get probing() { return SIDECAR_STRINGS[getLocale()].sidecar_starting; },
  get clearing() { return SIDECAR_STRINGS[getLocale()].sidecar_starting; },
  get healthy() { return SIDECAR_STRINGS[getLocale()].sidecar_healthy; },
  get adopted_external() { return SIDECAR_STRINGS[getLocale()].sidecar_adopted; },
  get failed() { return SIDECAR_STRINGS[getLocale()].sidecar_failed; },
  // R6 T-2: deliberately not started because the cloud relay is the active
  // channel — an honest resting state, not a failure and not a pending start.
  get suspended() { return DEVICES_STRINGS[getLocale()].dev_chan_lan_suspended; },
};
