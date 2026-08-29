<script setup lang="ts">
// SPEC-REF:
//   docs/decisions/2026-08-27-owner-no-password-login-on-clients.md (owner
//     ruling, card NR-2b, PC half: keep and polish the Cloud Key paste —
//     「粘贴即校验、错误具名提示」 (validate on paste, name the error) — and ADD a
//     button that guides the user to sign in in the browser, with the whole
//     route stated on the same screen. Explicitly NOT an in-app email form.)
//
// 🔴 THE RULING WAS CORRECTED THE SAME DAY AND THIS BLOCK WITH IT. The sentence
// above used to end 「…and explicitly NOT a loopback callback that pastes the key
// by itself」. The owner overturned that at UAT, looking at the shipped screen:
// 「浏览器里 Gmail 都登录成功了，为什么还要我去复制 Key」. It is corrected in
// place rather than deleted, because a prohibition that was true for a few hours
// and then false is exactly the 「过期的真话」 this repo keeps paying for — and
// the next person to read this file would have taken it as live.
//
// ⇒ WHAT THE BUTTON DOES NOW: bind a one-shot listener on 127.0.0.1, open the
// console with the port and a random `state`, and let the console redirect the
// browser back with a one-time grant we spend for a real key. Nobody copies
// anything. The paste form BELOW is untouched and stays as the fallback for a
// machine where that cannot work — the ruling's own instruction.
//
// The signed-out block of the cloud card: how you GET a Cloud Key, and where you
// put it. Both halves live here because they are one journey, and because
// DevicesPage.vue was at the 800-line cap — the move is a VERBATIM lift of the
// paste form plus the new guide, not a rewrite.
//
// 🔴 THE BUTTON GOES THROUGH THE ONE DOOR, AND THERE IS NO OTHER. In this
// WebView a blank-target anchor and a scripted new window open NOTHING — no
// error, no log line, just a control that looks like it works (measured off
// wry/tauri's sources; `src-tauri/src/shell/external_open.rs` carries the
// chain). Every external link in this app was dead that way until 0.3.24.
// `openExternalUrl` is the door and `verify:lint external-link-door` is what
// stops a second one being cut — see the reverse control in this card's commit
// message, where a scripted new window written here turned that lint red.
//
// ⚠️ The two forbidden forms are named in words above rather than spelled out,
// and that is not squeamishness: the gate scans raw text, comments included, so
// a file that merely DESCRIBES them fails it. Its allowlist is reserved for
// files that must write them to assert their absence, and this is not one.
//
// 🔴 A FAILED OPEN MUST STILL LEAVE A ROUTE. `ok:true` from the door means the
// OS ACCEPTED the URL and no more than that; `ok:false` means it did not. In
// that case the copy names the address in words, because a user whose machine
// cannot open a browser can still reach the console from a phone, and a dead
// end here is a dead end for the whole cloud channel.
import { onBeforeUnmount, ref, watch } from 'vue';
import { S } from '../../lib/strings';
import { openExternalUrl } from '../../lib/bridge-os';
import { saveCloudKey } from '../../lib/bridge';
import {
  beginBrowserSignIn,
  cancelBrowserSignIn,
  pollBrowserSignIn,
} from '../../lib/bridge-signin';
import {
  DEFAULT_CLOUD_ENDPOINT,
  isJwtShaped,
  asCloudStatus,
  type CloudStatus,
} from '../../lib/channel';
import {
  buildDesktopSignInUrl,
  openConsoleSignIn,
  pasteLooksMalformed,
  signInFailureText,
  signInPageCopy,
  valueAfterPaste,
} from '../../lib/cloud-signin';

const props = defineProps<{
  /** The endpoint the page believes is saved. Mirrors into the box below unless
   *  the user is mid-edit — never blank a field someone is typing into. */
  endpoint: string;
}>();

const emit = defineEmits<{ (e: 'saved', next: CloudStatus): void }>();

const keyInput = ref('');
const endpointInput = ref(props.endpoint || DEFAULT_CLOUD_ENDPOINT);
const savingKey = ref(false);
// Local paste-shape complaint (the Rust side re-checks and latches its own).
const keyShapeError = ref(false);
const opening = ref(false);
const openFailed = ref(false);

watch(
  () => props.endpoint,
  (next: string) => {
    if (document.activeElement?.getAttribute('data-field') === 'cloud-endpoint') return;
    endpointInput.value = next || DEFAULT_CLOUD_ENDPOINT;
  },
);

