// The update card must ALWAYS say something — one render per outcome the Rust
// side can emit, plus the two states only the frontend knows about.
//
// 🔴 WHY THIS FILE EXISTS (0.3.49). owner, 2026-08-30, a Windows 10 box on
// 0.3.48, English UI: under Settings → About, where the update card should be,
// there was an EMPTY rounded box — no text, no button — and owner read it as
// 「自动更新检测没有实现」("automatic update detection is not implemented").
// `update-block.test.ts` pins sentence-by-sentence what each state says, and
// every one of those assertions was green: not one of them asked the question
// this file asks, which is 「is there ANY sentence at all」. The empty box was
// a state with no branch: `UpdateBlock` wrapped its whole tree in
// `v-if="showsUpdateBlock(s)"`, which is false for `form === 'dev'` — and
// `form: 'dev'` is BOTH what a build-tree copy reports AND the store's
// pre-answer placeholder before `update_state` has returned. Either way the
// component rendered a `<!---->` and the `card pad` wrapper in SettingsPage
// stayed on screen around nothing.
//
// The harness is the one `update-block.test.ts` established (SSR through
// `vue/server-renderer`, comments stripped) — with one more step: TAGS are
// stripped too, so what is compared is the text a reader gets, and an element
// tree with no words in it comes out as ''. Asserting on markup here would let
// `<div class="upd"></div>` pass as "rendered".
//
// 🔴 The matrix is enumerated from the Rust types, not from what the template
// happens to branch on: `InstallForm::tag()` (form.rs), `UpdatePlan::tag()`
// (mod.rs), `ManualReason` (mod.rs), `UpdateFailure::tag()` (failure.rs — read
// through FAILURE_KEYS, which `update-tag-parity.test.ts` binds to that file),
// and `PendingOutcome` (breadcrumb.rs). A new Rust variant that reaches the
// screen with no words gets caught here, whichever file it was added to.

import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { FAILURE_KEYS, type UpdateSnapshot, type UpdateStateDto } from '../lib/update-view';
import UpdateBlock from './components/UpdateBlock.vue';
import { S, hydrateLocale, setLocale, wireLocaleStore } from '../lib/strings';
import type { KvStore } from '../lib/types';

