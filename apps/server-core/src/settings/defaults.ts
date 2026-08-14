// SPEC-REF:
//   docs/decisions/2026-07-23-lan-model-defaults.md (STT defaults: lan-funasr-ws
//     (zh) + lan SenseVoice (*); LLM default: lan-vllm-qwen35; referenced by
//     preset id, the implementation side adds no new hardcoded IP)
//   docs/rebuild/05-DATA-MODEL.md §5 (KV keys: stt.routings plural; stt.routing
//     singular is legacy, must not be revived)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §4 (presets)
//   CLAUDE.md environment fact: IPs go only into the presets package, code must
//     never hardcode them
//
// First-boot idempotent seeding. The default routings are RESOLVED from the
// @flowmic/protocol engine presets BY ID at boot — no LAN IP ever appears in
// server-core source (the IP lives only in the presets package). The seeded keys
// are consumed by the R1-3 STT orchestrator (stt.routings) and the R1-4 compose
// orchestrator (llm.config) — a documented forward-reference, not a façade (those
// cards each claim the consumer).
//
// 🔴 THE IDEMPOTENCE RULE WAS NARROWED (0.3.0 W1, 2026-08-06). It used to read
// 「an existing key is never overwritten」 full stop. That is no longer true, and
// the precise rule is now:
//
//   · An existing key's CONTENT is never overwritten. Not one language, endpoint,
//     model or key is ever changed by seeding. Instant-save (即改即存) user edits still win.
//   · A row may be rewritten EXACTLY ONCE to record WHO WROTE IT, and only when
//     the row is still value-identical to the default this process would seed and
//     carries no marker yet. See `settings/provenance.ts reclassifyUnmarked` —
//     it is add-only, it never strips a marker, and it returns null (⇒ zero
//     writes) for everything else.
//
// The rewrite is content-preserving, but it is a real write with a real
// `updated_at` bump, so it is stated here rather than hidden behind the old
// sentence. Why it has to exist at all: without the marker the seeded rows are
// indistinguishable from user rows, and the platform managed default is therefore
// unreachable for every account that has ever booted — the whole reason
// `provenance.ts` exists, argued in full in that file's header.

import { findLlmPreset, findSttPreset } from '@flowmic/protocol';
import type { SettingsRepo } from '../db/repos/settings.repo';
import { reclassifyUnmarked, stampProvenance } from './provenance';

