<script setup lang="ts">
// NR-109 (MAIN decision ①, 2026-09-26) — the `unverified` account card's way
// forward: resend the verification email from this PC.
//
// Rendered by CloudAccountLines.vue ONLY in the `unverified` phase. It owns its
// own small state (sending / last answer) so neither page that embeds the card
// has to thread a second action through; when the relay says the account is
// already verified it asks the card to read the account again (`recheck`, which
// CloudAccountLines forwards as its existing `retry`).
//
// Every sentence is decided in lib/verification-resend.ts; only `sent` may say a
// mail went out.
import { computed, ref } from 'vue';
import { S } from '../../lib/strings';
import { resendVerificationEmail } from '../../lib/bridge';
import { resendFeedback, type ResendRaw } from '../../lib/verification-resend';

const emit = defineEmits<{ (e: 'recheck'): void }>();

const sending = ref(false);
const last = ref<ResendRaw | null>(null);
const feedback = computed(() => (last.value === null ? null : resendFeedback(last.value)));

async function resend(): Promise<void> {
  if (sending.value) return;
  sending.value = true;
  last.value = null;
  try {
    last.value = await resendVerificationEmail();
  } finally {
    sending.value = false;
  }
  if (feedback.value?.recheck) emit('recheck');
}
</script>

<template>
  <div class="vr">
    <button class="btn ghost sm" type="button" :disabled="sending" @click="resend">
      {{ sending ? S.cloud_verify_resend_sending : S.cloud_verify_resend }}
    </button>
    <span v-if="feedback?.text" class="vr-fb" :class="feedback.tone" role="status">{{ feedback.text }}</span>
  </div>
</template>

<style scoped>
.vr { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; }
.vr-fb { line-height: 1.4; }
.vr-fb.ok { color: var(--green-ink); }
.vr-fb.warn { color: var(--amber-ink); }
</style>
