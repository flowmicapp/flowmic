<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import Icon from './components/Icon.vue';
import SttSettings from './components/SttSettings.vue';
import LlmSettings from './components/LlmSettings.vue';
import ScenarioCard from './components/ScenarioCard.vue';
import ScenarioInference from './components/ScenarioInference.vue';
import PrefsAppearance from './components/PrefsAppearance.vue';
import DataFlowDisclosure from './components/DataFlowDisclosure.vue';
// UP-3b in-app update — hangs below the existing "About" section, no new page
// (design doc §5.2).
import UpdateCard from './components/UpdateCard.vue';
// L3 account card (0.2.48): the plan / usage / subscription-expiry on the card are
// now answered by the server right now (`/api/me` + `/api/cloud/summary`), no
// longer a snapshot the Cloud Key carried from the moment it was issued. The
// Devices page's cloud card embeds the same component, so the two places never
// need separate fixes again.
import CloudAccountLines from './components/CloudAccountLines.vue';
// ⚠️ owner 2026-08-02 UI batch 1 ③: `TimelineStats` / `DataPortability` /
// `TimelineClear` **moved as a group to the Timeline page** (data operations belong
// next to the data itself). None of the three components changed a single line —
// what changed is only who mounts them; `TimelineClear`'s `@cleared` →
// `stats.refresh()` wiring moved right along with them (stats that don't refresh
// after a clear would keep reporting the pre-clear numbers, which is one of C2's
// acceptance items).
import { S } from '../lib/strings';
import { currentChannel, settingsPending } from './store';
import {
  CH,
  fetchAutostartState,
  fetchCloudStatus,
  fetchSidecarState,
  navigateMain,
  onChannel,
  setAutostartEnabled,
  type AutostartInfo,
  type SidecarStatus,
} from '../lib/bridge';
// 0.3.8 — the OS-owned doors moved out of bridge.ts when the 800-line cap bit.
import { openLogDirectory } from '../lib/bridge-os';
import { settingsSyncNotice } from '../lib/settings-sync-notice';
import {
  asCloudStatus,
  CHANNEL_LABEL,
  EMPTY_CLOUD_STATUS,
  type CloudStatus,
} from '../lib/channel';
import { useCloudAccount } from '../lib/use-cloud-account';
import { clearPos } from '../lib/capsule-position';
import { localKv } from '../lib/storage';
import { APP_VERSION } from '../lib/version';

type Sec = 'account' | 'stt' | 'llm' | 'prefs' | 'about' | 'privacy';
// V2-07.8a: a COMPUTED, not a setup-time array — `label: S.set_nav_account`
// evaluated once would keep the nav in the launch language after a switch.
//
// ⚠️ owner 2026-08-02 UI batch 1 ③: the sixth item, "Data", was removed and moved
// as a group to the Timeline page. This array is back to 0.2.38's five-item shape —
// the previous round's note "Data was APPENDED at the end, nothing above it moved"
// is exactly why it can now be cleanly removed: what's deleted is the trailing
// item, "About" becomes the spy's "last section" again, and the other four items'
// positions match the 2026-08-04 real-device execution sheet exactly (the "saved
// locally" badge on the Account row is unchanged).
const SECS = computed<Array<{ id: Sec; label: string }>>(() => [
  { id: 'account', label: S.set_nav_account },
  { id: 'stt', label: S.set_nav_stt },
  { id: 'llm', label: S.set_nav_llm },
  { id: 'prefs', label: S.set_nav_prefs },
  { id: 'about', label: S.set_nav_about },
  // 0.3.0 P1 — APPENDED at the end, same reasoning as the "Data" item that used
  // to live here: the four positions above are the ones the 2026-08-04 real-device
  // sheet names, and appending is the one edit that leaves every one of them
  // where the sheet says it is. Being last in the body costs nothing for
  // reachability — this nav lists every section the moment the page opens.
  { id: 'privacy', label: S.disc_nav },
]);

const active = ref<Sec>('account');
const cloud = ref<CloudStatus>({ ...EMPTY_CLOUD_STATUS });
/** RV-94 (B4-11): the LAN sidecar's own phase — settings_scope_lan means every
 *  write this page makes targets it, and ONLY it (owner ⑤); `currentChannel`
 *  (active-channel dot elsewhere) says nothing about whether IT is up, so a
 *  cloud-connected user with a dead LAN sidecar would otherwise see a green
 *  footer and a mute "saved locally" with no way to learn why. */
