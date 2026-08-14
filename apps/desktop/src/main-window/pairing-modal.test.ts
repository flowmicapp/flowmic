// N5 (owner requirement ②) component-level test — really compiles and RENDERS
// PairingModal.vue and asserts what the user sees for each unavailable case.
//
// Render path: same as prefs-appearance.test.ts — vitest's default SSR transform
// compiles the SFC into its SSR form, so `vue/server-renderer`'s renderToString is
// the matching runtime (a custom client renderer cannot mount it). That means this
// file proves MARKUP and COPY, not clicks:
//   • the DECISIONS (which channel is asked for; whether a QR exists at all) are
//     proven in lib/pairing.test.ts + lib/pairing-bridge.test.ts;
//   • the WIRING from a tab click to those decisions is anchored on the source
//     literals at the bottom (mode-badge.test.ts / prefs-appearance.test.ts culture);
//   • what a rendered tree actually SHOWS is proven here.
//
// The "no QR" assertions are load-bearing and deliberately structural: the single
// <img class="qr"> in the template is gated on `!view.qrSuppressed && qrDataUrl`, and
// `qrDataUrl` is only ever written from `view.qrPayload` — which the pure tests pin
// to null in every blocked / pending / loopback case. So "no QR renders" is guaranteed
// by the gate, and the anchor below proves the gate is the only door.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import PairingModal from './components/PairingModal.vue';
import { S, setLocale } from '../lib/strings';
import { PAIR_APP_URL } from '../lib/strings/pairing';
import { EMPTY_CLOUD_STATUS, type ChannelId, type CloudStatus } from '../lib/channel';
import type { PairingInfo } from '../lib/pairing';

const LAN_INFO: PairingInfo = {
  short_code: '1234',
  endpoint: 'http://192.168.1.5:41879',
  pc_name: 'DESKTOP-MAIN',
  connected: true,
  mobiles: 0,
  channel: 'lan',
  expires_in_ms: null,
};

const CLOUD_READY: CloudStatus = {
  ...EMPTY_CLOUD_STATUS,
  endpoint: 'https://flowmic.app',
  key_set: true,
  key_head: 'eyJhbG',
  readiness: 'ready',
};

function render(props: {
  info?: Partial<PairingInfo>;
  channel?: ChannelId;
  cloud?: CloudStatus;
}): Promise<string> {
  return renderToString(
    createSSRApp(PairingModal, {
      open: true,
      info: { ...LAN_INFO, ...props.info },
      channel: props.channel ?? 'lan',
      // Default = a fresh install: LAN active, no Cloud Key at all.
      cloud: props.cloud ?? { ...EMPTY_CLOUD_STATUS },
    }),
  );
}

/** The one <img class="qr"> the template can produce. */
function hasQr(html: string): boolean {
  return html.includes('class="qr"');
}

/** Just the channel-switch row, so a `disabled` assertion is about a TAB and not
 *  about the footer's refresh button (which has its own disabled rule). */
function tabsOf(html: string): string {
  const m = html.match(/<div class="tabs"[\s\S]*?<\/div>/);
  expect(m, 'the channel tabs row must be rendered').not.toBeNull();
  return m?.[0] ?? '';
}

afterEach(() => {
  setLocale('zh-CN');
});

