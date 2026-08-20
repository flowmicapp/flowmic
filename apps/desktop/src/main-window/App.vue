<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from './components/Icon.vue';
import BrandMark from './components/BrandMark.vue';
import FirstRunLocale from './components/FirstRunLocale.vue';
import AccessibilityNotice from './components/AccessibilityNotice.vue';
// 2026-08-19 §5-B — the built-in speech model, said BEFORE the user holds the
// button and speaks. Mounted unconditionally (its own v-if is inside), because
// it also owns this window's single model-status poller — see the component.
import LocalModelNotice from './components/LocalModelNotice.vue';
import DevicesPage from './DevicesPage.vue';
import ConnDiagPage from './ConnDiagPage.vue';
import TimelinePage from './TimelinePage.vue';
import SettingsPage from './SettingsPage.vue';
import { conn, currentChannel, initBridge, lanConnected } from './store';
import { initUpdateStore, updateAvailable } from './update-store';
import { pullServerSettings, watchServerSettingsUpdates } from './settings-model';
import {
  CH,
  UI_NAVIGATE,
  UI_NAVIGATE_DOM,
  fetchCloudStatus,
  fetchSidecarState,
  onChannel,
  type SidecarStatus,
} from '../lib/bridge';
import type { MainPage } from '../lib/bridge';
import { asCloudStatus, EMPTY_CLOUD_STATUS, type CloudStatus } from '../lib/channel';
import { deriveConnDot } from '../lib/conn-dot';
import { S } from '../lib/strings';
import { localKv } from '../lib/storage';
import { profileKeys, resolveFirstRunPrompt } from '../lib/strings/first-run-locale';

type Page = MainPage;
const PAGES: readonly Page[] = ['devices', 'timeline', 'settings', 'diag'];
const page = ref<Page>('devices');

/** U1 — does this install still owe the user the one-time language question?
 *
 *  🔴 The signal is NOT "the profile is empty". It cannot be: `./store` above is
 *  imported by this file, and constructing its TimelineStore at module scope
 *  already stamped three `flowmic.history.*` keys into a brand-new profile
 *  before a single statement here runs (ES imports are hoisted above
 *  everything, so no statement position in App.vue OR main.ts can precede it).
 *  resolveFirstRunPrompt therefore asks whether any flowmic key holds
 *  SOMETHING — see first-run-locale.ts, where that measurement is written down.
 *
 *  A `ref` read once, not a computed: resolveFirstRunPrompt makes the signal
 *  durable on its first call, so asking twice would be asking a question whose
 *  answer it just changed. */
const needsLocaleChoice = ref(resolveFirstRunPrompt(localKv, profileKeys()));

/** owner 2026-07-27: the pages are toggled with v-show and therefore SHARE this
 *  one scroll container, which means the scroll offset bled across them — scroll
 *  Settings down to About, switch to Timeline, and the timeline opened scrolled
 *  into the middle of the list (or clamped to somewhere arbitrary if it was
 *  shorter). Opening a page puts you at its top, which is what every reader
 *  expects. */
const contentEl = ref<HTMLElement | null>(null);
watch(page, () => {
  if (contentEl.value) contentEl.value.scrollTop = 0;
});

// Real inputs for the four-state footer dot (same deriveConnDot as DevicesPage /
// capsule — never a parallel binary connected?g:o).
const cloud = ref<CloudStatus>({ ...EMPTY_CLOUD_STATUS });
const sidecar = ref<SidecarStatus | null>(null);
const connView = computed(() =>
  deriveConnDot({
    connected: conn.connected,
    registered: conn.registered,
    // RV-新B — the channel of the very snapshot the other two fields come from,
    // instead of a global "current channel" that could disagree with it. `conn` is the
    // primary channel's row, so this is "which channel this snapshot is describing"
    // and the answer can never drift from the connected/registered pair it is judging.
    channel: currentChannel.value,
    sidecarPhase: sidecar.value?.phase ?? null,
    cloud: cloud.value,
  }),
);

function goPage(next: unknown): void {
  if (typeof next === 'string' && (PAGES as readonly string[]).includes(next)) {
    page.value = next as Page;
  }
}

function openConnDiag(): void {
  // owner 2026-07-26 ①: the footer status is the DOOR to the diagnostic page —
  // it no longer dumps you on the devices page to hunt for a card.
  page.value = 'diag';
}

function onDomNav(ev: Event): void {
  goPage((ev as CustomEvent<{ page?: string }>).detail?.page);
}

let unlistenSidecar: (() => void) | null = null;
let unlistenCloud: (() => void) | null = null;
let unlistenSettings: (() => void) | null = null;

