// The settings UI model for the things THIS PC owns: its speech-engine routing
// table and its language-model configuration. A device-local display cache
// (localStorage) is the UI source of truth, hydrated from preset-derived
// defaults, and every edit is pushed to the LAN server through the
// SettingsClient anchor methods (change-applies-immediately, no save button).
// NO endpoint/IP is hard-coded here: STT/LLM endpoints come from the
// @flowmic/protocol presets (goes through the presets package, hard-coding an
// IP is forbidden).
//
// 🔴 WHAT THIS MODEL NO LONGER HOLDS (owner 2026-09-03, phone-owned
// preferences). The scenario card, AI polish, two-pass refine, the personal
// dictionary and the scenario-inference consent were all edited here and pushed
// as settings rows. They are now the PHONE's, they travel with each
// transcription request, and no server stores them — so the fields, the
// mutators and the `applyServerSettings` cases for them are gone rather than
// hidden. A screen that kept writing them would be writing frames the server
// refuses by name, which is the same defect as a control that changes nothing.

import { reactive } from 'vue';
import {
  CUSTOM_PRESET_ID,
  SETTINGS_KEY_CAPABILITY_LLM,
  STT_PRESETS,
  findLlmPreset,
  findSttPreset,
  llmPresetsByGroup,
  sttPresetsByGroup,
  type SttEngineId,
} from '@flowmic/protocol';
// The display-cache narrowing layer, moved out whole at the 800-line cap
// (2026-08-28). That module carries the full argument for every salvage rule;
// this file is one of its call sites. The two shapes it produces are re-exported
// below so the existing importers are untouched.
import { asLlmConfig, loadWith, type LlmConfigModel } from './settings-cache-narrow';
export type { LlmConfigModel };
import { localKv } from '../lib/storage';
import { CH, fetchServerSettings, onChannel } from '../lib/bridge';
import type { ServerSettingItem } from '../lib/types';
import { SETTINGS_ANCHOR_KEYS } from '../lib/settings-client';
// The routing ROW — its type, its narrowing, and §R2's one ordering rule. Moved
// out whole when this file hit the 800-line cap; that module carries the full
// argument and the reverse control, and this file is one of its call sites
// rather than a second opinion. `Routing` is re-exported below so the dozen
// existing importers are untouched.
import { asOrderedRoutings, orderedRoutings, type Routing } from './stt-routing-order';
export { orderedRoutings, type Routing };
import { settings } from './store';

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
//
// ⚠️ The five keys the phone now owns (`flowmic.ui.stt.dictionary`,
// `flowmic.ui.stt.polish`, `flowmic.ui.stt.polish.strength`,
// `flowmic.settings.sttRefine`, `flowmic.ui.scenario.card`,
// `flowmic.ui.scenario.inference`) are NOT read or written any more, and are
// deliberately not cleared either: this build has no screen that could show
// them, and deleting a user's stored values on upgrade would be a destructive
// act performed by a card whose job was to remove a screen. They are named here
// so the next person does not mint a different spelling for one of them.
const K_ROUTINGS = 'flowmic.ui.stt.routings';
const K_LLM = 'flowmic.ui.llm.config';

function save(key: string, value: unknown): void {
  localKv.set(key, JSON.stringify(value));
}

export const sttPresets = STT_PRESETS;
/** The menu, already sectioned (06 §7.1 ②). Re-exported rather than re-derived
 *  in the SFCs: the catalogue decides what the sections are, the page renders
 *  them. */
export const llmPresetSections = llmPresetsByGroup();
export const sttPresetSections = sttPresetsByGroup();

