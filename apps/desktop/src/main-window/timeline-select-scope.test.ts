// E8 (2026-09-02) — multi-select must be keyed to the FILTERED list, not the
// full entry list.
//
// `selectedInOrder`'s own doc (batch-copy.ts) already says its first argument
// "is the list the page renders" — TimelinePage.vue's `selectedRows` computed
// passed `entries.value` (the FULL, unfiltered list) instead. `toggleOne` only
// ever adds a key while its row is visible under `v-for="e in filtered"`, but
// nothing removes a key when a later filter-chip change hides that row again —
// `selectedKeys` keeps it, and resolving against `entries` (rather than
// `filtered`) meant a hidden row's key still counted toward the selection bar
// and still got copied by "Copy selected," even though every visible control
// (the chip strip, the checkboxes, the row list itself) agreed that row was
// off-screen.
//
// WHY A SOURCE-SCAN TEST. TimelinePage.vue has no dedicated render/interaction
// test anywhere in this repo (grep confirms it), and this package has neither
// `@vue/test-utils` nor a jsdom environment configured (`node` only) — there is
// no harness in this codebase for mounting a live component and driving
// select-then-refilter interactions. `selectedInOrder` itself is already fully
// unit-tested in isolation (batch-copy.test.ts): given the right `displayed`
// list, it filters correctly. The uncovered fact was never that function — it
// was which list TimelinePage.vue's ONE call site hands it, and that is
// exactly what this file pins, the same way settings-scope-note.test.ts pins
// settings_route.rs's key split and inject-evidence-face.test.ts pins several
// dozen other source-level facts in this same package.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('E8 — TimelinePage.vue keys the selection to the filtered list', () => {
  it('selectedRows resolves selectedInOrder against `filtered`, not `entries`', () => {
    const page = src('./TimelinePage.vue');
    const selectedRowsDecl = page.slice(
      page.indexOf('const selectedRows = computed'),
      page.indexOf(');', page.indexOf('const selectedRows = computed')) + 2,
    );
    expect(selectedRowsDecl).toContain('selectedInOrder(filtered.value, selectedKeys.value, rowKey)');
    // REVERSE-CONTROL SHAPE: the pre-fix line read
    // `selectedInOrder(entries.value, selectedKeys.value, rowKey)` — this is
    // the exact string that must NOT be present any more.
    expect(selectedRowsDecl).not.toContain('selectedInOrder(entries.value');
  });

  it('selectAll already used the filtered view — the two selection entry points must agree', () => {
    // If selectAll and selectedRows read two different lists, "select all" can
    // select rows that "the selection" then refuses to count or copy — the
    // exact shape of the bug one level over. Pinning both keeps them coupled.
    const page = src('./TimelinePage.vue');
    expect(page).toContain('selectedKeys.value = new Set(filtered.value.map(rowKey))');
  });
});
