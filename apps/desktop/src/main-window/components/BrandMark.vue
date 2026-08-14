<script setup lang="ts">
// GA-34 — the FlowMic mark, inlined.
//
// The sidebar used a generic `mic` glyph from the icon set, which is a
// placeholder wearing the product's clothes. This is the real mark from the
// brand package (docs/ui-design/brand/), inlined rather than loaded as a file so
// the sidebar never renders a broken-image box while an asset resolves.
//
// The MICRO tier is the right source here (BRAND.md §1.1: micro for 16–24 px,
// mid for 32–48, full for 64+). The sidebar tile paints it at 14 px — scaling the
// full mark down to that size aliases its thin waves into mud, which is exactly
// what the tier rule exists to prevent.
//
// Rendered in `currentColor` on purpose: the tile behind it is the brand
// gradient, so a two-tone mark would fight it. The colour mark lives on the
// launcher/taskbar icons, which have no tile.
</script>

<template>
  <svg class="brand-mark" viewBox="0 0 280 280" role="img" aria-label="FlowMic">
    <rect x="92" y="20" width="96" height="156" rx="20" fill="currentColor" opacity="0.92" />
    <path
      d="M 56 140 Q 56 220 140 220 Q 224 220 224 140"
      fill="none"
      stroke="currentColor"
      stroke-width="14"
      stroke-linecap="round"
    />
    <rect x="133" y="220" width="14" height="46" fill="currentColor" />
    <rect x="104" y="258" width="72" height="14" rx="4" fill="currentColor" />
  </svg>
</template>

<style scoped>
/* Sized by the tile (.sidenav .brand .logo .icon), same as the glyph it replaced. */
.brand-mark { width: 100%; height: 100%; display: block; }
</style>
