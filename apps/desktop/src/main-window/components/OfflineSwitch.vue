<!-- P7 (0.3.1, owner 2026-08-15) — the manual 「下线」 switch, devices-page
     entrance (the tray toggle is the other one; both go through the same Rust
     write path, shell::offline::apply, so they can never disagree).

     Its own component rather than lines in DevicesPage.vue: that file sits at
     its pinned 825-line translation-bloat baseline in verify/lint/file-size.mjs
     — one extra line fails the gate (precedent: ChannelCardHead.vue).

     The rendered state is ALWAYS the store's `offlineMode`, which is written
     only from Rust facts (the OFFLINE_STATE push + the offline_state seed) —
     the checkbox never renders the click's intention. While a toggle is in
     flight the control disables instead of guessing. -->
<script setup lang="ts">
import { ref } from 'vue';
import { setOfflineMode } from '../../lib/bridge';
import { S } from '../../lib/strings';
import { offlineMode } from '../store';

const busy = ref(false);

async function onToggle(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const applied = await setOfflineMode(!offlineMode.value);
    // The command's return IS the post-apply Rust state; the OFFLINE_STATE
    // push confirms it a moment later. `null` = could not ask — leave the
    // store value alone rather than render a guess.
    if (applied !== null) offlineMode.value = applied;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <label class="offline-switch" :class="{ on: offlineMode, busy }" :title="S.dev_offline_hint">
    <!-- P7b — the real checkbox STAYS and is only visually hidden. It keeps the
         semantics (role, checked state, label), the keyboard (Tab + Space) and
         the AT announcement that a hand-built <div role="switch"> would have to
         re-implement and get subtly wrong. The capsule below is its skin. -->
    <input
      type="checkbox"
      class="sr"
      :checked="offlineMode"
      :disabled="busy"
      :aria-label="S.dev_offline_hint"
      @change="onToggle"
    />
    <span class="track" aria-hidden="true"><span class="knob"></span></span>
    <!-- ④ (owner 2026-08-21): the label follows the FACT, not the action.
         「下线」 next to an off-knob read as ambiguous — is it the state or the
         thing the knob does? While online the label says 「在线」; while offline
         the amber sentence below (which already opens with 「已下线」) IS the
         label, so the word is never printed twice. -->
    <span v-if="!offlineMode" class="lbl">{{ S.dev_online_label }}</span>
    <!-- The on-state truth line: while offline the channel chips go grey via
         the store's synthetic rows, but this sentence is the one that SAYS
         why (a silent grey page reads as a fault, not a choice). -->
    <span v-if="offlineMode" class="offline-active">{{ S.dev_offline_active }}</span>
  </label>
</template>

<!--
  P7b (owner, 2026-08-15: 「做成胶囊形状的开关，结合设计语言」).
  ── WHY A CAPSULE AT ALL ────────────────────────────────────────────────────
  A checkbox says 「tick this option」; this control says 「the machine is now
  off / on the network」 — a MODE with a live consequence, applied the instant
  it moves. A switch is the affordance for that, and `border-radius:999px` is
  already this app's capsule vocabulary (.chip, .pick, the segmented control,
  the addr pill), so the shape is borrowed, not invented.

  ── WHY THE ON-STATE IS AMBER AND NOT BRAND ─────────────────────────────────
  🔴 The considered choice, and the one worth arguing. `--brand` is what this
  UI fills when a state is the GOOD/primary one (.btn.pri, .pick.on, .tab.on).
  「已下线」 is the opposite: a deliberate self-imposed restriction where the
  phones can no longer reach this computer. This page already speaks amber for
  exactly that fact — the sentence one span to the right is `--amber-ink`, and
  amber is the devices page's existing 「attention, this is not the normal
  state」 ink (.st-y). Filling it brand would make 「下线」 look like the
  achievement, which is a status word telling a small lie.

  ── WHAT THE CONTROL MUST NOT DO ────────────────────────────────────────────
  ⚠️ It NEVER renders the click's intention. The knob's position is bound to
  the store's `offlineMode`, which is written only from Rust facts, and while a
  toggle is in flight the whole control is `busy` (dimmed, pointer-events off)
  instead of animating to a state nobody has confirmed. That is the same rule
  the script above already followed; the skin must not quietly break it, which
  is why `.on` is driven by `offlineMode` and not by `:checked`.
-->
<style scoped>
.offline-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: var(--t2);
}
.offline-switch.busy { cursor: default; opacity: .55; pointer-events: none; }

/* Visually hidden, NOT `display:none` — a hidden-by-display input leaves the
   focus order and stops being reachable by keyboard. */
.sr {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  clip-path: inset(50%);
  overflow: hidden; white-space: nowrap;
}

.track {
  position: relative;
  flex: none;
  width: 32px; height: 18px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  transition: background-color .16s ease, border-color .16s ease;
}
.knob {
  position: absolute;
  top: 2px; left: 2px;
  width: 12px; height: 12px;
  border-radius: 999px;
  background: var(--surface);
  box-shadow: var(--sh-sm);
  transition: transform .16s ease, background-color .16s ease;
}
.offline-switch.on .track { background: var(--amber); border-color: var(--amber); }
/* The knob keeps `--surface` in BOTH states — one token, no second colour to
   justify, and it lands on the right side of the contrast in each theme: the
   light surface reads on light-theme amber, the dark surface reads on the
   brighter amber the dark palette uses. */
.offline-switch.on .knob { transform: translateX(14px); }
.offline-switch.on .lbl { color: var(--t1); }

.offline-switch:hover .track { border-color: var(--line-strong); }
.offline-switch.on:hover .track { border-color: var(--amber); }
/* The focus ring rides the TRACK, because that is what the user sees as the
   control — the input it belongs to is one pixel wide. */
.sr:focus-visible + .track { outline: 2px solid var(--brand); outline-offset: 2px; }

.offline-active {
  /* The devices page's existing amber status ink (.st-y), theme-aware. */
  color: var(--amber-ink);
  font-size: 12px;
}
</style>
