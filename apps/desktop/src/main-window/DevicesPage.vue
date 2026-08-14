<script setup lang="ts">
// WP-R23-1 device page (demo desktop.html L280-316). Shows the channels, the
// "Paired phones" table, and THIS PC's card; the "Add phone" button opens the pairing
// modal — a big 4-digit code plus a QR built from a LOCAL dep (no CDN). For a
// loopback endpoint the QR is suppressed and only the code + a LAN-address hint
// are shown (F-2346).
//
// R6 T-8: the paired-phone table is REAL. It used to show only "N online" with a
// standing note that the server exposed no per-device query event — that gap is
// now closed by the additive `pc:list-mobiles` (04 §3.1), so the card lists each
// phone's name/pairing time/last activity/online dot. Three states are kept apart
// deliberately: loading / read failed (loud) / genuinely no pairings — a failed
// read must never render as "not a single one". `online` is the server's live
// room presence; nothing here upgrades a phone to online on its own.
//
// R6 T-2 (dual-channel, REDESIGN §5.2): the channels row is now TWO cards — "Local
// LAN" and "Cloud relay" — with an explicit single-select (07 §6: exactly one live
// connection). The cloud card carries the Cloud Key paste form and renders every
// failure LOUDLY: an expired / refused key says so and asks for a new paste, and
// the channel never silently reverts to LAN pretending to work.
// The pairing modal gains a channel tab because the two pairing stories differ:
// LAN pairs by QR/code on the same Wi-Fi, cloud pairs by code only once the phone
// is on the same relay.
//
// N5 (owner requirement ②): that tab is now a real SWITCH, and this page owns which
// channel it points at (`pairTarget`) because this page is the only reader of the
// pairing snapshot — one fetcher, one truth. While the modal is closed the target
// tracks the active channel, so the cards outside the modal see exactly what they
// saw before.

import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import Icon from './components/Icon.vue';
import PairingModal from './components/PairingModal.vue';
import PairedList from './components/PairedList.vue';
import CloudAccountLines from './components/CloudAccountLines.vue';
// REQ-12-14: the head both channel cards wear (identity tile · name · state pill).
// One component so the two cards cannot drift — read its header for the C-8 note.
import ChannelCardHead from './components/ChannelCardHead.vue';
// REQ-12-14: This-machine card, split out because it must NOT inherit `.chan`'s
// new channel-identity chrome (see that file's 🔴 block).
import SelfPcCard from './components/SelfPcCard.vue';
// MAC-08: non-Windows plaintext credentials disclosure (full-width under
// This-machine).
import CredentialsAtRestNote from './components/CredentialsAtRestNote.vue';
import { conn, connByChannel, currentChannel } from './store';
import { S, SIDECAR_LABEL } from '../lib/strings';
import {
  CH,
  clearCloudKey,
  fetchCloudStatus,
  fetchPairedMobilesView,
  fetchPairingInfo,
  fetchSidecarState,
  onChannel,
  refreshPairingCode,
  retrySidecar,
  saveCloudKey,
  type SidecarStatus,
} from '../lib/bridge';
import {
  asCloudStatus,
  DEFAULT_CLOUD_ENDPOINT,
  deriveCloudCard,
  deriveLanCard,
  EMPTY_CLOUD_STATUS,
  isJwtShaped,
  type ChannelId,
  type CloudStatus,
} from '../lib/channel';
// REQ-12-10b: the same-machine shell's summary line. Pure, and it reads the two
// cards' OWN dots — never a second derivation of "whether this channel is up".
import { summariseChannelGroup } from '../lib/channel-card-state';
// L3 account card (0.2.48): this card's account block and the one on the Settings
// page are the same component fetching the same data — before this, the two
// places each drew the same four lines separately, so the "plan is a snapshot"
// defect had to be fixed twice, and could end up fixed two different ways.
import { useCloudAccount } from '../lib/use-cloud-account';
// REQ-12-01: the sign-out second confirm as a pure state machine. Split out of
// this file rather than trimmed into it — the gate block pushed the SFC to 807
// lines, 7 over the cap, and the repo's standing move at the cap is a structural
// split (PairingModal.vue and devices-page.css both came out of THIS file that
// way). It also lands the confirm exactly where its sibling on this same page
// already lives: lib/release-mobile.ts, the revoke gate.
import {
  armSignOut,
  disarmSignOut,
  newSignOutConfirm,
  runSignOut,
  SIGN_OUT_CONFIRM_TTL_MS,
} from '../lib/cloud-signout-gate';
import { cloudPairBlock, formatPcid, initialPairTab, isLoopbackEndpoint, type PairingInfo } from '../lib/pairing';
import { mergeWithCache, readPairedCache, writePairedCache, type PairedPresenceView } from '../lib/paired-mobiles';
import { localKv } from '../lib/storage';
import {
  applySelectedHost,
  loadSelectedHost,
  resolveSelected,
  saveSelectedHost,
  type LanCandidate,
} from '../lib/lan-endpoint';

const EMPTY: PairingInfo = { short_code: null, endpoint: '', pc_name: '', connected: false, mobiles: 0, lan_candidates: [] };

const rawInfo = ref<PairingInfo>({ ...EMPTY });

// ── GA-21: which LAN address the phone is told to dial ──────────────────────
// The server's ranking is a DEFAULT; this machine's owner knows which cable the
// phone actually shares. Device-local, never a synced setting (see lan-endpoint).
const selectedHost = ref<string | null>(loadSelectedHost());

