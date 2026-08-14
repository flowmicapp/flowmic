// V2-18 — batch copy plan / hints / result message. The card's acceptance core:
// ① 3 text + 2 image selected → the clipboard payload is exactly those 3 texts
//   in display order, no placeholder lines;
// ② the result message carries BOTH numbers — "Copied 3 items" AND "skipped 2 items";
// ③ an all-pictures selection gets "no copyable text", never "Copied 0 items";
// ④ the toolbar hint exists BEFORE the button is pressed whenever a picture is
//   in the selection (and is absent when none is).
// The DOM clipboard write stays in the .vue (store.textOf precedent: "the DOM
// write is the view's job"); `plan.text` is exactly what gets written.

import { beforeEach, describe, it, expect } from 'vitest';
import { setLocale } from '../lib/strings';

beforeEach(() => {
  setLocale('zh-CN');
});
import {
  isImageRow,
  planBatchCopy,
  preCopyHint,
  resultMessage,
  selectedInOrder,
  type BatchRow,
} from './batch-copy';

// Default `created_at` is a strictly increasing timestamp, one tick per call, so
// every test written before planBatchCopy sorted internally — which built its
// literal array in "the order I want it to come out" — keeps meaning exactly that,
// with zero timestamps to spell out by hand. Tests that care about sort order pass
// `created_at` explicitly (see the ⑤⑥⑦ tests below) instead of relying on this.
const ROW_BASE_MS = Date.parse('2026-08-01T00:00:00.000Z');
let rowSeq = 0;

function row(
  id: string,
  output_text: string,
  entry_type: 'transcript' | 'image' = 'transcript',
  created_at?: string,
): BatchRow {
  rowSeq += 1;
  return {
    id,
    output_text,
    entry_type,
    created_at: created_at ?? new Date(ROW_BASE_MS + rowSeq * 1000).toISOString(),
  };
}

describe('V2-18 batch copy', () => {
  it('① 3 text + 2 image selected → payload is exactly the 3 texts, display order, zero placeholders', () => {
    const displayed = [
      row('a', '第一条'),
      row('b', '🖼 PNG · 12 KB', 'image'),
      row('c', '翻译后的结果'), // a translate row: the PROCESSED text, as displayed
      row('d', '🖼 PNG · 34 KB', 'image'),
      row('e', '第三条'),
    ];
    const plan = planBatchCopy(displayed);
    expect(plan.text).toBe('第一条\n翻译后的结果\n第三条');
    expect(plan.copied).toBe(3);
    expect(plan.skippedImages).toBe(2);
    expect(plan.selected).toBe(5);
    expect(plan.text).not.toContain('🖼');
  });

  it('② result message carries BOTH numbers: 已复制 3 条 and 跳过 2 条', () => {
    const plan = planBatchCopy([
      row('a', 'x'),
      row('b', 'p', 'image'),
      row('c', 'y'),
      row('d', 'q', 'image'),
      row('e', 'z'),
    ]);
    const msg = resultMessage(plan);
    expect(msg).toContain('已复制 3 条');
    expect(msg).toContain('跳过 2 条');
    expect(msg).toContain('图片');
  });

  it('②b picture-free selection → plain 已复制 N 条, no 跳过', () => {
    const msg = resultMessage(planBatchCopy([row('a', 'x'), row('b', 'y')]));
    expect(msg).toBe('已复制 2 条');
    expect(msg).not.toContain('跳过');
  });

  it('③ all-pictures selection → 没有可复制的文本, never 已复制 0 条', () => {
    const plan = planBatchCopy([row('a', '🖼 PNG', 'image'), row('b', '🖼 PNG', 'image')]);
    expect(plan.copied).toBe(0);
    const msg = resultMessage(plan);
    expect(msg).toContain('没有可复制的文本');
    expect(msg).toContain('2 条都是图片');
    expect(msg).not.toContain('已复制');
  });

  it('④ toolbar hint is present BEFORE copying whenever a picture is selected, null otherwise', () => {
    const hint = preCopyHint([row('a', 'x'), row('b', 'p', 'image'), row('c', 'q', 'image')]);
    expect(hint).not.toBeNull();
    expect(hint).toContain('选中的 3 条里有 2 条是图片');
    expect(hint).toContain('复制时会跳过');
    expect(preCopyHint([row('a', 'x'), row('b', 'y')])).toBeNull();
    expect(preCopyHint([])).toBeNull();
  });

  // owner 2026-08-01, docs/strategy/2026-08-01-data-asset-lifecycle-design.md §4b-6:
  // concatenation order is chronological ascending, regardless of the order the user
  // checked things in. These three pin that ruling in
  // planBatchCopy itself (not in the caller), including the tie-break answer.

  it('⑤ 完全逆序 / 打乱传入 → 输出恒为时间升序（不依赖调用方传入的顺序）', () => {
    const early = row('a', '最早说的', 'transcript', '2026-08-01T09:00:00.000Z');
    const mid = row('b', '中间说的', 'transcript', '2026-08-01T09:05:00.000Z');
    const late = row('c', '最后说的', 'transcript', '2026-08-01T09:10:00.000Z');

    // fully reversed: the latest one sorted to the front
    expect(planBatchCopy([late, mid, early]).text).toBe('最早说的\n中间说的\n最后说的');
    // shuffled
    expect(planBatchCopy([mid, early, late]).text).toBe('最早说的\n中间说的\n最后说的');
    // already ascending, stays ascending (not coincidentally "looks unsorted")
    expect(planBatchCopy([early, mid, late]).text).toBe('最早说的\n中间说的\n最后说的');
  });

  it('⑥ 排序不改变图片整条跳过：skippedImages / copied 计数与②③一致', () => {
    const rows = [
      row('c', '第三条', 'transcript', '2026-08-01T09:10:00.000Z'),
      row('b', '🖼 图片1', 'image', '2026-08-01T09:05:00.000Z'),
      row('a', '第一条', 'transcript', '2026-08-01T09:00:00.000Z'),
      row('d', '🖼 图片2', 'image', '2026-08-01T09:15:00.000Z'),
    ];
    const plan = planBatchCopy(rows);
    expect(plan.text).toBe('第一条\n第三条');
    expect(plan.copied).toBe(2);
    expect(plan.skippedImages).toBe(2);
    expect(plan.selected).toBe(4);
  });

  it('⑦ 时间戳并列（相等）→ 顺序确定：稳定排序保留传入顺序，唯一无需臆造第二排序键的答案', () => {
    const tie = '2026-08-01T09:00:00.000Z';
    const first = row('x', '先传入的', 'transcript', tie);
    const second = row('y', '后传入的', 'transcript', tie);
    // input order first, second → the tie preserves this order
    expect(planBatchCopy([first, second]).text).toBe('先传入的\n后传入的');
    // input order reversed, second, first → the tie reverses too (proving it is
    // "stable", not a coincidental hit)
    expect(planBatchCopy([second, first]).text).toBe('后传入的\n先传入的');
  });

  it('selectedInOrder keeps display order, drops unselected and dead ids', () => {
    const displayed = [row('a', '1'), row('b', '2'), row('c', '3'), row('d', '4')];
    const picked = selectedInOrder(displayed, new Set(['d', 'a', 'ghost']));
    expect(picked.map((r) => r.id)).toEqual(['a', 'd']);
  });

  it('isImageRow keys on entry_type, not on any thumbnail field', () => {
    expect(isImageRow(row('a', 'x', 'image'))).toBe(true);
    expect(isImageRow(row('b', 'x'))).toBe(false);
  });
});
