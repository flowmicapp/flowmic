// GA-20 — the fifth timeline chip. REDESIGN §5.2 lists five; four shipped, so
// image rows were visible under "All" but could never be isolated.
//
// The one rule worth pinning: 'image' selects on entry_type, and the MODE chips
// must not sweep image rows in on the mode value an image row still carries.

import { describe, expect, it } from 'vitest';
import { matchesFilter, type TimelineFilter } from './timeline-filter';

const transcript = (mode: string): { mode: string; entry_type: 'transcript' } => ({
  mode,
  entry_type: 'transcript',
});
const picture = (mode: string): { mode: string; entry_type: 'image' } => ({
  mode,
  entry_type: 'image',
});

describe('timeline filter chips', () => {
  it('all keeps everything', () => {
    for (const row of [transcript('realtime'), picture('translate')]) {
      expect(matchesFilter(row, 'all')).toBe(true);
    }
  });

  it('each mode chip keeps only that mode', () => {
    const modes: TimelineFilter[] = ['realtime', 'translate', 'organize'];
    for (const f of modes) {
      for (const m of modes) {
        expect(matchesFilter(transcript(m as string), f)).toBe(m === f);
      }
    }
  });

  it('the image chip selects on entry_type, whatever mode the row carries', () => {
    expect(matchesFilter(picture('realtime'), 'image')).toBe(true);
    expect(matchesFilter(picture('organize'), 'image')).toBe(true);
    expect(matchesFilter(transcript('realtime'), 'image')).toBe(false);
  });

  it('a mode chip never sweeps in a picture that happens to carry that mode', () => {
    // The regression this guards: an image sent while "Realtime" was active carries
    // mode:'realtime', so a naive `e.mode === f` would file it under "Realtime".
    expect(matchesFilter(picture('realtime'), 'realtime')).toBe(false);
    expect(matchesFilter(picture('translate'), 'translate')).toBe(false);
  });
});
