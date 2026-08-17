// The one guard that makes a second copy of the System Settings path safe.
//
// `perm_ax_pane` (the standing instruction in the notice) and the capsule's
// `INJECT_NO_ACCESSIBILITY` reason line (the flash after a failed utterance)
// both spell out the same macOS menu path, in nine languages. That is two
// copies of one fact — normally the exact defect this repo is loudest about —
// and the reason it is allowed is written at the top of ./permission.ts. This
// file is what makes the permission conditional: they cannot drift apart
// without something going red.
//
// 🔴 The assertion is `includes`, not equality, and that direction is chosen:
// the reason line is 「<what is wrong> · <where to fix it>」 and only its second
// half is the path. Asserting equality would force the two sentences to be one
// sentence, which is what we deliberately did not do.
//
// ⚠️ It also pins something a translator would otherwise be right to change:
// the path uses macOS's OWN wording per language, because the reader is hunting
// for those exact words on their own screen. A better-sounding translation that
// does not match the menu is worse than no translation — and it would land here.

import { describe, expect, it } from 'vitest';
import { UI_LOCALES } from './generated/locales.g';
import { INJECT_FAIL_REASON_CATALOGUES } from './capsule';
import { PERMISSION_STRINGS } from './permission';

describe('the Accessibility menu path exists once, in two sentences', () => {
  it.each([...UI_LOCALES])('%s: the notice path occurs verbatim in the capsule reason', (loc) => {
    const pane = PERMISSION_STRINGS[loc].perm_ax_pane;
    const reason = INJECT_FAIL_REASON_CATALOGUES[loc].INJECT_NO_ACCESSIBILITY;

    expect(pane.length, `${loc}: the path must not be empty`).toBeGreaterThan(0);
    expect(reason, `${loc}: the capsule must have a reason line for this code`).toBeTruthy();
    expect(
      reason!.includes(pane),
      `${loc}: the notice says "${pane}" but the capsule reason is "${reason}" — ` +
        'one of the two was changed without the other',
    ).toBe(true);
  });

  // Not decoration: a path with no separator would be a translation that
  // flattened the menu into prose, which is precisely the form the reader
  // cannot match against their own screen.
  it.each([...UI_LOCALES])('%s: the path is still a path', (loc) => {
    expect(PERMISSION_STRINGS[loc].perm_ax_pane).toContain('▸');
  });
});

describe('the notice never renders an empty string', () => {
  // shardCatalogue throws on a missing key, so this is about a key that EXISTS
  // and is blank — which the generator would happily emit and no type would
  // catch. A blank title renders an empty banner: visible, meaningless.
  it.each([...UI_LOCALES])('%s: every permission string has content', (loc) => {
    for (const [key, value] of Object.entries(PERMISSION_STRINGS[loc])) {
      expect(value.trim().length, `${loc}.${key} is blank`).toBeGreaterThan(0);
    }
  });
});
