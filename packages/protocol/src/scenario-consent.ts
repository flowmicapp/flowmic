// SPEC-REF:
//   docs/strategy/R7-V2-TASK-CARDS.md V2-08 (focus process → LLM scenario
//     inference, explicit consent-type opt-in; card constraint 3
//     「模型去向从本地切到外部时必须重新征求同意」("consent must be re-requested
//     when the model destination moves from local to external"))
//   docs/decisions/2026-07-28-scenario-inference-privacy-boundary.md
//   docs/decisions/2026-07-30-a5-owner-rulings.md ② (exe basename ONLY)
//   docs/decisions/2026-07-31-owner-nine-rulings-batch.md D1 (additional
//     private-network segments are configurable; defaults come from presets,
//     must not be hard-coded into this function)
//   apps/server-core/src/compose/scenario-inference.ts (the descriptor whitelist
//     and the resolution order — the half of V2-08 that stays server-side)
//   packages/protocol/src/constants.ts (SETTINGS_KEY_SCENARIO_INFERENCE — the KV
//     key whose value is a ScenarioConsentRow)
//
// WHY THIS IS IN THE PROTOCOL PACKAGE.
//
// Pure functions and types with NO wire surface: no zod schema, no event name,
// no error code. They are here because two processes have to answer the same
// two questions and get the same answer:
//
//   * the SERVER asks them to decide whether an executable name may be sent to
//     a model at all (apps/server-core/src/compose/scenario-infer-store.ts);
//   * the DESKTOP asks them to decide what its consent screen is allowed to
//     claim — which destination the user is being asked about, and whether a
//     consent recorded earlier still covers the endpoint configured now.
//
// Before this file the classification lived only in server-core, so a consent
// screen could only have been built by re-deriving the rules in the UI. Every
// way the two copies could disagree is a lie on screen: a switch shown ON while
// the gate is closed promises a feature that is not running, and a switch shown
// OFF while the gate is open hides one that is. Sharing the function makes
// 「不许有第二份分类」("no second copy of the classification is allowed") a
// compile-time fact instead of a discipline.

import { ADDITIONAL_PRIVATE_CIDRS } from './engine-presets';
import type { LlmConfig } from './types';

/**
 * WHATWG `URL`, declared locally with the ONE member [hostOf] uses.
 *
 * This package's tsconfig lib is ES2022 with neither DOM nor @types/node, and
 * deliberately so: the same dist is consumed by the server (Node) and by the
 * desktop WebView, and a wire-contract package that can reach for browser-only
 * or Node-only APIs stops being portable. `URL` is a global in both runtimes
 * but belongs to neither lib, so the choice was between this declaration,
 * widening the whole package's lib, and hand-parsing the host — and the last is
 * precisely what
 * [hostOf] refuses to do, because a half-salvaged string is where a wrong
 * `local` verdict comes from.
 */
declare const URL: {
  new (input: string): { readonly hostname: string };
};

/** Where the model that would see the executable name actually lives. */
export type ModelDestination = 'local' | 'external';

