// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §5 (final pipeline last stage — the
//     opt-in, meaning-preserving LLM polish applied to the TERMINAL final only;
//     ≤800 ms budget; reuses the shared llm.config, no new model identity)
//   docs/archive/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-6 ④⑤ (failure semantics: deliver
//     the pure two-stage text + wire polish:'skipped'+reason + forensic; never
//     block delivery, never
//     deliver an LLM output that bypassed the guard, never go silent)
//   CLAUDE.md red line: no silent failure; an LLM failure must not silently fall
//     back to injecting the raw STT text
//   Ported from legacy apps/server/src/stt/stt-polish.ts (F-3073 track B).
//     Carry-over takes priority over rewriting: POLISH_SYSTEM_PROMPT, the ≤800ms AbortController, the
//     content-hash LRU(200) that caches ONLY guard-accepted outputs, stripWrapping,
//     and the checkMeaningPreserved gate are carried verbatim in mechanism.
//
//   TWO DELIBERATE CONTRACT REVERSALS vs legacy (new-line red lines — see the
//   inline `DIVERGENCE` notes):
//     1. Settings read is NOT done here (legacy `loadPolishSettings` +
//        `DEFAULT_POLISH_LLM_CONFIG` are DROPPED): the per-session snapshot lives
//        in engine/stt-factory.ts (readSttPolish + resolveLlmConfigWithSource),
//        so a broken `stt.polish` fails LOUD at audio:start instead of legacy's
//        silent-OFF.
//     2. Failure is NEVER silent: legacy logged to console.error only; here every
//        skip is (a) surfaced on the wire by the bridge via `polishWireSignal` and
//        (b) forensically logged through the server `log`, never a bare console.

import type { AppCategory } from '../compose/app-category';
import { logPolishGuard, guardFamily } from '../obs/polish-telemetry';
import { randomUUID, createHash } from 'node:crypto';
import { DEFAULT_POLISH_STRENGTH, type LlmConfig, type LlmProtocol, type PolishStrength } from '@flowmic/protocol';
import {
  streamerFor as defaultStreamerFor,
  type LlmStreamer,
  type LlmStreamOpts,
} from '../compose/llm';
import { toLlmFinishReason, type LlmFinishReason } from '../compose/llm/types';
import { LLM_ROUTE_FATAL_CODES } from '../compose/llm-health';
import type { LlmConfigSource } from '../compose/llm-config';
import { log } from '../log';
import { checkMeaningPreserved } from './stt-polish-guard';
import { trace, traceEnabled, tracedList, tracedText } from '../trace/pipeline-trace';

export { checkMeaningPreserved, CLOSED_CLASS_TERMS, type GuardResult } from './stt-polish-guard';

export {
  POLISH_SYSTEM_PROMPT,
  POLISH_SMOOTH_SYSTEM_PROMPT,
  RULE_DATA_BOUNDARY,
  polishSystemPrompt,
  polishSystemPromptWithScenario,
} from './stt-polish-prompts';
import { polishSystemPromptWithScenario } from './stt-polish-prompts';
import { contextEcho, contextSystemPrompt, pieceRequest, type ContextRule } from './stt-polish-piece'; // card INC-1e, POL-3

// ─── latency budget ──────────────────────────────────────────────────────
//
// 06 §5 says "≤800ms budget" and that number was carried here verbatim as a FLAT
// cap. It is the right number for the case the spec was describing — an in-place
// correction of a few mis-heard characters — and the wrong number for what this
// function actually does, which is correct a WHOLE terminal final. The model has
// to re-emit every character it was handed, so the work is proportional to the
// text while the budget was not.
//
// MEASURED, not assumed (owner's box, server.log 2026-07-28): every utterance of
// 4–12 s of audio polished fine; every utterance of 24–61 s returned
// LLM_TIMEOUT. Same model, same host, same session. A budget that only ever
// succeeds on short sentences is not a safety limit, it is an off switch that
// nobody knew was on — and because the failure path is (correctly) silent-to-
// the-user pure-two-stage text, the owner's long dictations were going
// unpolished all day with only a WARN line to show for it.
//
// So the spec's 800 ms becomes the FLOOR (the in-place case keeps its promise
// exactly), plus a per-character allowance, capped so a genuinely stalled model
// still fails loud instead of holding an utterance hostage.
//
// PER_CHAR is sized for a small local model (the LAN Qwen3.5-4B preset): CJK
// runs ≈1.5 chars/token, so 20 ms/char ≈ 30 ms/token of output — roomy for a
// 4B at any sane batch size, without being a blank cheque. MAX bounds the worst
// case: past 6 s the user is better served by the un-polished text they can
// already read than by a spinner.
//
// MEASURED AGAIN, cloud leg (production LA relay → api.deepseek.com,
// deepseek-v4-flash, thinking disabled via FLOWMIC_LLM_VENDOR_BODY,
// 2026-08-28): a realistic CJK polish round-trip is 0.9–1.6 s, while a short
// utterance's budget under the 800 ms floor was only 1.0–1.2 s — journalctl
// shows three LLM_TIMEOUTs whose elapsedMs beat budgetMs by 1–3 ms. The floor
// was calibrated for a LAN model and put the managed-cloud leg permanently on
// the line. Raised to 2 s per the owner's 2026-08-07 ruling (「LLM 返回超过
// 2S 基本就算不合格了应抛弃」, docs/decisions/2026-08-07-owner-segment-
// polish-2s-budget-and-no-legacy-fleet.md): the polish attempt now GETS the
// full 2 s the ruling allows before the honest skip; beyond it the discard
// stands. LAN models answering in <1 s are unaffected — a floor only matters
// when the model is slower than it.

