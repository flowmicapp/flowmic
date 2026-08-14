<script setup lang="ts">
// The "This PC" (本机) card, split out of DevicesPage.vue by REQ-12-14.
//
// 🔴 The split is REQUIRED BY that card, not tidiness. This card used to be
// `<div class="card chan self">` — it borrowed the CHANNEL card's class and then
// overrode the direction. REQ-12-14 gives `.chan` a channel-identity rail, a
// tinted channel icon tile and a channel-state pill, i.e. chrome whose whole job
// is to answer "which channel / is this channel reachable." This card is not a
// channel and cannot answer either question, so inheriting that chrome would
// have made it claim something it has no source for. It owns its own class now.
//
// Everything else is a VERBATIM move — the rename state machine, its loud failure
// line, the connection dot and the version line, comments included. The only
// change is the boundary: the two facts `deriveConnDot` needs (the sidecar phase
// and the cloud status) arrive as props instead of being read off the page's own
// refs, and the post-rename re-read arrives as the same `reload` prop shape
// PairedList.vue already uses (an awaited fetch, not a fire-and-forget emit —
// the draft must not be cleared before the server's answer is on screen).

import { computed, ref } from 'vue';
import { S } from '../../lib/strings';
import { conn, currentChannel } from '../store';
import { renamePc } from '../../lib/bridge';
import { deriveConnDot } from '../../lib/conn-dot';
import type { CloudStatus } from '../../lib/channel';
import { APP_VERSION } from '../../lib/version';

const props = defineProps<{
  /** The name the SERVER last answered with (the page owns the snapshot). */
  pcName: string;
  /** `SidecarStatus.phase` or null — one of `deriveConnDot`'s two inputs that
   *  this card does not own. Typed loosely on purpose: `deriveConnDot` already
   *  takes `string | null` and re-deriving a stricter type here would be a second
   *  place that has to learn about a new phase. */
  sidecarPhase: string | null;
  cloud: CloudStatus;
  /** The parent's re-read, awaited after a successful rename. */
  reload: () => Promise<void>;
}>();

// ── GA-10: rename THIS PC (04 §3.7 reserved key) ───────────────────────────
// owner 2026-07-26 iron rule: the name is the PC's to set — this is the only
// surface in the whole product that can change it. The edit is inline
// (change-applies-immediately has no save button anywhere else either); a
// refusal is LOUD and the old name stays on screen, because showing the typed
// name over an unchanged row is the lie.
const renaming = ref(false);
const renameDraft = ref<string | null>(null); // null = not editing
const renameFailed = ref(false);

function startRename(): void {
  renameFailed.value = false;
  renameDraft.value = props.pcName;
}
function cancelRename(): void {
  renameDraft.value = null;
  renameFailed.value = false;
}
async function commitRename(): Promise<void> {
  const next = (renameDraft.value ?? '').trim();
  if (renaming.value) return;
  if (next === '' || next === props.pcName) return cancelRename();
  renaming.value = true;
  renameFailed.value = false;
  try {
    if (await renamePc(next)) {
      // Re-read rather than patch locally: the snapshot is the server's answer,
      // so the card can never show a name the server did not accept.
      await props.reload();
      renameDraft.value = null;
    } else {
      renameFailed.value = true;
    }
  } finally {
    renaming.value = false;
  }
}

// T-5b: same deriveConnDot as the sidebar footer — one truth, two surfaces.
const connView = computed(() =>
  deriveConnDot({
    connected: conn.connected,
    registered: conn.registered,
    // RV-新B: this snapshot's OWN channel (see App.vue), not a global preference.
    channel: currentChannel.value,
    sidecarPhase: props.sidecarPhase,
    cloud: props.cloud,
  }),
);
</script>

<template>
  <!-- this PC — GA-10 made the name editable HERE and nowhere else (04 §3.7;
       owner iron rule "the PC's name can only be controlled by the PC side").
       A failed rename keeps the old name on screen and says so.
       Version is the same APP_VERSION the settings About section shows. -->
  <div class="card self-card">
    <div class="self-main">
      <div v-if="renameDraft === null" class="self-name-row">
        <span class="self-name">{{ pcName }}</span>
        <button class="btn ghost sm" :disabled="!conn.connected" :title="S.dev_rename_hint"
          @click="startRename">{{ S.dev_rename }}</button>
      </div>
      <div v-else class="self-name-row">
        <input v-model="renameDraft" class="input rename-input" maxlength="80" spellcheck="false"
          :disabled="renaming" @keyup.enter="commitRename" @keyup.esc="cancelRename" />
        <button class="btn pri sm" :disabled="renaming" @click="commitRename">
          {{ renaming ? S.saving : S.dev_rename_save }}
        </button>
        <button class="btn ghost sm" :disabled="renaming" @click="cancelRename">{{ S.dev_release_cancel }}</button>
      </div>
      <div v-if="renameFailed" class="chan-loud">{{ S.dev_rename_failed }}</div>
      <div class="muted mono" style="font-size:12px;margin-top:2px">{{ S.set_about_version }} {{ APP_VERSION }}</div>
    </div>
    <span style="margin-left:auto" class="self-conn">
      <span class="dot" :class="connView.dot"></span>
      <span class="muted">{{ connView.label }}</span>
    </span>
  </div>
</template>

<style scoped>
/* 2026-07-29 polish: `.chan` set flex-direction:column and .self inherited it —
   that's why the name used to render centered with the connection status
   stranded at the bottom-right. This card is a ROW: identity block on the left,
   live status on the right.
   REQ-12-14: the padding used to come from `.chan` on the devices page. It is
   spelled out here now, because this card no longer wears the channel class —
   see the 🔴 block in <script> for why that decoupling is the point of the move
   rather than a side effect of it. */
.self-card { padding: 16px 18px; display: flex; flex-direction: row; align-items: center; gap: 14px; }
.self-card:hover { border-color: var(--line-strong); }
.self-main { flex: 1 1 auto; min-width: 0; }
.self-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.self-name { font-weight: 700; font-size: 14px; }
.rename-input { max-width: 260px; font-size: 13px; }
.self-name-row .btn { font-size: 11.5px; padding: 3px 9px; }
.self-conn { display: inline-flex; align-items: center; gap: 6px; }
/* Same red block the channel cards use for a loud failure. Duplicated rather
   than shared for the same reason PairedList.vue duplicates it: scoped styles do
   not cross the component boundary, and a page-level rule reaching into a child
   would only work by accident (it would style the child's ROOT node, not this
   line inside it). */
.chan-loud { margin-top: 8px; font-size: 12px; color: var(--red); background: var(--red-soft);
  border-radius: 8px; padding: 8px 10px; line-height: 1.5; }
.btn.pri:disabled, .btn.ghost:disabled { opacity: .5; cursor: default; }
</style>
