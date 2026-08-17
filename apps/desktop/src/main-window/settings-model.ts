// WP-R2-2 settings UI model. Mirrors the mobile pattern: a device-local display
// cache (localStorage) is the UI source of truth, hydrated from preset-derived
// defaults, and every edit is pushed to the server through the SettingsClient
// anchor methods (change-applies-immediately, no save button). The server
// remains authoritative for compose/STT; loading its snapshot (settings:list)
// is a later refinement — the mobile likewise drives from a local cache. NO
// endpoint/IP is hard-coded here: STT/LLM endpoints come from the
// @flowmic/protocol presets (goes through the presets package, hard-coding an
// IP is forbidden).

import { reactive } from 'vue';
import {
  ADDITIONAL_PRIVATE_CIDRS,
  DICTIONARY_PACKS,
  LLM_PRESETS,
  SCENARIO_MAX_DOMAINS,
  SCENARIO_MAX_LABEL_LEN,
  SCENARIO_MAX_PACKS,
  SCENARIO_MAX_PROFESSIONS,
  SCENARIO_MAX_TERMS,
  DEFAULT_POLISH_STRENGTH,
  POLISH_STRENGTHS,
  SETTINGS_KEY_CAPABILITY_LLM,
  SETTINGS_KEY_SCENARIO_INFERENCE,
  STT_PRESETS,
  ScenarioCardSchema,
  classifyDestination,
  findLlmPreset,
  findSttPreset,
  inferenceBlockedReason,
  scenarioConsentRow,
  type InferenceBlockedReason,
  type ModelDestination,
  type ScenarioCard,
  type PolishStrength,
  type ScenarioInferenceConsent,
  type SttEngineId,
} from '@flowmic/protocol';
import { localKv } from '../lib/storage';
import { CH, fetchServerSettings, onChannel } from '../lib/bridge';
import type { ServerSettingItem } from '../lib/types';
import { SETTINGS_ANCHOR_KEYS } from '../lib/settings-client';
import { S } from '../lib/strings';
import { settings } from './store';

// stt.dictionary is read by the server via a VARIABLE key (scenario-context /
// engine-factory) and is deliberately NOT a drift-lint anchor — so it is pushed
// through updateSetting with this const key, never a string literal at the call.
const STT_DICTIONARY_KEY = 'stt.dictionary';

// V2-08 consent row (`scenario.inference`). The server reads it with a VARIABLE
// key too, so this MUST go out through the constant and never as a literal at the
// updateSetting call: the settings-key-drift lint pairs literal-keyed UI writes
// with literal-keyed server reads, and a literal here would be a set-only orphan
// (a FAIL that would then be "fixed" by inventing a fake server anchor). Same
// stance and same reason as STT_DICTIONARY_KEY above.
//
// Its sibling `scenario.inference.overrides` (the owner's per-process descriptor
// corrections) is NOT declared here: this card ships no UI for it, and a key
// constant with no writer is the façade the anti-façade rule is about. Named in
// prose so the next card does not invent a different spelling.
const SCENARIO_INFERENCE_KEY = SETTINGS_KEY_SCENARIO_INFERENCE;

// Card POLISH-CFG (2026-08-09) — `capability.llm`, a READ-ONLY fact, not a setting.
//
// 🔴 THIS KEY IS NEVER WRITTEN, AND THAT IS ENFORCED ELSEWHERE. The server
// SYNTHESISES it on every `settings:list` (settings.handler.ts
// `withEffectiveDefaults`); it is not in the settings table and cannot be stored.
// `verify/lint/settings-key-drift.mjs` keys a three-way rule off the
// `capability.` prefix — a UI that WRITES one is a hard failure, one the server
// produces that no UI renders is a façade, one the UI renders that no server
// produces is an invention — so this constant appearing under apps/desktop is
// what proves the fact has a consumer. Do NOT add it to any push/update path,
// and do NOT restate it as a `'capability.llm'` literal: the lint greps the
// CONSTANT NAME, so a literal here would read as "no consumer" and fail the
// build while the screen looks fine.
const CAPABILITY_LLM_KEY = SETTINGS_KEY_CAPABILITY_LLM;

// Local display-cache keys (never travel the wire).
const K_ROUTINGS = 'flowmic.ui.stt.routings';
const K_DICT = 'flowmic.ui.stt.dictionary';
const K_POLISH = 'flowmic.ui.stt.polish';
// Card C8. A SEPARATE local key rather than a second field inside K_POLISH's
// value: the existing key holds a bare boolean, so widening it would make every
// already-cached value unparseable on the first launch after an update.
const K_POLISH_STRENGTH = 'flowmic.ui.stt.polish.strength';
const K_REFINE = 'flowmic.settings.sttRefine';
const K_LLM = 'flowmic.ui.llm.config';
const K_SCENARIO = 'flowmic.ui.scenario.card';
const K_INFER = 'flowmic.ui.scenario.inference';

