<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
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
  sttPresetSections,
  sttPresets,
  updateRoutingField,
  type Routing,
} from '../settings-model';
import { presetGroupLabel } from '../../lib/preset-group-label';
import { fetchSidecarState } from '../../lib/bridge';
import {
  createProbeStore, PROBE_STT_PATH, runProbe, toRowView, watchHidden,
  type HiddenWatcher, type ProbeTransport,
} from '../../lib/probe-client';
import { modelStore } from '../../lib/model-client';
import { BUILTIN_STT_ENGINE_ID, baseSpokenLang, readyPackForLang } from '../../lib/model-status';
import { endonymFor, FALLBACK_LANG, spokenLangCodes } from '../../lib/spoken-langs';
import { focusLocalModelCard } from '../../lib/model-card-focus';

// Preset id currently backing each routing row (best-effort match by endpoint).
function presetIdFor(index: number): string {
  const r = model.routings[index];
  const p = sttPresets.find((x) => x.engine === r?.engine_id && x.endpoint === r?.endpoint);
  return p?.id ?? '';
}

// ── the language cell (owner ruling 2026-08-27 §2-1) ─────────────────────────
//
// 🔴 IT WAS A FREE-TEXT `<input>` AND THAT IS WHY THE OWNER COULD NOT USE IT.
// Anything typed became a routing key, matched by string equality against what
// the phone announces — so a plausible-looking `zh-CN`, `en-US` or `Chinese`
// produced a row that was visible, editable, and unreachable by any utterance.
// A control that accepts values it cannot honour is not a lenient control, it
// is a control that lies about its own contract.
//
// The offered set is the SERVER's `spoken_langs` (the model catalog's eight
// keys, on the wire), never a list typed here — see lib/spoken-langs.ts.
const spokenCodes = computed(() => spokenLangCodes(modelStore.status?.spoken_langs));
const langOptions = computed(() =>
  spokenCodes.value.map((code) => ({ value: code, label: endonymFor(code) })),
);

/**
 * How a STORED value that is not one of the offered codes has to be shown.
 *
 * 🔴 THREE ANSWERS, NOT TWO, AND THE MIDDLE ONE IS THE WHOLE POINT. Every
 * install that has ever opened this page owns a `zh-CN` row (the desktop's old
 * placeholder), and since the 2026-08-27 router change that row WORKS — it is
 * region-normalised onto `zh`. Painting it red would be a fresh lie in the
 * opposite direction: a warning about a row that is doing its job. So:
 *
 *   · `offered`  — one of the eight, or the fallback row;
 *   · `regional` — not offered, but its base subtag is (`zh-CN`, `en-US`). It
 *     routes. Shown with its language's name AND its raw code, no badge, and
 *     picking the plain code from the list replaces it;
 *   · `unknown`  — nothing can match it. Raw code, red badge, and the sentence
 *     that says what to do.
 *
 * ⚠️ NONE of the three rewrites what is stored. The owner ruled that
 * explicitly, and it is the same rule the rest of this repo keeps: a settings
 * screen that silently corrects a value on render leaves the user unable to see
 * what their machine is actually configured with.
 */
type LangKind = 'offered' | 'regional' | 'unknown';
function langKind(language: string): LangKind {
  if (language === FALLBACK_LANG || spokenCodes.value.includes(language)) return 'offered';
  return spokenCodes.value.includes(baseSpokenLang(language)) ? 'regional' : 'unknown';
}
/** The extra `<option>` a non-offered stored value needs, so the select can
 *  DISPLAY what is stored. Without it the browser shows the first option and
 *  the screen would claim a language the machine is not configured for. */
function storedOptionLabel(language: string): string {
  return langKind(language) === 'regional'
    ? `${endonymFor(baseSpokenLang(language))} (${language})`
    : language;
}

