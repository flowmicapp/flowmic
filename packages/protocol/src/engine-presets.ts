// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md (reference infrastructure / presets)
//   F-1903 (engine-presets.ts with self-hosted presets — FunASR ws / Whisper
//     http / SenseVoice / vLLM / Ollama)
//
// Bundled preset catalogue surfaced in Settings → STT and Settings → LLM.
// User-supplied API keys are never co-located here; they live in
// `user_settings` (encrypted, prefix `enc:v1:`) per F-705.
//
// 🔴 IN-PLACE CORRECTION (0.3.8). This header used to continue:
//   「LAN IPs and model paths are not secrets and are kept in source (per
//    CLAUDE.md: docs/code LAN presets are R&D config, not production).」
// Kept because it names the mistake exactly: the question was never whether
// those addresses are SECRET. They are not. The question is whether one
// person's office machines belong in every user's settings menu, and they do
// not — see the note above STT_PRESETS for the owner's ruling and what replaced
// them. 「not a secret」 answered a question nobody had asked.

import type { LlmProtocol, SttEngineId } from './types';

/** Env var naming the deployment's extra private ranges — see
 *  [ADDITIONAL_PRIVATE_CIDRS]. Comma-separated CIDRs, e.g.
 *  `FLOWMIC_ADDITIONAL_PRIVATE_CIDRS=100.64.7.0/24`. */
export const ADDITIONAL_PRIVATE_CIDRS_ENV = 'FLOWMIC_ADDITIONAL_PRIVATE_CIDRS';

declare global {
  /** Stamped at BUILD time by apps/desktop/vite.config.ts `define`. Never
   *  assigned at run time; absent in Node, where the env var is read instead. */
  // eslint-disable-next-line no-var
  var __FLOWMIC_ADDITIONAL_PRIVATE_CIDRS__: string | undefined;
}

/** Where [readAdditionalPrivateCidrs] looks. Injectable so tests can drive both
 *  arms without a build — see the note on the literal expressions below. */
export interface AdditionalPrivateCidrSource {
  __FLOWMIC_ADDITIONAL_PRIVATE_CIDRS__?: string | undefined;
  process?: { env?: Record<string, string | undefined> } | undefined;
}

/**
 * Read the deployment's extra private CIDRs. Exported for tests, which cannot
 * use [ADDITIONAL_PRIVATE_CIDRS] to exercise the env path: that const is a
 * module-load snapshot, so an env var set after import can never reach it.
 *
 * Two sources, in order, because this module is bundled into BOTH a Node process
 * (server-core / the sidecar) and a browser bundle (the desktop WebView2
 * frontend, via Vite):
 *   1. `globalThis.__FLOWMIC_ADDITIONAL_PRIVATE_CIDRS__` — what
 *      apps/desktop/vite.config.ts `define` stamps in at BUILD time, since a
 *      WebView2 page has no `process.env` to read at run time;
 *   2. `process.env[ADDITIONAL_PRIVATE_CIDRS_ENV]` — the Node path, read through
 *      `globalThis.process` so the browser bundle does not throw on a name that
 *      is not defined there.
 *
 * 🔴 THE DEFAULT ARM MUST BE A LITERAL `globalThis.X` MEMBER EXPRESSION, and
 * this is not style. MEASURED with the repo's own esbuild 0.25.12 (2026-08-09,
 * machine dev-pc-a) — a `define` of `globalThis.__FOO__` substitutes ONLY
 * the written-out dotted form:
 *
 *     const g = globalThis;
 *     g['__FOO__']    → g["__FOO__"]          NOT substituted
 *     g.__FOO__       → g.__FOO__             NOT substituted
 *     globalThis.__FOO__ → "100.64.7.0/24"   substituted
 *
 * The first draft of this function read `g['__FLOWMIC_…__']` off an aliased
 * `globalThis`, so the desktop `define` would have stamped a value that nothing
 * ever read — a wiring that looks present, passes every test that injects its
 * own source object, and does nothing on a real build. That is the façade shape
 * CLAUDE.md names, and it was caught by measuring the bundler rather than by
 * reasoning about it.
 *
 * The injectable `source` parameter exists for tests ONLY; production always
 * takes the literal path.
 */
