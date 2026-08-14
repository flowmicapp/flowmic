<script setup lang="ts">
// The "Add Phone" (添加手机) modal, split out of DevicesPage.vue when GA-10's
// rename UI pushed that file past the 800-line cap. Nothing about the modal
// changed in the move: it owns the big 4-digit code, the locally-rendered QR
// (a LOCAL dep, never a CDN — WP-R23-1 ruling 2), the GA-18 live countdown
// with its auto-refresh, and the channel tabs.
//
// The parent still owns the pairing SNAPSHOT (it is the same `pairing_code` read
// the device page renders elsewhere), so this component takes it as a prop and
// asks the parent to re-read after minting a fresh code. One reader, one truth.
//
// N5 (owner requirement ②) — the channel tabs used to be LABELS: only the
// globally active channel could hold a code, and the other tab said "go switch
// channels on the device page first." They are now the CHOICE: picking one
// re-reads that channel's code + address immediately (not on the next 3 s
// poll) and redraws the QR from it. Two honesty gates come with that, and they
// are the reason this file grew:
//   • a cloud channel with no usable Cloud Key is DISABLED with its reason on
//     screen — never an empty or relay-less QR that cannot scan (`cloudPairBlock`);
//   • the snapshot carries the channel it describes, so during the async re-read
//     nothing is drawn from the previous channel's answer (`reason === 'pending'`).
// The LAN 「address not resolved yet」 case is unchanged and still the existing
// F-2346 path: `qrSuppressed` with `reason === 'loopback'`.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (QR payload / short code TTL)
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (F-2346 loopback ⇒ QR suppressed)
//   docs/strategy/2026-07-25-full-gap-audit/02-DESKTOP.md GA-18 (live countdown)

import { computed, onUnmounted, ref, watch } from 'vue';
import QRCode from 'qrcode';
import Icon from './Icon.vue';
import { S } from '../../lib/strings';
import { PAIR_APP_URL } from '../../lib/strings/pairing';
import { refreshPairingCode } from '../../lib/bridge';
import { CHANNEL_LABEL, CHANNEL_VISUAL, cloudLoudReason, type ChannelId, type CloudStatus } from '../../lib/channel';
import {
  cloudPairBlock,
  derivePairAddresses,
  derivePairingModal,
  formatPcid,
  pairChannelOf,
  type PairingInfo,
} from '../../lib/pairing';
import { deadlineFrom, deriveCountdown, shouldAutoRefresh, shouldMintAbsent } from '../../lib/pair-countdown';

const props = defineProps<{
  open: boolean;
  info: PairingInfo;
  /** The channel this modal is pairing THROUGH — owned by the parent because the
   *  parent is the only fetcher of `info`, and the two must move together. */
  channel: ChannelId;
  // ⚠️ owner 2026-08-02 UI batch 1 ①: the `activeChannel` prop is GONE along
  // with the "primary channel" (主通道) dot it fed — it was this component's
  // ONLY use of it, and a prop the parent computes, passes and nothing reads
  // is the plainest façade there is. The parent still owns `activeChannel`: it
  // decides which tab the modal OPENS on (`initialPairTab`), which is a real
  // behaviour and unaffected. What died is the CLAIM on screen that one of the
  // two tabs is the "primary channel" — a word the user can do nothing with.
  /** The cloud channel's real state — the ONLY input to whether its option can be
   *  offered at all. Taken raw (not a pre-computed boolean) so the reason shown is
   *  the same wording the device page's cloud card uses for the same fact. */
  cloud: CloudStatus;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'reload'): void;
  /** The user picked a channel — the parent re-reads THAT channel's snapshot. */
  (e: 'channel', channel: ChannelId): void;
}>();

const refreshing = ref(false);
const refreshFailed = ref(false);
const qrDataUrl = ref<string | null>(null);
/** owner 2026-07-26 ⑦: a QR that failed to RENDER used to just… not appear —
 *  the catch below nulled the image and said nothing, which is a silent failure
 *  wearing empty space. Now the modal says so and offers the code + endpoint as
 *  the manual path. */
const qrRenderFailed = ref(false);

