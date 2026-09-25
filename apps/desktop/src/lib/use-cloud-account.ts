// SPEC-REF:
//   docs/archive/strategy/2026-08-02-l3-account-card-design.md §2.4 (four states) / §3 (pathway)
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

import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import { CH, fetchCloudAccount, onChannel } from './bridge';
import {
  deriveAccountCard,
  parseLiveAccount,
  type AccountCard,
  type CloudAccountRaw,
  type LiveAccount,
} from './cloud-account';
import type { CloudStatus } from './channel';
import {
  farEndIsPaying,
  foldBudgetFrame,
  guestIsSpending,
  PAYER_FRESH_MS,
  type PayerLatch,
} from './billing-payer';

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
  /** Card MP-3 — the last thing the relay said about who pays. Component-scoped,
   *  unlike `lastLive`: it describes a recording happening now, and a fact that
   *  short-lived has no business outliving the page that is showing it. */
  const payer = ref<PayerLatch | null>(null);

  const card = ref<AccountCard>(
    deriveAccountCard({ cloud: cloud.value, raw: null, lastLive: null, loading: false }),
  );

  /** What the last [recompute] was told about the room — the only state the
   *  MP-3 / MP-8 sweep needs to decide whether anything on screen would actually
   *  change. Without it the sweep rebuilds the card every few seconds for no
   *  reason, which is churn a reviewer would rightly read as a bug.
   *  🔴 BOTH are remembered, not just the first: a sweep that only watched
   *  `farEndPaid` would leave 「a visitor is spending your plan」 on screen after
   *  the visitor stopped, and would do it silently. */
  let farEndPaid = false;
  let guestSpent = false;

  function recompute(): void {
    const now = Date.now();
    farEndPaid = farEndIsPaying(payer.value, now);
    guestSpent = guestIsSpending(payer.value, now);
    card.value = deriveAccountCard({
      cloud: cloud.value,
      raw: raw.value,
      lastLive,
      loading: loading.value,
      farEndPays: farEndPaid,
      guestSpends: guestSpent,
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

  // ── cards MP-3 / MP-8: whose minutes is this recording costing ──────────────
  //
  // 🔴 THIS SUBSCRIPTION DOES NOT FEED THE NUMBERS. The card's figures come from
  // `refresh()` and keep coming from there; the only thing taken off these frames
  // is the `payer` word (`billing-payer.ts` reads one key and ignores the rest).
  // A second source for a number already on screen is this repo's #1 bug shape.
  //
  // 🔴 AND IT IS WATCHDOGGED, because the relay has no 「the recording ended」
  // frame to close the latch with: it pushes on start and every ~10 s while a
  // recording runs, then simply stops. The freshness test lives in
  // `farEndIsPaying`; this timer is only what makes the screen re-ask it. Its
  // period is half the freshness window so the sentence disappears within about
  // one heartbeat of the last frame rather than whenever something else happens
  // to touch the card.
  let unlisten: (() => void) | null = null;
  let sweep: ReturnType<typeof setInterval> | null = null;
  onMounted(() => {
    void onChannel<unknown>(CH.billingBudget, (frame) => {
      const next = foldBudgetFrame(payer.value, frame, Date.now());
      if (next === payer.value) return;
      payer.value = next;
      recompute();
    }).then((off) => {
      unlisten = off;
    });
    sweep = setInterval(() => {
      // Nothing has aged out ⇒ nothing to redraw. The tests are the same
      // functions the render uses, so the sweep can never disagree with what is
      // on screen.
      const now = Date.now();
      if (
        farEndIsPaying(payer.value, now) !== farEndPaid
        || guestIsSpending(payer.value, now) !== guestSpent
      ) {
        recompute();
      }
    }, PAYER_FRESH_MS / 2);
  });
  onUnmounted(() => {
    if (sweep !== null) clearInterval(sweep);
    sweep = null;
    unlisten?.();
    unlisten = null;
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
