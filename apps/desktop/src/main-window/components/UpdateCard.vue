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
    @check="updateCheckNow"
    @download="updateDownload"
    @apply="updateApply"
    @dismiss="updateDismissPending"
    @open-page="openPage"
    @toggle-auto="updateSetAutoCheck"
  />
</template>

<script setup lang="ts">
import UpdateBlock from './UpdateBlock.vue';
import {
  updateApply,
  updateBusy as busy,
  updateCheckNow,
  updateDismissPending,
  updateDownload,
  updateSetAutoCheck,
  updateState as s,
} from '../update-store';

const openPage = () => {
  if (s.value.notes_url) window.open(s.value.notes_url, '_blank', 'noreferrer');
};
</script>
