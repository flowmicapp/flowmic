// C-8 (owner 2026-08-01: unify channel visual identity, wrap-up round). C-4 built the ONE definition
// (lib/channel.ts's CHANNEL_VISUAL + tokens.css's `--channel-*-ink/-soft` +
// `.chan-badge.<css>`) and converted 4 render sites; a full-scan found 5 more
// still drawing their own colour, `PairedList.vue`'s `.chip.chan-lan/.chan-cloud`
// (aliasing the generic teal/brand tokens) chief among them. This is the single
// machine guard the task asked for: across the four files this lane owns, no
// channel-identity colour literal survives, and every one of them consumes the
// one definition instead. Per-component behaviour (real icon shapes actually
// rendered, positive probes, reverse-checked once each — see the delivery
// report) lives in each file's own test (paired-list.test.ts,
// conn-diag-badge.test.ts, pairing-modal.test.ts, devices-info-panel.test.ts);
// this file is the drift fence.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 🔴 UPDATED by REQ-12-14 (2026-08-12). DevicesPage.vue no longer draws the two
// channel headings itself — components/ChannelCardHead.vue does, once, for both
// cards. Two assertions below therefore changed, and the distinction between what
// they measure matters:
//   · the COLOUR FENCE (no private channel-colour literal) is unchanged in
//     meaning and now covers five files instead of four — the new render site is
//     added to it, DevicesPage.vue stays in it;
//   · the RENDER probe («this file actually consumes CHANNEL_VISUAL») moved with
//     the markup. Simply dropping DevicesPage.vue from it would leave the page
//     free to grow a hand-drawn heading again with nothing watching, so it is
//     replaced by an explicit DELEGATION assertion: the page must hand both cards
//     to ChannelCardHead. That is a semantic check on the page, not a rendering
//     one — the rendered result of the head itself is covered by SSR in
//     components/channel-card-head.test.ts.
const FILES: Record<string, string> = {
  'components/PairedList.vue': readFileSync(
    fileURLToPath(new URL('./components/PairedList.vue', import.meta.url)),
    'utf8',
  ),
  'components/PairingModal.vue': readFileSync(
    fileURLToPath(new URL('./components/PairingModal.vue', import.meta.url)),
    'utf8',
  ),
  'components/ChannelCardHead.vue': readFileSync(
    fileURLToPath(new URL('./components/ChannelCardHead.vue', import.meta.url)),
    'utf8',
  ),
  'ConnDiagPage.vue': readFileSync(fileURLToPath(new URL('./ConnDiagPage.vue', import.meta.url)), 'utf8'),
  'DevicesPage.vue': readFileSync(fileURLToPath(new URL('./DevicesPage.vue', import.meta.url)), 'utf8'),
};

/** The files that DRAW a channel identity. DevicesPage.vue delegates now, so it
 *  is not one of them — see the block above, and the delegation test below. */
const RENDER_SITES = Object.fromEntries(
  Object.entries(FILES).filter(([name]) => name !== 'DevicesPage.vue'),
);

// PairingModal.vue keeps two PRE-EXISTING literals unrelated to channel identity
// (design-token-literals.mjs's ALLOWLIST: the modal-scrim alpha and the QR's
// white plate). Excluding exactly those two keeps this guard about channel
// colours, not a duplicate of that lint.
const UNRELATED_ALLOWED = ['rgba(11, 16, 32, .42)', '#fff'];

