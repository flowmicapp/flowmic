// First coverage of the FunASR hotword path: `stt/hotwords.ts` (the pure
// builder) and `stt/engine-factory.ts loadHotwords` (the settings reader that
// feeds it). Before this file there was ZERO — no test of the clamp, the cap,
// the empty-frame contract, or which terminology sources reach an engine.
//
// 🔴 WHY THIS FILE DOES NOT DRIVE `audio:start`.
// The obvious route-level test of the fail-loud contract would pass WITHOUT the
// change this file exists to cover. `engine/stt-factory.ts` calls
// `resolveReplacementRules` to build the deterministic replacer BEFORE it
// constructs the SttSessionBridge, so on a corrupt `scenario.card` that earlier
// line throws first, on every `audio:start`. A socket-harness test would go
// green by measuring that pre-existing guard and would keep being green if
// `loadHotwords` were reverted. The honest assertion is a DIRECT unit call to
// `loadHotwords(repo, userId)` — that is the only way the throw being asserted
// is the one this path owns. Same reasoning for the merge tests: they call
// `loadHotwords` directly and read the frame value it returns.
//
// 🔴 WHAT THESE TESTS DO NOT PROVE. They prove the CONTENT of the open frame we
// hand FunASR — which terms are in the JSON string and at what weights. They
// prove nothing about recognition accuracy. No engine runs here. "The hotwords
// field now contains the user's terms" and "transcription of those terms got
// better" are two claims, and only the first is measured. Verifying the second
// needs a real FunASR engine and real speech.
//
// REVERSE CONTROLS — each was executed, observed RED for the stated reason, and
// restored. The exact break and the observed failure are recorded per test.
// ONE test has no break-the-implementation control and says so in place (the
// headroom-arithmetic one pins constants, so inverting its expectation would
// only test the test); its evidence is that it caught a wrong number in the
// doc comment it guards, before that comment was ever committed.

import { describe, expect, it } from 'vitest';

import {
  DICTIONARY_PACKS,
  SCENARIO_MAX_TERMS,
  SETTINGS_KEY_SCENARIO_CARD,
  composeDictionary,
} from '@flowmic/protocol';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { ServerError } from '../src/errors';
import {
  buildHotwords,
  clampHotwordWeight,
  HOTWORDS_MAX_ENTRIES,
  type SttDictionaryEntry,
} from '../src/stt/hotwords';
import { loadHotwords } from '../src/stt/engine-factory';

function freshDb(): DbConnection {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('hotwords-test-secret-key') });
  db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
  return db;
}
const U = 'u1';

/** The open-frame value as the engine would see it: parsed back from the JSON
 *  STRING. Asserting on the parsed map (not on substring matches) is deliberate
 *  — a substring assertion would pass on a term that merely appears somewhere in
 *  the serialisation. */
function hotwordMap(json: string | undefined): Record<string, number> {
  expect(json).toBeTypeOf('string');
  return JSON.parse(json as string) as Record<string, number>;
}

describe('buildHotwords — weight clamp (06 §5: default 20, band 10..50)', () => {
  // T1. REVERSE CONTROL (executed): hotwords.ts `if (w < HOTWORD_MIN_WEIGHT)
  // return HOTWORD_MIN_WEIGHT;` → `return w;`
  //   → RED, and only on the below-band case:
  //     FAIL  weight below the band is raised to 10
  //       expected 3 to be 10 // Object.is equality
  //     (the 99→50, absent→20 and 20.6→21 assertions stayed green)
  //   Restored; suite green again.
  it('weight below the band is raised to 10', () => {
    expect(hotwordMap(buildHotwords([{ term: 'low', weight: 3 }])).low).toBe(10);
    expect(clampHotwordWeight(3)).toBe(10);
  });

  it('weight above the band is lowered to 50', () => {
    expect(hotwordMap(buildHotwords([{ term: 'high', weight: 99 }])).high).toBe(50);
  });

  it('an absent weight becomes the default 20', () => {
    expect(hotwordMap(buildHotwords([{ term: 'plain' }])).plain).toBe(20);
  });

  it('a fractional in-band weight is rounded, not truncated', () => {
    // 20.6 → 21 (Math.round), not 20. The FunASR field is an integer weight.
    expect(hotwordMap(buildHotwords([{ term: 'frac', weight: 20.6 }])).frac).toBe(21);
  });
});

