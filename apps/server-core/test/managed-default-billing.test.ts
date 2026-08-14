// 🔴 T7 acceptance — "who supplied the key", not "whether there is a key".
//   docs/strategy/2026-08-02-h6-soniox-streaming-adapter-card.md §-0f
//
// The bug: `managed-default.ts` copies FLOWMIC_MANAGED_STT_API_KEY onto the
// platform routing, and `resolveByok` used to answer TRUE for any non-empty key
// regardless of who supplied it. A keyed managed default therefore classified
// the PLATFORM'S OWN traffic as the user's BYOK, which switched off two money
// gates at once. `.local/soniox.env` sets exactly that variable — but this was
// never a Soniox bug: FLOWMIC_MANAGED_STT_ENGINE=deepgram + a Deepgram key
// reproduced both failures with zero code changes. The managed-default feature
// has not been billable for ANY keyed engine since it was written; it stayed
// dormant only because production ran the keyless FunASR default.
//
// D1 rule (assert the name and the number that actually takes effect separately): three SEPARATE assertions, one per
// consequence, plus a fourth for the LLM-meter conflation (T7-b).
//   ① isByok === false               — the classification itself
//   ② a row really lands in usage_records — the quota meter's actual input
//   ③ gated === true                 — the VAD billing gate really closes
//   ④ polish tokens are metered off the LLM key, not the STT key
//
// ⚠️ Why ② must read the DB and not the quota guard: `quota-guard.ts:51-67` is
// not BYOK-aware at all — it compares effectiveLimits against usage_records.
// With is_byok:true no row is ever written, so `used` stays 0 and `used>=limit`
// never trips. The guard is STARVED, not disabled ⇒ any test that exercises
// ensureQuota directly is GREEN while the leak is live. Only the row catches it.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createDbConnection } from '../src/db/connection';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { deriveKey } from '../src/auth/crypto';
import { makeUsageTracker } from '../src/billing/usage-tracker';
import { currentMonth } from '../src/db/repos/usage.repo';
import { makeSttOrchestratorFactory, resolveByok } from '../src/stt/engine-factory';
import { selectRoutingWithSource, type Routing } from '../src/stt/engine-router';
import { managedDefaultRouting } from '../src/stt/managed-default';
import { VadGate } from '../src/stt/vad-gate';
import { AudioSession } from '../src/stt/audio/session';
import { isByokLlm } from '../src/compose/llm-config';
import type { SettingRow, SettingsRepo } from '../src/db/repos/settings.repo';
import type { SttEngine, SttEngineConfig } from '../src/stt/engines/base';
import type { EngineFactory } from '../src/stt/engine-router';
import type { SttEngineId } from '@flowmic/protocol';

/** The env a production VPS gets from `.local/soniox.env` — same SHAPE, obviously
 *  not the real key (which is gitignored and never printed). The engine id is
 *  deliberately `deepgram`, an id that has existed for many versions: this bug
 *  predates Soniox and the test says so. */
/** A2-5 — the third argument the STT metering seam grew. This suite is about
 *  the BYOK verdict and the month bucket, not about character counts, so it
 *  passes a pair of honest zeros: these harnesses drive the meter directly and
 *  never transcribe anything, so "zero characters" is the true report. 🔴 Deliberately
 *  NOT a plausible-looking number — a fixture that invented "41 characters" for a
 *  session with no text would be a measurement nobody made. */
const NO_TEXT_MEASURED = { transcript: 0, delivered: 0 } as const;

const MANAGED_ENV = {
  FLOWMIC_MANAGED_STT_ENABLED: '1',
  FLOWMIC_MANAGED_STT_ENGINE: 'deepgram',
  FLOWMIC_MANAGED_STT_API_KEY: 'platform-key-not-the-users',
} as unknown as NodeJS.ProcessEnv;

/** In-memory settings repo — the user has NO stt.routings, so selection falls
 *  through to the managed default (that is the whole scenario). */
function settingsWith(rows: Record<string, unknown> = {}): SettingsRepo {
  return {
    readAll: (): SettingRow[] => [],
    read: (_u, key): SettingRow | null =>
      key in rows ? ({ key, value: rows[key], updated_at: '' } as unknown as SettingRow) : null,
    write: (): SettingRow => { throw new Error('unused'); },
    remove: (): boolean => false,
  };
}