/**
 * 🔴 OSS-DEFAULTS (0.3.0) — WHAT A STRANGER'S FIRST BOOT SEEDS.
 *
 * These three used to be `lan-funasr-ws` / `lan-sensevoice` / `lan-vllm-qwen35`,
 * i.e. every fresh install on earth was born pointed at the owner's office LAN.
 * The `TODO(public build)` at the foot of this file said so in as many words; this is
 * that TODO being paid.
 *
 * STT now seeds the BUILT-IN engine (`builtin-sherpa-local`, the 7th bundled
 * engine — in-process sherpa-onnx, no endpoint at all). That is the only default
 * that is NEUTRAL: it dials nobody's machine, so a stranger's first boot is no
 * longer pointed at this project's office.
 *
 * ⚠️ 「NEUTRAL」 IS NOT 「NEEDS NOBODY'S NETWORK」 — this comment said the latter
 * and it was false (W5O, 2026-08-09). The engine has no ENDPOINT, but it has a
 * MODEL. Until 2026-08-09 first use auto-downloaded ~228 MB from huggingface.co
 * (falling back to github.com) — that default is now REVERSED by owner ruling
 * (DISC-2): `autoDownload` is OPT-IN (`stt/engines/sherpa-local.ts`
 * `sherpaAutoDownloadEnabled`, only FLOWMIC_SHERPA_AUTO_DOWNLOAD=1/true fetches).
 *
 * ⚠️ THIS COMMENT USED TO SAY the stock install therefore 「fails LOUD
 * (STT_CONFIG_MISSING)」. That sentence was true of one layer and false of the
 * product, measured on the shipped 0.2.61 artifact (ENG cards, 2026-08-11,
 * docs/strategy/2026-08-11-eng-local-stt-cards.md): the shipped resources tree
 * had no addon so open() failed, the engine DID throw the named code, the
 * orchestrator re-coded it to STT_NETWORK_DROP, and the phone dropped
 * code+message and painted "no speech heard" — a QUIET failure blaming the room.
 * A seed-file comment cannot promise end-to-end loudness; each layer owns its
 * own half, each with its own anchor:
 *
 *   · Engine (the only claim THIS paragraph is allowed to make): a non-network
 *     open failure — model absent, and equally the native addon failing to
 *     resolve — throws SttEngineError('STT_CONFIG_MISSING', …, retryable:false)
 *     from `SherpaLocalEngine.open` (stt/engines/sherpa-local.ts). The
 *     model-absent variant is pinned by test/sherpa-model.test.ts
 *     「fail-loud when model absent」; the addon-absent variant goes through the
 *     same catch but is unpinned (the dev tree always resolves the addon).
 *   · Server mapping: whether that code survives onto the `stt:error` frame is
 *     decided by the catch in `orchestrator-core.ts start()` (card ENG-2 /
 *     fix-029).
 *   · Phone rendering: whether the user ever reads it is decided by the
 *     `sttError` case in `apps/mobile/lib/src/ptt/ptt_inbound.dart` (card
 *     ENG-3 / fix-030).
 *   · Packaging: whether the shipped sidecar payload can resolve the addon at
 *     all is `apps/desktop/scripts/build-sidecar.mjs` territory (card ENG-1 /
 *     fix-028).
 *
 * What THIS file guarantees is only the seed: a stock boot routes to
 * `builtin-sherpa-local` and dials nobody — no silent dialing of a third
 * party; the operator supplies the model or opts in.
 * So "zero configuration" now means zero configuration to be pointed at nobody — speech
 * itself still needs the operator to provide a model. It is nobody's PRIVATE
 * network, and that is what the card bought.
 *
 * LLM seeds NOTHING — see [LLM_NOT_CONFIGURED]. There is no neutral LLM the way
 * there is a neutral STT engine, and the alternatives are all worse: an address
 * is somebody's machine, and `''` is an address that a downstream layer will
 * cheerfully hand to `fetch`.
 *
 * A deployment that wants the old behaviour NAMES the preset it wants (below).
 * Naming it is the point: the addresses stay in the presets catalogue, where
 * CLAUDE.md "code must never hardcode it, presets go through the presets
 * package" already puts them, and the choice to
 * dial one becomes a deployment fact instead of a shipped default.
 */
const DEFAULT_STT_ZH_PRESET = 'builtin-sherpa-local';
const DEFAULT_STT_WILDCARD_PRESET = 'builtin-sherpa-local';

/**
 * The named "LLM not configured" state. NOT an endpoint, and deliberately NOT `''`.
 *
 * When this is the selected preset id, [buildDefaultSettings] emits NO
 * `llm.config` entry at all, and `compose/llm-config.ts resolveLlmConfigWithSource`
 * answers the absence with the registered, already-four-language
 * `LLM_INVALID_MODEL` — message `llm.config is not configured`. So "not configured" is a
 * sentence the user reads, not a connection attempt that fails as a network
 * error and sends them to look at their router.
 *
 * ⚠️ It is a SEED-SELECTION value, never a stored one: it must never reach
 * `user_settings`. A row whose endpoint is the string 'not-configured' would be
 * exactly the silent-dial shape this exists to prevent — `validate()` would pass
 * it (non-empty string) and the streamer would resolve it as a relative URL.
 * Absence of the row is the state; there is no sentinel row.
 */
export const LLM_NOT_CONFIGURED = 'not-configured';
const DEFAULT_LLM_PRESET = LLM_NOT_CONFIGURED;

/** Deployment host overrides — see [hostOverride]. */
export const STT_HOST_ENV = 'FLOWMIC_DEFAULT_STT_HOST';
export const LLM_HOST_ENV = 'FLOWMIC_DEFAULT_LLM_HOST';

/**
 * Deployment preset selection — which catalogue entry first boot seeds.
 *
 * 🔴 These three are what keeps the owner's deployments behaving EXACTLY as
 * before. `/etc/flowmic-app/env` (and any other box that wants the LAN engines)
 * declares:
 *
 *     FLOWMIC_DEFAULT_STT_ZH_PRESET=lan-funasr-ws
 *     FLOWMIC_DEFAULT_STT_WILDCARD_PRESET=lan-sensevoice
 *     FLOWMIC_DEFAULT_LLM_PRESET=lan-vllm-qwen35
 *
 * beside the two HOST overrides it already sets, and every seeded value is
 * byte-identical to what this file produced before the card.
 *
 * ⚠️ SEPARATE VARIABLES FROM THE HOSTS ON PURPOSE, even though a deployment
 * that sets one will usually set the other. They answer two different questions
 * — "which engine to use" vs "which machine that engine is on" — and this repo's head bug shape is one
 * value answering two questions. Deriving the preset from the presence of
 * `FLOWMIC_DEFAULT_STT_HOST` would be exactly that, and it would silently
 * re-point any deployment that set a host for some other reason.
 */
