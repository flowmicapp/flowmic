// N5 (owner 需求②) — the IPC-boundary half of「弹窗里切通道」.
//
// The pure decision core lives in pairing.test.ts. This file asserts the thing no
// pure test can: that the CHANNEL the modal picked actually reaches the two Tauri
// commands as an argument, in BOTH directions. The reverse assertion is the point —
// a bridge that dropped the argument (or hard-coded one channel) would satisfy a
// single 「cloud arrives as cloud」 check whenever cloud happened to be the default.
//
// `bridge.ts` gates every invoke on `__TAURI_INTERNALS__` being present on `window`
// (so a plain `vite dev` browser degrades instead of throwing), which is why the
// stub below installs both the flag and a mocked `invoke`.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) }));
// Never touched here, but bridge.ts imports it at module load.
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

const hadWindow = 'window' in globalThis;
(globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };

afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

const { asPairingInfo, fetchPairingInfo, refreshPairingCode } = await import('./bridge');

/** The args of the single invoke made by the call under test. */
function lastArgs(): Record<string, unknown> {
  expect(invoke).toHaveBeenCalledTimes(1);
  return (invoke.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
});

describe('fetchPairingInfo carries the pairing channel (N5)', () => {
  it('asks for cloud, then asks for lan — two different channels, not one twice', async () => {
    invoke.mockResolvedValue({ short_code: '0007', endpoint: 'https://flowmic.app', channel: 'cloud' });
    await fetchPairingInfo('cloud');
    expect(invoke.mock.calls[0]?.[0]).toBe('pairing_code');
    expect(lastArgs()).toEqual({ channel: 'cloud' });

    invoke.mockReset();
    invoke.mockResolvedValue({ short_code: '1234', endpoint: 'http://192.168.1.5:41879', channel: 'lan' });
    await fetchPairingInfo('lan');
    expect(lastArgs()).toEqual({ channel: 'lan' });
  });

  it('omitting the channel sends no channel — the Rust side then uses the stored preference', async () => {
    // Regression protection (the card's 回归保护 ["regression protection"] item):
    // this is what every caller outside the modal does, and it must behave
    // exactly as it did before N5.
    await fetchPairingInfo();
    expect(lastArgs()).toEqual({ channel: undefined });
  });
});

describe('refreshPairingCode mints on the selected channel (N5)', () => {
  it('sends the channel through, both ways', async () => {
    invoke.mockResolvedValue('0007');
    await refreshPairingCode('cloud');
    expect(invoke.mock.calls[0]?.[0]).toBe('refresh_pairing_code');
    expect(lastArgs()).toEqual({ channel: 'cloud' });

    invoke.mockReset();
    invoke.mockResolvedValue('1234');
    await refreshPairingCode('lan');
    expect(lastArgs()).toEqual({ channel: 'lan' });
  });

  it('a refusal stays a refusal — null, never a fabricated code', async () => {
    // 「取码失败 → 响亮路径保持」("code fetch failure → the loud path stays"):
    // with_channel_socket returns None when that channel has no session, and
    // that must arrive as null so the modal shows 刷新失败 ("refresh failed").
    invoke.mockResolvedValue(null);
    expect(await refreshPairingCode('cloud')).toBeNull();
    invoke.mockReset();
    invoke.mockRejectedValue(new Error('ipc down'));
    expect(await refreshPairingCode('lan')).toBeNull();
  });

  it('omitting the channel keeps the pre-N5 call shape', async () => {
    invoke.mockResolvedValue('1234');
    await refreshPairingCode();
    expect(lastArgs()).toEqual({ channel: undefined });
  });
});

// owner 2026-07-30 ② —「局域网显示监听的 IP，多个要全部列出」("the LAN tab must show
// the listening IP, and list every one if there are several"). The addresses
// were being
// sent by Rust and thrown away by this narrowing: the filter asserted `c is string`
// while testing `typeof c === 'object'`, so every candidate failed it. A type predicate
// is an assertion the compiler does not verify, which is why these tests are on the
// VALUES rather than on the types.
describe('asPairingInfo keeps the fields the shell actually sends', () => {
  it('every LAN candidate survives — not one, not none', () => {
    const info = asPairingInfo({
      endpoint: 'http://192.168.1.5:41879',
      lan_candidates: ['192.168.1.5', '10.8.0.2', '172.20.1.7'],
    });
    expect(info.lan_candidates).toEqual(['192.168.1.5', '10.8.0.2', '172.20.1.7']);
  });

  it('junk inside the array is dropped, the rest is kept', () => {
    const info = asPairingInfo({ lan_candidates: ['192.168.1.5', '', null, 42, { address: 'x' }] });
    expect(info.lan_candidates).toEqual(['192.168.1.5']);
  });

  it('a missing list stays ABSENT rather than becoming an empty one', () => {
    // 「还没解析出来」("not yet resolved") and 「这台机器没有局域网地址」("this machine
    // has no LAN address") are different facts; the card only draws the section
    // when there is something to draw.
    expect(asPairingInfo({}).lan_candidates).toBeUndefined();
    expect(asPairingInfo({ lan_candidates: 'nope' }).lan_candidates).toBeUndefined();
  });

  it('lan_endpoint / expires_in_ms / machine_uid pass through (they were dropped)', () => {
    // Three more façades in the same function: the LAN card's own address (v0.2.4), the
    // GA-18 code TTL the modal counts down from, and the machine id the diagnostics row
    // prints. All three were absent from the returned literal, so their production
    // readers could only ever see `undefined`.
    const info = asPairingInfo({
      lan_endpoint: 'http://192.168.1.5:41879',
      expires_in_ms: 240_000,
      machine_uid: '4638-2393-00fe',
    });
    expect(info.lan_endpoint).toBe('http://192.168.1.5:41879');
    expect(info.expires_in_ms).toBe(240_000);
    expect(info.machine_uid).toBe('4638-2393-00fe');
  });

  it('…but a garbage value for any of them is still refused', () => {
    const info = asPairingInfo({ lan_endpoint: 7, expires_in_ms: 'soon', machine_uid: '' });
    expect(info.lan_endpoint).toBeUndefined();
    expect(info.expires_in_ms).toBeUndefined();
    expect(info.machine_uid).toBeUndefined();
  });
});

describe('asPairingInfo narrows the snapshot channel (N5)', () => {
  it('keeps the two known tags', () => {
    expect(asPairingInfo({ channel: 'lan' }).channel).toBe('lan');
    expect(asPairingInfo({ channel: 'cloud' }).channel).toBe('cloud');
  });

  it('leaves it ABSENT for anything else — never a defaulted "lan"', () => {
    // A defaulted tag would let the cross-channel gate compare against a value the
    // shell never sent, i.e. it would happily render a cloud snapshot as LAN.
    expect(asPairingInfo({}).channel).toBeUndefined();
    expect(asPairingInfo({ channel: 'saas' }).channel).toBeUndefined();
    expect(asPairingInfo({ channel: 42 }).channel).toBeUndefined();
    expect(asPairingInfo(null).channel).toBeUndefined();
  });
});