const sidecar = ref<SidecarStatus | null>(null);
const resetDone = ref(false);
const logOpenPending = ref(false);
/** V2-10 launch at startup. null = unknown state (read failed or not yet read
 *  back) — never render a toggle direction that hasn't been verified (criterion
 *  4). The displayed value always comes from reading the system registry back,
 *  never from settings storage. */
const autostart = ref<AutostartInfo | null>(null);
/** The failure reason is shown verbatim (criterion 1: a registration/read-back
 *  failure must be visible in the UI). */
const autostartError = ref<string | null>(null);
const autostartPending = ref(false);
/** null = no failure yet. A string = the REASON, shown verbatim: "the directory
 *  doesn't exist" and "the shell won't open" need different fixes, and swallowing
 *  the difference is what makes a forensic path unusable at the exact moment it
 *  is needed. */
const logOpenError = ref<string | null>(null);

/** RV-新B — the CURRENT channel (admission-derived, from the CONNECTION frame), not
 *  the deleted `cloud.channel` preference flag which was a constant "local LAN". */
const channelLabel = computed(() => CHANNEL_LABEL[currentChannel.value]);
const signedIn = computed(() => cloud.value.key_set);
// L3: plan/usage/subscription-expiry no longer read from `cloud` (JWT claims) —
// the `planBadge(cloud.plan)` and `formatExpiry(cloud.expires_at)` computeds have
// been deleted; they were the source of those two "snapshot from issuance time"
// lines. The Cloud Key's own exp is still shown, but is now carried by this
// binding to the "Cloud Key valid until" line.
const { card: accountCard, refresh: refreshAccount } = useCloudAccount(cloud);
/** RV-94: 'saved' | 'pending_transient' | 'pending_no_service' — see
 *  lib/settings-sync-notice.ts for why `settingsPending` alone cannot answer
 *  "why, and what should I do". */
const syncNotice = computed(() => settingsSyncNotice(settingsPending.value, sidecar.value?.phase ?? null));

async function loadCloud(): Promise<void> {
  cloud.value = await fetchCloudStatus();
}

function goDevices(): void {
  navigateMain('devices');
}

function resetCapsulePos(): void {
  clearPos(localKv);
  resetDone.value = true;
  window.setTimeout(() => {
    resetDone.value = false;
  }, 1200);
}

/** The precondition for apply-and-persist-immediately is knowing the true value
 *  first: clicking the toggle while the state is unknown is not a "switch", it's
 *  a re-read. */
async function loadAutostart(): Promise<void> {
  const r = await fetchAutostartState();
  if (r.ok) {
    autostart.value = r.info;
  } else {
    autostart.value = null;
    autostartError.value = `${S.set_prefs_autostart_read_failed}${r.reason}`;
  }
}

async function toggleAutostart(): Promise<void> {
  if (autostartPending.value) return;
  if (autostart.value === null) {
    await loadAutostart();
    return;
  }
  autostartPending.value = true;
  autostartError.value = null;
  try {
    const r = await setAutostartEnabled(!autostart.value.enabled);
    if (r.ok) {
      // r.info is the real system state after the Rust side reads it back and
      // verifies it, not the value we hoped for.
      autostart.value = r.info;
    } else {
      autostartError.value = `${S.set_prefs_autostart_failed}${r.reason}`;
      // Even a write that fails partway through must let the display follow the
      // truth (e.g. it got registered but the re-check failed).
      const s = await fetchAutostartState();
      if (s.ok) autostart.value = s.info;
    }
  } finally {
    autostartPending.value = false;
  }
}

async function openLogs(): Promise<void> {
  if (logOpenPending.value) return;
  logOpenPending.value = true;
  logOpenError.value = null;
  try {
    const r = await openLogDirectory();
    logOpenError.value = r.ok ? null : r.reason;
  } finally {
    logOpenPending.value = false;
  }
}