export interface Routing {
  language: string;
  engine_id: SttEngineId;
  endpoint?: string;
  api_key?: string;
  model?: string;
}
export interface DictEntry {
  term: string;
  aliases?: string[];
  weight?: number;
}
export interface LlmConfigModel {
  preset_id: string;
  protocol: string;
  endpoint: string;
  api_key: string;
  model: string;
}

/** owner 2026-07-27 — the same class as the "PC timeline page renders entirely
 *  blank" defect, on the page with the most surface.
 *
 *  The old `load<T>` returned `JSON.parse(raw) as T`: only a PARSE failure fell
 *  back, so any value that parsed but had a different shape — including a literal
 *  `null`, which parses fine — was handed to the templates verbatim. These caches
 *  outlive upgrades, so `model.card.professions.includes(…)`,
 *  `model.llm.preset_id`, `model.dictionary.length` and friends were one
 *  older-build cache away from throwing during render and blanking the whole
 *  settings page. Every key now goes through a narrowing function; a value that
 *  cannot be salvaged falls back to the same default a fresh install gets. */
function loadWith<T>(key: string, fallback: T, narrow: (v: unknown) => T | null): T {
  const raw = localKv.get(key);
  if (raw === null) return fallback;
  try {
    return narrow(JSON.parse(raw) as unknown) ?? fallback;
  } catch {
    return fallback;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function asStr(v: unknown, fb = ''): string {
  return typeof v === 'string' ? v : fb;
}
function asBoolean(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Card C8 — the correction strength, narrowed against the protocol's own
 *  enum rather than a string literal copied into this file. An unrecognised
 *  value returns null so [loadWith] falls back to the default, which is the
 *  same stance every other key here takes. */
function asPolishStrength(v: unknown): PolishStrength | null {
  return typeof v === 'string' && (POLISH_STRENGTHS as readonly string[]).includes(v)
    ? (v as PolishStrength)
    : null;
}

function asRoutings(v: unknown): Routing[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter(isObj).map((r) => {
    const out: Routing = {
      language: asStr(r.language, 'zh-CN'),
      engine_id: asStr(r.engine_id, 'funasr') as SttEngineId,
    };
    if (typeof r.endpoint === 'string') out.endpoint = r.endpoint;
    if (typeof r.api_key === 'string') out.api_key = r.api_key;
    if (typeof r.model === 'string') out.model = r.model;
    return out;
  });
}

function asDictionary(v: unknown): DictEntry[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter(isObj).flatMap((d) => {
    const term = asStr(d.term);
    if (term === '') return [];
    const out: DictEntry = { term };
    // The template renders `d.aliases.join('、')` behind a truthy `.length` check
    // — which a STRING also satisfies, so a string here threw `.join is not a
    // function`. Normalize to a real array of strings either way.
    if (Array.isArray(d.aliases)) {
      out.aliases = d.aliases.filter((a): a is string => typeof a === 'string');
    } else if (typeof d.aliases === 'string' && d.aliases !== '') {
      out.aliases = [d.aliases];
    }
    if (typeof d.weight === 'number' && Number.isFinite(d.weight)) out.weight = d.weight;
    return [out];
  });
}

function asLlmConfig(v: unknown): LlmConfigModel | null {
  if (!isObj(v)) return null;
  return {
    preset_id: asStr(v.preset_id),
    protocol: asStr(v.protocol, 'openai-compatible'),
    endpoint: asStr(v.endpoint),
    api_key: asStr(v.api_key),
    model: asStr(v.model),
  };
}

/** The card has a real schema, so validate against THAT rather than restating it.
 *  A card that fails only on a bound (one over-long term) is salvaged field by
 *  field instead of discarded — these strings are the owner's own content, and
 *  silently emptying their scenario card would be its own kind of lie. */
function asCard(v: unknown): ScenarioCard | null {
  const parsed = ScenarioCardSchema.safeParse(v);
  if (parsed.success) return parsed.data;
  if (!isObj(v)) return null;
  const arr = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
  return {
    professions: arr(v.professions),
    domains: arr(v.domains),
    packs: arr(v.packs),
    terms: arr(v.terms),
  };
}
/** The V2-08 consent row, narrowed from EITHER source it can arrive from: the
 *  local display cache and the server snapshot both hold the same stored shape
 *  (`{granted, granted_for}`), so there is one narrowing function rather than two
 *  that could disagree about what counts as a consent.
 *
 *  Anything else — including a row whose `granted_for` is outside the closed
 *  vocabulary — reads as NO CONSENT, which is exactly what server-core's reader
 *  does with it. Salvaging a partial row would be inventing an agreement. */
function asConsentRow(v: unknown): ScenarioInferenceConsent | null {
  if (!isObj(v)) return null;
  const granted = v.granted;
  const grantedFor = v.granted_for;
  if (typeof granted !== 'boolean') return null;
  if (grantedFor !== 'local' && grantedFor !== 'external') return null;
  return { granted, grantedFor };
}

function save(key: string, value: unknown): void {
  localKv.set(key, JSON.stringify(value));
}

/** Options offered by the profession/domain chip row (multi-select → card.professions). */
export const PROFESSION_OPTIONS = [
  '软件开发', '云原生 / 运维', '产品设计', '金融', '医疗', '法律', '教育', '科研',
] as const;

/** Labels for the curated dictionary packs (protocol pack ids → UI label).
 *  V2-07.8a: GETTERS reading S — an init-time literal table would freeze the
 *  boot locale and never switch (the status.ts BADGES bug class). */
export const PACK_LABELS: Record<string, string> = {
  get 'tech-dev'() { return S.pack_tech_dev; },
  get medical() { return S.pack_medical; },
  get legal() { return S.pack_legal; },
  get finance() { return S.pack_finance; },
  get 'proper-noun'() { return S.pack_proper_noun; },
  get 'code-switch'() { return S.pack_code_switch; },
};
export const PACKS = DICTIONARY_PACKS.map((p) => ({
  id: p.id,
  get label() { return PACK_LABELS[p.id] ?? p.label; },
}));

export const sttPresets = STT_PRESETS;
export const llmPresets = LLM_PRESETS;

// ── default routing derived from a PRESET (no hard-coded IP) ──
function routingFromPreset(presetId: string, language: string): Routing {
  const p = findSttPreset(presetId);
  const r: Routing = { language, engine_id: (p?.engine ?? 'funasr') as SttEngineId };
  if (p?.endpoint !== undefined) r.endpoint = p.endpoint;
  if (p?.model !== undefined) r.model = p.model;
  if (p?.api_key !== undefined) r.api_key = p.api_key;
  return r;
}
function llmFromPreset(presetId: string): LlmConfigModel {
  const p = findLlmPreset(presetId);
  return {
    preset_id: presetId,
    protocol: p?.protocol ?? 'openai-compatible',
    endpoint: p?.endpoint ?? '',
    api_key: p?.api_key ?? '',
    model: p?.model ?? '',
  };
}

/**
 * 🔴 OSS-DEFAULTS (0.3.0): the STT preset a FRESH install starts on.
 *
 * Was `'lan-funasr-ws'`, whose endpoint is `ws://100.64.7.68:10095` — the
 * owner's office LAN, compiled into the WebView2 bundle of every copy of the
 * app. The header of this section says "no hard-coded IP" and that was true of
 * this FILE and false of the value: the address arrived through the preset.
 *
 * `builtin-sherpa-local` is the 7th bundled engine and runs in-process, so it
 * has NO endpoint at all — [routingFromPreset] simply omits the field. That is
 * why it is the right neutral default rather than merely a blank one: there is
 * no address to get wrong.
 *
 * ⚠️ This is the PRE-FIRST-SYNC placeholder only, same as `polishEnabled` below.
 * The server owns the real value and overwrites it on the connected rising edge
 * (`applyServerSettings`). It still matters, because it is what a user sees —
 * and what `inferenceDestination()` classifies — before that first
 * `settings:list` lands, and on a machine that never connects it is the whole
 * answer.
 */
const DEFAULT_STT_PRESET = 'builtin-sherpa-local';

/**
 * 🔴 OSS-DEFAULTS (0.3.0): the explicit "LLM not yet configured" state.
 *
 * Was `llmFromPreset('lan-vllm-qwen35')` ⇒ `http://100.64.7.179:8000/v1`.
 * There is no neutral LLM the way `builtin-sherpa-local` is a neutral STT
 * engine, so the honest default is to have none, stated rather than implied:
 * `preset_id: ''` is the same "the user has not chosen a preset" value
 * [asLlmConfig] already produces for a row with no preset, so the
 * unconfigured state has ONE spelling instead of two.
 *
 * The empty `endpoint` is not a dialable address on either side of the wire:
 * server-core `compose/llm-config.ts validate()` refuses it by name
 * (`LLM_INVALID_MODEL` — "llm.config.endpoint is required"), and this side
 * renders it as an empty field, which is what "not configured" looks like.
 */
const LLM_UNCONFIGURED: LlmConfigModel = {
  preset_id: '',
  protocol: 'openai-compatible',
  endpoint: '',
  api_key: '',
  model: '',
};

const EMPTY_CARD: ScenarioCard = { professions: [], domains: [], packs: [], terms: [] };

export const model = reactive({
  routings: loadWith<Routing[]>(K_ROUTINGS, [routingFromPreset(DEFAULT_STT_PRESET, 'zh-CN')], asRoutings),
  dictionary: loadWith<DictEntry[]>(K_DICT, [], asDictionary),
  /**
   * WP-R4-6 AI polish. 🔴 THE SERVER OWNS THIS VALUE — this field is a CACHE of
   * the last answer `settings:list` gave, not an opinion of its own.
   *
   * The `false` here is the pre-first-sync placeholder only, and it is no longer
   * load-bearing: as of 0.3.0 L2 the server states `stt.polish` in every
   * `settings:list` even when the account has no row (settings.handler.ts
   * `withEffectiveDefaults`), so `applyServerSettings` always overwrites this on
   * the connected rising edge. It used to be the ONLY answer for an account that
   * had never touched the switch — and it was the wrong one, because the server's
   * default is not this constant. That rendered the toggle OFF while polish ran on
   * every closing final (RT ledger §6.1 item 6; R11).
   * ⚠️ Do NOT "fix" this by hard-coding `true` when the default flips. A local
   * mirror of a server-side constant is the defect itself, not the value it was
   * set to — the mirror goes stale on the deploy that changes the constant, and
   * this UI ships in a binary that deploy cannot reach.
   */
  polishEnabled: loadWith<boolean>(K_POLISH, false, asBoolean),
  /**
   * Card C8 — how far the polish layer may go. Only meaningful while
   * `polishEnabled` is true, and deliberately NOT cleared when the toggle goes
   * off: a user who turns polish off and back on should find the choice they
   * made, not a silently reset one.
   *
   * ⚠️ The default is the PRODUCT default (`strict`), not a neutral one, and
   * the difference matters on this side specifically: this value is what a user
   * sees before the first `settings:list` lands, so a wrong placeholder here
   * would show `smooth` to someone whose account is on `strict` — the exact
   * "the switch reports whether a row exists rather than what the server does"
   * shape that card POLISH-CFG was written to close.
   */
  polishStrength: loadWith<PolishStrength>(K_POLISH_STRENGTH, DEFAULT_POLISH_STRENGTH, asPolishStrength),
  /**
   * Card POLISH-CFG — "can a usable language model be resolved," answered by
   * the SERVER (`capability.llm`, value `{usable:boolean}`) and rendered
   * beside the polish switch as "the capability AI polish needs is not
   * configured, and it is not in effect."
   *
   * 🔴 WHY THE DESKTOP CANNOT ANSWER THIS ITSELF, i.e. why it is on the wire at
   * all. The effective `stt.polish` says on/off but never WHY, and this side can
   * only see the `llm.config` ROW — while the platform's managed default is
   * env-gated and is never a row. A desktop that inferred "not configured" from
   * an empty `model.llm.endpoint` would call a working cloud account "not
   * configured." Book 15 R11: the layer making the claim must hold the fact
   * the claim needs.
   *
   * 🔴 `true` IS THE PRE-FIRST-SYNC VALUE ON PURPOSE, AND IT IS NOT A GUESS AT
   * THE ANSWER — it is the absence of a claim. The sentence renders only on
   * `false`, so this default means "we have not been told anything, so we
   * assert nothing." Starting at `false` would print "not configured" on
   * every cold start, before a single `settings:list` has landed, on machines
   * that are configured fine.
   *
   * ⚠️ NOT cached in localStorage, unlike every field around it. Those are
   * settings whose last known value is still the user's intent after a restart;
   * this is a fact about the server RIGHT NOW, and a cached copy would happily
   * outlive the configuration it described — an "expired-but-still-true
   * statement" (过期的真话) with a persistence layer. No row exists to write,
   * so there is nothing to write back either.
   */
  llmCapabilityUsable: true,
  refineEnabled: loadWith<boolean>(K_REFINE, false, asBoolean),
  llm: loadWith<LlmConfigModel>(K_LLM, { ...LLM_UNCONFIGURED }, asLlmConfig),
  card: loadWith<ScenarioCard>(K_SCENARIO, EMPTY_CARD, asCard),
  /** V2-08 — the consent this PC last recorded, or `null` for "never asked,"
   *  which is the state every install starts in and the state the feature is
   *  OFF in. NOT a
   *  boolean: what the user agreed to includes WHICH destination they were shown
   *  (protocol `ScenarioInferenceConsent`), and dropping that half is how a
   *  consent given for a LAN box silently becomes one for a vendor. */
  inferenceConsent: loadWith<ScenarioInferenceConsent | null>(K_INFER, null, asConsentRow),
});

// ── STT routings ──
function pushRoutings(): void {
  save(K_ROUTINGS, model.routings);
  // The wire value is the plain routing array (07 §8 / engine-factory reader).
  settings.setSttRoutings(model.routings.map((r) => ({ ...r })));
}
export function setPresetForRouting(index: number, presetId: string): void {
  const r = model.routings[index];
  if (!r) return;
  const preset = routingFromPreset(presetId, r.language);
  model.routings[index] = preset;
  pushRoutings();
}
export function addRouting(): void {
  model.routings.push(routingFromPreset('builtin-sherpa-local', '*'));
  pushRoutings();
}
export function removeRouting(index: number): void {
  model.routings.splice(index, 1);
  pushRoutings();
}
export function updateRoutingField(index: number, field: keyof Routing, value: string): void {
  const r = model.routings[index];
  if (!r) return;
  (r as Record<string, unknown>)[field] = value;
  pushRoutings();
}

// ── personal dictionary (stt.dictionary — variable key, NOT a drift anchor) ──
function pushDictionary(): void {
  save(K_DICT, model.dictionary);
  settings.updateSetting(STT_DICTIONARY_KEY, model.dictionary.map((d) => ({ ...d })));
}
export function addDictEntry(term: string): boolean {
  const t = term.trim();
  if (t.length === 0 || model.dictionary.some((d) => d.term === t)) return false;
  model.dictionary.push({ term: t });
  pushDictionary();
  return true;
}
export function removeDictEntry(term: string): void {
  model.dictionary = model.dictionary.filter((d) => d.term !== term);
  pushDictionary();
}

// ── AI polish (stt.polish — literal SET anchor via settings.setSttPolish) ──
function pushPolish(): void {
  save(K_POLISH, model.polishEnabled);
  save(K_POLISH_STRENGTH, model.polishStrength);
  // 🔴 CARD C8 DEPLOYMENT ORDER LIVES ON THIS LINE. `SttPolishSchema` is
  // `.strict()`, so a server that predates the `strength` field REJECTS this
  // write outright (SETTINGS_SCHEMA_INVALID) — the write does not degrade to
  // "enabled only", it fails, and the user's toggle stops working. Both server
  // halves therefore ship first: the relay, AND the LAN server that ships
  // inside this same desktop installer.
  //
  // ⚠️ The second half is the one that is easy to miss, and it is also the one
  // that makes this safe in practice: the LAN server travels in the installer
  // with this UI, so for the LAN path the two are never out of step by
  // construction. The exposure is a NEW desktop talking to an OLD relay.
  settings.setSttPolish({ enabled: model.polishEnabled, strength: model.polishStrength });
}
export function setPolishEnabled(enabled: boolean): void {
  model.polishEnabled = enabled;
  pushPolish();
}
/** Card C8. Deliberately reachable while polish is OFF (the control is rendered
 *  disabled, not hidden) so the value the user picks is the value they get when
 *  they turn it on — rather than a choice silently discarded in between. */
export function setPolishStrength(strength: PolishStrength): void {
  model.polishStrength = strength;
  pushPolish();
}

// ── two-pass refine (stt.refine — literal SET anchor via settings.setSttRefine) ──
// GA-14. OFF by default and the default is load-bearing: a second full
// transcription is a second engine bill for that utterance.
function pushRefine(): void {
  save(K_REFINE, model.refineEnabled);
  settings.setSttRefine({ enabled: model.refineEnabled });
}
export function setRefineEnabled(enabled: boolean): void {
  model.refineEnabled = enabled;
  pushRefine();
}

// ── LLM config ──
function pushLlm(): void {
  save(K_LLM, model.llm);
  // Push the resolved inline config (protocol/endpoint/api_key/model) — the
  // server llm-config reader accepts either inline or preset_id + overrides.
  settings.setLlmConfig({
    protocol: model.llm.protocol,
    endpoint: model.llm.endpoint,
    api_key: model.llm.api_key,
    model: model.llm.model,
  });
}
export function setLlmPreset(presetId: string): void {
  model.llm = llmFromPreset(presetId);
  pushLlm();
}
export function updateLlmField(field: keyof LlmConfigModel, value: string): void {
  (model.llm as Record<string, unknown>)[field] = value;
  pushLlm();
}

// ── scenario card (scenario.card — literal SET anchor via settings.setScenarioCard) ──
function pushCard(): void {
  save(K_SCENARIO, model.card);
  settings.setScenarioCard({ ...model.card });
}
function toggleIn(list: string[], value: string, max: number): string[] {
  if (list.includes(value)) return list.filter((x) => x !== value);
  if (list.length >= max) return list; // at cap → no-op
  return [...list, value];
}
export function toggleProfession(value: string): void {
  model.card.professions = toggleIn(model.card.professions, value, SCENARIO_MAX_PROFESSIONS);
  pushCard();
}
export function toggleDomain(value: string): void {
  model.card.domains = toggleIn(model.card.domains, value, SCENARIO_MAX_DOMAINS);
  pushCard();
}
export function togglePack(id: string): void {
  model.card.packs = toggleIn(model.card.packs, id, SCENARIO_MAX_PACKS);
  pushCard();
}
export type TermAdd = 'added' | 'duplicate' | 'too-long' | 'at-cap' | 'empty';
export function addTerm(raw: string): TermAdd {
  const t = raw.trim();
  if (t.length === 0) return 'empty';
  if (t.length > SCENARIO_MAX_LABEL_LEN) return 'too-long';
  if (model.card.terms.includes(t)) return 'duplicate';
  if (model.card.terms.length >= SCENARIO_MAX_TERMS) return 'at-cap';
  model.card.terms = [...model.card.terms, t];
  pushCard();
  return 'added';
}
export function removeTerm(term: string): void {
  model.card.terms = model.card.terms.filter((x) => x !== term);
  pushCard();
}

// ── V2-08 scenario inference consent (scenario.inference — CONSTANT key, NOT a drift anchor) ──
//
// The switch writes a row shaped exactly the way server-core's reader accepts:
// `{granted, granted_for}` built by the protocol's own [scenarioConsentRow], with
// `granted_for` computed by the protocol's own [classifyDestination]. Neither is
// re-derived here, and that is the whole point of the card that added them: a
// consent row whose `granted_for` is not in the closed vocabulary reads as
// MALFORMED server-side ⇒ "no setting" ⇒ the feature stays off ⇒ the user has
// ticked a box that changes nothing, which is worse than not offering the box.
//
// SCOPE: `settings:update` is pinned to the LAN socket (src-tauri shell::mod.rs
// `with_lan_socket`), so this row reaches the self-hosted server only — the same
// scope every other setting on this page has, which is why the consent card
// repeats the "the settings below apply to the local LAN channel" note.

/** Where the model that would be shown the executable name lives RIGHT NOW —
 *  derived from the LLM endpoint on screen, so the consent card and the server
 *  gate cannot disagree about which endpoint is in question.
 *
 *  Passes the deployment overlay from presets (`ADDITIONAL_PRIVATE_CIDRS`) so
 *  owner D1's office LAN (`100.64.7.*`) classifies as local here. The
 *  classifier itself never hard-codes that range — omitting the argument would
 *  fall back to RFC1918-only. */
export function inferenceDestination(): ModelDestination {
  return classifyDestination(model.llm.endpoint, ADDITIONAL_PRIVATE_CIDRS);
}

/** Why the feature is not running, or `undefined` when it is. The SAME function
 *  the server gate calls — the desktop must not answer this itself, because every
 *  way the two answers could differ is a lie on screen. */
export function inferenceBlocked(): InferenceBlockedReason | undefined {
  return inferenceBlockedReason(model.inferenceConsent ?? undefined, inferenceDestination());
}

/** What the switch shows. NOT `consent.granted`: a consent granted for a LAN box
 *  while the endpoint now points elsewhere is granted AND not in force, and a
 *  switch rendered from `granted` alone would sit there claiming ON. */
export function inferenceEnabled(): boolean {
  return inferenceBlocked() === undefined;
}

/** Record (or withdraw) consent for the endpoint currently on screen.
 *  Change-applies-immediately — no confirm button, no second step. */
export function setScenarioInferenceGranted(granted: boolean): void {
  const consent: ScenarioInferenceConsent = { granted, grantedFor: inferenceDestination() };
  model.inferenceConsent = consent;
  const row = scenarioConsentRow(consent);
  save(K_INFER, row);
  // Withdrawal is a WRITTEN `granted:false`, not a deleted row: the server drops
  // this user's whole descriptor cache whenever the consent premises change, and
  // that is the mechanism behind "once turned off, use stops immediately from
  // the next sentence on (including any previously-cached inference)."
  // It also records that the user answered, rather than that we forgot to ask.
  settings.updateSetting(SCENARIO_INFERENCE_KEY, row);
}

export const SCENARIO_CAPS = {
  professions: SCENARIO_MAX_PROFESSIONS,
  domains: SCENARIO_MAX_DOMAINS,
  packs: SCENARIO_MAX_PACKS,
  terms: SCENARIO_MAX_TERMS,
  labelLen: SCENARIO_MAX_LABEL_LEN,
};

// ── settings:list bridge (WP-R3.5 — R2-2 deferred refinement) ────────────────
// On the connected rising edge the desktop pulls the server-authoritative
// settings snapshot and ADOPTS it into this display cache. This is the observable
// consumer that closes the R2-2 deferral (07 §8: "loading its snapshot
// (settings:list) is a later refinement"). Server wins for a key the user has NOT
// locally edited-and-not-yet-synced (settings.isKeyPending → last-write-wins for
// an in-flight local edit); only the five keys this model owns are mapped, and a
// malformed value is skipped (defensive — never throws into the UI). For a PC the
// server returns unredacted at-rest-decrypted plaintext (settings.handler §3.7),
// the same shape this model writes via the anchor methods, so adoption is loss-
// less. NO endpoint/IP is introduced here — values come straight from the server.

/** Adopt a server settings:list snapshot into the reactive model + display cache.
 *  Pure w.r.t. the network (takes the already-fetched items) so it is unit-testable. */
export function applyServerSettings(items: ServerSettingItem[]): void {
  for (const { key, value, updated_at } of items) {
    // 🔴 C3 — EVERY item is evidence about the clock our own writes are judged
    // against, including the ones this model does not own and the one the server
    // pushed back because it refused our write (that loser frame arrives as a
    // settings:updated notification and lands here via the re-pull below). Fed
    // BEFORE the pending check on purpose: whether we adopt a value and what it
    // tells us about the other side's timebase are two different questions, and
    // skipping the second is how a lagging clock keeps losing silently.
    settings.observeStamp(updated_at);
    if (settings.isKeyPending(key)) continue; // a pending local edit wins (already saved locally)
    switch (key) {
      case SETTINGS_ANCHOR_KEYS.sttRoutings: // 'stt.routings'
        if (Array.isArray(value)) {
          model.routings = (value as Routing[]).map((r) => ({ ...r }));
          save(K_ROUTINGS, model.routings);
        }
        break;
      case STT_DICTIONARY_KEY: // 'stt.dictionary'
        if (Array.isArray(value)) {
          model.dictionary = (value as DictEntry[]).map((d) => ({ ...d }));
          save(K_DICT, model.dictionary);
        }
        break;
      case SETTINGS_ANCHOR_KEYS.sttPolish: { // 'stt.polish'
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const enabled = (value as { enabled?: unknown }).enabled;
          if (typeof enabled === 'boolean') {
            model.polishEnabled = enabled;
            save(K_POLISH, model.polishEnabled);
          }
          // Card C8. ABSENT is a real answer, not a missing one: every row
          // written before this field existed omits it, and it means `strict`.
          // Adopting the default here rather than leaving the cached value
          // alone is what makes the control report what the SERVER will do —
          // the same rule the `enabled` half already follows, and the reason
          // `capability.llm` above is documented as the opposite case (there,
          // unparseable really does mean "no new answer").
          const strength = asPolishStrength((value as { strength?: unknown }).strength);
          model.polishStrength = strength ?? DEFAULT_POLISH_STRENGTH;
          save(K_POLISH_STRENGTH, model.polishStrength);
        }
        break;
      }
      case CAPABILITY_LLM_KEY: { // 'capability.llm' — READ-ONLY `{usable:boolean}`
        // Adopted like any other snapshot value, with ONE difference stated so it
        // is not "tidied up" later: there is no `save(...)` and no push-back. It
        // is a fact the server recomputes per read, not a value this PC owns.
        // A malformed / missing `usable` leaves the last known answer alone — the
        // same stance as the consent row: "cannot parse it" is not "the answer
        // is false," and guessing false here puts "not configured" on screen
        // for a configured account.
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const usable = (value as { usable?: unknown }).usable;
          if (typeof usable === 'boolean') model.llmCapabilityUsable = usable;
        }
        break;
      }
      case SETTINGS_ANCHOR_KEYS.llmConfig: // 'llm.config' (inline {protocol,endpoint,api_key,model})
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const v = value as Partial<LlmConfigModel>;
          model.llm = {
            preset_id: model.llm.preset_id, // server value has no preset_id — keep the UI's
            protocol: v.protocol ?? model.llm.protocol,
            endpoint: v.endpoint ?? model.llm.endpoint,
            api_key: v.api_key ?? model.llm.api_key,
            model: v.model ?? model.llm.model,
          };
          save(K_LLM, model.llm);
        }
        break;
      case SETTINGS_ANCHOR_KEYS.scenarioCard: // 'scenario.card'
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const c = value as Partial<ScenarioCard>;
          model.card = {
            professions: c.professions ?? [],
            domains: c.domains ?? [],
            packs: c.packs ?? [],
            terms: c.terms ?? [],
          };
          save(K_SCENARIO, model.card);
        }
        break;
      case SCENARIO_INFERENCE_KEY: { // 'scenario.inference' (V2-08 consent row)
        // The SERVER's row is the one the gate actually reads, so it wins over
        // this PC's display cache. A row this narrows to null is left alone
        // rather than adopted as "not consented": "cannot parse it" and "the
        // user refused" are two different facts, and only the server's own
        // reader gets to act on the first one (it does — as off, loudly).
        const consent = asConsentRow(value);
        if (consent !== null) {
          model.inferenceConsent = consent;
          save(K_INFER, scenarioConsentRow(consent));
        }
        break;
      }
      // Unknown keys (device.*, preferences.*, …) are not owned by this model — skip.
    }
  }
}