/**
 * Classify an LLM endpoint as local or external.
 *
 * owner 2026-07-28: 「本地托管不需要太担心，只有云端或设置了外部模型服务商才需要
 * 关心」("no need to worry much about locally-hosted; only cloud or a configured
 * external model vendor needs concern"). That ruling only means anything if
 * this function is right about which one is in front of the user — so the UI
 * shows the destination rather than a generic warning, and this is where the
 * destination comes from.
 *
 * WHAT IT ACTUALLY ANSWERS is 「这个地址能不能被证明是私网」("can this address be
 * proven to be a private network"), NOT 「这是不是别人的服务」("is this someone
 * else's service"). Only the first question is decidable from an endpoint
 * string, and the difference is load-bearing for anything that renders the
 * verdict.
 *
 * Built-in truth (NOT configurable): loopback, RFC1918, link-local, and the
 * intranet-name heuristics below. Those ranges are facts, not preferences —
 * a caller cannot shrink or override them.
 *
 * Deployment overlay (OPTIONAL second argument): additional IPv4 CIDRs the
 * deployer treats as private. Defaults live in the presets package
 * (`ADDITIONAL_PRIVATE_CIDRS`). This function never reads that constant itself —
 * callers pass it (or [destinationOf] defaults to it). Omitting the argument
 * (or passing `undefined` / `[]`) keeps the RFC1918-only verdict — fail closed:
 * one extra confirmation beats quietly trusting a globally-routable address.
 * The private-line CIDR must NOT be hard-coded here (CLAUDE.md: 「代码禁写死，
 * 预设走 presets 包」("code must not hard-code it, presets go through the
 * presets package"); owner D1 2026-07-31).
 *
 * UNPARSEABLE OR UNKNOWN ⇒ `'external'`, deliberately. A hostname this function
 * does not recognise is not evidence of a private network; it is absence of
 * evidence, and the failure direction must be the one that asks the user rather than the
 * one that quietly widens what leaves the machine. The two mistakes are not
 * symmetric: mistakenly treating an external endpoint as local hands the list of
 * applications the user dictates into to whoever runs that endpoint, under a
 * consent they gave for a box on their own LAN. Mistakenly treating a local
 * endpoint as external costs one extra confirmation.
 */
export function classifyDestination(
  endpoint: string | undefined,
  additionalPrivateCidrs?: readonly string[],
): ModelDestination {
  const host = hostOf(endpoint);
  if (host === undefined) return 'external';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'local';
  // mDNS / single-label intranet names resolve on the local network only.
  if (host.endsWith('.local')) return 'local';
  if (host === '::1' || host === '[::1]') return 'local';

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (octets.some((o) => o > 255)) return 'external';
    const [a, b] = octets;
    if (a === 127) return 'local'; // loopback
    if (a === 10) return 'local'; // RFC1918 10/8
    // RFC1918 172.16/12 is 172.16–172.31 ONLY — built-in, not overridable.
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return 'local';
    if (a === 192 && b === 168) return 'local'; // RFC1918 192.168/16
    if (a === 169 && b === 254) return 'local'; // link-local
    // Deployment overlay: only reached after the built-in ranges said no.
    if (matchesAdditionalCidr(octets as [number, number, number, number], additionalPrivateCidrs)) {
      return 'local';
    }
    return 'external';
  }
  // A bare single-label host (`vllm-box`, `nas`) is an intranet name — it cannot
  // resolve on the public internet without a search domain.
  if (!host.includes('.') && !host.includes(':')) return 'local';
  return 'external';
}

/** True when `octets` falls inside any well-formed CIDR in `cidrs`. Malformed
 *  entries are skipped (that entry cannot widen the verdict). */
function matchesAdditionalCidr(
  octets: readonly [number, number, number, number],
  cidrs: readonly string[] | undefined,
): boolean {
  if (cidrs === undefined || cidrs.length === 0) return false;
  const hostInt = ipv4ToInt(octets);
  for (const cidr of cidrs) {
    const parsed = parseIpv4Cidr(cidr);
    if (parsed === undefined) continue;
    if ((hostInt & parsed.mask) === (parsed.network & parsed.mask)) return true;
  }
  return false;
}

function parseIpv4Cidr(cidr: string): { network: number; mask: number } | undefined {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return undefined;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return undefined;
  // prefix 0 ⇒ mask 0 (match every IPv4); otherwise shift without sign-bit traps.
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return { network: ipv4ToInt(octets as [number, number, number, number]), mask };
}

function ipv4ToInt(octets: readonly [number, number, number, number]): number {
  return (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
}

function hostOf(endpoint: string | undefined): string | undefined {
  if (typeof endpoint !== 'string') return undefined;
  const raw = endpoint.trim();
  if (raw.length === 0) return undefined;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    // Not a URL. Do NOT try to salvage a host out of it by hand — a half-parsed
    // string is exactly where a wrong `local` verdict would come from.
    return undefined;
  }
}

