<script lang="ts">
// NR-120 — the raw developer text of a failed local service (sidecar), folded.
//
// WHY IT EXISTS: the LAN card used to print `sidecar.detail` straight under the
// failure line (`spawn failed: …`, `create_dir_all(…) failed: …`, an old host
// Node's complaint). That string is the developer's sentence for the forensic
// log, English only and unlocalised; the owner met it on Ubuntu with an old host
// Node (screenshot 2026-09-28). The user-facing line is the status label the
// card already carries (`sidecar_failed` beside `sidecar_title`); this block is
// what stays UNDER it: collapsed by default, so the raw text is not in the tree
// until someone asks for it, and copyable, so support can still ask for it.
//
// WHY A RENDER FUNCTION, NOT A <template>: the desktop's component tests run in
// vitest's `node` environment, where an SFC <template> is compiled to its SSR
// form and cannot be mounted by a client renderer (see
// prefs-appearance.test.ts's header). A render function compiles the same in
// both, so sidecar-failure-detail.test.ts mounts THIS component and clicks the
// real toggle instead of asserting on a hand-built stand-in.
import { defineComponent, h, ref } from 'vue';
import { S } from '../../lib/strings';

export default defineComponent({
  name: 'SidecarFailureDetail',
  props: {
    /** The raw developer text (`SidecarStatus.detail`). Never shown while folded. */
    detail: { type: String, required: true },
  },
  setup(props) {
    const open = ref(false);
    const copied = ref(false);
    const copyFailed = ref(false);

    async function copy(): Promise<void> {
      copyFailed.value = false;
      try {
        await navigator.clipboard.writeText(props.detail);
        copied.value = true;
        setTimeout(() => { copied.value = false; }, 1200);
      } catch {
        // Say so: a copy that silently did nothing would look like it worked.
        copyFailed.value = true;
      }
    }

    return () => h('div', { class: 'sc-fold' }, [
      h('button', {
        class: 'fold-toggle',
        type: 'button',
        'aria-expanded': open.value ? 'true' : 'false',
        onClick: () => { open.value = !open.value; },
      }, [
        h('span', S.model_detail),
        h('span', { class: ['diag-chev', { open: open.value }] }, '▾'),
      ]),
      open.value
        ? h('div', { class: 'sc-fold-body' }, [
            h('div', { class: 'sc-detail mono' }, props.detail),
            h('button', { class: 'btn ghost sm', type: 'button', onClick: copy },
              copied.value ? S.model_copied : S.op_copy),
            copyFailed.value ? h('p', { class: 'sc-copy-failed' }, S.op_copy_failed) : null,
          ])
        : null,
    ]);
  },
});
</script>

<style scoped>
.sc-fold { margin-top: 6px; }
.fold-toggle { display: flex; align-items: center; gap: 6px; background: none; border: 0;
  padding: 0; cursor: pointer; color: var(--t3); font-size: 11.5px; }
.diag-chev { color: var(--t3); font-size: 11px; transition: transform .15s ease; }
.diag-chev.open { transform: rotate(180deg); }
.sc-detail { margin: 8px 0; font-size: 11.5px; color: var(--red); word-break: break-all; user-select: text; }
.sc-copy-failed { margin: 6px 0 0; font-size: 11px; color: var(--t3); }
</style>
