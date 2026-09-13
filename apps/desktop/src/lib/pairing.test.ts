// WP-R23-1 — device-page pairing helper tests. Covers the QR payload format
// (04 §3.1 L64) and the F-2346 loopback suppression that the modal branches on.

import { describe, expect, it } from 'vitest';
import { UI_LOCALES } from './strings/generated/locales.g';
import {
  buildHttpsQrPayload,
  buildQrPayload,
  cloudPairBlock,
  derivePairAddresses,
  derivePairingModal,
  endpointHost,
  initialPairTab,
  isLoopbackEndpoint,
  isLoopbackHost,
  PAIR_HTTPS_HOST,
  PAIR_HTTPS_PATH,
  pairChannelOf,
  pairLinkLang,
  qrAltHosts,
  QR_ALT_MAX,
  toWsUrl,
  type PairingInfo,
} from './pairing';

describe('endpointHost', () => {
  it('parses http/ws/bare/ipv6 forms', () => {
    expect(endpointHost('http://127.0.0.1:41879')).toBe('127.0.0.1');
    expect(endpointHost('ws://192.168.1.5:41879')).toBe('192.168.1.5');
    expect(endpointHost('192.168.1.5:41879')).toBe('192.168.1.5');
    expect(endpointHost('localhost:41879')).toBe('localhost');
    expect(endpointHost('http://[::1]:41879')).toBe('[::1]');
    expect(endpointHost('')).toBe('');
  });
});

describe('loopback detection (F-2346)', () => {
  it('flags loopback / wildcard / unparseable hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.13.9.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(true);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
    expect(isLoopbackHost('100.64.7.78')).toBe(false);
  });

  it('treats an empty endpoint as loopback (suppress)', () => {
    expect(isLoopbackEndpoint('')).toBe(true);
    expect(isLoopbackEndpoint('http://127.0.0.1:41879')).toBe(true);
    expect(isLoopbackEndpoint('http://192.168.1.5:41879')).toBe(false);
  });
});

describe('toWsUrl', () => {
  it('maps http→ws, https→wss, bare→ws, and keeps ws(s)', () => {
    expect(toWsUrl('http://192.168.1.5:41879')).toBe('ws://192.168.1.5:41879');
    expect(toWsUrl('https://flowmic.app')).toBe('wss://flowmic.app');
    expect(toWsUrl('192.168.1.5:41879')).toBe('ws://192.168.1.5:41879');
    expect(toWsUrl('ws://x:1')).toBe('ws://x:1');
    expect(toWsUrl('wss://x:1')).toBe('wss://x:1');
  });
});

describe('buildQrPayload (04 §3.1 L64)', () => {
  it('emits the exact flowmic://pair schema with a ws-url endpoint', () => {
    expect(buildQrPayload({ endpoint: 'http://192.168.1.5:41879', code: '1234' })).toBe(
      'flowmic://pair?endpoint=ws://192.168.1.5:41879&code=1234&channel=standalone',
    );
    expect(buildQrPayload({ endpoint: 'https://flowmic.app', code: '0007', channel: 'saas' })).toBe(
      'flowmic://pair?endpoint=wss://flowmic.app&code=0007&channel=saas',
    );
  });
});

