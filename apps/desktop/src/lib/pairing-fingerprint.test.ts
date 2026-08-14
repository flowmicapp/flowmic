// D2LAN-B2 — `fp=` on the pairing QR.
//
// The claim this file has to defend is not 「the new key is present」 (trivial) but
// 🔴 「adding it changed NOTHING for anyone who does not know it」. Two independent
// readers of that payload exist today and neither will be updated in this round:
//
//   ① the SERVER, which never parses the payload at all beyond
//      `/code=(\d{4})/` — apps/server-core/src/room/registry.ts, symbol
//      `resolvePcForPair` — and takes the FIRST match. That is the entire reason
//      `alt=` is appended last, and the reason `fp=` goes behind it.
//   ② the PHONE, apps/mobile/lib/src/signaling/wire_payloads.dart, symbol
//      `PairEntry.parse`, which does `Uri.parse` + `queryParameters` and reads
//      only `endpoint` and `code`.
//
// Both are reproduced below as executable stand-ins rather than described in a
// comment, because a comment asserting what another file does is a claim whose
// truth changes when that file does and which nothing would catch (反 façade ④).

import { describe, expect, it } from 'vitest';
import { buildQrPayload, derivePairingModal, type PairingInfo } from './pairing';

/** VERBATIM the regex in `resolvePcForPair`. If that one ever changes, this copy
 *  is wrong and the assertions built on it become theatre — which is why the
 *  symbol is named above and why this is a one-line copy rather than a
 *  re-implementation. */
const SERVER_CODE_RE = /code=(\d{4})/;

/** What `PairEntry.parse` sees: a real query parser, so unknown keys are ignored
 *  by construction. */
function phoneReads(payload: string): { endpoint: string | null; code: string | null } {
  const url = new URL(payload);
  return { endpoint: url.searchParams.get('endpoint'), code: url.searchParams.get('code') };
}

/** A realistic value: 24 base64url chars, and it deliberately CONTAINS a 4-digit
 *  run (`9421`) so that a payload which put `fp=` in front of `code=` would be
 *  caught by the server-regex assertions below instead of passing by luck. */
const FP = 'oTA0pWG9421vmsxFi1ZoR4gs';

describe('buildQrPayload — no fingerprint means byte-identical to before', () => {
  it('emits the exact pre-D2-LAN payload when no fingerprint is supplied', () => {
    expect(buildQrPayload({ endpoint: 'http://10.0.0.78:41879', code: '4821' }))
      .toBe('flowmic://pair?endpoint=ws://10.0.0.78:41879&code=4821&channel=standalone');
  });

  it('is byte-identical for null, undefined, empty and whitespace-only', () => {
    const base = 'flowmic://pair?endpoint=ws://10.0.0.78:41879&code=4821&channel=standalone&alt=100.64.7.78';
    const opts = {
      endpoint: 'http://10.0.0.78:41879',
      code: '4821',
      candidates: ['100.64.7.78'],
    } as const;
    expect(buildQrPayload(opts)).toBe(base);
    expect(buildQrPayload({ ...opts, fingerprint: null })).toBe(base);
    expect(buildQrPayload({ ...opts, fingerprint: undefined })).toBe(base);
    expect(buildQrPayload({ ...opts, fingerprint: '' })).toBe(base);
    expect(buildQrPayload({ ...opts, fingerprint: '   ' })).toBe(base);
  });
});

describe('buildQrPayload — fp= is appended LAST', () => {
  it('goes after channel when there are no alternates', () => {
    expect(buildQrPayload({ endpoint: 'http://10.0.0.78:41879', code: '4821', fingerprint: FP }))
      .toBe(`flowmic://pair?endpoint=ws://10.0.0.78:41879&code=4821&channel=standalone&fp=${FP}`);
  });

  it('goes after alt=, not between code= and alt=', () => {
    const payload = buildQrPayload({
      endpoint: 'http://10.0.0.78:41879',
      code: '4821',
      candidates: ['100.64.7.78', '10.8.66.78'],
      fingerprint: FP,
    });
    expect(payload).toBe(
      'flowmic://pair?endpoint=ws://10.0.0.78:41879&code=4821&channel=standalone' +
        `&alt=100.64.7.78,10.8.66.78&fp=${FP}`,
    );
    // Positional, not just textual: this is the property the ordering exists for.
    expect(payload.indexOf('&fp=')).toBeGreaterThan(payload.indexOf('&alt='));
    expect(payload.indexOf('&fp=')).toBeGreaterThan(payload.indexOf('&code='));
  });
});

