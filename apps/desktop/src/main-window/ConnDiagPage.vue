<script setup lang="ts">
// Connection diagnostics — its own page (owner 2026-07-26 instruction ①).
//
// It used to be a card squatting at the top of the devices page, where its five
// rows displaced the content that page is actually about. The owner's ruling
// matches the card's real usage pattern: nobody reads a diagnostic while things
// work, and when things break they want ALL of it. So the sidebar footer status
// ("Connected / 1 phone online") is now the entry point — clicking it lands here —
// and this page shows the full picture with room to breathe: the global verdict,
// BOTH resident channels' own socket state (GA-28: they are independent facts),
// the local service, and the latched last-loud-reason.
//
// No fold logic here on purpose: folding was the card's answer to squatting on
// someone else's page. A dedicated page has nothing to yield to.

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from './components/Icon.vue';
import { conn, connByChannel, currentChannel } from './store';
import { S, SIDECAR_LABEL } from '../lib/strings';
import {
  CH,
  fetchCloudStatus,
  fetchPairingInfo,
  fetchSidecarState,
  onChannel,
  type SidecarStatus,
} from '../lib/bridge';
// ⚠️ Focus-probe temporarily hidden (owner 2026-08-02 UI batch 1 ④) — the
// `focusDiagnostic` / `FocusDiagnostic` imports are commented out together with
// their only caller, down in the V2-01 section below. Restore both places together.
import { asCloudStatus, CHANNEL_LABEL, CHANNEL_VISUAL, EMPTY_CLOUD_STATUS, type ChannelId, type CloudStatus } from '../lib/channel';
import { connChannelLabel, deriveConnDot } from '../lib/conn-dot';
import { model, type Routing } from './settings-model';
import {
  configMissingRow,
  createProbeStore,
  isLlmEndpointConfigured,
  pickSttDiagResult,
  PROBE_LLM_PATH,
  PROBE_STT_PATH,
  runProbe,
  toRowView,
  type ProbeResult,
  type ProbeRowView,
  type ProbeTransport,
} from '../lib/probe-client';

const cloud = ref<CloudStatus>({ ...EMPTY_CLOUD_STATUS });
const sidecar = ref<SidecarStatus | null>(null);
const lanEndpoint = ref('');
// v0.2.4 — THIS MACHINE's cross-channel identity. Shown here rather than on the
// device page because it is a diagnostic, not a setting: it is the value the
// owner compares against the phone when asking "are these two the same machine".
// Empty = the machine id could not be read, which the row states rather than
// papering over with a placeholder that would look like an answer.
const machineUid = ref('');

// REQ-12-12 — local STT/LLM one-shot (same transport + store as settings;
// D3: never a resident green light; page is v-if so leaving wipes the store).
const engineTransport: ProbeTransport = {
  baseUrl: async (): Promise<string | null> => (await fetchSidecarState())?.endpoint ?? null,
};
const engineProbe = createProbeStore(async (): Promise<ProbeRowView[]> => {
  const routings: Routing[] = model.routings.map((r) => ({ ...r }));
  let sttRow: ProbeRowView;
  if (routings.length === 0) {
    sttRow = configMissingRow(S.stt_title, S.probe_no_routing, 'STT_CONFIG_MISSING');
  } else {
    const sttResults: ProbeResult[] = [];
    for (const r of routings) {
      sttResults.push(
        await runProbe(PROBE_STT_PATH, { routings, language: r.language }, engineTransport),
      );
    }
    sttRow = toRowView(S.stt_title, pickSttDiagResult(sttResults));
  }

  const llmRow = !isLlmEndpointConfigured(model.llm.endpoint)
    ? configMissingRow(S.llm_title, S.probe_no_llm, 'LLM_CONFIG_MISSING')
    : toRowView(
        S.llm_title,
        await runProbe(
          PROBE_LLM_PATH,
          {
            protocol: model.llm.protocol,
            endpoint: model.llm.endpoint,
            api_key: model.llm.api_key,
            model: model.llm.model,
          },
          engineTransport,
        ),
      );
  return [sttRow, llmRow];
});