// ── S1-01 (W-12, owner 2026-09-06) — the transitional PRIMARY code: a real
// https:// URL a phone's system camera can open (installed app → App Link;
// no app → the web fallback page). SAME key set/order as buildQrPayload plus
// a trailing v=1 — spec: docs/strategy/2026-09-05-web-client-protocol-and-api-
// addendum.md §3/§5. `buildQrPayload`'s own output is asserted UNCHANGED above
// and in qr-roundtrip.test.ts / pairing-pcid.test.ts / pairing-fingerprint*
// .test.ts — this describe block only ever reads the NEW function. ──────────
describe('buildHttpsQrPayload (W-12 transitional primary code)', () => {
  it('emits https://flowmic.app/go/pair with a percent-encoded endpoint and v=1', () => {
    // 🔴 THE LITERAL PREFIX IS ASSERTED FIRST, AND THAT IS THE POINT OF THESE
    // TWO LINES (card DOM-1). Until this card the expectations below
    // interpolated `PAIR_HTTPS_HOST` and then hand-typed `/pair` — half pinned
    // to the constant, half a copy. Interpolating BOTH halves would make the
    // rest of this test self-referential (it would pass for any URL the builder
    // and the constants happened to agree on), so the URL this product actually
    // prints is stated once, by hand, here.
    expect(buildHttpsQrPayload({ endpoint: 'http://192.168.1.5:41879', code: '1234' })).toContain(
      'https://flowmic.app/go/pair?',
    );
    expect(`https://${PAIR_HTTPS_HOST}${PAIR_HTTPS_PATH}`).toBe('https://flowmic.app/go/pair');

    expect(buildHttpsQrPayload({ endpoint: 'http://192.168.1.5:41879', code: '1234' })).toBe(
      `https://${PAIR_HTTPS_HOST}${PAIR_HTTPS_PATH}?endpoint=ws%3A%2F%2F192.168.1.5%3A41879&code=1234&channel=standalone&v=1`,
    );
    expect(buildHttpsQrPayload({ endpoint: 'https://flowmic.app', code: '0007', channel: 'saas' })).toBe(
      `https://${PAIR_HTTPS_HOST}${PAIR_HTTPS_PATH}?endpoint=wss%3A%2F%2Fflowmic.app&code=0007&channel=saas&v=1`,
    );
  });

  it('carries the EXACT key set and order: endpoint, code, channel, alt, fp, pcid, v', () => {
    const payload = buildHttpsQrPayload({
      endpoint: 'http://10.0.0.78:41879',
      code: '4821',
      channel: 'standalone',
      candidates: ['10.0.0.78', '100.64.7.78'],
      fingerprint: 'abcDEF012345678901234567', // 24-char SPKI-sha256 shape, isQrSafeValue-clean
      pcid: '302914775',
    });
    const url = new URL(payload);
    expect(Array.from(url.searchParams.keys())).toEqual([
      'endpoint',
      'code',
      'channel',
      'alt',
      'fp',
      'pcid',
      'v',
    ]);
    expect(url.searchParams.get('v')).toBe('1');
  });

  it('omitting fingerprint/pcid omits those keys entirely (not empty-valued)', () => {
    const payload = buildHttpsQrPayload({ endpoint: 'http://192.168.1.5:41879', code: '1234' });
    const url = new URL(payload);
    expect(Array.from(url.searchParams.keys())).toEqual(['endpoint', 'code', 'channel', 'v']);
    expect(url.searchParams.has('fp')).toBe(false);
    expect(url.searchParams.has('pcid')).toBe(false);
  });

  it('REVERSE CONTROL: `code=` must still be the FIRST /code=(\\d{4})/ match ahead of `pcid=`', () => {
    // Structural, not statistical (same reasoning as pairing-pcid.test.ts): the
    // server pulls the pairing code out of a scanned link with the FIRST
    // `/code=(\d{4})/` match, so nothing shaped like a 4-digit run may sit
    // ahead of `code=`, and `pcid=` (nine digits) must stay behind it.
    const PCID = '412300009'; // contains a 4-digit run ('4123') on purpose
    const payload = buildHttpsQrPayload({
      endpoint: 'https://flowmic.app',
      code: '9007',
      channel: 'saas',
      pcid: PCID,
    });
    expect(/code=(\d{4})/.exec(payload)?.[1]).toBe('9007');
    expect(payload.indexOf('&pcid=')).toBeGreaterThan(payload.indexOf('&code='));
    expect(payload.includes('&v=1')).toBe(true);
  });
});

// -- M-2 (web client stage 1, design 2026-09-08-web-client-mic-ui-design.md 5)
// -- the https link carries the DESKTOP's UI language, so a phone with no app
// installed lands on the web mic client already in that language. The page's
// parse order is: path segment > `?lang=` > browser language, so this key only
// ever decides a FIRST arrival at `/go/pair`; once the page rewrites itself to
// `/go/<seg>/...` the segment wins and this value is out of the picture. ------