export const STT_ZH_PRESET_ENV = 'FLOWMIC_DEFAULT_STT_ZH_PRESET';
export const STT_WILDCARD_PRESET_ENV = 'FLOWMIC_DEFAULT_STT_WILDCARD_PRESET';
export const LLM_PRESET_ENV = 'FLOWMIC_DEFAULT_LLM_PRESET';

function presetIdFromEnv(envVar: string, fallback: string): string {
  const v = (process.env[envVar] ?? '').trim();
  return v === '' ? fallback : v;
}

interface SttRouting {
  language: string;
  engine_id: string;
  endpoint?: string;
  api_key?: string;
  model?: string;
}

/**
 * owner 2026-07-27 — flowmic.app's default STT/LLM point at 10.0.0.68 / .179.
 *
 * The presets carry the R&D LAN addresses (100.64.7.x, the owner's office
 * network). The flowmic.app VPS reaches THE SAME TWO MACHINES over a
 * different route — verified from the box itself: identical ports (10095 FunASR
 * ws answering `101 Switching Protocols`, 50000 SenseVoice, 8200 Whisper, 9000
 * FunSpeech on .68; 8000 vLLM on .179) and the identical vLLM model path
 * `/mnt/nvme-data/vllm-work/models/Qwen3.5-4B`.
 *
 * That is a ROUTE difference, not an engine difference, so it is expressed as a
 * per-deployment HOST override rather than as duplicate presets — duplicating
 * them would put two menu entries in front of the user for one service, and
 * would bake a private VPN subnet into a package bound for a public repo
 * (00-README G2: server-core is formally open source). The deployment declares its own
 * topology in /etc/flowmic-app/env instead:
 *
 *     FLOWMIC_DEFAULT_STT_HOST=10.0.0.68
 *     FLOWMIC_DEFAULT_LLM_HOST=10.0.0.179
 *
 * HOST ONLY. Scheme, port and path are preserved from the preset, so a
 * deployment cannot quietly redirect an engine to a different port and get a
 * different service while the settings still claim FunASR. An unparseable
 * endpoint or host throws at boot — a default that silently stayed on an
 * unreachable address is the exact failure this exists to remove (it is what
 * flowmic.app had: every routing pointed at 100.64.7.x, which that box has
 * never been able to reach).
 */
function hostOverride(endpoint: string | undefined, envVar: string, presetId: string, presetEnvVar: string): string | undefined {
  const host = (process.env[envVar] ?? '').trim();
  if (endpoint === undefined) {
    // OSS-DEFAULTS: the endpoint-less case became REACHABLE the day the seeded
    // default became `builtin-sherpa-local` (it has no endpoint by design).
    // Returning undefined silently would mean a deployment that sets a HOST but
    // forgets the PRESET gets its override quietly dropped, and then spends the
    // afternoon asking why the box it configured is idle. So the mismatch is
    // named, and it names BOTH variables — the one that is set and the one that
    // is missing — because either could be the one the operator meant to change.
    if (host !== '') {
      throw new Error(
        `settings.defaults: ${envVar}='${host}' is set, but the seeded preset '${presetId}' has no endpoint to override ` +
          `(it runs in-process). Name a network preset with ${presetEnvVar}, or unset ${envVar}.`,
      );
    }
    return undefined;
  }
  if (host === '') return endpoint;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`settings.defaults: preset endpoint '${endpoint}' is not a URL, cannot apply ${envVar}`);
  }
  // Assigning an invalid hostname is a silent no-op in the WHATWG parser, so it
  // is checked by reading back rather than trusted.
  url.hostname = host;
  if (url.hostname !== host.toLowerCase() && url.hostname !== `[${host.toLowerCase()}]`) {
    throw new Error(`settings.defaults: ${envVar}='${host}' is not a valid host`);
  }
  return url.toString();
}

function routingFromPreset(language: string, presetId: string, presetEnvVar: string): SttRouting {
  const p = findSttPreset(presetId);
  if (!p) throw new Error(`settings.defaults: unknown STT preset '${presetId}' (from ${presetEnvVar})`);
  const endpoint = hostOverride(p.endpoint, STT_HOST_ENV, presetId, presetEnvVar);
  return {
    language,
    engine_id: p.engine,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(p.model !== undefined ? { model: p.model } : {}),
    ...(p.api_key !== undefined ? { api_key: p.api_key } : {}),
  };
}