/** `waiting` covers both the listener and the exchange: from here they are one
 *  fact — 「we are not done and there is nothing for you to do」. Splitting them
 *  on screen would be reporting our own internals as if they were the user's
 *  business. */
const signingIn = ref(false);
/** The named failure sentence, or ''. Cleared the instant a new attempt starts:
 *  a red line left standing over a fresh attempt is the 「过期的真话」 shape this
 *  file's paste handler already guards against. */
const signInError = ref('');
let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * The whole browser sign-in, from this side.
 *
 * ORDER, and every step of it is load-bearing:
 *   1. Rust binds loopback and mints the state. If that fails we say so and
 *      NEVER open a browser — sending someone to sign in when the answer has
 *      nowhere to land is a dead end they can only discover by waiting.
 *   2. The URL is opened through the ONE door. If the OS opens nothing we stop
 *      the listener rather than leaving it holding a port for three minutes.
 *   3. Poll until the phase settles.
 */
async function openSignIn(): Promise<void> {
  if (opening.value || signingIn.value) return;
  openFailed.value = false;
  signInError.value = '';
  opening.value = true;
  try {
    const endpoint = (endpointInput.value.trim() || DEFAULT_CLOUD_ENDPOINT).trim();
    const begun = await beginBrowserSignIn(endpoint, signInPageCopy());
    if (!begun.ok) {
      signInError.value = signInFailureText(begun.reason);
      return;
    }
    const url = buildDesktopSignInUrl(begun.data.port, begun.data.state);
    if (!(await openConsoleSignIn(openExternalUrl, url))) {
      // The listener is holding a port for a browser that never opened. Hand it
      // back now instead of at the deadline.
      await cancelBrowserSignIn();
      openFailed.value = true;
      return;
    }
    signingIn.value = true;
    startPolling();
  } finally {
    opening.value = false;
  }
}

/** 600 ms: fast enough that the card flips over while the person is still
 *  looking at it, slow enough that a three-minute window is 300 cheap IPC calls
 *  and not thousands. */
function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => {
    void tick();
  }, 600);
}

async function tick(): Promise<void> {
  const p = await pollBrowserSignIn();
  if (p.phase === 'waiting' || p.phase === 'exchanging') return;
  stopPolling();
  signingIn.value = false;
  if (p.phase === 'done') {
    // The SAME handler a paste goes through — `applyCloud` on the devices page.
    // One way in, one shape out; the `key_set` flip is what makes the account
    // card fetch /api/me, and a second path here would be a second answer to
    // 「are we signed in」.
    emit('saved', asCloudStatus(p.cloud));
    return;
  }
  if (p.phase === 'failed') {
    signInError.value = signInFailureText(p.reason);
  }
  // `idle` = cancelled. Nothing to say: the person asked for it.
}

async function cancelSignIn(): Promise<void> {
  stopPolling();
  signingIn.value = false;
  await cancelBrowserSignIn();
}

/** A listener that outlives the screen that started it would hold a port with
 *  nobody left to read its result. Leaving the page IS a cancellation. */
onBeforeUnmount(() => {
  stopPolling();
  if (signingIn.value) void cancelBrowserSignIn();
});

/** Card NR-2b — 「粘贴即校验」 ("validate on paste"). The shape check already
 *  existed; what did not is it happening at the moment the user pastes.
 *
 *  🔴 THE DEFECT THIS CLOSES IS A DELAY, NOT A MISSING CHECK. Pasting a
 *  password, a console URL or half a token used to look perfectly fine until
 *  Save, at which point the complaint arrived about something the user had
 *  stopped thinking about. Nothing about the SAVE path changes: it still
 *  re-checks and still refuses, because the field can be edited by hand after a
 *  paste and a check that only ran once would be the weaker of the two.
 */
function onKeyPaste(ev: ClipboardEvent): void {
  const el = ev.target as HTMLInputElement | null;
  const pasted = ev.clipboardData?.getData('text') ?? '';
  keyShapeError.value = pasteLooksMalformed(
    valueAfterPaste(
      el?.value ?? keyInput.value,
      pasted,
      el?.selectionStart ?? null,
      el?.selectionEnd ?? null,
    ),
  );
}

/** Typing after a complaint retires it — the user is answering it. Leaving the
 *  red line up while the field changes underneath is the 「过期的真话」 shape:
 *  a sentence that was true when written and is never re-examined. */
watch(keyInput, () => {
  if (keyShapeError.value) keyShapeError.value = false;
});