class StubEngine implements SttEngine {
  state = 'closed' as const;
  constructor(public readonly id: SttEngineId, public cfg: SttEngineConfig) {}
  push(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
  on(): this { return this; }
}
const stubFactory: EngineFactory = (id, cfg) => new StubEngine(id, cfg) as unknown as SttEngine;

function buildManagedSession(): { isByok: boolean; gated: boolean } {
  const factory = makeSttOrchestratorFactory({
    settings: settingsWith(),
    mode: 'saas',
    engineFactory: stubFactory,
    managedDefault: () => managedDefaultRouting(MANAGED_ENV),
  });
  const built = factory(new AudioSession(), 'zh', 'u1', new VadGate());
  return { isByok: built.isByok, gated: built.gated };
}

describe('T7 — a platform managed-default key is NOT BYOK', () => {
  it('precondition: the managed default really does carry a NON-EMPTY key', () => {
    // Without this, ① could pass for the boring reason (no key at all) and the
    // whole test would be a positive control for nothing.
    const r = managedDefaultRouting(MANAGED_ENV);
    expect(r?.api_key).toBe('platform-key-not-the-users');
    expect((r?.api_key ?? '').length).toBeGreaterThan(0);
    expect(r?.engine_id).toBe('deepgram');
  });

  it('① isByok === false when the key came from the platform managed default', () => {
    expect(buildManagedSession().isByok).toBe(false);
  });

  it('③ gated === true — the VAD billing gate really closes on managed streaming', () => {
    expect(buildManagedSession().gated).toBe(true);
  });

  it('② the usage really lands in usage_records (the quota meter reads THAT, not a flag)', () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
    db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
    const tracker = makeUsageTracker(db.usage, { mode: 'saas' });
    const { isByok } = buildManagedSession();

    // Replay the ONE production metering site (audio.handler.ts:109) with the
    // flag this session actually produced.
    tracker.recordSttUsage('u1', { is_byok: isByok }, 120_000, NO_TEXT_MEASURED);

    const row = db.usage.get('u1', currentMonth());
    expect(row).not.toBeNull();
    expect(row?.stt_minutes).toBeCloseTo(2, 6);
    db.close();
  });

  it('positive control: a USER key with the same shape is still BYOK and still ungated', () => {
    // Proves ①/③ are not simply「always false / always true」— the same code path
    // answers the other way when the provenance is the user's.
    const factory = makeSttOrchestratorFactory({
      settings: settingsWith({ 'stt.routings': [{ language: '*', engine_id: 'deepgram', api_key: 'the-users-own-key' }] }),
      mode: 'saas',
      engineFactory: stubFactory,
      managedDefault: () => managedDefaultRouting(MANAGED_ENV),
    });
    const built = factory(new AudioSession(), 'zh', 'u1', new VadGate());
    expect(built.isByok).toBe(true);
    expect(built.gated).toBe(false);
  });

  it('and a BYOK session correspondingly writes NO usage row (the other half of ②)', () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
    db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
    makeUsageTracker(db.usage, { mode: 'saas' }).recordSttUsage('u1', { is_byok: true }, 120_000, NO_TEXT_MEASURED);
    expect(db.usage.get('u1', currentMonth())).toBeNull();
    db.close();
  });

  // 🔴 W1.5. The other TWO guards at the top of recordSttUsage were relied upon
  // in prose and pinned by nothing. `stt-session.ts` dispose() cites all three
  // as the reason it does NOT carry its own copy of the guard — so an unpinned
  // guard there is a decision resting on an assumption. The adversarial review
  // found the claim before a regression did.
  it('standalone never bills, however long the session was (the mode guard)', () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
    db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
    makeUsageTracker(db.usage, { mode: 'standalone' }).recordSttUsage('u1', { is_byok: false }, 120_000, NO_TEXT_MEASURED);
    expect(db.usage.get('u1', currentMonth())).toBeNull();
    // Positive control: the SAME call under saas does write, so the null above
    // is the guard and not a blind probe.
    makeUsageTracker(db.usage, { mode: 'saas' }).recordSttUsage('u1', { is_byok: false }, 120_000, NO_TEXT_MEASURED);
    expect(db.usage.get('u1', currentMonth())?.stt_minutes).toBeCloseTo(2, 6);
    db.close();
  });

  it('a zero-duration session writes NO row — the guard dispose() depends on', () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
    db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
    const tracker = makeUsageTracker(db.usage, { mode: 'saas' });
    // Exactly what the dispose path reports for a session that carried nothing.
    tracker.recordSttUsage('u1', { is_byok: false }, 0, NO_TEXT_MEASURED);
    expect(db.usage.get('u1', currentMonth())).toBeNull();
    tracker.recordSttUsage('u1', { is_byok: false }, -1, NO_TEXT_MEASURED);
    expect(db.usage.get('u1', currentMonth())).toBeNull();
    // Positive control, same tracker instance.
    tracker.recordSttUsage('u1', { is_byok: false }, 60_000, NO_TEXT_MEASURED);
    expect(db.usage.get('u1', currentMonth())?.stt_minutes).toBeCloseTo(1, 6);
    db.close();
  });
});