function memKv(): KvStore {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

function state(over: Partial<UpdateStateDto> = {}): UpdateStateDto {
  return {
    current_version: '0.3.48',
    form: 'msi',
    auto_check: true,
    last_success_check: null,
    checking: false,
    plan: null,
    latest: null,
    notes_url: null,
    manual_reason: null,
    failure: null,
    download: { active: false, received: 0, total: 0 },
    verified_filename: null,
    verified_sha256: null,
    verified_size: null,
    can_swap_in_place: null,
    pending: null,
    ...over,
  };
}

/** The words a reader gets: markup and comments removed, whitespace folded. */
async function text(s: UpdateStateDto, snapshot?: UpdateSnapshot): Promise<string> {
  const html = await renderToString(createSSRApp(UpdateBlock, { s, snapshot }));
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── the enumeration ────────────────────────────────────────────────────────

/** `InstallForm::tag()` — every arm. `dev` is handled on its own below because
 *  it is the one form that never checks. */
const CHECKING_FORMS = ['msi', 'portable', 'unknown', 'unsupported_platform'] as const;

/** `ManualReason` → the DTO's `manual_reason` tag. */
const MANUAL_REASONS = ['unknown_form', 'unsupported_platform', 'no_fetchable_kind'] as const;

interface Case {
  name: string;
  s: UpdateStateDto;
  snapshot?: UpdateSnapshot;
  /** At least one sentence the reader must be able to find. */
  says: () => string[];
}

function matrix(): Case[] {
  const cases: Case[] = [];

  // Frontend-only states: before Rust has answered, and when it never did.
  cases.push({
    name: 'the store’s pre-answer placeholder (update_state not yet returned)',
    s: state({ current_version: '', form: 'dev' }),
    snapshot: 'pending',
    says: () => [S.upd_section, S.upd_loading],
  });
  cases.push({
    name: 'update_state never answered (invoke failed / outside Tauri)',
    s: state({ current_version: '', form: 'dev' }),
    snapshot: 'unanswered',
    says: () => [S.upd_section, S.upd_state_unavailable, S.upd_check_now],
  });

  // A dev build: Rust checks nothing (design §4.2) and says so.
  cases.push({
    name: 'form=dev, plan=null (a build-tree copy before any check)',
    s: state({ form: 'dev' }),
    says: () => [S.upd_section, S.upd_dev_note],
  });
  cases.push({
    name: 'form=dev, plan=not_checked (a build-tree copy after update_check)',
    s: state({ form: 'dev', plan: 'not_checked' }),
    says: () => [S.upd_section, S.upd_dev_note],
  });

  for (const form of CHECKING_FORMS) {
    cases.push({
      name: `form=${form}, plan=null (never checked this session)`,
      s: state({ form }),
      says: () => [S.upd_section, S.upd_current, S.upd_last_check_never, S.upd_check_now],
    });
    cases.push({
      name: `form=${form}, plan=up_to_date`,
      s: state({ form, plan: 'up_to_date', last_success_check: '2026-08-30T08:00:00Z' }),
      says: () => [S.upd_up_to_date],
    });
    cases.push({
      name: `form=${form}, plan=available`,
      s: state({ form, plan: 'available', latest: '9.9.9', notes_url: 'https://x/n' }),
      says: () => [S.upd_available, '9.9.9'],
    });
    for (const reason of MANUAL_REASONS) {
      cases.push({
        name: `form=${form}, plan=manual_only, reason=${reason}`,
        s: state({ form, plan: 'manual_only', latest: '9.9.9', manual_reason: reason }),
        says: () => [S.upd_available, '9.9.9'],
      });
    }
    for (const tag of Object.keys(FAILURE_KEYS)) {
      cases.push({
        name: `form=${form}, failure=${tag}`,
        s: state({ form, failure: { tag, detail: 'd', blocking: false } }),
        says: () => [(S as Record<string, string>)[FAILURE_KEYS[tag] as string] as string],
      });
    }
    cases.push({
      name: `form=${form}, pending=completed`,
      s: state({ form, pending: { outcome: 'completed', from: '0.3.47', to: '0.3.48', detail: null } }),
      says: () => [S.upd_done, '0.3.48'],
    });
    cases.push({
      name: `form=${form}, pending=not_completed`,
      s: state({
        form,
        pending: { outcome: 'not_completed', from: '0.3.47', to: '0.3.48', detail: 'rolled_back' },
      }),
      says: () => [S.upd_pending_failed, S.upd_pending_rolled_back],
    });
  }
  return cases;
}

beforeEach(() => {
  wireLocaleStore(memKv());
  hydrateLocale();
  setLocale('en');
});

describe('UpdateBlock renders words in every outcome (en)', () => {
  const cases = matrix();

  it('enumerates more than the four forms × five plans', () => {
    // A sanity floor, so a refactor that empties the matrix cannot pass vacuously.
    expect(cases.length).toBeGreaterThan(4 * 5 + Object.keys(FAILURE_KEYS).length);
  });

  for (const c of cases) {
    it(`says something: ${c.name}`, async () => {
      const words = await text(c.s, c.snapshot);
      // 🔴 THE assertion. Everything below it is "which sentence"; this one is
      // "any sentence" — the question nobody had asked.
      expect(words, `rendered an empty card for: ${c.name}`).not.toBe('');
      for (const sentence of c.says()) {
        expect(sentence, `no catalogue value behind a sentence for: ${c.name}`).toBeTruthy();
        expect(words).toContain(sentence);
      }
    });
  }
});