describe('pairLinkLang (M-2)', () => {
  it('spells a registry tag the way the web client spells it in a URL', () => {
    expect(pairLinkLang('zh-CN')).toBe('zh-cn');
    expect(pairLinkLang('zh-TW')).toBe('zh-tw');
    expect(pairLinkLang('ja')).toBe('ja');
    // English is `en`, NOT the empty string: its URL PATH form is no segment at
    // all (`/go/`), but a `lang=` with nothing in it cannot be told apart from a
    // desktop too old to send one.
    expect(pairLinkLang('en')).toBe('en');
  });

  it('every shipped locale is carried, and the whole registry is covered', () => {
    // Reads the SAME list every language menu iterates, so a tenth locale is
    // carried the day it is added -- and this assertion is what makes that claim
    // checkable instead of remembered.
    for (const tag of UI_LOCALES) {
      expect(pairLinkLang(tag), tag).toBe(tag.toLowerCase());
    }
    expect(UI_LOCALES.length).toBeGreaterThanOrEqual(9);
  });

  it('an unknown / blank / already-lowercased tag emits NOTHING rather than a guess', () => {
    // The negative half of the same fact: the page's third fallback (browser
    // language) is a real answer for a first arrival, and a `lang=` it cannot
    // resolve is not. `zh-cn` is refused HERE (it is not a registry tag) even
    // though it is exactly what gets EMITTED -- the translation has one
    // direction and one author.
    expect(pairLinkLang('zh-cn')).toBeNull();
    expect(pairLinkLang('en-US')).toBeNull();
    expect(pairLinkLang('pt')).toBeNull();
    expect(pairLinkLang('')).toBeNull();
    expect(pairLinkLang('   ')).toBeNull();
    expect(pairLinkLang(null)).toBeNull();
    expect(pairLinkLang(undefined)).toBeNull();
  });
});

