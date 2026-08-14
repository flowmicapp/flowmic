// GA-20 — the timeline filter predicate. REDESIGN §5.2 lists FIVE chips; the
// implementation shipped four, so image rows (renderable since T-4) could be
// seen but never isolated.
//
// Kept out of the .vue so it is unit-testable and so the one non-obvious rule
// lives somewhere a reader will find it: 'image' selects on entry_type, not on
// mode. An image row still carries whatever mode was active when it was sent,
// so a mode chip that compared only `mode` would sweep pictures into "Realtime".

export type TimelineFilter = 'all' | 'realtime' | 'translate' | 'organize' | 'image';

// REQ-12-13 — a `'control'` row (a remote key press this PC executed) shows under
// "All" and under NO mode chip. Its `mode` is a structural filler (a keypress has no
// mode; docs/rebuild/15 §2.0-e), so a `entry_type !== 'image'` test would have swept
// every keypress into "Realtime" — the exact defect the header above records having fixed
// once already for pictures. The rule is written positively for that reason.
export function matchesFilter(
  e: { mode: string; entry_type: 'transcript' | 'image' | 'control' },
  f: TimelineFilter,
): boolean {
  if (f === 'all') return true;
  if (f === 'image') return e.entry_type === 'image';
  return e.entry_type === 'transcript' && e.mode === f;
}
