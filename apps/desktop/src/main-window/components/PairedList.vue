<script setup lang="ts">
// The "Paired Phones" (已配对手机) card, split out of DevicesPage.vue in the
// 2026-07-29 polish round (the grouping work below would have pushed that file
// past the 800-line cap — same reason PairingModal exists). It owns ONLY
// presentation:
//
//   • the three read states (loading / failed-loud / genuinely no pairings) —
//     a failed read is still never drawn as "not a single one";
//   • D1: rows are GROUPED PER PHYSICAL HANDSET (derivePairedGroups). One phone
//     paired over both channels used to be two loose rows plus a "same phone"
//     chip; now it is one group whose header carries the name and the aggregate
//     online fact (ANY channel online → the phone is online), with one sub-row
//     per pairing. The chip is gone — the structure says it.
//   • D2: row actions adapt to state ("disconnect" only exists while there IS a
//     connection to end) and sit in a fixed right-hand column instead of
//     drifting with the row's content.
//   • D5: "last active" reads relative (just now / N minutes ago / N hours ago /
//     yesterday), the full stamp moved to the tooltip. "Paired at" stays the
//     full stamp.
//
// NOTHING about the data flow changed: the parent still fetches
// (pc:list-mobiles) and passes the view down; every button calls the same
// lib/release-mobile state machine with the same pairing_id + channel, and the
// machine's three rules (confirm gate / loud failure / one-at-a-time) are its
// own tests', not this template's.

import { computed, reactive, ref } from 'vue';
import Icon from './Icon.vue';
import { S } from '../../lib/strings';
import { releaseMobile } from '../../lib/bridge';
import { CHANNEL_LABEL, CHANNEL_VISUAL, type ChannelId } from '../../lib/channel';
import {
  derivePairedGroups,
  derivePairedList,
  type PairedGroup,
  type PairedMobileRow,
  type PairedPresenceView,
  type Presence,
} from '../../lib/paired-mobiles';
import { formatRelativeTime } from '../../lib/relative-time';
import { askRevoke, cancelRevoke, newReleaseState, performRelease, type ReleaseDeps } from '../../lib/release-mobile';

const props = defineProps<{
  /** undefined = still reading · null = the read FAILED (loud) · view = the truth
   *  (rows carry presence; unreachable channels' rows come from the last-known
   *  cache marked `unknown` — the merge lives in lib/paired-mobiles, the parent
   *  wires storage). */
  view: PairedPresenceView | null | undefined;
  /** The parent's re-read. The release state machine awaits it after a REAL
   *  success (its rule ②: a failed action never refreshes the table), so this
   *  must be the async fetch itself, not a fire-and-forget emit. */
  reload: () => Promise<void>;
}>();

const pairedList = computed(() =>
  derivePairedList(props.view === undefined ? undefined : (props.view?.rows ?? null)),
);
const groups = computed(() => derivePairedGroups(pairedList.value.rows));
/** Header counts are PER HANDSET now — the section is called "Paired Phones"
 *  (已配对手机), so the number must count phones, not pairing records. */
const onlineGroups = computed(() => groups.value.filter((g) => g.presence === 'online').length);
/** Mockup §2: the old red unreachable banner (an internal-reasoning sentence in
 *  error styling) is GONE. When an unreachable channel has cached rows, the rows
 *  themselves say "state unknown"; only a channel with NOTHING cached gets this
 *  one quiet line — the old honesty rule ("could not ask" ≠ "no phone") kept,
 *  minus the shouting. It is a state-style notice: it disappears by derivation
 *  the moment the channel answers again. */
const unlistedLine = computed(() => {
  const chans = props.view?.unlisted ?? [];
  if (chans.length === 0) return null;
  return chans.map((c) => S.dev_paired_unlisted.replace('{ch}', CHANNEL_LABEL[c])).join(' ');
});

// ── the tri-state session chip (unknown ≠ error — Presence's doc has the whole story) ──
function chipText(p: Presence): string {
  return p === 'online' ? S.dev_paired_online : p === 'unknown' ? S.dev_paired_unknown : S.dev_paired_offline;
}
function chipClass(p: Presence): string {
  return p === 'online' ? 'in-use' : p === 'unknown' ? 'unk-chip' : 'off-chip';
}
function dotClass(p: Presence): string {
  return p === 'online' ? 'g' : p === 'unknown' ? 'unk' : 'off';
}
function rowChipTitle(m: PairedMobileRow): string {
  return m.presence === 'unknown'
    ? S.dev_paired_unknown_tip.replace('{t}', m.asOfLabel ?? '—')
    : S.dev_paired_online_tip;
}
/** ③ (owner 2026-08-21 screenshot ruling): an offline handset used to say
 *  「离线」 three times — once on the header, once per pairing row. When every
 *  row shares the header's aggregate state the row chips repeat it, so they
 *  render only when the rows DISAGREE (one channel online, the other not) —
 *  the one case where a per-row answer carries information the header cannot. */
