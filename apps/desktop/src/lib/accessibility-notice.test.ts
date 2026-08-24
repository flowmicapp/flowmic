import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  asAccessibilityStatus,
  isBlockedByLocation,
  needsAccessibilityGrant,
  type AccessibilityStatus,
} from './accessibility-notice';

describe('accessibility notice — who is entitled to warn', () => {
  it('warns exactly when the platform HAS the permission and it is not granted', () => {
    expect(needsAccessibilityGrant({ supported: true, trusted: false, translocated: false })).toBe(true);
    expect(needsAccessibilityGrant({ supported: true, trusted: true, translocated: false })).toBe(false);
  });

  // The failure this pins is a real one and it is not hypothetical: the Rust
  // side reports `trusted: true` on platforms without the permission precisely
  // so a caller that forgets `supported` cannot warn — this asserts the JS half
  // does not undo that by reading the fields the other way round.
  it('never warns on a platform that has no such permission', () => {
    expect(needsAccessibilityGrant({ supported: false, trusted: true, translocated: false })).toBe(false);
    // Even if something upstream were to send the impossible pair, the answer
    // is still no: `supported` decides whether the question exists at all.
    expect(needsAccessibilityGrant({ supported: false, trusted: false, translocated: false })).toBe(false);
  });

  it('renders nothing when we could not ask — "unknown" is not "broken"', () => {
    expect(needsAccessibilityGrant(null)).toBe(false);
  });
});

describe('accessibility notice — the shape is checked, not asserted', () => {
  it('accepts the shape the command really returns', () => {
    const ok: AccessibilityStatus | null = asAccessibilityStatus({ supported: true, trusted: false, translocated: false });
    expect(ok).toEqual({ supported: true, trusted: false, translocated: false });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'trusted'],
    ['a number', 1],
    ['an empty object', {}],
    ['a missing field', { supported: true }],
    // 🔴 The one that matters. A Rust rename, a serde attribute, or a command
    // that starts answering with strings would land here — and the whole point
    // of returning null is that it renders NOTHING rather than a macOS
    // permission banner on a machine that has no such permission.
    ['stringly-typed booleans', { supported: 'true', trusted: 'false' }],
  ])('refuses %s', (_label, input) => {
    expect(asAccessibilityStatus(input)).toBeNull();
    expect(needsAccessibilityGrant(asAccessibilityStatus(input))).toBe(false);
  });
});

describe('the location blocker — same reading, opposite instruction', () => {
  const st = (o: Partial<AccessibilityStatus> = {}): AccessibilityStatus => ({
    supported: true,
    trusted: false,
    translocated: false,
    ...o,
  });

  it('🔴 an ungranted permission and an unreachable one are NOT the same answer', () => {
    // Both are `trusted: false`. Only the second one means「去设置里点开关」is
    // advice that cannot succeed, which is the whole defect this pair fixes.
    expect(needsAccessibilityGrant(st())).toBe(true);
    expect(isBlockedByLocation(st())).toBe(false);

    expect(needsAccessibilityGrant(st({ translocated: true }))).toBe(true);
    expect(isBlockedByLocation(st({ translocated: true }))).toBe(true);
  });

  it('a granted permission is never reported as blocked, translocated or not', () => {
    // Belt and braces: if the app somehow IS trusted while translocated, there
    // is nothing to tell anyone. The notice must not appear to explain a
    // problem the reader does not have.
    expect(isBlockedByLocation(st({ trusted: true, translocated: true }))).toBe(false);
  });

  it('a platform without the permission is never blocked by its location', () => {
    expect(isBlockedByLocation(st({ supported: false, translocated: true }))).toBe(false);
  });

  it('「could not ask」 stays its own answer here too', () => {
    expect(isBlockedByLocation(null)).toBe(false);
  });
});

describe('narrowing the third field — the failure direction is not symmetric', () => {
  it('reads the flag when the Rust side sends it', () => {
    expect(asAccessibilityStatus({ supported: true, trusted: false, translocated: true }))
      .toEqual({ supported: true, trusted: false, translocated: true });
  });

  it('🔴 a missing or malformed flag DEGRADES to false — it never voids the notice', () => {
    // Rejecting the object would hide a real missing permission behind a blank
    // screen. Degrading yields exactly the copy we shipped before this field
    // existed. The two outcomes are not equally wrong, so the narrowing is not
    // as strict as it is for `supported` / `trusted` — which it still is:
    for (const bad of [undefined, null, 'yes', 1]) {
      const s = asAccessibilityStatus({ supported: true, trusted: false, translocated: bad });
      expect(s).not.toBeNull();
      expect(s!.translocated).toBe(false);
      expect(needsAccessibilityGrant(s)).toBe(true);
    }
    // Control: the two strict fields still void it, so the leniency above is
    // scoped to one field and is not this function going soft.
    expect(asAccessibilityStatus({ supported: 'yes', trusted: false })).toBeNull();
  });
});

describe('the component really branches — a rule nothing renders is a rule that does not exist', () => {
  const sfc = readFileSync(
    new URL('../main-window/components/AccessibilityNotice.vue', import.meta.url),
    'utf8',
  );

  it('the body and the instruction are both chosen by the blocker', () => {
    expect(sfc).toContain('isBlockedByLocation(status) ? S.perm_ax_move_body : S.perm_ax_body');
    expect(sfc).toContain('S.perm_ax_move_how');
  });

  it('🔴 the settings button is withheld when pressing it cannot help', () => {
    // The defect was never that we said nothing — it was that we offered an
    // action that could not work, so the reader did it three times.
    expect(sfc).toContain('v-if="!isBlockedByLocation(status)"');
  });

  it('the settings path is not left on screen next to 「move the app」', () => {
    const how = sfc.slice(sfc.indexOf('class="ax-how"'), sfc.indexOf('class="ax-actions"'));
    expect(how).toContain('v-if="isBlockedByLocation(status)"');
    expect(how).toContain('perm_ax_pane');
    // The path lives in the ELSE arm — i.e. it cannot render in the blocked case.
    expect(how.indexOf('v-else')).toBeLessThan(how.indexOf('perm_ax_pane'));
  });
});
