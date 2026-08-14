// V2-19 — capsule strip per-row copy (owner 2026-08-01 §4b-7). Pure-logic specs
// for capsule-copy.ts; the SFC wiring (button, icon swap, forensic line) is
// asserted separately in recent.test.ts by reading CapsuleApp.vue literally —
// same two-layer technique as batch-copy.ts/TimelinePage.vue and MODE_BADGE/
// recent.test.ts.

import { describe, expect, it } from 'vitest';
import { canCopyLine, copyPayload } from './capsule-copy';

describe('copyPayload: same source as the render, never re-derived', () => {
  it('returns exactly l.text — no reformatting, no extra fields appended', () => {
    expect(copyPayload({ text: '大家好' })).toBe('大家好');
  });

  it('is blind to every OTHER field on the line — changing them never changes the payload', () => {
    const base = { text: '同一句话' };
    // Two "lines" that differ in everything except `text` must copy identically —
    // if this ever failed it would mean the payload started reading a second
    // field (the "one value answers two questions" (一个值答两个问题) shape this repo hunts).
    const a = { ...base, mode: 'realtime', source: null, id: 'a' } as const;
    const b = { ...base, mode: 'translate', source: '原文', id: 'b' } as const;
    expect(copyPayload(a)).toBe(copyPayload(b));
    expect(copyPayload(a)).toBe('同一句话');
  });

  it('an empty rendered text copies as an empty string (canCopyLine is the gate, not this)', () => {
    expect(copyPayload({ text: '' })).toBe('');
  });
});

describe('canCopyLine: the R8 gate — omit rather than copy nothing', () => {
  it('a row with rendered text is copyable', () => {
    expect(canCopyLine({ text: '你好' })).toBe(true);
  });

  it('a row with NO rendered text (the un-captioned-image case) is not', () => {
    expect(canCopyLine({ text: '' })).toBe(false);
  });

  it('whitespace-only text does not count as something to copy', () => {
    expect(canCopyLine({ text: '   ' })).toBe(false);
    expect(canCopyLine({ text: '\n\t' })).toBe(false);
  });

  it('is NOT keyed on entryType — an image row with a caption is copyable exactly like a transcript row', () => {
    // Same shape both ways: only `text` decides. entryType is irrelevant to the
    // function (it is not even in the Pick<>), which is the point — image rows
    // are not a special case, they pass through the same emptiness gate.
    expect(canCopyLine({ text: '📷 图片说明' })).toBe(true);
  });
});
