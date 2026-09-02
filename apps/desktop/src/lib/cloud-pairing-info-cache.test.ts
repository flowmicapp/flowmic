// P3 #23 (2026-09-02) — pins shouldFetchCloudPairingInfo's decision, and
// therefore that DevicesPage.vue's `loadInfo()` stops doubling its
// `pairing_code` IPC traffic once the cloud pcid/node are known.

import { describe, expect, it } from 'vitest';
import { shouldFetchCloudPairingInfo } from './cloud-pairing-info-cache';

describe('shouldFetchCloudPairingInfo', () => {
  it('fetches on the first tick after mount (nothing cached yet, key configured, LAN active)', () => {
    expect(shouldFetchCloudPairingInfo('lan', true, null)).toBe(true);
  });

  it('🔴 does NOT fetch again once a pcid is cached — the waste this card exists to remove', () => {
    expect(shouldFetchCloudPairingInfo('lan', true, 'pc-12345')).toBe(false);
  });

  it('keeps retrying if the cache is still null (a previous fetch failed, or genuinely no pcid) — never gives up', () => {
    expect(shouldFetchCloudPairingInfo('lan', true, null)).toBe(true);
  });

  it('never fetches when no cloud key is configured, cached or not', () => {
    expect(shouldFetchCloudPairingInfo('lan', false, null)).toBe(false);
    expect(shouldFetchCloudPairingInfo('lan', false, 'pc-12345')).toBe(false);
  });

  it('never fetches while the cloud tab is already the active pairing target (that path reads its own fetchPairingInfo answer directly)', () => {
    expect(shouldFetchCloudPairingInfo('cloud', true, null)).toBe(false);
    expect(shouldFetchCloudPairingInfo('cloud', true, 'pc-12345')).toBe(false);
  });
});