// The tested decision core: what the modal shows (code / QR / suppress + why).
//
// GA-31: the CLOUD tab now gets a QR too. R6 declined to draw one on the theory
// that a phone must join the relay account first — but that is a reason the
// pairing can FAIL, not a reason to withhold the endpoint and the code. A QR
// carrying both is strictly better than making the user type a relay URL on a
// phone keyboard, and an un-joined phone gets the server's loud ack either way.
// `buildQrPayload` has accepted the `saas` channel since WP-R23-1; until now
// nothing ever passed it.
const view = computed(() => derivePairingModal(props.info, pairChannelOf(props.channel)));

/** 0.2.66 — the PCID as the eye reads it, `XXX XXX XXX`.
 *
 *  🔴 THE CLIPBOARD DOES NOT GET THIS. `copyPcid` below writes `view.pcid`, the raw
 *  nine digits, because the phone's field is digits-only: the grouped form would be
 *  stripped at best and refused at worst, and "I copied what it displayed" is
 *  precisely how a copy button becomes a wrong answer. Grouping is legibility,
 *  nothing else. */
const pcidDisplay = computed(() => (view.value.pcid ? formatPcid(view.value.pcid) : ''));

/** Fail-loud copy state, two flags because they are two facts and only one of them
 *  can be true at a time: "written" (fades) and "refused" (stays until the next
 *  attempt or the next open). A refused write is TOLD, and the message names the
 *  fallback — the digits are on screen. owner ⑦'s standing rule on this modal: never
 *  a button that silently does nothing. */
const pcidCopied = ref(false);
const pcidCopyFailed = ref(false);
let pcidCopyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyPcid(): Promise<void> {
  const raw = view.value.pcid;
  if (!raw) return;
  pcidCopyFailed.value = false;
  try {
    // The main window is an ordinary focusable WebView2 document, so the async
    // clipboard API works here — same call TimelinePage.vue's copy() makes. (The
    // capsule cannot: it carries WS_EX_NOACTIVATE and goes through the native
    // `capsule_copy_text` command instead. Two windows, two mechanisms, on purpose.)
    await navigator.clipboard.writeText(raw);
    pcidCopied.value = true;
    if (pcidCopyTimer !== null) clearTimeout(pcidCopyTimer);
    // owner 2026-08-01 "notice lifecycle matches fact lifecycle": "copied" is
    // an EVENT, so it fades. The PCID row beside it is a STATE and stays.
    pcidCopyTimer = setTimeout(() => { pcidCopied.value = false; }, 1600);
  } catch {
    pcidCopied.value = false;
    pcidCopyFailed.value = true;
  }
}

/** B4-15 — the addresses, in words, for the person TYPING into a phone.
 *
 *  The QR now carries every LAN address (`alt=`) and the phone probes them and
 *  picks a reachable one with no user decision. That leaves one gap this closes:
 *  someone on the "manual entry" tab (no camera / permission refused) sees only
 *  what the desktop prints. Before this the modal printed no address at all, and
 *  the device page's list is behind the modal the user is standing in front of.
 *
 *  LAN only: on the relay there is a single address and it is already the one
 *  in the QR, so a list would be one row repeating the endpoint. */
const addresses = computed(() =>
  props.channel === 'lan'
    ? derivePairAddresses(props.info.endpoint, props.info.lan_candidates)
    : { primary: '', others: [], dropped: [] },
);
const showAddresses = computed(
  () => addresses.value.primary !== '' || addresses.value.others.length > 0,
);

/** N5 ③ — why the cloud relay cannot be paired through at all (null = it can). */
const cloudBlock = computed(() =>
  cloudPairBlock({
    keySet: props.cloud.key_set,
    endpoint: props.cloud.endpoint,
    readiness: props.cloud.readiness,
  }),
);

/** WHY the cloud option is unavailable — shown on the disabled tab (as its title)
 *  and, when it is the selected one, in place of the code+QR block. `null` = the
 *  cloud channel can be paired through. */
const cloudBlockText = computed<string | null>(() => {
  switch (cloudBlock.value) {
    // Refused / lapsed: cloudLoudReason picks the wording that matches the ACTUAL
    // code ("please re-paste the Cloud Key" is a dead end for a registry-level
    // refusal), so this line and the device page's cloud card cannot disagree.
    case 'rejected':
      return cloudLoudReason(props.cloud) ?? S.cloud_err_refused;
    case 'no-endpoint':
      return S.cloud_err_no_endpoint;
    case 'no-key':
      return S.dev_chan_cloud_no_key;
    default:
      return null;
  }
});

