<!-- The main window's one-time word about the built-in speech model
     (design book 2026-08-19-local-model-onboarding-design.md §5-B).

     ── WHY IT EXISTS AT ALL ─────────────────────────────────────────────────
     §2-1: 「在能知道的最早时刻告知，而不是在最坏的时刻失败」. The worst moment is
     the one the product had until today — the user holds the button, speaks a
     whole sentence, and only then learns that the engine they picked has no
     model. Everything needed to say so was knowable the moment the app opened.

     ── WHAT IT IS NOT ───────────────────────────────────────────────────────
     🔴 NOT MODAL. §5-B: 「不许挡住产品」. It is a strip above the pages — the
     same slot AccessibilityNotice occupies — with ONE action and a dismissal
     that is remembered for the session. Blocking a product to talk about a file
     is not an acceptable trade, and a notice that cannot be put away becomes a
     dialog with extra steps.

     🔴 NOT SHOWN WHEN WE DO NOT KNOW. `shouldOfferModelSetup` renders nothing
     while the local service has not answered: offering to fetch 228 MB on the
     strength of a failed HTTP GET is the 「不知道 vs 没有」 conflation this repo
     hunts, and it would fire on every launch during the seconds before the
     sidecar is up. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { S } from '../../lib/strings';
import { dismissModelNotice, modelStore, startModelPolling } from '../../lib/model-client';
import { anyModelReady, builtinEngineSelected, shouldOfferModelSetup } from '../../lib/model-status';
import { model } from '../settings-model';
import { navigateMain } from '../../lib/bridge';

/** 🔴 THE ONE POLLER FOR THIS WINDOW LIVES HERE, and that is a wiring decision
 *  worth stating: this component is mounted unconditionally by App.vue (its own
 *  visibility is a `v-if` INSIDE it), while the settings card is behind a page
 *  the user may never open. Hanging the poll off the card would mean the notice
 *  could only appear after somebody had already gone looking — which is the one
 *  thing §2-1 is against. The card reads the same store and starts no second
 *  poller; `modelStore` is module state precisely so the two cannot disagree. */
let stop: (() => void) | null = null;
onMounted(() => { stop = startModelPolling(); });
onUnmounted(() => { stop?.(); stop = null; });

const show = computed(() =>
  shouldOfferModelSetup({
    builtinSelected: builtinEngineSelected(model.routings),
    // LM-CAT: ANY ready pack quiets the notice. A machine whose user speaks
    // French and downloaded only the French pack has a working built-in
    // engine — nagging it that "the model" (the legacy SenseVoice row) is
    // absent would be a true sentence about the wrong subject.
    state: modelStore.status === null
      ? null
      : anyModelReady(modelStore.status)
        ? 'ready'
        : modelStore.snapshot?.state ?? null,
    dismissed: modelStore.noticeDismissed,
  }),
);

function openSettings(): void {
  navigateMain('settings');
}
</script>

<template>
  <!-- role=status, not alert: a standing condition the reader may act on when
       they like. Same choice, same reason as AccessibilityNotice. -->
  <section v-if="show" class="model-note" role="status">
    <div class="mn-head">{{ S.model_notice_title }}</div>
    <!-- The 「why there is a download at all」 clause is in this sentence and may
         not be trimmed out of it (shard note ④): a network request the user did
         not expect is exactly what this replaces. -->
    <p class="mn-body">{{ S.model_notice_body }}</p>
    <div class="mn-acts">
      <button class="btn pri" type="button" @click="openSettings">{{ S.model_notice_open }}</button>
      <button class="btn ghost sm" type="button" @click="dismissModelNotice()">
        {{ S.model_notice_dismiss }}
      </button>
    </div>
  </section>
</template>

<style scoped>
/* Amber, not red, and the colour is part of the sentence: nothing is broken and
   nothing was lost — a file has not been fetched yet. The same vocabulary the
   accessibility strip and the `cached` face use. */
.model-note {
  background: var(--amber-soft);
  border: 1px solid var(--amber-line);
  border-radius: var(--r12);
  padding: 12px 14px;
  margin-bottom: 16px;
}
.mn-head { font-size: 13px; font-weight: 700; color: var(--amber-ink); }
.mn-body { margin-top: 6px; font-size: 12px; line-height: 1.6; color: var(--t2); }
.mn-acts { margin-top: 10px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
</style>
