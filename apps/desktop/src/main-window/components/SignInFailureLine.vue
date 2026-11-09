<script lang="ts">
// FR-D2 (D-MKT-7, 2026-11-06) — the red line under a failed browser sign-in.
//
// It holds the failure's CODE and turns it into a sentence at render. The guide
// used to keep the finished sentence in a ref, so a sign-in that timed out while
// the interface was in Chinese kept saying 登录已超时 after the reader switched to
// English, until the next restart. A sentence is a rendering; only the code is a
// fact about what happened.
//
// A render function, not a <template>, so sign-in-failure-line.test.ts can mount
// it with a client renderer and switch the language under it (the same reason as
// SidecarFailureDetail.vue).
import { defineComponent, h, type PropType } from 'vue';
import { signInFailureText } from '../../lib/cloud-signin';

export default defineComponent({
  name: 'SignInFailureLine',
  props: {
    /** `null` = nothing failed. `reason` is the Rust side's code, which may itself
     *  be null or unknown; signInFailureText has a sentence for those too. */
    failure: { type: Object as PropType<{ reason: string | null } | null>, default: null },
  },
  setup(props) {
    return () => (props.failure === null
      ? null
      : h('div', { class: 'chan-loud' }, signInFailureText(props.failure.reason)));
  },
});
</script>
