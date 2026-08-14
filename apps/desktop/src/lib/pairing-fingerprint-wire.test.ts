// D2LAN-B2b — the LAST hop: a Tauri `pairing_code` snapshot → the QR payload.
//
// 🔴 WHY A SECOND FINGERPRINT TEST FILE EXISTS. `pairing-fingerprint.test.ts`
// (card D2LAN-B2) proves that `buildQrPayload` CAN carry an `fp=` when handed one.
// That was true, and the feature was still worth zero, because nothing handed it
// one. This file tests the handing-over — and specifically the one line where the
// value dies silently:
//
//   `asPairingInfo` (lib/bridge.ts) rebuilds the snapshot FIELD BY FIELD. A field
//   missing from that literal is a field the caller can never see. It has already
//   happened four times in this exact function (`lan_candidates`' filter, then
//   `lan_endpoint` / `expires_in_ms` / `machine_uid`, all three of which the Rust
//   side had been sending into a void). A hole there fails EXACTLY like an unwired
//   chain: no `fp=`, no error, every other test still green.
//
// So the input here is a raw object shaped like what Rust's serde emits, not a
// hand-built `PairingInfo` — the narrowing is inside the tested path, not around it.

import { describe, expect, it } from 'vitest';
import { asPairingInfo } from './bridge';
import { derivePairingModal } from './pairing';

/** 24 base64url chars, containing a 4-digit run (`9421`) on purpose so that any
 *  ordering mistake shows up in the server-code-regex assertion below. */
const FP = 'oTA0pWG9421vmsxFi1ZoR4gs';

/** VERBATIM the regex in server-core `room/registry.ts`, symbol `resolvePcForPair`. */
const SERVER_CODE_RE = /code=(\d{4})/;

/** What `pairing_code` serializes (Rust `shell/connection.rs`, struct `PairingInfo`).
 *  Keys are the serde field names, which is what makes this a wire fixture rather
 *  than a restatement of the TS interface. */
function rustSnapshot(overrides: Record<string, unknown> = {}): unknown {
  return {
    short_code: '4821',
    endpoint: 'http://10.0.0.78:41879',
    pc_name: 'dev-pc-a',
    connected: true,
    mobiles: 0,
    lan_candidates: ['10.0.0.78', '100.64.7.78'],
    expires_in_ms: 300000,
    machine_uid: 'dev-pc-a::abc123',
    lan_endpoint: 'http://10.0.0.78:41879',
    lan_tls_fp: FP,
    channel: 'lan',
    ...overrides,
  };
}

describe('a fingerprint the sidecar published reaches the QR', () => {
  it('🔴 survives asPairingInfo — the narrowing that has eaten four fields already', () => {
    expect(asPairingInfo(rustSnapshot()).lan_tls_fp).toBe(FP);
  });

  it('🔴 end to end: Rust snapshot in, `fp=` on the payload out', () => {
    const view = derivePairingModal(asPairingInfo(rustSnapshot()), 'standalone');
    expect(view.qrPayload).toBe(
      'flowmic://pair?endpoint=ws://10.0.0.78:41879&code=4821&channel=standalone' +
        `&alt=100.64.7.78&fp=${FP}`,
    );
  });

  it('keeps `fp=` LAST — the server takes the FIRST /code=(\\d{4})/ match', () => {
    const payload = derivePairingModal(asPairingInfo(rustSnapshot()), 'standalone').qrPayload ?? '';
    expect(payload.indexOf('&fp=')).toBeGreaterThan(payload.indexOf('&alt='));
    expect(payload.indexOf('&fp=')).toBeGreaterThan(payload.indexOf('&code='));
    // FP contains `9421`; the code is `4821`. If ordering ever inverted, this is
    // the assertion that would notice — and it is the one the server depends on.
    expect(SERVER_CODE_RE.exec(payload)?.[1]).toBe('4821');
  });
});

describe('every way the fingerprint can be absent ⇒ today`s exact payload', () => {
  const PRE_D2LAN =
    'flowmic://pair?endpoint=ws://10.0.0.78:41879&code=4821&channel=standalone&alt=100.64.7.78';

  it.each([
    // The no-TLS server: `/api/network` answers `lan_tls_fp: null`, Rust maps it to
    // `Option::None`, serde emits null.
    ['a server serving plain (null)', { lan_tls_fp: null }],
    // A shell older than this card: the key is simply not in the snapshot.
    ['an older shell (key absent)', { lan_tls_fp: undefined }],
    // Defensive: a value that is not a string cannot become a pin.
    ['a non-string value', { lan_tls_fp: 42 }],
    ['an empty string', { lan_tls_fp: '' }],
  ])('%s ⇒ byte-identical to the pre-D2-LAN QR', (_name, override) => {
    const info = asPairingInfo(rustSnapshot(override));
    expect(derivePairingModal(info, 'standalone').qrPayload).toBe(PRE_D2LAN);
  });

  it('🔴 the positive control: the SAME snapshot with a fingerprint differs', () => {
    // Without this, every assertion above would also pass against an
    // implementation that dropped the fingerprint unconditionally — i.e. against
    // the bug this card exists to fix.
    expect(derivePairingModal(asPairingInfo(rustSnapshot()), 'standalone').qrPayload)
      .not.toBe(PRE_D2LAN);
  });
});

describe('the cloud channel never carries a LAN pin', () => {
  it('drops it even when the snapshot (wrongly) carries one', () => {
    // Rust already blanks it on the cloud channel (`shell/connection.rs`), so this
    // asserts the SECOND gate. Two gates on purpose: the Rust snapshot is a public
    // command result and only the modal knows which tab is on screen.
    const view = derivePairingModal(asPairingInfo(rustSnapshot({ channel: 'cloud' })), 'saas');
    expect(view.qrPayload).not.toContain('fp=');
  });
});