function colourLiteralsExcluding(text: string, allowed: string[]): string[] {
  const hits = text.match(/#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)/g) ?? [];
  return hits.filter((h) => !allowed.includes(h));
}

describe('C-8 one-definition guard: no private channel colour literal in the 4 owned files', () => {
  it.each(Object.entries(FILES))('%s carries zero channel-colour literals', (_name, text) => {
    expect(colourLiteralsExcluding(text, UNRELATED_ALLOWED)).toEqual([]);
  });

  it('the retired `.chip.chan-lan` / `.chip.chan-cloud` CSS rules are gone (PairedList.vue)', () => {
    const src = FILES['components/PairedList.vue'];
    expect(src).not.toMatch(/\.chip\.chan-lan\s*\{/);
    expect(src).not.toMatch(/\.chip\.chan-cloud\s*\{/);
  });

  it('none of the four files alias the generic teal/brand tokens to mean 「哪条通道」', () => {
    // The exact shape of the bug this guard exists to catch: `var(--teal-ink)`/
    // `var(--brand)` used as a stand-in for channel identity instead of the
    // dedicated `--channel-*` pair. `.chip.in-use` (a DIFFERENT concept — "current
    // channel/online", reused identically regardless of which channel) still legally
    // uses `--teal-soft/--teal-ink`, so this checks the RETIRED selector shapes
    // specifically, not every use of the generic tokens in these files.
    for (const [name, src] of Object.entries(FILES)) {
      expect(src, `${name} must not gate teal on the cloud channel`).not.toMatch(
        /channel\s*===\s*'cloud'[^;]*\?\s*'chan-cloud'/,
      );
    }
  });

  it('every render site imports CHANNEL_VISUAL from lib/channel — the one definition', () => {
    expect(FILES['components/PairedList.vue']).toMatch(/CHANNEL_VISUAL[^;]*\}\s*from\s*'\.\.\/\.\.\/lib\/channel'/);
    expect(FILES['components/PairingModal.vue']).toMatch(/CHANNEL_VISUAL[^;]*\}\s*from\s*'\.\.\/\.\.\/lib\/channel'/);
    expect(FILES['components/ChannelCardHead.vue']).toMatch(
      /CHANNEL_VISUAL[^;]*\}\s*from\s*'\.\.\/\.\.\/lib\/channel'/,
    );
    expect(FILES['ConnDiagPage.vue']).toMatch(/CHANNEL_VISUAL[^;]*\}\s*from\s*'\.\.\/lib\/channel'/);
  });

  it('every render site actually RENDERS from CHANNEL_VISUAL in its template (no orphan import)', () => {
    // Import-without-use would be the façade shape this whole project keeps
    // getting bitten by — grep the template half, not just the import line.
    for (const [name, src] of Object.entries(RENDER_SITES)) {
      const tpl = src.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? '';
      expect(tpl, `${name} template must reference CHANNEL_VISUAL`).toContain('CHANNEL_VISUAL');
      expect(tpl, `${name} template must render an iconPath`).toContain('.iconPath');
    }
  });

  it('REQ-12-14: DevicesPage DELEGATES both channel identities — it does not drop them', () => {
    // The replacement for the old "DevicesPage renders an iconPath" probe. What
    // has to stay true is that BOTH cards get their identity from the one head
    // component; a page that quietly re-grew its own heading (or lost one card's
    // identity) is the regression this still catches.
    const tpl = (FILES['DevicesPage.vue'] ?? '').match(/<template>([\s\S]*)<\/template>/)?.[1] ?? '';
    expect(tpl, 'the page template must be findable').not.toBe('');
    expect(tpl).toContain('<ChannelCardHead channel="lan"');
    expect(tpl).toContain('<ChannelCardHead channel="cloud"');
    // …and it feeds each head the dot from that card's OWN derivation, so the two
    // heads cannot end up describing the same channel's health.
    expect(tpl).toContain(':dot="lanCard.dot"');
    expect(tpl).toContain(':dot="cloudCard.dot"');
  });
});

// 🔴 Reverse control (manually verified, see the delivery report — each file was
// independently taken through one red/green round trip; this just restates the
// method): at any one of the four files, swap the CHANNEL_VISUAL call back for a
// literal colour (e.g. swap PairedList.vue's
// `:class="CHANNEL_VISUAL[m.channel].css"`, icon included, back for
// `background: var(--teal-soft)`) → the "zero channel-colour literals" assertion
// above goes red for that file; changing it back restores green.
