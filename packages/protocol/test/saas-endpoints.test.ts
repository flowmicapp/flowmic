// The relay-endpoint SSOT: the canonical address and the retired ones.
//
// These assertions guard the two properties the desktop's one-time endpoint
// migration LEANS ON but cannot check for itself (it receives the list already
// built): that the list never contains the canonical value, and that every entry
// is already in the normal form the comparison uses. A `.trim()`-able or
// trailing-slash entry would still work — both sides are normalised — but it
// would make the list read as if the shape mattered, and the next person adding
// a domain would copy the sloppy one.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SAAS_ENDPOINT, LEGACY_SAAS_ENDPOINTS } from '../src/constants';

/** The exact normalisation cloud_endpoint.rs applies to BOTH sides. */
function normalise(v: string): string {
  return v.trim().replace(/\/+$/, '').toLowerCase();
}

describe('SaaS endpoint SSOT', () => {
  it('names the canonical relay', () => {
    expect(DEFAULT_SAAS_ENDPOINT).toBe('https://flowmic.app');
  });

  // ⚠️ THESE TWO ASSERTIONS ARE ABOUT OUR HOSTED BUILD, NOT ABOUT THE SOFTWARE.
  // The list is deployment data (see the declaration): a build that is not our
  // hosted service has retired nothing, so an empty list is correct there and
  // the open-source export strips both this and the non-emptiness check below.
  // Everything else in this file states an invariant that must hold in EVERY
  // build, and none of it is stripped.

  // 🔴 The idempotency guard, in the one place it can be stated as a rule rather
  // than as behaviour. The Rust side also refuses to act when the stored value
  // already equals the canonical one, so a bad entry here could not actually loop
  // — but that is a second line of defence, and this is the first.
  it('never contains the canonical endpoint (a self-migrating entry would never converge)', () => {
    const canonical = normalise(DEFAULT_SAAS_ENDPOINT);
    for (const legacy of LEGACY_SAAS_ENDPOINTS) {
      expect(normalise(legacy)).not.toBe(canonical);
    }
  });

  it('holds entries already in normal form (trimmed, no trailing slash, lowercase)', () => {
    for (const legacy of LEGACY_SAAS_ENDPOINTS) {
      expect(legacy).toBe(normalise(legacy));
    }
  });

  it('holds absolute http(s) URLs — a bare host would match nothing', () => {
    for (const legacy of LEGACY_SAAS_ENDPOINTS) {
      expect(legacy).toMatch(/^https?:\/\/[^/]+$/);
    }
  });

});
