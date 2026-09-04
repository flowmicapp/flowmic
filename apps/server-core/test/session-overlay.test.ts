// settings/session-overlay.ts — the repo view the STT and compose factories read
// phone-owned preferences through (design D2, owner rulings 2026-09-03).
//
// 🔴 The two cases that matter most are the reverse controls, because each
// pins a failure direction the design table (task book §2) names:
//   · "the bundle WINS over a contradicting stored row" — without it, a stale
//     database row could keep acting from a server the user cannot see;
//   · "an absent bundle key answers null and the database row is NOT READ" —
//     the difference between "the phone holds no such preference" and "fall
//     back to whatever the server still has", which is the exact thing the
//     owner's note (配置不进云端) forbids. Asserted on the READ itself (a
//     recording repo), not only on the resolved value: a value-only assertion
//     would pass for an overlay that read the row and then discarded it, and
//     that implementation would still be one refactor away from leaking it.
//
// REVERSE CONTROL (executed 2026-09-03, this tree; restored byte-identical,
// sha256 compared):
//   session-overlay.ts `read()` — replaced the phone-owned branch with
//   `return synthesised(userId, key) ?? db.read(userId, key)` (i.e. fall
//   through to the database when the bundle lacks the key) → 3 red / 26 green
//   across this file + settings-effect-probe.test.ts:
//     FAIL  session-overlay > 🔴 bundle present but key ABSENT ⇒ null, and the database row is NOT read
//       AssertionError: expected { user_id: 'u', …(3) } to be null
//     FAIL  session-overlay > a bundle without stt.polish resolves the DEFAULT from the (database) llm.config, not from a stored polish row
//       AssertionError: expected { enabled: false } to deeply equal { enabled: true }
//     FAIL  settings-effect-probe > probe 7 > 🔴 REVERSE CONTROL — the bundle WINS over a contradicting stored row, and an absent bundle key never falls through to one
//       AssertionError: expected '{"StaleRowTerm":20}' to be undefined
//   The first draft of this header predicted 4 red including the readAll and
//   retired-key cases; those stayed GREEN (the break was in read() only, and
//   they do not go through the absent-key branch). The measured 3 is what
//   stands. Note the second line: it is the stored `{enabled:false}` polish row
//   leaking through as the session's answer — the exact defect. Restored; all green.

import { describe, expect, it } from 'vitest';
import {
  SETTINGS_KEY_SCENARIO_CARD,
  SETTINGS_KEY_SCENARIO_INFERENCE,
  SETTINGS_KEY_STT_POLISH,
  SETTINGS_KEY_STT_REFINE,
} from '@flowmic/protocol';
import type { SettingRow, SettingsRepo } from '../src/db/repos/settings.repo';
import {
  PHONE_OWNED_SETTING_KEYS,
  RETIRED_SETTING_KEY_STT_DICTIONARY,
  isPhoneOwnedKey,
  overlaySettings,
} from '../src/settings/session-overlay';
import { readSttPolish } from '../src/stt/stt-polish-settings';
import { readSttRefine } from '../src/stt/stt-refine-settings';
import { resolveReplacementRules, resolveScenarioContext } from '../src/compose/scenario-context';
import { ServerError } from '../src/errors';

const U = 'u';

/** A SettingsRepo that records every key its read() is asked for — the same
 *  instrument settings-anchors.test.ts uses, because "was the row read" is the
 *  fact this file is about. */
function recordingRepo(store: Record<string, unknown>, reads: string[]): SettingsRepo {
  return {
    readAll: () => Object.entries(store).map(([key, value]) => ({ user_id: U, key, value, updated_at: 'stored' })),
    read: (userId, key): SettingRow | null => {
      reads.push(key);
      return key in store ? { user_id: userId, key, value: store[key], updated_at: 'stored' } : null;
    },
    write: (userId, key, value) => ({ user_id: userId, key, value, updated_at: 'written' }),
    remove: () => false,
  };
}

