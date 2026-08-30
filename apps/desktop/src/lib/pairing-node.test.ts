// owner 2026-08-30 — the relay node reaches the device page's cloud card.
//
// 🔴 WHY THIS FILE EXISTS AT ALL, and it is not a formality. `asPairingInfo` is
// a HAND-WRITTEN NARROWING, and this repo has been burned by that shape three
// times in a row: `lan_candidates` (a `c is string` predicate that tested
// `typeof c === 'object'`, so the array was empty on every machine ever),
// `lan_endpoint` / `expires_in_ms` / `machine_uid` (three fields Rust had been
// sending for versions, dropped because they were missing from the literal),
// and `lan_tls_fp`. Every one of them failed the same way: the whole chain
// upstream was correct, nothing threw, and the value simply never arrived.
//
// A wired chain with a hole in this literal fails EXACTLY like an unwired one.
// So the node gets its own case, feeding the narrowing what Rust actually
// sends.

import { describe, expect, it } from 'vitest';
import { asPairingInfo } from './pairing-info';

describe('the relay node survives the narrowing (owner 2026-08-30)', () => {
  it('carries a node id through', () => {
    const info = asPairingInfo({
      short_code: '1234',
      endpoint: 'https://srvjp.flowmic.app',
      pc_name: 'dev-pc-a',
      connected: true,
      mobiles: 1,
      channel: 'cloud',
      node: 'srvjp',
    });
    expect(info.node).toBe('srvjp');
  });

  it('🔴 leaves it ABSENT rather than defaulting it', () => {
    // A LAN snapshot and a single-node deployment both send nothing here, and
    // the card's rule is「draw nothing」. A default — even an empty string —
    // would make the card ask 「is this falsy?」 about a value that has three
    // meanings, which is the one-value-two-questions shape this repo pays for
    // on a schedule.
    const lan = asPairingInfo({
      short_code: '1234',
      endpoint: 'https://192.168.1.5:41879',
      pc_name: 'dev-pc-a',
      connected: true,
      mobiles: 0,
      channel: 'lan',
    });
    expect('node' in lan).toBe(false);
  });

  it('drops a value that is not a non-empty string', () => {
    for (const bad of [42, '', null, {}, ['srvjp']]) {
      const info = asPairingInfo({
        short_code: null,
        endpoint: '',
        pc_name: '',
        connected: false,
        mobiles: 0,
        node: bad,
      });
      expect('node' in info).toBe(false);
    }
  });
});