/** The same verdict for a resolved LLM config. Lives beside [classifyDestination]
 *  rather than at either caller so 「同意针对的是哪个字段」("which field the
 *  consent applies to") has one answer.
 *
 *  Default overlay = `ADDITIONAL_PRIVATE_CIDRS` from presets so every production
 *  caller of this helper (desktop consent + server gate) shares one deployment
 *  answer without re-deriving it. Pass `[]` to force the RFC1918-only path.
 *  [classifyDestination] itself still defaults to no overlay — that is the
 *  fail-closed primitive; this helper is the deployment-aware wrapper. */
export function destinationOf(
  config: Pick<LlmConfig, 'endpoint'> | undefined,
  additionalPrivateCidrs: readonly string[] = ADDITIONAL_PRIVATE_CIDRS,
): ModelDestination {
  return classifyDestination(config?.endpoint, additionalPrivateCidrs);
}

/**
 * What the user actually agreed to. Stored, not derived — consent is a fact
 * about a past moment, and the whole point of recording the destination is that
 * the current one can differ from it.
 */
export interface ScenarioInferenceConsent {
  /** The user pressed the confirm button on the consent screen. */
  readonly granted: boolean;
  /** The destination that was shown to them AT THAT MOMENT. */
  readonly grantedFor: ModelDestination;
}

/** Why the feature is not running (or `undefined` when it is). */
export type InferenceBlockedReason =
  | 'no-consent'
  /** Consented against a LAN box; the model now lives somewhere else. */
  | 'destination-widened';

/**
 * The gate. Returns the reason the feature must stay OFF, or `undefined`.
 *
 * Card constraint 3: 「模型去向从本地切到外部时必须重新征求同意——否则在本地环境下
 * 同意的事，被一次模型切换悄悄扩大了范围。」("consent must be re-requested when the
 * model destination moves from local to external — otherwise something agreed
 * to under a local setup gets silently widened in scope by a model switch.")
 * That is the second branch. Note it is one-directional on purpose: external →
 * local NARROWS the exposure, and re-prompting for a change that only makes
 * things safer trains people to click through consent screens.
 *
 * The desktop calls this for a second reason the server does not have: it is
 * the ONLY honest source for what the consent switch may display. 「granted 是
 * true」("granted is true") and 「功能正在跑」("the feature is running") are two
 * different questions, and the second one is this function.
 */
export function inferenceBlockedReason(
  consent: ScenarioInferenceConsent | undefined,
  current: ModelDestination,
): InferenceBlockedReason | undefined {
  if (consent === undefined || !consent.granted) return 'no-consent';
  if (consent.grantedFor === 'local' && current === 'external') return 'destination-widened';
  return undefined;
}

/**
 * The consent row AS STORED — the JSON value of the SETTINGS_KEY_SCENARIO_INFERENCE
 * user_settings key. snake_case on the KV/wire side, camelCase in
 * [ScenarioInferenceConsent]; this type is the boundary between the two.
 *
 * It is a TYPE and not a zod schema on purpose: `settings:update` already carries
 * an arbitrary `{key, value}` (protocol-schemas-sync.ts), so the value shape is
 * not a new wire contract and adding one would change the 58-event/55-code
 * surface for nothing.
 *
 * The SHAPE IS CLOSED and the closure is the point: server-core's reader
 * (scenario-infer-store.ts `readConsent`) treats any row whose `granted_for` is
 * not exactly 'local' | 'external' as MALFORMED ⇒ 「没有设置」("not configured")
 * ⇒ feature off. A
 * writer that hand-spelled this object and got the field name or the value
 * vocabulary wrong would produce a switch the user can tick that changes
 * nothing, which is strictly worse than having no switch. [scenarioConsentRow]
 * exists so no caller has to spell it; compose-scenario-infer-store.test.ts
 * feeds its output through the real reader so the two ends are pinned by a test
 * rather than by two comments agreeing with each other.
 */
export interface ScenarioConsentRow {
  readonly granted: boolean;
  readonly granted_for: ModelDestination;
}

/** [ScenarioInferenceConsent] → the stored row. The one place the KV field names
 *  are written on the producing side. */
export function scenarioConsentRow(consent: ScenarioInferenceConsent): ScenarioConsentRow {
  return { granted: consent.granted, granted_for: consent.grantedFor };
}
