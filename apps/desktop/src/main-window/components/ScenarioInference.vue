<script setup lang="ts">
// V2-08 consent surface (card Z2). The switch that decides whether the focused
// executable's basename may be sent to the model.
//
// Three properties are load-bearing and none of them is cosmetic:
//
//  1. THE SWITCH SHOWS WHETHER THE FEATURE IS RUNNING, not whether a consent row
//     exists. Those are different questions once the model endpoint can change
//     under a stored consent, and `inferenceEnabled()` answers the second by
//     calling the SAME protocol gate the server calls. A switch rendered from
//     `granted` alone would sit there saying ON while the server sends nothing.
//  2. THE DESTINATION IS SHOWN WITH THE RULE, NOT A CHARACTER JUDGEMENT. The
//     classifier answers "is this inside RFC1918 (+ deployment overlay)?".
//     Desktop passes `ADDITIONAL_PRIVATE_CIDRS` from presets (D1), so the
//     owner's office LAN is `local` here; without that overlay it stays
//     `external`. The card prints the endpoint verbatim and then one of two
//     rule-stating verdicts. The VERDICT never says "third party" — the
//     classifier cannot answer who owns an address (RV-55). 0.3.0 P3 draws the
//     line where it actually belongs rather than banning the word: on the
//     unprovable branch the card adds ONE sentence naming the consequence ("if
//     this is someone else's service, your text reaches that third party"),
//     which is true precisely because the address could not be placed. On the
//     private branch that sentence is not rendered at all.
//  3. NO HALF DOORS. `scenario.inference.overrides` (per-process manual
//     corrections) has no UI in this card, so there is no button, no placeholder
//     and no "coming soon" for it here.

import Icon from './Icon.vue';
import { S } from '../../lib/strings';
import {
  inferenceBlocked,
  inferenceDestination,
  inferenceEnabled,
  model,
  setScenarioInferenceGranted,
} from '../settings-model';
</script>

<template>
  <div class="set-sec">
    <!-- Same scope statement as the two model sections: settings:update is pinned
         to the LAN socket, so this consent reaches the self-hosted server only. -->
    <div class="scope-note">{{ S.settings_scope_lan }}</div>
    <div class="sub-h" style="margin-top:0">{{ S.infer_title }}
      <span class="muted" style="font-weight:400">{{ S.infer_hint }}</span>
    </div>

    <div class="card pad infer-card">
      <div class="infer-line">{{ S.infer_collect }}</div>
      <div class="infer-line">{{ S.infer_no_screen }}</div>
      <div class="infer-line">{{ S.infer_sends_to }}</div>
      <div class="infer-dest">
        <span class="mono">{{ model.llm.endpoint || S.infer_endpoint_unset }}</span>
        <span class="verdict" :class="{ ext: inferenceDestination() === 'external' }">
          {{ inferenceDestination() === 'local' ? S.infer_dest_private : S.infer_dest_unprovable }}
        </span>
      </div>
      <!-- 0.3.0 P3: the consequence, on the ONE branch where it can be true. The
           verdict above answers "can this be proven private"; this answers "and
           if it is not yours, then what." It is deliberately absent on the private
           branch — there, naming a third party would be the RV-55 lie. -->
      <div v-if="inferenceDestination() === 'external'" class="infer-line ext-note">
        {{ S.infer_dest_unprovable_note }}
      </div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div class="chkrow" @click="setScenarioInferenceGranted(!inferenceEnabled())">
        <span class="chk" :class="{ on: inferenceEnabled() }"><Icon name="check" /></span>
        <div>
          <div>{{ S.infer_toggle }}</div>
          <div class="sub">{{ inferenceEnabled() ? S.stt_sub_on : S.stt_sub_off_default }}</div>
        </div>
      </div>
      <div class="sub" style="padding:0 14px 12px">{{ S.infer_off_note }}</div>
    </div>

    <!-- Consent recorded against a LAN box while the endpoint now points elsewhere:
         the server has stopped the feature, so say so instead of leaving a switch
         that reads OFF for no visible reason. -->
    <div v-if="inferenceBlocked() === 'destination-widened'" class="infer-widened" role="alert">
      {{ S.infer_widened_note }}
    </div>
  </div>
</template>

<style scoped>
.scope-note { font-size: 11.5px; color: var(--t3); line-height: 1.6; background: var(--surface-inset); border-radius: 8px; padding: 8px 11px; margin-bottom: 12px; }
.card.pad { padding: 12px 14px; }
.infer-card { margin-bottom: 12px; }
.infer-line { font-size: 12.5px; line-height: 1.7; color: var(--t2); }
.infer-line.ext-note { margin-top: 6px; color: var(--t3); }
.infer-dest { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--line-soft); }
.infer-dest .mono { font-size: 12.5px; word-break: break-all; }
.verdict { font-size: 11.5px; color: var(--t3); }
.verdict.ext { color: var(--amber-ink); }
.infer-widened { margin: -4px 2px 10px; font-size: 12px; line-height: 1.6; color: var(--amber-ink); }
</style>
