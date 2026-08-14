// REQ-13-21 (owner 2026-08-13, screenshot in the ruling) — the pairing modal
// overflowed the main window and buried the flow under a 46px code + two hints
// + a flat four-chip address block. Three fixes are pinned here:
//
//   ① STRUCTURE: `.modal` carries `max-height` + `overflow-y` — on any window
//      size the foot buttons stay reachable. jsdom does no layout, so this is a
//      SOURCE pin on the component's own style block (the precedent is
//      capsule-shadow-fits-window.test.ts parsing tokens.css): crude, but the
//      alternative is nothing standing between us and the screenshot again.
//   ② DENSITY: the QR is the hero; the code is ONE line under it; the address
//      block folds behind a single toggle line by default.
//   ③ LOUD PATHS STAY LOUD: loopback (no QR possible — manual entry IS the
//      path) auto-opens the fold; a fold that hid the addresses there would
//      strand exactly the user it was built for.
//
// Rendering via vue/server-renderer per update-block.test.ts, whose header also
// records the comment-stripping trap (SSR emits template comments verbatim, and
// this file's negative assertions would otherwise match our own comments).
//
// What SSR CANNOT prove here: the click-to-toggle (SSR renders initial state
// only) and the auto-mint wiring (doRefresh crosses the bridge). The toggle is
// a one-line v-if; the mint DECISION is the pure `shouldMintAbsent`, truth-table
// pinned in pair-countdown.test.ts. All-green unit tests have zero proof value
// for "is it wired up" — the real-device leg is "switch channels, watch a code
// appear unclicked."

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';

import PairingModal from './components/PairingModal.vue';
import type { PairingInfo } from '../lib/pairing';
import type { CloudStatus } from '../lib/channel';

const stripComments = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '');

const cloudIdle: CloudStatus = {
  endpoint: '',
  key_set: false,
  key_head: null,
  plan: null,
  subject: null,
  expires_at: null,
  readiness: 'unconfigured' as CloudStatus['readiness'],
  auth_error: null,
};

function lanInfo(over: Partial<PairingInfo> = {}): PairingInfo {
  return {
    short_code: '5071',
    endpoint: 'http://10.0.0.78:41879',
    pc_name: 'DESKTOP-MAIN',
    connected: true,
    mobiles: 0,
    lan_candidates: ['10.8.66.78', '172.30.176.1', '198.18.0.1', '100.64.7.78'],
    ...over,
  } as PairingInfo;
}

async function render(info: PairingInfo): Promise<string> {
  const html = await renderToString(
    createSSRApp(PairingModal, { open: true, info, channel: 'lan', cloud: cloudIdle }),
  );
  return stripComments(html);
}

describe('REQ-13-21 ① the modal cannot outgrow the window (source pin)', () => {
  it('.modal declares max-height and inner scroll', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./components/PairingModal.vue', import.meta.url)),
      'utf8',
    );
    const modalRule = /\.modal\s*\{[^}]*\}/.exec(src)?.[0] ?? '';
    expect(modalRule, 'the .modal rule exists').not.toBe('');
    expect(modalRule).toContain('max-height');
    expect(modalRule).toContain('overflow-y: auto');
  });
});

describe('REQ-13-21 ② density — code is one line, addresses fold', () => {
  it('the 46px code block is gone and the code renders inline', async () => {
    const html = await render(lanInfo());
    expect(html).not.toContain('code-big');
    expect(html).toContain('code-inline');
    expect(html).toContain('5071');
  });

  it('addresses are folded by default: toggle visible, not one IP chip rendered', async () => {
    const html = await render(lanInfo());
    expect(html).toContain('addr-toggle');
    // The four candidate IPs must NOT be on screen until the user asks.
    for (const ip of ['10.8.66.78', '172.30.176.1', '198.18.0.1', '100.64.7.78']) {
      expect(html, ip).not.toContain(ip);
    }
  });
});

describe('REQ-13-21 ③ loud paths auto-open the fold', () => {
  it('loopback (manual entry IS the path): addresses render expanded, code still present', async () => {
    // A loopback endpoint suppresses the QR (F-2346) — the only way in is typing
    // an address + the code, so hiding either behind the fold would be a trap.
    const html = await render(lanInfo({ endpoint: 'http://127.0.0.1:41879' }));
    expect(html).toContain('5071');
    // The fold opened by itself: candidate addresses are on screen unclicked.
    expect(html).toContain('10.8.66.78');
  });
});
