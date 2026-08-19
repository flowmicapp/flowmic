<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import ProbePanel from './ProbePanel.vue';
// 2026-08-19 §5-A — the built-in engine's model: is it here, how far along is
// the download, and where would you put the files by hand. It sits directly
// under the routing table because that table is where the built-in engine is
// chosen, and the card is the answer to 「I chose it — now what?」.
import LocalModelCard from './LocalModelCard.vue';
import { POLISH_STRENGTHS } from '@flowmic/protocol';
import { S } from '../../lib/strings';
import { SETTINGS_MSG } from '../../lib/strings/settings';
import {
  addDictEntry,
  addRouting,
  model,
  removeDictEntry,
  removeRouting,
  setPolishEnabled,
  setPolishStrength,
  setRefineEnabled,
  setPresetForRouting,
  sttPresets,
  updateRoutingField,
  type Routing,
} from '../settings-model';
import { fetchSidecarState } from '../../lib/bridge';
import {
  createProbeStore, PROBE_STT_PATH, runProbe, toRowView, watchHidden,
  type HiddenWatcher, type ProbeTransport,
} from '../../lib/probe-client';

// Preset id currently backing each routing row (best-effort match by endpoint).
function presetIdFor(index: number): string {
  const r = model.routings[index];
  const p = sttPresets.find((x) => x.engine === r?.engine_id && x.endpoint === r?.endpoint);
  return p?.id ?? '';
}

const newTerm = ref('');
function addTerm(): void {
  if (addDictEntry(newTerm.value)) newTerm.value = '';
}

// GA-12 — "test connection." One button, but one reading PER LANGUAGE ROW: the server
// resolves each language through the production §4 routing algorithm, so the
// probe tests the resolution as well as the endpoint. What is probed is exactly
// what the table above shows (the config travels in the request body).
const transport: ProbeTransport = {
  baseUrl: async (): Promise<string | null> => (await fetchSidecarState())?.endpoint ?? null,
};
const probe = createProbeStore(async () => {
  const routings: Routing[] = model.routings.map((r) => ({ ...r }));
  if (routings.length === 0) {
    return [toRowView(S.stt_title, { ok: false, code: 'STT_CONFIG_MISSING', message: S.probe_no_routing, latency_ms: 0 })];
  }
  const rows = [];
  for (const r of routings) {
    const label = `${r.language} · ${r.engine_id}`;
    rows.push(toRowView(label, await runProbe(PROBE_STT_PATH, { routings, language: r.language }, transport)));
  }
  return rows;
});