// ── duplicate languages (owner ruling 2026-08-27 §R2-2) ──────────────────────
//
// 🔴 WHAT A DUPLICATE ACTUALLY DOES, because the copy has to be true: matching
// resolves a language key through a three-step ladder inside an author layer,
// and two rows carrying the SAME key collide at the same rung of the same layer.
// The router settles that with `find`, i.e. first one wins — so the second row
// is not "lower priority", it is unreachable. That is what the note says.
//
// ⚠️ TWO SEPARATE MEASURES, and the split matters:
//   · the select DISABLES a language another row already owns, so a duplicate
//     cannot be created here at all;
//   · a row that ALREADY duplicates an earlier one gets the note.
// The second is not made redundant by the first: the stored array can carry
// duplicates written by an older build, by the server, or by hand. Nothing is
// rewritten on render — the owner ruled that explicitly, and it is the same rule
// the `regional`/`unknown` display keeps: a settings screen that quietly
// corrects a value leaves the user unable to see what their machine is
// configured with.
//
// The current row's OWN value stays selectable, or the select would refuse to
// display the value it is displaying.
const langOwners = computed(() => {
  const first = new Map<string, number>();
  model.routings.forEach((r, i) => {
    if (!first.has(r.language)) first.set(r.language, i);
  });
  return first;
});
/** Is `code` taken by a row OTHER than `index`. */
function langTakenByAnotherRow(index: number, code: string): boolean {
  const owner = langOwners.value.get(code);
  return owner !== undefined && owner !== index;
}
/** Is THIS row the losing copy of a language an earlier row already claims. */
function isDuplicateRow(index: number): boolean {
  const r = model.routings[index];
  if (!r) return false;
  const owner = langOwners.value.get(r.language);
  return owner !== undefined && owner < index;
}

