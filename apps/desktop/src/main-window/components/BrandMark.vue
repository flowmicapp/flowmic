<script setup lang="ts">
// GA-34 — the FlowMic mark, inlined.
//
// The sidebar used a generic `mic` glyph from the icon set, which is a
// placeholder wearing the product's clothes. This is the real mark from the
// brand package (docs/ui-design/brand/), inlined rather than loaded as a file so
// the host never renders a broken-image box while an asset resolves.
//
// Brand 2.0 (owner 2026-08-21): shoulder-wave composition, MICRO tier — the
// same three-part reduction as the NANO16 frame (phone + cradle + two shoulder
// ticks; post and base are dropped below 24 px, see
// docs/ui-design/brand/svg/flowmic-mark-micro.svg). Weights are the nano
// weights scaled to the 280 grid; do not "correct" them toward the full mark —
// at tile size these ARE the correct proportions.
//
// Rendered in `currentColor` on purpose: the tile behind it supplies the
// color context, so a multi-tone mark would fight it. The color mark lives on
// the launcher/taskbar icons and the titlebar glyph, which carry their own
// palettes.
</script>

<template>
  <svg class="brand-mark" viewBox="0 0 280 280" role="img" aria-label="FlowMic">
    <rect x="92" y="52" width="96" height="150" rx="20" fill="currentColor" opacity="0.92" />
    <path
      d="M 60 160 Q 60 232 140 232 Q 220 232 220 160"
      fill="none"
      stroke="currentColor"
      stroke-width="28"
      stroke-linecap="round"
    />
    <path
      d="M 38 56 A 42 42 0 0 1 73 21"
      fill="none"
      stroke="currentColor"
      stroke-width="26"
      stroke-linecap="round"
      opacity="0.75"
    />
    <path
      d="M 242 56 A 42 42 0 0 0 207 21"
      fill="none"
      stroke="currentColor"
      stroke-width="26"
      stroke-linecap="round"
      opacity="0.75"
    />
  </svg>
</template>

<style scoped>
/* Sized by the host tile, same as the glyph it replaced. */
.brand-mark { width: 100%; height: 100%; display: block; }
</style>
