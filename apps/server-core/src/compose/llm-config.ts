// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §4 (BYOK judged by api_key: platform
//     sentinel 'EMPTY' → not BYOK, counts toward quota; a user-supplied non-empty
//     key → BYOK, never metered), §6 (single LLM config; default preset
//     lan-vllm-qwen35 seeded by WP-R1-2 settings defaults)
//   🔴 M4 correction (0.3.0 task book; T7 precondition in
//     docs/decisions/2026-08-02-production-engine-lineup-soniox-deepseek.md §3):
//     the §4 sentence above describes the USER-supplied case only. The judgement
//     itself is by PROVENANCE (who supplied the config), key shape second — see
//     LlmConfigSource / resolveByokLlm below, mirroring the STT side's
//     engine-router.ts RoutingSource + engine-factory.ts resolveByok.
//   @flowmic/protocol findLlmPreset (engine-presets) + LlmConfig/LlmProtocol
//   apps/server-core/src/db/repos/settings.repo.ts (enc:v1: api_key decrypted
//     ON READ — this resolver receives plaintext)
//   CLAUDE.md red line: no silent failures (missing/invalid llm.config → fail loud)
//
// Resolves the effective LlmConfig for a user from the `llm.config` setting. The
// seeded value (WP-R1-2) is a full inline config resolved from the
// lan-vllm-qwen35 preset. A `preset_id` field, if present, is resolved through
// engine-presets and any explicit sibling fields overlay it — so both "inline
// config" and "preset reference + overrides" shapes work. The api_key arrives
// already decrypted (the settings repo unwraps enc:v1: on read); this module
// never touches ciphertext. A missing or malformed config fails loud with a
// whitelisted LLM_* code — never a silent default endpoint.

import { findLlmPreset, type LlmConfig, type LlmProtocol } from '@flowmic/protocol';
import type { SettingRow, SettingsRepo } from '../db/repos/settings.repo';
import { isSeedMarked } from '../settings/provenance';
import { ServerError } from '../errors';

// settings-key-drift GET ANCHOR (decision 2026-07-23-settings-key-drift-literal-
// anchors): WP-R2-2 gives the desktop a real UI SET face for `llm.config`
// (`updateSetting('llm.config')` in apps/desktop/src/lib/settings-client.ts), so
// resolveLlmConfig now reads it through a literal-keyed `readSetting('llm.config')`
// local helper — the drift lint's GET regex needs one real reader to pair with
// that writer (the mechanical "key has a live reader AND a live writer" proof).
// There is no protocol constant for this key; the desktop set anchor + this read
// key are pinned equal in settings-anchors.test.ts. Reads still funnel through the
// repo's variable-key read() — the helper only exposes the ONE literal.
const PROTOCOLS: readonly LlmProtocol[] = ['openai-compatible', 'anthropic'];

