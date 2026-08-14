// C-8 (owner 2026-08-01 unified channel visual identity, closing round): the connection-diagnostics page's
// per-channel row used to be plain text (`{{ row.label }}`) — no colour, no icon,
// nothing telling the LAN row from the cloud row apart except its fixed position
// in the `[lanState, cloudState]` array. Now it goes through the ONE definition
// (lib/channel.ts's CHANNEL_VISUAL + tokens.css's `.chan-badge.<css>`), same shape
// TimelinePage.vue uses.
//
// Render path: SSR, same technique as pairing-modal.test.ts / paired-list.test.ts.
// ConnDiagPage.vue makes every bridge/store call inside onMounted, which SSR does
// NOT run — but the template does not need it to: `channelRow` is a pure computed
// over `connByChannel` (a reactive object that starts life as `{}`), so both rows
// render in their honest "unknown" pre-fetch state without any bridge stub. That is
// enough to prove the badge markup and the two distinct icon shapes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import ConnDiagPage from './ConnDiagPage.vue';
import { S } from '../lib/strings';

/** The rendered page with HTML COMMENTS STRIPPED.
 *
 *  Vue's SSR renderer emits `<!-- … -->` template comments verbatim, and this page now
 *  carries a large commented-out block (the hidden focus probe) plus prose explaining the
 *  retired "primary channel" chip. Every "X is absent from the screen" assertion below
 *  must be blind to those, or it is measuring the comment rather than the page — the
 *  sibling file timeline-data-group.test.ts hit exactly that and went red against
 *  correct code. The positive assertions are unaffected: stripping comments never
 *  invents markup. */
async function render(): Promise<string> {
  const raw = await renderToString(createSSRApp(ConnDiagPage));
  return raw.replace(/<!--[\s\S]*?-->/g, '');
}

describe('ConnDiagPage channel rows (C-8, one definition)', () => {
  it('renders a `.chan-badge` per channel row — a REAL positive probe', async () => {
    const html = await render();
    // Vue's SSR renderer puts the :class binding BEFORE the static class attr.
    expect(html).toContain('class="lan chan-badge"');
    expect(html).toContain('class="cloud chan-badge"');
  });

  it('the LAN and cloud rows carry REAL different icon shapes', async () => {
    const html = await render();
    const lanBadge = html.match(/class="lan chan-badge"[\s\S]*?<\/span>/)?.[0] ?? '';
    const cloudBadge = html.match(/class="cloud chan-badge"[\s\S]*?<\/span>/)?.[0] ?? '';
    expect(lanBadge).not.toBe('');
    expect(cloudBadge).not.toBe('');
    expect(lanBadge).toContain('<circle');
    expect(cloudBadge).not.toContain('<circle');
    expect(lanBadge).not.toBe(cloudBadge);
  });

  it('the health dot stays a SEPARATE fact from the channel identity badge', async () => {
    // "is it reachable" and "which channel" must not collapse into one signal — the dot right
    // before the badge is untouched by this change (still `row.known`/`row.up`
    // driven), only the label next to it grew an icon+colour identity.
    const html = await render();
    expect(html).toMatch(/<span class="o dot"[^>]*><\/span>\s*<span class="lan chan-badge"/);
    expect(html).toMatch(/<span class="o dot"[^>]*><\/span>\s*<span class="cloud chan-badge"/);
  });

  it('never draws a channel-identity hex literal', async () => {
    const html = await render();
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});

// 🔴 Reverse control (verified manually once then reverted, see the delivery
// report): temporarily change ConnDiagPage.vue's `CHANNEL_VISUAL[row.id]` to a
// constant `CHANNEL_VISUAL.cloud` (both rows get the same badge) → the "REAL
// different icon shapes" test goes red (lanBadge has no <circle>); reverting
// it restores green.

describe('ConnDiagPage.vue source consumes the one definition', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./ConnDiagPage.vue', import.meta.url)), 'utf8');

  it('imports CHANNEL_VISUAL instead of drawing its own colour', () => {
    expect(SRC).toContain('CHANNEL_VISUAL');
    expect(SRC).toMatch(/CHANNEL_VISUAL\[row\.id\]\.css/);
    expect(SRC).toMatch(/CHANNEL_VISUAL\[row\.id\]\.iconPath/);
  });
});

// ── owner 2026-08-02 UI batch 1 ① "primary channel" badge retired ──────────────────────────────
//
// A DELETION, so the assertions are negative — plus one positive control, because a
// negative alone would also pass on a page that renders nothing at all (card G13's
// rule ②: a negative assertion must come with its own positive control).
describe('the "primary channel" chip is retired from the diagnostics page', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./ConnDiagPage.vue', import.meta.url)), 'utf8');

  it('the rendered channel rows carry no primary chip', async () => {
    const html = await render();
    expect(html).not.toContain('chip in-use');
    // Positive control: the rows themselves ARE on screen, so the zero above is about the chip
    // and not about an empty render.
    expect(html).toContain('class="lan chan-badge"');
    expect(html).toContain('class="cloud chan-badge"');
  });

  it('`primary` is gone from the row shape, not merely hidden by a v-if', () => {
    // A `v-if="false"`-style hide would keep the value flowing and let the next edit
    // resurrect it by accident. The derivation itself no longer reads it.
    expect(SRC).not.toContain('snap?.primary');
    expect(SRC).not.toContain('row.primary');
    expect(SRC).not.toContain('dev_chan_in_use');
  });

  it('the MECHANISM is documented as surviving — removing the UI badge ≠ deleting the mechanism', () => {
    // The one thing this card must not be read as having done. If a later round deletes
    // `Admission::primary()` on the strength of "the UI stopped using it", this anchor
    // is what should have stopped it.
    expect(SRC).toContain('Admission::primary()');
    expect(SRC).toContain('primary-channel-ui-retired-mechanism-inventory');
  });
});

