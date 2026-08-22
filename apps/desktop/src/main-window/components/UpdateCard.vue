<!--
  UP-3b — the settings-page seat of the update block (mockup §5.2, mounted
  under Settings → About).

  ── Two files, not an unfinished rename ────────────────────────────────────────
  There is only ONE render chain, and `update-block.test.ts` reads it as
  **data** to pin it down:

      SettingsPage.vue  →  UpdateCard.vue (this file)  →  UpdateBlock.vue (says it in words)

  **The settings page mounts this file**; `UpdateBlock` is only ever rendered
  by this file. The reason for the split is written at the top of UpdateBlock,
  in one sentence: SSR rendering does not run `onMounted`, so a component that
  fetches its own data would forever sit at its initial value in a render
  test, and "bolt a test-only entry point onto the product just so it can be
  tested" is doing it backwards.

  🔴 Since UP-3c the STATE does not live here either: `../update-store` owns
  the one UpdateStateDto — it must, because the sidenav badge in App.vue reads
  the same value, and a second `update_state` asker keeping its own copy would
  be two independently-updated answers to one question (the repo's named #1
  bug shape). The automatic check also moved there (boot + 24 h recheck), so
  opening Settings no longer fires one; what this page shows is whatever the
  app-scope owner knows, plus the manual "check now" button. This file is
  reduced to the glue the chain pin describes: hand the store's state to
  UpdateBlock, hand UpdateBlock's actions back to the store.

  🔴 The tray gets no "check for updates" item, and the capsule gets nothing at
     all: two entry points would mean two state sources, and the capsule is
     the overlay shown while transcribing (ambient surfacing never steals
     focus = red line).
-->
<template>
  <UpdateBlock
    :s="s"
    :busy="busy"
    :open-failed="openFailed"
    @check="updateCheckNow"
    @download="updateDownload"
    @apply="updateApply"
    @dismiss="updateDismissPending"
    @open-page="openPage"
    @toggle-auto="updateSetAutoCheck"
  />
</template>

<script setup lang="ts">
import { ref } from 'vue';
import UpdateBlock from './UpdateBlock.vue';
import { openExternalUrl } from '../../lib/bridge-os';
import {
  updateApply,
  updateBusy as busy,
  updateCheckNow,
  updateDismissPending,
  updateDownload,
  updateSetAutoCheck,
  updateState as s,
} from '../update-store';

/** 🔴 0.3.24 — WAS `window.open`, which opened NOTHING. Reported from a
 *  real machine (owner 2026-08-21, Windows 10 on 0.3.5: 「要连接下载页去下载，但又
 *  点不开」), root cause in `src-tauri/src/shell/external_open.rs`: a WebView2
 *  window declared in tauri.conf.json drops every new-window request on the
 *  floor. The click did nothing, threw nothing, and logged nothing.
 *
 *  ⚠️ It is the WHOLE of this card's manual route — when the plan is
 *  `manual_only` there is no download button behind it — so a refusal is
 *  rendered rather than swallowed: the block shows the sentence plus the address
 *  itself, and the user can still get there by hand. */
const openFailed = ref<string | null>(null);
const openPage = async () => {
  const url = s.value.notes_url;
  if (!url) return;
  openFailed.value = null;
  const r = await openExternalUrl(url);
  if (!r.ok) openFailed.value = url;
};
</script>
