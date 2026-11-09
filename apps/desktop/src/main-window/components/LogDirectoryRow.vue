<script lang="ts">
// The "where are my logs" row of Settings > About, moved out of SettingsPage.vue
// (FR-D2, 2026-11-06) and written as a render function so log-directory-row.test.ts
// can mount it and press the real button (see SidecarFailureDetail.vue for why a
// <template> cannot be pressed in this repo's test environment).
//
// The address is asked of the running app. It used to be a catalogue string
// spelling %LOCALAPPDATA%\FlowMic\, which told Linux and macOS readers about a
// folder that does not exist on their machine. If the app cannot answer, no
// address is shown rather than a guessed one.
//
// The reason a failed open gives is a developer's sentence and goes to the forensic
// log (bridge-os.ts `openLogDirectory`); the reader gets the failure line and the
// address to open by hand.
import { defineComponent, h, onMounted, ref } from 'vue';
import { fetchLogDirectory, openLogDirectory } from '../../lib/bridge-os';
import { S } from '../../lib/strings';

export default defineComponent({
  name: 'LogDirectoryRow',
  setup() {
    const dir = ref<string | null>(null);
    const pending = ref(false);
    const failed = ref(false);

    onMounted(() => {
      void fetchLogDirectory().then((d) => { dir.value = d; });
    });

    async function open(): Promise<void> {
      if (pending.value) return;
      pending.value = true;
      failed.value = false;
      try {
        failed.value = !(await openLogDirectory()).ok;
      } finally {
        pending.value = false;
      }
    }

    return () => h('div', [
      h('div', { class: 'log-open-row' }, [
        dir.value === null ? null : h('span', { class: 'mono log-open-dir' }, dir.value),
        h('button', { class: 'btn ghost sm', type: 'button', disabled: pending.value, onClick: open },
          pending.value ? S.set_about_log_opening : S.set_about_log_open),
      ]),
      failed.value
        ? h('div', { class: 'log-open-failed', role: 'alert' }, [
            `${S.set_about_log_open_failed} `,
            dir.value === null ? null : h('span', { class: 'mono log-open-dir' }, dir.value),
          ])
        : null,
    ]);
  },
});
</script>

<style scoped>
.log-open-row { display: flex; align-items: center; gap: 12px; margin-top: 8px; flex-wrap: wrap; font-size: 12.5px; }
.log-open-row .btn:disabled { opacity: .5; cursor: default; }
.log-open-dir { word-break: break-all; }
.log-open-failed { margin-top: 8px; color: var(--red); font-size: 12px; line-height: 1.5; }
</style>
