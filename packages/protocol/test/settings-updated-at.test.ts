import { describe, it, expect } from 'vitest';
import { safeParseEvent } from '../src/protocol-schemas';

// G2 (0.3.x) — the additive-optional `updated_at` on the three §3.7 settings
// events. Contract: docs/rebuild/04-PROTOCOL-SPEC.md §3.7-a.
//
// Three cases per event, the same triple `additive-rev-r1.test.ts` uses for
// `edited` and `origin`:
//   · PRESENT  — the new field parses and survives;
//   · ABSENT   — a v1 client that never sends it still parses (this is the one
//                that matters: absence means UNKNOWN, and the server degrades to
//                exactly today's behaviour. If this case ever goes red, every
//                deployed client's writes start failing at the zod boundary,
//                which is anonymous and silent);
//   · WRONG TYPE — rejected, so the field cannot become a free-text smuggling
//                slot the way an un-narrowed `z.unknown()` would.
//
// ⚠️ What this file does NOT prove: that the SERVER honours the stamp. The
// regress guard and the clamp are behaviour, not shape — they live in
// apps/server-core (settings.handler) and in golden G22. A schema test going
// green here says the field can cross the wire, nothing about who wins.
//
// REVERSE CONTROL (executed 2026-08-16, this tree): removing `.optional()` from
// `SettingsUpdateSchema.updated_at` in protocol-schemas-sync.ts turned the ABSENT
// cases red —
//   FAIL  settings:update parses with NO updated_at (v1 compat -- absence = unknown)
//     AssertionError: expected false to be true
// — and the PRESENT/WRONG-TYPE cases stayed green, i.e. only the compat half is
// load-bearing for that one character. Restored, re-run green.

const KEY = 'scenario.card';
const CARD = { professions: [], domains: [], packs: [], terms: [] };
const STAMP = '2026-08-16T10:00:00.000Z';

/** `settings:list` takes `{}`; its ACK is a handler literal with no schema, so
 *  the two schema'd events are what this table can speak about. Named here so
 *  the absence of a third row reads as known rather than forgotten. */
const EVENTS = ['settings:update', 'settings:updated'] as const;

describe('G2 settings updated_at — additive optional on §3.7', () => {
  for (const event of EVENTS) {
    describe(event, () => {
      it('parses WITH updated_at, and the value survives verbatim', () => {
        const r = safeParseEvent(event, { key: KEY, value: CARD, updated_at: STAMP });
        expect(r.success).toBe(true);
        // Not just `success`: zod strips unknown keys silently, so a field that
        // was never added to the object would parse "fine" and vanish. The whole
        // failure mode this repo has paid for twice (duration_ms, inject_origin)
        // is a frame that arrives with the feature quietly gone.
        expect(r.success && (r.data as { updated_at?: string }).updated_at).toBe(STAMP);
      });

      it('parses with NO updated_at (v1 compat — absence = unknown, never epoch)', () => {
        const r = safeParseEvent(event, { key: KEY, value: CARD });
        expect(r.success).toBe(true);
        // And it must stay ABSENT, not be defaulted into existence: a zod
        // default would hand an old client a stamp it never authored, and that
        // fabricated stamp would then win or lose a comparison on its behalf.
        expect(r.success && 'updated_at' in (r.data as object)).toBe(false);
      });

      it('rejects a numeric (epoch-millis) updated_at', () => {
        // Specifically pinned: epoch millis is the shape a client would reach for
        // first, and silently accepting it would put two different time formats
        // on one field — the「一个值答两个问题」shape, in the field that exists to
        // be compared.
        expect(safeParseEvent(event, { key: KEY, value: CARD, updated_at: 1_755_338_400_000 }).success).toBe(false);
      });

      it('rejects an empty updated_at', () => {
        expect(safeParseEvent(event, { key: KEY, value: CARD, updated_at: '' }).success).toBe(false);
      });

      it('🔴 ACCEPTS an unparseable string — `Iso8601` is a NAME, not a validator', () => {
        // MEASURED, and it contradicted this file's first draft (which asserted
        // a rejection here and went red): `Iso8601` in protocol-primitives.ts is
        // `z.string().min(1)`. It carries no date validation whatsoever.
        //
        // 🔴 The consequence is not cosmetic, and it is the server's to carry.
        // The regress guard compares two of these. String comparison puts
        // 'yesterday' ABOVE '2026-08-16T…' (lowercase 'y' > '2'), so a garbage
        // stamp would win EVERY comparison and could pin a row permanently —
        // the same permanent-unwritability failure the future-stamp clamp
        // exists to close, arriving through a different door.
        // ⇒ settings.handler.ts must treat an UNPARSEABLE stamp as ABSENT
        //   (= unknown ⇒ degrade to today's behaviour), never as a comparable
        //   value. That is asserted where the behaviour lives, not here.
        //
        // Deliberately NOT tightening `Iso8601`: it is a shared primitive on
        // history created_at/updated_at and other events, so narrowing it would
        // be a NON-additive change with a blast radius far outside G2, and old
        // frames would start dying at the anonymous, silent zod boundary. Pinned
        // here instead so the gap is a known fact rather than a surprise.
        expect(safeParseEvent(event, { key: KEY, value: CARD, updated_at: 'yesterday' }).success).toBe(true);
      });
    });
  }

  it('settings:list still takes an empty object (untouched by G2)', () => {
    expect(safeParseEvent('settings:list', {}).success).toBe(true);
  });

  it('the stamp does not become required — key+value alone is still a whole frame', () => {
    // The negative of the negative: proves the compat case above is not passing
    // because the schema stopped validating anything at all.
    expect(safeParseEvent('settings:update', { value: CARD, updated_at: STAMP }).success).toBe(false);
    expect(safeParseEvent('settings:update', { key: '', value: CARD }).success).toBe(false);
  });
});