function engineDotClass(row: ProbeRowView): string {
  if (row.ok) return 'g';
  // Config-missing is amber (knowable, user-fixable), not red (broken).
  if (row.detail === 'STT_CONFIG_MISSING' || row.detail === 'LLM_CONFIG_MISSING') return 'o';
  return 'r';
}

function engineStatusText(row: ProbeRowView): string {
  if (row.ok) return `${row.headline} · ${row.latency}`;
  return row.headline;
}

// One truth, fourth surface: the same deriveConnDot as the sidebar footer,
// devices page and capsule (T-5b).
const connView = computed(() =>
  deriveConnDot({
    connected: conn.connected,
    registered: conn.registered,
    // RV-新B: this snapshot's OWN channel (see App.vue), not a global preference.
    channel: currentChannel.value,
    sidecarPhase: sidecar.value?.phase ?? null,
    cloud: cloud.value,
  }),
);

/** Latch the last real loud reason so it stays readable AFTER recovery — the
 *  label says "most recent fault" precisely because a green dot may sit beside it
 *  (no silent failure cuts both ways: no swallowed errors, no invented ones). */
const lastLoudReason = ref<string | null>(null);
watch(
  () => connView.value.detail,
  (d) => {
    if (d) lastLoudReason.value = d;
  },
);

/** GA-28: each resident channel's OWN socket, not the primary's mirrored onto
 *  both — the whole reason connByChannel exists.
 *
 *  ⚠️ owner 2026-08-02 UI batch 1 ① "the primary-channel label should no longer be
 *  needed": `primary` is GONE from this row. It used to feed a "primary channel"
 *  chip beside the channel badge — the LAST presentation point of that word in the
 *  product (the other was the pairing modal's tab dot, removed in the same round).
 *  The MECHANISM is untouched and must not be "cleaned up" from here:
 *  `Admission::primary()` (src-tauri/src/socket/admission.rs) still decides which
 *  channel's CONNECTION frame owns `store.conn`, which the sidebar dot, the capsule strip
 *  and this page's own verdict banner all read. Removing the UI label ≠ removing the
 *  mechanism — the mechanism's surviving consumers and whether it can be retired are
 *  inventoried in
 *  `docs/decisions/2026-08-02-primary-channel-ui-retired-mechanism-inventory.md`. */
const lanState = computed(() => channelRow('lan'));
const cloudState = computed(() => channelRow('cloud'));
function channelRow(ch: ChannelId): { id: ChannelId; label: string; up: boolean; known: boolean } {
  const snap = connByChannel[ch];
  return {
    id: ch,
    label: CHANNEL_LABEL[ch],
    up: snap?.connected === true,
    // A channel we have never heard from is UNKNOWN, not down — the honest
    // rendering is "no data", never a red dot nothing backs.
    known: snap !== undefined,
  };
}

async function loadOnce(): Promise<void> {
  cloud.value = await fetchCloudStatus();
  sidecar.value = await fetchSidecarState();
  const info = await fetchPairingInfo();
  lanEndpoint.value = info.endpoint;
  machineUid.value = info.machine_uid ?? '';
}

let unSidecar: (() => void) | null = null;
let unCloud: (() => void) | null = null;
onMounted(async () => {
  // RV-24: register the listener first, then pull the snapshot — the rule store.ts
  // spells out at its snapshot seed («register first so a frame arriving mid-seed
  // is not lost, then ask for the current state»). This page's whole job is
  // telling the truth about the link, so a push it slept through would be the
  // worst place to lose one.
  unSidecar = await onChannel<SidecarStatus>(CH.sidecarState, (p) => {
    sidecar.value = p;
  });
  unCloud = await onChannel<unknown>(CH.cloudState, (p) => {
    cloud.value = asCloudStatus(p);
    void loadOnce();
  });
  await loadOnce();
  // After sidecar endpoint is known — probing before loadOnce races `probe_no_server`.
  void engineProbe.run();
});
onUnmounted(() => {
  unSidecar?.();
  unCloud?.();
  engineProbe.reset();
});