export function readAdditionalPrivateCidrs(source?: AdditionalPrivateCidrSource): readonly string[] {
  const raw = source
    ? source.__FLOWMIC_ADDITIONAL_PRIVATE_CIDRS__ ||
      source.process?.env?.[ADDITIONAL_PRIVATE_CIDRS_ENV] ||
      ''
    : // Literal expressions on purpose — see above.
      globalThis.__FLOWMIC_ADDITIONAL_PRIVATE_CIDRS__ ||
      (globalThis as AdditionalPrivateCidrSource).process?.env?.[ADDITIONAL_PRIVATE_CIDRS_ENV] ||
      '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Deployment-level CIDRs treated as private IN ADDITION to built-in RFC1918.
 *
 * Callers pass this into [classifyDestination] (desktop `inferenceDestination`)
 * or rely on [destinationOf]'s default. The classifier never hard-codes the
 * private-line range — that would break「代码禁写死，预设走 presets 包」
 * (CLAUDE.md / owner D1 2026-07-31). [classifyDestination] with no / empty
 * overlay stays RFC1918-only (fail closed).
 *
 * 🔴 OSS-DEFAULTS (0.3.0): THE DEFAULT IS NOW EMPTY. It used to be
 * `['100.64.7.0/24']` — the owner's office LAN, compiled into every copy of the
 * app. Two things were wrong with that. The obvious one: a stock install shipped
 * one stranger's network topology to every other stranger. The one that actually
 * bites: this overlay decides whether the scenario-inference consent screen calls
 * an endpoint `local` or `external`, so a build carrying somebody else's range
 * would tell a user 「这是标准私网地址段内的地址」 about an address that, on THEIR
 * network, is a publicly-registered one. A wrong reassurance is worse than the
 * 「程序无法自动判定」 sentence the empty default falls back to.
 *
 * Empty is FAIL-CLOSED: with no overlay a non-RFC1918 address classifies
 * `external`, which is the cautious answer, not the convenient one.
 *
 * The owner's environment keeps its old behaviour by DECLARING the range —
 * [ADDITIONAL_PRIVATE_CIDRS_ENV] in `/etc/flowmic-app/env` for the server, and
 * the same variable present at `vite build` time for the desktop bundle (see
 * apps/desktop/vite.config.ts). `10.0.0.*` still needs no entry: it is
 * already RFC1918.
 */
export const ADDITIONAL_PRIVATE_CIDRS: readonly string[] = readAdditionalPrivateCidrs();

/**
 * Which section of the menu a preset belongs to (0.3.43, owner 2026-08-28 Q1/Q2).
 * Contract: docs/rebuild/06-STT-ENGINE-LAYER.md §7.1 ②.
 *
 * 🔴 THIS IS A DATA-PLANE FIELD ONLY — NO WIRE SCHEMA CHANGES. Same standing as
 * `SttEngineId`: no zod schema in this package references `SttPreset` /
 * `LlmPreset`, so adding it moves no frame, keeps `whitelist=54` intact, needs no
 * PROTOCOL_SCHEMA_VERSION bump, and the relay does not need redeploying.
 * [measured 2026-08-28] `grep -n 'SttPreset\|LlmPreset' packages/protocol/src/*schema*.ts`
 * → zero hits.
 *
 * ⚠️ IT IS NOT DECORATION, WHICH IS WHY IT LIVES IN THE CATALOGUE RATHER THAN IN
 * THE UI. A grouping computed in the settings page would be a second opinion
 * about what a preset IS, held by a layer that only renders it — and the desktop
 * is not the only consumer of this catalogue. The catalogue states its own shape.
 */
export type PresetGroup = 'builtin' | 'cloud' | 'local' | 'custom';

/** LLM groups, in menu order. `builtin` is deliberately absent: there is no
 *  in-process language model the way `sherpa-local` is an in-process recogniser,
 *  and offering an empty section would promise one. */
export type LlmPresetGroup = Extract<PresetGroup, 'cloud' | 'local' | 'custom'>;
export const LLM_PRESET_GROUPS: readonly LlmPresetGroup[] = ['cloud', 'local', 'custom'] as const;

/** STT groups, in menu order. The built-in offline engine leads because it is the
 *  only one that works with nothing configured — see DEFAULT_STT_PRESET. */
export type SttPresetGroup = PresetGroup;
export const STT_PRESET_GROUPS: readonly SttPresetGroup[] = ['builtin', 'local', 'cloud', 'custom'] as const;

/** The explicit 「自定义 / Custom」 id, shared by both catalogues.
 *
 *  🔴 A CONSTANT, NOT THE LITERAL `'custom'` SPELLED OUT AT EACH SITE. It is
 *  read by the desktop settings model (the edit⇒custom jump, §7.1 ⑥) and written
 *  by both catalogues below; three hand-typed copies of a magic string is how the
 *  jump lands on an id no preset has, which renders as 「请选择」 — i.e. the
 *  defect this card exists to fix, reintroduced by a typo nothing would catch. */
export const CUSTOM_PRESET_ID = 'custom';

export interface SttPreset {
  id: string;
  label: string;
  engine: SttEngineId;
  /** Network endpoint. Optional since WP-R23-0: the built-in offline engine
   *  (`sherpa-local`) runs in-process and has none. */
  endpoint?: string;
  language_hint: string;
  api_key?: string;
  model?: string;
  /** §7.1 ② — which menu section. */
  group: SttPresetGroup;
}

export interface LlmPreset {
  id: string;
  label: string;
  protocol: LlmProtocol;
  endpoint: string;
  api_key: string;
  model: string;
  /** §7.1 ② — which menu section. */
  group: LlmPresetGroup;
}

/**
 * 🔴 0.3.8 — THE CATALOGUE IS A LIST OF ENGINE KINDS, NOT A LIST OF MACHINES.
 *
 * owner 2026-08-17: 「PC 端的设置中的 STT 和 LLM 的配置是没有定制的内容的，需要让
 * 用户决定如何选择和配置，不要有任何的内置个性化配置」 ("the STT and LLM settings
 * on the PC must carry no customised content — the user decides what to choose
 * and configure; there must be no built-in personalised configuration").
 *
 * Until this card, six entries below carried `100.64.7.68` / `100.64.7.179`
 * and one carried `/mnt/nvme-data/vllm-work/models/Qwen3.5-4B`. Those are one
 * person's office machines and one person's disk layout, and they were not
 * merely present in the source — they were IN THE DROPDOWN: picking 「FunASR
 * (LAN, streaming)」 on any install on earth wrote that address into that user's
 * settings. The 0.3.0 OSS-defaults card had already made the SEED neutral
 * (`settings/defaults.ts`); what it did not do was clear the menu, so a stranger
 * still had to be told not to choose the wrong item.
 *
 * What each entry now contributes is the part that is genuinely product
 * knowledge — the engine kind, its protocol, and the port that engine
 * conventionally listens on — with `localhost` standing where a host belongs.
 * The user (or a deployment's `FLOWMIC_DEFAULT_*_HOST`) supplies the machine.
 *
 * ⚠️ THE IDs DID NOT CHANGE, and the `lan-` prefix is now a historical spelling
 * rather than a claim. Renaming them would invalidate every `preset_id` already
 * stored in `user_settings` and every deployment env that names one, to buy a
 * nicer word. Read `lan-` as 「self-hosted」.
 *
 * ⚠️ WHAT THIS CARD DID **NOT** DO: it did not verify that any of these ports or
 * model names is right for a reader's own deployment. They are the values this
 * project ran against, minus the address — a starting point in a field the user
 * is expected to edit, not a promise about their machine.
 */
export const STT_PRESETS: readonly SttPreset[] = [
  // Built-in offline engine (WP-R23-0): the 7th bundled engine, runs in-process
  // (sherpa-onnx SenseVoice-small int8) — the zero-config / offline safety net.
  // No network endpoint (`endpoint` intentionally omitted). The ~228 MB model is
  // NOT bundled; it is downloaded on demand at first use (see
  // docs/strategy/spikes/sherpa-onnx-spike.md §6.3).
  {
    id: 'builtin-sherpa-local',
    label: '内置本地（离线）/ Built-in Local (offline)',
    engine: 'sherpa-local',
    language_hint: '*',
    group: 'builtin',
  },
  {
    id: 'lan-funasr-ws',
    label: 'FunASR (self-hosted, streaming)',
    engine: 'funasr',
    endpoint: 'ws://localhost:10095',
    language_hint: 'zh-CN',
    group: 'local',
  },
  {
    id: 'lan-whisper-http',
    label: 'Whisper large-v3-turbo (self-hosted, batch)',
    engine: 'openai-whisper',
    endpoint: 'http://localhost:8200/v1',
    api_key: '',
    model: 'whisper-large-v3-turbo',
    language_hint: '*',
    group: 'local',
  },
  {
    id: 'lan-sensevoice',
    label: 'SenseVoice-Small (self-hosted)',
    engine: 'custom-openai-compatible',
    endpoint: 'http://localhost:50000/v1',
    api_key: '',
    model: 'SenseVoiceSmall',
    language_hint: '*',
    group: 'local',
  },
  {
    id: 'lan-funspeech',
    label: 'FunSpeech Paraformer (self-hosted, batch)',
    engine: 'funspeech-http',
    endpoint: 'http://localhost:9000/stream/v1/asr',
    language_hint: 'zh-CN',
    group: 'local',
  },
  // Cloud BYOK entries — R-engines-1 Behavior bullet 3: defined in code
  // with empty `api_key`; the user supplies their own key via Settings,
  // which is then persisted AES-256-GCM-encrypted (F-705).
  //
  // 🔴 SONIOX IS NOT HERE, AND ITS ABSENCE IS A MEASURED RESULT, NOT AN OVERSIGHT.
  // owner 2026-08-28 Q2 asked for a Soniox BYOK preset *conditionally*: 「落地前须
  // 实证 LAN sidecar 的 engine-factory 真能驱动 soniox，否则只报告不加项」. It
  // cannot, and three independent readings say so:
  //   ① apps/server-core/src/stt/engine-factory.ts — `case 'soniox'` calls
  //      `requireCloudEngine`, which loads the PRIVATE package
  //      `@flowmic/stt-cloud` and, failing that, throws BY NAME;
  //   ② apps/server-core/test/sidecar-excludes-stt-cloud.test.ts is a MANDATORY
  //      test that re-runs build-sidecar.mjs's own esbuild config and asserts the
  //      adapter's fingerprints are absent from the bundle — the exclusion is
  //      enforced, not incidental;
  //   ③ [measured 2026-08-28, machine dev-pc-a] the shipped
  //      `apps/desktop/src-tauri/resources/server.js` contains the SPECIFIER
  //      STRING and nothing else of the adapter.
  // And types.ts states the intent outright: 「A self-hosted build will never
  // construct it; that is intended (H3), not a gap to fill.」
  // ⇒ Adding the row would ship a menu item that throws when chosen — worse than
  // 「一个改变不了任何东西的控件」, because it does not merely do nothing. Sealed
  // until the sidecar can actually load the adapter. Full argument: 06 §7.1 ⑦.
  {
    id: 'cloud-deepgram',
    label: 'Deepgram',
    engine: 'deepgram',
    endpoint: 'wss://api.deepgram.com/v1/listen',
    api_key: '',
    language_hint: '*',
    group: 'cloud',
  },
  {
    id: 'cloud-openai-realtime',
    label: 'OpenAI Realtime',
    engine: 'openai-realtime',
    endpoint: 'wss://api.openai.com/v1/realtime',
    api_key: '',
    language_hint: '*',
    group: 'cloud',
  },
  // §7.1 ② — the explicit 「I will fill this in myself」 row. It exists so that
  // configuring by hand is a CHOICE the menu offers, rather than a state a user
  // falls into by editing a field under a dropdown that then misreports itself.
  // Blank endpoint on purpose: `''` is not a dialable address (server-core's
  // `requireEndpoint` refuses it by name), which is what 「not configured」 must
  // look like — see the LLM_UNCONFIGURED note in the desktop settings model.
  {
    id: CUSTOM_PRESET_ID,
    label: '自定义 / Custom',
    engine: 'custom-openai-compatible',
    endpoint: '',
    api_key: '',
    model: '',
    language_hint: '*',
    group: 'custom',
  },
] as const;

/**
 * 🔴 0.3.43 — THE LLM MENU IS A LIST OF VENDORS, NOT A LIST OF ONE PERSON'S
 * MACHINES (owner 2026-08-28 Q1; contract 06 §7.1).
 *
 * Until this card the entire menu was three rows — vLLM(Qwen3.5-4B) /
 * Ollama(gemma3:12b) / Anthropic. That is an internal build sheet. 0.3.8 had
 * already removed the customised IPs from it; what it left behind was the
 * customised COMBINATION, and the owner named the consequence exactly:
 * 「主流用户（OpenAI/OpenRouter/DeepSeek…）用不起来」 — a mainstream user opened
 * this dropdown and did not find the thing they actually pay for.
 *
 * 🔴 WHAT THE `model` FIELD ON A CLOUD ROW IS, AND WHAT IT IS NOT (Q3).
 * It is a STARTING POINT the user is expected to edit, and 「测试连接」 verifies
 * it against the live vendor on demand. It is NOT a promise that this string is
 * the vendor's current flagship on the day you read this — model ids move faster
 * than a desktop binary ships, and a preset catalogue compiled into an installer
 * physically cannot track them.
 * ⚠️ THE RULE THAT PRODUCED THESE VALUES: every id below is one this project has
 * a real basis for. Where the current flagship was uncertain, the entry carries a
 * conservative, known-real id rather than a guessed one — because the failure
 * mode of a plausible-but-wrong id is `LLM_INVALID_MODEL` on first use, which
 * sends the user to debug their key and their network for a string WE invented.
 * A stale-but-real default costs one edit; a fabricated one costs a support
 * ticket. Where a vendor has no single obvious default, the field is left blank:
 * an empty box asks a question, a wrong box answers one nobody asked.
 *
 * ⚠️ `api_key: ''` throughout — BYOK, R-engines-1 Behavior bullet 3. Keys are
 * supplied in Settings and persisted AES-256-GCM-encrypted (F-705). No key, real
 * or placeholder, is ever committed here (the `no-cloud-keys` lint enforces it).
 */
export const LLM_PRESETS: readonly LlmPreset[] = [
  // ── cloud (BYOK) ───────────────────────────────────────────────────────────
  {
    id: 'cloud-openai',
    label: 'OpenAI',
    protocol: 'openai-compatible',
    endpoint: 'https://api.openai.com/v1',
    api_key: '',
    model: 'gpt-4o',
    group: 'cloud',
  },
  {
    id: 'cloud-openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compatible',
    endpoint: 'https://openrouter.ai/api/v1',
    api_key: '',
    // OpenRouter addresses models as `vendor/model` — the prefix is part of the
    // id, not decoration, and dropping it is the single most common way an
    // OpenRouter request 404s.
    model: 'openai/gpt-4o',
    group: 'cloud',
  },
  {
    id: 'cloud-deepseek',
    label: 'DeepSeek',
    protocol: 'openai-compatible',
    endpoint: 'https://api.deepseek.com/v1',
    api_key: '',
    model: 'deepseek-chat',
    group: 'cloud',
  },
  // 🔴 ID UNCHANGED (`cloud-anthropic-claude`). It is the one row that predates
  // this card, and every `preset_id` already stored in a `user_settings` row
  // names it — see the ids-never-change note above STT_PRESETS. The label lost
  // its 「(Cloud)」 suffix because the section heading now says that.
  {
    id: 'cloud-anthropic-claude',
    label: 'Anthropic Claude',
    // The one non-OpenAI-shaped protocol in the catalogue: Anthropic's native
    // Messages API, and the endpoint carries NO `/v1` — that path segment is part
    // of the route the adapter builds, not of the base URL.
    protocol: 'anthropic',
    endpoint: 'https://api.anthropic.com',
    api_key: '',
    model: 'claude-sonnet-4-5',
    group: 'cloud',
  },
  {
    id: 'cloud-gemini',
    label: 'Google Gemini',
    // Google's OpenAI-COMPATIBILITY endpoint, not the native generateContent
    // one: this catalogue only has two protocols, and the compatibility shim is
    // what makes Gemini reachable through the one we already speak. The trailing
    // slash and the `openai/` segment are both load-bearing.
    protocol: 'openai-compatible',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    api_key: '',
    model: 'gemini-2.0-flash',
    group: 'cloud',
  },
  {
    id: 'cloud-groq',
    label: 'Groq',
    protocol: 'openai-compatible',
    endpoint: 'https://api.groq.com/openai/v1',
    api_key: '',
    model: 'llama-3.3-70b-versatile',
    group: 'cloud',
  },
  {
    id: 'cloud-mistral',
    label: 'Mistral',
    protocol: 'openai-compatible',
    endpoint: 'https://api.mistral.ai/v1',
    api_key: '',
    // Mistral publishes rolling `-latest` aliases; using one is how this entry
    // stays true for longer than the binary it ships in.
    model: 'mistral-large-latest',
    group: 'cloud',
  },
  {
    id: 'cloud-xai',
    label: 'xAI Grok',
    protocol: 'openai-compatible',
    endpoint: 'https://api.x.ai/v1',
    api_key: '',
    model: 'grok-2-latest',
    group: 'cloud',
  },
  // ── local (self-hosted) ────────────────────────────────────────────────────
  //
  // 🔴 THE TWO IDs BELOW DID NOT CHANGE AND MUST NOT. `lan-vllm-qwen35` /
  // `lan-ollama-gemma3` name a MODEL that their labels no longer mention, and
  // that mismatch is deliberate: renaming them would invalidate every stored
  // `preset_id` and every deployment env that names one, to buy a tidier string.
  // Read `lan-` as 「self-hosted」 (same standing as the STT ids above).
  // The `model` values stay as editable starting points — a self-hosted server
  // serves whatever its operator loaded, which is precisely why the field is a
  // text box and not a list.
  {
    id: 'lan-vllm-qwen35',
    label: 'vLLM (self-hosted)',
    protocol: 'openai-compatible',
    endpoint: 'http://localhost:8000/v1',
    // vLLM requires a Bearer token to be PRESENT but does not check it; the
    // literal `EMPTY` is vLLM's own documented stand-in, not a redacted secret.
    api_key: 'EMPTY',
    model: 'Qwen3.5-4B',
    group: 'local',
  },
  {
    id: 'lan-ollama-gemma3',
    label: 'Ollama (self-hosted)',
    protocol: 'openai-compatible',
    endpoint: 'http://localhost:11434/v1',
    api_key: '',
    model: 'gemma3:12b',
    group: 'local',
  },
  {
    id: 'local-lmstudio',
    label: 'LM Studio (self-hosted)',
    protocol: 'openai-compatible',
    endpoint: 'http://localhost:1234/v1',
    api_key: '',
    // Blank ON PURPOSE: LM Studio serves whichever model the user has loaded in
    // the app, so there is no id this catalogue could state that would be right
    // more often than it was wrong. See the model-field rule in the header.
    model: '',
    group: 'local',
  },
  // ── custom ─────────────────────────────────────────────────────────────────
  {
    id: CUSTOM_PRESET_ID,
    label: '自定义 / Custom',
    protocol: 'openai-compatible',
    endpoint: '',
    api_key: '',
    model: '',
    group: 'custom',
  },
] as const;

export function findSttPreset(id: string): SttPreset | undefined {
  return STT_PRESETS.find((p) => p.id === id);
}

export function findLlmPreset(id: string): LlmPreset | undefined {
  return LLM_PRESETS.find((p) => p.id === id);
}

/**
 * The menu, already sectioned — one function per catalogue rather than a `filter`
 * repeated in every consumer.
 *
 * ⚠️ AN EMPTY GROUP IS DROPPED, and that is a product rule rather than tidiness:
 * an `<optgroup>` with a heading and no rows tells the user a category exists and
 * that they are not allowed into it. Order comes from the *_PRESET_GROUPS arrays,
 * so the menu's shape is stated in one place and not re-derived from array
 * position here.
 */
export function llmPresetsByGroup(): readonly { group: LlmPresetGroup; presets: readonly LlmPreset[] }[] {
  return LLM_PRESET_GROUPS
    .map((group) => ({ group, presets: LLM_PRESETS.filter((p) => p.group === group) }))
    .filter((section) => section.presets.length > 0);
}

export function sttPresetsByGroup(): readonly { group: SttPresetGroup; presets: readonly SttPreset[] }[] {
  return STT_PRESET_GROUPS
    .map((group) => ({ group, presets: STT_PRESETS.filter((p) => p.group === group) }))
    .filter((section) => section.presets.length > 0);
}