/** Pull + adopt the server settings snapshot. Called on the LAN connected rising
 *  edge (App.vue) and on every settings:updated frame (below). A down socket /
 *  empty snapshot is a no-op (keep the local cache). */
export async function pullServerSettings(): Promise<void> {
  const items = await fetchServerSettings();
  if (items.length > 0) applyServerSettings(items);
}

// ── RV-22 `settings:updated` → re-pull the server snapshot ──
//
// Rust forwards the server's settings:updated onto the flowmic://settings-updated
// bridge channel (socket/client.rs) and lib/bridge.ts declares the channel, but
// NOTHING in this window listened — a setting changed from the phone left the PC's
// settings page stale for the entire session. Wired rather than deleted: keeping
// the two ends in step is the only reason that forward exists.
//
// The listener lives HERE, next to its sink, and not in store.ts's initBridge:
// this module already imports store.ts, so wiring it there would close an import
// cycle (lint 3/9 `circular`). App.vue registers it at mount — that is the one
// production caller, and it registers BEFORE the first pull can happen (the
// "register the listener before pulling the snapshot" rule store.ts spells
// out at its snapshot seed).

/** Debounce window (ms). One server-side batch (e.g. three engine keys written
 *  together) emits several settings:updated frames back-to-back, and each would
 *  otherwise cost a settings:list round-trip whose answer is identical. */
