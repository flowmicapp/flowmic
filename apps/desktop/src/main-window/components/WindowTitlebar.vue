<script setup lang="ts">
// Custom titlebar (owner 2026-08-21): the native Windows frame is hidden
// (tauri.conf.json main window `decorations: false`), so this bar is the
// window's only chrome — drag surface, brand, and the min/max/close controls.
// The brand moved here FROM the sidenav tile (removed the same day): one
// window, one place that says FlowMic.
//
// Close is NOT quit: `win.close()` raises CloseRequested, and the Rust handler
// (lib.rs on_window_event) prevents it and hides to the tray — the tray stays
// the only quit path (07 §7). This button must go through close(), never
// hide(), so both close paths share that single policy point.
import { onMounted, onUnmounted, ref } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { S } from '../../lib/strings';

// Lazily tolerant of a non-Tauri host (vitest/jsdom): the API object throws
// without __TAURI_INTERNALS__, and a titlebar that cannot reach the window
// should render inert buttons, not take the whole component tree down.
let win: ReturnType<typeof getCurrentWindow> | null = null;
try {
  win = getCurrentWindow();
} catch {
  win = null;
}

const isMax = ref(false);
let unlisten: (() => void) | null = null;

async function syncMax(): Promise<void> {
  if (!win) return;
  try {
    isMax.value = await win.isMaximized();
  } catch {
    /* window gone mid-query (hide/close race) — keep the last known state */
  }
}

onMounted(() => {
  void syncMax();
  // onResized also fires for maximize/unmaximize, whichever input caused it
  // (button, drag-region double-click, Win+Up, snap layouts).
  void win
    ?.onResized(() => void syncMax())
    .then((un) => {
      unlisten = un;
    })
    .catch(() => {});
});
onUnmounted(() => {
  unlisten?.();
});

function minimize(): void {
  void win?.minimize();
}
function toggleMax(): void {
  void win?.toggleMaximize();
}
function closeWin(): void {
  void win?.close();
}
</script>

<template>
  <header class="titlebar">
    <div class="tb-side" data-tauri-drag-region>
      <!-- The brand glyph, brand 2.0 (owner 2026-08-21): PLATELESS colored
           mark — at 20px the ink plate ate nearly half the box, so the bar's
           own dark ground is the plate now, and the mark fills the grid.
           Shoulder-wave composition on the 24 grid: phone + cradle + post +
           two Stream-teal shoulder ticks. Update together with the
           logo-tools/render-icons.mjs NANO frames (same design family).
           pointer-events:none via CSS so every pixel of the bar outside the
           buttons drags the window. -->
      <svg class="tb-mark" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="7.5" y="2.5" width="9" height="13" rx="2.6" fill="var(--brandmark-phone)" />
        <path
          d="M 4.5 12 A 7.5 7.5 0 0 0 19.5 12"
          fill="none"
          stroke="var(--brandmark-stroke)"
          stroke-width="2.4"
          stroke-linecap="round"
        />
        <rect x="11" y="19.9" width="2" height="2.6" fill="var(--brandmark-stroke)" />
        <path d="M 2.7 4.2 A 3.2 3.2 0 0 1 5.2 1.7" fill="none" stroke="var(--brandmark-wave)" stroke-width="2" stroke-linecap="round" />
        <path d="M 21.3 4.2 A 3.2 3.2 0 0 0 18.8 1.7" fill="none" stroke="var(--brandmark-wave)" stroke-width="2" stroke-linecap="round" />
      </svg>
      <b class="tb-name"><span class="tb-flow">Flow</span><span class="tb-mic">Mic</span></b>
    </div>
    <div class="tb-main" data-tauri-drag-region>
      <div class="tb-controls">
        <button
          class="tb-btn"
          type="button"
          :aria-label="S.win_minimize"
          :title="S.win_minimize"
          @click="minimize"
        >
          <svg viewBox="0 0 10 10"><path d="M 0 5 H 10" /></svg>
        </button>
        <button
          class="tb-btn"
          type="button"
          :aria-label="isMax ? S.win_restore : S.win_maximize"
          :title="isMax ? S.win_restore : S.win_maximize"
          @click="toggleMax"
        >
          <svg v-if="!isMax" viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" rx="1.6" />
          </svg>
          <svg v-else viewBox="0 0 10 10">
            <rect x="0.5" y="2.5" width="7" height="7" rx="1.3" />
            <path d="M 2.8 2.5 V 2.1 A 1.6 1.6 0 0 1 4.4 0.5 H 7.9 A 1.6 1.6 0 0 1 9.5 2.1 V 5.6 A 1.6 1.6 0 0 1 7.9 7.2 H 7.5" />
          </svg>
        </button>
        <button
          class="tb-btn tb-close"
          type="button"
          :aria-label="S.win_close"
          :title="S.win_close"
          @click="closeWin"
        >
          <svg viewBox="0 0 10 10"><path d="M 1 1 L 9 9 M 9 1 L 1 9" /></svg>
        </button>
      </div>
    </div>
  </header>
</template>