// ── V2-01 focus probe (requirement ⑦'s first step: measure before changing) ──────
//
// 🔴 Temporarily hidden (owner 2026-08-02 UI batch 1 ④: "focus probe (diagnostic
//    only, does not inject) — comment it out for now, bring it back when
//    needed"). **Code stays, must not be deleted** — following this repo's
//    convention for "deliberately kept".
//
//    Conditions X for restoring (any one triggers restoring the whole block —
//    script section + template section + the two imports at the top — together):
//      ① the symptom "UI reports ✓ injected, but no text landed in the target
//         window" reappears in a form the logs cannot distinguish the cause of;
//      ② the RV-45 line (becoming a registered and activated speech TIP) restarts,
//         and needs this as a reference measurement.
//    What has to come back together with it (all still present, nothing deleted):
//      · the `focusDiagnostic` / `type FocusDiagnostic` import at the top
//        (commented out, see the file header);
//      · the `.card.pad` "focus probe" block in the template (commented out, see
//        the same-named marker inside <template>);
//      · the ten `S.diag_focus_probe` / `S.diag_probe_*` copy strings —
//        **deliberately not deleted**, complete in all four locales, marked at
//        their source (lib/strings/connection.ts) as waiting for this section to
//        come back.
//    ⚠️ The bridge `focusDiagnostic()` (lib/bridge.ts) and Rust's
//    `focus_diagnostic` command therefore **temporarily have zero callers**. This
//    is not a façade — a façade is "a capability is defined with nobody calling
//    it while the UI still promises it"; here the UI promises nothing at all. The
//    same note is marked at the source too.
//
// When injecting into Claude Code, the window gets activated but the text
// doesn't land, yet the UI reports "✓ injected". This symptom has at least three
// mutually distinct root causes (UIA misjudging / an activation race / focus
// being on the window frame rather than the input box), each with a completely
// different fix, while looking identical on screen. Guessing wrong means fixing
// the wrong place, and what gets changed is the injection path, which is under
// line-by-line human review.
//
// The countdown lives here rather than as a sleep in Rust: the sample has to be
// taken AFTER the user has already switched to the target window. A sleep in
// Rust could do that too, but then the countdown would be invisible — the user
// wouldn't know when to switch windows, and what gets measured would still be
// FlowMic itself.
//
// const PROBE_COUNTDOWN_S = 5;
// const probeLeft = ref(0);
// const probeResult = ref<FocusDiagnostic | null>(null);
// const probeFailed = ref(false);
// let probeTimer = 0;
//
// function probeLine(d: FocusDiagnostic): string {
//   return [
//     `verdict=${d.verdict}`,
//     `refuse=${d.would_refuse ?? '-'}`,
//     `fg=0x${d.foreground_hwnd.toString(16)}`,
//     `[${d.foreground_process}]`,
//     JSON.stringify(d.foreground_title),
//     `focus=0x${d.focus_hwnd.toString(16)}`,
//     `caret=0x${d.caret_hwnd.toString(16)}`,
//     `gui_ok=${d.gui_info_ok}`,
//     `focus_is_fg=${d.focus_is_foreground}`,
//   ].join(' ');
// }
//
// function startProbe(): void {
//   if (probeLeft.value > 0) return;
//   probeResult.value = null;
//   probeFailed.value = false;
//   probeLeft.value = PROBE_COUNTDOWN_S;
//   probeTimer = window.setInterval(async () => {
//     probeLeft.value -= 1;
//     if (probeLeft.value > 0) return;
//     window.clearInterval(probeTimer);
//     const d = await focusDiagnostic();
//     // If it can't be obtained, say so — a diagnostic button that fails silently
//     // is worse than no button at all.
//     if (d === null) probeFailed.value = true;
//     else probeResult.value = d;
//   }, 1000);
// }
//
// async function copyProbe(): Promise<void> {
//   const d = probeResult.value;
//   if (d === null) return;
//   try {
//     await navigator.clipboard.writeText(probeLine(d));
//   } catch {
//     probeFailed.value = true; // Say so even when copying fails — must not pretend it succeeded
//   }
// }
//
// onUnmounted(() => window.clearInterval(probeTimer));
</script>