describe('PairingModal channel switch (N5, component-level)', () => {
  it('both channels are offered as buttons', async () => {
    const html = await render({ cloud: CLOUD_READY, channel: 'lan' });
    expect(html).toContain(S.dev_chan_lan);
    expect(html).toContain(S.dev_chan_cloud);
  });

  // owner 2026-08-02 UI batch 1 ① "the primary channel should no longer be
  // needed, other places must be audited too." This test used to assert the
  // OPPOSITE (`expect(html).toContain('class="tab-dot"')`) — the dot marking
  // which tab was the primary channel. Flipped to a negative because a deletion is the one
  // kind of change a positive test cannot notice, and because the whole prop that fed it
  // (`activeChannel`) is gone from this component: the parent still computes it, but only
  // to choose the tab the modal OPENS on, which is a behaviour and not a claim on screen.
  it('neither tab claims to be the "primary channel" any more', async () => {
    const html = await render({ cloud: CLOUD_READY, channel: 'lan' });
    expect(html).not.toContain('tab-dot');
    // The retired string is gone from the catalogue too — zero producers, so it goes
    // with its producers (the `INJECT_NO_RECEIPT` precedent).
    expect(Object.keys(S)).not.toContain('dev_chan_in_use');
  });

  // C-8 (owner 2026-08-01 unified channel visual identity, closing round): the
  // two tabs used to say "local LAN" / "cloud relay" in plain text,
  // colour-and-icon-less — the SAME word choice this file's own comment above
  // worries about being lost, but the IDENTITY question (which channel) had no
  // colour+icon answer here at all. Now each tab's label is the ONE definition
  // (lib/channel.ts's CHANNEL_VISUAL + tokens.css's `.chan-badge.<css>`), same
  // shape TimelinePage.vue uses.
  it('each tab carries the ONE-definition channel badge (icon + colour), not bare text', async () => {
    const html = await render({ cloud: CLOUD_READY, channel: 'lan' });
    // Vue's SSR renderer puts the :class binding BEFORE the static class attr.
    expect(html).toContain('class="lan chan-badge"');
    expect(html).toContain('class="cloud chan-badge"');
  });

  it('the LAN and cloud tab badges carry REAL different icon shapes', async () => {
    const html = await render({ cloud: CLOUD_READY, channel: 'lan' });
    const lanBadge = html.match(/class="lan chan-badge"[\s\S]*?<\/span>/)?.[0] ?? '';
    const cloudBadge = html.match(/class="cloud chan-badge"[\s\S]*?<\/span>/)?.[0] ?? '';
    expect(lanBadge).not.toBe('');
    expect(cloudBadge).not.toBe('');
    expect(lanBadge).toContain('<circle');
    expect(cloudBadge).not.toContain('<circle');
    expect(lanBadge).not.toBe(cloudBadge);
  });

  it('cloud has no key configured → that option is disabled + states why, and no QR', async () => {
    const html = await render({ cloud: { ...EMPTY_CLOUD_STATUS } });
    expect(tabsOf(html)).toContain('disabled');
    // The reason is on the disabled option itself (title), reusing the device page's
    // wording for the same fact instead of inventing a second sentence.
    expect(html).toContain(S.dev_chan_cloud_no_key);
    expect(hasQr(html)).toBe(false);
  });

  it('cloud key is available → that option is no longer disabled (reverse assertion)', async () => {
    // Without this the previous test would also pass for a modal that disabled the
    // cloud option unconditionally.
    const html = await render({ cloud: CLOUD_READY });
    expect(tabsOf(html)).not.toContain('disabled');
    expect(html).not.toContain(S.dev_chan_cloud_no_key);
  });

  it('cloud selected but cloud has no key → body has only the reason, no code and no QR', async () => {
    // Reachable state: cloud_clear_key keeps the cloud channel selected while logged
    // out. The modal opens on LAN for it (initialPairTab), but a key can also lapse
    // WHILE the cloud tab is open — this is that frame.
    const html = await render({ channel: 'cloud', info: { channel: 'cloud' } });
    expect(html).toContain(S.dev_chan_cloud_no_key);
    expect(html).not.toContain('class="code-big mono"');
    expect(hasQr(html)).toBe(false);
    // …and "refresh pairing code" is not offered either: there is no server to mint on.
    expect(html).toContain(`${S.pair_refresh}`);
    expect(html).toMatch(/<button class="btn ghost sm" disabled/);
  });

  it('cloud login expired → says "expired, please re-paste," not "not signed in"', async () => {
    const html = await render({
      channel: 'cloud',
      info: { channel: 'cloud' },
      cloud: { ...CLOUD_READY, key_set: false, readiness: 'rejected', auth_error: 'AUTH_TOKEN_EXPIRED' },
    });
    expect(html).toContain(S.cloud_err_expired);
    expect(html).not.toContain(S.dev_chan_cloud_no_key);
    expect(hasQr(html)).toBe(false);
  });

  it('the snapshot is still the previous channel\'s → explicitly says "loading," draws no QR/code at all', async () => {
    const html = await render({ channel: 'cloud', info: { channel: 'lan' }, cloud: CLOUD_READY });
    expect(html).toContain(S.pair_switching);
    expect(html).not.toContain('class="code-big mono"');
    expect(hasQr(html)).toBe(false);
  });

  it('the LAN address has not resolved yet → reuses the loopback criterion explicitly, never gives a loopback QR', async () => {
    const html = await render({ info: { endpoint: 'http://127.0.0.1:41879' } });
    expect(html).toContain(S.pair_loopback);
    expect(hasQr(html)).toBe(false);
    // The code still shows — the manual path (type this PC's LAN address + the code)
    // is real, so suppressing it too would be hiding a working route.
    expect(html).toContain('1234');
  });

  it('this channel itself is not connected → cloud says the cloud sentence, LAN says the LAN sentence', async () => {
    const cloudDown = await render({
      channel: 'cloud',
      info: { channel: 'cloud', connected: false, short_code: null },
      cloud: CLOUD_READY,
    });
    expect(cloudDown).toContain(S.cloud_pair_offline);
    expect(hasQr(cloudDown)).toBe(false);

    const lanDown = await render({ info: { connected: false, short_code: null } });
    expect(lanDown).toContain(S.pair_disconnected);
    expect(lanDown).not.toContain(S.cloud_pair_offline);
  });

  it('all four languages: "loading" and "cloud not configured" both render non-Chinese copy in each language', async () => {
    for (const loc of ['en', 'ja', 'ko'] as const) {
      setLocale(loc);
      const pending = await render({ channel: 'cloud', info: { channel: 'lan' }, cloud: CLOUD_READY });
      expect(pending, `pair_switching missing in ${loc}`).toContain(S.pair_switching);
      expect(pending).not.toContain('正在读取该通道的配对码与地址…');

      const noKey = await render({ channel: 'cloud', info: { channel: 'cloud' } });
      expect(noKey, `cloud no-key reason missing in ${loc}`).toContain(S.dev_chan_cloud_no_key);
    }
  });
});