const CARD = { professions: ['eye surgeon'], domains: [], packs: [], terms: [{ term: 'Kubernetes', aliases: ['k8s'] }] };

describe('the phone-owned key set', () => {
  it('is exactly the four keys the readers anchor on, spelled as the protocol SSOT spells them', () => {
    expect([...PHONE_OWNED_SETTING_KEYS].sort()).toEqual(
      [SETTINGS_KEY_SCENARIO_CARD, SETTINGS_KEY_STT_POLISH, SETTINGS_KEY_STT_REFINE, SETTINGS_KEY_SCENARIO_INFERENCE].sort(),
    );
    expect(RETIRED_SETTING_KEY_STT_DICTIONARY).toBe('stt.dictionary');
    for (const k of PHONE_OWNED_SETTING_KEYS) expect(isPhoneOwnedKey(k)).toBe(true);
    for (const k of ['stt.routings', 'llm.config', 'scenario.inference.overrides', 'stt.dictionary', 'device.pc_name']) {
      expect(isPhoneOwnedKey(k)).toBe(false);
    }
  });
});

describe('overlaySettings — prefs === null (an old phone)', () => {
  it('returns the database repo ITSELF, not a wrapper — today\'s behaviour byte for byte', () => {
    const db = recordingRepo({ 'stt.polish': { enabled: false } }, []);
    expect(overlaySettings(db, null)).toBe(db);
  });
});

describe('overlaySettings — a bundle is present', () => {
  it('a phone-owned key present in the bundle answers a synthesised row (no stamp), and the database is NOT asked', () => {
    const reads: string[] = [];
    const db = recordingRepo({ 'stt.polish': { enabled: false } }, reads);
    const view = overlaySettings(db, { 'stt.polish': { enabled: true, strength: 'smooth' } });
    const row = view.read(U, 'stt.polish');
    expect(row).toEqual({ user_id: U, key: 'stt.polish', value: { enabled: true, strength: 'smooth' }, updated_at: '' });
    expect(reads).toEqual([]);
  });

  it('🔴 bundle present but key ABSENT ⇒ null, and the database row is NOT read', () => {
    const reads: string[] = [];
    const db = recordingRepo({ 'stt.polish': { enabled: false }, [SETTINGS_KEY_SCENARIO_CARD]: CARD }, reads);
    // The phone pushed ONLY its refine switch — it holds no polish preference
    // and no card. Both must read as "not set", and the rows must not be touched.
    const view = overlaySettings(db, { 'stt.refine': { enabled: true } });
    expect(view.read(U, 'stt.polish')).toBeNull();
    expect(view.read(U, SETTINGS_KEY_SCENARIO_CARD)).toBeNull();
    expect(view.read(U, SETTINGS_KEY_SCENARIO_INFERENCE)).toBeNull();
    expect(reads).toEqual([]);
  });

  it('every other key delegates to the database untouched', () => {
    const reads: string[] = [];
    const routings = [{ language: '*', engine_id: 'sherpa-local' }];
    const db = recordingRepo({ 'stt.routings': routings, 'llm.config': { model: 'm' } }, reads);
    const view = overlaySettings(db, { 'stt.polish': { enabled: true } });
    expect(view.read(U, 'stt.routings')?.value).toBe(routings);
    expect(view.read(U, 'llm.config')?.value).toEqual({ model: 'm' });
    expect(view.read(U, 'scenario.inference.overrides')).toBeNull();
    expect(reads).toEqual(['stt.routings', 'llm.config', 'scenario.inference.overrides']);
  });

  it('the retired stt.dictionary key answers null under a bundle regardless of the database', () => {
    const reads: string[] = [];
    const db = recordingRepo({ 'stt.dictionary': [{ term: 'Kubernetes' }] }, reads);
    expect(overlaySettings(db, {}).read(U, 'stt.dictionary')).toBeNull();
    expect(reads).toEqual([]);
    // …while an old phone (null prefs) still gets whatever the database says —
    // the retirement is enforced by the readers having no code for it, not here.
    expect(overlaySettings(db, null).read(U, 'stt.dictionary')?.value).toEqual([{ term: 'Kubernetes' }]);
  });

  it('readAll hides the database\'s phone-owned rows and appends the bundle\'s', () => {
    const db = recordingRepo({ 'stt.routings': [], 'stt.polish': { enabled: false }, 'stt.dictionary': [] }, []);
    const keys = overlaySettings(db, { 'stt.refine': { enabled: true } }).readAll(U).map((r) => r.key);
    expect(keys).toEqual(['stt.routings', 'stt.refine']);
  });

  it('a write or remove of a phone-owned key through the overlay throws — nothing on this path may store one', () => {
    const db = recordingRepo({}, []);
    const view = overlaySettings(db, {});
    expect(() => view.write(U, 'stt.polish', { enabled: true })).toThrow(/phone-owned/);
    expect(() => view.remove(U, 'stt.dictionary')).toThrow(/phone-owned/);
    // …and a non-phone key still writes through.
    expect(view.write(U, 'stt.routings', []).updated_at).toBe('written');
  });

  it('a bundle value of `undefined` reads as absent (the same as a stored null value)', () => {
    const db = recordingRepo({}, []);
    expect(overlaySettings(db, { 'stt.polish': undefined }).read(U, 'stt.polish')).toBeNull();
  });
});

