// owner 2026-09-12 item 2 — the two things the pairing modal had to start
// saying, asserted on the RENDERED tree:
//   • the local-network code cannot be scanned by the browser client, and the
//     modal now says so on that tab (and only on that tab);
//   • the legacy `flowmic://` code is FOLDED behind a text button.
//
// ── HOW THIS FILE DRIVES THE COMPONENT ───────────────────────────────────────
// Same render path as pairing-modal.test.ts: vitest's SSR transform compiles
// the SFC to its `ssrRender` form, so `vue/server-renderer` is the matching
// runtime and there is no DOM to click in.
//
// Two consequences, and the workaround for each is deliberate:
//
//  1. THE QR IMAGES ARE NEVER IN AN SSR RENDER. Both codes are rasterized by an
//     `await QRCode.toDataURL(...)` inside a watcher; renderToString does not
//     await that, so `qrDataUrl` / `qrDataUrlSmall` are still null when the tree
//     is produced. That is why every QR assertion in pairing-modal.test.ts is
//     `false`. This file needs the opposite case, so it writes the two data URLs
//     onto the component's OWN refs in a `created()` hook — the same refs the
//     awaited rasterization would have written, set before the first render.
//
//  2. THERE IS NO CLICK. The disclosure is opened by calling `toggleLegacyQr`,
//     which is the component's own handler — the very function the template
//     binds to the button's `@click`. The binding itself is anchored on the
//     source at the bottom of this file, so the chain is complete: the button
//     calls this function (anchor), and calling this function makes the code
//     appear (render).
//
// REVERSE CONTROL (run by hand, 2026-09-12): deleting `v-if="legacyQrOpen"`
// from the small <img> turns ①'s "hidden by default" red
// (the legacy <img> is then in the default render); deleting the
// `v-if="channel === 'lan'"` on the caption turns ③'s cloud half red. Restored,
// both green again.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import PairingModal from './components/PairingModal.vue';
import { S, setLocale } from '../lib/strings';
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

/** Vue's SSR escaping, so an assertion can be written against the CATALOGUE
 *  string rather than against a copy of it pasted into this file (the sentence
 *  contains an apostrophe in English). */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The legacy <img> as it appears in the render. NOT the bare string
 *  'qr-small': the template's own comment mentions the class, so a substring
 *  test would be green on a render that draws nothing. */
const LEGACY_IMG = 'class="qr qr-small"';
const FAKE_QR = 'data:image/png;base64,PRIMARY';
const FAKE_QR_SMALL = 'data:image/png;base64,LEGACY';

interface ModalSetupState {
  qrDataUrl: string | null;
  qrDataUrlSmall: string | null;
  legacyQrOpen: boolean;
  toggleLegacyQr: () => void;
}

function render(opts: {
  channel?: ChannelId;
  cloud?: CloudStatus;
  /** press the disclosure before the first render */
  openLegacy?: boolean;
}): Promise<string> {
  const app = createSSRApp(PairingModal, {
    open: true,
    info: { ...LAN_INFO, channel: opts.channel ?? 'lan' },
    channel: opts.channel ?? 'lan',
    cloud: opts.cloud ?? CLOUD_READY,
  });
  let reached = false;
  app.mixin({
    created(this: { $: { setupState?: Partial<ModalSetupState> } }) {
      const st = this.$.setupState;
      if (!st || typeof st.toggleLegacyQr !== 'function') return;
      reached = true;
      const s = st as ModalSetupState;
      s.qrDataUrl = FAKE_QR;
      s.qrDataUrlSmall = FAKE_QR_SMALL;
      if (opts.openLegacy) s.toggleLegacyQr();
    },
  });
  return renderToString(app).then((html) => {
    // Measure the ruler: if the hook never found the modal, every "not present"
    // assertion below would pass for the wrong reason.
    expect(reached, 'the PairingModal instance was never reached by the setup hook').toBe(true);
    return html;
  });
}

/** The single primary <img class="qr">; the legacy one is `class="qr qr-small"`. */
function hasBigQr(html: string): boolean {
  return html.includes('class="qr"');
}

afterEach(() => {
  setLocale('zh-CN');
});

describe('PairingModal — legacy QR disclosure + the LAN "not for the web version" caption', () => {
  it('① the legacy code is folded by default: its button is there, the code is not', async () => {
    setLocale('en');
    const html = await render({ channel: 'lan' });
    expect(hasBigQr(html), 'the primary code must still be drawn').toBe(true);
    expect(html).toContain(esc(S.pair_legacy_qr_label));
    expect(html).not.toContain(esc(S.pair_legacy_qr_hide));
    expect(html).not.toContain(LEGACY_IMG);
    expect(html).not.toContain(FAKE_QR_SMALL);
  });

  it('② pressing the disclosure shows the legacy code and flips the caption', async () => {
    setLocale('en');
    const html = await render({ channel: 'lan', openLegacy: true });
    expect(html).toContain(LEGACY_IMG);
    expect(html).toContain(FAKE_QR_SMALL);
    expect(html).toContain(esc(S.pair_legacy_qr_hide));
    expect(html).not.toContain(esc(S.pair_legacy_qr_label));
    // GA-31 is carried by the PRIMARY code and the disclosure never touches it.
    expect(hasBigQr(html)).toBe(true);
  });

  it('③ the "the web version cannot use this code" caption is on the LAN tab only', async () => {
    setLocale('en');
    const lan = await render({ channel: 'lan' });
    expect(lan).toContain(esc(S.pair_lan_no_web));
    // Information tone: the code beside it is good, nothing has failed.
    expect(lan).not.toMatch(/class="pair-warn"[^>]*>[^<]*The web version/);

    const cloud = await render({ channel: 'cloud' });
    expect(cloud).not.toContain(esc(S.pair_lan_no_web));
    // GA-31: the cloud tab still has its own code — this card removed nothing.
    expect(hasBigQr(cloud)).toBe(true);
  });

  it('③b the caption follows the interface language (it is catalogue copy, not a literal)', async () => {
    setLocale('zh-CN');
    const zh = await render({ channel: 'lan' });
    expect(zh).toContain(esc(S.pair_lan_no_web));
    expect(zh).toContain('FlowMic-web');
    setLocale('ja');
    const ja = await render({ channel: 'lan' });
    expect(ja).toContain(esc(S.pair_lan_no_web));
    expect(ja).not.toContain(esc(S.pair_legacy_qr_hide));
  });

  it('wiring anchor: the button is what calls the toggle, and the code is gated on it', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./components/PairingModal.vue', import.meta.url)),
      'utf8',
    );
    const tpl = src.slice(src.indexOf('<template>'));
    // The render above proves what `toggleLegacyQr` DOES; this proves the button
    // is the only thing that calls it.
    expect(tpl).toContain('@click="toggleLegacyQr"');
    expect(tpl).toContain('v-if="legacyQrOpen"');
    expect(tpl).toContain('legacyQrOpen ? S.pair_legacy_qr_hide : S.pair_legacy_qr_label');
    expect(tpl).toContain('v-if="channel === \'lan\'"');
    // The caption is a note, not a warning: `.pair-warn` is the modal's failure
    // face and this is not a failure.
    expect(tpl).toContain('<div v-if="channel === \'lan\'" class="pair-note">{{ S.pair_lan_no_web }}</div>');
  });
});
