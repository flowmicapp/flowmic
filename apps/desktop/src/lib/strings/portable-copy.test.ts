// Pins the 2026-08-11 honesty fix: import report must not claim「只恢复了文字」
// ("only the text was restored") when thumbnails ride in the row (16 册
// §5.2「当初未导完整图」, "the full image wasn't exported in the first place").

import { describe, expect, it } from 'vitest';
import { PORTABLE_STRINGS } from './portable';
import { UI_LOCALES } from './locale';

describe('portable import copy — no false「只恢复了文字」', () => {
  // The four regexes below are the four languages that HAVE a way to say it; the
  // loop is over the registry (2026-08-14) so a language added later is covered
  // by the non-empty assertion at least, instead of leaving the guard silently
  // scoped to the four it was written for.
  it('pd_r_no_pictures never claims an only-text restore, in any shipped language', () => {
    for (const locale of UI_LOCALES) {
      const s = PORTABLE_STRINGS[locale].pd_r_no_pictures;
      expect(s.length).toBeGreaterThan(0);
      expect(s).not.toMatch(/只恢复了文字/);
      expect(s).not.toMatch(/only the text/i);
      expect(s).not.toMatch(/文字だけ/);
      expect(s).not.toMatch(/글자만/);
    }
  });
});
