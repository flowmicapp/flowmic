// Component-level test — really compiles and RENDERS TimelinePage.vue.
//
// Render path: the same one prefs-appearance.test.ts / pairing-modal.test.ts use —
// vitest's default SSR transform compiles the SFC into its SSR form, so
// `vue/server-renderer`'s renderToString is the matching runtime. That means this file
// proves MARKUP and COPY, not clicks:
//   · the DECISIONS (what a search matches, what the bound drops, whether a write
//     landed) are proven in lib/timeline-store.test.ts + lib/timeline-query.test.ts;
//   · what the page SHOWS for each of those states is proven here.
//
// The three things worth this file:
//   ① owner ①: rows from BOTH servers appear in one list, each wearing its own
//      channel label — the assertion that would have failed for the entire life of the
//      one-channel store;
//   ② the EMPTY STATES are separate sentences. "no matching entries" / "the
//      timeline is genuinely empty" / "no match, and only N are kept on this
//      machine" are three different claims and collapsing any two is the
//      display face of the red line "no silent failures";
//   ③ owner 2026-07-31: the page really SAYS what the bound did and whether the rows
//      reached disk. A trimmed store that stays quiet is "the user thinks all their
//      history is there."
//
// "Searching…" is deliberately absent: the search is local and synchronous now, so the
// moment it described (question asked, answer unknown) no longer exists.
//
// `./store` is mocked because it constructs the real TimelineStore over localStorage +
// the Tauri bridge at module load; the page's own inputs are exactly the refs below,
// which is what makes that substitution honest rather than convenient.

import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineRow } from '../lib/types';
import type { RetentionFacts } from '../lib/timeline-store';

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- hoisted before imports
  const { reactive, ref } = require('vue') as typeof import('vue');
  return {
    entries: ref<TimelineRow[]>([]),
    timelineFailure: ref<null>(null),
    timelineQuery: ref(''),
    timelineRetention: ref<RetentionFacts>({ kept: 0, cutoff: null, cutoffs: { text: null, images: null } }),
    timelineStorageFailed: ref(false),
    mobileNames: reactive<Record<string, string>>({}),
    mobileMachines: reactive<Record<string, string | null>>({}),
    timeline: {
      edit: vi.fn(),
      remove: vi.fn(),
      reInject: vi.fn(),
      refresh: vi.fn(),
      search: vi.fn(),
      clearSearch: vi.fn(),
      clearFailure: vi.fn(),
      textOf: vi.fn(),
      // Rework: the collapsed data bar's live summary walks allRows() on every render.
      allRows: vi.fn(() => [] as TimelineRow[]),
    },
    // RV-93: the page reads the delivered picture through this passthrough (it is
    // exported by ./store, not by the store object) — mocked so the zoom can be
    // exercised without the Tauri bridge.
    rowImage: vi.fn(async () => null),
  };
});

vi.mock('./store', () => ({
  entries: h.entries,
  timelineFailure: h.timelineFailure,
  timelineQuery: h.timelineQuery,
  timelineRetention: h.timelineRetention,
  timelineStorageFailed: h.timelineStorageFailed,
  mobileNames: h.mobileNames,
  mobileMachines: h.mobileMachines,
  timeline: h.timeline,
  rowImage: h.rowImage,
}));

const TimelinePage = (await import('./TimelinePage.vue')).default;
const { S, setLocale } = await import('../lib/strings');
const { TL_RETENTION_MSG } = await import('../lib/strings/timeline');

function row(over: Partial<TimelineRow> = {}): TimelineRow {
  return {
    id: 'r1',
    mode: 'realtime',
    status: 'injected',
    edited: false,
    source_text: null,
    output_text: 'hello from the sidecar',
    created_at: '2026-07-30T10:00:00.000Z',
    updated_at: '2026-07-30T10:00:00.000Z',
    entry_type: 'transcript',
    control_kind: null,
    control_outcome: null,
    thumb_b64: null,
    // RV-93: "was this row's full-size picture saved." False here is the
    // honest default for a transcript fixture — the field is required
    // precisely so a row cannot omit an answer and have the page guess one.
    full_image: false,
    target: null,
    mobile_id: null,
    device_label: null,
    channel: 'lan',
    ...over,
  };
}

async function html(): Promise<string> {
  return renderToString(createSSRApp(TimelinePage));
}

afterEach(() => {
  h.entries.value = [];
  h.timelineQuery.value = '';
  h.timelineRetention.value = { kept: 0, cutoff: null, cutoffs: { text: null, images: null } };
  h.timelineStorageFailed.value = false;
  setLocale('zh-CN');
});