/**
 * Does the stored `llm.preset_id` name a preset that exists?
 *
 * 🔴 THE DEFECT THIS ANSWERS (owner 2026-08-28 defect ①; 06 §7.1 ⑤). A fresh
 * install stores `preset_id: ''` — a deliberate, documented "the user has not
 * chosen" value (see LLM_UNCONFIGURED). But an HTML `<select>` whose `value`
 * matches no `<option>` does not render blank: it shows THE FIRST OPTION. So a
 * PC that had never been configured displayed the first vendor in the catalogue,
 * as though someone had picked it, while the four fields underneath were empty.
 * Book 15 R11 in its purest form — a control stating something it has no basis
 * for.
 *
 * ⚠️ TWO CASES, ONE ANSWER, ON PURPOSE. `''` (never chosen) and a preset id from
 * a build that no longer has it (uninstalled overlay, downgrade, hand-edited
 * cache) are different histories with the same present tense: the menu cannot
 * show what is stored. Both get the 「please choose」 row, and NEITHER rewrites
 * the stored value — the same rule the STT language cell keeps, for the same
 * reason (a settings screen that silently corrects on render leaves the user
 * unable to see what their machine is configured with).
 */
export function llmPresetUnresolved(): boolean {
  return findLlmPreset(model.llm.preset_id) === undefined;
}

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

