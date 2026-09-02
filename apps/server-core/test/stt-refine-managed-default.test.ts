// Card A7 — GA-14 refine must not silently pick a different engine than the
// live session did.
//
// SPEC-REF:
//   docs/strategy/2026-09-02-full-implementation-audit-and-next-plan.md §3-A A7
//   docs/rebuild/06-STT-ENGINE-LAYER.md §5 (refine two-pass)
//
// ── THE ACCOUNT ──────────────────────────────────────────────────────────────
// `resolveRefine` called `selectRouting(args.sourceLang, routings)` with NO
// `managedDefault` — tier 3 of the §4 algorithm (the platform's managed/pool
// route, what virtually every production session actually runs on) was
// structurally unreachable from inside it. When the live session actually ran
// on the managed default (soniox, a STREAMING engine — see
// stt/streaming-engines.ts), refine fell through to a SEEDED batch-capable
// fallback (sherpa-local) instead of correctly recognising that the live
// engine cannot do a second pass at all, and silently re-transcribed with the
// wrong engine.
//
// The fix (`stt/engine-factory.ts` `makeManagedDefaultResolver`, threaded into
// `resolveRefine`'s new 4th parameter) makes refine ask the exact same
// question the live session asked. This test drives `resolveRefine` directly
// with the ACTUAL production shape (soniox as managed default, sherpa-local
// seeded) and asserts on the WARN log — resolveRefine's own honest statement
// of what it decided — rather than invoking `transcribe`, which would need to
// fake a live vendor connection.
//
// ── REVERSE CONTROL ──────────────────────────────────────────────────────────
// Calling `resolveRefine` with the 4th argument omitted (the pre-fix call
// shape) turns this RED: no "streaming-only" WARN fires, and refine comes back
// ARMED — using sherpa-local, the wrong engine. Seen red locally against the
// pre-fix call, then the fix was restored — see the WP-1 report for this run.

import { describe, expect, it, vi } from 'vitest';
import type { SettingRow, SettingsRepo } from '../src/db/repos/settings.repo';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { RoomStore } from '../src/room/store';
import type { Socket } from 'socket.io';
import { resolveRefine, type SttFactoryDeps } from '../src/engine/stt-factory';
import type { SttStartArgs } from '../src/socket/handlers/audio.handler';
import type { Routing } from '../src/stt/engine-router';
import { log } from '../src/log';

function settingsWith(rows: Record<string, unknown> = {}): SettingsRepo {
  return {
    readAll: (): SettingRow[] => Object.entries(rows).map(([key, value]) => ({ key, value, updated_at: '' }) as unknown as SettingRow),
    read: (_u, key): SettingRow | null => (key in rows ? ({ key, value: rows[key], updated_at: '' } as unknown as SettingRow) : null),
    write: (): SettingRow => { throw new Error('unused'); },
    remove: (): boolean => false,
  };
}

// The real production shape: `stt.routings` holds only a SEEDED sherpa-local
// fallback row (batch-capable), and the pool's managed default is soniox
// (streaming) — exactly findings-stt.md's "refine re-transcribes with
// sherpa-local instead of Soniox".
const SEEDED_SHERPA_LOCAL: Routing = { language: 'zh', engine_id: 'sherpa-local', provenance: 'seed' };
const managedDefaultIsSoniox = (language: string): Routing | null =>
  language === 'zh' ? { language: 'zh', engine_id: 'soniox' } : null;

function baseDeps(): SttFactoryDeps {
  return {
    settings: settingsWith({ 'stt.routings': [SEEDED_SHERPA_LOCAL] }),
    mode: 'saas',
    store: {} as unknown as RoomStore<Socket>,
    quota: {} as unknown as QuotaGuard,
  };
}

function baseArgs(): SttStartArgs {
  return {
    userId: 'u1', mode: 'realtime', delivery: 'inject', sourceLang: 'zh',
    onComplete: () => {},
  };
}

describe('card A7 — resolveRefine must ask the same routing question the live session asked', () => {
  it('the live engine is soniox (streaming) ⇒ refine correctly declines, by name, instead of substituting sherpa-local', () => {
    const warns: Array<[string, unknown]> = [];
    const spy = vi.spyOn(log, 'warn').mockImplementation((m, f) => { warns.push([m, f]); });
    try {
      const refine = resolveRefine(baseDeps(), baseArgs(), { enabled: true }, managedDefaultIsSoniox);

      // 🔴 THE ASSERTION — refine is NOT armed, and it says why: the routed
      // engine (soniox, the one the live session actually used) is
      // streaming-only. This is the honest "switch is on and does nothing"
      // statement the file's own header promises, naming the RIGHT engine.
      expect(refine).toBeUndefined();
      expect(warns).toContainEqual([
        'stt.refine is ON but the routed engine is streaming-only — no second pass',
        { engine: 'soniox', language: 'zh' },
      ]);
      // Positive control: this is not vacuous — a resolver that (wrongly) never
      // participates would produce the SAME "no routing matched" warning
      // instead, which is a different, less honest failure this test must tell
      // apart from the one it is proving.
      expect(warns.some(([m]) => m === 'stt.refine is ON but no routing matches — no second pass')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('reverse control: omitting managedDefault (the pre-fix call shape) silently arms refine on the WRONG engine', () => {
    const warns: Array<[string, unknown]> = [];
    const spy = vi.spyOn(log, 'warn').mockImplementation((m, f) => { warns.push([m, f]); });
    try {
      // The exact call `resolveRefine` used to make: no 4th argument, so tier 3
      // (managedDefault) is unreachable and selection falls through to the
      // seeded sherpa-local row.
      const refine = (resolveRefine as unknown as (
        deps: SttFactoryDeps, args: SttStartArgs, cfg: { enabled: boolean },
      ) => { cfg: unknown; transcribe: unknown } | undefined)(baseDeps(), baseArgs(), { enabled: true });

      // Armed — but on sherpa-local, not on the engine that actually heard this
      // utterance. No "streaming-only" warning fires because the router never
      // even considered soniox.
      expect(refine).toBeDefined();
      expect(warns.some(([m]) => m === 'stt.refine is ON but the routed engine is streaming-only — no second pass')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
