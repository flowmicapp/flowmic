import { describe, expect, it } from 'vitest';
import { EMPTY_CLOUD_STATUS, type CloudStatus } from './channel';
import { connLoudReason, deriveConnDot, deriveFooterConnDot, type ConnDotInput } from './conn-dot';
import { S } from './strings';

const base = (over: Partial<ConnDotInput> = {}): ConnDotInput => ({
  connected: false,
  registered: false,
  channel: 'lan',
  sidecarPhase: null,
  cloud: { ...EMPTY_CLOUD_STATUS },
  ...over,
});

const cloud = (over: Partial<CloudStatus> = {}): CloudStatus => ({
  ...EMPTY_CLOUD_STATUS,
  ...over,
});

describe('deriveConnDot', () => {
  it('g: connected && registered', () => {
    const v = deriveConnDot(base({ connected: true, registered: true, sidecarPhase: 'healthy' }));
    expect(v).toEqual({ dot: 'g', label: S.conn_online, detail: null });
  });

  it('y: connected but not yet registered (must NOT paint green)', () => {
    const v = deriveConnDot(base({ connected: true, registered: false, sidecarPhase: 'healthy' }));
    expect(v.dot).toBe('y');
    expect(v.label).toBe(S.conn_reconnecting);
    expect(v.detail).toBeNull();
  });

  it('y: registered but disconnected = reconnect in flight', () => {
    const v = deriveConnDot(base({ connected: false, registered: true }));
    expect(v).toEqual({ dot: 'y', label: S.conn_reconnecting, detail: null });
  });

  it('o: never connected, no loud fault', () => {
    const v = deriveConnDot(base());
    expect(v).toEqual({ dot: 'o', label: S.conn_offline, detail: null });
  });

  it('r: LAN sidecar failed carries loud detail', () => {
    const v = deriveConnDot(base({ channel: 'lan', sidecarPhase: 'failed' }));
    expect(v.dot).toBe('r');
    expect(v.label).toBe(S.conn_fault);
    expect(v.detail).toBe(S.dev_chan_lan_failed);
  });

  it('r: cloud loud reason (expired key) carries detail', () => {
    const v = deriveConnDot(
      base({
        channel: 'cloud',
        cloud: cloud({ readiness: 'key_expired', key_set: true }),
      }),
    );
    expect(v.dot).toBe('r');
    expect(v.detail).toBe(S.cloud_err_expired);
  });

  it('regression: connected && !registered must never be green', () => {
    const v = deriveConnDot(base({ connected: true, registered: false }));
    expect(v.dot).not.toBe('g');
  });

  it('loud on inactive cloud channel does not paint red while on LAN', () => {
    // Active channel is LAN and healthy — a stale cloud refusal must not
    // bleed into the global connection dot.
    const staleCloud = cloud({
      readiness: 'rejected',
      auth_error: 'AUTH_TOKEN_EXPIRED',
      key_set: true,
    });
    const v = deriveConnDot(
      base({
        channel: 'lan',
        connected: true,
        registered: true,
        sidecarPhase: 'healthy',
        cloud: staleCloud,
      }),
    );
    expect(v.dot).toBe('g');
    expect(connLoudReason({ channel: 'lan', sidecarPhase: 'healthy', cloud: staleCloud })).toBeNull();
  });
});

// Footer aggregate (owner 2026-08-21 evening): the sidebar card judges BOTH
// channels. Green = everything healthy; yellow = the standby channel is loudly
// faulted while the session leg is fine (the fault is NAMED); red = every
// channel loudly faulted. deriveConnDot keeps its active-channel semantics for
// every other surface — the test right above this block ("loud on inactive
// cloud channel does not paint red while on LAN") pins that split.
describe('deriveFooterConnDot', () => {
  const staleCloud = cloud({ readiness: 'rejected', auth_error: 'AUTH_TOKEN_EXPIRED', key_set: true });

  it('g: session up and BOTH channels healthy', () => {
    const v = deriveFooterConnDot(
      base({ connected: true, registered: true, sidecarPhase: 'healthy' }),
    );
    expect(v).toEqual({ dot: 'g', label: S.conn_online, detail: null });
  });

  it('y: session green on LAN but the standby cloud channel is loudly faulted', () => {
    const v = deriveFooterConnDot(
      base({ channel: 'lan', connected: true, registered: true, sidecarPhase: 'healthy', cloud: staleCloud }),
    );
    expect(v.dot).toBe('y');
    expect(v.label).toBe(S.conn_online);
    expect(v.detail).toBe(S.cloud_err_expired);
  });

  it('y: session green on cloud but the LAN sidecar failed', () => {
    const v = deriveFooterConnDot(
      base({ channel: 'cloud', connected: true, registered: true, sidecarPhase: 'failed' }),
    );
    expect(v.dot).toBe('y');
    expect(v.detail).toBe(S.dev_chan_lan_failed);
  });

  it('r: BOTH channels loudly faulted, both reasons named', () => {
    const v = deriveFooterConnDot(
      base({ channel: 'lan', sidecarPhase: 'failed', cloud: staleCloud }),
    );
    expect(v.dot).toBe('r');
    expect(v.label).toBe(S.conn_fault);
    expect(v.detail).toContain(S.dev_chan_lan_failed);
    expect(v.detail).toContain(S.cloud_err_expired);
  });

  it('r: an ACTIVE-channel fault alone stays red — the leg carrying the session being down is not "partial"', () => {
    const v = deriveFooterConnDot(base({ channel: 'lan', sidecarPhase: 'failed' }));
    expect(v.dot).toBe('r');
    expect(v.detail).toBe(S.dev_chan_lan_failed);
  });

  it('y-base (reconnecting) with a standby fault keeps the state and carries the reason', () => {
    const v = deriveFooterConnDot(
      base({ channel: 'lan', connected: false, registered: true, sidecarPhase: 'healthy', cloud: staleCloud }),
    );
    expect(v.dot).toBe('y');
    expect(v.label).toBe(S.conn_reconnecting);
    expect(v.detail).toBe(S.cloud_err_expired);
  });
});

describe('connLoudReason', () => {
  it('returns null when LAN sidecar is not failed', () => {
    expect(connLoudReason({ channel: 'lan', sidecarPhase: 'healthy', cloud: EMPTY_CLOUD_STATUS })).toBeNull();
  });

  it('returns cloudLoudReason on the cloud channel', () => {
    expect(
      connLoudReason({
        channel: 'cloud',
        sidecarPhase: null,
        cloud: cloud({ readiness: 'rejected', auth_error: 'KEY_MALFORMED' }),
      }),
    ).toBe(S.cloud_err_malformed);
  });
});