<template>
  <div class="diag-wrap">
    <div class="page-head">
      <h2>{{ S.cap_diag }}</h2>
    </div>

    <!-- the global verdict: a prominent banner, then the facts under it -->
    <div class="card diagp">
      <div class="verdict">
        <span class="dot lg" :class="connView.dot"></span>
        <div class="vtext">
          <b>{{ connView.label }}</b>
          <span class="sub">{{ connChannelLabel(currentChannel) }}</span>
        </div>
      </div>
      <div class="rows">
        <div v-if="lanEndpoint" class="drow"><span class="k">{{ S.diag_endpoint }}</span><span class="v mono">{{ lanEndpoint }}</span></div>
        <div class="drow"><span class="k">{{ S.cap_socket }}</span><span class="v">{{ conn.connected ? S.cap_socket_ok : S.cap_socket_down }}</span></div>
        <div class="drow"><span class="k">{{ S.diag_registered }}</span><span class="v">{{ conn.registered ? S.diag_registered_yes : S.diag_registered_no }}</span></div>
        <div class="drow"><span class="k">{{ S.diag_mobiles }}</span><span class="v">{{ conn.mobiles }}</span></div>
        <div class="drow">
          <span class="k">{{ S.diag_machine_uid }}</span>
          <span class="v mono">{{ machineUid || S.diag_machine_uid_unknown }}</span>
        </div>
        <div v-if="lastLoudReason" class="drow loud"><span class="k">{{ S.diag_loud }}</span><span class="v">{{ lastLoudReason }}</span></div>
      </div>
    </div>

    <!-- GA-28: the two resident channels are independent sockets to different
         servers; each row is that channel's OWN truth.
         owner 2026-08-01: colour + icon combination, must not rely on colour
         alone — the row used to be plain text (no colour, no icon, nothing but
         position told the two rows apart). Now
         the ONE definition: lib/channel.ts's CHANNEL_VISUAL + tokens.css's
         `.chan-badge.<css>`, same shape TimelinePage.vue uses. The health `.dot`
         stays separate — it answers "whether it's up", the badge answers "which
         channel", and a diagnostics page is exactly the place those two must
         never be conflated. -->
    <div class="sub-h">{{ S.diag_channels }}</div>
    <div class="card diagp">
      <div class="rows">
        <div v-for="row in [lanState, cloudState]" :key="row.id" class="drow">
          <span class="chrow">
            <span class="dot" :class="row.known ? (row.up ? 'g' : 'o') : 'o'"></span>
            <span class="chan-badge" :class="CHANNEL_VISUAL[row.id].css">
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" v-html="CHANNEL_VISUAL[row.id].iconPath"></svg>
              {{ row.label }}
            </span>
            <!-- owner 2026-08-02 UI batch 1 ①: the "primary channel" chip is
                 removed. This row now answers exactly two questions — "which
                 channel" (badge) and "whether it's up" (dot + text on the right).
                 The third question, "who is the primary channel", gives the user
                 no action to take, while it looked like a status. -->
          </span>
          <span class="v">{{ row.known ? (row.up ? S.diag_ch_up : S.diag_ch_down) : S.diag_ch_unknown }}</span>
        </div>
        <div class="drow">
          <span class="chrow"><Icon name="gear" class="mini" />{{ S.sidecar_title }}</span>
          <span class="v" :class="{ loudtext: sidecar?.phase === 'failed' }">
            {{ sidecar ? SIDECAR_LABEL[sidecar.phase] ?? sidecar.phase : '—' }}
          </span>
        </div>
        <div v-if="sidecar?.phase === 'failed' && sidecar?.detail" class="sc-detail mono">{{ sidecar.detail }}</div>
      </div>
      <!-- 🔴 Focus probe: temporarily hidden (owner 2026-08-02 UI batch 1 ④).
           Code stays, must not be deleted; the restore conditions and the
           checklist of what comes back with it are written in <script> at the
           same-named "V2-01 focus probe" marker.
      <div class="card pad" style="margin-top:14px">
        <div class="drow" style="padding-top:0">
          <span class="chrow"><Icon name="target" class="mini" />{{ S.diag_focus_probe }}</span>
          <button class="btn ghost sm" type="button" :disabled="probeLeft > 0" @click="startProbe">
            {{ probeLeft > 0 ? `${probeLeft} ${S.diag_probe_countdown}` : S.diag_probe_start }}
          </button>
        </div>
        <div class="muted" style="font-size:12px;line-height:1.55">
          {{ S.diag_probe_hint_1a }}<b>{{ S.diag_probe_hint_1b }}</b>{{ S.diag_probe_hint_1c }}
          {{ S.diag_probe_hint_2a }}<b>{{ S.diag_probe_hint_2b }}</b>
        </div>
        <div v-if="probeFailed" class="sc-detail mono">{{ S.diag_probe_failed }}</div>
        <template v-if="probeResult">
          <div class="sc-detail mono" style="color:var(--t1);margin-top:10px">{{ probeLine(probeResult) }}</div>
          <div class="drow">
            <span class="k">{{ S.diag_probe_paste_hint }}</span>
            <button class="btn ghost sm" style="margin-left:auto" type="button" @click="copyProbe">{{ S.op_copy }}</button>
          </div>
        </template>
      </div>
      -->
    </div>

    <!-- REQ-12-12: local recognition / LLM — one-shot via probe-client (D3). -->
    <div class="sub-h">{{ S.diag_engines }}</div>
    <div class="card diagp">
      <div class="rows">
        <div v-if="engineProbe.state.running && engineProbe.state.rows.length === 0" class="drow">
          <span class="chrow"><span class="dot o"></span>{{ S.probe_running }}</span>
        </div>
        <div
          v-for="row in engineProbe.state.rows"
          :key="row.label"
          class="drow"
        >
          <span class="chrow">
            <span class="dot" :class="engineDotClass(row)"></span>
            {{ row.label }}
          </span>
          <span class="v" :class="{ loudtext: !row.ok && engineDotClass(row) === 'r' }">
            {{ engineStatusText(row) }}
          </span>
        </div>
      </div>
      <div class="engine-actions">
        <button
          class="btn ghost sm"
          type="button"
          :disabled="engineProbe.state.running"
          @click="engineProbe.run()"
        >
          {{ engineProbe.state.running ? S.probe_running : S.test_conn }}
        </button>
        <span class="engine-hint">{{ S.probe_hint }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* A diagnostic is a single column of facts — a constrained width keeps each
   label next to its value instead of flinging them to opposite edges of a
   ~1100px page (owner 2026-07-26 relayout). */
.diag-wrap { max-width: 620px; }
.diagp { padding: 15px 18px; margin-bottom: 14px; }

/* Global verdict as a banner: a bigger dot + the verdict, the channel under it. */
.verdict { display: flex; align-items: center; gap: 11px; }
.verdict .vtext { display: flex; flex-direction: column; gap: 1px; line-height: 1.3; }
.verdict b { font-size: 15px; font-weight: 700; }
.verdict .sub { font-size: 12px; color: var(--t2); }
.dot.lg { width: 11px; height: 11px; }

/* The facts, separated from the banner by a hairline. */
.rows { margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--line); display: flex; flex-direction: column; }
.rows:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.drow { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 12.5px; color: var(--t1); }
.drow .k { color: var(--t2); }
.drow .v { margin-left: auto; color: var(--t1); font-weight: 500; text-align: right; max-width: 62%; word-break: break-all; }
.drow.loud .v, .loudtext { color: var(--red); }
.chrow { display: inline-flex; align-items: center; gap: 7px; }
/* `.chip.in-use` was removed together with the "primary channel" text it rendered
   (owner 2026-08-02 UI batch 1 ①) — a rule no element will ever match and a
   string with no producer are the same class of leftover. */
.sc-detail { margin-top: 8px; font-size: 11.5px; color: var(--red); word-break: break-all; }
.mini { width: 13px; height: 13px; color: var(--t3); }
.engine-actions {
  margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--line);
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.engine-hint { font-size: 11.5px; color: var(--t3); line-height: 1.4; }
</style>
