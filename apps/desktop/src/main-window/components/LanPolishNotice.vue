<!-- Card NR-123 (owner 2026-09-29, docs/decisions/2026-09-29-owner-lan-polish-hint-and-testflight.md)
     — the quiet line on the Local-LAN card: this computer has no usable AI model,
     so polish for phones on the local network is off. One button jumps to the
     language-model section, where the fix is.

     ── THE ONE FACT IT READS ────────────────────────────────────────────────
     `model.llmCapabilityUsable` — the SERVER's `capability.llm` (card
     POLISH-CFG), the same boolean LlmSetupCard.vue and the language-model
     section read. Desktop settings are pulled from the LAN server
     (src-tauri/src/shell/settings_route.rs `settings_list`, 「hydrate from the
     LAN server」), so on this card that fact is the
     local service's own answer, which is exactly the server the phone's LAN
     polish runs on. Never `model.llm.endpoint === ''`: see LlmSetupCard.vue.

     ── WHY IT IS NOT THE SETUP CARD ────────────────────────────────────────
     LlmSetupCard is a first-run door and is put away for good once dismissed.
     This line has no dismissal on purpose: it states a standing fact about the
     channel the card describes, and it goes away by itself the moment a model
     is set up (`usable` flips to true on the next settings:list).
     `true` is the pre-first-sync value, so a configured PC never flashes it.

     ── NR-130: THE SECOND FACT ─────────────────────────────────────────────
     `model.llmModelRejected` — the server's `capability.llm.rejected`: a model
     IS set up, and its provider refused it the last time a phone's polish ran
     (server-core stt/llm-reject-latch.ts). Same place, same button, its own
     sentence: "not set up" and "refused" have the same fix location but are
     different things to say. It clears when the model settings change or a
     later polish goes through (the server pushes settings:updated either way). -->
<script setup lang="ts">
import { S } from '../../lib/strings';
import { model } from '../settings-model';
import { jumpToSettingsSection } from '../../lib/settings-section-jump';
</script>

<template>
  <div v-if="!model.llmCapabilityUsable || model.llmModelRejected" class="lan-polish" role="status" data-testid="lan-polish-notice">
    <span class="lp-text">{{ model.llmCapabilityUsable ? S.dev_lan_polish_model_rejected : S.dev_lan_polish_no_model }}</span>
    <button class="btn ghost sm" type="button" data-jump="llm" @click="jumpToSettingsSection('llm')">
      {{ S.llm_setup_go_llm }}
    </button>
  </div>
</template>

<style scoped>
/* Quiet on purpose: nothing is broken, the phone's text still arrives. */
.lan-polish { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; line-height: 1.5; color: var(--t3); }
.lp-text { flex: 1 1 auto; min-width: 0; }
</style>
