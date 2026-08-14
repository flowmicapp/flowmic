<script setup lang="ts">
// GA-12 — the inline "test connection" result. The SINGLE render point for the four
// dimensions (ok / latency_ms / model_echoed / sample_output), shared by the STT
// and LLM settings sections.
//
// Deliberately NOT a status light (13 §3 D3): it exists only while `state.rows`
// is non-empty, its owner wipes it on any config edit and when the page stops
// being displayed, and nothing about it is ever persisted.
import { S } from '../../lib/strings';
import type { ProbeState } from '../../lib/probe-client';

defineProps<{ state: ProbeState }>();
const emit = defineEmits<{ (e: 'toggle', index: number): void }>();
</script>

<template>
  <div class="probe" v-if="state.running || state.rows.length > 0">
    <div v-if="state.running" class="prow muted">{{ S.probe_running }}</div>

    <div v-for="(r, i) in state.rows" :key="i" class="prow">
      <div class="phead">
        <span class="pmark" :class="r.ok ? 'st-g' : 'st-r'">{{ r.ok ? '✓' : '✗' }}</span>
        <span class="plabel mono">{{ r.label }}</span>
        <span class="phl" :class="{ bad: !r.ok }">{{ r.headline }}</span>
        <span class="pgap"></span>
        <!-- ① latency_ms -->
        <span class="muted">{{ S.probe_latency }} {{ r.latency }}</span>
        <span v-if="r.byok" class="muted">· {{ r.byok }}</span>
      </div>

      <div class="pdims">
        <!-- ② model_echoed ("not provided" when the service echoed nothing) -->
        <span class="muted pk">{{ S.probe_model }}</span>
        <span class="mono pv">{{ r.model }}</span>
        <!-- ③ sample_output — or the honest reason there is none -->
        <span class="muted pk">{{ S.probe_sample }}</span>
        <span class="pv" :class="r.sampleIsNote ? 'pnote' : 'mono'">{{ r.sample }}</span>
      </div>

      <template v-if="r.detail">
        <button class="pmore" @click="emit('toggle', i)">
          {{ S.probe_detail }} {{ state.expanded === i ? '▾' : '▸' }}
        </button>
        <pre v-if="state.expanded === i" class="praw mono">{{ r.detail }}</pre>
      </template>
    </div>

    <div class="muted phint">{{ S.probe_hint }}</div>
  </div>
</template>

<style scoped>
.probe { margin-top: 10px; border: 1px solid var(--line); border-radius: var(--r12); background: var(--surface); padding: 10px 12px; }
.prow + .prow { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 10px; }
.phead { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.pmark { font-weight: 700; }
.plabel { font-size: 12px; color: var(--t2); }
.phl { font-weight: 600; }
.phl.bad { color: var(--red); }
.pgap { flex: 1; }
.pdims { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin-top: 6px; align-items: baseline; }
.pk { white-space: nowrap; }
.pv { font-size: 12px; word-break: break-all; }
.pnote { color: var(--t3); font-size: 12px; }
.pmore { margin-top: 6px; font-size: 12px; color: var(--t2); }
.pmore:hover { color: var(--t1); }
.praw { margin-top: 4px; padding: 8px; border-radius: var(--r8); background: var(--red-soft); color: var(--red-ink); font-size: 11px; white-space: pre-wrap; word-break: break-all; }
.phint { margin-top: 8px; }
</style>
