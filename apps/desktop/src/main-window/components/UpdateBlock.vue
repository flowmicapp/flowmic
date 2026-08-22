<!--
  UP-3b — the **presentation** half of the "update" block. Consumes only one
  DTO, only emits events, never touches Rust itself.

  ── Two files, not an unfinished rename ────────────────────────────────────────
  There is only ONE render chain, and `update-block.test.ts` reads it as
  **data** to pin it down:

      SettingsPage.vue  →  UpdateCard.vue (fetches data)  →  UpdateBlock.vue (this file, says it in words)

  **`UpdateCard` is the one the settings page mounts**; this file is only ever
  rendered by `UpdateCard`, with no second consumer. Anyone who wants to know
  "which one is actually running on screen" gets the answer from that test, not
  from this comment — a comment asserting other code's behaviour has a truth
  value that changes with whatever that other code becomes, while the comment
  itself never does (anti-façade ④).

  🔴 Why split into two components: SSR rendering does not run `onMounted`, so
  a component that fetches its own data would forever sit at its initial value
  in a render test — that was exactly what happened in the first version, all
  11 render assertions red against `<!---->`. A test-only entry point could
  have been bolted on, but that is **changing the product for the sake of the
  test**; once "fetch data" and "say it in words" are split apart, the render
  test drives every state directly via props, and it is still testing the exact
  tree the user actually sees.
  ⇒ **A component shape that a render test cannot drive is itself a design signal.**

  🔴 Three rules that must not be touched, all guarded by tests in lib/update-view.ts:
    ① Only `verdict.kind === 'up_to_date'` may say "up to date";
    ② "Last successful check: …" appears together with the whole block,
       **never conditionally rendered** — it is the sole evidence for rule ①;
    ③ No "install" button until the hash has been verified (`verified_sha256`
       is produced by Rust's VerifiedPackage, and that type has no public
       constructor).
