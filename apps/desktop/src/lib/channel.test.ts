import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SAAS_ENDPOINT, ERROR_CODES, LEGACY_SAAS_ENDPOINTS } from '@flowmic/protocol';
import {
  asCloudStatus,
  CHANNEL_LABEL,
  CHANNEL_VISUAL,
  cloudEndpointSsot,
  cloudLoudReason,
  DEFAULT_CLOUD_ENDPOINT,
  LEGACY_CLOUD_ENDPOINTS,
  deriveCloudCard,
  deriveLanCard,
  EMPTY_CLOUD_STATUS,
  formatExpiry,
  isJwtShaped,
  planBadge,
  type CloudStatus,
} from './channel';
import { S, setLocale } from './strings';
import { CLOUD_STRINGS } from './strings/cloud';

const cloud = (over: Partial<CloudStatus> = {}): CloudStatus => ({ ...EMPTY_CLOUD_STATUS, ...over });

beforeEach(() => {
  setLocale('zh-CN');
});

describe('channel labels', () => {
  it('uses exactly the two mandated terms', () => {
    expect(CHANNEL_LABEL.lan).toBe('本地局域网');
    expect(CHANNEL_LABEL.cloud).toBe('云端中继');
  });

  it('takes the default relay endpoint from the protocol SSOT, not a literal', () => {
    expect(DEFAULT_CLOUD_ENDPOINT).toBe(DEFAULT_SAAS_ENDPOINT);
  });

  it('takes the RETIRED relay endpoints from the same SSOT', () => {
    expect(LEGACY_CLOUD_ENDPOINTS).toEqual(LEGACY_SAAS_ENDPOINTS);
  });
});

// ── C7: the endpoint SSOT crossing the Tauri boundary ────────────────────────
//
// The desktop's stored `CloudConfig.endpoint` is migrated off a retired address
// by Rust, using literals that must NOT live in that crate. This is the packing
// half; the decision half is src-tauri/src/socket/cloud_endpoint.rs.
describe('cloudEndpointSsot — what the cloud_status read carries inward', () => {
  it('carries the canonical value and the retired list, under the arg names Rust takes', () => {
    // Single-word keys on purpose (bridge.ts header: "single-word args to avoid
    // any camelCase↔snake_case ambiguity across the boundary"). Renaming either
    // one here without renaming the Rust parameter makes the command reject the
    // call at runtime, where only a console warning would show it.
    expect(cloudEndpointSsot()).toEqual({
      canonical: DEFAULT_SAAS_ENDPOINT,
      legacy: [...LEGACY_SAAS_ENDPOINTS],
    });
  });

  it('hands over a plain mutable array (the readonly SSOT itself must not travel)', () => {
    const sent = cloudEndpointSsot().legacy;
    expect(Array.isArray(sent)).toBe(true);
    expect(sent).not.toBe(LEGACY_SAAS_ENDPOINTS);
  });
});

