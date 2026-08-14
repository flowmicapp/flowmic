// GA-21 — the LAN endpoint pick. owner's tablet could reach 100.64.7.78, but
// every QR and announced endpoint pointed at 10.0.0.78 because the server's
// heuristic ranks RFC1918 first: LAN pairing was broken out of the box, with a
// manual endpoint entry as the only way through.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  applySelectedHost,
  hostOf,
  LAN_HOST_KEY,
  loadSelectedHost,
  resolveSelected,
  saveSelectedHost,
  type LanCandidate,
} from './lan-endpoint';

const cand = (address: string, nonStandardPrivate = false): LanCandidate => ({
  address,
  nonStandardPrivate,
});

describe('applySelectedHost', () => {
  it('swaps the host and keeps scheme + port', () => {
    expect(applySelectedHost('http://10.0.0.78:41879', '100.64.7.78')).toBe(
      'http://100.64.7.78:41879',
    );
  });

  it('is a no-op without a selection, or when it already matches', () => {
    expect(applySelectedHost('http://10.0.0.78:41879', null)).toBe(
      'http://10.0.0.78:41879',
    );
    expect(applySelectedHost('http://100.64.7.78:41879', '100.64.7.78')).toBe(
      'http://100.64.7.78:41879',
    );
  });

  it('leaves an unparseable or empty endpoint alone rather than inventing one', () => {
    // A picker that silently produced a malformed URL would be worse than none:
    // the QR would encode something no phone can dial.
    expect(applySelectedHost('', '100.64.7.78')).toBe('');
    expect(applySelectedHost('   ', '100.64.7.78')).toBe('   ');
  });

  it('hostOf reads the host from bare and schemed endpoints', () => {
    expect(hostOf('http://10.0.0.5:41879')).toBe('10.0.0.5');
    expect(hostOf('10.0.0.5:41879')).toBe('10.0.0.5');
    expect(hostOf('')).toBe('');
  });
});

describe('resolveSelected', () => {
  const list = [cand('10.0.0.78'), cand('100.64.7.78', true)];

  it('honours a stored pick that still exists', () => {
    expect(resolveSelected(list, '100.64.7.78')).toBe('100.64.7.78');
  });

  it('falls back to the server default when nothing is stored', () => {
    expect(resolveSelected(list, null)).toBe('10.0.0.78');
  });

  it('drops a stored address that has since disappeared (cable out / VPN down)', () => {
    // Advertising an address the host no longer has would tell the phone to dial
    // nothing at all — worse than the heuristic's guess.
    expect(resolveSelected(list, '10.9.9.9')).toBe('10.0.0.78');
  });

  it('returns null when the host has no candidates yet', () => {
    expect(resolveSelected([], '100.64.7.78')).toBeNull();
  });
});

// The desktop's vitest env is `node` (these are pure-logic tests, no DOM), so
// localStorage has to be supplied. A real map-backed stub, not a no-op: without
// it load/save would fall into their own try/catch and the test would "pass"
// while proving nothing.
function installLocalStorage(): void {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe('device-local persistence', () => {
  beforeEach(() => installLocalStorage());

  it('round-trips through localStorage under the documented key', () => {
    saveSelectedHost('100.64.7.78');
    expect(localStorage.getItem(LAN_HOST_KEY)).toBe('100.64.7.78');
    expect(loadSelectedHost()).toBe('100.64.7.78');
    saveSelectedHost(null);
    expect(loadSelectedHost()).toBeNull();
  });

  it('the key is device-local, not a synced settings key', () => {
    // Which cable THIS machine is reachable on is a property of this machine's
    // wiring; syncing it would push one PC's NIC choice onto another.
    expect(LAN_HOST_KEY.startsWith('flowmic.pairing.')).toBe(true);
  });
});