/** owner 2026-07-27 (the Settings page tab-group switching effect didn't match
 *  the web version).
 *
 *  The nav is a scroll-spy, so a click had TWO writers racing for `active`: the
 *  click set it, then every frame of the smooth scroll fired `spy()`, which
 *  re-derived it from the position the animation happened to be passing through.
 *  The highlight therefore walked across the intermediate sections and landed
 *  wherever the animation finished — and how far that is depends on the window
 *  height, which is precisely why the wide web window and the narrower PC window
 *  behaved differently. Hold the spy off until the scroll settles: an explicit
 *  click is a statement of intent, not a suggestion. */
let spySuppressed = false;
let settleTimer = 0;

function scrollTo(id: Sec): void {
  active.value = id;
  const el = document.getElementById(`set-${id}`);
  if (!el) return;
  spySuppressed = true;
  window.clearTimeout(settleTimer);
  // `scrollend` is not available in every WebView2 build we ship against, so a
  // timeout is the floor rather than the optimisation.
  settleTimer = window.setTimeout(() => {
    spySuppressed = false;
  }, 700);
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Nearest scrollable ancestor (the main-window `.content`), or null. */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement;
  while (p) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll') return p;
    p = p.parentElement;
  }
  return null;
}

function spy(): void {
  if (spySuppressed) return;
  const root = document.getElementById('set-account');
  if (!root) return;
  // Devices/Timeline/Settings are all mounted at once and toggled with v-show,
  // and they SHARE one scroll container (.content) — so this handler also fires
  // while Settings is display:none, and while hidden every getBoundingClientRect()
  // is 0. Every comparison below is then meaningless: the section loop matches
  // all five and latches the LAST one, so the nav would open highlighting About
  // instead of Account. `offsetParent === null` is exactly the display:none state.
  if (root.offsetParent === null) return;
  const scroller = scrollParentOf(root);
  // Bottom of the scroller: the trailing section (About) is shorter than the
  // viewport, so its top NEVER reaches the threshold below — the old spy could
  // not select it at all, and clicking it snapped the highlight back to
  // Preferences. At the end of the scroll the last section is the honest answer,
  // and it is also what the user is actually looking at.
  if (scroller !== null && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
    active.value = SECS.value[SECS.value.length - 1]!.id;
    return;
  }
  const top = scroller ? scroller.getBoundingClientRect().top + 24 : 24;
  let current: Sec = SECS.value[0]!.id;
  for (const { id } of SECS.value) {
    const el = document.getElementById(`set-${id}`);
    if (!el) continue;
    if (el.getBoundingClientRect().top <= top + 8) current = id;
  }
  active.value = current;
}

let scroller: HTMLElement | null = null;
let unlistenCloud: (() => void) | null = null;
let unlistenSidecar: (() => void) | null = null;

onMounted(async () => {
  // RV-24: register the listener first, then pull the snapshot — the rule
  // store.ts spells out at its snapshot seed («register first so a frame
  // arriving mid-seed is not lost, then ask for the current state»). A
  // cloud-state push that lands between the pull and the listen is lost for the
  // session; both halves are idempotent.
  unlistenCloud = await onChannel<unknown>(CH.cloudState, (p) => {
    cloud.value = asCloudStatus(p);
  });
  await loadCloud();
  // RV-94: same register-then-pull edge for the LAN sidecar's own phase (this
  // page's syncNotice, not the footer dot's active-channel one).
  unlistenSidecar = await onChannel<SidecarStatus>(CH.sidecarState, (p) => {
    sidecar.value = p;
  });
  sidecar.value = await fetchSidecarState();
  // Re-read the real system autostart state every time the Settings page is
  // entered — after the user manually disables it in Windows Settings/Task
  // Manager, this must show "off" (criterion 4).
  void loadAutostart();
  await nextTick();
  const anchor = document.getElementById('set-account');
  scroller = anchor ? scrollParentOf(anchor) : null;
  scroller?.addEventListener('scroll', spy, { passive: true });
  spy();
});

onUnmounted(() => {
  scroller?.removeEventListener('scroll', spy);
  window.clearTimeout(settleTimer);
  unlistenCloud?.();
  unlistenSidecar?.();
});
</script>