describe('buildHttpsQrPayload + lang= (M-2)', () => {
  it('appends &lang=<lowercase tag> for two different desktop languages', () => {
    expect(
      buildHttpsQrPayload({ endpoint: 'http://192.168.1.5:41879', code: '1234', lang: 'zh-CN' }),
    ).toBe(
      `https://${PAIR_HTTPS_HOST}${PAIR_HTTPS_PATH}?endpoint=ws%3A%2F%2F192.168.1.5%3A41879` +
        `&code=1234&channel=standalone&lang=zh-cn&v=1`,
    );
    expect(
      buildHttpsQrPayload({ endpoint: 'https://flowmic.app', code: '0007', channel: 'saas', lang: 'en' }),
    ).toBe(
      `https://${PAIR_HTTPS_HOST}${PAIR_HTTPS_PATH}?endpoint=wss%3A%2F%2Fflowmic.app` +
        `&code=0007&channel=saas&lang=en&v=1`,
    );
  });

  it('sits behind every other key and still AHEAD of v=1', () => {
    const payload = buildHttpsQrPayload({
      endpoint: 'http://10.0.0.78:41879',
      code: '4821',
      channel: 'standalone',
      candidates: ['10.0.0.78', '100.64.7.78'],
      fingerprint: 'abcDEF012345678901234567',
      lang: 'de',
    });
    const url = new URL(payload);
    expect(Array.from(url.searchParams.keys())).toEqual([
      'endpoint',
      'code',
      'channel',
      'alt',
      'fp',
      'lang',
      'v',
    ]);
    // `v` says which shape the keys before it are in; a marker that new keys are
    // appended after would describe a payload that ends before it.
    expect(payload.endsWith('&v=1')).toBe(true);
  });

  it('no lang / unknown lang leaves the payload BYTE-IDENTICAL to the pre-M-2 one', () => {
    const base = buildHttpsQrPayload({ endpoint: 'http://192.168.1.5:41879', code: '1234' });
    expect(base).toBe(
      `https://${PAIR_HTTPS_HOST}${PAIR_HTTPS_PATH}?endpoint=ws%3A%2F%2F192.168.1.5%3A41879&code=1234&channel=standalone&v=1`,
    );
    expect(buildHttpsQrPayload({ endpoint: 'http://192.168.1.5:41879', code: '1234', lang: 'pt-BR' })).toBe(base);
    expect(buildHttpsQrPayload({ endpoint: 'http://192.168.1.5:41879', code: '1234', lang: null })).toBe(base);
  });

  it('the legacy flowmic:// payload does NOT grow a lang= (different reader)', () => {
    // The `flowmic://` code can only ever reach the INSTALLED app, which owns
    // its own UI language. Only the https link can land on the web page that
    // takes its language from the URL.
    const info: PairingInfo = {
      short_code: '1234',
      endpoint: 'http://192.168.1.5:41879',
      pc_name: 'PC',
      connected: true,
      mobiles: 0,
    };
    const v = derivePairingModal(info, 'standalone', 'zh-CN');
    expect(v.qrPayload).toBe('flowmic://pair?endpoint=ws://192.168.1.5:41879&code=1234&channel=standalone');
    expect(v.qrPayloadHttps).toContain('&lang=zh-cn');
  });

  it('derivePairingModal without a locale emits no lang= (the core stays test-callable)', () => {
    const info: PairingInfo = {
      short_code: '1234',
      endpoint: 'http://192.168.1.5:41879',
      pc_name: 'PC',
      connected: true,
      mobiles: 0,
    };
    expect(derivePairingModal(info, 'standalone').qrPayloadHttps).not.toContain('lang=');
  });

  it('MOBILE EXPECTATIONS: a link carrying lang= still parses the way PairEntry.parse reads it', () => {
    // What the phone does with this link is spelled out in
    // apps/mobile/lib/src/signaling/wire_payloads.dart (`PairEntry.parse`) and
    // pinned there by apps/mobile/test/incoming_pair_link_test.dart. Restated
    // here on the PRODUCING side because the two halves ship in different
    // languages and neither compiler can see the other:
    //   1. prefix match  - `input.startsWith(kPairLinkPrefixHttps)`
    //   2. `Uri.parse` + `queryParameters['endpoint' | 'code' | 'fp']`
    //      (a MAP -- an extra key it has never heard of is simply not read)
    //   3. a 4-digit test on `code`
    // and the RELAY pulls the code out of the forwarded payload with the FIRST
    // `/code=(\d{4})/` match (`Registry.resolvePcForPair`).
    const payload = buildHttpsQrPayload({
      endpoint: 'http://10.0.0.78:41879',
      code: '4821',
      channel: 'standalone',
      pcid: null,
      lang: 'ru',
    });
    expect(payload.startsWith(`https://${PAIR_HTTPS_HOST}${PAIR_HTTPS_PATH}`)).toBe(true);
    const url = new URL(payload);
    expect(url.searchParams.get('endpoint')).toBe('ws://10.0.0.78:41879');
    expect(url.searchParams.get('code')).toBe('4821');
    expect(/^\d{4}$/.test(url.searchParams.get('code') ?? '')).toBe(true);
    expect(url.searchParams.has('fp')).toBe(false);
    expect(/code=(\d{4})/.exec(payload)?.[1]).toBe('4821');
    // No registry tag contains a digit, so `lang=` could not be mistaken for a
    // code even in front of it -- it sits behind `code=` anyway, because that
    // rule is structural and not statistical.
    expect(payload.indexOf('&lang=')).toBeGreaterThan(payload.indexOf('&code='));
    expect(/\d/.test(url.searchParams.get('lang') ?? '')).toBe(false);
  });
});

// ── B4-15: the QR carries every LAN address, so the phone can pick a reachable
// one instead of being handed the desktop's single guess ─────────────────────

describe('qrAltHosts (B4-15)', () => {
  it('lists the OTHER addresses, in server order, without the endpoint`s own', () => {
    expect(qrAltHosts('http://10.0.0.78:41879', ['10.0.0.78', '100.64.7.78'])).toEqual([
      '100.64.7.78',
    ]);
    // Order is the SERVER's ranking, not sorted here — the desktop's guess stays
    // the phone's first fallback, which is what makes the choice reproducible.
    expect(qrAltHosts('http://10.0.0.1:41879', ['10.0.0.1', '100.64.7.78', '10.0.0.78'])).toEqual([
      '100.64.7.78',
      '10.0.0.78',
    ]);
  });

  it('is empty when there is nothing to add (no candidates / only the endpoint)', () => {
    expect(qrAltHosts('http://192.168.1.5:41879')).toEqual([]);
    expect(qrAltHosts('http://192.168.1.5:41879', [])).toEqual([]);
    expect(qrAltHosts('http://192.168.1.5:41879', ['192.168.1.5'])).toEqual([]);
  });

  it('refuses a host that would corrupt the payload, and de-dupes', () => {
    // A comma splits one address into two on the phone; an `&` starts a new query
    // parameter. Both are dropped rather than emitted in a shape a parser guesses at.
    expect(qrAltHosts('http://a:1', ['1.1.1.1,2.2.2.2', '3.3.3.3&x=1', '', '4.4.4.4'])).toEqual([
      '4.4.4.4',
    ]);
    expect(qrAltHosts('http://a:1', ['5.5.5.5', '5.5.5.5'])).toEqual(['5.5.5.5']);
  });

  it('caps the list so the picture stays scannable', () => {
    const many = Array.from({ length: 12 }, (_, i) => `10.0.0.${i + 1}`);
    expect(qrAltHosts('http://192.168.1.5:41879', many)).toHaveLength(QR_ALT_MAX);
  });
});