const lanCandidates = computed<LanCandidate[]>(() =>
  (rawInfo.value.lan_candidates ?? []).map((address) => ({
    address,
    // The server marks these; the desktop only needs the flag, and re-deriving
    // it here would be a second classifier to drift. Recomputed narrowly: an
    // address outside RFC1918 that the server still offered IS the non-standard
    // case, since the server already dropped loopback/APIPA.
    nonStandardPrivate: !/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(address),
  })),
);

const effectiveHost = computed(() => resolveSelected(lanCandidates.value, selectedHost.value));

/** Everything downstream (QR payload, modal endpoint, the listen-address label)
 *  reads THIS, so one selection moves all three — there is no second place a
 *  stale endpoint can survive. */
const info = computed<PairingInfo>(() => ({
  ...rawInfo.value,
  endpoint: applySelectedHost(rawInfo.value.endpoint, effectiveHost.value),
}));

function pickHost(host: string): void {
  selectedHost.value = host;
  saveSelectedHost(host);
}

/** owner 2026-08-02 UI batch 1 ⑤: "this machine's listen address is collapsed by
 *  default, the control becomes a 'Change listen IP' style".
 *
 *  ⚠️ This does not contradict owner 2026-07-30 ②'s "list every one, don't hide
 *  them inside a <select>" — the two govern two different things, and it's worth
 *  spelling out because the next reader might glance at this and assume this
 *  round overturned the last one:
 *    · The previous round's red line was **the address the phone actually needs
 *      must never be invisible** (the bug back then was a single address being
 *      swallowed by a <select>, leaving not one readable address on screen). That
 *      address **still stays resident now** — the `.addr` mono pill on the card
 *      renders exactly `lanEndpointLabel`, i.e. the one the QR code is currently
 *      carrying, after `applySelectedHost`. What's collapsed is **the other
 *      candidates**, not the answer itself.
 *    · What this round collapses is **the act of switching to a different
 *      address**. It's an occasional decision on a multi-NIC machine, and it was
 *      making the LAN card noticeably taller than the cloud card (owner's
 *      screenshot's second complaint was exactly this).
 *  Session-local, same as the cloud-account fold: this is the state of "do I
 *  want to change it right now", not a setting. */
const lanIpsOpen = ref(false);
/** REQ-12-11 — LAN local-service + firewall note fold. Session-local like
 *  `lanIpsOpen` / `cloudDetailOpen`. Default CLOSED so the two channel cards
 *  share a thin resting face; sidecarFailed / lanCard.loud force the body open
 *  (U11: the firewall note must stay reachable — never 「only when failed」). */
const lanServiceOpen = ref(false);
const modalOpen = ref(false);

/** N5 — the channel the pairing snapshot is being read FOR (the modal's tab).
 *  Declared here rather than inside the modal because `loadInfo` below is the only
 *  place that calls `pairing_code`, and "which channel to ask" and "who does the
 *  asking" have to be the same decision or the answer and the tab drift apart.
 *  Kept in step with the active channel while the modal is closed (see the watch
 *  further down). */
const pairTarget = ref<ChannelId>('lan');

/** 0.2.66 — the relay's PCID for this PC, for the cloud card's own line.
 *
 *  🔴 READ ON THE CLOUD CHANNEL SPECIFICALLY, not off `rawInfo`. `rawInfo` follows
 *  `pairTarget`, which tracks the ACTIVE channel while the modal is closed — so on a
 *  LAN-primary machine it describes the sidecar and its `pcid` is `null` by contract.
 *  Reading it there would have produced the plainest façade shape there is: a line
 *  that renders on exactly the machines that do not need it and stays blank on the
 *  ones that do, with every test green.
 *
 *  Skipped entirely with no Cloud Key: there is no relay session to ask, and that is
 *  also the state in which the card shows the paste form instead of this line. */
const cloudPcid = ref<string | null>(null);

async function loadInfo(): Promise<void> {
  rawInfo.value = await fetchPairingInfo(pairTarget.value);
  if (pairTarget.value === 'cloud') {
    cloudPcid.value = rawInfo.value.pcid ?? null;
  } else if (cloud.value.key_set) {
    cloudPcid.value = (await fetchPairingInfo('cloud')).pcid ?? null;
  } else {
    cloudPcid.value = null;
  }
}

/** The modal picked a channel: point the snapshot at it and re-read IMMEDIATELY.
 *  Not on the next 3 s LAN poll and not on the 1 s countdown tick — the user just
 *  changed which server the phone should dial. */
async function pickPairChannel(channel: ChannelId): Promise<void> {
  pairTarget.value = channel;
  await loadInfo();
}

// ── Paired-phones card (R6 T-8, pc:list-mobiles) ──
// undefined = still reading · null = the read FAILED (loud) · view = the truth.
// The states, the per-handset grouping and the row actions all render inside
// <PairedList> (split out in the 2026-07-29 polish); this page only fetches.
const pairedView = ref<PairedPresenceView | null | undefined>(undefined);
const pairedLoading = ref(false);