describe('buildHotwords — the 300 cap', () => {
  // T2. REVERSE CONTROL (executed): hotwords.ts `if (count >= HOTWORDS_MAX_ENTRIES)
  // break;` → `if (count > HOTWORDS_MAX_ENTRIES) break;`
  //   → RED on the BOUNDARY, not on the shape — BOTH tests in this block:
  //     FAIL  350 distinct terms are truncated to exactly 300 keys
  //       expected 301 to be 300 // Object.is equality
  //     FAIL  the cap counts accepted INPUT entries, not distinct output keys
  //       expected [ 'dup', 'after-the-cap' ] to deeply equal [ 'dup' ]
  //   Restored; green. An off-by-one here is exactly the failure a "length is
  //   roughly 300" assertion would sail past, which is why this asserts ===.
  it('350 distinct terms are truncated to exactly 300 keys', () => {
    const entries: SttDictionaryEntry[] = Array.from({ length: 350 }, (_, i) => ({ term: `t${i}` }));
    expect(Object.keys(hotwordMap(buildHotwords(entries))).length).toBe(300);
    expect(HOTWORDS_MAX_ENTRIES).toBe(300);
  });

  it('the headroom arithmetic in loadHotwords is measured, not asserted in prose', () => {
    // loadHotwords' doc comment states how many entries can sit AHEAD of the
    // user's personal dictionary before the 300 cap bites. A number written in a
    // comment is a claim with no owner, and this repo has been burned by exactly
    // that (anti-façade ④: an assertion about behaviour elsewhere whose truth
    // changes when someone else's code changes, while it does not). So the
    // number is recomputed here from the packs themselves.
    //
    // 🔴 It is 66, NOT the 67 you get by adding the six pack lengths
    // (15+10+10+10+12+10): composeDictionary dedupes by term and 'GitHub' ships
    // in BOTH tech-dev and proper-noun. Adding the lengths up measures the
    // curated CONTENT; what reaches the frame is the MERGE, and only the merge
    // is what the cap sees. If a future pack adds another cross-pack duplicate,
    // this goes red and the doc comment gets corrected with it.
    //
    // PROVENANCE, since this test has no "break the implementation" control of
    // the usual kind (it pins constants, so inverting an expectation would only
    // test the test): the doc comment SAID 67 when it was first written, from
    // adding the pack lengths up on paper. Running the merge said 66. That is
    // this assertion's reverse control — it already caught the exact error it
    // exists to prevent, before the commit that introduced it. The two
    // computations below (pre-dedupe vs merged) are kept side by side so the
    // discrepancy stays visible instead of being rounded into one number.
    const allPackIds = DICTIONARY_PACKS.map((p) => p.id);
    const everyPackEnabled = composeDictionary(allPackIds).length;
    expect(everyPackEnabled).toBe(66);
    expect(DICTIONARY_PACKS.reduce((n, p) => n + p.entries.length, 0)).toBe(67); // pre-dedupe
    expect(SCENARIO_MAX_TERMS + everyPackEnabled).toBe(166);
    // …leaving the personal dictionary at least this many slots.
    expect(HOTWORDS_MAX_ENTRIES - (SCENARIO_MAX_TERMS + everyPackEnabled)).toBe(134);
  });

  it('the cap counts accepted INPUT entries, not distinct output keys', () => {
    // Documented decision, not an accident (see loadHotwords' doc comment): the
    // builder's counter increments on every accepted entry INCLUDING one whose
    // term repeats a key already in the map. Duplicates became possible the
    // moment hotwords started merging three sources (the same term can sit in
    // the card AND a pack), so this rule is now load-bearing and is pinned here.
    const entries: SttDictionaryEntry[] = [
      ...Array.from({ length: 300 }, () => ({ term: 'dup' })),
      { term: 'after-the-cap' },
    ];
    const map = hotwordMap(buildHotwords(entries));
    expect(Object.keys(map)).toEqual(['dup']);
    expect(map['after-the-cap']).toBeUndefined();
  });
});