<template>
  <div>
    <div class="page-head">
      <h2>{{ S.settings_title }}</h2>
      <span class="savehint">{{ S.settings_savehint }}</span>
      <span v-if="syncNotice === 'pending_no_service'" class="saved local noservice" style="margin-left:auto">
        <Icon name="inbox" />{{ S.dev_chan_lan_suspended }}
      </span>
      <span v-else-if="syncNotice === 'pending_transient'" class="saved local" style="margin-left:auto">
        <Icon name="inbox" />{{ S.saved_local }}
      </span>
      <span v-else class="saved" style="margin-left:auto"><Icon name="check" />{{ S.saved }}</span>
    </div>
    <!-- RV-94 (B4-11): the other half of "saved locally" — when the locally-hosted
         server-core hasn't started, clearly explain why + what to do, rather than
         leaving the user to guess (owner's own words from the 2026-08-01 real-device
         session). -->
    <div v-if="syncNotice === 'pending_no_service'" class="sync-no-service" role="alert">
      <span>{{ S.saved_local_no_service_hint }}</span>
      <button class="btn ghost sm" type="button" @click="goDevices">
        <Icon name="devices" />{{ S.set_account_goto_devices }}
      </button>
    </div>

    <div class="set-wrap">
      <nav class="set-nav" aria-label="settings sections">
        <button v-for="s in SECS" :key="s.id" type="button" :class="{ on: active === s.id }" @click="scrollTo(s.id)">
          {{ s.label }}
        </button>
      </nav>

      <div class="set-body">
        <!-- Account -->
        <section id="set-account" class="set-sec">
          <h3>{{ S.set_account_title }}</h3>
          <p class="hint">{{ S.set_account_hint }}</p>
          <div class="card pad">
            <div class="acct-line">
              <span class="muted">{{ S.set_account_channel }}</span>
              <b>{{ channelLabel }}</b>
            </div>
            <CloudAccountLines v-if="signedIn" :card="accountCard" @retry="refreshAccount" />
            <div v-else class="acct-line">{{ S.set_account_signed_out }}</div>
            <button class="btn ghost sm" style="margin-top:10px" @click="goDevices">
              <Icon name="devices" />{{ S.set_account_goto_devices }}
            </button>
          </div>
        </section>

        <!-- Speech recognition (existing component, includes the scenario card) -->
        <div id="set-stt">
          <SttSettings />
          <ScenarioCard />
        </div>

        <!-- Language model + V2-08 scenario-inference consent (the consent is
             specifically about the LLM endpoint above, so this card sits right
             below the endpoint input box, where the user can see what they're
             consenting to) -->
        <div id="set-llm">
          <LlmSettings />
          <ScenarioInference />
        </div>

        <!-- Preferences: only genuinely actionable items -->
        <section id="set-prefs" class="set-sec">
          <h3>{{ S.set_prefs_title }}</h3>
          <p class="hint">{{ S.set_prefs_hint }}</p>
          <!-- UI language + theme (V2-07.8a): apply-and-persist-immediately, the
               capsule window follows via UI_PREFS_SYNC -->
          <PrefsAppearance />
          <!-- Launch at startup (V2-10): the whole row is the toggle; state is read
               from the system registry, failures are shown loudly -->
          <div class="card pad prefs-row as-toggle" :class="{ busy: autostartPending || autostart === null }" @click="toggleAutostart">
            <span class="chk" :class="{ on: autostart?.enabled === true }"><Icon name="check" /></span>
            <div>
              <div class="prefs-label">{{ S.set_prefs_autostart }}</div>
              <div class="muted" style="font-size:12px;margin-top:2px">{{ S.set_prefs_autostart_hint }}</div>
            </div>
          </div>
          <div v-if="autostart?.registered_cmd" class="autostart-path mono">
            {{ S.set_prefs_autostart_path }}{{ autostart.registered_cmd }}
          </div>
          <div v-if="autostart?.registered_exe_exists === false" class="log-open-error" role="alert">
            {{ S.set_prefs_autostart_dead }}
          </div>
          <div v-if="autostartError !== null" class="log-open-error" role="alert">{{ autostartError }}</div>
          <div class="card pad prefs-row">
            <div>
              <div class="prefs-label">{{ S.set_prefs_capsule_reset }}</div>
              <div class="muted" style="font-size:12px;margin-top:2px">{{ S.set_prefs_capsule_reset_hint }}</div>
            </div>
            <button class="btn ghost sm" style="margin-left:auto" @click="resetCapsulePos">
              <Icon name="refresh" />{{ resetDone ? S.set_prefs_capsule_reset_done : S.set_prefs_capsule_reset }}
            </button>
          </div>
        </section>

        <!-- About: the true version + a real bridge to the log directory (shows the
             manual path on failure) -->
        <section id="set-about" class="set-sec">
          <h3>{{ S.set_about_title }}</h3>
          <div class="card pad">
            <div class="acct-line">
              <span class="muted">{{ S.set_about_version }}</span>
              <b class="mono">{{ APP_VERSION }}</b>
            </div>
            <div class="sub-h" style="margin-top:14px;margin-bottom:6px">{{ S.set_about_log_title }}</div>
            <div class="muted" style="font-size:12.5px;line-height:1.55">{{ S.set_about_log_hint }}</div>
            <div class="log-open-row">
              <span class="mono">{{ S.set_about_log_path }}</span>
              <button class="btn ghost sm" type="button" :disabled="logOpenPending" @click="openLogs">
                {{ logOpenPending ? S.set_about_log_opening : S.set_about_log_open }}
              </button>
            </div>
            <div v-if="logOpenError !== null" class="log-open-error" role="alert">
              {{ S.set_about_log_open_failed }} <span class="mono">{{ S.set_about_log_path }}</span>
              <div class="log-open-reason mono">{{ logOpenError }}</div>
            </div>
          </div>
          <!-- UP-3b in-app update (design doc §5.2: "add a block below it, no new
               page"). 🔴 No "check for updates" item added to the tray, not a single
               word added to the capsule — two entry points would mean two state
               sources, and the capsule is the overlay shown while transcribing
               (ambient surfacing never grabs focus = red line). -->
          <div class="card pad" style="margin-top:12px">
            <UpdateCard />
          </div>
        </section>
        <!-- 0.3.0 P1 privacy and data — the core path (audio → recognition → optional
             language-model processing → injection into this PC) plus the
             privacy-policy / terms entry. The scenario-inference consent card
             above covers ONE optional feature; this section covers the path
             every single sentence takes. -->
        <section id="set-privacy" class="set-sec">
          <h3>{{ S.disc_title }}</h3>
          <p class="hint">{{ S.disc_entry_sub }}</p>
          <DataFlowDisclosure />
        </section>
        <!-- owner 2026-08-02 UI batch 1 ③: the "Data" section moved as a group to the
             Timeline page (TimelinePage.vue's `tl-data` area). **No orphan heading is
             left behind here, and no placeholder card either** — a section with
             nothing but a heading left is worse than no section at all: it promises a
             group of functionality that isn't here. None of the three components
             themselves changed; only their mount point did. -->
      </div>
    </div>
  </div>
</template>

<style scoped>
.acct-line { display: flex; align-items: baseline; gap: 8px; font-size: 13px; margin-bottom: 6px; flex-wrap: wrap; }
.acct-line b { font-weight: 600; }
.prefs-row { display: flex; align-items: center; gap: 14px; }
.prefs-row.as-toggle { cursor: pointer; margin-bottom: 12px; }
.prefs-row.as-toggle.busy { cursor: default; opacity: .6; }
.prefs-label { font-size: 13.5px; font-weight: 600; }
.autostart-path { font-size: 11.5px; color: var(--t3); margin: -6px 2px 10px; word-break: break-all; line-height: 1.5; }
.log-open-row { display: flex; align-items: center; gap: 12px; margin-top: 8px; flex-wrap: wrap; font-size: 12.5px; }
.log-open-error { margin-top: 8px; color: var(--red); font-size: 12px; line-height: 1.5; }
.log-open-reason { margin-top: 3px; color: var(--t3); font-size: 11.5px; word-break: break-word; }
.log-open-row .btn:disabled { opacity: .5; cursor: default; }
/* RV-94 (B4-11): the actionable notice row for "saved locally" because "the local
   service hasn't started". */
.sync-no-service {
  display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
  margin: -6px 0 14px; padding: 8px 12px; border-radius: 8px;
  background: var(--amber-soft); color: var(--amber-ink); font-size: 12px; line-height: 1.55;
}
.sync-no-service .btn { margin-left: auto; flex-shrink: 0; }
.saved.local.noservice { color: var(--amber-ink); }
</style>