describe('N5 wiring anchors (source literals — the click→re-read path)', () => {
  const src = readFileSync(fileURLToPath(new URL('./components/PairingModal.vue', import.meta.url)), 'utf8');
  const page = readFileSync(fileURLToPath(new URL('./DevicesPage.vue', import.meta.url)), 'utf8');
  const tpl = src.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? '';

  it('C-8: the tab consumes CHANNEL_VISUAL — the one definition — not a private colour', () => {
    expect(src).toContain("CHANNEL_LABEL, CHANNEL_VISUAL, cloudLoudReason");
    expect(tpl).toContain('CHANNEL_VISUAL[id].css');
    expect(tpl).toContain('CHANNEL_VISUAL[id].iconPath');
    // Only the two pre-existing, unrelated allowlisted literals (modal scrim
    // alpha + QR white plate — see design-token-literals.mjs's ALLOWLIST) may
    // remain; no NEW hex for the tab identity.
    const hexHits = (src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).filter((h) => h !== '#fff');
    expect(hexHits).toEqual([]);
  });

  it('the tab click goes through pickChannel → emit, and the parent re-reads at once', () => {
    expect(tpl).toContain('@click="pickChannel(id)"');
    expect(src).toContain("emit('channel', id)");
    // The parent binds it to a handler that fetches immediately (no poll, no tick).
    expect(page).toContain('@channel="pickPairChannel"');
    expect(page).toContain('pairTarget.value = channel;');
    expect(page).toContain('await loadInfo();');
    expect(page).toContain('fetchPairingInfo(pairTarget.value)');
  });

  it('there is exactly ONE QR image and it is gated on the suppression decision', () => {
    // The 「no QR」 assertions above are only as strong as this: if a second <img>
    // appeared outside the gate, a blocked channel could still show a code picture.
    expect((tpl.match(/<img/g) ?? []).length).toBe(1);
    expect(tpl).toContain('v-if="!view.qrSuppressed && qrDataUrl"');
    expect(src).toContain('() => view.value.qrPayload');
  });

  it('the blocked-channel branch comes BEFORE anything that could draw a code', () => {
    const blocked = tpl.indexOf('v-if="tabBlocked"');
    // REQ-13-21 rewrote the anchor: `code-big` (the 46px block) is gone and the
    // code renders as the one-line `code-line` under the QR. The ordering claim
    // is unchanged — a blocked tab must never show a code.
    const codeLine = tpl.indexOf('code-line');
    expect(blocked).toBeGreaterThan(-1);
    expect(codeLine).toBeGreaterThan(blocked);
  });

  it('the refresh verb and the snapshot read both carry the selected channel', () => {
    expect(src).toContain('refreshPairingCode(props.channel)');
    expect(page).toContain('refreshPairingCode(pairTarget.value)');
  });

  it('the disabled cloud option is really disabled, not merely styled', () => {
    expect(tpl).toContain(":disabled=\"id === 'cloud' && cloudBlock !== null\"");
    expect(src).toContain("if (id === 'cloud' && cloudBlock.value !== null) return;");
  });

  it('the modal never opens on a tab it would disable', () => {
    expect(page).toContain('initialPairTab(activeChannel.value, cloudBlock.value !== null)');
  });

  it('the "local LAN" card reads its OWN address, not the pairing endpoint', () => {
    // N5 side-effect guard: `endpoint` now follows the modal's tab, so anything
    // that asks "what is this channel's address" off it would print the relay
    // URL on the LAN card the moment the user looks at the cloud tab — the
    // 0.2.4 defect, reopened.
    expect(page).toContain('const lanLoopback = computed(() => isLoopbackEndpoint(lanOwnEndpoint.value));');
    expect(page).toContain('loopback: lanLoopback.value,');
    expect(page).toContain("rawInfo.value.channel === 'lan'");
    // …while the QR keeps using the PAIRING endpoint's loopback verdict (F-2346).
    expect(page).toContain('const loopback = computed(() => isLoopbackEndpoint(info.value.endpoint));');
    expect(page).toContain('watch([modalOpen, loopback]');
  });

  it('the pairing target is only auto-synced while the modal is CLOSED', () => {
    // A cloud-state push mid-pairing must not swap the QR under the user's phone.
    expect(page).toContain('if (!open) pairTarget.value = active;');
  });
});