function uniformPresence(g: PairedGroup): boolean {
  return g.rows.every((r) => r.presence === g.presence);
}
/** The group header's aggregate chip. For an unknown aggregate the tooltip quotes
 *  the first unknown member's snapshot time — one handset, one cache read. */
function groupChipTitle(g: PairedGroup): string {
  if (g.presence !== 'unknown') return S.dev_paired_online_tip;
  const asOf = g.rows.find((r) => r.presence === 'unknown')?.asOfLabel ?? '—';
  return S.dev_paired_unknown_tip.replace('{t}', asOf);
}

const retrying = ref(false);
async function onRetry(): Promise<void> {
  if (retrying.value) return;
  retrying.value = true;
  try {
    await props.reload();
  } finally {
    retrying.value = false;
  }
}

// GA-08: the release state machine, bound exactly as DevicesPage bound it.
const release = reactive(newReleaseState());
const releaseDeps: ReleaseDeps = { release: releaseMobile, reload: props.reload };
const doRelease = (id: string, revoke: boolean, channel: ChannelId): Promise<boolean> =>
  performRelease(release, releaseDeps, id, revoke, channel);

/** D5 — "last active" relative; a missing/unparseable stamp keeps the old fallback. */
function relTime(iso: string | null): string {
  return formatRelativeTime(iso) ?? S.dev_paired_never;
}

/** 🔴 owner 2026-08-02 UI batch 1 ②: "'Offline' and 'active just now' appearing
 *  side by side — the status semantics are either wrong or misleading."
 *
 *  After going back to the code, the answer is **misleading, not wrong** — both
 *  values are true, they answer two different questions, and the UI puts them
 *  side by side without explaining either. Field by field (what each one
 *  actually means, and who writes it):
 *
 *   · Online/offline chip ← `m.online` ← the server's `pc:list-mobiles`:
 *     `store.getMobile(pc.room_uuid, m.id)?.connected === true`
 *     (apps/server-core/src/socket/handlers/pc.handler.ts). Whether **this
 *     pairing's** socket is in the room, **right now**, **on this channel's
 *     server**. Per-channel, per-pairing, instantaneous.
 *     ⚠️ A phone inside the mobile-drop grace period counts as **offline**
 *     here (that spot has the lead's long ruling comment).
 *
 *   · Last active ← `m.last_seen_at` ← the `mobile_pairings.last_seen_at`
 *     column. There are **only three writers**, all audited:
 *       ① `mobile:reconnect` (registry.reconnectMobile) — ⚠️ **including the
 *          refused ones**: `last_seen_at` is stamped during the lookup that
 *          happens BEFORE the suite gate, and the comment there says "a refused
 *          reconnect is still a real contact." ⇒ A phone being blocked on the
 *          reconnect ladder by `PAIR_RELEASED` / `PC_BUSY` will **both refresh
 *          this column to "just now" AND never enter the room**. **That is
 *          exactly the screenshot.**
 *       ② `heartbeat` (heartbeat.handler.ts) — ⚠️ the phone only runs this
 *          5-second timer **while actively recording** (ptt_session.dart's
 *          `_startHeartbeat` is only called from pttDown / resumeCapture), so
 *          it is **not** a standing presence signal;
 *       ③ the Bearer-authenticated HTTP entry points (`POST /api/inject/image`
 *          and the diagnostics upload, via http/pairing-auth.ts's
 *          `verifyPairedMobile`).
 *     **Does NOT include** `GET /api/pc/presence`: RV-98 deliberately turned it
 *     into a pure lookup (`findPairingByToken`), for exactly the same reason as
 *     here — a column that answers both "last actually connected" and "last
 *     polled" is this repo's #1 bug shape. That one is already fixed correctly;
 *     do not "unify" it back because of this note.
 *
 *  ⇒ "Offline + just now" is a sentence that **can be true at the same time**:
 *  "it has no session right now; it made contact just a moment ago."
 *  So the fix is not to change the judgement criteria (that would make it lie),
 *  but (a) fix the half that is genuinely broken — the refresh trigger was
 *  missing the non-primary channel, see DevicesPage.vue's `perChannelMobiles`;
 *  (b) let the two cells on the same row make clear which question each one is
 *  answering — which is exactly what this title does. */