describe('buildQrPayload with candidates (B4-15)', () => {
  it('appends alt= LAST, so the server`s /code=(\\d{4})/ can never read it as the code', () => {
    const payload = buildQrPayload({
      endpoint: 'http://10.0.0.78:41879',
      code: '4821',
      candidates: ['10.0.0.78', '100.64.7.78'],
    });
    expect(payload).toBe(
      'flowmic://pair?endpoint=ws://10.0.0.78:41879&code=4821&channel=standalone&alt=100.64.7.78',
    );
    // The server's own extraction, verbatim (registry.ts:260). A payload whose
    // FIRST code= match were not the real code would pair against another PC.
    expect(/code=(\d{4})/.exec(payload)![1]).toBe('4821');
  });

  it('emits the pre-B4-15 payload byte-for-byte when there is nothing to add', () => {
    // The additive guarantee: an older phone must see exactly the old string.
    expect(buildQrPayload({ endpoint: 'http://192.168.1.5:41879', code: '1234' })).toBe(
      'flowmic://pair?endpoint=ws://192.168.1.5:41879&code=1234&channel=standalone',
    );
    expect(
      buildQrPayload({ endpoint: 'http://192.168.1.5:41879', code: '1234', candidates: ['192.168.1.5'] }),
    ).toBe('flowmic://pair?endpoint=ws://192.168.1.5:41879&code=1234&channel=standalone');
  });
});

describe('derivePairAddresses (B4-15: the manual path sees the same addresses)', () => {
  it('splits the endpoint`s own host from the rest', () => {
    const v = derivePairAddresses('http://10.0.0.78:41879', [
      '10.0.0.78',
      '100.64.7.78',
    ]);
    expect(v.primary).toBe('10.0.0.78');
    expect(v.others).toEqual(['100.64.7.78']);
    expect(v.dropped).toEqual([]);
  });

  it('names the addresses that did NOT fit in the QR (never a silent truncation)', () => {
    const many = Array.from({ length: 9 }, (_, i) => `10.0.0.${i + 1}`);
    const v = derivePairAddresses('http://10.0.0.1:41879', many);
    expect(v.others).toHaveLength(8); // every other address is still LISTED
    expect(v.dropped).toEqual(many.slice(1 + QR_ALT_MAX)); // …and these are typed by hand
    expect(v.dropped.length).toBeGreaterThan(0);
  });

  it('survives an endpoint it cannot parse', () => {
    const v = derivePairAddresses('', ['100.64.7.78']);
    expect(v.primary).toBe('');
    expect(v.others).toEqual(['100.64.7.78']);
  });
});