// Any edit voids the reading (a ✓ beside an endpoint the user just changed is a
// lie), and so does leaving the page — the main window uses v-show, so this
// section is never unmounted (see probe-client.watchHidden).
function editRouting(index: number, field: keyof Routing, value: string): void {
  probe.reset();
  updateRoutingField(index, field, value);
}
function pickPreset(index: number, presetId: string): void {
  probe.reset();
  setPresetForRouting(index, presetId);
}
function dropRouting(index: number): void {
  probe.reset();
  removeRouting(index);
}
function appendRouting(): void {
  probe.reset();
  addRouting();
}

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
    <h3>{{ S.stt_title }}</h3>
    <p class="hint">{{ S.stt_hint }}</p>

    <div class="card" style="margin-bottom:12px">
      <table class="tbl">
        <thead>
          <tr>
            <th style="width:22%">{{ S.col_language }}</th>
            <th style="width:34%">{{ S.stt_preset }}</th>
            <th>{{ S.col_endpoint }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in model.routings" :key="i">
            <td>
              <input class="input" :value="r.language" @change="editRouting(i, 'language', ($event.target as HTMLInputElement).value)" />
            </td>
            <td>
              <select class="input" :value="presetIdFor(i)" @change="pickPreset(i, ($event.target as HTMLSelectElement).value)">
                <option value="" disabled>{{ S.stt_engine_custom }} / {{ r.engine_id }}</option>
                <option v-for="p in sttPresets" :key="p.id" :value="p.id">{{ p.label }}</option>
              </select>
            </td>
            <td>
              <input class="input mono" :value="r.endpoint ?? ''" :placeholder="S.stt_builtin_no_endpoint"
                     @change="editRouting(i, 'endpoint', ($event.target as HTMLInputElement).value)" />
            </td>
            <td style="text-align:right">
              <button class="ops-del" :title="S.op_delete" @click="dropRouting(i)"><Icon name="trash" /></button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="stt-ops">
      <button class="btn ghost sm" @click="appendRouting"><Icon name="plus" />{{ S.stt_add_lang }}</button>
      <button class="btn ghost sm" :disabled="probe.state.running" @click="probe.run()">
        {{ probe.state.running ? S.probe_running : S.test_conn }}
      </button>
    </div>
    <ProbePanel :state="probe.state" @toggle="probe.toggle" />

    <LocalModelCard />

    <div class="sub-h">{{ S.polish_title }}
      <span class="muted" style="font-weight:400">{{ S.polish_hint }}</span>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="chkrow" @click="setPolishEnabled(!model.polishEnabled)">
        <span class="chk" :class="{ on: model.polishEnabled }"><Icon name="check" /></span>
        <div>
          <div>{{ S.polish_toggle }}</div>
          <div class="sub">{{ model.polishEnabled ? S.stt_sub_on : S.stt_sub_off_default }}</div>
        </div>
      </div>
      <!-- Card POLISH-CFG: the precondition, stated on the row itself — same
           treatment as refine_precondition below, deliberately not a new visual.
           The switch alone cannot say this: `stt.polish` answers on/off and the
           server derives its default from "is there a usable language model,"
           so without this line a user with no model sees a switch that is ON
           and does nothing. The fact comes from the SERVER (`capability.llm`);
           this side never infers it from an empty llm.config — see settings-model.ts. -->
      <div class="sub" style="padding:0 14px 12px" v-if="!model.llmCapabilityUsable">{{ S.polish_no_llm }}</div>
      <!-- Card C8: correction strength. NOT a fourth mode — a dial inside this
           same toggle, so the three-mode lock is untouched.

           🔴 Rendered DISABLED rather than hidden while polish is off. Hiding it
           would make the control appear only after the toggle is flipped, so a
           user could not see what they were about to get before getting it; and
           `setPolishStrength` deliberately still stores the choice, so turning
           polish off and on again returns the value they picked rather than a
           silently reset one.

           🔴 The hint states the TRADE, not a ranking. `smooth` is not "better":
           it gives up word-for-word fidelity for readability, and someone
           dictating a quotation needs that written down where they can read it
           BEFORE choosing. -->
      <div class="polish-strength" :class="{ off: !model.polishEnabled }">
        <div class="sub">{{ S.polish_strength_label }}</div>
        <div class="seg">
          <button
            v-for="s in POLISH_STRENGTHS"
            :key="s"
            class="pick"
            type="button"
            :class="{ on: model.polishStrength === s }"
            :disabled="!model.polishEnabled"
            @click="setPolishStrength(s)"
          >{{ s === 'smooth' ? S.polish_strength_smooth : S.polish_strength_strict }}</button>
        </div>
        <div class="sub note">{{ S.polish_strength_hint }}</div>
      </div>
    </div>

    <!-- GA-14 two-pass refine. The precondition is stated on the row itself:
         a second pass needs a BATCH engine, and a user whose routing is
         funasr/deepgram/openai-realtime would otherwise flip a switch that
         quietly does nothing. -->
    <div class="sub-h">{{ S.refine_title }}
      <span class="muted" style="font-weight:400">{{ S.refine_hint }}</span>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="chkrow" @click="setRefineEnabled(!model.refineEnabled)">
        <span class="chk" :class="{ on: model.refineEnabled }"><Icon name="check" /></span>
        <div>
          <div>{{ S.refine_toggle }}</div>
          <div class="sub">{{ model.refineEnabled ? S.stt_sub_on : S.stt_sub_off_default }}</div>
        </div>
      </div>
      <div class="sub" style="padding:0 14px 12px">{{ S.refine_precondition }}</div>
    </div>

    <div class="sub-h">{{ S.dict_title }} <span class="muted" style="font-weight:400">{{ SETTINGS_MSG.dictCount(model.dictionary.length, 300) }}</span></div>
    <div class="card" v-if="model.dictionary.length > 0">
      <div class="dict-row" v-for="d in model.dictionary" :key="d.term">
        <span class="term">{{ d.term }}</span>
        <span class="alias" v-if="d.aliases && d.aliases.length">{{ SETTINGS_MSG.dictAliases(d.aliases) }}</span>
        <span class="alias" v-else>{{ S.dict_no_alias }}</span>
        <button class="rm" :title="S.op_delete" @click="removeDictEntry(d.term)"><Icon name="x" /></button>
      </div>
    </div>
    <div class="term-input">
      <input class="input" v-model="newTerm" :placeholder="S.dict_add" @keyup.enter="addTerm" />
      <button class="btn ghost sm" @click="addTerm"><Icon name="plus" />{{ S.dict_add }}</button>
    </div>
  </div>
</template>

<style scoped>
.polish-strength { padding: 0 14px 12px; }
/* Same .seg/.pick vocabulary as TimelineClear's segmented control — this is the
   app's existing two-choice idiom, not a new visual. */
.polish-strength .seg { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 6px; }
.polish-strength .pick { border: 1px solid var(--line); background: transparent; color: var(--t2);
  border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.polish-strength .pick.on { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
/* Disabled rather than hidden while polish is off: the user can read what the
   choice means before turning the feature on. */
.polish-strength .pick:disabled { cursor: default; opacity: 0.55; }
.polish-strength.off { opacity: 0.7; }
.polish-strength .note { line-height: 1.6; }
.ops-del { color: var(--t3); width: 26px; height: 26px; border-radius: 7px; }
.ops-del:hover { color: var(--red); background: var(--line-soft); }
.ops-del .icon { width: 14px; height: 14px; }
.scope-note { font-size: 11.5px; color: var(--t3); line-height: 1.6; background: var(--surface-inset); border-radius: 8px; padding: 8px 11px; margin-bottom: 12px; }
</style>
