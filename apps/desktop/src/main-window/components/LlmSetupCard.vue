<!-- Card LLM-NOTICE (owner 2026-08-25, D2) — the dismissible first-run card:
     「this PC has no language model yet」, with two buttons that JUMP straight
     to the speech-model and language-model configurations.

     ── THE ONE FACT IT READS ────────────────────────────────────────────────
     `model.llmCapabilityUsable` — the SERVER's `capability.llm` (card
     POLISH-CFG). Never `model.llm.endpoint === ''`: the managed cloud default
     is env-gated and is not a settings row, so an empty endpoint on a working
     flowmic.app account would print this card to a user who needs nothing.

     ── WHAT IT IS NOT ───────────────────────────────────────────────────────
     NOT MODAL, and the same slot as LocalModelNotice / AccessibilityNotice:
     above the pages, true on whichever page the reader opens, with one
     dismissal that is REMEMBERED (lib/llm-setup-card.ts explains why this one
     persists while the model notice is per-session).

     NOT a fourth sentence about the model. The three facts (modes unsupported /
     polish not in effect / scenario terms still work) live where each one is
     acted on (LLM section, polish card, scenario card). This card is the
     first-run DOOR to the two configurations — its body says what works
     without a model and what does not, and asserts no switch's default value.

     🔴 NO 「read the guide」 LINK — the web section does not exist yet (0.3.24's
     dead-link defect would return). See lib/llm-setup-card.ts. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { S } from '../../lib/strings';
import { localKv } from '../../lib/storage';
import { model } from '../settings-model';
import { jumpToSettingsSection } from '../../lib/settings-section-jump';
import { readSetupCardDismissed, shouldShowLlmSetupCard, writeSetupCardDismissed } from '../../lib/llm-setup-card';

const dismissed = ref(readSetupCardDismissed(localKv));

const show = computed(() =>
  shouldShowLlmSetupCard({ usable: model.llmCapabilityUsable, dismissed: dismissed.value }),
);

function dismiss(): void {
  writeSetupCardDismissed(localKv);
  dismissed.value = true;
}
</script>

<template>
  <!-- role=status, not alert — a standing condition, acted on when the reader
       likes (same choice as the two sibling strips). -->
  <section v-if="show" class="llm-setup" role="status" data-testid="llm-setup-card">
    <div class="ls-head">{{ S.llm_setup_title }}</div>
    <p class="ls-body">{{ S.llm_setup_body }}</p>
    <div class="ls-acts">
      <button class="btn pri" type="button" data-jump="stt" @click="jumpToSettingsSection('stt')">
        {{ S.llm_setup_go_stt }}
      </button>
      <button class="btn pri" type="button" data-jump="llm" @click="jumpToSettingsSection('llm')">
        {{ S.llm_setup_go_llm }}
      </button>
      <button class="btn ghost sm" type="button" @click="dismiss">{{ S.llm_setup_dismiss }}</button>
    </div>
  </section>
</template>

<style scoped>
/* Brand-soft, not amber: nothing is broken and nothing is missing that the
   product cannot do without — this is a door, not a warning. */
.llm-setup {
  background: var(--brand-soft);
  border: 1px solid var(--line);
  border-radius: var(--r12);
  padding: 12px 14px;
  margin-bottom: 16px;
}
.ls-head { font-size: 13px; font-weight: 700; color: var(--t1); }
.ls-body { margin-top: 6px; font-size: 12px; line-height: 1.6; color: var(--t2); }
.ls-acts { margin-top: 10px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
</style>