async function loadPaired(): Promise<void> {
  if (pairedLoading.value) return;
  pairedLoading.value = true;
  try {
    // A failed read is assigned VERBATIM (null) — never coerced to [], which the
    // card would render as "no paired phones yet", i.e. a lie about the pairing state.
    const raw = await fetchPairedMobilesView();
    if (raw === null) {
      pairedView.value = null;
      return;
    }
    // Design doc §2.2: unreachable channels answer from the last-known cache, marked
    // "state unknown", instead of their rows silently vanishing (which the owner's
    // screenshot showed reads as "the pairing was lost"). The merge is pure; this
    // page only wires storage in and out.
    const merged = mergeWithCache(raw, readPairedCache(localKv), new Date());
    writePairedCache(localKv, merged.nextCache);
    pairedView.value = merged.view;
  } finally {
    pairedLoading.value = false;
  }
}

async function openModal(): Promise<void> {
  // N5 — open on the channel that can actually pair: the active one, unless that is
  // a cloud channel with no usable Cloud Key (signing out keeps the cloud channel
  // selected, deliberately — T-2 ⑤), in which case LAN. Never a disabled tab.
  pairTarget.value = initialPairTab(activeChannel.value, cloudBlock.value !== null);
  await loadInfo();
  // No fresh code available (post-reconnect / stale) but connected → mint one
  // BEFORE showing the modal, so it never flashes "no pairing code yet" on the way in.
  // Minted on the pairing target, which is the channel whose address the modal is
  // about to show — `info.connected` is that channel's own link since N5.
  if (info.value.connected && !info.value.short_code) {
    if (await refreshPairingCode(pairTarget.value)) await loadInfo();
  }
  modalOpen.value = true;
}

function closeModal(): void {
  modalOpen.value = false;
}

// ── GA-10: rename THIS PC ──────────────────────────────────────────────────
// The rename state machine and the This-machine card's connection dot moved into
// components/SelfPcCard.vue with the card itself (REQ-12-14). This page still
// owns the snapshot, so it hands the card `pcName` and its own `loadInfo` as the
// post-rename re-read.

/** Whether the PAIRING endpoint is loopback — the QR's question (F-2346) and the
 *  trigger for the re-poll below. Follows the pairing tab, like `endpoint` itself. */
const loopback = computed(() => isLoopbackEndpoint(info.value.endpoint));
const endpointLabel = computed(() => info.value.endpoint || '—');
/** The Local-LAN card's OWN address, whatever the pairing tab points at. */
const lanOwnEndpoint = computed(() =>
  applySelectedHost(rawInfo.value.lan_endpoint ?? '', effectiveHost.value),
);
/** The Local-LAN card's OWN address. Falls back to `endpoint` only when this
 *  build's shell did not send one — and never when `endpoint` is the relay,
 *  because printing the cloud URL on the LAN card is the bug this replaces. */
const lanEndpointLabel = computed(() => {
  if (lanOwnEndpoint.value !== '') return lanOwnEndpoint.value;
  // N5 — the fallback may only be taken when the snapshot on hand really describes
  // the LAN channel. `endpoint` follows the PAIRING channel, and the modal can now
  // point that at the relay while LAN is still the active channel, so the old
  // `activeChannel === 'lan'` guard would print the relay URL right here — the exact
  // 0.2.4 defect this fallback lives inside. An untagged snapshot (older shell)
  // keeps the previous guard.
  const snapshotIsLan =
    rawInfo.value.channel === undefined
      ? activeChannel.value === 'lan'
      : rawInfo.value.channel === 'lan';
  return snapshotIsLan ? endpointLabel.value : '—';
});
/** Whether the LAN CHANNEL is reachable only from this machine — the LAN card's own
 *  question, so it is answered from the LAN card's own address rather than from the
 *  pairing endpoint (which since N5 can be the relay while LAN is active). An empty
 *  address means "not resolved yet", which `isLoopbackEndpoint('')` has always
 *  reported as loopback — the same value this used to get from the dialed
 *  loopback URL. */
const lanLoopback = computed(() => isLoopbackEndpoint(lanOwnEndpoint.value));
const pcName = computed(() => info.value.pc_name || 'FlowMic PC');

// ── sidecar (self-hosted server) status — 07 §5, WP-R2-4 ──
const sidecar = ref<SidecarStatus | null>(null);
const retrying = ref(false);
const sidecarLabel = computed(() => (sidecar.value ? SIDECAR_LABEL[sidecar.value.phase] ?? S.sidecar_starting : S.sidecar_starting));
const sidecarFailed = computed(() => sidecar.value?.phase === 'failed');
const sidecarHealthy = computed(() => sidecar.value?.phase === 'healthy' || sidecar.value?.phase === 'adopted_external');

async function doRetrySidecar(): Promise<void> {
  if (retrying.value) return;
  retrying.value = true;
  try {
    sidecar.value = (await retrySidecar()) ?? sidecar.value;
  } finally {
    retrying.value = false;
  }
}

// F-2343: while the modal is open and the endpoint is still loopback, re-poll the
// pairing snapshot every 3 s so a late-resolving LAN IP flips the QR on without a
// manual refresh (the Rust side polls /api/network; this just re-reads it).
let lanPoll: ReturnType<typeof setInterval> | null = null;
watch([modalOpen, loopback], ([open, isLoop]) => {
  if (open && isLoop && lanPoll === null) {
    lanPoll = setInterval(() => void loadInfo(), 3000);
  } else if ((!open || !isLoop) && lanPoll !== null) {
    clearInterval(lanPoll);
    lanPoll = null;
  }
});