onMounted(() => {
  void initBridge();
  // UP-3c: the app-scope update store boots with the WINDOW, not with the
  // settings page — the sidenav badge below needs the answer whichever page
  // the user is on (2026-08-02 decision: the PC reminder is the settings line
  // PLUS a non-focus-stealing main-window badge).
  void initUpdateStore();
  // R6 T-5c: the capsule ⚙ opens THIS window on the settings page (REDESIGN §5.2).
  // The main WebView stays alive while hidden to the tray, so this listener is
  // registered once at boot and receives the event whatever the window state.
  // An unknown page value is ignored — never a blank content area.
  void onChannel<{ page?: string }>(UI_NAVIGATE, (p) => goPage(p?.page));
  // Same-window path (T-7 settings Account section → Devices page); see navigateMain.
  window.addEventListener(UI_NAVIGATE_DOM, onDomNav);
  // RV-22: the settings:updated listener, registered FIRST — before the pull edge
  // below can fire — because a frame arriving between a pull and a listen is lost
  // for good (the same "register the listener first, then pull the snapshot" rule
  // as store.ts's snapshot seed). This
  // is the ONE production caller of watchServerSettingsUpdates; without it the
  // Rust-side forward stays the dead façade RV-22 found.
  void watchServerSettingsUpdates().then((un) => {
    unlistenSettings = un;
  });
  // 07 §8 / WP-R3.5: adopt the server-authoritative settings snapshot on the
  // connected rising edge (settings:list → local display cache). immediate covers
  // the case where the socket is already up at mount.
  //
  // RV-16: the edge is the LAN channel's, not the primary one's. `settings_list` is
  // pinned to the LAN socket in Rust (shell/mod.rs `with_lan_socket`), so watching
  // `conn.connected` watched the wrong socket: with preference=cloud a LAN socket
  // coming back pulled nothing at all. Trigger and verb must read the same socket.
  watch(
    lanConnected,
    (isConn, was) => {
      if (isConn && !was) void pullServerSettings();
    },
    { immediate: true },
  );

  void (async () => {
    // RV-24: register BEFORE pulling — the rule main-window/store.ts spells out at
    // its snapshot seed («register first so a frame arriving mid-seed is not lost,
    // then ask for the current state»). A push landing between the fetch and the
    // listen is lost for the rest of the session; both halves are idempotent, so
    // the overlap costs nothing.
    unlistenSidecar = await onChannel<SidecarStatus>(CH.sidecarState, (p) => {
      sidecar.value = p;
    });
    unlistenCloud = await onChannel<unknown>(CH.cloudState, (p) => {
      cloud.value = asCloudStatus(p);
    });
    cloud.value = await fetchCloudStatus();
    sidecar.value = await fetchSidecarState();
  })();
});

onUnmounted(() => {
  window.removeEventListener(UI_NAVIGATE_DOM, onDomNav);
  unlistenSidecar?.();
  unlistenCloud?.();
  unlistenSettings?.();
});
</script>

<template>
  <div class="win-body">
    <FirstRunLocale v-if="needsLocaleChoice" @chosen="needsLocaleChoice = false" />
    <nav class="sidenav">
      <div class="brand"><span class="logo"><BrandMark /></span><b>{{ S.app_name }}</b></div>
      <button class="navitem" :class="{ on: page === 'devices' }" @click="page = 'devices'">
        <Icon name="devices" />{{ S.nav_devices }}
      </button>
      <button class="navitem" :class="{ on: page === 'timeline' }" @click="page = 'timeline'">
        <Icon name="clock" />{{ S.nav_timeline }}
      </button>
      <button class="navitem" :class="{ on: page === 'settings' }" @click="page = 'settings'">
        <Icon name="gear" />{{ S.nav_settings }}
        <!-- UP-3c — the ruled main-window badge (l4 design §5.2): a dot, not a
             word. It points at Settings → About, where the sentence and the
             buttons live; it never steals focus and never moves layout. -->
        <span v-if="updateAvailable" class="nav-update-dot" :title="S.upd_available"></span>
      </button>
      <button class="side-foot" type="button" :title="S.cap_diag" @click="openConnDiag">
        <div class="row">
          <span class="dot" :class="connView.dot"></span>
          {{ connView.label }}
          <Icon name="chev-right" />
        </div>
        <div v-if="connView.detail" class="conn-detail">{{ connView.detail }}</div>
        <div v-if="conn.mobiles > 0" class="muted" style="margin-top:4px">{{ conn.mobiles }} {{ S.dev_mobiles_online }}</div>
      </button>
    </nav>

    <main ref="contentEl" class="content">
      <!-- 0.3.8 — above the pages, not inside one. The permission does not
           belong to Devices or to Settings: while it is missing, NOTHING this
           product does reaches another window, so it is true on whichever page
           the reader happens to open. It renders only on macOS and only while
           the permission is actually absent (see the component). -->
      <AccessibilityNotice />
      <!-- Same slot and the same argument as the strip above it: while the
           selected engine has no model, NOTHING this product hears becomes
           text, so it is true on whichever page the reader happens to open.
           Unlike that one it can be put away for the session — the fact it
           reports does not go away on its own, it goes away when the reader
           decides to spend the bandwidth (§5-B). -->
      <LocalModelNotice />
      <DevicesPage v-show="page === 'devices'" />
      <ConnDiagPage v-if="page === 'diag'" />
      <TimelinePage v-show="page === 'timeline'" />
      <SettingsPage v-show="page === 'settings'" />
    </main>
  </div>
</template>