describe('TimelinePage — owner ① both channels in one list', () => {
  it('renders rows from BOTH servers, each carrying its own channel label', async () => {
    h.entries.value = [
      row({ id: 'a', channel: 'lan', output_text: 'said over the LAN' }),
      row({ id: 'b', channel: 'cloud', output_text: 'said over the relay', created_at: '2026-07-30T09:00:00.000Z' }),
    ];
    const out = await html();
    expect(out).toContain('said over the LAN');
    expect(out).toContain('said over the relay');
    // The two labels are the SAME ones the device page uses (lib/channel CHANNEL_LABEL).
    expect(out).toContain(S.dev_chan_lan);
    expect(out).toContain(S.dev_chan_cloud);
    expect(out).not.toContain(S.empty_timeline);
  });

  // 2026-08-01 owner: colour + icon combination, must not rely on colour alone
  // — each row's channel badge carries BOTH the css class (colour) and the
  // icon (a real different shape per channel), never text/colour alone.
  it('each row wears the icon+colour badge for ITS OWN channel — CHANNEL_VISUAL, one definition', async () => {
    h.entries.value = [
      row({ id: 'a', channel: 'lan', output_text: 'lan row' }),
      row({ id: 'b', channel: 'cloud', output_text: 'cloud row', created_at: '2026-07-30T09:00:00.000Z' }),
    ];
    const out = await html();
    // Vue SSR merges the static `class="chan-badge"` and the bound `:class="…css"`
    // with the DYNAMIC class first — "lan chan-badge", not "chan-badge lan".
    expect(out).toContain('class="lan chan-badge"');
    expect(out).toContain('class="cloud chan-badge"');
    // The two icon shapes really are different SVG bodies (not the same glyph twice).
    expect(out).toContain('cx="12" cy="20" r="1"'); // the lan icon's dot
    expect(out).toContain('M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z'); // the cloud icon's blob
  });

  it('the same id on two servers renders as TWO rows', async () => {
    // Keying the list by the bare id would have collapsed these into one (Vue would
    // also warn about duplicate keys); `(channel, id)` is the row's only address.
    h.entries.value = [
      row({ id: 'same', channel: 'lan', output_text: 'the LAN one' }),
      row({ id: 'same', channel: 'cloud', output_text: 'the relay one', created_at: '2026-07-30T09:00:00.000Z' }),
    ];
    const out = await html();
    expect(out).toContain('the LAN one');
    expect(out).toContain('the relay one');
  });
});

// Card P/D — "which phone said it" has TWO sources now, and this file is where the second one
// stops being a value nobody renders. A row minted from a delivery frame carries only
// `device_label` (the relay forwards the inject frame verbatim; it has no pairing id),
// so without this fallback every new row would go back to having no sender at all —
// which is exactly the field-with-no-renderer shape the repo bans.
describe('TimelinePage — a row says WHICH PHONE sent it', () => {
  it('prefers the live-resolved pairing name (a renamed phone reads correctly)', async () => {
    h.mobileNames.p1 = 'Pixel 8-ab12';
    h.entries.value = [row({ mobile_id: 'p1', device_label: 'the stale stamped label' })];
    const out = await html();
    expect(out).toContain('Pixel 8-ab12');
    expect(out).not.toContain('the stale stamped label');
    delete h.mobileNames.p1;
  });

  it('falls back to the label the delivery frame carried — a minted row has only that', async () => {
    h.entries.value = [row({ mobile_id: null, device_label: 'Mate 60-cd34' })];
    expect(await html()).toContain('Mate 60-cd34');
  });

  it('an unresolvable pairing id falls THROUGH to the stamped label, not to silence', async () => {
    // "cannot find this pairing" (revoked, or paired while we were not
    // looking) is not "we don't know which phone" — and the frame told us.
    h.entries.value = [row({ mobile_id: 'gone', device_label: 'Mate 60-cd34' })];
    expect(await html()).toContain('Mate 60-cd34');
  });

  it('neither source ⇒ no chip at all, never a placeholder name', async () => {
    h.entries.value = [row({ mobile_id: null, device_label: null, output_text: 'anonymous row' })];
    const out = await html();
    expect(out).toContain('anonymous row');
    expect(out).not.toContain(S.tl_sender_tip);
  });
});

describe('TimelinePage — the search box and its empty states', () => {
  it('the search box is on the page, with the scope stated', async () => {
    const out = await html();
    expect(out).toContain(S.tl_search_ph);
    expect(out).toContain(S.tl_search_hint);
  });

  it('a search with no hits says "no match" (没有匹配) (and it is true — the rows are right here)', async () => {
    h.timelineQuery.value = '会议';
    const out = await html();
    expect(out).toContain(S.tl_search_none);
    expect(out).not.toContain(S.empty_timeline);
  });

  it('no search at all + no rows is the ordinary empty timeline', async () => {
    const out = await html();
    expect(out).toContain(S.empty_timeline);
    expect(out).not.toContain(S.tl_search_none);
  });

  it('the search copy follows a language switch (four locales are wired)', async () => {
    // Substrings, not the whole S value: an apostrophe in the en copy comes back as
    // `&#39;` from the SSR renderer, and asserting on the escape would be asserting on
    // the renderer rather than on the catalogue.
    const zh = await html();
    expect(zh).toContain('搜索这台电脑的时间线');
    setLocale('en');
    expect(await html()).toContain('timeline…');
    setLocale('ja');
    expect(await html()).toContain('タイムラインを検索');
    setLocale('ko');
    expect(await html()).toContain('타임라인 검색');
  });
});

