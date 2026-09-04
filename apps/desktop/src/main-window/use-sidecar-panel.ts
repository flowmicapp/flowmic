// The devices page's "sidecar (self-hosted server) status" family — 07 §5,
// WP-R2-4. Moved out whole at the 800-line cap (2026-09-02, same reason and
// same VERBATIM-move discipline as settings-model.ts's stt-routing-order.ts
// split): the ref, the three derived facts, and the one
// action (retry) that touches it all belong together and have no other
// caller, so a composable is the honest boundary rather than a second file
// that only half-owns the state.
//
// `sidecar` stays a plain ref the page can also assign directly (the
// seedThenSubscribe push at DevicesPage.vue's mount hook does exactly that) —
// this is not trying to hide the field behind an action, only to stop
// repeating the three derived computeds and the retry handler.
import { computed, ref, type Ref } from 'vue';
import { S, SIDECAR_LABEL } from '../lib/strings';
import { retrySidecar, type SidecarStatus } from '../lib/bridge';

export interface SidecarPanel {
  sidecar: Ref<SidecarStatus | null>;
  retrying: Ref<boolean>;
  sidecarLabel: Readonly<Ref<string>>;
  sidecarFailed: Readonly<Ref<boolean>>;
  sidecarHealthy: Readonly<Ref<boolean>>;
  doRetrySidecar: () => Promise<void>;
}

export function useSidecarPanel(): SidecarPanel {
  const sidecar = ref<SidecarStatus | null>(null);
  const retrying = ref(false);
  const sidecarLabel = computed(() =>
    sidecar.value ? SIDECAR_LABEL[sidecar.value.phase] ?? S.sidecar_starting : S.sidecar_starting,
  );
  const sidecarFailed = computed(() => sidecar.value?.phase === 'failed');
  const sidecarHealthy = computed(
    () => sidecar.value?.phase === 'healthy' || sidecar.value?.phase === 'adopted_external',
  );

  async function doRetrySidecar(): Promise<void> {
    if (retrying.value) return;
    retrying.value = true;
    try {
      sidecar.value = (await retrySidecar()) ?? sidecar.value;
    } finally {
      retrying.value = false;
    }
  }

  return { sidecar, retrying, sidecarLabel, sidecarFailed, sidecarHealthy, doRetrySidecar };
}