/** Floor — owner's 2-second disqualification line (2026-08-07 ruling); the
 *  original 06 §5 800 ms figure is kept alive in the per-char term's base. */
export const POLISH_BUDGET_MS = 2_000;
/** Per-input-character allowance on top of the floor. */
export const POLISH_BUDGET_PER_CHAR_MS = 20;
/** Hard ceiling: a stalled model must still fail loud. */
export const POLISH_BUDGET_MAX_MS = 6_000;

/** The budget for an input of `chars` characters. Pure, so the scaling rule is
 *  provable without an LLM. Non-finite / negative input degrades to the floor
 *  rather than to a nonsense budget. */
export function polishBudgetMs(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return POLISH_BUDGET_MS;
  const scaled = POLISH_BUDGET_MS + Math.ceil(chars) * POLISH_BUDGET_PER_CHAR_MS;
  return Math.min(scaled, POLISH_BUDGET_MAX_MS);
}

/** content-hash LRU cache bound. */
const POLISH_CACHE_MAX = 200;

// ─── §wire mapping (the lead's clarification, 2026-07-24) ─────────────────────
/** The canonical `polish_reason` wire values a skip normalizes to (internal
 *  fine-grained detail stays in the forensic log, never on the wire).
 *  `not_configured` (NR-123) is produced only at arming time, by
 *  engine/stt-factory.ts `resolvePolishDep`, never by a polish run.
 *  `model_rejected` (NR-130) is produced only BY a polish run: the provider
 *  refused the configured model for a configuration reason (see
 *  [polishSkipReasonForCode]). */
export type PolishSkipReason = 'timeout' | 'llm_error' | 'empty_output' | 'guard_reject' | 'not_configured' | 'model_rejected';

/**
 * NR-130 (MAIN 2026-09-29) — the wire reason for a streamer error code.
 *
 * `model_rejected` = the provider answered and refused THIS configuration: a key
 * it does not accept (`LLM_AUTH_FAIL`) or a model/endpoint it does not know
 * (`LLM_INVALID_MODEL`). Those are the two codes llm-health.ts
 * `LLM_ROUTE_FATAL_CODES` already names as "broken until someone changes the
 * config" — the same line, read from the same set, so the two cannot drift.
 * The fix is in the model settings, which is what the phone's hint says.
 *
 * 🔴 Everything else stays where it was, and that split is the point (one value,
 * one question): `LLM_TIMEOUT` ⇒ `timeout`; `LLM_RATE_LIMITED`, transport and
 * overload failures ⇒ `llm_error`. Waiting can fix those, so "check your model
 * settings" would be a false instruction for them.
 */
export function polishSkipReasonForCode(code: string): PolishSkipReason {
  if (code === 'LLM_TIMEOUT') return 'timeout';
  return LLM_ROUTE_FATAL_CODES.has(code) ? 'model_rejected' : 'llm_error';
}

/** The honest signal the bridge stamps onto stt:final. A REASON in the result ⇒
 *  the attempt did not succeed ⇒ 'skipped'; NO reason ⇒ polish ran and succeeded
 *  ⇒ 'applied' (see polishWireSignal). */
export type PolishWireSignal =
  | { polish: 'applied' }
  | { polish: 'skipped'; polish_reason: PolishSkipReason };

/** Strip the quoting/markdown-fencing an LLM sometimes wraps its output in.
 *  Exported so the refine pass (stt-refine-llm.ts) strips output the SAME way —
 *  two copies of this would let one leg deliver a fenced string the other would
 *  have cleaned. */
