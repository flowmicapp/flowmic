// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md (reference infrastructure / presets)
//   F-1903 (engine-presets.ts with LAN presets — FunASR ws / Whisper http /
//     SenseVoice / vLLM Qwen / Ollama gemma3)
//
// Bundled preset catalogue surfaced in Settings → STT and Settings →
// LLM. LAN IPs and model paths are not secrets and are kept in source
// (per CLAUDE.md: docs/code LAN presets are R&D config, not production).
// User-supplied API keys are never co-located here; they live in
// `user_settings` (encrypted, prefix `enc:v1:`) per F-705.

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
}

export interface LlmPreset {
  id: string;
  label: string;
  protocol: LlmProtocol;
  endpoint: string;
  api_key: string;
  model: string;
}

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
  },
  {
    id: 'lan-funasr-ws',
    label: 'FunASR (LAN, streaming)',
    engine: 'funasr',
    endpoint: 'ws://100.64.7.68:10095',
    language_hint: 'zh-CN',
  },
  {
    id: 'lan-whisper-http',
    label: 'Whisper large-v3-turbo (LAN, batch)',
    engine: 'openai-whisper',
    endpoint: 'http://100.64.7.68:8200/v1',
    api_key: '',
    model: 'whisper-large-v3-turbo',
    language_hint: '*',
  },
  {
    id: 'lan-sensevoice',
    label: 'SenseVoice-Small (LAN)',
    engine: 'custom-openai-compatible',
    endpoint: 'http://100.64.7.68:50000/v1',
    api_key: '',
    model: 'SenseVoiceSmall',
    language_hint: '*',
  },
  {
    id: 'lan-funspeech',
    label: 'FunSpeech Paraformer (LAN, batch)',
    engine: 'funspeech-http',
    endpoint: 'http://100.64.7.68:9000/stream/v1/asr',
    language_hint: 'zh-CN',
  },
  // Cloud BYOK entries — R-engines-1 Behavior bullet 3: defined in code
  // with empty `api_key`; the user supplies their own key via Settings,
  // which is then persisted AES-256-GCM-encrypted (F-705).
  {
    id: 'cloud-deepgram',
    label: 'Deepgram (Cloud)',
    engine: 'deepgram',
    endpoint: 'wss://api.deepgram.com/v1/listen',
    api_key: '',
    language_hint: '*',
  },
  {
    id: 'cloud-openai-realtime',
    label: 'OpenAI Realtime (Cloud)',
    engine: 'openai-realtime',
    endpoint: 'wss://api.openai.com/v1/realtime',
    api_key: '',
    language_hint: '*',
  },
] as const;

export const LLM_PRESETS: readonly LlmPreset[] = [
  {
    id: 'lan-vllm-qwen35',
    label: 'vLLM Qwen3.5-4B (LAN)',
    protocol: 'openai-compatible',
    endpoint: 'http://100.64.7.179:8000/v1',
    api_key: 'EMPTY',
    model: '/mnt/nvme-data/vllm-work/models/Qwen3.5-4B',
  },
  {
    id: 'lan-ollama-gemma3',
    label: 'Ollama gemma3:12b (LAN)',
    protocol: 'openai-compatible',
    endpoint: 'http://100.64.7.68:11434/v1',
    api_key: '',
    model: 'gemma3:12b',
  },
  // Cloud BYOK entry — R-engines-1 Behavior bullet 3: defined in code
  // with empty `api_key`; user-supplied key is encrypted at rest (F-705).
  {
    id: 'cloud-anthropic-claude',
    label: 'Anthropic Claude (Cloud)',
    protocol: 'anthropic',
    endpoint: 'https://api.anthropic.com',
    api_key: '',
    model: 'claude-sonnet-4-5',
  },
] as const;

export function findSttPreset(id: string): SttPreset | undefined {
  return STT_PRESETS.find((p) => p.id === id);
}

export function findLlmPreset(id: string): LlmPreset | undefined {
  return LLM_PRESETS.find((p) => p.id === id);
}
