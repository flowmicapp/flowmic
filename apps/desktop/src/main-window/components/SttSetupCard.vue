<!-- Card STT-SETUP (owner ruling 2026-08-28, item 1) — the dismissible first-run
     card that says 「this machine cannot turn speech into text yet」, names the
     pack it would fetch for the language this machine's owner probably speaks,
     and gets it moving in ONE press.

     ── THE FACTS IT READS ───────────────────────────────────────────────────
     `lib/stt-setup-card.ts` — the whole decision, out of here so the rule is
     unit-testable and so this file cannot grow a second answer to 「show it or
     not」. The card renders; it does not judge.

     ── WHAT IT IS NOT ───────────────────────────────────────────────────────
     NOT MODAL, and it shares the slot above the pages with AccessibilityNotice
     / LocalModelNotice / LlmSetupCard. It is 并列 with the LLM card by the
     owner's word — the two sit side by side in one row on a wide window.

     🔴 WHILE THIS CARD IS UP, LocalModelNotice IS SUPPRESSED (in App.vue, with
     the reasoning written there). Both would otherwise be true at once on a
     fresh install and would say the same thing twice, one of them without an
     action.

     🔴 TWO SENTENCES, NEVER MERGED (owner, verbatim: 「局域网模式下本地转录不可用
     ——云端中继不受影响——两句不许混」). One says what stops working; the other
     says what does not. Merging them into a hedged single sentence is how a
     first-run reader concludes the product is broken. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { S } from '../../lib/strings';
import { modelStore, startModelDownload } from '../../lib/model-client';
import { formatMbCoarse } from '../../lib/model-status';
import { endonymFor } from '../../lib/spoken-langs';
import { focusLocalModelCard } from '../../lib/model-card-focus';
import { jumpToSettingsSection } from '../../lib/settings-section-jump';
import { dismissSttSetupCard, sttSetupCardView } from '../../lib/stt-setup-card';

const view = computed(() => sttSetupCardView());

/** Set only when the START itself was refused. `null` is not 「fine」, it is
 *  「nothing has been claimed」 — the button never reports success on its own,
 *  because success is the progress block in the model card, not this press. */
const startFailed = ref<string | null>(null);

async function downloadAndShow(): Promise<void> {
  const pack = view.value.pack;
  if (pack === null) return;
  startFailed.value = null;
  // Passing the language is what makes 「下载完成后自动可使用」 true without a
  // second step: the server records the per-language SELECTION at download
  // start, so the resolve ladder picks this pack the moment its files land.
  await startModelDownload(pack.model_id, view.value.language);
  if (modelStore.actionError !== null) {
    startFailed.value = modelStore.actionError;
    return;
  }
  // Only now — a jump on a refused start would take the reader somewhere that
  // shows nothing happening and let them conclude it worked.
  jumpToSettingsSection('stt');
  focusLocalModelCard(view.value.language);
}
</script>

<template>
  <!-- role=status, not alert — a standing condition, acted on when the reader
       likes (same choice as the three sibling strips). -->
  <section v-if="view.show" class="stt-setup" role="status" data-testid="stt-setup-card">
    <div class="ss-head">{{ S.stt_setup_title }}</div>
    <p class="ss-body">{{ S.stt_setup_limit_local }}</p>
    <p class="ss-body">{{ S.stt_setup_limit_cloud }}</p>
    <div class="ss-facts">
      <span class="ss-label">{{ S.stt_setup_lang }}</span>
      <span class="chip">{{ endonymFor(view.language) }}</span>
    </div>
    <div class="ss-facts" v-if="view.pack">
      <span class="ss-label">{{ S.stt_setup_pack }}</span>
      <span class="mono ss-id">{{ view.pack.model_id }}</span>
      <span class="chip" v-if="view.pack.bytes_total !== null">
        {{ formatMbCoarse(view.pack.bytes_total) }}
      </span>
    </div>
    <div class="ss-acts">
      <button class="btn pri" type="button" data-testid="stt-setup-download"
              :disabled="modelStore.busy === 'download'" @click="downloadAndShow">
        {{ modelStore.busy === 'download' ? S.model_starting : S.stt_setup_download }}
      </button>
      <button class="btn ghost sm" type="button" @click="dismissSttSetupCard()">
        {{ S.stt_setup_dismiss }}
      </button>
    </div>
    <!-- The press was refused, and the reason is the server's own words. Never
         swallowed: a button that did nothing and said nothing is the defect
         this repo names 「静默失败」. -->
    <p v-if="startFailed" class="ss-fail" role="alert">
      {{ S.model_action_failed }} <span class="mono">{{ startFailed }}</span>
    </p>
  </section>
</template>

<style scoped>
/* Brand-soft, not amber, and the colour is the sentence: nothing is broken —
   a file has not been fetched yet. Same vocabulary as the LLM card it sits
   beside, because the two are 并列 and a different colour would rank them. */
.stt-setup {
  background: var(--brand-soft);
  border: 1px solid var(--line);
  border-radius: var(--r12);
  padding: 12px 14px;
  margin-bottom: 16px;
}
.ss-head { font-size: 13px; font-weight: 700; color: var(--t1); }
.ss-body { margin-top: 6px; font-size: 12px; line-height: 1.6; color: var(--t2); }
.ss-facts { margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ss-label { font-size: 12px; color: var(--t2); }
/* The id is what a support conversation needs; it must not out-shout the
   sentences above it (same demotion the model card gives it). */
.ss-id { font-size: 11px; color: var(--t2); word-break: break-all; }
.ss-acts { margin-top: 10px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ss-fail { margin-top: 8px; font-size: 12px; line-height: 1.6; color: var(--red-ink); }
</style>
