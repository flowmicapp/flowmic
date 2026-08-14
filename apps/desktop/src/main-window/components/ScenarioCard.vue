<script setup lang="ts">
import { ref } from 'vue';
import Icon from './Icon.vue';
import { S } from '../../lib/strings';
import { SETTINGS_MSG } from '../../lib/strings/settings';
import {
  PACKS,
  PROFESSION_OPTIONS,
  SCENARIO_CAPS,
  addTerm,
  model,
  removeTerm,
  togglePack,
  toggleProfession,
  type TermAdd,
} from '../settings-model';

const newTerm = ref('');
const reject = ref('');
function submitTerm(): void {
  const outcome: TermAdd = addTerm(newTerm.value);
  if (outcome === 'added') {
    newTerm.value = '';
    reject.value = '';
    return;
  }
  reject.value =
    outcome === 'duplicate' ? S.scenario_term_exists
    : outcome === 'too-long' ? SETTINGS_MSG.termTooLong(SCENARIO_CAPS.labelLen)
    : outcome === 'at-cap' ? SETTINGS_MSG.termsAtCap(SCENARIO_CAPS.terms)
    : '';
}
</script>

<template>
  <div class="set-sec">
    <div class="sub-h" style="margin-top:0">{{ S.scenario_title }}
      <span class="muted" style="font-weight:400">{{ S.scenario_hint }}</span>
    </div>

    <div class="field">
      <label>{{ S.scenario_professions }}</label>
      <div class="ctx-chips">
        <span v-for="p in PROFESSION_OPTIONS" :key="p" class="ctx-chip"
              :class="{ on: model.card.professions.includes(p) }" @click="toggleProfession(p)">{{ p }}</span>
      </div>
    </div>

    <div class="field">
      <label>{{ S.scenario_packs }}</label>
      <div class="card">
        <div v-for="pack in PACKS" :key="pack.id" class="chkrow" @click="togglePack(pack.id)">
          <span class="chk" :class="{ on: model.card.packs.includes(pack.id) }"><Icon name="check" /></span>
          <div>{{ pack.label }}</div>
        </div>
      </div>
    </div>

    <div class="field">
      <label>{{ S.scenario_terms }}
        <span class="muted" style="font-weight:400">{{ model.card.terms.length }} / {{ SCENARIO_CAPS.terms }} · {{ SETTINGS_MSG.termsCapNote(SCENARIO_CAPS.labelLen) }}</span>
      </label>
      <div class="card" v-if="model.card.terms.length > 0">
        <div class="dict-row" v-for="t in model.card.terms" :key="t">
          <span class="term">{{ t }}</span>
          <button class="rm" :title="S.op_delete" @click="removeTerm(t)"><Icon name="x" /></button>
        </div>
      </div>
      <div class="term-input">
        <input class="input" v-model="newTerm" :placeholder="S.scenario_term_ph" @keyup.enter="submitTerm" />
        <button class="btn ghost sm" @click="submitTerm"><Icon name="plus" />{{ S.scenario_add_term }}</button>
        <span v-if="reject" class="reject">{{ reject }}</span>
      </div>
    </div>
  </div>
</template>