// ── owner 2026-08-01: colour + icon combination, cannot rely on colour alone; define once, unify across the whole product (颜色+图标组合，不能只靠颜色；一处定义，全产品统一) ──────────────
describe('CHANNEL_VISUAL — icon + colour, one definition', () => {
  it('the two icons are REAL different shapes, not one glyph recoloured', () => {
    expect(CHANNEL_VISUAL.lan.iconPath).not.toBe(CHANNEL_VISUAL.cloud.iconPath);
    expect(CHANNEL_VISUAL.lan.iconPath.length).toBeGreaterThan(0);
    expect(CHANNEL_VISUAL.cloud.iconPath.length).toBeGreaterThan(0);
    // Different SVG primitive VOCABULARY (arcs+dot vs a single blob path), not just
    // different path data for the same primitive — a cheap silhouette-diversity check.
    expect((CHANNEL_VISUAL.lan.iconPath.match(/<path/g) ?? []).length).toBeGreaterThan(1);
    expect((CHANNEL_VISUAL.lan.iconPath.match(/<circle/g) ?? []).length).toBe(1);
    expect((CHANNEL_VISUAL.cloud.iconPath.match(/<path/g) ?? []).length).toBe(1);
    expect(CHANNEL_VISUAL.cloud.iconPath).not.toContain('<circle');
  });

  it('css class matches the channel key (selects .chan-badge.lan / .chan-badge.cloud)', () => {
    expect(CHANNEL_VISUAL.lan.css).toBe('lan');
    expect(CHANNEL_VISUAL.cloud.css).toBe('cloud');
  });

  it('carries ZERO colour hex — the one definition is tokens.css, not a second copy here', () => {
    // A crude but real drift guard: if a future edit pastes a literal hex into this
    // file (e.g. "for convenience"), that IS the exact duplication "define once" (一处定义) forbids.
    const values = Object.values(CHANNEL_VISUAL).flatMap((v) => [v.css, v.iconPath]);
    for (const v of values) expect(v).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  // 🔴 Reverse control (反向对照) (window C-4, manually verified at delivery
  // time, not kept as a permanent assertion): change tokens.css's
  // --channel-lan-ink from #0f766e to another value without changing this test → the case below goes red.
  // See the delivery report's "reverse control" section for the original red text.
  it('tokens.css defines the exact four hex literals this token pair promises — the SAME hex apps/mobile/lib/src/ui/tokens.dart FlowMicChannelColors carries (see that file header for the side-by-side table)', () => {
    const cssPath = fileURLToPath(new URL('../styles/tokens.css', import.meta.url));
    const css = readFileSync(cssPath, 'utf-8');
    // light
    expect(css).toContain('--channel-lan-ink: #0f766e');
    expect(css).toContain('--channel-lan-soft: #e6faf7');
    expect(css).toContain('--channel-cloud-ink: #4f46e5');
    expect(css).toContain('--channel-cloud-soft: #eef0fe');
    // dark
    expect(css).toContain('--channel-lan-ink: #2dd4bf');
    expect(css).toContain('--channel-lan-soft: #12302c');
    expect(css).toContain('--channel-cloud-ink: #818cf8');
    expect(css).toContain('--channel-cloud-soft: #262a4e');
  });

  it('tokens.css has exactly ONE .chan-badge.lan / .chan-badge.cloud definition (one place, not per-page)', () => {
    const cssPath = fileURLToPath(new URL('../styles/tokens.css', import.meta.url));
    const css = readFileSync(cssPath, 'utf-8');
    expect(css.match(/\.chan-badge\.lan\s*\{/g) ?? []).toHaveLength(1);
    expect(css.match(/\.chan-badge\.cloud\s*\{/g) ?? []).toHaveLength(1);
  });
});

describe('isJwtShaped', () => {
  it('accepts a three-segment base64url token', () => {
    expect(isJwtShaped('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2ln')).toBe(true);
    expect(isJwtShaped('  eyJh.eyJz.c2ln  ')).toBe(true); // trimmed
  });

  it('rejects the mispastes that actually happen', () => {
    expect(isJwtShaped('')).toBe(false);
    expect(isJwtShaped('hunter2')).toBe(false);
    expect(isJwtShaped('https://flowmic.app/console')).toBe(false);
    expect(isJwtShaped('eyJh..c2ln')).toBe(false);
    expect(isJwtShaped('eyJh.eyJz')).toBe(false);
    expect(isJwtShaped('eyJh.ey Jz.c2ln')).toBe(false);
  });
});

describe('asCloudStatus', () => {
  it('degrades unknown payloads to the logged-out default instead of a half object', () => {
    expect(asCloudStatus(null)).toEqual(EMPTY_CLOUD_STATUS);
    expect(asCloudStatus('nope')).toEqual(EMPTY_CLOUD_STATUS);
    expect(asCloudStatus({ readiness: 'weird' }).readiness).toBe('no_key');
  });

  it('RV-新B: never carries a `channel`, whatever the shell sends', () => {
    // THE REVERSE ASSERTION for the deleted field. This status answers "can this
    // cloud key be used" only; "which channel is current" comes from the CONNECTION frame
    // (store.currentChannel / capsule state.channel). An older shell still sends the
    // key, and it must not be resurrected here — a value nothing can move would go
    // straight back to being read as live state.
    expect(Object.keys(asCloudStatus({ channel: 'cloud' }))).not.toContain('channel');
    expect(Object.keys(EMPTY_CLOUD_STATUS)).not.toContain('channel');
  });

  it('reads a real DTO verbatim', () => {
    const dto = {
      endpoint: 'https://relay.example',
      key_set: true,
      key_head: 'eyJhbG',
      plan: 'pro',
      subject: 'user-42',
      expires_at: 1893456000,
      readiness: 'ready',
      auth_error: null,
    };
    expect(asCloudStatus(dto)).toEqual({ ...dto, readiness: 'ready' });
  });

  it('never carries a key field even if the shell somehow sent one', () => {
    const parsed = asCloudStatus({ key_set: true, jwt: 'eyJh.eyJz.sig' });
    expect(Object.keys(parsed)).not.toContain('jwt');
    expect(JSON.stringify(parsed)).not.toContain('eyJh.eyJz.sig');
  });
});

describe('deriveLanCard', () => {
  it('is green when the local server is healthy and this socket is up', () => {
    const up = deriveLanCard({ connected: true, sidecarPhase: 'healthy', loopback: false });
    expect(up.dot).toBe('g');
    expect(up.status).toBe(S.dev_chan_lan_ready);
  });

  it('GA-28: a suspended local server is grey — it is genuinely not running', () => {
    const suspended = deriveLanCard({ connected: false, sidecarPhase: 'suspended', loopback: false });
    expect(suspended.dot).toBe('o');
    expect(suspended.status).toBe(S.dev_chan_lan_suspended);
    expect(suspended.loud).toBeNull();
  });

  it('owner 2026-07-30 ②: the card has NO role half left — only its own health', () => {
    // Two rules died with the "primary channel" setting. The dot never described the role
    // (GA-28 already split that off), but the STATUS LINE did: a connected channel
    // that was not the selected one read "resident, standing by", i.e. it answered "did you select it"
    // under a heading that asks "is it connected or not". A card with no `active` input cannot
    // give two answers, which is the point — this object is the whole contract.
    const card = deriveLanCard({ connected: true, sidecarPhase: 'healthy', loopback: false });
    expect(Object.keys(card).sort()).toEqual(['dot', 'loud', 'status']);
    expect(card.status).toBe(S.dev_chan_lan_ready);
  });

  it('is loud when the local server failed', () => {
    const failed = deriveLanCard({ connected: false, sidecarPhase: 'failed', loopback: false });
    expect(failed.dot).toBe('r');
    expect(failed.loud).toBe(S.dev_chan_lan_failed);
  });

  it('shows the loopback caveat rather than a plain ready line', () => {
    const lo = deriveLanCard({ connected: true, sidecarPhase: 'healthy', loopback: true });
    expect(lo.status).toBe(S.dev_chan_lan_loopback);
  });
});

describe('deriveCloudCard', () => {
  it('is green when keyed and connected', () => {
    const c = deriveCloudCard({ status: cloud({ key_set: true, readiness: 'ready' }), connected: true });
    expect(c.dot).toBe('g');
    expect(c.status).toBe(S.dev_chan_cloud_ready);
    expect(c.loud).toBeNull();
  });

  it('is amber (not green) while the relay connection is still coming up', () => {
    const c = deriveCloudCard({ status: cloud({ key_set: true, readiness: 'ready' }), connected: false });
    expect(c.dot).toBe('y');
    expect(c.status).toBe(S.dev_chan_connecting);
  });

  it('GA-28 / owner ②: a live relay reads READY, and no channel field is consulted', () => {
    // Two layers of the same lesson. GA-28: both channels are resident, so drawing a
    // live relay socket grey would be a plain lie about a working link. owner ② /
    // RV-新B: the card cannot even ASK "did you select it" any more — the field that answered
    // it is gone, because reading it had frozen half the users on "resident, standing by" while the
    // relay was carrying their phone.
    const c = deriveCloudCard({ status: cloud({ key_set: true, readiness: 'ready' }), connected: true });
    expect(c.dot).toBe('g');
    expect(c.status).toBe(S.dev_chan_cloud_ready);
  });

  it('GA-28: …but a channel with no key is grey, because it really is not dialed', () => {
    const c = deriveCloudCard({ status: cloud({ key_set: false, readiness: 'no_key' }), connected: true });
    expect(c.dot).toBe('o');
    expect(c.loud).toBeNull();
  });

  it('fails LOUD on an expired key instead of a quiet "connecting"', () => {
    const c = deriveCloudCard({ status: cloud({ readiness: 'key_expired', key_set: true }), connected: false });
    expect(c.dot).toBe('r');
    expect(c.loud).toBe(S.cloud_err_expired);
  });

  it('fails LOUD on a server rejection, and says so even when the socket is up', () => {
    // The socket may well be connected — on the OTHER channel. The refused cloud
    // card must still shout, never render as a working channel.
    const c = deriveCloudCard({
      status: cloud({ readiness: 'rejected', auth_error: 'AUTH_TOKEN_EXPIRED' }),
      connected: true,
    });
    expect(c.dot).toBe('r');
    expect(c.loud).toBe(S.cloud_err_expired);
  });

  it('names the ACTUAL reason instead of blaming the login every time', () => {
    expect(cloudLoudReason(cloud({ readiness: 'rejected', auth_error: 'KEY_MALFORMED' }))).toBe(S.cloud_err_malformed);
    expect(cloudLoudReason(cloud({ readiness: 'rejected', auth_error: 'AUTH_TOKEN_INVALID' }))).toBe(S.cloud_err_expired);
    expect(cloudLoudReason(cloud({ readiness: 'rejected', auth_error: 'AUTH_TOKEN_EXPIRED' }))).toBe(S.cloud_err_expired);
    expect(cloudLoudReason(cloud({ readiness: 'rejected', auth_error: 'auth:expired' }))).toBe(S.cloud_err_expired);
    // A registry/payload refusal is NOT an expired login — the key is still there,
    // so telling the user to re-paste it would send them down a dead end.
    expect(cloudLoudReason(cloud({ readiness: 'rejected', auth_error: 'PAIR_INVALID_PAYLOAD' }))).toBe(S.cloud_err_refused);
    expect(cloudLoudReason(cloud({ readiness: 'rejected', auth_error: null }))).toBe(S.cloud_err_refused);
  });

  // ── M4-5: hitting the plan's PC-count limit — this PC must be able to read what's going on ──────────────────
  //
  // The positive control is written in the first case: first prove the
  // "generic string" probe is alive (other refusal codes really do still land
  // on it), otherwise the next case's "is not equal to the generic string"
  // might just mean the probe is blind.

  it('M4-5 positive control: other registration refusals still land on the generic string', () => {
    expect(cloudLoudReason(cloud({ readiness: 'rejected', auth_error: 'PAIR_RATE_LIMITED' }))).toBe(S.cloud_err_refused);
  });

  it('M4-5: when hitting the PC-count limit it says the quota limit, no longer "see the diagnostic log for details"', () => {
    const loud = cloudLoudReason(cloud({ readiness: 'rejected', auth_error: 'PCS_LIMIT_EXCEEDED' }));
    expect(loud).toBe(S.cloud_err_pc_limit);
    expect(loud).not.toBe(S.cloud_err_refused);
    // What's asserted is **the content the user reads**, not "swapped out for a
    // different key": this sentence must itself answer both "what happened"
    // and "what can I do" — missing either one turns it back into a useless sentence.
    expect(loud).toContain('上限');
    expect(loud).toContain('升级套餐');
    expect(loud).toContain('购买');
  });

  it('M4-5: this sentence really gets painted onto the cloud card (not just the pure function computing correctly)', () => {
    // The gap between "computed correctly" and "painted onto the screen" is a lesson this repo has paid for.
    const c = deriveCloudCard({
      status: cloud({ readiness: 'rejected', auth_error: 'PCS_LIMIT_EXCEEDED', key_set: true }),
      connected: true,
    });
    expect(c.dot).toBe('r');
    expect(c.loud).toBe(S.cloud_err_pc_limit);
  });

  it('M4-5: the branch recognizes the code itself from the protocol table, not a hand-copied string', () => {
    // If `PCS_LIMIT_EXCEEDED` disappears or gets renamed from the protocol table
    // ⇒ channel.ts's `ErrorCode` annotation fails to compile on the spot. This
    // test guards the other half: it **really is** in that table right now,
    // meaning this branch truly has a server-emittable code it corresponds to.
    expect(Object.keys(ERROR_CODES)).toContain('PCS_LIMIT_EXCEEDED');
  });

  it('M4-5: not a single number is allowed in the four-language copy —— the SSOT for the machine count lives on the server', () => {
    // 2/3/10 belong to `apps/server-core/src/billing/plans.ts`; the web billing
    // page is already a second copy, and if the desktop copies one more that's
    // a third — the day the tier changes it becomes a quiet lie. So here we set
    // up an invariant **that needs no memory**: any number appearing in this sentence counts as a violation.
    for (const [locale, table] of Object.entries(CLOUD_STRINGS)) {
      const line = (table as Record<string, string>).cloud_err_pc_limit;
      expect(line, `${locale} is missing cloud_err_pc_limit`).toBeTruthy();
      expect(line, `${locale} copied the machine count into the desktop copy`).not.toMatch(/\d/);
    }
  });

  it('is quiet (not loud) when simply not logged in yet', () => {
    const c = deriveCloudCard({ status: cloud({ readiness: 'no_key' }), connected: false });
    expect(c.loud).toBeNull();
    expect(c.status).toBe(S.dev_chan_cloud_no_key);
    // GA-28: grey, not amber. Amber means "connecting" — nothing is being dialed
    // without a key, and a spinner-coloured dot for a state that will never
    // progress on its own is the small end of the same façade problem.
    expect(c.dot).toBe('o');
  });

  it('only complains about a missing endpoint once a key exists', () => {
    expect(cloudLoudReason(cloud({ readiness: 'no_endpoint', key_set: false }))).toBeNull();
    expect(cloudLoudReason(cloud({ readiness: 'no_endpoint', key_set: true }))).toBe(S.cloud_err_no_endpoint);
  });
});

describe('plan + expiry rendering', () => {
  it('never invents a plan badge', () => {
    expect(planBadge(null)).toBeNull();
    expect(planBadge('   ')).toBeNull();
    expect(planBadge('pro')).toBe('PRO');
  });

  it('formats expiry locale-independently and rejects junk', () => {
    const at = new Date(2026, 7, 1, 9, 5, 0).getTime() / 1000;
    expect(formatExpiry(at)).toBe('2026-08-01 09:05');
    expect(formatExpiry(null)).toBeNull();
    expect(formatExpiry(0)).toBeNull();
    expect(formatExpiry(Number.NaN)).toBeNull();
  });
});
