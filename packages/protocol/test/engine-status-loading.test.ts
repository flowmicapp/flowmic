// NR-38 — `stt:engine-status` gains a fourth value: `loading`.
//
// WHY IT IS A PROTOCOL FACE: it widens an existing schema's enum, which is the
// same shape `control-key-punctuation.test.ts` guards for `control:key`. What is
// deliberately NOT changed, and is asserted here: the EVENT count. No name is
// added, so the 57-event whitelist (`events.ts` EVENT_NAMES), its count guard
// (`events-count.test.ts`), `apps/server-core/test/protocol-contract.test.ts`
// and the Rust `DESKTOP_EVENTS` subset guard are all untouched.
//
// WHY IT IS ADDITIVE, stated as the failure direction rather than as a promise:
//   - new producer → OLD consumer: every shipped consumer reads `status` as a
//     closed match with a default arm and DROPS the unknown value instead of
//     throwing. Desktop capsule `controller.ts onEngineStatus` gates on an
//     explicit `=== 'ready' | 'reconnecting' | 'failed'` before it writes state;
//     the desktop Rust leg (`socket/fanout.rs on_forward`) forwards the payload
//     verbatim as `serde_json::Value` and never parses the enum; the phone's
//     `local_engine_status.dart observeFrame` has `_ => null` and returns
//     without recording. So an un-updated end shows exactly what it shows
//     today — nothing during the cold seconds — which is the product as shipped.
//   - old producer → new consumer: `loading` simply never arrives; the first
//     frame is `ready`, as it is today.
// Neither direction can refuse a frame, so no deployment order applies (and the
// relay never emits this for a local engine at all — the sidecar that produces
// it ships inside the desktop app).

import { describe, expect, it } from 'vitest';
import { SttEngineStatusSchema } from '../src/protocol-schemas-audio';
import { safeParseEvent } from '../src/protocol-schemas';
import { EVENT_NAMES } from '../src/events';
import { ERROR_CODE_LIST } from '../src/error-codes';

describe('stt:engine-status — the loading value', () => {
  it('accepts loading', () => {
    expect(SttEngineStatusSchema.safeParse({ provider: 'sherpa-local', status: 'loading' }).success).toBe(true);
  });

  it('accepts loading through the registry the server and relay actually use', () => {
    // safeParseEvent is the boundary the relay runs every frame through
    // (relay.handler.ts forwards `parsed.data`), so a value that parses here is
    // a value that survives a relay that was never redeployed.
    expect(safeParseEvent('stt:engine-status', { provider: 'sherpa-local', status: 'loading' }).success).toBe(true);
  });

  it('still accepts the three values that existed before (the widening broke nothing)', () => {
    for (const status of ['ready', 'reconnecting', 'failed']) {
      expect(SttEngineStatusSchema.safeParse({ provider: 'funasr', status }).success, status).toBe(true);
    }
  });

  it('still rejects anything outside the four — the enum is not a free string', () => {
    for (const status of ['dead', 'Loading', 'loading ', '', 'starting', 'open']) {
      expect(SttEngineStatusSchema.safeParse({ provider: 'funasr', status }).success, status).toBe(false);
    }
  });

  it('retry_count stays optional and provider stays required', () => {
    expect(SttEngineStatusSchema.safeParse({ provider: 'sherpa-local', status: 'loading', retry_count: 0 }).success).toBe(true);
    expect(SttEngineStatusSchema.safeParse({ status: 'loading' }).success).toBe(false);
    expect(SttEngineStatusSchema.safeParse({ provider: '', status: 'loading' }).success).toBe(false);
  });

  it('adds NO event name — the whitelist and its count guard do not move', () => {
    expect(EVENT_NAMES).toHaveLength(57);
    expect(EVENT_NAMES).toContain('stt:engine-status');
  });
});

// NR-96 (2026-09-24) — the ladder's retry budget on the same frame. Additive:
// three optional keys, no event, no error code. The PRODUCER side (only
// `reconnecting` frames carry them, and with the ladder's real numbers) is
// pinned in apps/server-core/test/engine-reconnect-progress.test.ts; this file
// pins the boundary every relay runs frames through.
describe('stt:engine-status — the NR-96 retry budget fields', () => {
  const full = { provider: 'soniox', status: 'reconnecting', retry_count: 2, retry_max: 3, retry_in_ms: 2_000, attempt_timeout_ms: 5_000 };

  it('keeps all three through the registry the relay forwards (parsed.data is what goes on)', () => {
    const r = safeParseEvent('stt:engine-status', full);
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual(full);
  });

  it('an old frame without them still parses — nothing refuses a pre-NR-96 producer', () => {
    const r = SttEngineStatusSchema.safeParse({ provider: 'soniox', status: 'reconnecting', retry_count: 1 });
    expect(r.success).toBe(true);
    expect(r.success && 'retry_max' in r.data).toBe(false);
  });

  it('each field is optional on its own (absent retry_max means unbounded, not invalid)', () => {
    for (const k of ['retry_max', 'retry_in_ms', 'attempt_timeout_ms'] as const) {
      const { [k]: _drop, ...rest } = full;
      expect(SttEngineStatusSchema.safeParse(rest).success, k).toBe(true);
    }
  });

  it('rejects values that would make the client lie: fractional, negative, or a zero budget/timeout', () => {
    for (const bad of [
      { retry_max: 0 }, { retry_max: 2.5 }, { retry_max: -1 },
      { retry_in_ms: -1 }, { retry_in_ms: 1.5 },
      { attempt_timeout_ms: 0 }, { attempt_timeout_ms: '5000' },
    ]) {
      expect(SttEngineStatusSchema.safeParse({ ...full, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    // retry_in_ms = 0 is a real value (retry immediately), not an invalid one.
    expect(SttEngineStatusSchema.safeParse({ ...full, retry_in_ms: 0 }).success).toBe(true);
  });

  it('adds no event and no error code — both count guards stay where they were', () => {
    expect(EVENT_NAMES).toHaveLength(57);
    expect(ERROR_CODE_LIST).toHaveLength(85);
  });
});