// ── GA-08: disconnect / unpair one paired phone ──────────────────────────────────
// The state machine (lib/release-mobile) and its bridge binding moved into
// <PairedList> with the rows themselves — same machine, same deps
// ({ release: releaseMobile, reload: loadPaired }), only the address changed.

// ── cloud relay channel (R6 T-2) ──
const cloud = ref<CloudStatus>({ ...EMPTY_CLOUD_STATUS });
const keyInput = ref('');
const endpointInput = ref('');
const savingKey = ref(false);
// Local paste-shape complaint (the Rust side re-checks and latches its own).
const keyShapeError = ref(false);

/** RV-新B — the channel the "Add phone" modal OPENS on: the CURRENT one, derived from
 *  which phone is admitted (`store.currentChannel` ← the CONNECTION frame's own tag).
 *
 *  It used to be `cloud.value.channel`, i.e. the Rust `CloudConfig.active` flag whose
 *  writer owner 2026-07-30 ② deleted — a constant `'lan'`. A user whose only phone is
 *  on the relay therefore had the modal open on Local LAN and got a code minted by a
 *  sidecar that phone cannot reach. The tab is still user-switchable; this only decides
 *  which one is showing when the dialog appears. */
const activeChannel = computed<ChannelId>(() => currentChannel.value);
/** N5 ③ — whether the cloud relay can be paired through at all. Same pure decision
 *  the modal uses for its disabled option; read here only to choose the tab the
 *  modal OPENS on, so the two can never disagree about "whether the cloud can be
 *  paired through". */
const cloudBlock = computed(() =>
  cloudPairBlock({
    keySet: cloud.value.key_set,
    endpoint: cloud.value.endpoint,
    readiness: cloud.value.readiness,
  }),
);

// N5 — while the modal is CLOSED the pairing target follows the active channel, so
// every other reader of this snapshot (the "This computer" card, the LAN address
// pill, the endpoint picker) sees exactly what it saw before this card. While it is OPEN
// the tab owns the target and this must not yank it back — a cloud-state push
// arriving mid-pairing would otherwise silently swap the QR under the user's phone.
watch(
  () => [activeChannel.value, modalOpen.value] as const,
  ([active, open]) => {
    if (!open) pairTarget.value = active;
  },
  { immediate: true },
);
// GA-28: each card reads ITS OWN channel's socket, not the global one. With both
// channels resident, `conn` is the PRIMARY channel's snapshot — feeding it to
// both cards would paint the other card with a link that is not its own.
const lanUp = computed(() => connByChannel.lan?.connected === true);
const cloudUp = computed(() => connByChannel.cloud?.connected === true);

/** EVERY resident channel's own phone count, as one comparable value.
 *
 *  🔴 The real defect from owner 2026-08-02 UI batch 1 ② is exactly here
 *  (screenshot: the phone card's header says "offline" while right next to it
 *  it says "last active just now"). This watch's original source included
 *  `conn.mobiles`, and `conn` **by construction is only the snapshot of the
 *  primary channel** (main-window/store.ts's `applyConnectionRows` does a bare
 *  `continue` on `primary === false`). `lanUp` / `cloudUp` from that same source
 *  also don't track phones — they read `connByChannel[x].connected`, i.e. the
 *  **desktop ↔ server** socket.
 *  ⇒ When a phone joins/leaves the room on a **non-primary channel**, none of
 *  these three values move, `loadPaired()` never gets triggered, and that
 *  column's online dot freezes on whatever it last read. This is precisely the
 *  first of the four classes of structural defects: "pushed state with no
 *  matching pull".
 *
 *  ⚠️ Why "one concatenated string" rather than listing the two numbers
 *  separately: `connByChannel` is a reactive **dictionary**, and channels are
 *  keys that only appear at runtime (a single-channel shell has just one).
 *  Fixed enumeration like `connByChannel.lan?.mobiles` / `.cloud?.mobiles`
 *  would silently miss a future third channel, and that kind of omission has
 *  no symbol you can grep for.
 *  ⚠️ `conn.mobiles` was **removed** from the source, not forgotten: it is a
 *  subset of this summary (the primary channel's row is also in
 *  `connByChannel`), and keeping it would just be a second answer to the same
 *  question. */
const perChannelMobiles = computed(() =>
  Object.keys(connByChannel)
    .sort()
    .map((ch) => `${ch}:${connByChannel[ch]?.mobiles ?? 0}`)
    .join('|'),
);

// Refresh the snapshot whenever the connection state or ANY channel's phone count
// changes, so the endpoint / pc_name and the paired table (incl. its live online dots)
// stay current.
//
// owner 2026-07-27: this watch USED to sit ~120 lines above, before `lanUp` and
// `cloudUp` were declared. `immediate: true` runs the source getter synchronously
// while `watch()` is being called, so it read two `const`s that were still in the
// temporal dead zone → `ReferenceError: Cannot access 'lanUp' before
// initialization` on EVERY mount of this page. Vue caught it around the getter, so
// there was no visible crash — it just truncated the watcher's dependency set at
// `conn.mobiles`, silently un-wiring the very LAN/cloud re-query the comment above
// promises. It must be declared after the computeds it depends on.
watch(
  () => [conn.connected, conn.registered, perChannelMobiles.value, lanUp.value, cloudUp.value] as const,
  () => {
    void loadInfo();
    void loadPaired();
  },
  { immediate: true },
);
const lanCard = computed(() =>
  deriveLanCard({
    connected: lanUp.value,
    sidecarPhase: sidecar.value?.phase ?? null,
    // N5: the CARD's own address, not the pairing endpoint — see lanLoopback.
    loopback: lanLoopback.value,
  }),
);
const cloudCard = computed(() => deriveCloudCard({ status: cloud.value, connected: cloudUp.value }));

