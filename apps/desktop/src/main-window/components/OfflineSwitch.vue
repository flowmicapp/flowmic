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
  <label class="offline-switch" :title="S.dev_offline_hint">
    <input
      type="checkbox"
      :checked="offlineMode"
      :disabled="busy"
      :aria-label="S.dev_offline_hint"
      @change="onToggle"
    />
    <span>{{ S.dev_offline_toggle }}</span>
    <!-- The on-state truth line: while offline the channel chips go grey via
         the store's synthetic rows, but this sentence is the one that SAYS
         why (a silent grey page reads as a fault, not a choice). -->
    <span v-if="offlineMode" class="offline-active">{{ S.dev_offline_active }}</span>
  </label>
</template>

<style scoped>
.offline-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.offline-active {
  /* The devices page's existing amber status ink (.st-y), theme-aware. */
  color: var(--amber-ink);
  font-size: 12px;
}
</style>