describe('buildHotwords — nothing to send omits the field entirely', () => {
  // T3. The contract is `undefined`, NOT an empty object: the caller omits the
  // field so the FunASR open frame stays byte-identical to the baseline. '{}'
  // would be a shipped behaviour change on every session of every user who has
  // configured no terminology at all.
  //
  // REVERSE CONTROL (executed): hotwords.ts `if (Object.keys(map).length === 0)
  // return undefined;` → `return '{}';`
  //   → RED on the all-malformed case (the only one that reaches that line):
  //     FAIL  a dictionary whose every entry is malformed → undefined
  //       expected '{}' to be undefined
  //   Restored; green.
  it('an empty array → undefined', () => {
    expect(buildHotwords([])).toBeUndefined();
  });

  it('a non-array value → undefined', () => {
    expect(buildHotwords(null)).toBeUndefined();
    expect(buildHotwords(undefined)).toBeUndefined();
  });

  it('a dictionary whose every entry is malformed → undefined', () => {
    const junk = [{ term: '   ' }, { term: '' }, { notATerm: 1 }, null] as unknown as SttDictionaryEntry[];
    expect(buildHotwords(junk)).toBeUndefined();
  });
});

describe('loadHotwords — reads the same three terminology sources as everything else', () => {
  // T4. THE MERGE. Before this change `loadHotwords` read `stt.dictionary`
  // ALONE — the narrowest of the three sources — so scenario-card terms and
  // curated dictionary packs never reached an engine from any client.
  //
  // REVERSE CONTROL (executed): engine-factory.ts `loadHotwords` body reverted
  // to the old single-source read
  //     const row = settings.read(userId, 'stt.dictionary');
  //     const value = row?.value;
  //     if (!Array.isArray(value)) return undefined;
  //     return buildHotwords(value as SttDictionaryEntry[]);
  //   → RED, and red in exactly the shape of the bug — 4 of the 14 tests fail:
  //     FAIL  card terms, packs and stt.dictionary all reach the engine frame
  //       expected undefined to be 20 // Object.is equality
  //     FAIL  curated pack weights survive the trip to the frame
  //       expected undefined to be type of 'string'
  //     FAIL  a present-but-malformed scenario.card throws, it does not degrade
  //       expected undefined to be an instance of ServerError
  //     FAIL  ONLY scenario.card.terms set → the terms still reach the engine
  //       expected undefined not to be undefined
  //   The first message is the asymmetry, and it is why `map.gRPC` is asserted
  //   BEFORE the other two: the run dies on FlowMic (expected 20), NOT on gRPC
  //   (expected 25), which proves the gRPC assertion ran and passed rather than
  //   never having been reached. The one source the old code did read still
  //   arrives; the two it did not are gone. This test is therefore not passing
  //   for some incidental reason.
  //   Restored; all 14 green.
  it('card terms, packs and stt.dictionary all reach the engine frame', () => {
    const db = freshDb();
    db.settings.write(U, SETTINGS_KEY_SCENARIO_CARD, {
      professions: [], domains: [], packs: ['tech-dev'], terms: ['FlowMic'],
    });
    db.settings.write(U, 'stt.dictionary', [{ term: 'gRPC', weight: 25 }]);

    const map = hotwordMap(loadHotwords(db.settings, U));
    // gRPC FIRST, deliberately: it is the one source the old code did read, so
    // asserting it ahead of the others makes the asymmetry visible in the revert
    // run — the failure lands on FlowMic, which proves gRPC passed rather than
    // merely never having been reached.
    expect(map.gRPC).toBe(25);         // ③ stt.dictionary
    expect(map.FlowMic).toBe(20);      // ① scenario card (no weight → default)
    expect(map.Kubernetes).toBe(20);   // ② curated pack
  });

  // T5. WEIGHT PRESERVATION. TermRule gained an optional `weight` for this: the
  // curated packs carry hand-authored weights, and mapping rules → hotwords
  // without carrying it would collapse every pack term to the default 20 —
  // silently, since the replacer (the rules' other consumer) never reads it.
  //
  // REVERSE CONTROL (executed): scenario-context.ts, packs leg — dropped
  // `...(typeof e.weight === 'number' ? { weight: e.weight } : {})`
  //   → RED on the authored-25 term, GREEN on the authored-20 one:
  //     FAIL  curated pack weights survive the trip to the frame
  //       expected 20 to be 25 // Object.is equality   (API)
  //   Kubernetes stayed green because its authored weight IS 20 — which is the
  //   whole reason both terms are asserted. A test that only checked Kubernetes
  //   would be satisfied by the default and would never see this regression.
  //   Restored; green.
  it('curated pack weights survive the trip to the frame', () => {
    const db = freshDb();
    db.settings.write(U, SETTINGS_KEY_SCENARIO_CARD, {
      professions: [], domains: [], packs: ['tech-dev'], terms: [],
    });
    const map = hotwordMap(loadHotwords(db.settings, U));
    expect(map.API).toBe(25);        // authored 25 — differs from the default
    expect(map.Kubernetes).toBe(20); // authored 20 — equals the default
    // and every pack entry is present, not just the two named above
    for (const e of composeDictionary(['tech-dev'])) expect(map[e.term]).toBeTypeOf('number');
  });

  // T6. FAIL-LOUD, asserted by DIRECT CALL (see the file header for why a route
  // test would be dishonest here). A present-but-malformed scenario.card must
  // throw SETTINGS_SCHEMA_INVALID rather than degrade transcription invisibly.
  // Fixture is the one from compose-scenario.test.ts verbatim: professions must
  // be an array of strings, so a number is invalid.
  //
  // REVERSE CONTROL (executed): engine-factory.ts, wrapped the resolver call —
  //     let rules; try { rules = resolveReplacementRules(settings, userId); }
  //     catch { return undefined; }
  //   → RED:
  //     FAIL  a present-but-malformed scenario.card throws, it does not degrade
  //       expected undefined to be an instance of ServerError
  //   Restored; green.
  it('a present-but-malformed scenario.card throws, it does not degrade', () => {
    const db = freshDb();
    db.settings.write(U, SETTINGS_KEY_SCENARIO_CARD, { professions: [42], domains: [], packs: [], terms: [] });
    let thrown: unknown;
    try { loadHotwords(db.settings, U); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ServerError);
    expect((thrown as ServerError).code).toBe('SETTINGS_SCHEMA_INVALID');
  });

  it('an ABSENT scenario.card does NOT throw — silence is the other half of the contract', () => {
    // Fail-loud must not become fail-noisy: a user who has configured nothing is
    // not a corrupt profile. Absent card + absent dictionary → undefined, and
    // the open frame stays baseline-identical.
    const db = freshDb();
    expect(() => loadHotwords(db.settings, U)).not.toThrow();
    expect(loadHotwords(db.settings, U)).toBeUndefined();
  });

  // T7. THE MOBILE-PERSONA REGRESSION, as an executable assertion.
  // The mobile custom-terms UI writes EXCLUSIVELY to scenario.card.terms and the
  // phone has no way to reach stt.dictionary at all. Under the old single-source
  // read this returned `undefined` — a mobile user's custom terminology reached
  // no engine, ever. This is the corrected problem statement, pinned.
  //
  // REVERSE CONTROL: covered by T4's revert (same break). Observed:
  //     FAIL  ONLY scenario.card.terms set → the terms still reach the engine
  //       expected undefined not to be undefined
  // i.e. the old code returned nothing at all for this user — no hotwords field
  // on the open frame, no terminology, ever.
  it('ONLY scenario.card.terms set → the terms still reach the engine', () => {
    const db = freshDb();
    db.settings.write(U, SETTINGS_KEY_SCENARIO_CARD, {
      professions: [], domains: [], packs: [], terms: ['FlowMic', '飞麦克项目'],
    });
    // no stt.dictionary row at all — the phone cannot write one
    expect(db.settings.read(U, 'stt.dictionary')).toBeNull();

    const json = loadHotwords(db.settings, U);
    expect(json).not.toBeUndefined();
    const map = hotwordMap(json);
    expect(map.FlowMic).toBe(20);
    expect(map['飞麦克项目']).toBe(20);
  });
});
