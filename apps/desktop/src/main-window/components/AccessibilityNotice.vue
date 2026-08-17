<!-- 0.3.8 — the macOS Accessibility permission, said ON THE MAC.

     ── WHAT WAS ACTUALLY MISSING (measured, not assumed) ──────────────────
     The refusal has always been correct and it has always been visible: on
     owner's Mac, 2026-08-17, eight utterances in a row produced
       `macOS synthetic-input preflight REFUSED: ax_trusted=false … err=INJECT_NO_ACCESSIBILITY`
     and each one drew the capsule's 📥 face with the reason line — 「还没给
     FlowMic「辅助功能」权限 · 系统设置 ▸ 隐私与安全性 ▸ 辅助功能」. So the
     product was NOT silent, and any claim that it was is false.

     What it was missing is that the line
       ① only appears AFTER a sentence has already failed to land,
       ② flashes and retreats to the tray with the capsule, and
       ③ is a path spelled in words with nothing to press.
     Between 08:34 and 08:41 the same line was drawn eight times; System
     Settings was opened at 08:42. This notice is the standing, pressable
     version of what the capsule was already saying — it appears BEFORE the
     first failure and stays until the permission is there.

     ── STATE-STYLE, THEREFORE POLLED ─────────────────────────────────────
     owner 2026-08-01: 「提示生命周期匹配事实生命周期」. There is no dismiss
     button on purpose — it leaves when the fact leaves. That only works if
     we keep asking, because the user grants the permission in System
     Settings WHILE this app is running. Two triggers: a slow interval, and
     the moment this window is looked at again (which is the edge that
     matters — they are coming back from the very pane the button opened).

     Who is entitled to render at all lives in lib/accessibility-notice.ts,
     including the rule that 「we could not ask」 renders NOTHING. -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { fetchAccessibilityStatus, openAccessibilitySettings } from '../../lib/bridge-os';
import { needsAccessibilityGrant, type AccessibilityStatus } from '../../lib/accessibility-notice';
import { S } from '../../lib/strings';

/** Every re-check writes here; the template derives from it and nothing else. */
const status = ref<AccessibilityStatus | null>(null);
/** Set only when the OS refused to open the pane. Cleared on the next attempt —
 *  it describes the last press, not a standing condition. */
const openFailed = ref(false);

/** How often to re-ask while the notice is up. Deliberately unhurried: the
 *  focus edge below is what makes it feel immediate, and this is only the
 *  backstop for the case where the user grants it without ever coming back to
 *  this window (a second display, or the pane opened from Spotlight). */
const RECHECK_MS = 4000;

let timer: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

async function recheck(): Promise<void> {
  status.value = await fetchAccessibilityStatus();
  // 🔴 `supported` cannot change inside a process — Windows does not grow an
  // Accessibility permission at runtime. Once we know it is false, stop asking
  // forever rather than paying an IPC every four seconds on every non-Mac
  // install for a banner that can never appear.
  if (status.value?.supported === false) stopPolling();
}

/** The window came back into view — most likely FROM the settings pane. */
function onVisible(): void {
  if (document.visibilityState === 'visible') void recheck();
}

async function onOpen(): Promise<void> {
  openFailed.value = false;
  const r = await openAccessibilitySettings();
  openFailed.value = !r.ok;
  // Not a re-check here on purpose: the pane has only just opened and the
  // answer is still false. The focus edge will ask when it is worth asking.
}

onMounted(() => {
  void recheck();
  timer = setInterval(() => void recheck(), RECHECK_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('focus', onVisible);
});
</script>

<template>
  <!-- role=status, not alert: this is a standing condition the reader can act
       on at their leisure, not an interruption. An assertive live region would
       re-announce itself on every poll. -->
  <section v-if="needsAccessibilityGrant(status)" class="ax-note" role="status">
    <div class="ax-head">{{ S.perm_ax_title }}</div>
    <p class="ax-body">{{ S.perm_ax_body }}</p>
    <div class="ax-how">
      <span class="ax-how-lbl">{{ S.perm_ax_how }}</span>
      <!-- The path stays on screen even when the button works. A button that
           opens the wrong thing (or nothing, on a future macOS that renames the
           pane) would otherwise leave the reader with no second route. -->
      <code class="ax-pane">{{ S.perm_ax_pane }}</code>
    </div>
    <div class="ax-actions">
      <button class="btn pri" type="button" @click="onOpen">{{ S.perm_ax_open }}</button>
      <span class="ax-self">{{ S.perm_ax_selfclears }}</span>
    </div>
    <p v-if="openFailed" class="ax-failed">{{ S.perm_ax_open_failed }}</p>
  </section>
</template>

<style scoped>
/* Amber, not red: nothing broke and nothing was lost — the delivery succeeded
   and only the injection had nowhere to land. That is what `cached` means
   everywhere else in this product (15 册 §2.5e-4), and the colour is part of
   the sentence. */
.ax-note {
  background: var(--amber-soft);
  border: 1px solid var(--amber-line);
  border-radius: var(--r12);
  padding: 12px 14px;
  margin-bottom: 16px;
}
.ax-head { font-size: 13px; font-weight: 700; color: var(--amber-ink); }
.ax-body { margin-top: 6px; font-size: 12px; line-height: 1.6; color: var(--t2); }
.ax-how { margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ax-how-lbl { font-size: 12px; color: var(--t2); }
.ax-pane {
  font-size: 12px;
  color: var(--amber-ink);
  background: var(--surface);
  border: 1px solid var(--amber-line);
  border-radius: 8px;
  padding: 2px 8px;
  /* The reader is matching these words against their own screen, so they must
     stay selectable and must not be re-wrapped into prose. */
  user-select: text;
}
.ax-actions { margin-top: 10px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ax-self { font-size: 12px; color: var(--t3); }
.ax-failed { margin-top: 8px; font-size: 12px; color: var(--amber-ink); }
</style>