/** The reason the SELECTED tab cannot pair at all, or null. Cloud-only: the LAN
 *  channel has no "not configured" state — a local server that is down is a
 *  CONNECTION problem, which `view.reason === 'disconnected'` already states, and an
 *  unresolved LAN address is the F-2346 `loopback` path. When this is non-null the
 *  modal renders the reason and nothing else: no code, no QR. */
const tabBlocked = computed<string | null>(() =>
  props.channel === 'cloud' ? cloudBlockText.value : null,
);

/** Whether "refresh pairing code" can do anything on the selected channel. A
 *  blocked tab has no server to mint on and a `pending` snapshot has not told
 *  us yet, so the button is disabled rather than allowed to produce a failure
 *  the user caused by clicking something we should not have offered.
 *  `info.connected` is per-channel since N5. */
const canRefresh = computed(
  () => tabBlocked.value === null && view.value.reason !== 'pending' && props.info.connected,
);

/** REQ-13-21 — the address block folds behind one line by default. The QR
 *  carries every address and a scanning phone picks one itself; the list serves
 *  the manual-typing path only. It AUTO-OPENS on the loud paths (loopback / QR
 *  render failure / dropped addresses) — a warning must never hide behind a
 *  closed disclosure — and never auto-closes on the user. */
const addrsOpen = ref(false);
watch(
  [() => view.value.reason, qrRenderFailed, () => addresses.value.dropped.length],
  ([reason, renderFailed, dropped]) => {
    if (reason === 'loopback' || renderFailed || (dropped as number) > 0) addrsOpen.value = true;
  },
  { immediate: true },
);

/** REQ-13-21 — one auto-mint per ABSENCE (see shouldMintAbsent's doc). Latched
 *  here, re-armed whenever the reason leaves 'no-code'. */
const autoMintTried = ref(false);
function maybeMintAbsent(): void {
  if (shouldMintAbsent({
    open: props.open,
    reason: view.value.reason,
    canRefresh: canRefresh.value,
    refreshing: refreshing.value,
    failed: refreshFailed.value,
    alreadyTried: autoMintTried.value,
  })) {
    autoMintTried.value = true;
    void doRefresh();
  }
}
watch(
  () => view.value.reason,
  (r) => {
    if (r !== 'no-code') {
      autoMintTried.value = false;
      return;
    }
    // The switch landed on a channel with no live code — mint NOW, not on the
    // next 1 s tick: the user is looking at the spot where a QR should be.
    maybeMintAbsent();
  },
);

/** Pick a pairing channel. The re-read is IMMEDIATE (the emit, not the 1 s tick):
 *  the user changed which server the phone should dial, so the code and the address
 *  on screen must both come from the new one before anything is scannable. */
function pickChannel(id: ChannelId): void {
  if (id === props.channel) return;
  // A disabled option is not a click we honour — see tabBlocked / the template.
  if (id === 'cloud' && cloudBlock.value !== null) return;
  refreshFailed.value = false;
  emit('channel', id);
}

// GA-18: `expires_in_ms` is a duration true at the instant it was read, so it is
// turned into an ABSOLUTE deadline once per snapshot (a stored duration would
// freeze the countdown — see lib/pair-countdown).
const codeDeadline = ref<number | null>(null);
const nowMs = ref(Date.now());
const countdown = computed(() => deriveCountdown(codeDeadline.value, nowMs.value));

watch(
  () => props.info,
  (i) => {
    codeDeadline.value = deadlineFrom(i.expires_in_ms, Date.now());
  },
  { immediate: true, deep: true },
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    refreshFailed.value = false;
    pcidCopied.value = false;
    pcidCopyFailed.value = false;
    addrsOpen.value = false; // collapsed on every open; the loud-path watch reopens if warranted
    autoMintTried.value = false;
    maybeMintAbsent(); // opening onto a code-less channel mints immediately too
  },
);