function isProtocol(v: unknown): v is LlmProtocol {
  return typeof v === 'string' && (PROTOCOLS as readonly string[]).includes(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Merge an optional preset base (by preset_id) with explicit inline fields. */
function mergeConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const presetId = str(raw['preset_id']);
  if (presetId === undefined) return raw;
  const preset = findLlmPreset(presetId);
  if (!preset) {
    throw new ServerError('LLM_INVALID_MODEL', `llm.config references unknown preset '${presetId}'`);
  }
  const base: Record<string, unknown> = {
    protocol: preset.protocol,
    endpoint: preset.endpoint,
    api_key: preset.api_key,
    model: preset.model,
  };
  // Explicit fields win over the preset base (a user override on top of a preset).
  for (const k of ['protocol', 'endpoint', 'api_key', 'model'] as const) {
    if (raw[k] !== undefined) base[k] = raw[k];
  }
  return base;
}

function validate(merged: Record<string, unknown>): LlmConfig {
  const protocol = merged['protocol'];
  const endpoint = str(merged['endpoint']);
  const apiKey = str(merged['api_key']);
  const model = str(merged['model']);
  if (!isProtocol(protocol)) {
    throw new ServerError('LLM_INVALID_MODEL', `llm.config.protocol must be one of ${PROTOCOLS.join('|')}`);
  }
  if (endpoint === undefined || endpoint.length === 0) {
    throw new ServerError('LLM_INVALID_MODEL', 'llm.config.endpoint is required');
  }
  if (model === undefined || model.length === 0) {
    throw new ServerError('LLM_INVALID_MODEL', 'llm.config.model is required');
  }
  // api_key may legitimately be '' or 'EMPTY' (platform endpoint) — only the
  // TYPE is enforced; the emptiness carries BYOK meaning (see isByokLlm).
  return { protocol, endpoint, api_key: apiKey ?? '', model };
}

/**
 * WHO supplied the selected LLM config. `'user'` = the user authored this row in
 * their `llm.config` (so any api_key on it is the USER'S key). `'seed'` = the
 * platform seeder wrote it at boot from the lan-vllm-qwen35 preset — it lives in
 * the user's settings but nobody chose it. `'managed-default'` = the platform
 * env-gated fallback, whose api_key is OUR key on OUR account.
 *
 * 🔴 M4 (0.3.0 task book) / T7 precondition of the DeepSeek lineup decision
 * (docs/decisions/2026-08-02-production-engine-lineup-soniox-deepseek.md §3):
 * this distinction is load-bearing for money, exactly as it was on the STT side
 * (stt/engine-router.ts RoutingSource). Before it existed the LLM BYOK judgement
 * asked "is there a key" instead of "who gave the key", so the moment the platform's own
 * DeepSeek key reached an LLM call, the platform's own traffic was classified
 * BYOK, `recordLlmUsage` early-returned, no usage_records row was ever written,
 * and the quota valve read used=0 forever — unmetered platform spend.
 *
 * 🔴 `'seed'` was added 2026-08-06 (0.3.0 W1), mirroring the STT side one for one:
 * `'user'` was answering both "this row lives in the user's settings" and "the
 * user chose it", and only the second should outrank the managed default. See
 * `settings/provenance.ts`. For
 * BYOK the two behave identically, which is why `resolveByokLlm` tests
 * `!== 'user'` rather than `=== 'managed-default'`.
 */
export type LlmConfigSource = 'user' | 'seed' | 'managed-default';

/** The resolved config WITH its provenance. Kept as one object so a caller
 *  physically cannot hold the config without holding the answer to "who supplied
 *  it" — same construction as the STT side's SelectedRouting. */
export interface SelectedLlmConfig {
  cfg: LlmConfig;
  source: LlmConfigSource;
}

/**
 * Resolve the platform managed-default LLM config from the environment, or null
 * when disabled. Mirrors stt/managed-default.ts managedDefaultRouting():
 * env-gated + explicit (FLOWMIC_MANAGED_LLM_ENABLED must be '1'/'true'), and an
 * ENABLED-but-invalid config is fail-loud (throws) — never a silent skip.
 *
 * 🔴 The API key read here is OURS, on OUR account (the production DeepSeek key
 * lives in /etc/flowmic-app/env beside FLOWMIC_MANAGED_STT_API_KEY). It is
 * deliberately still copied onto the config (the streamer needs it to connect) —
 * provenance travels beside it instead: resolveLlmConfigWithSource stamps
 * `source:'managed-default'` and resolveByokLlm refuses to call a platform key
 * BYOK however long it is. Putting a platform key into a USER'S `llm.config`
 * row is therefore always wrong — that row is 'user' provenance by definition,
 * same as pasting the platform key into a user's stt.routings would be.
 */
export function managedLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const enabled = env.FLOWMIC_MANAGED_LLM_ENABLED;
  if (enabled !== '1' && enabled !== 'true') return null;
  const protocol = env.FLOWMIC_MANAGED_LLM_PROTOCOL;
  if (!isProtocol(protocol)) {
    throw new Error(
      `FLOWMIC_MANAGED_LLM_ENABLED set but FLOWMIC_MANAGED_LLM_PROTOCOL is invalid: ${JSON.stringify(protocol)} (expected ${PROTOCOLS.join('|')})`,
    );
  }
  const endpoint = env.FLOWMIC_MANAGED_LLM_ENDPOINT;
  const model = env.FLOWMIC_MANAGED_LLM_MODEL;
  if (!endpoint || !model) {
    throw new Error(
      'FLOWMIC_MANAGED_LLM_ENABLED set but FLOWMIC_MANAGED_LLM_ENDPOINT / FLOWMIC_MANAGED_LLM_MODEL is missing',
    );
  }
  return { protocol, endpoint, api_key: env.FLOWMIC_MANAGED_LLM_API_KEY ?? '', model };
}

/**
 * Resolve the effective LLM config for a user WITH its provenance; throws (fail
 * loud) when nothing is configured or the row is malformed.
 *
 * Selection order mirrors the STT side (engine-router §4 `selectRoutingWithSource`):
 *
 *   1. a `llm.config` row the USER authored — wins, unconditionally
 *   2. the platform managed default
 *   3. a SEEDED `llm.config` row (the fallback line when no managed default is
 *      configured — every self-hosted build, and any deployment with
 *      FLOWMIC_MANAGED_LLM_ENABLED off)
 *   4. throw
 *
 * A present-but-malformed USER row still fails loud rather than falling through to
 * the platform engine — silently substituting for a corrupt user config would mask
 * the corruption. `managedDefault` is a test seam; production uses the env-gated
 * [managedLlmConfig].
 *
 * 🔴 REACHABILITY — THIS PARAGRAPH REPLACES ONE THAT IS NOW FALSE (0.3.0 W1,
 * 2026-08-06). It used to say the `source:'managed-default'` arm was UNREACHABLE
 * for any real account, and it was right: `buildDefaultSettings()` always includes
 * an `llm.config` entry and `seedDefaultSettings` runs for the standalone user
 * (`bootstrap.ts` :131), for every existing user at boot (:138), and at
 * registration (:422, the `onUserCreated` hook) — so the row was never absent and
 * this function always answered `'user'`. The arm is now REACHABLE, because the
 * seeded row is marked and no longer counts as the user's own: a seed row defers
 * to the managed default. That was the whole point of the change; the argument and
 * the failure directions are in `settings/provenance.ts`.
 *
 * 🔴 THE WARNING THAT OUTLIVED IT, still true and still the rule: do NOT close the
 * remaining door by making the managed default outrank a row the USER authored. A
 * platform key written into a USER'S `llm.config` row is `'user'` by definition and
 * is STILL judged BYOK — see the warning on [managedLlmConfig]. The way to put the
 * platform key in front of people is the env-gated managed default (which is what
 * now works), never precedence over a choice somebody made.
 *
 * ⚠️ Those `bootstrap.ts` line numbers were re-read on 2026-08-06 after the
 * shutdown-sequence split moved everything (they used to read :234/:241/:534, off
 * by ~146 lines and green in every gate — `coordinate-anchors` only detects paths
 * containing a `/`). Trust the symbol names over the numbers.
 */