export const model = reactive({
  /** 🔴 `'zh'`, NOT `'zh-CN'` (owner 2026-08-27 §2-2). One hyphen made this row
   *  unreachable: phone and seeder both say `zh`, routing was string equality,
   *  so a fresh desktop's only routing matched nothing said. The router now
   *  region-normalises too — that rescues the `zh-CN` already cached out there,
   *  this stops new ones being minted; either fix alone leaves half broken. */
  routings: loadWith<Routing[]>(K_ROUTINGS, [routingFromPreset(DEFAULT_STT_PRESET, 'zh')], asOrderedRoutings),
  /**
   * Card POLISH-CFG — "can a usable language model be resolved," answered by
   * the SERVER (`capability.llm`, value `{usable:boolean}`) and rendered on the
   * language-model section as "Translate / Organize are not supported."
   *
   * ⚠️ It used to also gate the sentence beside the AI-polish switch. That
   * switch moved to the phone (owner 2026-09-03), so this fact now has exactly
   * one reader on this end — which is why the sentence naming AI polish lives
   * in `llm_hint`, on the page that owns the configuration polish resolves
   * through, rather than beside a control that is no longer here.
   *
   * 🔴 WHY THE DESKTOP CANNOT ANSWER THIS ITSELF, i.e. why it is on the wire at
   * all. This side can only see the `llm.config` ROW — while the platform's
   * managed default is env-gated and is never a row. A desktop that inferred
   * "not configured" from an empty `model.llm.endpoint` would call a working
   * cloud account "not configured." Book 15 R11: the layer making the claim
   * must hold the fact the claim needs.
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
  llm: loadWith<LlmConfigModel>(K_LLM, { ...LLM_UNCONFIGURED }, asLlmConfig),
});

// ── STT routings ──
/**
 * The single write seam. Every mutator below funnels through it, so「what the
 * array holds」and「what the screen shows」cannot become two answers (owner
 * ruling §R2: 持久化数组与展示同序). Order is decided in ONE place —
 * `./stt-routing-order`, which carries the argument and the reverse control.
 */
function pushRoutings(): void {
  model.routings = orderedRoutings(model.routings);
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
/** Append a routing row.
 *
 *  🔴 `'en'`, NOT `'*'` (owner 2026-08-27 §2-1: 默认英文). 「Add language」 that
 *  adds a catch-all answers a different question from the one the button asks,
 *  and the seed already ships a `'*'` row — so the old default minted a SECOND
 *  wildcard that shadowed the first by list position, unexplained on screen.
 *  ⚠️ The fallback stays choosable (an option in the select, with a sentence for
 *  a label); it is just no longer what 「add」 hands you unasked.
 *
 *  🔴 THE BARE `push` IS DELIBERATE under §R2 (「新增行在兜底行之上」): the
 *  invariant in [pushRoutings] places the row, so this must not grow a second
 *  placement rule. One question, one answer. */
export function addRouting(): void {
  model.routings.push(routingFromPreset('builtin-sherpa-local', 'en'));
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

/**
 * Hand-edit one config field.
 *
 * 🔴 THE EDIT MOVES THE DROPDOWN TO `custom`, AND THAT IS THE WHOLE FUNCTION
 * (owner 2026-08-28 defect ②; 06 §7.1 ⑥). Before this, `preset_id` kept naming
 * whichever vendor had last been PICKED while the endpoint, model and key
 * underneath had been edited to something else entirely — so the screen answered
 * 「which row did I click」 with a control the user reads as 「what is this PC
 * configured with」. That is this repo's #1 bug shape: one value answering two
 * questions. There is no third state to invent here; once a field is hand-edited
 * the configuration is, by definition, the user's own.
 *
 * ⚠️ IT IS PERSISTED, not merely displayed — `pushLlm` saves the whole
 * `model.llm`, `preset_id` included. A jump that lived only in the DOM would come
 * back naming the old vendor after a restart, which is the same lie with a delay.
 *
 * ⚠️ NO 「unless the values still match the preset」 EXEMPTION, deliberately. It
 * sounds tidier and it reintroduces the defect in miniature: typing a vendor's
 * exact endpoint back in would silently re-attach a preset the user did not pick,
 * and the rule would then have to answer 「how equal is equal」 (trailing slash?
 * key? model?) — four sub-answers where the honest one needs none.
 *
 * `preset_id` is excluded from `field` AT THE TYPE LEVEL rather than by a
 * run-time guard: this function's entire contract is 「a human edited a config
 * box」, and routing a preset change through it would make the jump below
 * overwrite the very choice being made. [setLlmPreset] is that door.
 */
export function updateLlmField(field: Exclude<keyof LlmConfigModel, 'preset_id'>, value: string): void {
  (model.llm as Record<string, unknown>)[field] = value;
  model.llm.preset_id = CUSTOM_PRESET_ID;
  pushLlm();
}

// ── settings:list bridge (WP-R3.5 — R2-2 deferred refinement) ────────────────
// On the connected rising edge the desktop pulls the server-authoritative
// settings snapshot and ADOPTS it into this display cache. This is the observable
// consumer that closes the R2-2 deferral (07 §8: "loading its snapshot
// (settings:list) is a later refinement"). Server wins for a key the user has NOT
// locally edited-and-not-yet-synced (settings.isKeyPending → last-write-wins for
// an in-flight local edit); only the keys this model owns are mapped, and a
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
          // Ordered on the way in (§R2). The relay stores whatever order it was
          // handed, including arrays written by older builds — adopting them
          // verbatim would hold the invariant everywhere EXCEPT right after a
          // sync, i.e. exactly when the user is looking at the page.
          model.routings = orderedRoutings((value as Routing[]).map((r) => ({ ...r })));
          save(K_ROUTINGS, model.routings);
        }
        break;
      case CAPABILITY_LLM_KEY: { // 'capability.llm' — READ-ONLY `{usable:boolean}`
        // Adopted like any other snapshot value, with ONE difference stated so it
        // is not "tidied up" later: there is no `save(...)` and no push-back. It
        // is a fact the server recomputes per read, not a value this PC owns.
        // A malformed / missing `usable` leaves the last known answer alone:
        // "cannot parse it" is not "the answer is false," and guessing false
        // here puts "not configured" on screen for a configured account.
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
      // Unknown keys are not owned by this model — skip. Since owner
      // 2026-09-03 that set includes `scenario.card` / `stt.polish` /
      // `stt.refine` / `stt.dictionary` / `scenario.inference`: the phone owns
      // them, nothing stores them, and a case here would adopt a value this
      // build has no screen for. Named rather than merely absent, because
      // 「why is this key missing」 is the question a reader arrives with.
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