describe('the production readers over the overlay — validation stays in the readers', () => {
  it('🔴 REVERSE CONTROL: DB stt.polish={enabled:false} + bundle {enabled:true} ⇒ readSttPolish sees true, and the row was never read', () => {
    const reads: string[] = [];
    const db = recordingRepo({ 'stt.polish': { enabled: false } }, reads);
    expect(readSttPolish(overlaySettings(db, { 'stt.polish': { enabled: true } }), U)).toEqual({ enabled: true });
    expect(reads).toEqual([]);
    // Positive control: the same database, read by an old phone, DOES say false.
    expect(readSttPolish(overlaySettings(db, null), U)).toEqual({ enabled: false });
  });

  it('readSttRefine / readCard / resolveReplacementRules read the bundle, aliases included', () => {
    const db = recordingRepo({}, []);
    const view = overlaySettings(db, {
      'stt.refine': { enabled: true, min_utterance_ms: 15_000 },
      [SETTINGS_KEY_SCENARIO_CARD]: CARD,
    });
    expect(readSttRefine(view, U)).toEqual({ enabled: true, min_utterance_ms: 15_000 });
    expect(resolveScenarioContext(view, U)).toEqual({ professions: ['eye surgeon'], domains: [], terms: ['Kubernetes'] });
    expect(resolveReplacementRules(view, U)).toEqual([{ canonical: 'Kubernetes', aliases: ['k8s'] }]);
  });

  it('a malformed bundle value fails LOUD in the reader exactly as a malformed stored row does', () => {
    const db = recordingRepo({}, []);
    const bad = overlaySettings(db, { 'stt.polish': { enabled: 'yes' }, [SETTINGS_KEY_SCENARIO_CARD]: { professions: [42] } });
    for (const fn of [() => readSttPolish(bad, U), () => resolveScenarioContext(bad, U)]) {
      let thrown: unknown;
      try { fn(); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(ServerError);
      expect((thrown as ServerError).code).toBe('SETTINGS_SCHEMA_INVALID');
    }
  });

  it('a bundle without stt.polish resolves the DEFAULT from the (database) llm.config, not from a stored polish row', () => {
    const reads: string[] = [];
    const db = recordingRepo(
      { 'stt.polish': { enabled: false }, 'llm.config': { protocol: 'openai-compatible', endpoint: 'http://x/v1', model: 'm', api_key: '' } },
      reads,
    );
    // Default WITH an LLM is ON — the stored OFF must not be what answers.
    expect(readSttPolish(overlaySettings(db, {}), U)).toEqual({ enabled: true });
    expect(reads).not.toContain('stt.polish');
    expect(reads).toContain('llm.config');
  });
});