async function doSaveKey(): Promise<void> {
  if (savingKey.value) return;
  const key = keyInput.value.trim();
  const endpoint = (endpointInput.value.trim() || DEFAULT_CLOUD_ENDPOINT).trim();
  keyShapeError.value = !isJwtShaped(key);
  if (keyShapeError.value) return; // fail-loud locally; nothing is sent or stored
  savingKey.value = true;
  try {
    emit('saved', await saveCloudKey(key, endpoint));
    // The key is now DPAPI-wrapped on the Rust side; drop the plaintext copy the
    // input is holding so it does not sit in the DOM for the rest of the session.
    keyInput.value = '';
  } finally {
    savingKey.value = false;
  }
}
</script>

<template>
  <div class="keyform">
    <!-- The route to GETTING a key, above the field that wants one. Before this
         card a signed-out PC asked for a token and said nothing about where one
         comes from. -->
    <div class="signin-guide">
      <button
        v-if="!signingIn"
        class="btn pri sm"
        type="button"
        :disabled="opening"
        @click="openSignIn"
      >
        {{ S.cloud_signin_browser }}
      </button>
      <!-- Waiting has to LOOK like waiting, and it has to have a way out. A
           three-minute window behind an unchanged button is indistinguishable
           from a button that did nothing — which is the complaint that produced
           the one-door rule in the first place. -->
      <div v-else class="signin-wait">
        <span class="wait-t">{{ S.cloud_signin_waiting }}</span>
        <!-- `ghost`, not a bare `.btn sm`: `.btn` is layout only and
             `button{border:none;background:none}` removes what the browser would
             have drawn, so an unskinned button is INVISIBLE. That is 0.3.33's
             scar (「提示了有新版，但是没有升级的按钮」), and the door that caught
             this line's first draft is button-skin-door.test.ts. -->
        <button class="btn ghost sm" type="button" @click="cancelSignIn">{{ S.cloud_signin_cancel }}</button>
      </div>
      <div class="fld-hint">{{ S.cloud_signin_browser_hint }}</div>
      <div v-if="openFailed" class="chan-loud">{{ S.cloud_signin_browser_failed }}</div>
      <!-- Named, never a bare identifier: `signInFailureText` maps through an
           exhaustive record and falls back to a real sentence. -->
      <div v-if="signInError" class="chan-loud">{{ signInError }}</div>
    </div>
    <label class="fld">
      <span class="fld-l">{{ S.cloud_endpoint_label }}</span>
      <input v-model="endpointInput" class="input" data-field="cloud-endpoint" spellcheck="false"
        :placeholder="DEFAULT_CLOUD_ENDPOINT" />
    </label>
    <div class="fld-hint">{{ S.cloud_endpoint_hint }}</div>
    <label class="fld">
      <span class="fld-l">{{ S.cloud_key_label }}</span>
      <input v-model="keyInput" class="input" type="password" spellcheck="false" autocomplete="off"
        :placeholder="S.cloud_key_ph" @keyup.enter="doSaveKey" @paste="onKeyPaste" />
    </label>
    <div v-if="keyShapeError" class="chan-loud">{{ S.cloud_err_malformed }}</div>
    <button class="btn pri sm" :disabled="savingKey || keyInput.trim() === ''" @click="doSaveKey">
      {{ savingKey ? S.saving : S.cloud_key_save }}
    </button>
  </div>
</template>

<style scoped>
/* ⚠️ COPIED VERBATIM FROM devices-page.css, not re-styled. That file is
   `<style scoped>` on DevicesPage.vue, so its rules carry that component's
   data attribute and do NOT reach markup that has moved into a child — the
   form would render unstyled and nothing would say so. The same copy exists in
   PairedList.vue and SelfPcCard.vue for the same reason and by the same
   precedent; `.btn` / `.input` are global (styles/tokens.css) and are not
   copied. If devices-page.css changes these rules, change them here too. */
.keyform { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
.keyform .btn { align-self: flex-start; }
.fld { display: flex; flex-direction: column; gap: 4px; }
.fld-l { font-size: 11.5px; color: var(--t2); font-weight: 600; }
.fld-hint { font-size: 11px; color: var(--t3); line-height: 1.5; margin-top: -4px; }
.chan-loud { margin-top: 8px; font-size: 12px; color: var(--red); background: var(--red-soft); border-radius: 8px; padding: 8px 10px; line-height: 1.5; }

.signin-guide { display: flex; flex-direction: column; gap: 6px; margin-bottom: 4px; }
.signin-wait { display: flex; align-items: center; gap: 10px; }
.wait-t { font-size: 12px; color: var(--t2); }
</style>
