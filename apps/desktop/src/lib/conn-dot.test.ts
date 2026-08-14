import { describe, expect, it } from 'vitest';
import { EMPTY_CLOUD_STATUS, type CloudStatus } from './channel';
import { connLoudReason, deriveConnDot, type ConnDotInput } from './conn-dot';
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