// Render the QR image (data URL) locally whenever the payload changes.
watch(
  () => view.value.qrPayload,
  async (payload) => {
    qrRenderFailed.value = false;
    if (!payload) {
      qrDataUrl.value = null;
      return;
    }
    try {
      qrDataUrl.value = await QRCode.toDataURL(payload, { margin: 1, width: 216, errorCorrectionLevel: 'M' });
    } catch {
      // Fail-loud: the user is TOLD the QR could not be drawn and pointed at
      // the manual path (code + endpoint are both on this modal already).
      qrDataUrl.value = null;
      qrRenderFailed.value = true;
    }
  },
  { immediate: true },
);

async function doRefresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  refreshFailed.value = false;
  try {
    // N5 — minted on the SELECTED channel, not on the global preference: this is
    // the code that has to match the endpoint in the QR beside it.
    if (await refreshPairingCode(props.channel)) {
      // Re-read the snapshot instead of patching the code in place: the new
      // code's DEADLINE lives in the same Rust cache, and taking both from one
      // read keeps the displayed code and its countdown describing one code.
      emit('reload');
    } else {
      refreshFailed.value = true; // fail-loud: never fabricate a code
    }
  } finally {
    refreshing.value = false;
  }
}

// GA-18: the 1 s tick that moves the countdown and mints a fresh code when the
// current one dies. Runs ONLY while the modal is open. The auto-refresh decision
// is the pure `shouldAutoRefresh` — it reuses the in-flight guard and stops dead
// on `refreshFailed`, so a down socket produces ONE loud failure rather than a
// refresh attempt every second.
let codeTick: ReturnType<typeof setInterval> | null = null;
watch(
  () => props.open,
  (open) => {
    if (open && codeTick === null) {
      nowMs.value = Date.now();
      codeTick = setInterval(() => {
        nowMs.value = Date.now();
        // N5: never auto-mint on a channel we just told the user cannot pair — that
        // would be a request whose only possible outcome is a failure banner.
        if (canRefresh.value && shouldAutoRefresh({
          open: props.open,
          deadline: codeDeadline.value,
          now: nowMs.value,
          refreshing: refreshing.value,
          failed: refreshFailed.value,
        })) { void doRefresh(); return; }
        // REQ-13-21 backstop: the immediate watches above cover switch/open, but a
        // snapshot that turns code-less while the modal sits open lands here.
        maybeMintAbsent();
      }, 1000);
    } else if (!open && codeTick !== null) {
      clearInterval(codeTick);
      codeTick = null;
    }
  },
);
onUnmounted(() => {
  if (codeTick !== null) clearInterval(codeTick);
  // 0.2.66 — the "copied" fade timer is a timer too. 0.2.51 cost a real leak by
  // disposing a ValueNotifier and forgetting the timer beside it; one line.
  if (pcidCopyTimer !== null) clearTimeout(pcidCopyTimer);
});
</script>

