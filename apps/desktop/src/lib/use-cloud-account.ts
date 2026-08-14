// SPEC-REF:
//   docs/strategy/2026-08-02-l3-account-card-design.md §2.4 (four states) / §3 (pathway)
//
// The ONE piece of fetch orchestration behind the account card. Both surfaces that
// render the account (Settings page → Account, Devices page → cloud-card collapsed
// section) call this — a second copy of "when to ask, what to do when the ask fails"
// would be a second answer to "what state is this account in", and the two pages
// would drift the first time either one was touched.
//
// 🔴 [lastLive] is MODULE-scoped on purpose (survives a page switch) but is NEVER
// persisted to disk. A tier read from disk at cold start would appear on screen
// looking exactly like a live one — that is the bug this whole lane exists to fix,
// and writing it to localKv would reintroduce it one restart later.

import { onMounted, ref, watch, type Ref } from 'vue';
import { fetchCloudAccount } from './bridge';
import {
  deriveAccountCard,
  parseLiveAccount,
  type AccountCard,
  type CloudAccountRaw,
  type LiveAccount,
} from './cloud-account';
import type { CloudStatus } from './channel';

/** Session-only memory of the last answer the server actually gave. */
let lastLive: { account: LiveAccount; at: number } | null = null;

export interface CloudAccountBinding {
  card: Ref<AccountCard>;
  /** Ask the server now (the "refresh" button, and the mount / sign-in edges). */
  refresh: () => Promise<void>;
}

export function useCloudAccount(cloud: Ref<CloudStatus>): CloudAccountBinding {
  const raw = ref<CloudAccountRaw | null>(null);
  const loading = ref(false);
  const tick = ref(0); // bumps when `lastLive` (a plain module variable) changes

  const card = ref<AccountCard>(
    deriveAccountCard({ cloud: cloud.value, raw: null, lastLive: null, loading: false }),
  );

  function recompute(): void {
    card.value = deriveAccountCard({
      cloud: cloud.value,
      raw: raw.value,
      lastLive,
      loading: loading.value,
    });
  }

  async function refresh(): Promise<void> {
    // No key ⇒ nothing to ask with. Not a failure, and asking anyway would put a
    // `no_key` outcome on a card that is already showing the signed-out state.
    if (!cloud.value.key_set) {
      raw.value = null;
      recompute();
      return;
    }
    loading.value = true;
    recompute();
    const next = await fetchCloudAccount();
    raw.value = next;
    if (next.outcome === 'ok') {
      const parsed = parseLiveAccount(next);
      // 🔴 Only a PARSEABLE ok updates the remembered answer. An `ok` whose body we
      // could not read must not overwrite a good previous reading with nothing.
      if (parsed !== null) {
        lastLive = { account: parsed, at: next.fetched_at ?? Math.floor(Date.now() / 1000) };
        tick.value += 1;
      }
    }
    loading.value = false;
    recompute();
  }

  onMounted(() => {
    void refresh();
  });

  // Sign-in / sign-out edge: a freshly pasted Cloud Key must produce a fresh read,
  // and a sign-out must drop the answer rather than leave the previous account's
  // plan on screen under a signed-out card.
  watch(
    () => cloud.value.key_set,
    (set) => {
      if (set) {
        void refresh();
      } else {
        raw.value = null;
        lastLive = null;
        recompute();
      }
    },
  );
  watch(() => cloud.value.expires_at, recompute);
  watch(tick, recompute);

  return { card, refresh };
}