describe('derivePairingModal', () => {
  const base: PairingInfo = {
    short_code: '1234',
    endpoint: 'http://192.168.1.5:41879',
    pc_name: 'DESKTOP-MAIN',
    connected: true,
    mobiles: 0,
  };

  it('renders a QR for a connected, coded, LAN-reachable endpoint', () => {
    const v = derivePairingModal(base);
    expect(v.reason).toBe('ok');
    expect(v.qrSuppressed).toBe(false);
    expect(v.code).toBe('1234');
    expect(v.qrPayload).toBe('flowmic://pair?endpoint=ws://192.168.1.5:41879&code=1234&channel=standalone');
  });

  it('suppresses the QR for a loopback endpoint but still shows the code (F-2346)', () => {
    const v = derivePairingModal({ ...base, endpoint: 'http://127.0.0.1:41879' });
    expect(v.reason).toBe('loopback');
    expect(v.qrSuppressed).toBe(true);
    expect(v.qrPayload).toBeNull();
    expect(v.code).toBe('1234');
  });

  it('suppresses everything when disconnected', () => {
    const v = derivePairingModal({ ...base, connected: false });
    expect(v.reason).toBe('disconnected');
    expect(v.qrSuppressed).toBe(true);
    expect(v.qrPayload).toBeNull();
  });

  it('reports no-code when connected without a fresh code', () => {
    const v = derivePairingModal({ ...base, short_code: null });
    expect(v.reason).toBe('no-code');
    expect(v.code).toBeNull();
    expect(v.qrPayload).toBeNull();
  });

  it('B4-15: the LAN QR carries the snapshot`s other addresses', () => {
    const v = derivePairingModal({
      ...base,
      endpoint: 'http://10.0.0.78:41879',
      lan_candidates: ['10.0.0.78', '100.64.7.78'],
    });
    expect(v.qrPayload).toBe(
      'flowmic://pair?endpoint=ws://10.0.0.78:41879&code=1234&channel=standalone&alt=100.64.7.78',
    );
  });

  it('B4-15: the CLOUD QR carries none, even if a snapshot somehow had some', () => {
    // Reverse assertion. Rust already sends [] on the cloud channel, so a
    // one-directional test would pass against an implementation that simply
    // forwarded whatever it was given — and that implementation would tell a phone
    // on the relay to dial this machine's NIC, i.e. the opposite of 云端中继
    // ("the cloud relay").
    const v = derivePairingModal(
      { ...base, endpoint: 'https://flowmic.app', lan_candidates: ['100.64.7.78'] },
      'saas',
    );
    expect(v.qrPayload).toBe('flowmic://pair?endpoint=wss://flowmic.app&code=1234&channel=saas');
  });
});

// ── N5 (owner 需求② ["requirement ②"]): the modal picks its own pairing channel ──

describe('pairChannelOf (N5: one tag→payload-word mapping)', () => {
  it('maps the machine tags onto the payload words', () => {
    expect(pairChannelOf('lan')).toBe('standalone');
    expect(pairChannelOf('cloud')).toBe('saas');
  });
});

describe('cloudPairBlock (N5 ③: 云端不可用必须诚实)', () => {
  const ready = { keySet: true, endpoint: 'https://flowmic.app', readiness: 'ready' } as const;

  it('a usable cloud channel is NOT blocked', () => {
    expect(cloudPairBlock(ready)).toBeNull();
  });

  it('no Cloud Key ⇒ blocked with the no-key reason (never an empty QR)', () => {
    expect(cloudPairBlock({ ...ready, keySet: false, readiness: 'no_key' })).toBe('no-key');
    // key_set alone is enough: a shell that reported a stale「ready」with no key
    // must still not offer the option.
    expect(cloudPairBlock({ ...ready, keySet: false })).toBe('no-key');
    // A FRESH INSTALL has neither key nor endpoint, and「未登录」("not logged in")
    // is the useful half: the endpoint box on the device page comes pre-filled,
    // so complaining about it would point the user at a field they do not have
    // to touch.
    expect(cloudPairBlock({ keySet: false, endpoint: '', readiness: 'no_key' })).toBe('no-key');
  });

  it('a key but no relay endpoint ⇒ blocked (there is no address to put in a QR)', () => {
    expect(cloudPairBlock({ ...ready, endpoint: '', readiness: 'no_endpoint' })).toBe('no-endpoint');
    expect(cloudPairBlock({ ...ready, endpoint: '   ' })).toBe('no-endpoint');
  });

  it('a refused / expired key ⇒ blocked, and that reason OUTRANKS the gaps', () => {
    // The relay drops the key on an account-level refusal, so the rejected state
    // arrives WITH key_set=false — reporting「未登录」("not logged in") for it
    // would send the user to the paste box when the real message is「这把钥匙被
    // 拒了」("this key was rejected").
    expect(cloudPairBlock({ keySet: false, endpoint: '', readiness: 'rejected' })).toBe('rejected');
    expect(cloudPairBlock({ ...ready, readiness: 'key_expired' })).toBe('rejected');
  });
});