<template>
  <div v-if="open" class="modal-scrim" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <b>{{ S.pair_title }}</b>
        <button class="modal-x" @click="emit('close')"><Icon name="x" /></button>
      </div>

      <!-- U8: a first-time user landed here with no idea WHERE the thing that
           reads this code comes from. Shown for both channels (LAN also needs
           the phone app), always — not just on a blocked/pending tab. The
           download link only appears once `pair_app_url` is non-empty (S1);
           until then this is plain instructional text, never a dead <a>. -->
      <div class="pair-note">
        {{ S.pair_need_app }}
        <a v-if="PAIR_APP_URL" :href="PAIR_APP_URL" target="_blank" rel="noopener">{{ S.pair_get_app }}</a>
      </div>

      <!-- N5 (owner requirement ②): the channel SWITCH. Picking one re-reads
           that channel's code + address immediately and redraws the QR from
           it. A cloud option that cannot pair is really `disabled` — the
           reason sits right below.
           owner 2026-08-02 UI batch 1 ①: the second dot that marked the
           "primary channel" tab is GONE. Two dots on one row where only one is
           a control is a reading cost with no payoff — the `.on` tab state
           already says which channel this modal is showing, which is the only
           one the user can act on.
           owner 2026-08-01: colour + icon combination, must not rely on
           colour alone — the tab label is now the `.chan-badge`
           TimelinePage.vue/tokens.css already define (ONE definition,
           lib/channel.ts's CHANNEL_VISUAL), not a second private class. -->
      <div class="tabs">
        <button v-for="id in (['lan', 'cloud'] as ChannelId[])" :key="id" class="tab"
          :class="{ on: channel === id }"
          :disabled="id === 'cloud' && cloudBlock !== null"
          :title="id === 'cloud' && cloudBlockText ? cloudBlockText : undefined"
          @click="pickChannel(id)">
          <span class="chan-badge" :class="CHANNEL_VISUAL[id].css">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" v-html="CHANNEL_VISUAL[id].iconPath"></svg>
            {{ CHANNEL_LABEL[id] }}
          </span>
        </button>
      </div>

      <template v-if="tabBlocked">
        <!-- N5 ③ red line: state WHY, and draw no QR at all. An empty or relay-less
             QR here would be a code the phone can never use, presented as if it
             could — the exact "claiming something not actually done as done"
             shape. -->
        <div class="pair-warn">{{ tabBlocked }}</div>
        <!-- U8: `tabBlocked`'s text (dev_chan_cloud_no_key, owned by the sibling
             F5+U11 card's devices.ts) says a Cloud Key is needed but never says
             where one comes from. This modal does not own that string, so the
             pointer is a second line here rather than a rewrite of sibling copy.
             `no-key` only: 'rejected'/'no-endpoint' are not fixed by visiting the
             console, so this stays out of those cases. -->
        <div v-if="channel === 'cloud' && cloudBlock === 'no-key'" class="pair-note">
          {{ S.pair_cloud_console_hint }}
        </div>
      </template>
      <template v-else-if="view.reason === 'pending'">
        <!-- the snapshot on hand still describes the other channel (async re-read) -->
        <div class="pair-note">{{ S.pair_switching }}</div>
      </template>
      <template v-else-if="view.reason === 'disconnected'">
        <div class="pair-warn">{{ channel === 'cloud' ? S.cloud_pair_offline : S.pair_disconnected }}</div>
      </template>
      <template v-else>
        <!-- REQ-13-21 (owner 2026-08-13): the QR is the hero — scanning is the
             primary path — and the 4-digit code is ONE line under it instead of
             a 46px block above with its own hint. The old stack overflowed a
             720p window (the modal's own max-height below is the structural
             guarantee; this reorder is the density half).
             GA-31: a QR on BOTH tabs. The cloud one carries the relay endpoint
             (never a local NIC — the phone must reach the relay), so it also
             cannot hit the F-2346 loopback case; the account hint stays because
             joining the account is still a real prerequisite. -->
        <template v-if="!view.qrSuppressed && qrDataUrl">
          <img class="qr" :src="qrDataUrl" alt="pairing QR" />
        </template>
        <template v-else-if="view.reason === 'loopback'">
          <div class="pair-note">{{ S.pair_loopback }}</div>
        </template>
        <template v-else-if="qrRenderFailed">
          <!-- owner ⑦: never an unexplained blank where a QR should be -->
          <div class="pair-warn">{{ S.pair_qr_render_failed }}</div>
        </template>

        <!-- 0.2.66 (owner 2026-08-14) — cloud relay pairing needs BOTH the
             PCID and the pairing code, so the manual path on this tab needs
             BOTH on screen. Above the code because that is the order the
             phone asks for them, and because the PCID is the stable half: it
             is what someone reads out over the phone once, while the code
             below it is re-minted every five minutes.
             🔴 `view.pcid` is null on the LAN tab (derivePairingModal's channel
             gate), so this whole block is absent there and the local-LAN tab
             renders exactly as it did before this card — owner: "local LAN …
             has no PCID." -->
        <div v-if="view.pcid" class="pcid-box">
          <div class="pcid-l">{{ S.pair_pcid_label }}</div>
          <div class="pcid-row">
            <!-- Grouped for the eye; the button copies the RAW digits (copyPcid). -->
            <span class="pcid mono">{{ pcidDisplay }}</span>
            <button type="button" class="btn ghost sm pcid-copy" @click="copyPcid">
              <Icon name="copy" />{{ pcidCopied ? S.pair_pcid_copied : S.pair_pcid_copy }}
            </button>
          </div>
          <div v-if="pcidCopyFailed" class="pair-warn">{{ S.pair_pcid_copy_failed }}</div>
          <div class="pcid-hint">{{ S.pair_pcid_hint }}</div>
        </div>

        <!-- The manual path, always beside its QR (or standing in for a
             suppressed/failed one): the code stays visible in every state that
             HAS a code — loopback and render-failure point the user here. -->
        <div v-if="view.code" class="code-line">
          {{ S.pair_code_inline }}<span class="code-inline mono">{{ view.code }}</span>
        </div>
        <div v-else class="pair-warn">{{ S.pair_no_code }}</div>
        <div v-if="channel === 'cloud'" class="pair-note">{{ S.cloud_pair_hint }}</div>

        <!-- GA-18: a LIVE countdown when the server told us the deadline; the
             static TTL sentence only when it did not (never a made-up clock). -->
        <div class="pair-ttl muted">
          <!-- Only claim "auto-refreshing" while that is actually true: after
               a failed refresh the tick stops, so it would be a lie (the loud
               pair_refresh_failed line below is then the honest one). -->
          <template v-if="countdown.expired && !refreshFailed">{{ S.pair_expired_refreshing }}</template>
          <template v-else-if="countdown.label">
            {{ S.pair_expires_in }} <span class="mono ttl-num">{{ countdown.label }}</span>
          </template>
          <template v-else>{{ S.pair_ttl }}</template>
        </div>
        <div v-if="refreshFailed" class="pair-warn">{{ S.pair_refresh_failed }}</div>

        <!-- B4-15: the same addresses the QR carries, in text, for the manual
             path. `dropped` is loud on purpose — an address past the QR cap is
             reachable but NOT automatic, and a list that hid that would look
             complete while leaving the one NIC the phone needs off-screen.
             REQ-13-21: folded by default (see addrsOpen's doc — auto-opens on
             every loud path, so `dropped`/loopback/render-failure never hide). -->
        <div v-if="showAddresses" class="pair-addrs">
          <button type="button" class="addr-toggle" @click="addrsOpen = !addrsOpen">
            <span class="addr-chevron">{{ addrsOpen ? '▾' : '▸' }}</span>{{ S.pair_addr_toggle }}
          </button>
          <template v-if="addrsOpen">
            <div class="pair-addrs-l">{{ S.pair_addr_title }}</div>
            <div v-if="addresses.primary" class="pair-addr mono">
              {{ addresses.primary }}<span class="pair-addr-note"> · {{ S.pair_addr_in_qr }}</span>
            </div>
            <template v-if="addresses.others.length > 0">
              <div class="pair-addrs-sub">{{ S.pair_addr_others }}</div>
              <div class="pair-addr-row">
                <span v-for="h in addresses.others" :key="h" class="pair-addr mono">{{ h }}</span>
              </div>
            </template>
            <div v-if="addresses.dropped.length > 0" class="pair-addrs-sub warn">
              {{ S.pair_addr_dropped }} {{ addresses.dropped.join('、') }}
            </div>
          </template>
        </div>
      </template>

      <div class="modal-foot">
        <!-- N5: gated on the SELECTED channel (canRefresh), not on a global
             connection flag — offering "refresh pairing code" for a channel
             with no server is offering a button whose only outcome is a
             failure banner. -->
        <button class="btn ghost sm" :disabled="refreshing || !canRefresh" @click="doRefresh">
          <Icon name="refresh" />{{ S.pair_refresh }}
        </button>
        <button class="btn pri sm" @click="emit('close')">{{ S.pair_close }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-scrim { position: fixed; inset: 0; background: rgba(11, 16, 32, .42); display: flex; align-items: center; justify-content: center; z-index: 50; animation: scrim-in .16s ease; }
/* REQ-13-21 structural guarantee: the modal NEVER outgrows the window — on any
   window size the foot buttons stay reachable, scrolling inside if it must.
   The density reorder above makes scrolling rare; this line makes overflow
   impossible. Do not remove one on the strength of the other. */
.modal { width: 340px; max-height: calc(100vh - 48px); overflow-y: auto; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r16); box-shadow: var(--sh-lg); padding: 18px 20px 16px; animation: modal-in .2s cubic-bezier(.2, .8, .2, 1); }
/* 2026-07-29 polish: the modal used to pop in a single frame. A short
   rise-and-settle (capped to instant by the global reduced-motion rule) gives
   the layer a physical arrival without slowing anyone down. */
@keyframes scrim-in { from { opacity: 0; } }
@keyframes modal-in { from { opacity: 0; transform: translateY(10px) scale(.97); } }
.modal-head { display: flex; align-items: center; margin-bottom: 10px; }
.modal-head b { font-size: 15px; }
.modal-x { margin-left: auto; width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; color: var(--t3); }
.modal-x:hover { background: var(--line-soft); color: var(--t1); }
/* REQ-13-21: `.code-big` (46px) and `.pair-hint` left with their render sites. */
.code-line { text-align: center; font-size: 12.5px; color: var(--t2); margin: 6px 0 2px; }
.code-inline { font-size: 20px; font-weight: 700; letter-spacing: 4px; color: var(--brand); margin-left: 6px; }
.qr { display: block; width: 216px; height: 216px; margin: 6px auto 4px; border-radius: 10px; background: #fff; }
/* 0.2.66 PCID block (cloud tab only). Recessed like the address pills below, so it
   reads as "a value you can copy down" rather than as another status line. */
.pcid-box { margin: 8px 0 2px; padding: 8px 10px; background: var(--surface-inset); border-radius: 10px; }
.pcid-l { font-size: 11.5px; color: var(--t2); font-weight: 600; margin-bottom: 3px; }
.pcid-row { display: flex; align-items: center; gap: 8px; }
/* Wider tracking than the code pill: the grouping is what makes nine digits
   readable at a glance, and letter-spacing is half of that grouping. */
.pcid { flex: 1; font-size: 17px; font-weight: 700; letter-spacing: 1.5px; color: var(--t1); font-variant-numeric: tabular-nums; }
.pcid-copy { flex: none; }
.pcid-hint { font-size: 11px; color: var(--t3); line-height: 1.6; margin-top: 5px; }
.addr-toggle { display: flex; align-items: center; gap: 5px; width: 100%; font-size: 12px; color: var(--t2); padding: 2px 0; text-align: left; }
.addr-toggle:hover { color: var(--t1); }
.addr-chevron { font-size: 10px; color: var(--t3); }
.pair-note { font-size: 12px; color: var(--t2); line-height: 1.6; background: var(--amber-soft); border: 1px solid var(--amber-line); border-radius: 10px; padding: 10px 12px; margin: 6px 0; }
.pair-warn { font-size: 12.5px; color: var(--red); background: var(--red-soft); border-radius: 10px; padding: 10px 12px; margin: 6px 0; text-align: center; }
.pair-ttl { text-align: center; margin-top: 6px; }
/* B4-15 address list — same recessed mono pill the device page uses for an
   address you read off the screen and type into a phone. */
.pair-addrs { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
.pair-addrs-l { font-size: 11.5px; color: var(--t2); font-weight: 600; margin-bottom: 5px; }
.pair-addrs-sub { font-size: 11px; color: var(--t3); line-height: 1.6; margin: 6px 0 4px; }
.pair-addrs-sub.warn { color: var(--amber-ink); }
.pair-addr-row { display: flex; flex-wrap: wrap; gap: 6px; }
.pair-addr { display: inline-block; font-size: 11.5px; color: var(--t2);
  background: var(--surface-inset); border-radius: 7px; padding: 3px 8px; word-break: break-all; }
.pair-addr-note { color: var(--t3); }
.modal-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.ttl-num { font-variant-numeric: tabular-nums; }
/* pairing modal channel tabs */
.tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.tab { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px; font-size: 12.5px; font-weight: 600; color: var(--t2); padding: 7px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); }
.tab.on { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }
/* N5: a channel that cannot pair reads as unavailable rather than merely unselected
   — the reason is on its title and, once it can be selected, in the body. */
.tab:disabled { opacity: .5; cursor: default; }
/* `.tab-dot` was removed along with the "primary channel" it marked (owner 2026-08-02 UI batch 1 ①). */
.btn.pri:disabled, .btn.ghost:disabled { opacity: .5; cursor: default; }
</style>
