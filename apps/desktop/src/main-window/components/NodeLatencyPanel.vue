<script setup lang="ts">
// WP2 Card 1 — read-only relay-node latency, beside the cloud account card.
//
// Presentational: the numbers arrive as props, the check is an emit. That
// split is what makes the render test assert the REAL markup (channel-card-
// head / CloudAccountLines precedent) instead of a pre-fetch placeholder.
//
// 🔴 NO PER-NODE CONTROL. The computer picks the node; this panel only
// measures. A radio or a "use this" button would be a control that changed
// nothing (R8).
import { S } from '../../lib/strings';
import type { NodeLatencyRow, PathReading } from '../../lib/relay-latency';

defineProps<{
  nodes: NodeLatencyRow[];
  busy: boolean;
}>();
defineEmits<{ (e: 'check'): void }>();

function pathLabel(p: PathReading, many: boolean): string | null {
  if (!many) return null;
  return p.kind === 'alternate' ? S.node_lat_via_direct : S.node_lat_via_cloud;
}

function pathLine(p: PathReading): string {
  if (p.rtt_ms == null) return S.node_lat_unanswered;
  const lat = `${S.node_lat_latency} ${p.rtt_ms} ms`;
  if (p.connect_ms == null) return lat;
  return `${S.node_lat_connect} ${p.connect_ms} ms · ${lat}`;
}
</script>

<template>
  <div class="card pad nl" data-node-lat="1">
    <div class="nl-head">
      <div class="prefs-label">{{ S.node_lat_title }}</div>
      <button
        class="btn ghost sm"
        type="button"
        :disabled="busy"
        data-node-lat-check="1"
        @click="$emit('check')"
      >
        {{ busy ? S.node_lat_checking : S.node_lat_check }}
      </button>
    </div>
    <p class="nl-note">{{ S.node_lat_note }}</p>
    <div v-for="(n, i) in nodes" :key="i" class="nl-row" :data-node-lat-row="i">
      <div class="nl-who">
        <span v-if="n.short" class="nl-short">{{ n.short }}</span>
        <span v-if="n.selected" class="nl-here">
          <span class="nl-dot" aria-hidden="true" />
          {{ S.node_lat_here }}
        </span>
      </div>
      <div
        v-for="(p, j) in n.paths"
        :key="j"
        class="nl-path"
        :data-node-lat-path="p.kind"
      >
        <span v-if="pathLabel(p, n.paths.length > 1)" class="nl-kind">
          {{ pathLabel(p, n.paths.length > 1) }}
        </span>
        <span class="nl-nums">{{ pathLine(p) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.nl { margin-top: 12px; }
.nl-head { display: flex; align-items: center; gap: 12px; }
.nl-head .prefs-label { font-size: 13.5px; font-weight: 600; }
.nl-head .btn { margin-left: auto; }
.nl-head .btn:disabled { opacity: .5; cursor: default; }
.nl-note { margin: 6px 0 0; font-size: 12px; line-height: 1.55; color: var(--t3); }
.nl-row { margin-top: 12px; }
.nl-who { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.nl-short {
  font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  color: var(--teal); border: 1px solid var(--line); border-radius: 999px;
  padding: 1px 8px;
}
.nl-here { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--t2); }
.nl-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--teal); }
.nl-path { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-top: 4px; font-size: 12px; color: var(--t2); }
.nl-kind { font-size: 11px; color: var(--t3); min-width: 5.5em; }
.nl-nums { font-variant-numeric: tabular-nums; }
</style>
