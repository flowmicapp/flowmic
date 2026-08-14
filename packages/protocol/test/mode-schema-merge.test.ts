// WP-R3.5 — proves the ModeSchema→ProcessingModeSchema merge (packages/protocol/
// src/protocol-schemas-audio.ts) is a ZERO-wire-change cleanup. ModeSchema used to
// be a second `z.enum([...])` literal duplicating ProcessingModeSchema's three
// members; it is now a direct alias. These assertions pin that:
//   1. the two symbols are the SAME object (single source of truth),
//   2. they parse/reject identically for every mode value (round-trip),
//   3. the locked three-mode set is exactly realtime|translate|organize (no 4th),
//   4. the event schemas that consume ModeSchema (history sync) still round-trip.

import { describe, it, expect } from 'vitest';
import { ModeSchema, ProcessingModeSchema } from '../src/protocol-schemas-audio';
import { EVENT_NAMES } from '../src/events';
import { safeParseEvent } from '../src/protocol-schemas';

const MODES = ['realtime', 'translate', 'organize'] as const;
// draft/typing were deleted in the WP-R0-1 rename window; a 4th mode never exists.
const NON_MODES = ['draft', 'typing', 'summarize', '', 'REALTIME', null, 42];

describe('ModeSchema is a zero-wire-change alias of ProcessingModeSchema', () => {
  it('is the very same object (single source of truth)', () => {
    expect(ModeSchema).toBe(ProcessingModeSchema);
  });

  it('exposes exactly the three locked modes', () => {
    expect([...ModeSchema.options].sort()).toEqual([...MODES].sort());
  });

  it('accepts every canonical mode identically through both symbols', () => {
    for (const m of MODES) {
      const a = ModeSchema.safeParse(m);
      const b = ProcessingModeSchema.safeParse(m);
      expect(a.success).toBe(true);
      expect(b.success).toBe(true);
      expect(a).toEqual(b);
    }
  });

  it('rejects every non-mode identically through both symbols (no 4th mode)', () => {
    for (const bad of NON_MODES) {
      expect(ModeSchema.safeParse(bad).success).toBe(false);
      expect(ProcessingModeSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('55-event whitelist is untouched by the merge (payload-field, not event name)', () => {
    // A field-schema alias must never add/remove an event.
    expect(EVENT_NAMES).toContain('history:create');
    expect(EVENT_NAMES).not.toContain('mode');
  });

  it('the ModeSchema-consuming history events still round-trip a valid mode', () => {
    const item = {
      id: 'h1', pairing_id: null, pc_device_id: 'pc1', user_id: 'u1', mobile_id: null,
      mode: 'organize', source_text: null, source_lang: null, output_text: 'x',
      output_lang: null, duration_ms: null, segments_count: 0, status: 'injected',
      created_at: '2026-07-24T00:00:00.000Z', updated_at: '2026-07-24T00:00:00.000Z',
    };
    expect(safeParseEvent('history:create', { item }).success).toBe(true);
    // draft is no longer a valid mode anywhere the alias is used.
    expect(safeParseEvent('history:create', { item: { ...item, mode: 'draft' } }).success).toBe(false);
  });
});
