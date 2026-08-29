<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ProbePanel from './ProbePanel.vue';
import { S } from '../../lib/strings';
import { llmProtocolLabel, presetGroupLabel } from '../../lib/preset-group-label';
import {
  llmPresetSections, llmPresetUnresolved, model, setLlmPreset, updateLlmField,
  type LlmConfigModel,
} from '../settings-model';
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
// ⚠️ `preset_id` is excluded at the type level — it is not a config field and is
// not edited by hand; picking a preset goes through [pickPreset]. See
// updateLlmField, which moves the dropdown to `custom` on every call.
function editField(field: Exclude<keyof LlmConfigModel, 'preset_id'>, value: string): void {
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
    <!-- Card LLM-NOTICE (owner 2026-08-25 D2): the STANDING hint on this section —
         translate / organize are NOT SUPPORTED until a model is configured. One
         subject, one sentence: AI polish has its own line beside its own switch
         (polish_no_llm) and the scenario card has its own (its terms still work).
         Gated on the SERVER fact, same as those two — never on an empty endpoint. -->
    <p v-if="!model.llmCapabilityUsable" class="hint llm-standing" role="status">{{ S.llm_modes_unsupported }}</p>

    <div class="field">
      <label>{{ S.llm_preset }}</label>
      <select class="input" :value="model.llm.preset_id" @change="pickPreset(($event.target as HTMLSelectElement).value)">
        <!-- 🔴 DEFECT ① (owner 2026-08-28). A `<select>` whose value matches no
             `<option>` does not render blank — it renders THE FIRST OPTION. So a
             machine that had never been configured sat here naming the first
             vendor in the catalogue, with four empty fields underneath.

             🔴 THE `:value` IS THE STORED ID, NOT `""`, AND THAT IS THE WHOLE
             TRICK. Binding `""` would only cover the fresh-install case; a
             preset_id from a build that no longer has that row (downgrade,
             hand-edited cache) still matches nothing and the browser would fall
             back to the first option again. Echoing whatever is stored makes
             this row the one that matches, in both cases.
             `disabled` so it can be shown but never chosen; nothing is rewritten
             on render — the same rule the STT language cell keeps. -->
        <option v-if="llmPresetUnresolved()" :value="model.llm.preset_id" disabled>{{ S.preset_choose }}</option>
        <!-- Sections come from the catalogue (llmPresetsByGroup), not from a
             grouping this page invents. Vendor names are proper nouns and are
             never translated; only the headings are. -->
        <optgroup v-for="s in llmPresetSections" :key="s.group" :label="presetGroupLabel(s.group)">
          <option v-for="p in s.presets" :key="p.id" :value="p.id">{{ p.label }}</option>
        </optgroup>
      </select>
    </div>

    <div class="field">
      <label>{{ S.llm_protocol }}</label>
      <!-- Defect ③: this used to print the raw wire values at the user. The
           VALUE is still the enum — it is what `llm.config.protocol` stores and
           what the server's adapter switch reads. Only the label is human. -->
      <select class="input" :value="model.llm.protocol" @change="editField('protocol', ($event.target as HTMLSelectElement).value)">
        <option value="openai-compatible">{{ llmProtocolLabel('openai-compatible') }}</option>
        <option value="anthropic">{{ llmProtocolLabel('anthropic') }}</option>
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