function lastSeenTitle(stamp: string | null): string {
  return stamp === null ? S.dev_paired_last_seen_tip : `${stamp}\n${S.dev_paired_last_seen_tip}`;
}
</script>

<template>
  <div class="sub-h">
    {{ S.dev_paired }}
    <span v-if="pairedList.state === 'rows'" class="paired-count">
      {{ S.dev_paired_count }} {{ groups.length }} {{ S.dev_paired_unit }} ·
      {{ onlineGroups }} {{ S.dev_mobiles_online }}
    </span>
  </div>
  <div class="card pad">
    <div v-if="pairedList.state === 'loading'" class="muted">{{ S.dev_paired_loading }}</div>

    <div v-else-if="pairedList.state === 'failed'">
      <div class="chan-loud">{{ S.dev_paired_failed }}</div>
      <button class="btn ghost sm" style="margin-top:10px" :disabled="retrying" @click="onRetry">
        <Icon name="refresh" />{{ S.dev_paired_retry }}
      </button>
    </div>

    <div v-else-if="pairedList.state === 'empty'" class="muted">{{ S.dev_paired_empty }}</div>

    <ul v-if="pairedList.state === 'rows'" class="paired-list">
      <li v-for="g in groups" :key="g.key" class="paired-group">
        <!-- EVERY handset gets the same header, whether it holds one pairing or
             two (owner 2026-08-20 screenshot ruling: with shelled multi-groups
             and bare single rows in ONE list, the singles read as a different
             kind of thing — 「样式分不清，看起来奇怪」. The earlier 10b §2.4 rule
             「a single pairing gets no shell」 optimised each item alone and lost
             the list: uniformity IS information when items sit side by side).
             The dot and the status chip are the AGGREGATE tri-state (any channel
             online → online; else any unknown → unknown — "no session right now"
             is not claimable while one channel could not be asked). For a
             single-pairing handset the aggregate is simply that pairing's own
             state — same sentence, one source. -->
        <!-- ③ pg-off: an offline handset reads dimmed as a WHOLE (name + glyph),
             so the list separates live from dormant at a glance instead of by
             chip-reading. Actions and times keep full contrast — dimming what
             the user may still need to press would trade noise for friction. -->
        <div class="pg-head" :class="{ 'pg-off': g.presence === 'offline' }">
          <span class="dot" :class="dotClass(g.presence)"></span>
          <!-- REQ-12-10b: the header is the HANDSET, the rows are its pairings.
               A shape as well as a dot, per owner 2026-08-01 "must not rely on
               colour alone" — and the rows carry channel silhouettes, so a phone
               glyph here keeps the two levels visually different rather than
               differently coloured. -->
          <Icon name="phone" class="pg-ic" />
          <span class="pm-name">{{ g.name }}</span>
          <span class="chip" :class="chipClass(g.presence)" :title="groupChipTitle(g)">
            {{ chipText(g.presence) }}
          </span>
          <!-- The count chip stays multi-only: 「2 条配对」 explains why one phone
               has several rows; 「1 条配对」 explains nothing (and its English
               plural would be wrong). The SHELL is what is uniform, not this. -->
          <span v-if="g.multi" class="chip pg-count" :title="S.dev_group_hint">{{ g.rows.length }} {{ S.dev_group_pairings }}</span>
        </div>
        <ul class="pg-rows">
          <li v-for="m in g.rows" :key="`${m.channel}:${m.pairing_id}`" class="paired-row">
            <!-- Each sub-row is one PAIRING on one channel — its chip, times and
                 buttons all remain its own (disconnect/unpair on one does nothing
                 to the other). owner 2026-08-01: colour + icon combination, must
                 not rely on colour alone — this used to be a private
                 `.chip.chan-lan/.chan-cloud` pair aliasing the generic teal/brand
                 tokens (same colours as CHANNEL_VISUAL by coincidence, a second
                 definition that could silently drift). Now the ONE definition:
                 lib/channel.ts's CHANNEL_VISUAL selects a real icon +
                 tokens.css's `.chan-badge.<css>`, same shape TimelinePage.vue
                 uses for a timeline row's channel. -->
            <span class="chan-badge" :class="CHANNEL_VISUAL[m.channel].css">
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" v-html="CHANNEL_VISUAL[m.channel].iconPath"></svg>
              {{ CHANNEL_LABEL[m.channel] }}
            </span>
            <!-- owner 2026-08-02 UI batch 1 ②: the chip answers "is there a
                 session right now" and the meta line's "last active" answers
                 "when was the last contact" — see lastSeenTitle() for the full
                 definition of each and why both can be true at once.
                 Reworked: a channel that could not be ASKED answers neither —
                 that is the third state "state unknown," neutral (dashed, weak
                 grey), never red. -->
            <span v-if="!uniformPresence(g)" class="chip" :class="chipClass(m.presence)" :title="rowChipTitle(m)">
              {{ chipText(m.presence) }}
            </span>
            <span class="pm-meta">
              {{ S.dev_paired_at }} {{ m.pairedLabel ?? '—' }}
              ·
              {{ S.dev_paired_last_seen }}
              <span class="pm-seen" :title="lastSeenTitle(m.lastSeenLabel)">{{ relTime(m.last_seen_at) }}</span>
            </span>
            <!-- D2: a fixed right-hand action column. "Disconnect" exists only
                 while the phone is online (an offline row has no session to
                 end); "unpair" is always available and still gated on the
                 inline confirmation — EXCEPT on an unknown row: the revoke
                 travels this row's channel and that channel cannot be reached,
                 so the press is guaranteed to fail. A button that promises a
                 guaranteed failure is worse than a disabled one that says why
                 (mockup §2.3). -->
            <span class="pm-act">
              <button v-if="m.online" class="btn ghost sm" :title="S.dev_release_hint"
                :disabled="release.busyId !== null" @click="doRelease(m.pairing_id, false, m.channel)">
                {{ S.dev_release }}
              </button>
              <button class="btn ghost sm danger"
                :title="m.presence === 'unknown' ? S.dev_revoke_unreachable : S.dev_revoke_hint"
                :disabled="release.busyId !== null || m.presence === 'unknown'"
                @click="askRevoke(release, m.pairing_id)">
                {{ S.dev_revoke }}
              </button>
            </span>
            <div v-if="release.confirmId === m.pairing_id" class="pm-confirm">
              <span class="pm-confirm-t">{{ S.dev_revoke_confirm }}</span>
              <button class="btn ghost sm" @click="cancelRevoke(release)">{{ S.dev_release_cancel }}</button>
              <button class="btn danger sm" :disabled="release.busyId !== null"
                @click="doRelease(m.pairing_id, true, m.channel)">{{ S.dev_revoke_do }}</button>
            </div>
            <div v-if="release.failedId === m.pairing_id" class="chan-loud pm-loud">{{ S.dev_release_failed }}</div>
          </li>
        </ul>
      </li>
    </ul>

    <!-- A channel that could not be asked and has no cache: one weak-grey line
         (not red — unknown is not an error), appears at the bottom of the card.
         Absent when there is a cache: then the "unknown" fact is carried by the
         "state unknown" chip on the row itself. -->
    <div v-if="unlistedLine !== null" class="chan-note">{{ unlistedLine }}</div>
  </div>
