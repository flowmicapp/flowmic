import { describe, expect, it } from 'vitest';
import type { KvStore } from './types';
import {
  anchorToCaret,
  CAPSULE_CARET_GAP,
  CAPSULE_POS_KEY,
  CAPSULE_TOP_MARGIN,
  clampToWork,
  clearPos,
  defaultTopCenter,
  loadPos,
  savePos,
  shouldPersistDrag,
} from './capsule-position';

/** In-memory KvStore (the transports' test seam). */
function memKv(seed?: Record<string, string>): KvStore {
  const m = new Map<string, string>(Object.entries(seed ?? {}));
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
}

describe('capsule-position — first-surface default + drag persistence (C3)', () => {
  it('defaultTopCenter centers horizontally with the top margin', () => {
    expect(defaultTopCenter(1920, 560)).toEqual({ x: 680, y: CAPSULE_TOP_MARGIN });
  });

  it('defaultTopCenter clamps x to 0 on a screen narrower than the capsule', () => {
    expect(defaultTopCenter(400, 560)).toEqual({ x: 0, y: CAPSULE_TOP_MARGIN });
  });

  it('savePos → loadPos round-trips (logical px, rounded)', () => {
    const kv = memKv();
    savePos(kv, { x: 123.6, y: 40.2 });
    expect(loadPos(kv)).toEqual({ x: 124, y: 40 });
  });

  it('loadPos returns null when absent or malformed (→ caller uses top-center)', () => {
    expect(loadPos(memKv())).toBeNull();
    expect(loadPos(memKv({ [CAPSULE_POS_KEY]: 'not json' }))).toBeNull();
    expect(loadPos(memKv({ [CAPSULE_POS_KEY]: '{"x":1}' }))).toBeNull();
    expect(loadPos(memKv({ [CAPSULE_POS_KEY]: '{"x":"a","y":2}' }))).toBeNull();
  });

  it('clearPos drops a persisted drag so the next surface re-anchors (T-7 prefs)', () => {
    const kv = memKv();
    savePos(kv, { x: 10, y: 20 });
    expect(loadPos(kv)).toEqual({ x: 10, y: 20 });
    clearPos(kv);
    expect(loadPos(kv)).toBeNull();
  });

});

describe('anchorToCaret — caret anchoring (锚定) placement math (R6 T-1, owner ruling D1)', () => {
  // A 1920×1080 primary with a 40px taskbar; capsule reserves its tallest ambient
  // form (560×200) so a later grow-to-speaking can never reach the caret.
  const WORK = { x: 0, y: 0, width: 1920, height: 1040 };
  const SIZE = { width: 560, height: 200 };
  const caret = (x: number, y: number) => ({ x, y, width: 2, height: 20 });

  it('places the capsule BELOW the caret with the gap, centred on the caret', () => {
    // caret centre 501 → x = 501 − 280 = 221; y = (300+20) + 12 = 332
    expect(anchorToCaret(caret(500, 300), WORK, SIZE)).toEqual({ x: 221, y: 332 });
  });

  it('honours a custom gap below the caret', () => {
    expect(anchorToCaret(caret(500, 300), WORK, SIZE, 30).y).toBe(350);
    expect(CAPSULE_CARET_GAP).toBe(12);
  });

  it('FLIPS above when the capsule would not fit below (never obscure the caret)', () => {
    // caret bottom 920 → below = 932, 932+200 = 1132 > 1040 ⇒ flip: 900−12−200 = 688
    const pos = anchorToCaret(caret(500, 900), WORK, SIZE);
    expect(pos.y).toBe(688);
    expect(pos.y + SIZE.height).toBeLessThanOrEqual(900); // bottom edge above the caret top
  });

  it('clamps to the left edge when the caret sits near x = 0', () => {
    expect(anchorToCaret(caret(10, 300), WORK, SIZE).x).toBe(0);
  });

  it('clamps to the right edge when the caret sits near the screen edge', () => {
    // 1920 − 560 = 1360 is the right-most legal x
    expect(anchorToCaret(caret(1910, 300), WORK, SIZE).x).toBe(1360);
  });

  it('anchors within the SECONDARY monitor work area (negative coordinates)', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1040 };
    // caret centre −999 → x = −1279 (inside [−1920, −560]); below-placement holds
    expect(anchorToCaret(caret(-1000, 300), left, SIZE)).toEqual({ x: -1279, y: 332 });
    // and the clamp uses THAT monitor's bounds, not the primary's
    expect(anchorToCaret(caret(-1915, 300), left, SIZE).x).toBe(-1920);
    expect(anchorToCaret(caret(-10, 300), left, SIZE).x).toBe(-560);
  });

  it('flips above on a secondary monitor whose work area starts below y = 0', () => {
    const lower = { x: 1920, y: 200, width: 1280, height: 800 }; // rcWork y 200..1000
    // caret bottom 900 → below 912, 912+200 = 1112 > 1000 ⇒ flip to 880−12−200 = 668
    expect(anchorToCaret({ x: 2000, y: 880, width: 2, height: 20 }, lower, SIZE).y).toBe(668);
  });

  it('never leaves the work area when NEITHER side fits (degenerate short screen)', () => {
    const tiny = { x: 0, y: 0, width: 1920, height: 260 };
    const pos = anchorToCaret(caret(500, 120), tiny, SIZE);
    expect(pos.y).toBeGreaterThanOrEqual(tiny.y);
    expect(pos.y + SIZE.height).toBeLessThanOrEqual(tiny.y + tiny.height);
  });

  it('pins to the work-area origin when the capsule is wider than the screen', () => {
    const narrow = { x: 0, y: 0, width: 400, height: 1040 };
    expect(anchorToCaret(caret(200, 300), narrow, SIZE).x).toBe(0);
  });
});

