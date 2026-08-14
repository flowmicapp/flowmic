// 0.2.66 — the PCID's LAST hop: a Tauri `pairing_code` snapshot → the modal's view
// and the cloud QR payload.
//
// 🔴 WHY THE INPUT HERE IS A RAW OBJECT AND NOT A `PairingInfo`. `asPairingInfo`
// (lib/bridge.ts) rebuilds the snapshot FIELD BY FIELD, and a field missing from
// that literal is a field the caller can never see. It has now happened SIX times
// in that one function — `lan_candidates`' hand-written type predicate (which
// asserted `c is string` while testing `typeof c === 'object'`, so the GA-21
// multi-NIC picker never once had a candidate to show), then `lan_endpoint` /
// `expires_in_ms` / `machine_uid`, then `lan_tls_fp`. Every one of them failed
// EXACTLY like an unwired chain: no value, no error, all tests green. So the
// fixture below is keyed with serde's field names — the narrowing is INSIDE the
// tested path, not around it — and the assertions are on VALUES, never on types.
// 「它编译过」("it compiled") proves nothing about any of this.
//
// Companion files: `pairing-fingerprint-wire.test.ts` does the same for `fp=`
// (the card this one is modelled on), `qr-roundtrip.test.ts` proves the resulting
// picture is still scannable.

import { describe, expect, it } from 'vitest';
import { asPairingInfo } from './bridge';
import { buildQrPayload, derivePairingModal, formatPcid } from './pairing';

const PCID = '302914775';

/** VERBATIM the regex in server-core `room/registry.ts`, symbol `resolvePcForPair`
 *  — the one that reads the pairing code out of a scanned payload, FIRST match. */
const SERVER_CODE_RE = /code=(\d{4})/;

/** What `pairing_code` serializes (Rust `shell/connection.rs`, struct `PairingInfo`).
 *  Cloud-shaped: on the relay the Rust side sends no `lan_candidates` and no
 *  `lan_tls_fp` (it blanks both there), which is why they are absent here. */
function cloudSnapshot(overrides: Record<string, unknown> = {}): unknown {
  return {
    short_code: '4821',
    endpoint: 'https://flowmic.app',
    pc_name: 'dev-pc-a',
    connected: true,
    mobiles: 0,
    expires_in_ms: 300000,
    machine_uid: 'dev-pc-a::abc123',
    channel: 'cloud',
    pcid: PCID,
    ...overrides,
  };
}

describe('a PCID the relay minted reaches the screen and the QR', () => {
  it('🔴 survives asPairingInfo — the narrowing that has eaten five fields already', () => {
    expect(asPairingInfo(cloudSnapshot()).pcid).toBe(PCID);
  });

  it('🔴 end to end: Rust snapshot in, `pcid=` on the cloud payload out', () => {
    const view = derivePairingModal(asPairingInfo(cloudSnapshot()), 'saas');
    expect(view.qrPayload).toBe(
      `flowmic://pair?endpoint=wss://flowmic.app&code=4821&channel=saas&pcid=${PCID}`,
    );
  });

  it('🔴 the modal carries the RAW nine digits — that is what the copy button writes', () => {
    // The grouped form is produced at RENDER time by `formatPcid`. If the view ever
    // carried the spaced string instead, the copy button would put spaces on the
    // clipboard and the phone's digits-only field would eat or refuse them — a copy
    // button that hands over a value the target cannot accept.
    const view = derivePairingModal(asPairingInfo(cloudSnapshot()), 'saas');
    expect(view.pcid).toBe(PCID);
    expect(view.pcid).not.toContain(' ');
    expect(formatPcid(view.pcid!)).toBe('302 914 775');
  });

  it('keeps `pcid=` LAST — the server takes the FIRST /code=(\\d{4})/ match', () => {
    // Structural, not statistical: the payload grammar is append-only behind
    // `code=` (04 §3.1), and a nine-digit run is exactly the kind of value that
    // would be misread as a code if it were ever allowed in front of it. `4775` is
    // a four-digit run living INSIDE this pcid on purpose — if the ordering ever
    // inverted, this is the assertion that notices.
    const payload = derivePairingModal(asPairingInfo(cloudSnapshot()), 'saas').qrPayload ?? '';
    expect(payload.endsWith(`&pcid=${PCID}`)).toBe(true);
    expect(payload.indexOf('&pcid=')).toBeGreaterThan(payload.indexOf('&code='));
    expect(SERVER_CODE_RE.exec(payload)?.[1]).toBe('4821');
  });

  it('sits behind `fp=` too, on the hypothetical payload that carries both', () => {
    // Production never emits both (fp is LAN-only, pcid is relay-only), so this
    // asserts the BUILDER's ordering rather than a state a user can reach. It is
    // here because the rule is 「every key added from here on goes behind the last
    // one」 — a rule that only holds for the pairs someone happened to try is not
    // a rule, and the next key will be appended by reading this function.
    const payload = buildQrPayload({
      endpoint: 'https://flowmic.app',
      code: '4821',
      channel: 'saas',
      candidates: ['10.0.0.2'],
      fingerprint: 'oTA0pWG9421vmsxFi1ZoR4gs',
      pcid: PCID,
    });
    expect(payload.indexOf('&pcid=')).toBeGreaterThan(payload.indexOf('&fp='));
    expect(payload.indexOf('&fp=')).toBeGreaterThan(payload.indexOf('&alt='));
    expect(SERVER_CODE_RE.exec(payload)?.[1]).toBe('4821');
  });

  it('the PCID outlives the code — it is still shown when there is none', () => {
    // Two lifetimes, one row each: the code is a 5-minute secret and the PCID is
    // row-stable (design §4). A view that dropped the PCID on the `no-code` branch
    // would blank this PC's identity every time its code aged out, which is the
    // state the modal is MOST likely to open in.
    const view = derivePairingModal(asPairingInfo(cloudSnapshot({ short_code: null })), 'saas');
    expect(view.reason).toBe('no-code');
    expect(view.code).toBeNull();
    expect(view.pcid).toBe(PCID);
  });
});