describe('the two existing readers are unaffected', () => {
  it('the server`s /code=(\\d{4})/ still takes the real code', () => {
    // FP contains `9421`. If `fp=` were emitted before `code=`, the first match
    // would still be `code=` (the regex anchors on that literal) — so the sharper
    // statement is what is asserted: adding fp does not move the answer at all.
    const withFp = buildQrPayload({ endpoint: 'http://10.0.0.78:41879', code: '4821', fingerprint: FP });
    const withoutFp = buildQrPayload({ endpoint: 'http://10.0.0.78:41879', code: '4821' });
    expect(SERVER_CODE_RE.exec(withFp)?.[1]).toBe('4821');
    expect(SERVER_CODE_RE.exec(withFp)?.[1]).toBe(SERVER_CODE_RE.exec(withoutFp)?.[1]);
  });

  it('a phone that does not know `fp` reads the same endpoint and code as before', () => {
    const opts = {
      endpoint: 'http://10.0.0.78:41879',
      code: '4821',
      candidates: ['100.64.7.78'],
    } as const;
    expect(phoneReads(buildQrPayload({ ...opts, fingerprint: FP })))
      .toEqual(phoneReads(buildQrPayload(opts)));
    expect(phoneReads(buildQrPayload({ ...opts, fingerprint: FP })))
      .toEqual({ endpoint: 'ws://10.0.0.78:41879', code: '4821' });
  });
});

describe('a fingerprint that cannot be carried intact is DROPPED, not mangled', () => {
  // 🔴 The direction matters. A split or truncated pin makes the phone refuse a
  // server that IS the right one — an alarm nobody can diagnose. A missing pin
  // falls back to today's plain connection, which the phone can at least say out
  // loud (design §4-4). Between a false alarm and an honest downgrade, drop.
  it.each([
    ['comma', 'oTA0pWG9421vmsx,i1ZoR4gs'],
    ['ampersand', 'oTA0pWG9421vmsx&i1ZoR4gs'],
    ['space', 'oTA0pWG9421vmsx i1ZoR4gs'],
    ['newline', 'oTA0pWG9421vmsx\ni1ZoR4gs'],
    ['tab', 'oTA0pWG9421vmsx\ti1ZoR4gs'],
  ])('drops a fingerprint containing a %s', (_name, bad) => {
    const payload = buildQrPayload({ endpoint: 'http://10.0.0.78:41879', code: '4821', fingerprint: bad });
    expect(payload).toBe('flowmic://pair?endpoint=ws://10.0.0.78:41879&code=4821&channel=standalone');
    expect(payload).not.toContain('fp=');
  });

  it('a leading/trailing space is trimmed rather than dropping a good fingerprint', () => {
    expect(buildQrPayload({ endpoint: 'http://10.0.0.78:41879', code: '4821', fingerprint: ` ${FP} ` }))
      .toContain(`&fp=${FP}`);
  });
});

describe('derivePairingModal threads lan_tls_fp through — and only on the LAN', () => {
  const base: PairingInfo = {
    short_code: '4821',
    endpoint: 'http://10.0.0.78:41879',
    pc_name: 'dev-pc-a',
    connected: true,
    mobiles: 0,
    lan_candidates: ['100.64.7.78'],
  };

  it('emits fp= when the snapshot carries one', () => {
    const view = derivePairingModal({ ...base, lan_tls_fp: FP }, 'standalone');
    expect(view.qrPayload).toContain(`&fp=${FP}`);
    expect(view.qrPayload?.indexOf('&fp=')).toBeGreaterThan(view.qrPayload?.indexOf('&alt=') ?? 0);
  });

  it('a snapshot with no lan_tls_fp yields the pre-D2-LAN payload', () => {
    // ⚠️ This test's TITLE used to say 【未接线】("[not wired]") and its comment
    // said 「nothing sets lan_tls_fp yet」. Card D2LAN-B2b built the producer, so
    // that sentence became a stale truth (反 façade ④) while the ASSERTION below
    // stayed exactly as correct as it was — it pins the fallback, not the
    // absence of a producer. Renamed rather than deleted or weakened: a sidecar
    // serving plain, an older shell, and a mint that failed all still arrive
    // here, and「二维码没变」("the QR code hasn't changed") has to remain a
    // measured fact for them. The producer's own coverage is in
    // pairing-fingerprint-wire.test.ts.
    expect(derivePairingModal(base, 'standalone').qrPayload)
      .toBe('flowmic://pair?endpoint=ws://10.0.0.78:41879&code=4821&channel=standalone&alt=100.64.7.78');
  });

  it('never puts a LAN fingerprint on a cloud QR', () => {
    // The relay is reached over real https with a real CA chain; a self-signed
    // pin there answers a question that channel does not ask. Same guard that
    // drops `alt=` on cloud, two independent reasons.
    const view = derivePairingModal({ ...base, lan_tls_fp: FP }, 'saas');
    expect(view.qrPayload).not.toContain('fp=');
    expect(view.qrPayload).toBe('flowmic://pair?endpoint=ws://10.0.0.78:41879&code=4821&channel=saas');
  });
});