export function resolveLlmConfigWithSource(
  repo: SettingsRepo,
  userId: string,
  managedDefault: () => LlmConfig | null = () => managedLlmConfig(),
): SelectedLlmConfig {
  // The single literal-key GET anchor (settings-key-drift lint) — pairs with the
  // desktop updateSetting('llm.config') SET anchor. Reads funnel through the
  // repo's variable-key read(); this closure exposes only the ONE literal.
  const readSetting = (key: string): SettingRow | null => repo.read(userId, key);
  const row = readSetting('llm.config');
  // ABSENCE MEANS 'user' (settings/provenance.ts): an un-backfilled row is treated
  // as the user's own, which degrades to the pre-2026-08-06 behaviour rather than
  // to a platform engine silently replacing somebody's configuration.
  const seeded = row !== null && isSeedMarked(row.value);
  if (row === null || seeded) {
    const managed = managedDefault();
    if (managed) return { cfg: managed, source: 'managed-default' };
    // No managed default ⇒ fall THROUGH to the seeded row below, which is the
    // fallback line it has always been. Only a genuinely absent row throws here.
    if (row === null) throw new ServerError('LLM_INVALID_MODEL', 'llm.config is not configured');
  }
  if (row.value === null || typeof row.value !== 'object') {
    throw new ServerError('LLM_INVALID_MODEL', 'llm.config is not configured');
  }
  return {
    cfg: validate(mergeConfig(row.value as Record<string, unknown>)),
    source: seeded ? 'seed' : 'user',
  };
}

/**
 * BYOK judgement — "who supplied it", then "does it look like the user's own
 * key", in that order.
 *
 * 🔴 M4: the same T7 rule the STT side already carries (engine-factory.ts
 * resolveByok): a managed/platform-supplied config is NEVER BYOK — it is metered
 * and quota-counted **however many characters its key has**. Only a config the
 * USER supplied can be BYOK, and then only when the key is a real user key (not
 * '' and not the 'EMPTY' platform-endpoint sentinel). Do not narrow this back to
 * a key-shape test — the question is WHO SUPPLIED IT, and only the selection
 * step knows that, which is why the argument is a `SelectedLlmConfig` and not a
 * `LlmConfig`: a caller physically cannot ask without stating provenance.
 *
 * 🔴 `'seed'` (0.3.0 W1) is covered for free BY THE SHAPE of the test — `!== 'user'`
 * — and that is not luck, it is why the test was written that way instead of
 * `=== 'managed-default'`. A seeded row's api_key is a preset's, never a user's.
 * Today's seed carries 'EMPTY' (lan-vllm-qwen35), so the answer is unchanged
 * either way; the point is that it stays false if the seed ever gains a real key.
 * Verified rather than assumed — see settings-provenance.test.ts.
 */
export function resolveByokLlm(selected: SelectedLlmConfig): boolean {
  if (selected.source !== 'user') return false;
  const k = selected.cfg.api_key;
  return k.length > 0 && k !== 'EMPTY';
}

/**
 * ⚠️ Shape-only heuristic — DIAGNOSTIC USE ONLY (http/probe-routes.ts, whose
 * probe body is an ad-hoc payload the console posted, so no provenance exists to
 * ask about). It answers "does this key look like the user's own", NOT "who
 * supplied it".
 *
 * 🔴 NEVER use this for billing. Every billing/quota judgement must hold a
 * [SelectedLlmConfig] and call [resolveByokLlm] — a platform managed key is
 * non-empty and non-'EMPTY', so this function calls it BYOK, which is exactly
 * the M4/T7 money bug (unmetered platform spend). The STT side's resolveByok
 * carries the same warning for the same reason.
 */
export function isByokLlm(cfg: LlmConfig): boolean {
  const k = cfg.api_key;
  return k.length > 0 && k !== 'EMPTY';
}
