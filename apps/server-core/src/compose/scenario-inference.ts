// SPEC-REF:
//   docs/strategy/R7-V2-TASK-CARDS.md V2-08 (focus process → LLM scenario inference,
//     explicit-consent opt-in; four card-face constraints)
//   docs/decisions/2026-07-30-a5-owner-rulings.md ② (owner's exact words "V2-08: pick (a)"
//     — exe basename ONLY; window_title must not be collected under reading (a))
//   docs/decisions/2026-07-28-scenario-inference-privacy-boundary.md
//     (SUPERSEDED on the title question by the 07-30 ruling above; its other
//     four implementation constraints still hold)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (scenario source ②;
//     constraint #2: the scenario block is DATA, never instructions)
//   docs/rebuild/04-PROTOCOL-SPEC.md §156 (window title is sensitive, no table persists it)
//
// The privacy-critical half of V2-08. This file holds the DECISIONS — where the
// model lives, whether consent covers it, and whether an LLM-produced descriptor
// is safe to render into a prompt. The LLM call itself and the cache storage sit
// elsewhere so these rules can be tested without either.
//
// 2026-07-30 NARROWED TO RULING (a). The collection surface is the executable
// basename and nothing else: no window title is read, sent or logged anywhere on
// this path (see [INFERENCE_COLLECTED_FIELDS] and the payload builder in
// scenario-infer-call.ts, which is keyed by that constant so widening it cannot
// compile). The 07-28 ruling had allowed an opt-in title; owner replaced it with
// (a) so the public "app name only, never reads the screen" claim needs no rewrite.
//
// Everything here is still written to fail toward the SAFER answer, because the
// two directions are not symmetric: mistakenly treating an external endpoint as
// local hands the list of applications the user dictates into to whoever runs
// that endpoint, under a consent they gave for a box on their own LAN.
// Mistakenly treating a local endpoint as external costs one extra confirmation.
//
// 2026-07-30 card Z2 — THE CLASSIFIER AND THE GATE NOW LIVE IN THE PROTOCOL
// PACKAGE (packages/protocol/src/scenario-consent.ts), imported below. Nothing
// about them changed; what changed is who else can ask. They used to be reachable
// only from server-core, so the desktop consent SCREEN could not have been built
// without re-deriving "whether this endpoint counts as a private network" and
// "whether the recorded consent still counts" in the
// UI — and a second copy of those two rules is a lie on screen the first time the
// copies disagree (a switch shown ON while the gate is shut promises a feature
// that is not running). The reasons why each branch is what it is travelled with
// the code; read them there before touching either. Everything BELOW this line —
// the descriptor whitelist, the resolution order, the collection whitelist and
// the forensic line — is prompt-safety and stays here, because no UI needs it and
// the payload builder that depends on it is server-side.

import type { ErrorCode, InferenceBlockedReason } from '@flowmic/protocol';

// ── the descriptor whitelist ────────────────────────────────────────────────

/**
 * Longest accepted descriptor. The built-in ones run to ~72 characters
 * ('writing code or technical content (a code editor or terminal is focused)');
 * 160 leaves room without leaving room for a paragraph.
 */
export const MAX_DESCRIPTOR_LENGTH = 160;

/**
 * Allowed characters: ASCII letters, digits, space, and a short punctuation set.
 *
 * NOT a stylistic preference. This descriptor is produced by an LLM, keyed by a
 * process name the user does not control either, and then rendered into the
 * system prompt of the NEXT model call. Without this it is a user-supplied
 * prompt fragment delivered by way of an executable name (master-plan §4.1
 * constraint #2 exists for exactly this). Excluded on purpose:
 *   * newlines — the scenario block is delimited; a newline is the first tool
 *     for climbing out of it;
 *   * backticks, angle brackets, braces, brackets — template/markup fence
 *     characters;
 *   * non-ASCII — the built-in descriptors are English by design, and allowing
 *     arbitrary Unicode reopens homoglyph and bidi tricks for no gain.
 */