</template>

<style scoped>
/* "Paired Phones" (已配对手机) card (R6 T-8; moved from DevicesPage.vue unchanged where not noted) */
.paired-count { margin-left: 8px; font-size: 11.5px; font-weight: 500; color: var(--t3); }
.chan-loud { margin-top: 8px; font-size: 12px; color: var(--red); background: var(--red-soft); border-radius: 8px; padding: 8px 10px; line-height: 1.5; }

/* D1: the list's unit is the GROUP (one physical handset), rows nest inside.
 *
 * 🔴 owner 2026-08-02 screenshot: "there's a stray dot in front of the unpair
 * row." That black dot is the `<li>`'s own **bullet marker**, not anything we
 * drew — tokens.css's `* { margin:0; padding:0 }` reset does not include
 * `list-style`, so it has always been there. Why only this row has it:
 * `.paired-row` and `.pg-rows` both set `display: flex`, and flex knocks out
 * `display: list-item`, taking the marker with it; `.paired-group` (the group
 * header `li`) **has no `display` set**, so once it is blockified as a flex
 * child it is STILL a list-item ⇒ only it grows a dot.
 * ⚠️ Same-family scan (only four `<ul>`s in the whole repo): `DataPortability.vue`'s
 * two `.report` lists **deliberately** want bullet markers (import results,
 * line by line), so this rule is **scoped to only this file's two lists**,
 * not a global `ul { list-style: none }` — that would strip the markers those
 * two spots genuinely need. */