/** Minimal engine stub for the ④ seam test — emits one final on flush. */
class PolishFakeEngine extends EventEmitter {
  readonly id = 'custom-openai-compatible';
  private _state = 'closed';
  finalOnFlush: string | null = null;
  get state(): string { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void {}
  async flush(): Promise<void> {
    if (this.finalOnFlush !== null) {
      this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'zh', duration_ms: 1234 });
    }
  }
  async close(): Promise<void> { this._state = 'closed'; }
}
let polishByokSeen: boolean | null = null;

describe('T7-b — the LLM meter must read the LLM key, not the STT key', () => {
  // stt-session.ts used to pass the STT routing's isByok into onPolishUsage →
  // recordLlmUsage. A user with a BYOK **STT** key got their platform **LLM**
  // polish tokens waived: one value answering two questions. This asserts the
  // two paths (compose + polish) now derive the answer from the same config.
  const platformLlm = { protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: 'EMPTY', model: 'm' } as const;
  const byokLlm = { protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: 'sk-user', model: 'm' } as const;

  it('④ platform LLM + BYOK STT ⇒ polish tokens DO land in usage_records', () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
    db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
    const tracker = makeUsageTracker(db.usage, { mode: 'saas' });

    const sttIsByok = resolveByok(selectRoutingWithSource(
      'zh', [{ language: '*', engine_id: 'deepgram', api_key: 'users-stt-key' } as Routing],
    ));
    expect(sttIsByok).toBe(true); // the STT side really is BYOK …
    // … and the polish call is billed off the LLM config regardless.
    tracker.recordLlmUsage('u1', { is_byok: isByokLlm(platformLlm) }, 100, 40);

    const row = db.usage.get('u1', currentMonth());
    expect(row?.llm_tokens_in).toBe(100);
    expect(row?.llm_tokens_out).toBe(40);
    db.close();
  });

  it('positive control: a real BYOK LLM key still waives the polish tokens', () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
    db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
    makeUsageTracker(db.usage, { mode: 'saas' }).recordLlmUsage('u1', { is_byok: isByokLlm(byokLlm) }, 100, 40);
    expect(db.usage.get('u1', currentMonth())).toBeNull();
    db.close();
  });

  // 🔴 The two above replay the METER. This one drives the PRODUCTION SEAM
  // (SttSessionBridge → onPolishUsage), which is the line that was wrong. A test
  // that only replays the meter stays green even if stt-session.ts goes back to
  // passing the STT flag — so this is the one the reverse control bites on.
  it('④ SEAM: BYOK STT + platform LLM ⇒ onPolishUsage receives byok=FALSE, and the row lands', async () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
    db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
    const tracker = makeUsageTracker(db.usage, { mode: 'saas' });

    const eng = new PolishFakeEngine();
    const bridge = new SttSessionBridge({
      build: (session: AudioSession) => ({
        orchestrator: new SttEngineOrchestrator(session, () => eng as unknown as never, { engineFlushTimeoutMs: 200 }),
        // The STT routing IS BYOK — the user's own microphone key.
        isByok: true,
        gated: false,
      }),
      emitter: { emit: (): void => {} },
      userId: 'u1', mode: 'realtime', sourceLang: 'zh',
      onComplete: (): void => {},
      // …while polish runs on the PLATFORM's LLM ('EMPTY' sentinel = not BYOK).
      onPolishUsage: (tIn: number, tOut: number, byok: boolean) => {
        polishByokSeen = byok;
        tracker.recordLlmUsage('u1', { is_byok: byok }, tIn, tOut);
      },
      polish: {
        // M4: the bridge now takes the config WITH its provenance. 'user' + the
        // 'EMPTY' platform-endpoint sentinel is the shape this test was written
        // for (a user row pointing at the platform's own LAN/vLLM endpoint) — it
        // is NOT BYOK, so the tokens must land. The managed-default provenance
        // arm (a long platform key that shape alone would call BYOK) is pinned in
        // stt-session-bridge.test.ts 「M4 polish metering judges BYOK by
        // provenance」.
        llm: {
          cfg: { protocol: 'openai-compatible', endpoint: 'http://test.invalid/v1', api_key: 'EMPTY', model: 'm' },
          source: 'user',
        },
        deps: { streamerFor: () => async function* () { yield { kind: 'done', full: '你好。', usage: { tokens_in: 100, tokens_out: 40 } }; } as never },
      },
      levelIntervalMs: 0,
    } as never);

    await new Promise((r) => setTimeout(r, 5));
    eng.finalOnFlush = '你好';
    await bridge.finish();

    // The flag itself…
    expect(polishByokSeen).toBe(false);
    // …AND the number it actually moved (D1 rule: assert the name and the number that actually takes effect separately).
    const row = db.usage.get('u1', currentMonth());
    expect(row?.llm_tokens_in).toBe(100);
    expect(row?.llm_tokens_out).toBe(40);
    db.close();
  });
});