describe('initialPairTab (N5: never open on a disabled tab)', () => {
  it('opens on the active channel when that channel can pair', () => {
    expect(initialPairTab('lan', false)).toBe('lan');
    expect(initialPairTab('cloud', false)).toBe('cloud');
  });

  it('falls back to LAN when cloud is active but cannot pair', () => {
    // cloud_clear_key keeps the cloud channel SELECTED while logged out (T-2 ⑤),
    // so this is a reachable state, not a hypothetical.
    expect(initialPairTab('cloud', true)).toBe('lan');
  });

  it('a blocked cloud channel never affects the LAN tab', () => {
    expect(initialPairTab('lan', true)).toBe('lan');
  });
});

describe('derivePairingModal cross-channel gate (N5)', () => {
  const lanInfo: PairingInfo = {
    short_code: '1234',
    endpoint: 'http://192.168.1.5:41879',
    pc_name: 'DESKTOP-MAIN',
    connected: true,
    mobiles: 0,
    channel: 'lan',
  };

  it('draws NOTHING from a snapshot that describes the other channel', () => {
    // The async re-read window. Rendering the LAN code under the cloud tab would
    // emit 「A 服务器的码 + B 通道的载荷」("server A's code + channel B's payload")
    // — the pairing mismatch RV-27 removed.
    const v = derivePairingModal(lanInfo, 'saas');
    expect(v.reason).toBe('pending');
    expect(v.qrSuppressed).toBe(true);
    expect(v.qrPayload).toBeNull();
    expect(v.code).toBeNull();
  });

  it('renders once the snapshot IS the selected channel — both directions', () => {
    // Reverse assertion: it is not enough that LAN+standalone works; the cloud tab
    // must render the cloud snapshot, or the gate would just be a cloud-wide block.
    const lan = derivePairingModal(lanInfo, 'standalone');
    expect(lan.reason).toBe('ok');
    expect(lan.qrPayload).toBe('flowmic://pair?endpoint=ws://192.168.1.5:41879&code=1234&channel=standalone');

    const cloud = derivePairingModal(
      { ...lanInfo, channel: 'cloud', endpoint: 'https://flowmic.app', short_code: '0007' },
      'saas',
    );
    expect(cloud.reason).toBe('ok');
    expect(cloud.qrPayload).toBe('flowmic://pair?endpoint=wss://flowmic.app&code=0007&channel=saas');
  });

  it('an older shell that reports no channel keeps the pre-N5 behaviour', () => {
    // Regression protection: the gate cannot run against a value nobody sent, so it
    // must not fire — a snapshot with no tag renders exactly as it did before N5.
    const { channel: _drop, ...untagged } = lanInfo;
    expect(derivePairingModal(untagged, 'standalone').reason).toBe('ok');
    expect(derivePairingModal(untagged, 'saas').reason).toBe('ok');
  });

  it('an unresolved LAN address still suppresses the QR, tagged or not (F-2346)', () => {
    // N5 ③: 「局域网地址还没解析出来」("the LAN address has not been resolved yet")
    // reuses the EXISTING loopback criterion — no second classifier, and never a
    // QR carrying an address only this PC can reach.
    const v = derivePairingModal({ ...lanInfo, endpoint: 'http://127.0.0.1:41879' }, 'standalone');
    expect(v.reason).toBe('loopback');
    expect(v.qrSuppressed).toBe(true);
    expect(v.qrPayload).toBeNull();
    // The code still shows: typing it against a manually-entered LAN address is the
    // documented manual path, so this is not a silent failure.
    expect(v.code).toBe('1234');
  });

  it('a channel with no session of its own reports disconnected, not a fake code', () => {
    // Rust reports `connected` per channel since N5, which is what makes the cloud
    // tab able to say 「云端中继未连接」("cloud relay not connected") instead of
    // borrowing the LAN registration.
    const v = derivePairingModal(
      { ...lanInfo, channel: 'cloud', connected: false, short_code: null },
      'saas',
    );
    expect(v.reason).toBe('disconnected');
    expect(v.qrPayload).toBeNull();
  });
});
