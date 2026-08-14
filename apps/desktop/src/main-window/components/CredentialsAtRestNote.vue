<script setup lang="ts">
// MAC-08 plan B — tell the truth that non-Windows hosts store pairing tokens
// and the Cloud Key as plaintext. Windows has real DPAPI, so this block must
// not render there.
//
// The platform arrives as a prop so tests can drive both sides without mocking
// Vite's build stamp. Production omits the prop and reads `hostPlatform()`.
//
// ⚠️ No HTML comments in the template: Vue SSR emits them into the HTML, and
// negative "must not appear" assertions would match the comment text.
import { computed } from 'vue';
import { S } from '../../lib/strings';
import {
  credentialsStoredPlaintext,
  hostPlatform,
  type HostPlatform,
} from '../../lib/credentials-at-rest';

const props = defineProps<{ platform?: HostPlatform | string }>();

const visible = computed(() =>
  credentialsStoredPlaintext(props.platform ?? hostPlatform()),
);
</script>

<template>
  <div
    v-if="visible"
    class="cred-plain-note"
    data-cred-plain-note
    role="note"
  >{{ S.dev_cred_plaintext_note }}</div>
</template>

<style scoped>
/* Own block, full width, no single-line ellipsis — "can the user actually read
   this" is a layout question, not a catalogue question (0.2.53). */
.cred-plain-note {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-inset);
  font-size: 12px;
  line-height: 1.55;
  color: var(--t3);
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  word-break: break-word;
}
</style>
