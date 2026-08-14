<script setup lang="ts">
// REQ-12-14 — the head BOTH devices-page channel cards wear.
//
// Why a component rather than two blocks of markup on the page: owner's design
// brief asks "side by side, are these two faces of one system, or two grey boxes
// that ignore each other". Two hand-written
// heads answer that question with a promise; one component answers it
// structurally — the two cards physically cannot drift in tile size, title
// weight, pill shape or state vocabulary, because there is one of each.
//
// It also makes the new claim TESTABLE ON THE RENDERED RESULT rather than on
// source literals. DevicesPage.vue cannot be rendered in vitest (its cards are
// filled by onMounted over the Tauri bridge, so SSR only ever shows the empty
// pre-fetch state — see devices-info-panel.test.ts's header). This component
// takes its entire state as two props, so `renderToString` shows the real head,
// and the 0.2.53 law applies: the acceptance assertion for "can the user actually
// read this sentence" must land on the rendered result.
//
// C-8 (owner 2026-08-01: colour + icon combination, must not rely on colour alone)
// is kept and strengthened, not walked back:
//   · the ICON is still the ONE definition — lib/channel.ts's CHANNEL_VISUAL, a
//     real per-channel silhouette (wifi arcs vs a cloud outline), never the same
//     glyph recoloured;
//   · the colour still comes only from tokens.css's `--channel-*-ink/-soft` pair
//     (this file carries zero colour literals — the drift fence in
//     channel-visual-one-definition.test.ts checks exactly that);
//   · what changed is WHERE the colour sits. C-8 deliberately skipped the
//     `.chan-badge` pill because it would have stood right next to the health dot
//     and competed with it. That judgement still holds and is still honoured —
//     there is no `.chan-badge` here. The tint now lives in the ICON TILE at the
//     far left (identity) while the health state moved into its own pill at the
//     far right (status). They are at opposite ends of the row and answer
//     different questions, which is the separation C-8 was protecting.

import { computed } from 'vue';
import { CHANNEL_LABEL, CHANNEL_VISUAL, type ChannelId, type Dot } from '../../lib/channel';
import { channelStateWord } from '../../lib/channel-card-state';

const props = defineProps<{
  /** Which channel this card IS — decides the icon, the label and the tint. */
  channel: ChannelId;
  /** THIS channel's own health, exactly as `deriveLanCard` / `deriveCloudCard`
   *  published it. Nothing here re-derives it; see lib/channel-card-state.ts. */
  dot: Dot;
}>();

/** The two lookup tables are read STRAIGHT from the template below, not copied
 *  into local computeds first: the drift fence in channel-visual-one-definition
 *  .test.ts greps each render site's template for `CHANNEL_VISUAL`, and a local
 *  alias would hide this file from the one guard that watches for a second
 *  colour definition appearing. Only the state word needs a computed, because it
 *  is a call rather than an index. */
const state = computed(() => channelStateWord(props.dot));
</script>

<template>
  <div class="chan-head">
    <span class="chan-tile" :class="CHANNEL_VISUAL[channel].css">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" v-html="CHANNEL_VISUAL[channel].iconPath"></svg>
    </span>
    <h3 class="chan-name">{{ CHANNEL_LABEL[channel] }}</h3>
    <!-- The glance answer: colour AND word, so the state survives greyscale and
         a quick scan alike. `dot` classes the pill and the dot from the SAME
         value — they cannot disagree. -->
    <span class="chan-state" :class="dot">
      <span class="dot" :class="dot"></span>{{ state }}
    </span>
  </div>
</template>

<style scoped>
/* One row, three jobs, left to right: WHICH channel (tile) · its NAME · its
   STATE. The hairline under it separates "what this card is" from "this card's
   details", which is what the flat pre-REQ-12-14 card had no way of saying. */
.chan-head { display: flex; align-items: center; gap: 10px;
  padding-bottom: 11px; margin-bottom: 11px; border-bottom: 1px solid var(--line-soft); }

/* The identity tile. Soft channel fill + ink icon — the `-soft` half of the
   channel pair that C-8 left unused on this page (see the header for why it is
   allowed here and was not allowed beside the dot). */
.chan-tile { flex: none; width: 30px; height: 30px; border-radius: 9px;
  display: inline-flex; align-items: center; justify-content: center; }
.chan-tile .icon { width: 16px; height: 16px; stroke-width: 2.1; }
.chan-tile.lan { background: var(--channel-lan-soft); color: var(--channel-lan-ink); }
.chan-tile.cloud { background: var(--channel-cloud-soft); color: var(--channel-cloud-ink); }

/* The channel name is a real title now (it used to be 14px inside an h3 that
   also carried the dot and the icon). It is one of exactly two fixed strings, so
   the ellipsis is a guard for long translations, not for user input. */
.chan-name { flex: 1 1 auto; min-width: 0; font-size: 14.5px; font-weight: 700;
  color: var(--t1); letter-spacing: .1px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.chan-state { flex: none; display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 600; padding: 3px 9px 3px 8px; border-radius: 99px; }
.chan-state.g { background: var(--green-soft); color: var(--green-ink); }
.chan-state.y { background: var(--amber-soft); color: var(--amber-ink); }
.chan-state.r { background: var(--red-soft); color: var(--red-ink); }
.chan-state.o { background: var(--off-chip-bg); color: var(--t3); }

/* The ONE piece of motion on this page (owner: 1-2 deliberate bits of motion are
   fine, avoid a permanent blink). It runs ONLY in the amber "connecting" state,
   which is by definition transient — a steady channel never animates, so nothing
   blinks at rest. tokens.css's
   prefers-reduced-motion block collapses it globally. */
@keyframes chan-state-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .32; } }
.chan-state.y .dot { animation: chan-state-pulse 1.4s ease-in-out infinite; }
</style>
