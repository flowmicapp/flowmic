<script lang="ts">
// FR-D1 — the pairing dialog's answer to "where does the phone app come from".
//
// WHY A RENDER FUNCTION, NOT A <template>: the acceptance of a link is what
// clicking it does (CLAUDE.md D-40), and the desktop's component tests run in
// vitest's `node` environment, where an SFC <template> compiles to its SSR form
// and cannot be clicked (prefs-appearance.test.ts's header).
// pairing-get-app-link.test.ts mounts THIS component and clicks the real link.
//
// The door is `openExternalUrl` and nothing else: `target=_blank` opens nothing
// in this WebView (verify/lint/external-link-door.mjs). The `href` is there for
// what a reader sees on hover and for assistive technology.
import { computed, defineComponent, h, ref } from 'vue';
import { openExternalUrl } from '../../lib/bridge-os';
import { downloadUrl } from '../../lib/site-guide';
import { S } from '../../lib/strings';

export default defineComponent({
  name: 'GetAppLink',
  setup() {
    const url = computed(() => downloadUrl());
    const failed = ref(false);

    async function open(e: Event): Promise<void> {
      e.preventDefault();
      failed.value = false;
      const r = await openExternalUrl(url.value);
      if (!r.ok) failed.value = true;
    }

    return () => h('span', [
      h('a', { href: url.value, rel: 'noopener', onClick: open }, S.pair_get_app),
      failed.value
        ? h('div', { class: 'pair-open-failed', role: 'alert' }, [
            `${S.ext_open_failed} `,
            h('span', { class: 'mono' }, url.value),
          ])
        : null,
    ]);
  },
});
</script>

<style scoped>
.pair-open-failed { margin-top: 6px; font-size: 12px; line-height: 1.6; color: var(--amber-ink); }
.pair-open-failed .mono { word-break: break-all; }
</style>