export function stripWrapping(s: string): string {
  let out = s.trim();
  out = out.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
  if ((out.startsWith('"') && out.endsWith('"'))
    || (out.startsWith('“') && out.endsWith('”'))
    || (out.startsWith('「') && out.endsWith('」'))) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

// In-process content-hash LRU. Only GUARD-ACCEPTED outputs are cached (a
// rejected/failed attempt must not poison the cache with the raw fallback).
// Map iteration order is insertion order; re-inserting on hit gives cheap LRU.
const polishCache = new Map<string, string>();

/**
 * 🔴 THE PROMPT IS PART OF THE CACHE KEY, AND THIS IS A CROSS-USER CORRECTNESS
 * GATE, NOT A HIT-RATE TUNING KNOB.
 *
 * This Map is module-level, so it is PROCESS-WIDE: on the relay every account
 * shares it. The key used to be `sha256(model + ' ' + text)`, and that was
 * sound for exactly one reason — the system prompt was a global constant, so
 * "same model, same text" really did imply "same request". It was never sound
 * because the prompt was irrelevant; it was sound because the prompt could not
 * vary.
 *
 * Card C8 makes the prompt vary PER SESSION (correction strength). The moment
 * that is true, a key that omits the prompt says two different requests are the
 * same request: user A dictates a sentence on `smooth`, the smoothed output is
 * cached, and user B dictating the same sentence on `strict` is served A's
 * REWRITTEN text — a setting that silently does the opposite of what it says,
 * on someone else's content. So the discriminator lands here BEFORE the first
 * per-session prompt byte exists, not alongside it.
 *
 * ⚠️ WHY THE PROMPT DIGEST AND NOT THE STRENGTH LABEL. A label only covers the
 * variation someone remembered to enumerate. Digesting the actual system string
 * covers every future one for free — a scenario block, a per-language rule, a
 * dictionary hint — and it cannot fall out of sync with the prompt, because it
 * IS the prompt. The rejected A4 card (scenario in the polish prompt) is
 * precisely the case this pre-empts.
 *
 * ⚠️ WHAT IT STILL DOES NOT COVER, stated rather than implied: `protectedTerms`
 * are per-session and are NOT in the key. That is deliberate and already
 * handled — a cache hit is re-checked against this session's protected terms on
 * the way out (see the `cachedDrift` branch below), so the entry stays valid for
 * sessions without that term instead of being partitioned per dictionary.
 */
const promptDigests = new Map<string, string>();

function promptDigest(system: string): string {
  const memo = promptDigests.get(system);
  if (memo !== undefined) return memo;
  // 16 hex chars = 64 bits. The whole key is hashed again below, so this only
  // has to make DISTINCT PROMPTS distinct, and there are a handful of them per
  // process, not a birthday-problem population.
  const d = createHash('sha256').update(system).digest('hex').slice(0, 16);
  promptDigests.set(system, d);
  return d;
}

function cacheKey(model: string, system: string, text: string): string {
  return createHash('sha256').update(`${model} ${promptDigest(system)} ${text}`).digest('hex');
}

export interface PolishResult {
  timing?: { elapsedMs: number; ttfbMs: number | null; budgetMs: number; cacheHit: boolean; charsOut: number; finishReason: LlmFinishReason };
  /** Either the guard-accepted polished text, or the untouched INPUT (the pure
   *  two-stage text) when skipped/failed/rejected — delivery is never blocked. */
  text: string;
  /** LEGACY text-diff bit (output !== input). NOT the wire semantics — the wire
   *  signal keys off `reason` presence (see polishWireSignal). Kept for the
   *  ported legacy vectors. */
  applied: boolean;
  /** Internal fine-grained detail (forensic log + ported vectors). Present ⇔ the
   *  attempt did not succeed. */
  reason?: string;
  /** The normalized wire reason — set iff `reason` is set. */
  skipReason?: PolishSkipReason;
  /** QP-1: the strength whose output was delivered (present iff no `reason`).
   *  `strict` on a smooth request means the Smooth -> Strict fallback landed. */
  appliedStrength?: PolishStrength;
  /** QP-1: the smooth attempt's reject reason when the fallback was considered. */
  firstReject?: string;
  /** QP-1: present iff the strict fallback call was made. `timing.ttfbMs /
   *  charsOut / finishReason` then describe the STRICT call; this keeps the
   *  smooth call's own numbers (elapsed is from the start of the first call). */
  firstCall?: { elapsedMs: number; ttfbMs: number | null; charsOut: number; finishReason: LlmFinishReason };
  /** v0.2.3 — what this call actually cost, when the model reported it.
   *
   *  owner 2026-07-29 read "LLM tokens 0 / 250000" on the console while polish
   *  had been running on every utterance all day. It was not a broken meter: the
   *  ONLY `recordLlmUsage` site was `compose:start` (the AI action row), and
   *  0.1.0 had explicitly scoped polish out of billing. So the number was
   *  ALWAYS 0 — a dial that cannot move, which by this repo's own standard is a
   *  façade: it claims to measure something it never measures.
   *
   *  Absent when the provider reported no usage (some OpenAI-compatible servers
   *  omit it). Absent means UNKNOWN, and the caller must not record a zero for
   *  it — a recorded 0 would look like "it ran and cost nothing". */
  usage?: { tokensIn: number; tokensOut: number };
}

export interface PolishDeps {
  utteranceId?: string;
  /** Injectable fetch (LAN smoke / tests). Forwarded to the streamer. */
  fetch?: typeof globalThis.fetch;
  /** Override the AbortController timeout. Production writer since card POL-3: the
   *  stage-1 unit request caps it at the hold cap (engine/stt-session-units.ts), so
   *  the Smooth -> Strict retry below is only tried when it can still fit. */
  budgetMs?: number;
  /** Test seam: inject a streamer dispatcher (default = compose/llm streamerFor). */
  streamerFor?: (protocol: LlmProtocol) => LlmStreamer;
  /** PRODUCTION input (the lead's ruling, 2026-07-24, found via R4-6 real-chain
   *  testing): the per-session
   *  dictionary canonical terms (resolveReplacementRules → rule.canonical). The
   *  deterministic dictionary leg runs BEFORE polish, so its output is the user's
   *  explicit configuration — polish must never undo it. Any occurrence-count
   *  drift of a protected term between input and LLM output ⇒ guard_reject
   *  (real-chain physical evidence: vLLM rewrote dict-canonical `formatFlowMic` →
   *  `FormatFlow Mic`,
   *  passing the ported guard's calibration). Exact substring counts — the
   *  canonical form is user-specified verbatim, so case changes also reject. */
  protectedTerms?: readonly string[];
  /** NR-245: the session's focused-app category (engine/stt-factory.ts
   *  appCategoryFor), for the guard's known terms only — see GuardOpts.appCategory. */
  appCategory?: AppCategory;
  /** PRODUCTION input (card C8): the per-session correction strength, resolved
   *  from `stt.polish.strength` at the audio:start snapshot.
   *
   *  ⚠️ Absent ⇒ [[DEFAULT_POLISH_STRENGTH]] ⇒ `strict` ⇒ byte-identical to the
   *  behaviour before C8, INCLUDING the cache key (strict resolves to the same
   *  prompt object, so it digests to the same value). That is what makes the
   *  rollout safe in the direction that matters: a caller that has not been
   *  taught about strength yet cannot accidentally produce smoothed text. */
  strength?: PolishStrength;
  /** PRODUCTION input (card A4, owner ruling 2026-08-24): the rendered scenario
   *  block — professions / domains / preferred terminology — for this session,
   *  built by the SAME `buildScenarioBlock` the compose path uses so the two
   *  cannot describe the speaker differently. Absent/empty ⇒ the system prompt
   *  is byte-identical to the pre-A4 constant, cache key included.
   *
   *  🔴 This is what makes the scenario card mean something in REALTIME. Before
   *  it, professions and domains reached the LLM only on translate/organize, so
   *  a user who filled the card in and dictated normally got nothing from it —
   *  measured in the settings-effect probe (`card.professions/domains` reached
   *  neither the replacer nor the hotwords). */
  scenarioBlock?: string;
  /** Correlation id for the pipeline trace, threaded from the audio session so
   *  the `polish.request` / `polish.response` records join the `session.start`
   *  header. Absent ⇒ the records still emit, unjoined. Purely diagnostic: it
   *  never reaches the vendor and never enters the cache key. */
  traceId?: string;
  /** The session's spoken language (`audio:start.source_lang`, or the engine's
   *  own observation when it reported one).
   *
   *  🔴 DIAGNOSTIC ONLY, AND THAT IS THE WHOLE OF IT TODAY. It is written to the
   *  trace and to the skip warnings and reaches nothing else: not the prompt, not
   *  the guard, not the cache key. Rule 2 of both templates already says "preserve
   *  the original meaning, language, and spoken style exactly", so the language
   *  contract is stated; what was missing was any way to ANSWER「which language
   *  did this session think it was in」when that contract is broken.
   *
   *  ⚠️ Measured 2026-08-28: this function had no language parameter at all, while
   *  the hop directly above it (`stt-session.ts`) had just received the engine's
   *  own reported language and dropped it. So a user reporting「I dictated German
   *  and got English back」left a log that could not say what the session believed
   *  it was hearing — the honest failure of a diagnostic surface, and the reason
   *  this field is a field rather than an inference.
   *
   *  🔴 IT MUST NOT QUIETLY BECOME A PROMPT INPUT. Feeding it to the prompt would
   *  turn a caller's DECLARATION into an instruction, which is the failure
   *  compose/prompt.ts's `sourceLanguageNote` had to write four sentences to
   *  avoid. Full account: docs/archive/strategy/2026-08-28-multilingual-chain-audit.md §2 hop 7.
   *
   *  ML-1 (2026-10-13): it DOES reach the guard now (`GuardOpts.language`), which
   *  the line above used to rule out for want of a per-language corpus; ML-0
   *  built that corpus (test/fixtures/polish-guard-multilingual.jsonl). It turns
   *  on the per-language rules and the language-drift refusal, both silent when
   *  this is absent. Still not in the prompt and not in the cache key: the
   *  verdict on a cached output is re-taken with the same value (the cached-guard
   *  call passes it too). */
  language?: string;
  /** ML-2 (MAIN 2026-10-14): true only when audio:start said delivery 'none'
   *  (set in engine/stt-factory.ts): Notes, recovery legs, continuous
   *  recordings, and the flowmic-web island. Then dictated layout commands may
   *  become line breaks. Such text is not typed into a PC while it is
   *  recorded, but it is NOT guaranteed never to reach one: the phone can send
   *  a Notes row later ("+" multi-select or long-press resend,
   *  apps/mobile/lib/src/session/chat_explicit_delivery.dart), and the web
   *  island writes it into page fields. A PC types a line break as Enter
   *  (desktop inject/sendinput.rs NL-1), and Enter sends in a chat box; making
   *  those later paths safe is NR-253 (ledger). For delivery 'inject' the
   *  prompt keeps "new line" as words and the guard refuses any added line
   *  break. Absent: the PC-bound prompt, guard without an opinion. */
  lineBreaks?: boolean;
  /** Card INC-1e — the read-only context of a PIECE (stt-polish-piece.ts): earlier
   *  un-polished speech, sent in a marked block before the text and never
   *  corrected. Absent or empty ⇒ the legacy whole-text request, byte for byte. */
  context?: string;
  /** Card INC-1e — the caller's cancel (a background piece whose text moved on).
   *  A cancelled call returns internal reason `cancelled`; its result is never
   *  delivered, so the wire value it maps to is never read. */
  signal?: AbortSignal;
  /** Card POL-3 — which rule a NON-EMPTY `context` is framed with (stt-polish-piece.ts
   *  `contextSystemPrompt`). Absent ⇒ the INC-1 piece rule. Ignored without context. */
  contextRule?: ContextRule;
}

/** Exact-substring occurrence count (same counting the closed-class gate uses
 *  for CJK terms — no word-boundary assumption works across CJK/Latin mixes). */
function countTerm(s: string, term: string): number {
  return s.split(term).length - 1;
}

/** First protected term whose occurrence count drifted, or null when clean.
 *  Exported for the refine pass (stt-refine-llm.ts): the rule 「never undo the
 *  user's own configuration」 is one rule, so it has one implementation. */
export function protectedTermDrift(input: string, output: string, terms: readonly string[]): string | null {
  for (const t of terms) {
    if (t.length === 0) continue;
    // 🔴 `<`, NOT `!==`. The check exists to stop polish UNDOING the user's
    // configuration; removing a declared term is undoing it, and INTRODUCING one
    // is the correction the whole terminology feature exists to produce.
    //
    // With `!==` both directions rejected, and the second direction only became
    // reachable when the scenario block started travelling with the polish
    // prompt (card A4, owner ruling 2026-08-24): before that the deterministic
    // replacer had already put the canonical term into the INPUT, so the count
    // was 1 on both sides and the introduce case could not arise. The moment the
    // model was given the user's vocabulary and asked to use it, every
    // successful use of it — 洛克斯托 -> Rockstore, 0 occurrences -> 1 — became a
    // `guard_reject`, and the bare mis-heard text was delivered instead.
    //
    // ⚠️ The undo direction is UNCHANGED and must stay that way: a model that
    // drops a term the user declared is exactly what this was written to catch.
    if (countTerm(output, t) < countTerm(input, t)) return t;
  }
  return null;
}

/**
 * Bounded (≤800ms), non-streaming (the SSE transport is consumed to completion
 * internally), content-hash-cached, guard-gated LLM correction of a TERMINAL
 * final's already-normalized (pure two-stage) text. Reuses the shared compose/llm
 * transport + the caller-resolved llm.config — no new protocol, no new model
 * identity (WP-R4-6 ⑤). On timeout / transport error / empty output / guard
 * rejection it returns the INPUT text unchanged with a `reason` + normalized
 * `skipReason`, and forensically logs — NEVER throws, NEVER blocks delivery,
 * NEVER returns an over-the-guard output (red line).
 */
export async function polishFinalText(
  text: string,
  cfg: LlmConfig,
  deps: PolishDeps = {},
): Promise<PolishResult> {
  const trimmed = text.trim();
  const attemptAt = Date.now();
  const budgetMs = deps.budgetMs ?? polishBudgetMs(trimmed.length);
  const t: AttemptTelemetry = { ttfbMs: null, cacheHit: false, charsOut: 0, finishReason: 'none' };
  const finish = (r: PolishResult): PolishResult => {
    try { return { ...r, timing: { elapsedMs: Date.now() - attemptAt, ttfbMs: t.ttfbMs, budgetMs, cacheHit: t.cacheHit, charsOut: t.charsOut, finishReason: t.finishReason } }; }
    catch { return r; } // Missing telemetry must not become a polish exception.
  };
  // DIVERGENCE (reversal 2): empty input is a degenerate skip → normalized to the
  // 'empty_output' wire reason (the lead's clarification). Legacy kept only the internal
  // 'empty-input' label; the internal label is retained for the ported vector.
  if (trimmed.length === 0) return finish({ text, applied: false, reason: 'empty-input', skipReason: 'empty_output' });
  if (deps.signal?.aborted === true) return finish({ text, applied: false, reason: 'cancelled', skipReason: 'llm_error' }); // INC-1e: never sent

  // Resolved ONCE, here, at the boundary — every line below sees a total value
  // and no downstream branch has to decide what `undefined` means.
  const strength: PolishStrength = deps.strength ?? DEFAULT_POLISH_STRENGTH;
  const first = await polishAttempt(text, trimmed, cfg, deps, strength, budgetMs, t);
  if (first.reason === undefined) return finish({ ...first, appliedStrength: strength });

  // QP-1 — Smooth -> Strict fallback. A smooth result our guard refused (or an
  // empty one) is not evidence the utterance cannot be corrected; strict asks
  // for less and its guard has rejected nothing on the Tokyo relay
  // (2026-09-29..10-13: smooth 31/90 rejected, strict 0/14). ONE strict attempt,
  // inside the SAME budget — the cap is not raised; when what is left is under
  // POLISH_FALLBACK_MIN_MS the attempt is not made, because a call that cannot
  // finish only turns a guard_reject into a timeout. LLM errors / timeouts do
  // not fall back: a second call to a failing route is not a different answer.
  const fallBack = strength === 'smooth' && (first.skipReason === 'guard_reject' || first.skipReason === 'empty_output');
  if (!fallBack) return finish(first);
  const remainingMs = budgetMs - (Date.now() - attemptAt);
  if (remainingMs < POLISH_FALLBACK_MIN_MS) return finish({ ...first, firstReject: first.reason });
  // Keep the first call's numbers: `t` is about to describe the strict call.
  const firstCall = { elapsedMs: Date.now() - attemptAt, ttfbMs: t.ttfbMs, charsOut: t.charsOut, finishReason: t.finishReason };
  const second = await polishAttempt(text, trimmed, cfg, deps, 'strict', remainingMs, t);
  // Both calls were spent whatever the verdict; billing reflects the cost.
  const usage = addUsage(first.usage, second.usage);
  const withUsage = usage ? { usage } : {};
  if (second.reason === undefined) {
    return finish({ ...second, ...withUsage, appliedStrength: 'strict', firstReject: first.reason, firstCall });
  }
  // Strict refused too: exactly today's guard_reject / empty_output, first reason kept.
  return finish({ ...first, ...withUsage, firstReject: first.reason, firstCall });
}

/** QP-1: the least budget worth spending on the strict fallback. Strict
 *  polishes on the Tokyo relay finish at p50 ~1.0 s / p90 ~1.4 s; under
 *  1.2 s left the second call mostly cannot land. */
export const POLISH_FALLBACK_MIN_MS = 1_200;

interface AttemptTelemetry { ttfbMs: number | null; cacheHit: boolean; charsOut: number; finishReason: LlmFinishReason }

function addUsage(
  a: PolishResult['usage'],
  b: PolishResult['usage'],
): PolishResult['usage'] {
  if (!a) return b;
  if (!b) return a;
  return { tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut };
}

/** One polish call at one strength — the body polishFinalText always had. */
async function polishAttempt(
  text: string,
  trimmed: string,
  cfg: LlmConfig,
  deps: PolishDeps,
  strength: PolishStrength,
  budgetMs: number,
  t: AttemptTelemetry,
): Promise<PolishResult> {
  let ttfbMs: number | null = null, cacheHit = false, charsOut = 0, finishReason: LlmFinishReason = 'none';
  const finish = (r: PolishResult): PolishResult => {
    t.ttfbMs = ttfbMs; t.cacheHit = cacheHit; t.charsOut = charsOut; t.finishReason = finishReason;
    return r;
  };
  const protectedTerms = deps.protectedTerms ?? [];
  // INC-1e: a piece with context gets the piece template and a marked user
  // message; without context both are exactly what they always were.
  const piece = pieceRequest(trimmed, deps.context ?? '');
  const taskSystem = polishSystemPromptWithScenario(strength, deps.scenarioBlock ?? '', deps.lineBreaks === true);
  const system = piece.withContext ? contextSystemPrompt(taskSystem, deps.contextRule, deps.language) : taskSystem; // POL-3: unit rules

  const key = cacheKey(cfg.model, system, piece.user);
  const cached = polishCache.get(key);
  if (cached !== undefined) {
    cacheHit = true; charsOut = cached.length;
    polishCache.delete(key);
    polishCache.set(key, cached);
    // Cache hit ⇒ a previously guard-accepted output ⇒ SUCCESS (no reason) —
    // UNLESS this session's protected terms (dictionary differs per user/session;
    // the cache key does not include them) would drift: then the cached output is
    // not admissible HERE and the honest signal is a guard_reject skip. The entry
    // stays cached (it remains valid for sessions without that term).
    const cachedDrift = protectedTermDrift(trimmed, cached, protectedTerms);
    if (cachedDrift !== null) {
      log.warn('stt.polish cached output drifts a protected dictionary term — pure two-stage text kept', { family: 'dict', wire: 'guard_reject' });
      return finish({ text, applied: false, reason: `dict-term-drift:${cachedDrift}`, skipReason: 'guard_reject' });
    }
    // NR-245: the guard's verdict also depends on THIS session (declared terms,
    // focused-app category), which the key does not carry either — an output
    // a coding session accepted is not admissible in an email session. Same
    // signal as above; the entry stays cached for sessions it fits.
    const cachedGuard = checkMeaningPreserved(trimmed, cached, { strength, declaredTerms: protectedTerms, ...(deps.appCategory !== undefined ? { appCategory: deps.appCategory } : {}), ...(deps.language !== undefined ? { language: deps.language } : {}), ...(deps.lineBreaks !== undefined ? { lineBreaks: deps.lineBreaks } : {}) });
    if (!cachedGuard.ok) {
      log.warn('stt.polish cached output refused for this session — pure two-stage text kept', { family: guardFamily(cachedGuard.reason), wire: 'guard_reject' });
      return finish({ text, applied: false, reason: cachedGuard.reason, skipReason: 'guard_reject' });
    }
    // Even if it equals the input (LLM echoed), the wire signal is 'applied'.
    return finish({ text: cached, applied: cached !== text });
  }

  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  const cancel = (): void => ctrl.abort(); // INC-1e: the caller's cancel aborts the same request
  deps.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const streamer = (deps.streamerFor ?? defaultStreamerFor)(cfg.protocol);
    const opts: LlmStreamOpts = {
      cfg,
      system,
      user: piece.user,
      signal: ctrl.signal,
    };
    if (deps.fetch) opts.fetch = deps.fetch;

    // What we are ABOUT to hand the vendor, recorded before the call rather than
    // after it: a request line written only on success would be missing for
    // exactly the runs someone is trying to diagnose (timeout, abort, throw).
    // `protected_terms` is on this record because it is the one input that is
    // NOT in the cache key — two sessions can send byte-identical prompts and
    // legitimately reach different verdicts, and without this field that looks
    // like nondeterminism.
    if (traceEnabled()) {
      trace('polish.request', deps.traceId ?? 'no-session', {
        model: cfg.model,
        protocol: cfg.protocol,
        strength,
        language: deps.language,
        budget_ms: budgetMs,
        ...tracedList(protectedTerms),
        system: tracedText(system),
        user: tracedText(piece.user),
      });
    }
    let full = '';
    let errored: string | null = null;
    let usage: { tokensIn: number; tokensOut: number } | undefined;
    for await (const ev of streamer(opts)) {
      if (ev.kind !== 'delta') finishReason = toLlmFinishReason(ev.finish_reason);
      // Billing facts are captured before either terminal path can reject the output.
      if (ev.kind !== 'delta' && ev.usage) usage = { tokensIn: ev.usage.tokens_in, tokensOut: ev.usage.tokens_out };
      if (ev.kind === 'delta') { if (ev.text.length) ttfbMs ??= Date.now() - startedAt; full += ev.text; }
      else if (ev.kind === 'done') {
        full = ev.full; if (full.length) ttfbMs ??= Date.now() - startedAt;
        break;
      }
      else { errored = ev.code; break; }
    }
    // ONE response record, placed where EVERY post-call path passes through —
    // success, vendor error and abort alike. Putting it on the success branch
    // instead would leave the failing runs, the ones anyone actually traces,
    // with a request and no answer. What the verdict then does with this text
    // (guard_reject / empty_output / accepted) is already loud in the WARN lines
    // below and in the `delivered` record, so this line stays what the model
    // said rather than what we concluded.
    if (traceEnabled()) {
      trace('polish.response', deps.traceId ?? 'no-session', {
        error_code: errored,
        elapsed_ms: Date.now() - startedAt,
        tokens_in: usage?.tokensIn,
        tokens_out: usage?.tokensOut,
        ...tracedText(full),
      });
    }
    if (errored && deps.signal?.aborted === true) return finish({ text, applied: false, reason: 'cancelled', skipReason: 'llm_error', ...(usage ? { usage } : {}) });
    if (errored) {
      // The compose/llm streamer maps an abort (budget exceeded) → LLM_TIMEOUT and
      // transport/HTTP failures → other LLM_* codes; timeout is its own wire value.
      // NR-130: a config refusal (bad key / unknown model) is `model_rejected`.
      const skipReason: PolishSkipReason = polishSkipReasonForCode(errored);
      // The budget and the elapsed time are the two numbers that make a timeout
      // DIAGNOSABLE. Without them this line said "timed out" and nothing else, which
      // is why a budget that could never fit the job survived a whole release —
      // no-silent-failure is not satisfied by saying that something failed, only by
      // saying enough to act on it.
      log.warn('stt.polish llm error — pure two-stage text kept', {
        request: randomUUID(),
        code: errored,
        wire: skipReason,
        language: deps.language,
        chars: trimmed.length,
        budgetMs,
        elapsedMs: Date.now() - startedAt,
      });
      return finish({ text, applied: false, reason: errored, skipReason, ...(usage ? { usage } : {}) });
    }

    const cleaned = stripWrapping(full); charsOut = cleaned.length;
    if (cleaned.length === 0) {
      log.warn('stt.polish empty output — pure two-stage text kept', { wire: 'empty_output' });
      // The model RESPONDED — those tokens were spent whatever we then did
      // with the text. Billing must reflect the cost, not the verdict.
      return finish({ text, applied: false, reason: 'empty-output', skipReason: 'empty_output', ...(usage ? { usage } : {}) });
    }

    // The lead's ruling (2026-07-24): dictionary-canonical protection runs FIRST — it is
    // decisive and independent of the ported guard's calibration. The verbatim-
    // ported checkMeaningPreserved stays untouched (the carry-over-takes-priority
    // discipline); this check lives
    // here in the caller.
    const drift = protectedTermDrift(trimmed, cleaned, protectedTerms);
    if (drift !== null) {
      try { logPolishGuard(trimmed, cleaned, { ok: false, reason: 'dict-term-drift:' }, { ...deps, strength }); } catch { /* Observation only. */ }
      log.warn('stt.polish output drifts a protected dictionary term — pure two-stage text kept', { family: 'dict', wire: 'guard_reject' });
      return finish({ text, applied: false, reason: `dict-term-drift:${drift}`, skipReason: 'guard_reject', ...(usage ? { usage } : {}) });
    }

    // `declaredTerms` = the SAME per-session canonicals the drift check above
    // uses. The two do opposite jobs on the same list and both are needed: the
    // drift check refuses an output that DROPPED a declared term, this tells
    // the cardinality budget that an output which INTRODUCED one is not drift.
    const guard = checkMeaningPreserved(trimmed, cleaned, { strength, declaredTerms: protectedTerms, ...(deps.appCategory !== undefined ? { appCategory: deps.appCategory } : {}), ...(deps.language !== undefined ? { language: deps.language } : {}), ...(deps.lineBreaks !== undefined ? { lineBreaks: deps.lineBreaks } : {}) });
    try { logPolishGuard(trimmed, cleaned, guard, { ...deps, strength }); } catch { /* Observation only. */ }
    if (!guard.ok) {
      try { log.warn('stt.polish guard rejected — pure two-stage text kept', { family: guardFamily(guard.reason), wire: 'guard_reject' }); } catch { /* Observation only. */ }
      return finish({ text, applied: false, reason: guard.reason, skipReason: 'guard_reject', ...(usage ? { usage } : {}) });
    }

    // INC-1e (design §3.2 item 1): a piece may not repeat its context.
    const echo = piece.withContext ? contextEcho(deps.context ?? '', trimmed, cleaned) : null;
    if (echo !== null) {
      try { log.warn('stt.polish piece repeated its context — pure text kept', { family: 'context-echo', wire: 'guard_reject' }); } catch { /* Observation only. */ }
      return finish({ text, applied: false, reason: echo, skipReason: 'guard_reject', ...(usage ? { usage } : {}) });
    }
    polishCache.set(key, cleaned);
    if (polishCache.size > POLISH_CACHE_MAX) {
      const oldest = polishCache.keys().next().value;
      if (oldest !== undefined) polishCache.delete(oldest);
    }
    return finish({ text: cleaned, applied: cleaned !== text, ...(usage ? { usage } : {}) });
  } catch (err) {
    // The streamer is contracted never to throw (transport failures become error
    // events), so this is defense-in-depth. An aborted signal ⇒ timeout; else a
    // generic llm_error. Never silent (red line) — forensically logged, pure text kept.
    const skipReason: PolishSkipReason = ctrl.signal.aborted ? 'timeout' : 'llm_error';
    log.error('stt.polish exception — pure two-stage text kept', { outcome: 'exception', wire: skipReason });
    return finish({ text, applied: false, reason: 'exception', skipReason });
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Map a PolishResult to the honest stt:final wire signal (the lead's clarification
 * 2026-07-24). A REASON in the result means the attempt did not succeed →
 * 'skipped' + the normalized 4-value reason. NO reason — including a cache hit or
 * an LLM echo identical to the input — means polish ran and SUCCEEDED → 'applied',
 * regardless of the legacy `applied` text-diff bit (the phone's "polish skipped"
 * badge must only appear on a real failure).
 */
export function polishWireSignal(r: PolishResult): PolishWireSignal {
  if (r.reason === undefined) return { polish: 'applied' };
  return { polish: 'skipped', polish_reason: r.skipReason ?? 'llm_error' };
}

/**
 * NR-130 — the wire signal as the USER may read it, given WHO supplied the model.
 *
 * `model_rejected` tells the phone "the model set up for you was refused — check
 * its settings". That is only true of a config the user (or the seeder on their
 * own computer) put there. The managed default is OUR key on OUR account
 * (llm-config.ts `LlmConfigSource`): if a vendor refuses it, the user has
 * nothing to check, so the phone gets the plain `llm_error` and the operator
 * alarm is llm-health.ts's job. The forensic `outcome` keeps the raw reason.
 */
export function polishWireSignalFor(r: PolishResult, source: LlmConfigSource): PolishWireSignal {
  const signal = polishWireSignal(r);
  if (signal.polish === 'skipped' && signal.polish_reason === 'model_rejected' && source === 'managed-default') {
    return { polish: 'skipped', polish_reason: 'llm_error' };
  }
  return signal;
}

/** Test-only cache reset so guard/latency tests don't leak state across cases. */
export function __resetPolishCacheForTest(): void {
  polishCache.clear();
}