const DESCRIPTOR_ALLOWED = /^[A-Za-z0-9 .,:;'()/-]+$/;

/** Phrases that turn reference data into an instruction. Matched case-insensitively. */
const IMPERATIVE_MARKERS: readonly string[] = [
  'ignore',
  'disregard',
  'instead',
  'system:',
  'assistant:',
  'user:',
  'you must',
  'you should',
  'do not output',
  'output only',
  'respond with',
  'prompt',
];

export type DescriptorRejection =
  | 'empty'
  | 'too-long'
  | 'charset'
  | 'imperative';

export interface DescriptorVerdict {
  /** The descriptor to use, or undefined when it was rejected. */
  readonly value?: string;
  readonly rejected?: DescriptorRejection;
}

/**
 * Accept an LLM-produced descriptor, or reject it with a reason.
 *
 * A rejection yields NO descriptor — never a repaired one and never a fallback
 * category. Criterion 1: "cannot be inferred or the call fails → undefined, zero
 * contribution to the prompt. Never fall back to 'guessing the closest-looking
 * category'". Sanitising instead of rejecting would be the same mistake
 * in a friendlier costume: the output would look usable while nobody could say
 * what it had been.
 */
export function validateInferredDescriptor(raw: unknown): DescriptorVerdict {
  if (typeof raw !== 'string') return { rejected: 'empty' };
  const value = raw.trim();
  if (value.length === 0) return { rejected: 'empty' };
  if (value.length > MAX_DESCRIPTOR_LENGTH) return { rejected: 'too-long' };
  if (!DESCRIPTOR_ALLOWED.test(value)) return { rejected: 'charset' };
  const lowered = value.toLowerCase();
  for (const marker of IMPERATIVE_MARKERS) {
    if (lowered.includes(marker)) return { rejected: 'imperative' };
  }
  return { value };
}

// ── resolution order ────────────────────────────────────────────────────────

/** Where a descriptor came from. Surfaced so the owner-facing list can say so. */
export type DescriptorSource = 'override' | 'builtin' | 'inferred';

export interface ResolvedDescriptor {
  readonly descriptor: string;
  readonly source: DescriptorSource;
}

export interface DescriptorInputs {
  /** owner's manual correction for this process, if any. Wins over everything. */
  readonly override?: string;
  /** The hand-written closed map (app-category.ts). */
  readonly builtin?: string;
  /** A previously cached LLM inference for this process name. */
  readonly cached?: string;
}

/**
 * Pick the descriptor for a process, or `undefined`.
 *
 * Order is override > builtin > inferred, and the reason override outranks the
 * built-in table is criterion 3: "one wrong judgment will permanently and
 * silently contaminate every sentence under that program". If the
 * owner cannot outrank what the code believes, the correction they typed does
 * nothing and they have no way to tell.
 *
 * Every candidate passes back through [validateInferredDescriptor], including
 * the override — an owner typing a paragraph into that box is not an attacker,
 * but the prompt still has to survive it.
 */
export function resolveDescriptor(
  inputs: DescriptorInputs,
): ResolvedDescriptor | undefined {
  const candidates: readonly [DescriptorSource, string | undefined][] = [
    ['override', inputs.override],
    ['builtin', inputs.builtin],
    ['inferred', inputs.cached],
  ];
  for (const [source, raw] of candidates) {
    if (raw === undefined) continue;
    const verdict = validateInferredDescriptor(raw);
    if (verdict.value !== undefined) return { descriptor: verdict.value, source };
    // A rejected candidate does not fall through to the next one when it came
    // from the OWNER: silently using the built-in after ignoring their typed
    // correction would tell them the opposite of what happened.
    if (source === 'override') return undefined;
  }
  return undefined;
}

// ── what may be collected ───────────────────────────────────────────────────

/**
 * The entire collection surface, written down as a closed list.
 *
 * card-face constraint 2: "the collection-surface whitelist is hard-coded in
 * the code… leaving no opening for 'other process metadata'." It is a
 * constant rather than a comment so a future field has to be added HERE, in a
 * diff a reviewer reads, instead of appearing quietly inside a payload builder.
 *
 * ONE FIELD as of the 2026-07-30 (a) ruling. `window_title` used to be the
 * second entry — it is gone, and it is gone from [InferenceSignal] too, because
 * a whitelist that still names a field the ruling forbids is "ruled for (a),
 * but the code still leaves an opening for (b)". The constant is not decoration: buildInferenceUserMessage builds
 * its payload through a `Record<CollectedField, string>`, so re-adding an entry
 * here fails to compile until someone decides, in the open, what to do with it.
 */
export const INFERENCE_COLLECTED_FIELDS = ['process_name'] as const;

/** A field this feature is allowed to collect. Derived from the whitelist so the
 *  two can never drift. */
export type CollectedField = (typeof INFERENCE_COLLECTED_FIELDS)[number];

export interface InferenceSignal {
  /** The focus process basename, verbatim from `focus:state.process_name`
   *  (04 §3.5 — extension already stripped upstream). The whole signal. */
  readonly processName: string;
}

/**
 * The forensic line for an inference. Deliberately NOT parameterised by anything
 * free-form: card-face constraint 4 says the log is desensitised or process-name-only, and
 * the simplest way to guarantee that is to give the logger no way to receive
 * anything else. `detail` is a closed union of reason literals plus the protocol's
 * closed `ErrorCode` list — no caller can smuggle observed text through it.
 *
 * `unknown` and `error` were added when the store landed: [InferenceOutcome] has
 * five arms and this could only name three of them, so two real outcomes had no
 * honest word and would have had to be logged as something they were not.
 */
export function inferenceLogLine(
  processName: string,
  outcome: 'hit' | 'inferred' | 'rejected' | 'blocked' | 'unknown' | 'error',
  detail?: DescriptorRejection | InferenceBlockedReason | ErrorCode,
): string {
  const tail = detail === undefined ? '' : ` (${detail})`;
  return `scenario-inference ${processName} ${outcome}${tail}`;
}