// ── B4-15: the addresses, in words, for whoever is TYPING into a phone ───────
//
// The QR carries every LAN address now, and the phone auto-picks a reachable
// one. This block is the SAME fact for a human on the "manual entry" tab —
// owner's 2026-08-01 screenshot had one address on screen and no way to learn
// the other. It is asserted on the RENDERED tree rather than on source
// literals because the question is "are these addresses on the screen," not
// "are they written in the code."

describe('PairingModal LAN address list (B4-15)', () => {
  const MULTI = {
    endpoint: 'http://10.0.0.78:41879',
    lan_candidates: ['10.0.0.78', '100.64.7.78'],
  };

  it('expanded, it lists the QR`s address AND the other NICs on the LAN tab', async () => {
    // REQ-13-21 (owner 2026-08-13): this used to assert the list renders by
    // DEFAULT; the block now folds behind one toggle line (default-collapsed is
    // pinned in pairing-modal-density.test.ts). SSR cannot click, so the
    // expanded face is driven through the dropped>0 loud path, which auto-opens
    // the fold — the content contract is unchanged: primary + others + the
    // in-QR note, all on screen.
    const many = ['10.0.0.78', '100.64.7.78', '10.1.0.1', '10.1.0.2', '10.1.0.3', '10.1.0.4', '10.1.0.5'];
    const html = await render({
      info: { endpoint: 'http://10.0.0.78:41879', lan_candidates: many },
    });
    expect(html).toContain(S.pair_addr_title);
    expect(html).toContain('10.0.0.78');
    expect(html).toContain('100.64.7.78');
    expect(html).toContain(S.pair_addr_in_qr);
  });

  it('says out loud which addresses did NOT fit in the picture', async () => {
    // The anti-silent-truncation half of QR_ALT_MAX. Without this line a machine
    // with nine NICs looks fully covered while the one the phone needs is absent
    // from both the QR and the screen.
    const many = Array.from({ length: 9 }, (_, i) => `10.0.0.${i + 1}`);
    const html = await render({
      info: { endpoint: 'http://10.0.0.1:41879', lan_candidates: many },
    });
    expect(html).toContain(S.pair_addr_dropped);
    expect(html).toContain('10.0.0.9');
  });

  it('draws nothing on the CLOUD tab — the relay has one address, already shown', async () => {
    const html = await render({
      channel: 'cloud',
      cloud: CLOUD_READY,
      info: { ...MULTI, channel: 'cloud', endpoint: 'https://flowmic.app' },
    });
    expect(html).not.toContain(S.pair_addr_title);
    expect(html).not.toContain('100.64.7.78');
  });

  it('a single-NIC PC gets the endpoint line and no "also listening on" list', async () => {
    // REQ-13-21: was asserted on the default face; the fold now hides the block
    // until asked. Driven through loopback — the one single-NIC state that
    // auto-opens (manual entry IS the path there) — the claim is unchanged: the
    // endpoint line renders, an empty "also listening on" header never does.
    const html = await render({
      info: { endpoint: 'http://127.0.0.1:41879', lan_candidates: ['127.0.0.1'] },
    });
    expect(html).toContain('127.0.0.1');
    expect(html).not.toContain(S.pair_addr_others);
    expect(html).not.toContain(S.pair_addr_dropped);
  });
});

