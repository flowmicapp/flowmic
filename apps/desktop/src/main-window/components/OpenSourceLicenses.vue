<script lang="ts">
import { defineComponent, h, ref } from 'vue';
import { S } from '../../lib/strings';
// Compile the same source that build-sidecar stages as dist/NOTICE into the
// webview: opening the view needs no fetch, filesystem permission, or browser.
import notice from '../../../../../NOTICE?raw';

export default defineComponent({
  name: 'OpenSourceLicenses',
  setup() {
    const open = ref(false);
    return () => h('div', { class: 'licenses' }, [
      h('button', {
        id: 'licenses-toggle',
        type: 'button',
        class: 'btn ghost sm',
        'aria-expanded': String(open.value),
        'aria-controls': 'licenses-notice',
        onClick: () => { open.value = !open.value; },
      }, S.openSourceLicenses),
      open.value ? h('pre', {
        id: 'licenses-notice',
        class: 'licenses-notice mono',
        role: 'region',
        'aria-labelledby': 'licenses-toggle',
        tabindex: 0,
      }, notice) : null,
    ]);
  },
});
</script>

<style scoped>
.licenses { margin-top: 14px; min-width: 0; }
.licenses-notice {
  max-height: 50vh;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: monospace;
  font-size: 12px;
  line-height: 1.5;
  user-select: text;
}
</style>
