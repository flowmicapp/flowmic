<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ProbePanel from './ProbePanel.vue';
import { S } from '../../lib/strings';
import { llmPresets, model, setLlmPreset, updateLlmField, type LlmConfigModel } from '../settings-model';
import { fetchSidecarState } from '../../lib/bridge';
import {
  createProbeStore, PROBE_LLM_PATH, runProbe, toRowView, watchHidden,
  type HiddenWatcher, type ProbeTransport,
} from '../../lib/probe-client';

// GA-12 — "test connection." The config under test is sent IN THE REQUEST, so what is
// probed is exactly what the boxes above show — including edits not yet round-
// tripped through the server.
const transport: ProbeTransport = {
  baseUrl: async (): Promise<string | null> => (await fetchSidecarState())?.endpoint ?? null,
};
const probe = createProbeStore(async () => [
  toRowView(S.llm_title, await runProbe(PROBE_LLM_PATH, {
    protocol: model.llm.protocol,
    endpoint: model.llm.endpoint,
    api_key: model.llm.api_key,
    model: model.llm.model,
  }, transport)),
]);

// A reading is only true of the config it was taken against: any edit voids it.
function editField(field: keyof LlmConfigModel, value: string): void {
  probe.reset();
  updateLlmField(field, value);
}
function pickPreset(id: string): void {
  probe.reset();
  setLlmPreset(id);
}

// …and leaving the page voids it too (the main window uses v-show, so this
// section is never unmounted — see probe-client.watchHidden).
const root = ref<HTMLElement | null>(null);
let watcher: HiddenWatcher | null = null;
onMounted(() => {
  if (root.value) watcher = watchHidden(root.value, () => probe.reset());
});
onBeforeUnmount(() => watcher?.disconnect());
</script>

<template>
  <div class="set-sec" ref="root">
    <!-- owner ⑤: scope statement — these settings configure the LAN server only -->
    <div class="scope-note">{{ S.settings_scope_lan }}</div>
    <h3>{{ S.llm_title }}</h3>
    <p class="hint">{{ S.llm_hint }}</p>

    <div class="field">
      <label>{{ S.llm_preset }}</label>
      <select class="input" :value="model.llm.preset_id" @change="pickPreset(($event.target as HTMLSelectElement).value)">
        <option v-for="p in llmPresets" :key="p.id" :value="p.id">{{ p.label }}</option>
      </select>
    </div>

    <div class="field">
      <label>{{ S.llm_protocol }}</label>
      <select class="input" :value="model.llm.protocol" @change="editField('protocol', ($event.target as HTMLSelectElement).value)">
        <option value="openai-compatible">openai-compatible</option>
        <option value="anthropic">anthropic</option>
      </select>
    </div>

    <div class="field">
      <label>{{ S.llm_endpoint }}</label>
      <input class="input mono" :value="model.llm.endpoint" @change="editField('endpoint', ($event.target as HTMLInputElement).value)" />
    </div>

    <div class="field">
      <label>{{ S.llm_model }}</label>
      <input class="input" :value="model.llm.model" @change="editField('model', ($event.target as HTMLInputElement).value)" />
    </div>

    <div class="field">
      <label>{{ S.llm_apikey }}</label>
      <input class="input" type="password" :value="model.llm.api_key" :placeholder="S.llm_apikey_ph"
             @change="editField('api_key', ($event.target as HTMLInputElement).value)" />
    </div>

    <button class="btn ghost sm" :disabled="probe.state.running" @click="probe.run()">
      {{ probe.state.running ? S.probe_running : S.test_conn }}
    </button>
    <ProbePanel :state="probe.state" @toggle="probe.toggle" />
  </div>
</template>

<style scoped>
.scope-note { font-size: 11.5px; color: var(--t3); line-height: 1.6; background: var(--surface-inset); border-radius: 8px; padding: 8px 11px; margin-bottom: 12px; }
</style>
