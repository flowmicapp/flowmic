<script setup lang="ts">
// SPEC-REF:
//   docs/strategy/2026-08-02-l3-account-card-design.md §2 (information architecture + four states)
//
// The ONE rendering of the cloud account block. Both the Settings page account card
// and the Devices page cloud card embed this — before L3 each page drew its own copy
// of the same four lines, so "plan" and "valid until" had to be fixed twice and
// could be fixed differently.
//
// Purely presentational: everything it shows arrives in the `card` prop, computed by
// lib/cloud-account.ts and fed by lib/use-cloud-account.ts. That split is what makes
// the honesty rules unit-testable without a browser (same pattern as PairedList.vue).
//
// 🔴 The two expiry lines are SEPARATED BY A RULE and each label names WHOSE expiry it
// is. owner 2026-08-02 screenshot: "Plan FREE" sitting directly above "Valid until
// 2026-08-03" reads as "the subscription expires tomorrow", while the date was the
// Cloud Key's own exp. A single value was answering two questions, and the layout
// was half the reason.
import { computed } from 'vue';
import { S } from '../../lib/strings';
import type { AccountCard } from '../../lib/cloud-account';

// 🔴 M3-8: this component used to take a second prop, `cloud: CloudStatus`, and the
// Account row read `card.account?.email ?? card.account?.account_id ?? cloud.subject`.
// The last two are the account's internal UUID, so "couldn't be answered" printed a
// bare `3f9c1a2e-…-b7d4` under the label "Account" — which is not an answer to "who
// am I". The prop is GONE rather than merely unused: with no `CloudStatus` in scope
// the component cannot re-grow that fallback, and "whose job is it to answer ②" has
// exactly one answer (`cloud-account.ts` [identityLine]). Everything the card
// renders now arrives pre-decided in `card`, including "Cloud Key valid until"
// (which is where the key's own claims are still legitimately read — by the pure
// layer, from `cloud`).
const props = defineProps<{ card: AccountCard }>();
const emit = defineEmits<{ (e: 'retry'): void }>();

// ⚠️ The template deliberately has no HTML comments: Vue SSR emits them verbatim
// into the HTML, so a negative assertion like "does this sentence appear on screen"
// would be tricked green/red by the exact same string sitting in a comment. Anything
// that needs saying is written here instead.
//
// The order of the lines and when each appears (design doc §2.1):
//   ① loud — only present on a 401; loud and actionable, never merged into "can't
//      be reached right now";
//   ② Account — **the whole line is absent when there is no live answer** (not
//      "—", and definitely not the internal id);
//   ⑤ Subscription valid-until — the whole line is absent on the free tier (not "—");
//   ⑥ Cloud Key valid-until — below the divider, its label already carries the
//      words "Cloud Key".
//
// The divider exists to "separate ⑤ from ⑥". When ②③④⑤ are all absent (i.e.
// unreachable / 401) there is nothing above it, and drawing it would leave a
// dangling horizontal rule at the top of the page — so it only appears when there
// really is something above it.
const hasRowsAbove = computed(
  () =>
    props.card.identityText !== null ||
    props.card.planBadge !== null ||
    props.card.usageText !== null ||
    props.card.subExpiresText !== null ||
    props.card.subStateText !== null,
);
</script>

<template>
  <div class="ca">
    <div v-if="card.loud" class="ca-loud" role="alert">{{ card.loud }}</div>

    <div v-if="card.identityText" class="ca-line">
      <span class="ca-k">{{ S.cloud_account }}</span>
      <span class="ca-v mono">{{ card.identityText }}</span>
    </div>

    <div v-if="card.planBadge" class="ca-line">
      <span class="ca-k">{{ S.cloud_plan }}</span>
      <span class="chip plan">{{ card.planBadge }}</span>
      <span v-if="card.sourceBadge" class="chip src">{{ card.sourceBadge }}</span>
    </div>

    <div v-if="card.usageText" class="ca-line">
      <span class="ca-k">{{ S.cloud_usage }}</span>
      <span class="ca-v">{{ card.usageText }}</span>
    </div>

    <div v-if="card.subExpiresText" class="ca-line">
      <span class="ca-k">{{ S.cloud_sub_expires }}</span>
      <span class="ca-v">{{ card.subExpiresText }}</span>
    </div>
    <div v-if="card.subStateText" class="ca-line">
      <span class="ca-k"></span>
      <span class="ca-v warn">{{ card.subStateText }}</span>
    </div>

    <template v-if="card.keyExpiresText">
      <div v-if="hasRowsAbove" class="ca-sep"></div>
      <div class="ca-line">
        <span class="ca-k tip" :title="S.cloud_key_expires_tip">{{ S.cloud_key_expires }}</span>
        <span class="ca-v">{{ card.keyExpiresText }}</span>
      </div>
    </template>

    <div v-if="card.statusText || card.canRetry" class="ca-status">
      <span v-if="card.statusText" :class="{ dim: card.phase === 'live' }">{{ card.statusText }}</span>
      <button v-if="card.canRetry" class="ca-retry" type="button" @click="emit('retry')">
        {{ S.cloud_acct_retry }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ca { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
.ca-line { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; flex-wrap: wrap; }
.ca-k { color: var(--t3); min-width: 108px; }
.ca-v { color: var(--t1); word-break: break-all; }
.ca-v.warn { color: var(--amber-ink); }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.chip { font-size: 11px; padding: 1px 7px; border-radius: 999px; line-height: 1.6; }
.chip.plan { background: var(--amber-soft); color: var(--amber-ink); }
.chip.src { background: var(--teal-soft); color: var(--teal-ink); }
/* The rule that keeps "Subscription" and "Cloud Key" from being read as one block. */
.ca-sep { height: 1px; background: var(--line); margin: 4px 0 2px; }
/* Sibling of PairedList's `.pm-seen`: a dotted underline is this app's ONE mark for
   "there's an explanation here". */
.tip { text-decoration: underline dotted; text-underline-offset: 2px; cursor: help; }
.ca-status { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--t2); flex-wrap: wrap; }
.ca-status .dim { color: var(--t3); }
.ca-loud { font-size: 12px; color: var(--red-ink); background: var(--red-soft); border-radius: 6px; padding: 6px 8px; }
.ca-retry {
  font-size: 11.5px; padding: 2px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--line); background: transparent; color: var(--t2);
}
.ca-retry:hover { color: var(--t1); border-color: var(--t3); }
</style>
