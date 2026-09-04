// WP-R2-2 / WP-R4-6: settings-key-drift GET-anchor guard (decision 2026-07-23-
// settings-key-drift-literal-anchors). The desktop has four literal-key SET
// anchors (updateSetting('llm.config' | 'stt.routings' | 'scenario.card' |
// 'stt.polish')); this test pins that the SERVER's real read points ask the repo
// for the EXACT same literal keys — the mechanical "a key has a live reader AND
// a live writer" proof the anti-façade drift lint gives, verified behaviourally
// here so the two halves can never silently drift apart.
//
// 2026-09-03 (WP-B2) adds a FIFTH: 'scenario.inference'. Its UI half is not an
// `updateSetting` at all — owner moved the four phone-owned keys off
// `settings:update` and onto the transcription request, so the phone's SET
// anchor is `carrySetting('scenario.inference', …)` in
// apps/mobile/lib/src/settings/phone_prefs_payload.dart. The server half landed
// in the same merge, which is what the old note in scenario-infer-store.ts
// asked for by name; this file is where "it really asks the repo for THAT
// string" is proven rather than asserted in prose.

import { describe, expect, it } from 'vitest';
import {
  SETTINGS_KEY_SCENARIO_CARD,
  SETTINGS_KEY_SCENARIO_INFERENCE,
  SETTINGS_KEY_STT_POLISH,
} from '@flowmic/protocol';
import type { SettingRow, SettingsRepo } from '../src/db/repos/settings.repo';
import { loadRoutings } from '../src/stt/engine-factory';
import {
  STT_POLISH_DEFAULT_WITH_LLM,
  STT_POLISH_DEFAULT_WITHOUT_LLM,
  readSttPolish,
} from '../src/stt/stt-polish-settings';
import { ScenarioInferenceStore } from '../src/compose/scenario-infer-store';
import { resolveLlmConfigWithSource } from '../src/compose';
import { ServerError } from '../src/errors';

/** A SettingsRepo that records every key its read() is asked for. */
function recordingRepo(store: Record<string, unknown>, reads: string[]): SettingsRepo {
  return {
    readAll: () => [],
    read: (userId, key): SettingRow | null => {
      reads.push(key);
      return key in store ? { user_id: userId, key, value: store[key], updated_at: '' } : null;
    },
    write: () => {
      throw new Error('recordingRepo is read-only');
    },
    remove: () => false,
  };
}