/** REQ-12-10b — the same-machine shell's one line.
 *
 *  It quotes the two cards' OWN verdicts (`ChannelCard.dot`) rather than asking
 *  `connByChannel` a second time. That is not a shortcut: a shell that derived
 *  readiness independently could say "2/2 ready" above a card whose own pill
 *  reads "unavailable", which is this repo's number-one defect shape (one
 *  question, two answers). The array order is the render order, and the TOTAL
 *  comes from its length —
 *  a third card would be counted, not silently dropped. */
const channelSummary = computed(() =>
  summariseChannelGroup([lanCard.value.dot, cloudCard.value.dot]).label,
);

// D4 (2026-07-29 polish) — the cards' SECOND status layer: how many phones are
// actually connected over each channel, read from that channel's OWN connByChannel
// snapshot (never the primary's `conn.mobiles`, which belongs to one channel).
// Pure presentation — nothing here feeds any switching logic ("automatic LAN
// preference"-style auto-switching is explicitly out of scope).
const lanMobiles = computed(() => connByChannel.lan?.mobiles ?? 0);
const cloudMobiles = computed(() => connByChannel.cloud?.mobiles ?? 0);
function accessLine(n: number): string {
  return n > 0 ? S.dev_chan_ready_mobiles.replace('{n}', String(n)) : S.dev_chan_ready_no_mobiles;
}
const lanAccessLine = computed(() => accessLine(lanMobiles.value));
const cloudAccessLine = computed(() => accessLine(cloudMobiles.value));

// owner 2026-07-30 ②: the per-card "advanced" folds are GONE with the "set as
// primary channel" verb they existed to hide. The cards are an information panel now.
/** The cloud account fold: CLOSED by default once signed in and nothing is wrong
 *  (owner ② "when signed in, collapsed by default"). Session-local, like the old
 *  diag fold. */
const cloudDetailOpen = ref(false);
const { card: accountCard, refresh: refreshAccount } = useCloudAccount(cloud);
const cloudEndpointLabel = computed(() => cloud.value.endpoint || DEFAULT_CLOUD_ENDPOINT);

function applyCloud(next: CloudStatus): void {
  // REQ-12-01 — the signed-in/out state changed under the card (a push from the
  // relay, a key just pasted, the sign-out we ourselves just ran). Whatever the
  // user was being asked, they are no longer being asked THAT. Disarm before the
  // block re-renders, never after.
  if (next.key_set !== cloud.value.key_set) cancelClearKey();
  cloud.value = next;
  // Keep the endpoint box on the saved value (or the protocol default) unless the
  // user is mid-edit — never blank a field they are typing into.
  if (document.activeElement?.getAttribute('data-field') !== 'cloud-endpoint') {
    endpointInput.value = next.endpoint || DEFAULT_CLOUD_ENDPOINT;
  }
}

async function loadCloud(): Promise<void> {
  applyCloud(await fetchCloudStatus());
}

async function doSaveKey(): Promise<void> {
  if (savingKey.value) return;
  const key = keyInput.value.trim();
  const endpoint = (endpointInput.value.trim() || DEFAULT_CLOUD_ENDPOINT).trim();
  keyShapeError.value = !isJwtShaped(key);
  if (keyShapeError.value) return; // fail-loud locally; nothing is sent or stored
  savingKey.value = true;
  try {
    applyCloud(await saveCloudKey(key, endpoint));
    // The key is now DPAPI-wrapped on the Rust side; drop the plaintext copy the
    // input is holding so it does not sit in the DOM for the rest of the session.
    keyInput.value = '';
  } finally {
    savingKey.value = false;
  }
}

// owner 2026-07-27 double confirm: signing out DESTROYS the stored Cloud Key —
// getting back in needs the key re-pasted or a fresh console login, so this is a
// delete wearing a logout label. Same inline-confirm shape the revoke row uses.
//
// REQ-12-01 — the arm/fire decision lives in lib/cloud-signout-gate.ts (read its
// 🔴 block for the defect). What stays here is only the WIRING, and the wiring is
// where the fix actually is: arming now starts a clock, and EVERY back-out path
// calls `cancelClearKey`. It used to have exactly one — the Cancel button — which
// is why collapsing the fold or switching pages left a red "Confirm sign out"
// armed for the rest of the session under this page's `v-show`.
const signOutConfirm = reactive(newSignOutConfirm());
let signOutTimer: ReturnType<typeof setTimeout> | null = null;

function askClearKey(): void {
  armSignOut(signOutConfirm);
  if (signOutTimer !== null) clearTimeout(signOutTimer);
  signOutTimer = setTimeout(() => disarmSignOut(signOutConfirm), SIGN_OUT_CONFIRM_TTL_MS);
}

function cancelClearKey(): void {
  if (signOutTimer !== null) clearTimeout(signOutTimer);
  signOutTimer = null;
  disarmSignOut(signOutConfirm);
}

