// 🔴 T-7 (0.2.63, owner addendum #6) — 「原文栏什么时候出现」("when does the original-text row appear").
//
// This criterion previously had two copies (TimelinePage.vue / CapsuleApp.vue), and both used `mode`
// as a stand-in for 「有没有原文」("whether there is an original"), but after T-7 **a realtime row can
// also carry an original**: if organize/translate/polish was tapped on the card before manual delivery,
// that frame carries the pre-transform text along with it
// (apps/mobile/lib/src/session/delivery_source_text.dart). Under the old criterion, PC **received it,
// stored it, and never showed it** — the field arriving and the field being readable are two different things.
//
// Reverse control (actually run this round, the red output is copied into the test case below): revert
// `hasSourceLine` to 「mode 必须是 translate/organize」("mode must be translate/organize") ⇒ the
// 「realtime 行带原文」("a realtime row carries an original") case goes red immediately.

import { describe, expect, it } from 'vitest';
import { hasSourceLine } from './source-line';

describe('hasSourceLine', () => {
  it('🔴 a REALTIME row carrying an original offers it (the T-7 case)', () => {
    // The phone said a sentence in realtime mode, and tapped 「整理」("organize") before manual
    // delivery ⇒ the frame carries text=the organized sentence, source_text=the original. This slot
    // was false before T-7, and the field just sat on the row with nobody looking at it.
    expect(
      hasSourceLine({ source: '我说的原话', face: '整理后的话' }),
      // The reverse-control red output (when the mode half is added back in):
      //   AssertionError: expected false to be true // Object.is equality
    ).toBe(true);
  });

  it('translate / organize rows keep behaving exactly as before', () => {
    expect(hasSourceLine({ source: '我说的原话', face: 'the sentence' })).toBe(true);
  });

  it('no original ⇒ no 原文栏 (absent, null and empty all mean the same to a row)', () => {
    expect(hasSourceLine({ source: undefined, face: '一句话' })).toBe(false);
    expect(hasSourceLine({ source: null, face: '一句话' })).toBe(false);
    expect(hasSourceLine({ source: '', face: '一句话' })).toBe(false);
  });

  it('🔴 an original identical to the face is NOT an original', () => {
    // Expanding it would show the same sentence twice, while the label promises 「另一段」("a different passage").
    // The old criterion relied on realtime never carrying source_text to incidentally block this slot;
    // now it has to say so explicitly.
    expect(hasSourceLine({ source: '一模一样', face: '一模一样' })).toBe(false);
  });

  it('an empty face (the control-row shape) does not fabricate a source line', () => {
    // Remote-keypress row: `output_text` is an empty string, `source_text` is null (control_row.rs),
    // both fall into the branch above — this just pins it down as one concrete sample.
    expect(hasSourceLine({ source: null, face: '' })).toBe(false);
  });
});