-->
<template>
  <div v-if="showsUpdateBlock(s)" class="upd">
    <div class="sub-h">{{ S.upd_section }}</div>

    <!-- The result of the previous attempt (breadcrumb). Event-type "updated to x" / state-type "last one did not finish" -->
    <div v-if="notice" class="upd-notice" :class="notice.kind" role="status">
      <span v-if="notice.kind === 'done'">{{ S.upd_done }} {{ notice.to }}</span>
      <span v-else>
        {{ S.upd_pending_failed }}（{{ notice.to }}）
        <span v-if="notice.rolledBack" class="muted">{{ S.upd_pending_rolled_back }}</span>
      </span>
      <button class="btn ghost sm" type="button" @click="emit('dismiss')">{{ S.upd_dismiss }}</button>
    </div>

    <div class="acct-line">
      <span class="muted">{{ S.upd_current }}</span>
      <b class="mono">{{ s.current_version }}</b>
    </div>

    <!-- Verdict line. 🔴 Only the up_to_date branch says "up to date." -->
    <div v-if="v.kind === 'available'" class="upd-headline" role="status">
      ● {{ S.upd_available }} {{ v.latest }}
    </div>
    <div v-else-if="v.kind === 'manual_only'" class="upd-headline" role="status">
      ● {{ S.upd_available }} {{ v.latest }} — {{ reasonText }}
    </div>
    <!-- 🔴 A VERDICT LINE, not a muted aside (0.3.24). owner 2026-08-21, after
         updating to the newest build and pressing 「检查更新」:「点击检查新版，没有
         任何提示」("I click check-for-updates and get no message at all"), then,
         once shown where it was: 「看起来是显示了：已是最新，但不明显」("turns out
         it does say 'up to date', it just isn't noticeable"). It was rendered in
         `.muted` — the same grey as the two lines under it — so the ONE sentence
         that answers the question the button asks was the quietest thing on the
         card. This is a status word carrying real evidence (only
         `plan === 'up_to_date'` can produce it, and the 「last successful check」
         line right below is that evidence); it gets the same weight as its
         opposite, and the ✓ so the answer survives a glance. -->
    <div v-else-if="v.kind === 'up_to_date'" class="upd-headline ok" role="status">
      ✓ {{ S.upd_up_to_date }}
    </div>
    <div v-else-if="s.checking" class="muted">{{ S.upd_checking }}</div>

    <!-- 🔴 Each failure speaks for itself, never merged into one blanket "update failed." -->
    <div v-if="s.failure" class="upd-fail" :class="{ blocking: s.failure.blocking }" role="alert">
      <div>{{ failureSentence }}</div>
      <div class="upd-detail mono">{{ s.failure.detail }}</div>
    </div>

    <!-- 🔴 Standing, never conditionally rendered — see file header ② -->
    <div class="upd-last muted">{{ S.upd_last_check }}：{{ lastCheckText }}</div>

    <div v-if="pct !== null" class="upd-progress muted">{{ S.upd_downloading }} {{ pct }}%</div>

    <!-- 🔴 The hash gate's user-visible evidence (the mockup's §5.2 line) -->
    <div v-if="s.verified_sha256" class="upd-verified">✓ {{ S.upd_verified }}</div>

    <div class="upd-actions">
      <!-- 🔴 A BUTTON, not an `<a target=_blank>` (0.3.24). The anchor looked
           right and did nothing — see the note on `openPage` in UpdateCard.vue
           and the mechanism in src-tauri/src/shell/external_open.rs. Both routes
           to this page now go through the same emit, so there is one answer to
           「点了之后会发生什么」. -->
      <button v-if="s.notes_url" class="btn ghost sm" type="button" @click="emit('open-page')">
        {{ S.upd_notes }}
      </button>
      <button
        v-if="act.kind === 'download'"
        class="btn sm"
        type="button"
        :disabled="busy"
        @click="emit('download')"
      >
        {{ S.upd_download }}<span v-if="s.verified_size"> ({{ megabytes(s.verified_size) }})</span>
      </button>
      <button
        v-else-if="act.kind === 'install_msi' || act.kind === 'install_portable'"
        class="btn sm primary"
        type="button"
        :disabled="busy"
        @click="emit('apply')"
      >
        {{ act.kind === 'install_msi' ? S.upd_install_msi : S.upd_install_portable }}
      </button>
      <button
        v-else-if="act.kind === 'open_page'"
        class="btn ghost sm"
        type="button"
        @click="emit('open-page')"
      >
        {{ S.upd_open_page }}
      </button>
    </div>
    <!-- The OS would not take the address. Say so, and put the address where it
         can be read and selected — the same trade LocalModelCard makes for the
         model folder, and the reason `open_external_url` returns a Result at
         all: this card's manual route has nothing behind it. -->
    <div v-if="openFailed" class="upd-fail" role="alert">
      <div>{{ S.ext_open_failed }}</div>
      <div class="upd-detail mono">{{ openFailed }}</div>
    </div>
    <div v-if="act.kind === 'install_msi'" class="muted upd-hint">{{ S.upd_msi_hint }}</div>
    <div v-else-if="act.kind === 'install_portable'" class="muted upd-hint">{{ S.upd_portable_hint }}</div>

    <!-- Change-applies-immediately, no save button (red line) -->
    <label class="upd-auto">
      <input type="checkbox" :checked="s.auto_check" @change="onToggle" />
      <span>{{ S.upd_auto }}</span>
    </label>
    <!-- 🔴 §3 line 8: turned off ≠ up to date. Without this line, once turned
         off the UI would be left with nothing but a silent checkbox. -->
    <div v-if="!s.auto_check" class="muted upd-hint">{{ S.upd_auto_off_note }}</div>
    <button class="btn ghost sm" type="button" :disabled="s.checking" @click="emit('check')">
      {{ s.checking ? S.upd_checking : S.upd_check_now }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { S } from '../../lib/strings';
import { getLocale } from '../../lib/strings/locale';
import {
  action,
  failureKey,
  megabytes,
  pendingNotice,
  progressPercent,
  showsUpdateBlock,
  verdict,
  type UpdateStateDto,
} from '../../lib/update-view';

const props = defineProps<{ s: UpdateStateDto; busy?: boolean; openFailed?: string | null }>();
const emit = defineEmits<{
  (e: 'check' | 'download' | 'apply' | 'dismiss' | 'open-page'): void;
  (e: 'toggle-auto', enabled: boolean): void;
}>();

const s = computed(() => props.s);
const busy = computed(() => props.busy === true);
const openFailed = computed(() => props.openFailed ?? null);
const v = computed(() => verdict(props.s));
const act = computed(() => action(props.s));
const pct = computed(() => progressPercent(props.s));
const notice = computed(() => pendingNotice(props.s));

const onToggle = (e: Event) => emit('toggle-auto', (e.target as HTMLInputElement).checked);

const reasonText = computed(() => {
  const cur = v.value;
  return cur.kind === 'manual_only' ? (S as Record<string, string>)[cur.reasonKey] : '';
});

/** 🔴 A recognised code goes through the four-language copy; an unrecognised
 *  code prints the bare identifier — **never invent a sentence for it**. */
const failureSentence = computed(() => {
  const f = props.s.failure;
  if (!f) return '';
  const key = failureKey(f.tag);
  return key ? (S as Record<string, string>)[key] : f.tag;
});

const lastCheckText = computed(() => {
  const iso = props.s.last_success_check;
  if (!iso) return S.upd_last_check_never;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return S.upd_last_check_never;
  // UI language, does not follow the OS locale (red line).
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(d);
});
</script>

<style scoped>
.upd { margin-top: 4px; }
.sub-h { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.acct-line { display: flex; align-items: baseline; gap: 8px; font-size: 13px; margin-bottom: 6px; }
.upd-headline { font-size: 13px; font-weight: 600; margin: 4px 0; }
/* The 「已是最新」 face. Same weight as its opposite above — the difference is the
   colour, which is the product's own success ink, not a green invented here. */
.upd-headline.ok { color: var(--green-ink); }
.upd-last { font-size: 12px; margin: 6px 0; }
.upd-progress { font-size: 12px; margin: 4px 0; }
.upd-verified { font-size: 12px; color: var(--green-ink); margin: 4px 0; }
.upd-fail { margin: 6px 0; padding: 8px 10px; border-radius: 8px; background: var(--amber-soft); color: var(--amber-ink); font-size: 12px; line-height: 1.55; }
.upd-fail.blocking { background: var(--red-soft); color: var(--red-ink); }
.upd-detail { margin-top: 3px; font-size: 11px; opacity: .75; word-break: break-all; }
.upd-notice { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 6px 0 10px; padding: 8px 12px; border-radius: 8px; background: var(--amber-soft); color: var(--amber-ink); font-size: 12px; line-height: 1.55; }
.upd-notice .btn { margin-left: auto; }
.upd-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
.upd-hint { font-size: 12px; line-height: 1.55; margin: 2px 0 8px; }
.upd-auto { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 10px 0 8px; cursor: pointer; }
</style>