/** The fold toggle is a BACK-OUT path: collapsing the card is how a user says
 *  "never mind" without hunting for Cancel. Re-opening must ask again. */
function toggleCloudDetail(): void {
  cloudDetailOpen.value = !cloudDetailOpen.value;
  cancelClearKey();
}

async function doClearKey(): Promise<void> {
  if (signOutTimer !== null) clearTimeout(signOutTimer);
  signOutTimer = null;
  const next = await runSignOut(signOutConfirm, clearCloudKey);
  if (next !== null) applyCloud(next);
}

let unlistenSidecar: (() => void) | null = null;
let unlistenCloud: (() => void) | null = null;
onMounted(async () => {
  // RV-24: register the listener first, then pull the snapshot — the rule
  // store.ts spells out at its snapshot seed («register first so a frame
  // arriving mid-seed is not lost, then ask for the current state»). A
  // cloud-state / sidecar push that lands between the pull and the listen is
  // gone for the session; both halves are idempotent.
  unlistenSidecar = await onChannel<SidecarStatus>(CH.sidecarState, (p) => {
    sidecar.value = p;
    // A sidecar that just became healthy → re-read the pairing snapshot (its
    // endpoint / LAN address may now be available).
    if (p.phase === 'healthy' || p.phase === 'adopted_external') void loadInfo();
  });
  unlistenCloud = await onChannel<unknown>(CH.cloudState, (p) => {
    // Pushed on every channel switch / key change / relay refusal (the refusal
    // arrives unprompted — that is how an expired key surfaces without a reload).
    applyCloud(asCloudStatus(p));
    void loadInfo();
  });
  sidecar.value = await fetchSidecarState();
  await loadCloud();
});
onUnmounted(() => {
  if (lanPoll !== null) clearInterval(lanPoll);
  if (signOutTimer !== null) clearTimeout(signOutTimer);
  unlistenSidecar?.();
  unlistenCloud?.();
});
</script>