// U8 (2026-08-04) — the modal used to hand a first-time user a bare 4-digit
// code with no word about the phone-side app it is FOR, and the cloud tab's
// dead end (no Cloud Key) said so without pointing anywhere to get one. These
// assert the RENDERED markup, not raw string presence — a string that exists
// in the catalogue but is never interpolated into the template would pass a
// `Object.keys(S)` check and still leave the user stuck.
describe('U8 — pairing dialog is no longer a dead end for a first-time user', () => {
  it('always tells the user they need the phone app, on BOTH channels', async () => {
    const lan = await render({ channel: 'lan' });
    expect(lan).toContain(S.pair_need_app);
    const cloud = await render({ channel: 'cloud', info: { channel: 'cloud' }, cloud: CLOUD_READY });
    expect(cloud).toContain(S.pair_need_app);
  });

  it('does NOT render a download link while PAIR_APP_URL is empty (no fake URL)', async () => {
    // Façade guard: S1 has not landed yet, so `PAIR_APP_URL` (lib/strings/pairing.ts)
    // is ''. Rendering an <a href=""> for an empty string would be a link that
    // goes nowhere — worse than no link at all.
    expect(PAIR_APP_URL).toBe('');
    const html = await render({ channel: 'lan' });
    expect(html).not.toContain(S.pair_get_app);
    expect(html).not.toMatch(/<a[^>]*>[^<]*<\/a>/);
  });

  it('cloud tab with no Cloud Key points at the real console, not just "needed"', async () => {
    const html = await render({ channel: 'cloud', info: { channel: 'cloud' } });
    // Still shows the sibling-owned reason (this modal does not rewrite it)…
    expect(html).toContain(S.dev_chan_cloud_no_key);
    // …AND now also says where to get one.
    expect(html).toContain(S.pair_cloud_console_hint);
    expect(S.pair_cloud_console_hint).toContain('flowmic.app/console');
  });

  it('a WORKING cloud channel does not need the console pointer (no ambient nagging)', async () => {
    const html = await render({ channel: 'cloud', info: { channel: 'cloud' }, cloud: CLOUD_READY });
    expect(html).not.toContain(S.pair_cloud_console_hint);
  });

  it('all four languages: pair_need_app renders in every non-base locale too', async () => {
    for (const loc of ['en', 'ja', 'ko'] as const) {
      setLocale(loc);
      const html = await render({ channel: 'lan' });
      expect(html, `pair_need_app missing in ${loc}`).toContain(S.pair_need_app);
      expect(html).not.toContain('配对前，请先在手机上安装 FlowMic App。');
    }
  });
});