describe('settings-key-drift GET anchors read the exact literal keys the desktop writes', () => {
  it("loadRoutings reads 'stt.routings' (engine-factory GET anchor)", () => {
    const reads: string[] = [];
    const repo = recordingRepo({ 'stt.routings': [{ language: 'zh-CN', engine_id: 'funasr' }] }, reads);
    const routings = loadRoutings(repo, 'u1');
    expect(reads).toContain('stt.routings');
    expect(routings).toHaveLength(1);
  });

  it("resolveLlmConfigWithSource reads 'llm.config' (llm-config GET anchor)", () => {
    // M4 renamed the resolver (it now returns the config WITH its provenance) but
    // the GET anchor it owns is unchanged — that is the whole point of pinning the
    // anchor behaviourally instead of by symbol name.
    const reads: string[] = [];
    const repo = recordingRepo(
      { 'llm.config': { protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: 'EMPTY', model: 'm' } },
      reads,
    );
    const selected = resolveLlmConfigWithSource(repo, 'u1');
    expect(reads).toContain('llm.config');
    expect(selected.cfg.model).toBe('m');
    expect(selected.source).toBe('user'); // it came out of the user's own row
  });

  it("'scenario.card' literal == the protocol SSOT constant (desktop + mobile + server all agree)", () => {
    expect(SETTINGS_KEY_SCENARIO_CARD).toBe('scenario.card');
  });

  it("'stt.polish' literal == the protocol SSOT constant (WP-R4-6 GET/SET anchors agree)", () => {
    // stt-polish-settings.ts reads via readSetting('stt.polish') and the desktop
    // writes via updateSetting('stt.polish'); pin the literal == SSOT constant so
    // the two drift-lint anchors can never silently drift apart.
    expect(SETTINGS_KEY_STT_POLISH).toBe('stt.polish');
  });

  it("readSttPolish reads 'stt.polish' (stt-polish-settings GET anchor) and returns {enabled}", () => {
    const reads: string[] = [];
    const repo = recordingRepo({ 'stt.polish': { enabled: true } }, reads);
    expect(readSttPolish(repo, 'u1')).toEqual({ enabled: true });
    expect(reads).toContain('stt.polish');
    expect(readSttPolish(recordingRepo({ 'stt.polish': { enabled: false } }, []), 'u1')).toEqual({ enabled: false });
  });

  it('readSttPolish resolves the default from whether a usable LLM exists (POLISH-CFG)', () => {
    // 🔴 This case has now been rewritten TWICE by the same mechanism, and that is
    // the point worth keeping. It first read "defaults OFF" with a literal
    // `{enabled:false}`; owner ruled "AI polish defaults to fully on" and the literal went red, so
    // it was rewritten against a constant. On 2026-08-09 the constant itself
    // stopped being the answer: owner ruled the default follows "whether an LLM is configured", so
    // there is no single value left for this case to assert. It now states the
    // RULE, which is what it was always trying to be about.
    //
    // No llm.config and no managed default ⇒ nothing to call ⇒ the feature does
    // not arm itself behind the user's back.
    expect(readSttPolish(recordingRepo({}, []), 'u1')).toEqual(STT_POLISH_DEFAULT_WITHOUT_LLM);

    // A usable config ⇒ owner's "once LLM is configured, it needs to be enabled".
    const withLlm = recordingRepo(
      { 'llm.config': { protocol: 'openai-compatible', endpoint: 'http://x/v1', model: 'm', api_key: '' } },
      [],
    );
    expect(readSttPolish(withLlm, 'u1')).toEqual(STT_POLISH_DEFAULT_WITH_LLM);
  });

  it('🔴 an explicit row is honoured at BOTH values — this card moved the default, not the choice', () => {
    // Ruling §implementation-boundary 2. Without this, an implementation that forced the resolved
    // default over a stored row would pass the case above and silently overrule
    // every user who had ever touched the switch.
    const onWithoutLlm = recordingRepo({ 'stt.polish': { enabled: true } }, []);
    expect(readSttPolish(onWithoutLlm, 'u1')).toEqual({ enabled: true });
    const offWithLlm = recordingRepo(
      {
        'stt.polish': { enabled: false },
        'llm.config': { protocol: 'openai-compatible', endpoint: 'http://x/v1', model: 'm', api_key: '' },
      },
      [],
    );
    expect(readSttPolish(offWithLlm, 'u1')).toEqual({ enabled: false });
  });

  it('readSttPolish fails loud (SETTINGS_SCHEMA_INVALID) on present-but-malformed / non-strict', () => {
    for (const bad of [true, { enabled: 'yes' }, { enabled: true, extra: 1 }, []]) {
      let thrown: unknown;
      try {
        readSttPolish(recordingRepo({ 'stt.polish': bad }, []), 'u1');
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `expected throw for ${JSON.stringify(bad)}`).toBeInstanceOf(ServerError);
      expect((thrown as ServerError).code).toBe('SETTINGS_SCHEMA_INVALID');
    }
  });

  it("the scenario-inference store reads 'scenario.inference' (WP-B2 GET anchor) and the literal == the protocol SSOT constant", () => {
    // The SET half is the phone's `carrySetting('scenario.inference', …)`; this
    // is the GET half, and the lint refuses either alone. Behavioural, not by
    // symbol name: what matters is the STRING the repo is asked for.
    const reads: string[] = [];
    const repo = recordingRepo(
      // NOT granted: the read is the point, and a granted row would send the
      // store on to an LLM this case has no business making.
      { 'scenario.inference': { granted: false, granted_for: 'external' } },
      reads,
    );
    const store = new ScenarioInferenceStore({
      settings: repo,
      // Never reached: the row below says NOT granted, so the gate closes before
      // any round trip. Present because the deps are required by design (a
      // defaulted no-op meter is the façade 13-LESSONS-LEARNED §7 F1 ② bans).
      streamerFor: () => { throw new Error('no LLM call is expected here'); },
      recordUsage: () => { throw new Error('no metering is expected here'); },
      schedule: () => { throw new Error('nothing should be scheduled here'); },
      logLine: () => {},
    });
    // No `consent` argument ⇒ the store falls back to its OWN read, which is the
    // path that carries the anchor.
    store.resolve({
      userId: 'u1',
      processName: 'zzz-not-a-known-app.exe',
      cfg: { protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: '', model: 'm' },
      byok: false,
    });
    expect(reads).toContain('scenario.inference');
    expect(SETTINGS_KEY_SCENARIO_INFERENCE).toBe('scenario.inference');
  });

  it('readSttPolish re-snapshots per call (audio:start cadence — a settings:update lands on the NEXT take)', () => {
    // The bridge freezes its polish config at construction; the factory calls
    // readSttPolish fresh on every audio:start. So a mid-session flip is invisible
    // to the running session and picked up on the next — proven here at the read.
    const store: Record<string, unknown> = { 'stt.polish': { enabled: true } };
    const repo = recordingRepo(store, []);
    expect(readSttPolish(repo, 'u1')).toEqual({ enabled: true });
    store['stt.polish'] = { enabled: false };
    expect(readSttPolish(repo, 'u1')).toEqual({ enabled: false });
  });
});