function llmConfigFromPreset(presetId: string): { protocol: string; endpoint: string; api_key: string; model: string } {
  const p = findLlmPreset(presetId);
  if (!p) throw new Error(`settings.defaults: unknown LLM preset '${presetId}' (from ${LLM_PRESET_ENV})`);
  // The LLM preset always has an endpoint (unlike sherpa-local on the STT side),
  // so the override never returns undefined here.
  const endpoint = hostOverride(p.endpoint, LLM_HOST_ENV, presetId, LLM_PRESET_ENV) as string;
  return { protocol: p.protocol, endpoint, api_key: p.api_key, model: p.model };
}

/**
 * The default settings map (key → value). Built fresh from presets each boot.
 *
 * 🔴 OSS-DEFAULTS: `llm.config` IS ABSENT when no LLM preset is named — the list
 * is two entries long or one, and the one-entry case is the stock build. That
 * absence is the "not configured" state (see [LLM_NOT_CONFIGURED]); it is NOT a gap
 * somebody forgot to fill, and it must not be "helpfully" filled with a sentinel
 * row later. `resolveLlmConfigWithSource` already answers a missing row with the
 * registered `LLM_INVALID_MODEL` / 「llm.config is not configured」.
 *
 * ⚠️ Absence also flows into `stampProvenance` / `reclassifyUnmarked`, which take
 * this list as their notion of 「what the platform would seed」. With no
 * `llm.config` default there is nothing for an existing row to be value-identical
 * TO, so `reclassifyUnmarked` returns null for it and an existing row keeps
 * whatever provenance it has. That is the correct degradation — an un-backfilled
 * row reads as the user's own (provenance.ts), which is the pre-2026-08-06
 * behaviour — and it is another reason the deployment that wants the old marking
 * behaviour must name its preset rather than rely on a default.
 */
export function buildDefaultSettings(): { key: string; value: unknown }[] {
  const zhPreset = presetIdFromEnv(STT_ZH_PRESET_ENV, DEFAULT_STT_ZH_PRESET);
  const wildcardPreset = presetIdFromEnv(STT_WILDCARD_PRESET_ENV, DEFAULT_STT_WILDCARD_PRESET);
  const llmPreset = presetIdFromEnv(LLM_PRESET_ENV, DEFAULT_LLM_PRESET);
  const out: { key: string; value: unknown }[] = [
    {
      key: 'stt.routings',
      value: [
        routingFromPreset('zh', zhPreset, STT_ZH_PRESET_ENV),
        routingFromPreset('*', wildcardPreset, STT_WILDCARD_PRESET_ENV),
      ],
    },
  ];
  if (llmPreset === LLM_NOT_CONFIGURED) {
    // 🔴 THE LLM HALF OF THE REFUSAL [hostOverride] MAKES ON THE STT SIDE, AND IT
    // HAS TO LIVE HERE RATHER THAN IN [llmConfigFromPreset].
    //
    // `llmConfigFromPreset` is the ONLY caller of `hostOverride(…, LLM_HOST_ENV, …)`,
    // and the `if` below means it does not run at all in a stock install. So on the
    // 「HOST set, PRESET forgotten」 path — the exact operator mistake the STT throw
    // exists to name — `FLOWMIC_DEFAULT_LLM_HOST` was read by NOTHING: no error, no
    // log, no seeded row. Silently dropping a deployment's configured address is
    // the failure this card claims to have removed, and it was still here, one
    // branch over, for the one of the two hosts that had no test.
    //
    // Same two-variable message as the STT side (the set one AND the missing one),
    // for the same reason: either could be the one the operator meant to change.
    // Deliberately NOT the STT wording 「the seeded preset has no endpoint」 — that
    // sentence would be false here. Nothing is seeded at all; there is no preset,
    // so there is no endpoint for the host to be substituted into.
    const llmHost = (process.env[LLM_HOST_ENV] ?? '').trim();
    if (llmHost !== '') {
      throw new Error(
        `settings.defaults: ${LLM_HOST_ENV}='${llmHost}' is set, but no LLM preset is named, so no llm.config is ` +
          `seeded for that host to apply to. Name a network preset with ${LLM_PRESET_ENV}, or unset ${LLM_HOST_ENV}.`,
      );
    }
  } else {
    out.push({ key: 'llm.config', value: llmConfigFromPreset(llmPreset) });
  }
  return out;
}

