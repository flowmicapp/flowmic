import { describe, expect, it } from 'vitest';
import {
  asAccessibilityStatus,
  needsAccessibilityGrant,
  type AccessibilityStatus,
} from './accessibility-notice';

describe('accessibility notice — who is entitled to warn', () => {
  it('warns exactly when the platform HAS the permission and it is not granted', () => {
    expect(needsAccessibilityGrant({ supported: true, trusted: false })).toBe(true);
    expect(needsAccessibilityGrant({ supported: true, trusted: true })).toBe(false);
  });

  // The failure this pins is a real one and it is not hypothetical: the Rust
  // side reports `trusted: true` on platforms without the permission precisely
  // so a caller that forgets `supported` cannot warn — this asserts the JS half
  // does not undo that by reading the fields the other way round.
  it('never warns on a platform that has no such permission', () => {
    expect(needsAccessibilityGrant({ supported: false, trusted: true })).toBe(false);
    // Even if something upstream were to send the impossible pair, the answer
    // is still no: `supported` decides whether the question exists at all.
    expect(needsAccessibilityGrant({ supported: false, trusted: false })).toBe(false);
  });

  it('renders nothing when we could not ask — "unknown" is not "broken"', () => {
    expect(needsAccessibilityGrant(null)).toBe(false);
  });
});

describe('accessibility notice — the shape is checked, not asserted', () => {
  it('accepts the shape the command really returns', () => {
    const ok: AccessibilityStatus | null = asAccessibilityStatus({ supported: true, trusted: false });
    expect(ok).toEqual({ supported: true, trusted: false });
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
