import { describe, expect, it } from 'vitest';
import { CAPSULE_HEIGHT, CapsuleMorph, windowHeightFor } from './capsule-morph';

describe('CapsuleMorph — four forms (形态四态) (07 §4) + sizes (07 §1)', () => {
  it('speaking → just_injected (800ms) → idle_with_history → idle', () => {
    const m = new CapsuleMorph();
    m.setHistoryCount(3);
    expect(m.state(0)).toBe('idle_with_history');

    m.onSpeakingStart();
    expect(m.state(1000)).toBe('speaking');
    expect(m.windowHeight(1000)).toBe(windowHeightFor(CAPSULE_HEIGHT.speaking));

    m.onInjected(1000);
    expect(m.state(1100)).toBe('just_injected'); // inside the 800ms window
    expect(m.windowHeight(1100)).toBe(windowHeightFor(CAPSULE_HEIGHT.just_injected));
    expect(m.clickThrough(1100)).toBe(true); // click-through ONLY here

    expect(m.state(1900)).toBe('idle_with_history'); // window elapsed, has history
    expect(m.clickThrough(1900)).toBe(false);
    expect(m.windowHeight(1900)).toBe(windowHeightFor(CAPSULE_HEIGHT.idle_with_history));
  });

  it('idle when no recent history, and with_drawer overrides height', () => {
    const m = new CapsuleMorph();
    m.setHistoryCount(0);
    expect(m.state(0)).toBe('idle');
    expect(m.windowHeight(0)).toBe(windowHeightFor(CAPSULE_HEIGHT.idle));

    m.drawerOpen = true;
    expect(m.windowHeight(0)).toBe(windowHeightFor(CAPSULE_HEIGHT.with_drawer));
    expect(m.clickThrough(0)).toBe(false); // never click-through with the drawer open
  });

  it('speaking that ends with no injection falls back to idle*, not stuck speaking', () => {
    const m = new CapsuleMorph();
    m.onSpeakingStart();
    m.onSpeakingEnd();
    expect(m.state(0)).toBe('idle');
  });

  it('R6-R1: a non-injected result opens the 1.5s inject_failed flash (never green)', () => {
    const m = new CapsuleMorph();
    m.onSpeakingStart();
    m.onInjectFailed(1000);
    expect(m.state(1000)).toBe('inject_failed');
    expect(m.state(2499)).toBe('inject_failed'); // inside the 1500ms window
    expect(m.windowHeight(1200)).toBe(windowHeightFor(CAPSULE_HEIGHT.inject_failed));
    expect(m.clickThrough(1200)).toBe(false); // failure is NOT click-through
    expect(m.state(2501)).toBe('idle'); // window elapsed
  });

  it('R6-R1: onInjected and onInjectFailed are mutually exclusive', () => {
    const m = new CapsuleMorph();
    // A green flash then a failure flash → the failure wins its own window.
    m.onInjected(0);
    m.onInjectFailed(100);
    expect(m.state(200)).toBe('inject_failed');
    // …and the reverse: an ok result clears a pending failure flash.
    const m2 = new CapsuleMorph();
    m2.onInjectFailed(0);
    m2.onInjected(100);
    expect(m2.state(200)).toBe('just_injected');
  });
});
