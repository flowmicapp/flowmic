import { describe, it, expect } from 'vitest';
import {
  ADDITIONAL_PRIVATE_CIDRS,
  ADDITIONAL_PRIVATE_CIDRS_ENV,
  readAdditionalPrivateCidrs,
  CUSTOM_PRESET_ID,
  LLM_PRESET_GROUPS,
  STT_PRESET_GROUPS,
  STT_PRESETS,
  LLM_PRESETS,
  findSttPreset,
  findLlmPreset,
  llmPresetsByGroup,
  sttPresetsByGroup,
} from '../src/engine-presets';

// WP-R23-0: catalogue count guard + the built-in offline preset shape. The
// count assertion is the anti-façade lock for the preset catalogue — any add/
// remove must pass through here.
describe('STT preset catalogue', () => {
  it('holds exactly 8 bundled STT presets, all unique ids', () => {
    // 7 → 8 at 0.3.43: the explicit `custom` row (06 §7.1 ②).
    expect(STT_PRESETS.length).toBe(8);
    expect(new Set(STT_PRESETS.map((p) => p.id)).size).toBe(STT_PRESETS.length);
  });

  it('holds exactly 12 bundled LLM presets', () => {
    // 3 → 12 at 0.3.43 (owner Q1): 8 cloud vendors + 3 self-hosted + custom.
    expect(LLM_PRESETS.length).toBe(12);
    expect(new Set(LLM_PRESETS.map((p) => p.id)).size).toBe(LLM_PRESETS.length);
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
      // 🔴 THE `custom` ROW IS EXEMPT, AND THE EXEMPTION IS THE POINT OF THE ROW.
      // Its endpoint is blank BECAUSE it is the 「I will supply this myself」
      // choice; a placeholder address here would be the catalogue answering a
      // question the user is being asked. Written as an id check rather than a
      // 「skip anything blank」 rule, so a REAL vendor row losing its endpoint
      // still fails this test.
      if (p.id === CUSTOM_PRESET_ID) {
        expect(p.endpoint).toBe('');
        continue;
      }
      expect(typeof p.endpoint).toBe('string');
      expect(p.endpoint).not.toBe('');
    }
  });
});

