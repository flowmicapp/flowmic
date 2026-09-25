// Card RC-3b — `stt:engine-status` gains one additive optional field,
// `replayed_ms`, carried by the `ready` frame that ends an engine reconnect.
//
// Contract: book 04 §3 `stt:engine-status` row (RC-3b note). Producer:
// apps/server-core/src/stt/engine-session.ts `attemptReconnect`. Reader: the
// phone's outage accounting (apps/mobile/lib/src/ptt/ptt_capture_pump.dart).
//
// WHAT IS NOT CHANGED, and asserted here: the EVENT list and the error-code
// list. No name is added.
//
// WHY THIS FILE, and not just the relay test: the relay forwards
// `safeParseEvent(...).data` (the zod object strips unknown keys), so a field
// missing from the schema would reach nobody even though the producer set it.

import { describe, expect, it } from 'vitest';
import { SttEngineStatusSchema } from '../src/protocol-schemas-audio';
import { safeParseEvent } from '../src/protocol-schemas';
import { EVENT_NAMES } from '../src/events';

describe('stt:engine-status — replayed_ms (card RC-3b)', () => {
  it('survives the registry the relay parses every frame through', () => {
    const r = safeParseEvent('stt:engine-status', { provider: 'soniox', status: 'ready', replayed_ms: 12_000 });
    expect(r.success).toBe(true);
    expect(r.success && (r.data as { replayed_ms?: number }).replayed_ms).toBe(12_000);
  });

  it('is optional: a ready frame without it still parses (old relay, cold open)', () => {
    expect(SttEngineStatusSchema.safeParse({ provider: 'soniox', status: 'ready' }).success).toBe(true);
  });

  it('accepts 0 (nothing re-fed is a fact, not absence) and rejects negatives and fractions', () => {
    expect(SttEngineStatusSchema.safeParse({ provider: 'soniox', status: 'ready', replayed_ms: 0 }).success).toBe(true);
    for (const v of [-1, 1.5, '12000', null]) {
      expect(SttEngineStatusSchema.safeParse({ provider: 'soniox', status: 'ready', replayed_ms: v }).success, String(v)).toBe(false);
    }
  });

  it('adds no event name', () => {
    expect(EVENT_NAMES).toContain('stt:engine-status');
    expect(EVENT_NAMES.filter((n) => n.startsWith('stt:engine'))).toEqual(['stt:engine-status']);
  });
});