// ── REQ-12-15 (2026-08-12): what the frontend still decides about a drag ─────
// The drag itself is the OS's move loop now — there is no delta arithmetic left
// to test, because there is no delta. What remains is a single question with a
// real consequence: may we write a persisted position? A persisted position
// WINS FOREVER over caret anchoring (owner 裁定 D1), so answering "yes" to a
// mere click would silently switch off first-surface anchoring for good.
//
// This also replaces the old ~3px pointer threshold as the click/drag test.
// That threshold GUESSED from pointer jitter; this reads the window's actual
// position back from the OS, so「it did not move」is a fact, not a tolerance.
describe('shouldPersistDrag (native drag → may we persist?)', () => {
  it('a press that never moved the window persists nothing', () => {
    expect(shouldPersistDrag({ x: 680, y: 12 }, { x: 680, y: 12 })).toBe(false);
  });

  it('a real drag persists', () => {
    expect(shouldPersistDrag({ x: 680, y: 12 }, { x: 681, y: 12 })).toBe(true);
    expect(shouldPersistDrag({ x: 680, y: 12 }, { x: 680, y: 400 })).toBe(true);
  });

  it('sub-pixel jitter that savePos could not even store does not count as a move', () => {
    // savePos rounds to whole logical px, so a difference this small would write
    // the SAME bytes back — persisting on it would be a no-op that nonetheless
    // creates a persisted position and disables caret anchoring forever.
    expect(shouldPersistDrag({ x: 680.1, y: 12.2 }, { x: 680.4, y: 11.9 })).toBe(false);
  });

  it('a fractional move that DOES cross a pixel boundary counts', () => {
    expect(shouldPersistDrag({ x: 680.4, y: 12 }, { x: 680.6, y: 12 })).toBe(true);
  });
});

describe('clampToWork (stale persisted position)', () => {
  const SIZE = { width: 560, height: 200 };
  const work = { x: 0, y: 0, width: 2560, height: 1400 };

  it('leaves a position that is already inside untouched', () => {
    expect(clampToWork({ x: 100, y: 100 }, work, SIZE)).toEqual({ x: 100, y: 100 });
  });

  it('rescues the exact off-screen point measured on the real machine', () => {
    const rescued = clampToWork({ x: 1678, y: 1919 }, work, SIZE);
    expect(rescued.y).toBeLessThanOrEqual(work.height - SIZE.height);
    expect(rescued.y).toBeGreaterThanOrEqual(work.y);
  });

  it('pins to the work origin when the capsule cannot fit at all', () => {
    const tiny = { x: 0, y: 0, width: 100, height: 100 };
    expect(clampToWork({ x: 9999, y: 9999 }, tiny, SIZE)).toEqual({ x: 0, y: 0 });
  });
});
