// NR-96 follow-up (2026-09-24) — the engine reconnect ladder's worst case,
// derived in ONE place from the three AUDIO_DEFAULTS inputs. Two readers:
// the relay's audio retention window (server-core orchestrator-core.ts
// `unfedGraceMs`) and the desktop capsule's fallback watchdog for an old
// relay's frames. Both must move if any input moves, and neither may hold its
// own copy of the number — this file pins the derivation, the readers pin that
// they read it (apps/server-core/test/engine-reconnect-retention.test.ts,
// apps/desktop/src/capsule/engine-status-loading.test.ts).

import { describe, expect, it } from 'vitest';
import {
  AUDIO_DEFAULTS,
  ENGINE_RECONNECT_WORST_CASE_MS,
  engineReconnectDelayMs,
  engineReconnectWorstCaseMs,
} from '../src/constants';

describe('engine reconnect worst case', () => {
  it('is every attempt\'s wait plus every attempt\'s spawn cap (1+2+4 + 3×5 = 22 s)', () => {
    expect(ENGINE_RECONNECT_WORST_CASE_MS).toBe(22_000);
    const { engine_reconnect_backoff_ms: b, engine_reconnect_max_retries: n, engine_spawn_timeout_ms: t } = AUDIO_DEFAULTS;
    expect(ENGINE_RECONNECT_WORST_CASE_MS).toBe(b.reduce((a, x) => a + x, 0) + n * t);
  });

  it('reuses the last wait once the schedule runs out, exactly like the ladder', () => {
    expect(engineReconnectDelayMs([1_000, 2_000], 0)).toBe(1_000);
    expect(engineReconnectDelayMs([1_000, 2_000], 5)).toBe(2_000);
    expect(engineReconnectWorstCaseMs([1_000, 2_000], 4, 100)).toBe(1_000 + 2_000 + 2_000 + 2_000 + 4 * 100);
  });

  it('an empty schedule falls back to 1 s per attempt (the ladder\'s own fallback)', () => {
    expect(engineReconnectWorstCaseMs([], 2, 0)).toBe(2_000);
  });

  it('is strictly larger than the backoff sum alone — the spawn cap is part of the bound', () => {
    const sum = AUDIO_DEFAULTS.engine_reconnect_backoff_ms.reduce((a, x) => a + x, 0);
    expect(ENGINE_RECONNECT_WORST_CASE_MS).toBeGreaterThan(sum);
  });
});
