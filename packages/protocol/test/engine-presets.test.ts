import { describe, it, expect } from 'vitest';
import {
  ADDITIONAL_PRIVATE_CIDRS,
  ADDITIONAL_PRIVATE_CIDRS_ENV,
  readAdditionalPrivateCidrs,
  STT_PRESETS,
  LLM_PRESETS,
  findSttPreset,
} from '../src/engine-presets';

// WP-R23-0: catalogue count guard + the built-in offline preset shape. The
// count assertion is the anti-façade lock for the preset catalogue — any add/
// remove must pass through here.
describe('STT preset catalogue', () => {
  it('holds exactly 7 bundled STT presets, all unique ids', () => {
    expect(STT_PRESETS.length).toBe(7);
    expect(new Set(STT_PRESETS.map((p) => p.id)).size).toBe(STT_PRESETS.length);
  });

  it('holds exactly 3 bundled LLM presets', () => {
    expect(LLM_PRESETS.length).toBe(3);
  });

  it("🔴 OSS-DEFAULTS: the additional-CIDR overlay ships EMPTY — nobody's LAN is compiled in", () => {
    // Was `toEqual(['100.64.7.0/24'])` — the owner's office LAN, in every copy
    // of the app. Empty is the FAIL-CLOSED direction: with no overlay a
    // non-RFC1918 address classifies `external`, so the consent screen falls
    // back to 「程序无法自动判定」 instead of reassuring a stranger about an
    // address that is publicly-registered space on THEIR network.
    expect(ADDITIONAL_PRIVATE_CIDRS).toEqual([]);
    // Pinned as a STRING SEARCH over the module's own value, not field by
    // field: a list assertion only catches the entry somebody remembered to
    // look at, and this is about the one nobody thought of.
    expect(JSON.stringify(ADDITIONAL_PRIVATE_CIDRS)).not.toMatch(/172\.77\.77|192\.168\.188/);
  });

  it('🔴 OSS-DEFAULTS: a deployment declares its ranges through the env var', () => {
    // The escape hatch that keeps the owner's boxes classifying exactly as
    // before. Exercised through `readAdditionalPrivateCidrs` rather than the
    // const, because the const is a MODULE-LOAD SNAPSHOT — setting the variable
    // here could never reach it, and a test that pretended otherwise would be
    // measuring its own harness.
    const withEnv = { process: { env: { [ADDITIONAL_PRIVATE_CIDRS_ENV]: '100.64.7.0/24' } } };
    expect(readAdditionalPrivateCidrs(withEnv)).toEqual(['100.64.7.0/24']);
    // Multiple ranges, whitespace-tolerant; blanks are dropped rather than
    // becoming an empty CIDR that `classifyDestination` would have to ignore.
    expect(readAdditionalPrivateCidrs({
      process: { env: { [ADDITIONAL_PRIVATE_CIDRS_ENV]: ' 100.64.7.0/24 , , 10.9.0.0/16 ' } },
    })).toEqual(['100.64.7.0/24', '10.9.0.0/16']);
    // A build-time stamp (the desktop's vite `define`) wins over the Node path,
    // and neither present means EMPTY — never a throw, never a guess.
    expect(readAdditionalPrivateCidrs({ __FLOWMIC_ADDITIONAL_PRIVATE_CIDRS__: '10.1.0.0/16' }))
      .toEqual(['10.1.0.0/16']);
    expect(readAdditionalPrivateCidrs({})).toEqual([]);
  });

  it('includes the built-in offline sherpa-local preset with NO endpoint', () => {
    const p = findSttPreset('builtin-sherpa-local');
    expect(p).toBeDefined();
    expect(p?.engine).toBe('sherpa-local');
    // Local in-process engine — there is no network endpoint (WP-R23-0).
    expect(p?.endpoint).toBeUndefined();
    expect(p?.language_hint).toBe('*');
    expect(p?.label).toMatch(/offline/i);
  });

  it('every network (non-sherpa-local) preset still carries an endpoint', () => {
    for (const p of STT_PRESETS) {
      if (p.engine === 'sherpa-local') continue;
      expect(typeof p.endpoint).toBe('string');
      expect(p.endpoint).not.toBe('');
    }
  });
});