// ── owner 2026-08-02 UI batch 1 ④: focus probe temporarily hidden (code stays, must not be deleted) ────────────────
describe('the focus probe is HIDDEN, not deleted', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./ConnDiagPage.vue', import.meta.url)), 'utf8');

  it('nothing about the probe reaches the screen', async () => {
    const html = await render();
    expect(html).not.toContain(S.diag_focus_probe);
    expect(html).not.toContain(S.diag_probe_start);
    // Positive control: the page around it still renders.
    expect(html).toContain(S.diag_channels);
  });

  it('the code is still in the file, with the restore condition written beside it', () => {
    // "code stays, the restore condition X is written in place" — the whole
    // point of hiding rather than deleting is that the next person can put it
    // back without reconstructing it.
    expect(SRC).toContain('function startProbe()');
    expect(SRC).toContain('focusDiagnostic()');
    // 🔴 Re-anchored 2026-08-14: this read '恢复条件' until the English-ization
    // translated the comment it was pointing at, and the test went red on a
    // change that altered nothing about the code it guards. The assertion is
    // about a PROMISE being written down next to the hidden code — so it must
    // anchor on the promise, in whatever language the file is written in.
    expect(SRC).toContain('restore conditions');
    // …and the ten strings it needs are deliberately still in the catalogue.
    expect(Object.keys(S)).toContain('diag_focus_probe');
    expect(Object.keys(S)).toContain('diag_probe_paste_hint');
  });
});

// REQ-12-12 — local STT/LLM section (one-shot probe-client, not a resident light)
describe('REQ-12-12 ConnDiag engine status section', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./ConnDiagPage.vue', import.meta.url)), 'utf8');

  it('the section heading reaches the screen (SSR resting face)', async () => {
    const html = await render();
    expect(html).toContain(S.diag_engines);
    // Positive control: channel section still there.
    expect(html).toContain(S.diag_channels);
  });

  it('wires probe-client (STT + LLM paths) and short-circuits empty LLM', () => {
    expect(SRC).toContain('PROBE_STT_PATH');
    expect(SRC).toContain('PROBE_LLM_PATH');
    expect(SRC).toContain('isLlmEndpointConfigured');
    expect(SRC).toContain('configMissingRow');
    expect(SRC).toContain('S.probe_no_llm');
    // D3: one-shot — leaving resets; no localStorage of the reading.
    expect(SRC).toContain('engineProbe.reset()');
    expect(SRC).toContain('S.probe_hint');
  });
});
