<script setup lang="ts">
// NR-112 (2026-09-26) — what the signed-out cloud block shows WHILE the PC waits
// for the browser sign-in, lifted out of CloudSignInGuide.vue (which renders it
// under `v-if="signingIn"`, the one waiting row there is; this is not a second).
//
// WHY IT IS ITS OWN COMPONENT: the waiting state only exists after a click, and
// this repo's vitest runs SFCs through their SSR compile in `node`, where no
// click can happen (cloud-signin-guide.test.ts states the split). As a child
// with props, the exact markup that ships in the waiting state is mounted and
// asserted in every language (`signin-waiting.test.ts`) instead of being
// reachable only through a real window.
//
// WHY THE WINDOW IS NAMED ON SCREEN: it went from 180 s to 15 minutes because
// the console now asks a new account to confirm its email before it hands the
// sign-in to this PC (NR-111). Someone who leaves for their mailbox needs to
// know the PC is still waiting for them, and for how long. The number is not
// typed here: it is `window_ms` from the Rust `begin` call
// (`SIGNIN_WINDOW_MS` in src-tauri/src/cloud_signin.rs), so the sentence and the
// listener cannot disagree.
import { S } from '../../lib/strings';

const props = defineProps<{
  /** The listener's window in whole minutes, from `BeginDto.window_ms`. */
  minutes: number;
}>();

const emit = defineEmits<{ (e: 'cancel'): void }>();

/** `{min}` is the one placeholder `cloud_signin_waiting_hint` carries. */
function hint(): string {
  return S.cloud_signin_waiting_hint.replace('{min}', String(props.minutes));
}
</script>

<template>
  <div class="signin-waiting">
    <!-- Waiting has to LOOK like waiting, and it has to have a way out. A
         fifteen-minute window behind an unchanged button is indistinguishable
         from a button that did nothing — which is the complaint that produced
         the one-door rule in the first place. -->
    <div class="signin-wait">
      <span class="wait-t">{{ S.cloud_signin_waiting }}</span>
      <!-- `ghost`, not a bare `.btn sm`: `.btn` is layout only and
           `button{border:none;background:none}` removes what the browser would
           have drawn, so an unskinned button is INVISIBLE. That is 0.3.33's
           scar (「提示了有新版，但是没有升级的按钮」), and the door that caught
           this line's first draft is button-skin-door.test.ts. -->
      <button class="btn ghost sm" type="button" data-action="signin-cancel" @click="emit('cancel')">
        {{ S.cloud_signin_cancel }}
      </button>
    </div>
    <div class="fld-hint" data-line="signin-waiting-hint">{{ hint() }}</div>
  </div>
</template>

<style scoped>
/* `.signin-wait` / `.wait-t` moved VERBATIM from CloudSignInGuide.vue with the
   markup (scoped rules do not reach a child's elements). `.fld-hint` is the
   same copy CloudSignInGuide.vue carries from devices-page.css; if that file
   changes the rule, change it here too. */
.signin-waiting { display: flex; flex-direction: column; gap: 6px; }
.signin-wait { display: flex; align-items: center; gap: 10px; }
.wait-t { font-size: 12px; color: var(--t2); }
.fld-hint { font-size: 11px; color: var(--t3); line-height: 1.5; margin-top: -4px; }
</style>
