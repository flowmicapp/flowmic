// SPEC-REF:
//   docs/strategy/R7-V2-TASK-CARDS.md V2-08 (Option C: LLM inference + per-process cache)
//   docs/decisions/2026-07-30-a5-owner-rulings.md ② (ruling (a): exe basename only)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (restraint #2)
//   ./scenario-inference.ts (the gate + the whitelist this file obeys)
//   ./scenario-infer-store.ts (THE production caller — cache + consent + kick)
//
// The inference call. Runs ONCE per unseen process name, off the hot path — the
// per-utterance variant (Option B) was rejected because a round-trip per sentence
// would eat the ≤800ms scenario-correction budget whole.
//
// This file is deliberately thin. Every decision that matters — may we run at
// all, may this output be used — lives in scenario-inference.ts and is called
// from here rather than re-implemented. What is left is: build a prompt, read
// one answer, hand it to the validator.
//
// ─────────────────────────────────────────────────────────────────────────────
// WIRED 2026-07-30 (F2). The banner that used to sit here said「NOT WIRED YET —
// inferDescriptor has NO production caller」. It now has exactly one:
// [ScenarioInferenceStore.runInference] in ./scenario-infer-store.ts, reached
// from createComposeFactory (compose/index.ts) on a compose:start whose focus
// process has no owner override and no built-in category.
//
// Two things the old banner promised, kept:
//   * the window title is STILL not read anywhere on this path — under ruling (a)
//     it is not collected at all, so the public "we only use the app name, we
//     never read the screen" claim needs
//     no rewrite and the web Privacy page stays as it is;
//   * nothing here is a friendly stub. Every refusal returns a NAMED outcome and
//     the store logs each one — a blocked gate, a rejected descriptor and a
//     transport failure are three different lines, none of them silence.
// ─────────────────────────────────────────────────────────────────────────────

// Card Z2: destinationOf / inferenceBlockedReason and their two types now come from
// the protocol package (shared with the desktop consent screen). Import path only.
import {
  destinationOf,
  inferenceBlockedReason,
  type InferenceBlockedReason,
  type LlmConfig,
  type ScenarioInferenceConsent,
} from '@flowmic/protocol';
import {
  validateInferredDescriptor,
  type CollectedField,
  type DescriptorRejection,
  type InferenceSignal,
} from './scenario-inference';
import type { LlmStreamer } from './llm';

/** Hard ceiling on the inference call. It is not on the utterance path, but an
 *  unbounded call would still hold a socket and a slot forever on a wedged
 *  endpoint. */
export const INFERENCE_TIMEOUT_MS = 8_000;

const SYSTEM_PROMPT = [
  'You classify desktop applications for a dictation tool.',
  'Given an executable name, reply with ONE short',
  'English phrase describing what the user is most likely WRITING in that app.',
  'Examples of the expected shape:',
  '  "composing an email"',
  '  "writing a chat / instant message"',
  '  "writing code or technical content (a code editor or terminal is focused)"',
  'Rules: at most 20 words. Plain ASCII. No quotes, no markdown, no explanation.',
  'If you do not recognise the application, reply with exactly: UNKNOWN',
].join(' ');

/** The literal an honest model returns when it does not know. Kept explicit so
 *  "does not recognise it" has a representation that is NOT a plausible-looking guess. */
export const UNKNOWN_SENTINEL = 'UNKNOWN';

/** M6: what this call actually cost, when the provider reported it. Absent means
 *  UNKNOWN — the caller must not record a zero for it (a recorded 0 would read
 *  as 「ran free」). Same contract as PolishResult.usage in stt/stt-polish.ts. */
