// REQ-12-14 — the channel card head, asserted ON THE RENDERED RESULT.
//
// This file exists because of the 0.2.53 law: "whenever the acceptance
// criterion is 'can the user actually read this sentence,' the assertion must
// land on the rendered result." DevicesPage.vue itself cannot be rendered in vitest (its
// cards are filled by onMounted over the Tauri bridge, so SSR shows the empty
// pre-fetch state — devices-info-panel.test.ts's header spells that out, and it
// is exactly why that file is a source-literal guard). Pulling the head into its
// own component with two plain props is what buys back a real render here.
//
// Render path: same as paired-list.test.ts / pairing-modal.test.ts — vitest's
// default SSR transform compiles the SFC into its SSR form, so
// `vue/server-renderer` is the matching runtime. No fetch, no mount hooks, so the
// markup below is the real head, not a placeholder.

import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import ChannelCardHead from './ChannelCardHead.vue';
import { CHANNEL_VISUAL, type ChannelId, type Dot } from '../../lib/channel';
import { channelStateWord } from '../../lib/channel-card-state';
import { S } from '../../lib/strings';
import { setLocale, UI_LOCALES } from '../../lib/strings/locale';

function render(channel: ChannelId, dot: Dot): Promise<string> {
  return renderToString(createSSRApp(ChannelCardHead, { channel, dot }));
}

/** Whether SOME element in `html` carries all of `tokens` in its class list.
 *
 *  Written as a token-set check rather than a substring/regex on the attribute
 *  because Vue's SSR emits the BOUND class before the static one
 *  (`class="lan chan-tile"`, not `class="chan-tile lan"`). A naive
 *  `/class="chan-tile[^"]*lan/` reads as「the tile carries the lan tint」and is
 *  in fact asserting an attribute-serialisation order — it would go red on a
 *  correct component the day Vue changed that order, and it went red here on the
 *  first run for exactly that reason. */
function hasClasses(html: string, ...tokens: string[]): boolean {
  for (const attr of html.match(/class="[^"]*"/g) ?? []) {
    const have = new Set(attr.slice(7, -1).split(/\s+/));
    if (tokens.every((t) => have.has(t))) return true;
  }
  return false;
}

describe('the head answers "which channel" in the rendered markup', () => {
  it('renders the channel NAME and its OWN icon path — the two cards differ in both', async () => {
    const lan = await render('lan', 'g');
    const cloud = await render('cloud', 'g');

    expect(lan).toContain(S.dev_chan_lan);
    expect(cloud).toContain(S.dev_chan_cloud);
    // Real, different silhouettes — not one glyph recoloured (owner 2026-08-01:
    // colour + icon combination). Comparing the rendered paths is what proves it; comparing
    // the source would only prove two different property names were typed.
    expect(lan).toContain(CHANNEL_VISUAL.lan.iconPath);
    expect(cloud).toContain(CHANNEL_VISUAL.cloud.iconPath);
    expect(lan).not.toContain(CHANNEL_VISUAL.cloud.iconPath);
    expect(cloud).not.toContain(CHANNEL_VISUAL.lan.iconPath);
    // The tint hook that selects the `--channel-*` pair travels with the icon.
    expect(hasClasses(lan, 'chan-tile', 'lan')).toBe(true);
    expect(hasClasses(cloud, 'chan-tile', 'cloud')).toBe(true);
    expect(hasClasses(lan, 'chan-tile', 'cloud')).toBe(false);
  });
});

describe('the head answers "is it reachable" with a WORD, not only a colour', () => {
  it('every dot puts its own readable word on screen', async () => {
    // owner's acceptance line "connectivity status must not require reading a
    // long sentence" is only met if the word is
    // actually IN the markup. A green class with no text would satisfy every
    // source-literal check and still leave the state colour-only.
    for (const dot of ['g', 'y', 'r', 'o'] as Dot[]) {
      const html = await render('lan', dot);
      expect(html, `dot ${dot} rendered no word`).toContain(channelStateWord(dot));
      // Pill and dot are classed from the SAME value, so they cannot disagree.
      expect(hasClasses(html, 'chan-state', dot), `pill not classed ${dot}`).toBe(true);
      expect(hasClasses(html, 'dot', dot), `dot not classed ${dot}`).toBe(true);
    }
  });

  it('🔴 the word is the CARD’s verdict — a different dot renders a different word', async () => {
    // The reverse control for "the pill is wired to the prop at all." A head that
    // hard-coded "ready" (已就绪) would pass every assertion above except this one.
    const up = await render('cloud', 'g');
    const down = await render('cloud', 'r');
    expect(up).toContain(S.dev_chan_state_ready);
    expect(up).not.toContain(S.dev_chan_state_down);
    expect(down).toContain(S.dev_chan_state_down);
    expect(down).not.toContain(S.dev_chan_state_ready);
  });

  it('reads in all four locales (a missing translation would render an empty pill)', async () => {
    for (const loc of UI_LOCALES) {
      setLocale(loc);
      const html = await render('lan', 'o');
      expect(html, `${loc}: channel name missing`).toContain(S.dev_chan_lan);
      expect(html, `${loc}: state word missing`).toContain(S.dev_chan_state_off);
    }
    setLocale('zh-CN');
  });
});

describe('C-8 is honoured, not walked back', () => {
  it('no `.chan-badge` pill next to the state — the judgement C-8 made still holds', async () => {
    // C-8 skipped the badge here because it would sit beside the health signal and
    // compete with it. REQ-12-14 moved the identity tint to the far LEFT and the
    // health to the far RIGHT instead of stacking them, so the badge stays absent.
    const html = await render('lan', 'g');
    expect(html).not.toContain('chan-badge');
  });
});
