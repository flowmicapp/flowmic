// P3 #23 (2026-09-02) — the decision DevicesPage.vue's `loadInfo()` makes
// about whether it needs a SECOND `fetchPairingInfo('cloud')` IPC round-trip,
// pulled out so it is unit-testable without mounting the page.
//
// THE WASTE THIS AVOIDS. `loadInfo()` runs on a 3s interval (`lanPoll`). While
// the LAN tab is the active pairing target and a cloud key is configured, the
// old code fetched `pairing_code('cloud')` on EVERY tick just to keep
// `cloudPcid` / `cloudNode` current — a pcid/node pair that (per
// DevicesPage.vue's own doc comment on `cloudNode`) is a stable fact about
// which relay a cloud key routes through, not something that changes
// tick-to-tick. That doubled the `pairing_code` IPC traffic for data that,
// once known, does not need re-asking.
import type { ChannelId } from './paired-mobiles';

/** True only at the moments the cached cloud pcid/node can actually be stale:
 *  the LAN tab is active (the 'cloud' tab already re-reads directly off its own
 *  `fetchPairingInfo` answer, so this predicate is not consulted there), a
 *  cloud key IS configured (nothing to fetch otherwise), and nothing has been
 *  cached yet — either because this is the first tick after mount/key-set, or
 *  because a previous fetch failed and left the cache at `null` (in which case
 *  this deliberately keeps saying "fetch again": a failed read must retry, not
 *  give up and cache the failure as if it were an answer). */
export function shouldFetchCloudPairingInfo(
  activeChannel: ChannelId,
  cloudKeySet: boolean,
  cachedCloudPcid: string | null,
): boolean {
  return activeChannel !== 'cloud' && cloudKeySet && cachedCloudPcid === null;
}