// ── per-row local-model readiness (owner ruling §2-3) ────────────────────────
//
// 🔴 THE OWNER'S EMPTY-STATE RULING LANDS HERE. A fresh machine routes zh and
// `*` to the built-in engine (the server's seed) and has downloaded nothing, so
// this table used to present two rows that looked configured and could not
// transcribe a word — the exact shape of the Mac report that opened this card.
// Book 15's R11: the layer making the claim must hold the fact the claim needs,
// and this one now does (`readyPackForLang`).
//
// ⚠️ `status === null` renders NOTHING, deliberately. That is 「the local
// service has not answered」, not 「there is no model」, and the two must never
// share a face — one of them has a red call to action under it.
function localPack(language: string): { ready: boolean; modelId: string } | null {
  if (modelStore.status === null) return null;
  const entry = readyPackForLang(modelStore.status, language);
  return entry === null ? { ready: false, modelId: '' } : { ready: true, modelId: entry.model_id };
}
function isBuiltin(index: number): boolean {
  return model.routings[index]?.engine_id === BUILTIN_STT_ENGINE_ID;
}
function goToModelCard(language: string): void {
  // The fallback row has no one language to show, so it opens the card on
  // whatever the card would have chosen for itself.
  focusLocalModelCard(language === FALLBACK_LANG ? '' : baseSpokenLang(language));
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
          <template v-for="(r, i) in model.routings" :key="i">
            <tr>
              <td>
                <!-- A fixed list, never free text (§2-1). The stored value is
                     shown as-is: when it is not one of the offered codes it
                     gets its own option so the select cannot silently display
                     a language this machine is not configured for. -->
                <select class="input" :value="r.language"
                        @change="editRouting(i, 'language', ($event.target as HTMLSelectElement).value)">
                  <option v-if="langKind(r.language) !== 'offered'" :value="r.language">
                    {{ storedOptionLabel(r.language) }}
                  </option>
                  <!-- §R2-2: a language another row already owns cannot be
                       picked here. Disabled rather than hidden — a language
                       vanishing from the list would read as "unsupported". -->
                  <option v-for="o in langOptions" :key="o.value" :value="o.value"
                          :disabled="langTakenByAnotherRow(i, o.value)">{{ o.label }}</option>
                  <!-- The catch-all row. The asterisk is a wire value and is
                       never shown — a user reading 「*」 has been handed our
                       storage format instead of an answer.
                       It obeys the same rule: one catch-all is all there is. -->
                  <option :value="FALLBACK_LANG" :disabled="langTakenByAnotherRow(i, FALLBACK_LANG)">
                    {{ S.stt_lang_fallback }}
                  </option>
                </select>
              </td>
              <td>
                <!-- 🔴 THIS SELECT'S VALUE IS DERIVED, NOT STORED (06 §7.1 ⑥),
                     and that is why the LLM page's 「edit ⇒ custom」 jump has no
                     twin here. `presetIdFor` recomputes the match from the row's
                     ACTUAL engine+endpoint on every render, so editing the
                     endpoint below already drops this back to the 「no preset
                     matches」 row by construction. There is nothing here that
                     could drift out of step with the fields, and adding a stored
                     preset_id 「for symmetry」 would manufacture exactly the
                     defect the LLM side had to be fixed for. -->
                <select class="input" :value="presetIdFor(i)" @change="pickPreset(i, ($event.target as HTMLSelectElement).value)">
                  <!-- The current-state row: what this routing IS when no preset
                       describes it. Distinct from the `custom` PRESET in the
                       list below — that one is a choice you make, this one is a
                       fact being reported, and it names the live engine id. -->
                  <option value="" disabled>{{ S.stt_engine_custom }} / {{ r.engine_id }}</option>
                  <optgroup v-for="s in sttPresetSections" :key="s.group" :label="presetGroupLabel(s.group)">
                    <option v-for="p in s.presets" :key="p.id" :value="p.id">{{ p.label }}</option>
                  </optgroup>
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
            <!-- What this row can and cannot do RIGHT NOW, on the row itself.
                 Two different facts, never folded: an unusable language code,
                 and a built-in engine with no downloaded pack for it. -->
            <tr v-if="isDuplicateRow(i) || langKind(r.language) === 'unknown' || (isBuiltin(i) && localPack(r.language))" class="rownote">
              <td colspan="4">
                <!-- §R2-2. Its own line rather than folded into the two facts
                     below: this row may ALSO have an unusable code or a missing
                     model pack, and each of those is separately true. -->
                <div v-if="isDuplicateRow(i)" class="bad">{{ S.stt_lang_duplicate }}</div>
                <span v-if="langKind(r.language) === 'unknown'" class="bad">
                  <span class="badge-bad">{{ S.stt_lang_unsupported }}</span>{{ S.stt_lang_unsupported_note }}
                </span>
                <!-- 🔴 `&& localPack(...)` is load-bearing, not belt-and-braces.
                     This row used to render ONLY when the outer condition
                     already guaranteed a non-null pack; the duplicate note
                     (§R2-2) gave the row a third reason to exist, so the branch
                     can now be reached with `status === null` — 「the local
                     service has not answered」 — and the `!` below would throw
                     during render. Caught by stt-routing-order.test.ts on its
                     first run. -->
                <template v-else-if="isBuiltin(i) && localPack(r.language)">
                  <span v-if="localPack(r.language)!.ready" class="good">
                    {{ SETTINGS_MSG.sttModelReady(localPack(r.language)!.modelId) }}
                  </span>
                  <span v-else class="bad">
                    {{ S.stt_model_missing }}
                    <button class="btn ghost sm" type="button" @click="goToModelCard(r.language)">
                      {{ S.stt_model_missing_action }}
                    </button>
                  </span>
                </template>
              </td>
            </tr>
          </template>
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

    <!-- The card carries LOCAL_MODEL_CARD_ID on its own root (it is a
         multi-root component, so an attribute passed from here would not fall
         through to anything a scroll could find). -->
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
        <!-- R-2乙 (owner 2026-08-29): what smooth's meaning check can and cannot
             see, shown only to the person who chose smooth. The guard's §3.2
             closed-class half is built from Chinese and English term sets, so in
             every other language it degrades to a digit check; at strict the
             §3.1 bound is tight enough to carry the load, while smooth widens it
             by design — so this is the mode where the gap actually bites.
             The covered pair is named rather than derived from the user's own
             routing rows: the desktop can hold several language rows at once, so
             「your language is covered」 would be a claim about a set, not about
             this utterance. -->
        <div v-if="model.polishStrength === 'smooth'" class="sub note coverage">
          {{ S.polish_strength_smooth_coverage }}
        </div>
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
.polish-strength .coverage { margin-top: 6px; opacity: 0.85; }
.ops-del { color: var(--t3); width: 26px; height: 26px; border-radius: 7px; }
.ops-del:hover { color: var(--red); background: var(--line-soft); }
.ops-del .icon { width: 14px; height: 14px; }
.scope-note { font-size: 11.5px; color: var(--t3); line-height: 1.6; background: var(--surface-inset); border-radius: 8px; padding: 8px 11px; margin-bottom: 12px; }
/* The per-row verdict line. Sits UNDER the row rather than inside a cell: the
   0.2.53 lesson is that a sentence squeezed into a column beside five other
   things gets ellipsised down to three letters, and the sentence is the part
   that tells the user what to do. */
.rownote td { padding-top: 0; padding-bottom: 8px; font-size: 11.5px; line-height: 1.6; }
.rownote .good { color: var(--green-ink); }
.rownote .bad { color: var(--red-ink); display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rownote .badge-bad { background: var(--red-soft); border: 1px solid var(--red); color: var(--red-ink);
  border-radius: 999px; padding: 1px 8px; font-size: 11px; }
</style>