export interface InferenceUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export type InferenceOutcome =
  | { readonly kind: 'ok'; readonly descriptor: string; readonly usage?: InferenceUsage }
  /** The gate said no. Nothing was sent anywhere. */
  | { readonly kind: 'blocked'; readonly reason: InferenceBlockedReason }
  /** The model answered but the answer was not usable. The tokens were still
   *  spent — usage rides on this arm so billing records cost, not verdicts. */
  | { readonly kind: 'rejected'; readonly reason: DescriptorRejection; readonly usage?: InferenceUsage }
  /** The model said it does not know — the honest empty answer (also paid for). */
  | { readonly kind: 'unknown'; readonly usage?: InferenceUsage }
  /** Transport / provider failure. No usage: an errored stream reports none, and
   *  absent-means-unknown must not become a fabricated zero. */
  | { readonly kind: 'error'; readonly code: string };

export interface InferenceDeps {
  readonly cfg: LlmConfig;
  readonly consent: ScenarioInferenceConsent | undefined;
  readonly streamer: LlmStreamer;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/**
 * Build the user-message half of the inference prompt.
 *
 * Exported for the test that pins WHAT LEAVES THE MACHINE. Card constraint 2 fixes the
 * collection surface, and the only way to check that claim is to look at the
 * bytes this function produces — a promise about a payload is worth exactly as
 * much as an assertion over the payload.
 *
 * The `collected` record is keyed by [CollectedField], i.e. by the whitelist
 * itself. That is the mechanical half of ruling (a): putting `window_title` back
 * into INFERENCE_COLLECTED_FIELDS makes this object literal a type error until
 * somebody writes down what it renders, so the whitelist cannot become a comment
 * that the payload builder has quietly outgrown.
 */
export function buildInferenceUserMessage(signal: InferenceSignal): string {
  const collected: Record<CollectedField, string> = { process_name: signal.processName };
  return `executable: ${collected.process_name}`;
}

/**
 * Infer a descriptor for one process, or explain why not.
 *
 * NEVER returns a guess. Every non-`ok` branch contributes nothing to the
 * prompt (criterion 1) — there is no "guess the closest-looking category" fallback, because a confident
 * wrong category silently colours every sentence spoken under that app, and
 * unlike a failed injection nothing on screen would ever contradict it.
 */
export async function inferDescriptor(
  signal: InferenceSignal,
  deps: InferenceDeps,
): Promise<InferenceOutcome> {
  const blocked = inferenceBlockedReason(deps.consent, destinationOf(deps.cfg));
  // Checked BEFORE anything is built, let alone sent. The gate is not a
  // formality applied to a payload already in flight.
  if (blocked !== undefined) return { kind: 'blocked', reason: blocked };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? INFERENCE_TIMEOUT_MS,
  );
  try {
    let full = '';
    // M6: token accounting off the provider's own stream. Every arm below where
    // the model ANSWERED carries it out — the tokens were spent before any
    // verdict on the text, so billing must reflect the cost, not the verdict
    // (same rule as the polish pass). Absent = the provider did not say.
    let usage: InferenceUsage | undefined;
    for await (const ev of deps.streamer({
      cfg: deps.cfg,
      system: SYSTEM_PROMPT,
      user: buildInferenceUserMessage(signal),
      signal: controller.signal,
      fetch: deps.fetch,
    })) {
      if (ev.kind === 'error') return { kind: 'error', code: ev.code };
      if (ev.kind === 'done') {
        full = ev.full;
        if (ev.usage) usage = { tokensIn: ev.usage.tokens_in, tokensOut: ev.usage.tokens_out };
      }
    }
    const answer = full.trim();
    // Matched before validation: UNKNOWN is a well-formed answer meaning "no
    // descriptor", and reporting it as a whitelist rejection would blame the
    // model for doing the right thing.
    if (answer.toUpperCase() === UNKNOWN_SENTINEL) return { kind: 'unknown', ...(usage ? { usage } : {}) };

    const verdict = validateInferredDescriptor(answer);
    if (verdict.value === undefined) {
      return { kind: 'rejected', reason: verdict.rejected ?? 'empty', ...(usage ? { usage } : {}) };
    }
    return { kind: 'ok', descriptor: verdict.value, ...(usage ? { usage } : {}) };
  } finally {
    clearTimeout(timer);
  }
}