/**
 * Re-derive the provenance marker for a value on its way into `user_settings`.
 *
 * 🔴 THE ONE ENTRY POINT FOR WRITE PATHS (D1/D3). Every place that stores
 * `stt.routings` or `llm.config` calls this and stores what it returns:
 * `seedDefaultSettings` below, the socket `settings:update` handler, and the
 * console's `POST /api/cloud/stt-routings`. It binds the classifier to the CURRENT
 * defaults so no caller has to know that the defaults are an input at all — a
 * fourth write path that forgets is the failure this shape is trying to make
 * unlikely.
 *
 * Whatever marker the client sent is discarded and recomputed. Non-provenance keys
 * pass through untouched.
 */
export function stampSettingProvenance(key: string, value: unknown): unknown {
  return stampProvenance(key, value, buildDefaultSettings());
}

/**
 * Seed a user's missing default keys, and record the provenance of rows already
 * there. Returns the keys this call WROTE — either newly seeded, or rewritten
 * with the marker they should always have carried.
 *
 * ⚠️ Both cases land in one array because the caller (`bootstrap.ts`, which logs
 * `'seeded default settings'` with these keys) is off-limits to this change. For a
 * re-marked row that log line is imprecise but not false: the row WAS seeded, by
 * an earlier boot; this boot only wrote down which rows those are. It happens at
 * most once per row per database.
 *
 * Content is never touched — see the narrowed invariant in the file header.
 */
export function seedDefaultSettings(repo: SettingsRepo, userId: string): string[] {
  const defaults = buildDefaultSettings();
  const written: string[] = [];
  for (const { key, value } of defaults) {
    const row = repo.read(userId, key);
    if (row === null) {
      repo.write(userId, key, stampProvenance(key, value, defaults));
      written.push(key);
      continue;
    }
    // Add-only backfill for rows written before the marker existed. Returns null
    // — hence zero writes — for a user's own row, for an already-marked row, and
    // for a row seeded by an older default.
    const remarked = reclassifyUnmarked(key, row.value, defaults);
    if (remarked !== null) {
      repo.write(userId, key, remarked);
      written.push(key);
    }
  }
  return written;
}

/**
 * owner 2026-07-27 — "after connecting directly to the cloud, the phone can transcribe and record normally".
 *
 * Seeding used to run for the STANDALONE user and nobody else, so on a saas
 * deployment every REGISTERED account was born with no `stt.routings` and no
 * `llm.config` at all. flowmic.app proved it: the owner's real account had
 * exactly one settings row (`stt.polish`), which is why speaking against the
 * cloud produced no transcript — there was no engine to route to. A defaults
 * mechanism that never runs for the users who need it is the façade class this
 * project keeps re-learning (CLAUDE.md anti-façade).
 *
 * Runs over EVERY user at boot, which also repairs an account that predates
 * this call. Idempotent by construction — [seedDefaultSettings] never changes the
 * CONTENT of an existing row, so a user's own edits always survive a restart.
 *
 * 🔴 This is also where the provenance backfill lives (0.3.0 W1). It is a DATA
 * migration and this is the only loop in the process that already visits every
 * user's settings, so it needs no new mechanism and no schema change — see
 * `settings/provenance.ts reclassifyUnmarked` for why it is add-only and why it
 * must go through the repo rather than raw SQL (the enc:v1: envelope).
 *
 * ✅ The `TODO(public build)` that stood here — "a public multi-tenant build must not
 * seed a LAN engine into a stranger's account」 — is PAID (OSS-DEFAULTS, 0.3.0).
 * The stock seed is `builtin-sherpa-local` with no LLM at all; a deployment that
 * wants a LAN engine names it through [STT_ZH_PRESET_ENV] /
 * [STT_WILDCARD_PRESET_ENV] / [LLM_PRESET_ENV]. Kept rather than deleted because
 * the sentence records WHY the loop below is allowed to run over every account:
 * what it seeds is now neutral, so seeding for everyone is no longer a way to
 * point everyone at one office.
 */
export function seedDefaultSettingsForAllUsers(
  repo: SettingsRepo,
  users: { listAll(): { id: string }[] },
): { userId: string; keys: string[] }[] {
  const out: { userId: string; keys: string[] }[] = [];
  for (const u of users.listAll()) {
    const keys = seedDefaultSettings(repo, u.id);
    if (keys.length > 0) out.push({ userId: u.id, keys });
  }
  return out;
}
