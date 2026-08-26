// V2-19 — capsule strip per-row copy (owner 2026-08-01 §4b-7). Pure-logic specs
// for capsule-copy.ts; the SFC wiring (button, icon swap, forensic line) is
// asserted separately in recent.test.ts by reading CapsuleApp.vue literally —
// same two-layer technique as batch-copy.ts/TimelinePage.vue and MODE_BADGE/
// recent.test.ts.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canCopyLine, copyPayload, rowHasPicture } from './capsule-copy';

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

describe('canCopyLine: is there anything on this row worth taking', () => {
  const txt = (text: string) => ({ text, entryType: 'transcript' as const, fullImage: false, thumb: null });
  const pic = (o: { text?: string; fullImage?: boolean; thumb?: string | null } = {}) => ({
    text: o.text ?? '🖼 JPEG · 273 KB',
    entryType: 'image' as const,
    fullImage: o.fullImage ?? true,
    thumb: o.thumb ?? null,
  });

  it('a row with rendered text is copyable', () => {
    expect(canCopyLine(txt('你好'))).toBe(true);
  });

  it('whitespace-only text is not something to copy', () => {
    expect(canCopyLine(txt('   '))).toBe(false);
    expect(canCopyLine(txt(String.fromCharCode(10, 9)))).toBe(false);
  });

  /** 🔴 owner 2026-08-26, on 0.3.35: a picture row must have the SAME two
   *  controls every other row has, and the copy button must copy the PICTURE.
   *  「没必要就为图片这一行再增加一个特别的一个操作」.
   *
   *  Two previous rounds got this wrong in opposite directions and for the same
   *  underlying reason — both treated a picture row as a text row with an awkward
   *  string in it. First it copied the size label; then the button was hidden
   *  altogether, which took the action away instead of pointing it at the right
   *  payload. */
  it('🔴 a picture row is copyable BECAUSE OF THE PICTURE, label or no label', () => {
    expect(canCopyLine(pic()), 'the generated size label must not decide this').toBe(true);
    expect(canCopyLine(pic({ text: '' })), 'an uncaptioned picture is still a picture').toBe(true);
    expect(canCopyLine(pic({ text: '会议白板照片' })), 'a captioned picture too').toBe(true);
  });

  it('a picture row whose bytes are gone is not copyable', () => {
    // The honest negative: no original on disk and no preview means there is
    // nothing to put on the clipboard, and a button that always fails is a
    // façade (R8). The label alone must not resurrect it.
    expect(canCopyLine(pic({ fullImage: false, thumb: null }))).toBe(false);
  });

  it('rowHasPicture is what routes the click, and it only answers that', () => {
    // CapsuleApp.copyLine reads THIS to decide picture-vs-text. A transcript
    // that happens to carry a preview is still text (reverse control).
    expect(rowHasPicture(pic({ fullImage: true, thumb: null }))).toBe(true);
    expect(rowHasPicture(pic({ fullImage: false, thumb: 'AAA' }))).toBe(true);
    expect(rowHasPicture({ entryType: 'transcript', fullImage: true, thumb: 'AAA' })).toBe(false);
  });
});

describe('the capsule row has TWO controls, not three', () => {
  it('🔴 exactly one copy button is rendered, and it calls copyLine', () => {
    // The defect this pins is not a wrong value — it is a wrong NUMBER OF
    // BUTTONS, which no assertion about either button could ever see. Every
    // test on this file passed while a picture row carried three verbs.
    const sfc = readFileSync(fileURLToPath(new URL('./CapsuleApp.vue', import.meta.url)), 'utf8');
    expect(sfc.split('@click="copyLine(l)"').length - 1).toBe(1);
    expect(sfc, 'the picture-only copy button is gone').not.toContain('copyImageLine');
    expect(sfc, 'and so is its class').not.toContain('rcopy-img');
    // …while the re-inject button stays: owner kept the pair deliberately.
    expect(sfc.split('@click="reinjectLine(l)"').length - 1).toBe(1);
  });
});