// ── 0.3.43 vendor catalogue (owner 2026-08-28 Q1/Q2/Q3; contract 06 §7.1) ─────
describe('the catalogue is a vendor list, and old ids still resolve', () => {
  // 🔴 THE HIGHEST-VALUE ASSERTION IN THIS FILE. §7.1 ③: a stored `preset_id`
  // outlives the release that wrote it, so renaming a row silently unconfigures
  // every machine that chose it — and the symptom would be a settings page that
  // reads 「请选择」 on a PC that was working yesterday. These three ids predate
  // this card and must keep resolving forever.
  it.each(['lan-vllm-qwen35', 'lan-ollama-gemma3', 'cloud-anthropic-claude'])(
    'the pre-0.3.43 LLM preset id %s still resolves',
    (id) => {
      expect(findLlmPreset(id)).toBeDefined();
    },
  );

  it.each([
    'builtin-sherpa-local', 'lan-funasr-ws', 'lan-whisper-http',
    'lan-sensevoice', 'lan-funspeech', 'cloud-deepgram', 'cloud-openai-realtime',
  ])('the pre-0.3.43 STT preset id %s still resolves', (id) => {
    expect(findSttPreset(id)).toBeDefined();
  });

  it('Anthropic keeps its native protocol and its /v1-less base URL', () => {
    const p = findLlmPreset('cloud-anthropic-claude');
    expect(p?.protocol).toBe('anthropic');
    // The adapter appends the route; a `/v1` here would double it.
    expect(p?.endpoint).toBe('https://api.anthropic.com');
  });

  it('the eight ruled cloud vendors are all present', () => {
    // Named one by one rather than counted: a count passes while the wrong eight
    // are in the list, and the owner ruled a SET, not a quantity.
    const cloud = LLM_PRESETS.filter((p) => p.group === 'cloud').map((p) => p.id);
    expect(cloud).toEqual([
      'cloud-openai', 'cloud-openrouter', 'cloud-deepseek', 'cloud-anthropic-claude',
      'cloud-gemini', 'cloud-groq', 'cloud-mistral', 'cloud-xai',
    ]);
  });

  it('every CLOUD endpoint is https — a vendor row may never be plaintext', () => {
    // BYOK means the user's own API key travels this URL. A cloud preset on
    // `http://` would ship a credential-leaking default that looks configured.
    for (const p of LLM_PRESETS.filter((x) => x.group === 'cloud')) {
      expect(p.endpoint, p.id).toMatch(/^https:\/\//);
    }
    for (const p of STT_PRESETS.filter((x) => x.group === 'cloud')) {
      expect(p.endpoint, p.id).toMatch(/^wss:\/\/|^https:\/\//);
    }
  });

  it('every LOCAL endpoint is localhost — no machine of ours is in the menu', () => {
    // The 0.3.8 rule, now enforced per-group rather than by a global IP sweep:
    // this catches a self-hosted row gaining a REACHABLE address, which a
    // regex for two specific private ranges would not.
    for (const p of [...LLM_PRESETS, ...STT_PRESETS].filter((x) => x.group === 'local')) {
      expect(p.endpoint, p.id).toMatch(/^(https?|wss?):\/\/localhost(:\d+)?(\/|$)/);
    }
  });

  it('both catalogues carry exactly one explicit custom row, fully blank', () => {
    const llm = findLlmPreset(CUSTOM_PRESET_ID);
    expect(llm?.group).toBe('custom');
    expect(llm?.endpoint).toBe('');
    expect(llm?.api_key).toBe('');
    expect(llm?.model).toBe('');
    // The protocol is NOT blank: it is an enum with no empty member, and
    // openai-compatible is the shape almost every endpoint speaks.
    expect(llm?.protocol).toBe('openai-compatible');

    const stt = findSttPreset(CUSTOM_PRESET_ID);
    expect(stt?.group).toBe('custom');
    expect(stt?.endpoint).toBe('');
    expect(LLM_PRESETS.filter((p) => p.group === 'custom')).toHaveLength(1);
    expect(STT_PRESETS.filter((p) => p.group === 'custom')).toHaveLength(1);
  });

  it('every preset belongs to a declared group — no row can hide from the menu', () => {
    // 🔴 EXHAUSTIVENESS IN THE OTHER DIRECTION, and this is the assertion that
    // earns its keep. TypeScript already stops a preset carrying a group that
    // does not exist; nothing stops the GROUPS ARRAY omitting a group that
    // presets use — and the consequence is silent: `llmPresetsByGroup` would
    // simply never emit that section, so the rows vanish from the dropdown while
    // every type checks and every count still passes.
    for (const p of LLM_PRESETS) expect(LLM_PRESET_GROUPS, p.id).toContain(p.group);
    for (const p of STT_PRESETS) expect(STT_PRESET_GROUPS, p.id).toContain(p.group);

    // …and the round trip: sectioning loses nothing.
    expect(llmPresetsByGroup().flatMap((s) => s.presets.map((p) => p.id)))
      .toEqual(LLM_PRESETS.map((p) => p.id));
    expect(sttPresetsByGroup().flatMap((s) => s.presets.map((p) => p.id)))
      .toEqual(STT_PRESETS.map((p) => p.id));
  });

  it('no empty section is offered', () => {
    for (const s of [...llmPresetsByGroup(), ...sttPresetsByGroup()]) {
      expect(s.presets.length, s.group).toBeGreaterThan(0);
    }
  });

  it('🔴 soniox is NOT in the STT catalogue — the sidecar cannot construct it', () => {
    // owner Q2 asked for a Soniox BYOK preset CONDITIONALLY: 「否则只报告不加项」.
    // The condition failed (06 §7.1 ⑦ carries the three readings). This assertion
    // is what stops a future reader from 「completing」 the catalogue from the
    // ruling's first half alone — the row it would add throws on selection,
    // because `engine-factory`'s `case 'soniox'` requires a private package that
    // `sidecar-excludes-stt-cloud.test.ts` PROVES is absent from the bundle.
    expect(STT_PRESETS.some((p) => p.engine === 'soniox')).toBe(false);
  });

  it('no key, real or placeholder, ships in a cloud row', () => {
    for (const p of LLM_PRESETS.filter((x) => x.group === 'cloud')) {
      expect(p.api_key, p.id).toBe('');
    }
  });
});
