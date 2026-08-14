<!--
  UP-3b — the **data-fetching** half of the "update" block (mockup §5.2,
  mounted under Settings → About).

  ── Two files, not an unfinished rename ────────────────────────────────────────
  There is only ONE render chain, and `update-block.test.ts` reads it as
  **data** to pin it down:

      SettingsPage.vue  →  UpdateCard.vue (this file, fetches data)  →  UpdateBlock.vue (says it in words)

  **The settings page mounts this file**; `UpdateBlock` is only ever rendered
  by this file. The reason for the split is written at the top of UpdateBlock,
  in one sentence: SSR rendering does not run `onMounted`, so a component that
  fetches its own data would forever sit at its initial value in a render
  test, and "bolt a test-only entry point onto the product just so it can be
  tested" is doing it backwards.

  This component does exactly three things: ask Rust for `UpdateStateDto`,
  subscribe to pushes, and turn the user's actions into commands. Every
  judgement about "which sentence to say" lives in `lib/update-view.ts` (pure
  functions, guarded by update-view.test.ts); all rendering lives in
  `UpdateBlock.vue` (pure props, asserted by real rendering in update-card.test.ts).

  🔴 The endpoint default comes from `@flowmic/protocol`, not a literal in Rust
     (the written rule in shell/cloud.rs), and it is **deliberately not**
     `CloudConfig.endpoint` — "which relay am I connected to" and "what is the
     latest version" are two different questions, and design §1.1 says the
     latter is a global fact. A self-hosted relay answers 404, and 404 speaks
     for itself.

  🔴 The tray gets no "check for updates" item, and the capsule gets nothing at
     all: two entry points would mean two state sources, and the capsule is
     the overlay shown while transcribing (ambient surfacing never steals
     focus = red line).
-->
<template>
  <UpdateBlock
    :s="s"
    :busy="busy"
    @check="checkNow"
    @download="download"
    @apply="apply"
    @dismiss="dismissPending"
    @open-page="openPage"
    @toggle-auto="toggleAuto"
  />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import UpdateBlock from './UpdateBlock.vue';
import { UPDATE_MANIFEST_BASE, type UpdateStateDto } from '../../lib/update-view';
import { invokeSafe } from '../../lib/bridge';
import { listen } from '@tauri-apps/api/event';

const EMPTY: UpdateStateDto = {
  current_version: '',
  // 🔴 `dev` as the pre-load value, so the block renders NOTHING until Rust has
  // answered. Defaulting to a real form would flash a verdict assembled from
  // placeholders — a sentence with no evidence behind it, which is the exact
  // shape R11 forbids.
  form: 'dev',
  auto_check: true,
  last_success_check: null,
  checking: false,
  plan: null,
  latest: null,
  notes_url: null,
  manual_reason: null,
  failure: null,
  download: { active: false, received: 0, total: 0 },
  verified_filename: null,
  verified_sha256: null,
  verified_size: null,
  can_swap_in_place: null,
  pending: null,
};

const s = ref<UpdateStateDto>(EMPTY);
const busy = ref(false);

async function pull(cmd: string, args?: Record<string, unknown>) {
  busy.value = true;
  try {
    const next = await invokeSafe<UpdateStateDto>(cmd, args);
    if (next) s.value = next;
  } finally {
    busy.value = false;
  }
}

const checkNow = () => pull('update_check', { base: UPDATE_MANIFEST_BASE });
const download = () => pull('update_download');
const apply = () => pull('update_apply');
const dismissPending = () => pull('update_dismiss_pending');
const toggleAuto = (enabled: boolean) => pull('update_set_auto_check', { enabled });
const openPage = () => {
  if (s.value.notes_url) window.open(s.value.notes_url, '_blank', 'noreferrer');
};

onMounted(async () => {
  await pull('update_state');
  // The automatic check is started HERE rather than in Rust, because the endpoint
  // default lives in @flowmic/protocol — see the header. A dev build never checks
  // (design §4.2), and this returns before asking for anything at all.
  if (s.value.auto_check && s.value.form !== 'dev') void checkNow();
  // A pushed payload may be a throttled progress fragment rather than a whole
  // state, so the shape is checked before it is adopted wholesale.
  void listen<UpdateStateDto>('update:state', (e) => {
    const next = e.payload;
    if (next && typeof next === 'object' && 'current_version' in next) s.value = next;
  }).catch(() => {
    /* Not inside Tauri (component tests / browser preview): no event source. */
  });
});
</script>