describe('every way the PCID can be absent ⇒ today`s exact cloud payload', () => {
  const PRE_0266 = 'flowmic://pair?endpoint=wss://flowmic.app&code=4821&channel=saas';

  it.each([
    // A relay older than this round: the key is simply not in the ack, so the Rust
    // snapshot has nothing to put here.
    ['an older relay (key absent)', { pcid: undefined }],
    ['a serialized None (null)', { pcid: null }],
    // Defensive: neither of these can address a PC, so neither may ride the QR.
    ['a non-string value', { pcid: 302914775 }],
    ['an empty string', { pcid: '' }],
  ])('%s ⇒ byte-identical to the pre-0.2.66 QR', (_name, override) => {
    const info = asPairingInfo(cloudSnapshot(override));
    expect(derivePairingModal(info, 'saas').qrPayload).toBe(PRE_0266);
    expect(derivePairingModal(info, 'saas').pcid).toBeNull();
  });

  it('🔴 the positive control: the SAME snapshot WITH a pcid differs', () => {
    // Without this, every assertion above would also pass against an implementation
    // that dropped the PCID unconditionally — i.e. against the feature not existing.
    expect(derivePairingModal(asPairingInfo(cloudSnapshot()), 'saas').qrPayload).not.toBe(PRE_0266);
  });
});

describe('🔴 LAN has no PCID, ever (owner 2026-08-14)', () => {
  const LAN_SNAPSHOT = {
    short_code: '4821',
    endpoint: 'http://192.168.1.20:41879',
    pc_name: 'PC',
    connected: true,
    mobiles: 0,
    channel: 'lan',
  };

  it('a LAN snapshot that (wrongly) carries one is refused at this gate too', () => {
    // Rust already blanks it (`shell/connection.rs`, symbol `pcid_for_channel`), so
    // this asserts the SECOND gate — the same two-gate shape `lan_tls_fp` has in the
    // opposite direction, and for the same reason: the Rust snapshot is a public
    // command result, and only this layer knows which tab is on screen.
    const view = derivePairingModal(asPairingInfo({ ...LAN_SNAPSHOT, pcid: PCID }), 'standalone');
    expect(view.pcid).toBeNull();
    expect(view.qrPayload).not.toContain('pcid=');
    expect(view.qrPayload).toBe(
      'flowmic://pair?endpoint=ws://192.168.1.20:41879&code=4821&channel=standalone',
    );
  });

  it('…and the positive control on the very same input: as `saas`, it is kept', () => {
    // The LAN assertion above would pass just as happily against a gate that dropped
    // the PCID on BOTH channels. This is the arm that says the gate is a gate.
    const info = asPairingInfo({ ...LAN_SNAPSHOT, channel: 'cloud', pcid: PCID });
    expect(derivePairingModal(info, 'saas').pcid).toBe(PCID);
  });

  it('a snapshot describing the OTHER channel draws nothing at all (N5)', () => {
    // The cross-channel gate runs first, so mid-switch there is no frame in which
    // one channel's PCID is painted under the other channel's tab.
    const view = derivePairingModal(asPairingInfo(cloudSnapshot()), 'standalone');
    expect(view.reason).toBe('pending');
    expect(view.pcid).toBeNull();
  });
});

describe('formatPcid groups for the eye and refuses to dress up a non-PCID', () => {
  it('nine digits become XXX XXX XXX', () => {
    expect(formatPcid('302914775')).toBe('302 914 775');
    expect(formatPcid('000000001')).toBe('000 000 001');
  });

  it('anything else comes back VERBATIM, not chopped into threes', () => {
    // Inventing a grouping for a value that is not a PCID would make a wrong value
    // look like a right one. These cannot reach the UI (the wire parser refuses
    // them — `socket/wire.rs`, symbol `parse_pcid`); this is the boundary, not an
    // expectation.
    for (const bad of ['', '3029147', '30291477a', '302 914 775', '3029147750']) {
      expect(formatPcid(bad)).toBe(bad);
    }
  });
});