.paired-list, .pg-rows { list-style: none; }
.paired-list { display: flex; flex-direction: column; gap: 8px; }
/* REQ-12-10b (desktop half), reworked per owner 2026-08-20 — EVERY handset gets
 * the same shell.
 *
 * History, because the reversal is the story: 10b §2.4 originally ruled 「a
 * single pairing gets no shell — chrome with no information in it is worse than
 * none」. That optimised each item alone. The owner's 2026-08-20 screenshot
 * showed what it does to the LIST: shelled two-pairing groups and bare one-line
 * rows interleaved read as two different kinds of object (「样式分不清，看起来
 * 奇怪」), when they are the same kind — one physical handset. Uniform shells
 * make the unit of the list visible: one box = one device, its rows = its
 * pairings, however many there are.
 *
 * What did NOT change: the sub-rows keep their own channel badge, presence chip
 * and disconnect/unpair buttons, and acting on one still does nothing to the
 * other (that independence is a fact about the pairings, not a rendering
 * choice; see `dev_group_hint`).
 * ⚠️ Still deliberately NEUTRAL, not tinted per machine: the phone's list has an
 * identity colour lane (REQ-12-10 hashes `pc_machine_uid` to one of four), the
 * desktop has no such lane, and inventing one here would be a second identity
 * language that agrees with nothing. */
.paired-group { border: 1px solid var(--line); border-radius: var(--r12);
  background: var(--surface-inset); padding: 0 12px 4px; }
.pg-ic { width: 13px; height: 13px; color: var(--t3); }
.pg-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 0 9px; margin-bottom: 1px; border-bottom: 1px solid var(--line-soft);
  font-size: 13px; color: var(--t1); }
/* ③ offline handset: the whole identity dims, not just a chip (see template). */
.pg-head.pg-off .pm-name { color: var(--t3); font-weight: 500; }
.pg-head.pg-off .pg-ic { opacity: .6; }
.pg-rows { display: flex; flex-direction: column; padding-left: 2px; }
/* Rows divide INSIDE the shell; between shells the gap + border do the work. */
.paired-row + .paired-row { border-top: 1px dashed var(--line-soft); }
.paired-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 9px 0; font-size: 13px; color: var(--t1); }
/* a phone name is user-supplied and unbounded — ellipsize instead of letting
   it shove the chips and actions off the row */
.pm-name { font-weight: 600; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* D2: the action column is pinned to the row's right edge (margin-left:auto
   here, NOT on .pm-meta — that was the drift: meta width decided where the
   buttons landed). The group is one flex item, so on narrow rows it wraps as a
   unit and stays right-aligned. */
.pm-meta { font-size: 11.5px; color: var(--t3); }
/* owner 2026-08-02 UI batch 1 ②: the "last active" value carries a
   definitional tooltip, marked with a dotted underline telling the user
   "there's an explanation here" — otherwise that explanation would only be
   read by someone who happens to hover over it, and it is exactly the
   sentence that resolves why "offline + just now" looks self-contradictory. */
.pm-seen { text-decoration: underline dotted; text-underline-offset: 2px; cursor: help; }
.pm-act { margin-left: auto; flex: none; display: inline-flex; gap: 6px; }
.pm-act .btn, .pm-confirm .btn { font-size: 11.5px; padding: 3px 9px; }
.btn.danger { background: var(--red); color: var(--on-brand); }
.btn.ghost.danger { background: transparent; color: var(--red); }
/* the "unpair" confirmation stays full-width, so the consequence sentence is
   never clipped behind the meta column */
.pm-confirm { flex: 1 0 100%; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 6px; padding: 8px 10px; border-radius: 8px; background: var(--red-soft); }
.pm-confirm-t { flex: 1 1 200px; font-size: 11.5px; color: var(--t1); line-height: 1.5; }
.pm-loud { flex: 1 0 100%; }
.dot.off { background: var(--t3); }
.chip.off-chip { background: var(--off-chip-bg); color: var(--t3); }
/* "State unknown" (mockup §2.3): dashed border + hollow circle — stays visually
   distinct from "offline" (solid grey) even in greyscale; no red, no amber,
   unknown is neither an error nor a warning. */
.chip.unk-chip { background: transparent; border: 1px dashed var(--line-strong); color: var(--t3); cursor: help; }
.dot.unk { background: transparent; border: 1.5px solid var(--t3); box-sizing: border-box; }
/* Weak-grey channel note (not red) — state-type: disappears by derivation the
   instant the channel answers again. */
.chan-note { margin-top: 8px; font-size: 12px; color: var(--t3); line-height: 1.5; }
/* the group count chip is deliberately NEUTRAL: a statement ABOUT the rows,
   not a third channel. */
.chip.pg-count { background: var(--surface-2); color: var(--t2); }

.btn.pri:disabled, .btn.ghost:disabled { opacity: .5; cursor: default; }
</style>