<template>
  <div>
    <div class="page-head">
      <h2>{{ S.dev_title }}</h2>
      <span style="margin-left:auto">
        <button class="btn pri" @click="openModal"><Icon name="plus" />{{ S.dev_add_phone }}</button>
      </span>
    </div>

    <!-- channels (GA-28 dual-channel resident; owner 2026-07-26 ①: the local
         service folded into this card).
         owner 2026-07-30 ②: both cards are an INFORMATION PANEL — no channel is
         "selected" any more, so neither card is highlighted and neither offers a switch.
         What they show is what a connection is made of: health, the addresses the
         phone can reach, how many phones are on this channel, and (cloud) who is
         logged in.

         REQ-12-10b (same-machine grouping shell): the two cards describe the two
         channels of THIS machine, and side by side they used to read as two
         unrelated grey panels. The shell states the relation — and states ONLY
         that. It is not a card: no border-radius trickery merges the two, neither
         card loses its own status, its own address or its own actions. The mobile
         side's law is the same one (machine_group.dart: "what's missing is a
         statement of 'belonging to the same machine', not a merge").
         🔴 Merging the pair into one clickable card is forbidden by the ruling. -->
    <section class="chan-group">
      <div class="cg-head">
        <Icon name="devices" class="cg-ic" />
        <span class="cg-t">{{ S.dev_chan_group_title }}</span>
        <!-- Answerable by construction: the count is the two cards' own dots,
             not a third opinion — see `channelSummary` in <script>. -->
        <span class="cg-sum" :title="S.dev_chan_group_hint">{{ channelSummary }}</span>
      </div>
      <div class="channels">
        <!-- owner 2026-08-01: colour + icon combination, must not rely on colour
             alone — C-8's criterion (still uses CHANNEL_VISUAL, the one definition
             in lib/channel.ts). REQ-12-14 moved this entire row into
             <ChannelCardHead>: one implementation serving both cards, so tile
             size/heading weight/pill shape/status-word table can **structurally**
             never drift apart. C-8's original reason for rejecting the
             `.chan-badge` colour block (it would compete for attention with the
             health dot) holds exactly as it did and is honoured: that colour now
             lives in the leftmost icon tile (identity), while the health state
             moved to its own pill on the far right (status) — the two ends
             separated, each answering one question. Criteria and red lines are in
             that component's file header. -->
        <div class="card chan ch-lan">
          <ChannelCardHead channel="lan" :dot="lanCard.dot" />
          <div class="st">{{ lanCard.status }}</div>
          <!-- D4 second layer: phones actually connected over THIS channel right now.
               Only while the channel is up — a down channel's .st already says so. -->
          <div v-if="lanUp" class="st2">{{ lanAccessLine }}</div>
          <!-- 2026-07-29 polish: a bare "—" line was noise under the status text,
               which already says the channel is standing by. The address pill only
               appears when there IS an address worth copying down. -->
          <span v-if="lanEndpointLabel !== '—'" class="addr mono">{{ lanEndpointLabel }}</span>
          <!-- owner 2026-07-30 ② "the LAN shows the listening IP; when there are
               multiple, list them all". EVERY address
               this host listens on (not only when there are two, and not hidden
               inside a <select> — an address the phone needs but nobody can see is a
               silent failure). The non-RFC1918 ones are LABELLED, not demoted
               (GA-21), and the one the pairing QR carries says so. Clicking one
               moves the QR to it — GA-21's device-local choice, which is about THIS
               machine's NICs, not about which channel to use.
               owner 2026-08-02 UI batch 1 ⑤: the LIST is now behind "Change listen
               IP", closed by default. The address in use is untouched and still
               permanently on the card (the `.addr` pill above) — see
               `lanIpsOpen`'s note in <script> for why that keeps ②'s red line
               intact rather than walking it back. -->
          <div v-if="lanCandidates.length > 0" class="lanips">
            <button class="fold-toggle" type="button" @click="lanIpsOpen = !lanIpsOpen">
              <Icon name="edit" class="mini" />
              <span>{{ lanIpsOpen ? S.dev_fold_less : S.dev_lan_edit }}</span>
              <span class="diag-chev" :class="{ open: lanIpsOpen }">▾</span>
            </button>
            <template v-if="lanIpsOpen">
              <span class="lanips-l">{{ S.dev_lan_listen }}</span>
              <div class="lanips-row">
                <button
                  v-for="c in lanCandidates"
                  :key="c.address"
                  type="button"
                  class="lanip mono"
                  :class="{ on: c.address === effectiveHost }"
                  :title="S.dev_lan_pick"
                  @click="pickHost(c.address)"
                >
                  {{ c.address }}<span v-if="c.nonStandardPrivate" class="lanip-note"> · {{ S.dev_lan_nonstandard }}</span>
                  <span v-if="c.address === effectiveHost" class="lanip-note"> · {{ S.dev_lan_in_qr }}</span>
                </button>
              </div>
            </template>
          </div>
          <!-- owner 2026-07-26 ①: the local service is a FACT ABOUT this channel (the LAN
               channel IS the self-hosted server), so its line lives inside this
               card rather than in a standalone one. Retry keeps working here.
               REQ-12-11: resting face matches the cloud card — status on the fold
               toggle; firewall wall + detail behind it. Failure / loud auto-open
               (same shape as cloudDetailOpen || cloudCard.loud). U11 still holds:
               the note is mounted whenever the body is open, including the healthy
               path after a tap — never `v-if="sidecarFailed"` alone. -->
          <button
            v-if="!sidecarFailed && !lanCard.loud"
            class="fold-toggle"
            type="button"
            @click="lanServiceOpen = !lanServiceOpen"
          >
            <span class="dot" :class="sidecarHealthy ? 'g' : 'o'"></span>
            <span>{{ S.sidecar_title }} · {{ sidecarLabel }}</span>
            <span class="diag-chev" :class="{ open: lanServiceOpen }">▾</span>
          </button>
          <div v-if="sidecarFailed || lanCard.loud" class="sc-inline" :class="{ bad: sidecarFailed }">
            <span class="dot" :class="sidecarHealthy ? 'g' : sidecarFailed ? 'r' : 'o'"></span>
            <span>{{ S.sidecar_title }}</span>
            <span class="sc-status">{{ sidecarLabel }}</span>
            <button v-if="sidecarFailed" class="btn ghost sm" style="margin-left:auto" :disabled="retrying" @click="doRetrySidecar">
              <Icon name="refresh" />{{ retrying ? S.sidecar_retrying : S.sidecar_retry }}
            </button>
          </div>
          <template v-if="lanServiceOpen || sidecarFailed || lanCard.loud">
            <div v-if="sidecarFailed && sidecar?.detail" class="sc-detail mono">{{ sidecar.detail }}</div>
            <!-- U11: a passing loopback probe ≠ other devices can connect in. The
                 boundary between the node.exe popup and "ready" must be stated
                 openly. REQ-12-11 put it inside the fold body, but the healthy path
                 can still be opened with one click; the failure path forces it open. -->
            <div class="sc-fw-note">{{ S.sidecar_firewall_note }}</div>
          </template>
          <div v-if="lanCard.loud" class="chan-loud">{{ lanCard.loud }}</div>
        </div>

        <div class="card chan ch-cloud">
          <ChannelCardHead channel="cloud" :dot="cloudCard.dot" />
          <div class="st">{{ cloudCard.status }}</div>
          <div v-if="cloudUp" class="st2">{{ cloudAccessLine }}</div>
          <span class="addr mono">{{ cloudEndpointLabel }}</span>
          <!-- 0.2.66 (owner 2026-08-14): the relay now addresses this PC by a PCID,
               and a phone pairing over the cloud needs it BEFORE any modal is open —
               someone reads it out loud, or types it while looking at this card.
               Gated on the cloud socket being up as well as on the value existing:
               the id is cached per session, so showing it under a dead link would be
               reporting "the relay calls it this" with nothing currently saying so.
               The LAN card has no counterpart and must not grow one. -->
          <div v-if="cloudUp && cloudPcid" class="pcid-line">
            <span class="pcid-line-l">{{ S.pair_pcid_label }}</span>
            <span class="pcid-line-v mono">{{ formatPcid(cloudPcid) }}</span>
          </div>
          <div v-if="cloudCard.loud" class="chan-loud">{{ cloudCard.loud }}</div>

          <!-- owner 2026-07-26 ①: equal height with the LAN card — the account
               details fold away by default when signed in AND nothing is wrong.
               A loud problem or a signed-out state auto-expands (the fold must
               never hide the paste form someone needs, or a failure). -->
          <button v-if="cloud.key_set && !cloudCard.loud" class="fold-toggle" type="button" @click="toggleCloudDetail">
            <span>{{ cloudDetailOpen ? S.dev_fold_less : S.dev_fold_more }}</span>
            <span class="diag-chev" :class="{ open: cloudDetailOpen }">▾</span>
          </button>
          <!-- signed in: what the Cloud Key itself asserts (no invented email) -->
          <div v-if="cloud.key_set && (cloudDetailOpen || cloudCard.loud)" class="acct">
            <div class="acct-row">
              <span class="chip key-chip">{{ S.cloud_key_label }} · {{ S.cloud_key_set }}</span>
            </div>
            <CloudAccountLines :card="accountCard" @retry="refreshAccount" />
            <!-- REQ-12-01: same three-part shape the phone's confirm now uses —
                 the QUESTION, the consequence, and "what this does NOT touch" in
                 its own check-marked block. The last part is why the phone copy
                 was longer than this one for four versions: "Sign out" reads to
                 most people as "delete my account", and this machine is the OWNER
                 of the timeline (0.2.26), so "are my records gone" is the first
                 thing a user asks here — and the old strip answered neither. -->
            <button v-if="!signOutConfirm.armed" class="btn ghost sm" @click="askClearKey"><Icon name="x" />{{ S.cloud_key_clear }}</button>
            <div v-else class="pm-confirm">
              <span class="pm-confirm-t" style="flex:1 0 100%;font-weight:700">{{ S.cloud_key_clear_q }}</span>
              <span class="pm-confirm-t" style="flex:1 0 100%">{{ S.cloud_key_clear_confirm }}</span>
              <div style="flex:1 0 100%">
                <div class="acct-line" style="font-weight:600">{{ S.cloud_key_clear_unaffected }}</div>
                <div v-for="k in [S.cloud_key_clear_keeps_records, S.cloud_key_clear_keeps_account]" :key="k"
                  class="acct-line" style="display:flex;gap:5px;align-items:flex-start;margin-top:3px">
                  <Icon name="check" style="width:12px;height:12px;flex:none;margin-top:2px" /><span>{{ k }}</span>
                </div>
              </div>
              <!-- Cancel first and NOT the red one: the accidental click lands on the
                   way out. The danger button carries the icon as well as the fill,
                   so the two are told apart without colour (owner 2026-08-01 C-8). -->
              <button class="btn ghost sm" @click="cancelClearKey">{{ S.dev_release_cancel }}</button>
              <button class="btn danger sm" @click="doClearKey"><Icon name="x" />{{ S.cloud_key_clear_do }}</button>
            </div>
          </div>

          <!-- signed out (or a refused key): the paste form -->
          <!-- signed out ONLY. Explicit condition, not v-else: the fold above
               narrows the acct block's v-if, and a bare v-else would render this
               paste form whenever the details are merely FOLDED — a signed-in
               card asking you to sign in (the exact bug the first live screenshot
               of this rework caught). -->
          <div v-if="!cloud.key_set" class="keyform">
            <label class="fld">
              <span class="fld-l">{{ S.cloud_endpoint_label }}</span>
              <input v-model="endpointInput" class="input" data-field="cloud-endpoint" spellcheck="false"
                :placeholder="DEFAULT_CLOUD_ENDPOINT" />
            </label>
            <div class="fld-hint">{{ S.cloud_endpoint_hint }}</div>
            <label class="fld">
              <span class="fld-l">{{ S.cloud_key_label }}</span>
              <input v-model="keyInput" class="input" type="password" spellcheck="false" autocomplete="off"
                :placeholder="S.cloud_key_ph" @keyup.enter="doSaveKey" />
            </label>
            <div v-if="keyShapeError" class="chan-loud">{{ S.cloud_err_malformed }}</div>
            <button class="btn pri sm" :disabled="savingKey || keyInput.trim() === ''" @click="doSaveKey">
              {{ savingKey ? S.saving : S.cloud_key_save }}
            </button>
          </div>

        </div>
      </div>
    </section>

    <!-- paired mobiles — REAL rows from pc:list-mobiles (R6 T-8), rendered per
         physical handset (2026-07-29 polish D1) by PairedList.vue. This page
         still owns the fetch (loadPaired); the card owns the states, the
         grouping, the row actions and their release state machine binding. -->
    <PairedList :view="pairedView" :reload="loadPaired" />

    <!-- this PC — GA-10 made the name editable HERE and nowhere else (04 §3.7;
         owner's iron rule: "naming on the PC side can only be controlled by the
         PC side"). The card itself moved into
         components/SelfPcCard.vue (REQ-12-14): it must not inherit `.chan`'s new
         channel-identity chrome, because it is not a channel. This page still
         owns the snapshot, so it hands the card the name and its own re-read. -->
    <div class="sub-h">{{ S.dev_self }}</div>
    <SelfPcCard :pc-name="pcName" :sidecar-phase="sidecar?.phase ?? null" :cloud="cloud" :reload="loadInfo" />
    <CredentialsAtRestNote />

    <!-- pairing modal (split out at the file-size cap; same behaviour) -->
    <PairingModal
      :open="modalOpen"
      :info="info"
      :channel="pairTarget"
      :cloud="cloud"
      @close="closeModal"
      @reload="loadInfo"
      @channel="pickPairChannel"
    />
  </div>
</template>

<style scoped src="./devices-page.css"></style>