const SETTINGS_PULL_DEBOUNCE_MS = 200;
let settingsPullTimer: ReturnType<typeof setTimeout> | null = null;

/** The puller, injectable like the stores' transports — the default is the REAL
 *  implementation, never a friendly empty stub (book 13 §7 F1 ②). */
let pullSettings: () => Promise<void> = pullServerSettings;
export function setServerSettingsPuller(fn: () => Promise<void>): void {
  pullSettings = fn;
}

/** Coalesce N settings:updated frames into ONE settings:list pull. Exported so the
 *  coalescing is testable without the Tauri listen layer. */
export function scheduleServerSettingsPull(): void {
  if (settingsPullTimer !== null) return; // a pull is already armed — fold into it
  settingsPullTimer = setTimeout(() => {
    settingsPullTimer = null;
    void pullSettings();
  }, SETTINGS_PULL_DEBOUNCE_MS);
}

/** Subscribe to settings:updated. Returns the unlisten fn (a no-op outside Tauri).
 *  The frame is a NOTIFICATION, not a payload we apply: we re-pull the
 *  server-authoritative snapshot, so there stays exactly ONE way a server value
 *  becomes local state (applyServerSettings). */
export async function watchServerSettingsUpdates(): Promise<() => void> {
  return onChannel(CH.settingsUpdated, () => {
    scheduleServerSettingsPull();
  });
}