// ── owner 2026-07-31: "where did the trimmed rows go" must have an answer stated out loud ──────────────────────
describe('TimelinePage — the bound and the write are stated out loud', () => {
  it('says nothing about retention while nothing has been evicted', async () => {
    // The reverse assertion, and it matters: claiming a cutoff that never happened
    // would be its own small lie, and it would appear on every fresh install.
    h.entries.value = [row()];
    h.timelineRetention.value = { kept: 1, cutoff: null, cutoffs: { text: null, images: null } };
    const out = await html();
    expect(out).not.toContain('只保留最近');
    expect(out).not.toContain('已从本机清除');
  });

  it('once rows HAVE been evicted, the page says how many are left and from when', async () => {
    h.entries.value = [row()];
    h.timelineRetention.value = { kept: 2000, cutoff: '2026-01-05T08:30:00.000Z', cutoffs: { text: '2026-01-05T08:30:00.000Z', images: '2026-01-05T08:30:00.000Z' } };
    const out = await html();
    // The exact sentence the catalogue composes — count and cutoff both present, so
    // the user can check it against their own memory.
    expect(out).toContain('2000');
    expect(out).toContain('已从本机清除');
  });

  it('a search with no hits on a TRIMMED store says so — "no match" alone would be half true', async () => {
    // The fourth empty state. The evicted rows were never in the search at all, so
    // "no matching entries" on its own is a statement about a range the user was not
    // told about.
    h.entries.value = [];
    h.timelineQuery.value = '会议';
    h.timelineRetention.value = { kept: 2000, cutoff: '2026-01-05T08:30:00.000Z', cutoffs: { text: '2026-01-05T08:30:00.000Z', images: '2026-01-05T08:30:00.000Z' } };
    const out = await html();
    expect(out).toContain('搜索范围只有本机保留的 2000 条');
    expect(out).toContain('已从本机清除');
    expect(out).not.toContain(S.empty_timeline);
  });

  it('the retention copy follows a language switch', async () => {
    h.entries.value = [row()];
    h.timelineRetention.value = { kept: 7, cutoff: '2026-01-05T08:30:00.000Z', cutoffs: { text: '2026-01-05T08:30:00.000Z', images: '2026-01-05T08:30:00.000Z' } };
    setLocale('en');
    expect(await html()).toContain('This PC keeps only the most recent entries');
    setLocale('ja');
    expect(await html()).toContain('最近の記録だけを保存しています');
    setLocale('ko');
    expect(await html()).toContain('최근 기록만 보관합니다');
    // …and the catalogue really is the source of those sentences.
    setLocale('zh-CN');
    expect(TL_RETENTION_MSG.keptNote(7, 'X')).toContain('7');
  });

  it('a refused local write is stated — the rows below are memory-only', async () => {
    h.entries.value = [row()];
    h.timelineStorageFailed.value = true;
    expect(await html()).toContain(S.tl_store_write_failed);
  });

  it('…and is NOT stated when the write landed', async () => {
    h.entries.value = [row()];
    expect(await html()).not.toContain(S.tl_store_write_failed);
  });
});

// ── owner 2026-08-01 §4-2 ⑧: per-row word count ─────────────────────────────────────────
describe('TimelinePage — per-row word count (owner §4-2 ⑧, defined as each mode\'s final result)', () => {
  it('shows the word count computed from output_text (the FINAL result, not source_text)', async () => {
    h.entries.value = [
      row({
        output_text: 'hello world',
        source_text: 'a completely different original that must NOT be counted',
      }),
    ];
    const out = await html();
    expect(out).toContain('2 字');
  });

  // 🔴 Reverse control (verified manually during the window C-4 delivery, not
  // kept as a permanent assertion): change wordCountOf to read e.source_text
  // instead of e.output_text → the assertion above goes red (it counts the
  // words of the longer original instead). See the "reverse control" section
  // of the delivery report for the original red-text record.

  it('an image row shows NO word-count element (its output_text is a system descriptor, not speech)', async () => {
    h.entries.value = [
      row({ entry_type: 'image', output_text: '图片描述文字这里也不算', thumb_b64: 'AA==' }),
    ];
    const out = await html();
    // Asserting on the ELEMENT, not a raw substring: this file's own template
    // comment above the v-if literally contains the characters "0 字" (the
    // Chinese word count unit) as part of a note reading "must not draw '0 字'",
    // so a bare `.not.toContain('0 字')` would trip on the comment itself, not
    // on rendered content — the SSR renderer emits template comments verbatim.
    // `class="wc-chip"` only exists when the v-if actually rendered.
    expect(out).not.toContain('class="wc-chip"');
  });

  it('an empty transcript renders NO word-count element — never a rendered "0"', async () => {
    h.entries.value = [row({ output_text: '' })];
    expect(await html()).not.toContain('class="wc-chip"');
  });

  it('the word-count copy follows a language switch', async () => {
    h.entries.value = [row({ output_text: 'hello world' })];
    expect(await html()).toContain('2 字');
    setLocale('en');
    expect(await html()).toContain('2 words');
    setLocale('ja');
    expect(await html()).toContain('2文字');
    setLocale('ko');
    expect(await html()).toContain('2자');
    setLocale('zh-CN');
  });
});
