// SPEC-REF:
//   apps/server-core/src/engine/orchestrator.ts (ComposeOrchestrator seam —
//     run() yields deltas OR fails loud; NEVER silently reinjects raw STT text)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §6 (LLM failure surfaces a code, never a
//     raw-text fallback), §5 (≤800 ms budget for the scenario correction pass)
//   docs/strategy/2026-07-23-mock-billing-design.md §5 (recordLlmUsage counts;
//     BYOK is NOOP — carried via usage().isByok)
//   CLAUDE.md red line: LLM failure/timeout → explicit compose:error + status
//     records the truth, never silently fall back to injecting the raw STT text
//     as the result
//
// The concrete ComposeOrchestrator. run() streams the LLM's deltas as strings;
// on ANY failure event it THROWS a ServerError carrying a whitelisted LLM_* code
// so the handler emits compose:error — it NEVER yields the source_text back as a
// fake result. A per-turn budget (AbortController) turns a hang into a loud
// LLM_TIMEOUT. Token usage + BYOK are captured for the single recordLlmUsage
// site (read via readComposeUsage).

import type { ComposeOrchestrator } from '../engine/orchestrator';
import { ServerError, isErrorCode } from '../errors';
import type { ErrorCode } from '@flowmic/protocol';
import type { LlmConfig, LlmStreamer } from './llm';
import { COMPOSE_BUDGET_MS } from './mode';
import { guardComposeOutput, ComposeOutputRejectedError } from './output-guard';
import { log } from '../log';
import { trace, traceEnabled, tracedText } from '../trace/pipeline-trace';

export interface ComposeUsage {
  tokensIn: number;
  tokensOut: number;
  isByok: boolean;
}

/** The orchestrator plus the post-run usage read the billing site needs. Extends
 *  the seam without widening it — the handler treats it as a ComposeOrchestrator
 *  and reads usage() best-effort via readComposeUsage. */
export interface ComposeRun extends ComposeOrchestrator {
  usage(): ComposeUsage;
  /** The guard-approved output text, or null if the run did not complete
   *  cleanly. See readComposeOutput for the best-effort read the handler uses. */
  deliverableText(): string | null;
}

export interface ComposeRunDeps {
  streamerFor: (protocol: LlmConfig['protocol']) => LlmStreamer;
  fetch?: typeof globalThis.fetch;
  /** Per-turn budget (ms). Exceeding it aborts the fetch → LLM_TIMEOUT. */
  budgetMs?: number;
  /** §4.1 deterministic dictionary replacement (dictionary replacement), applied to the correction
   *  INPUT before the LLM sees it. Absent = identity. Never mutates source_text. */
  replace?: (text: string) => string;
  /** Correlation id shared with the `compose.scenario` record the factory
   *  emitted for this turn. Diagnostic only — never on the wire to the vendor. */
  traceId?: string;
}

function asErrorCode(code: string): ErrorCode {
  return isErrorCode(code) ? code : 'LLM_TIMEOUT';
}

class ComposeRunImpl implements ComposeRun {
  private readonly _usage: ComposeUsage;
  /** The guard-approved text, set once the run completes cleanly. Null until
   *  then, and null forever on a rejected run — there is no deliverable result
   *  for a run that failed, and a stale value here would be one. */
  private _deliverable: string | null = null;
  constructor(
    private readonly cfg: LlmConfig,
    private readonly system: string,
    private readonly isByok: boolean,
    private readonly deps: ComposeRunDeps,
  ) {
    this._usage = { tokensIn: 0, tokensOut: 0, isByok };
  }

  async *run(input: {
    task: 'translate' | 'organize' | 'draft_polish';
    source_text: string;
    source_lang?: string;
    target_lang?: string;
  }): AsyncIterable<string> {
    const streamer = this.deps.streamerFor(this.cfg.protocol);
    const budgetMs = this.deps.budgetMs ?? COMPOSE_BUDGET_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), budgetMs);
    let sawTerminal = false;
    // What the wire actually carried. The handler builds compose:done's
    // output_text by concatenating exactly these yields, so this string — not
    // the streamer's own `ev.full` — is the text the client will use, and it is
    // therefore the text the guard has to judge.
    let streamed = '';
    try {
      // Dictionary replacement (§4.1): the correction stage sees the alias→canonical-replaced
      // text, never the raw STT final. source_text (as spoken) is unchanged — this
      // is the compose INPUT only, and the persisted row is written elsewhere.
      const user = this.deps.replace ? this.deps.replace(input.source_text) : input.source_text;
      const opts = {
        cfg: this.cfg,
        system: this.system,
        user,
        signal: ctrl.signal,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      };
      // What actually goes to the vendor for this turn. `dict_replaced` is the
      // point of the record: `source_text` is what the user said and `user` is
      // what the model is being given, and the only way to see the dictionary
      // leg do its job on a compose turn is to compare those two. A single
      // `user` field would have shown the result without showing the effect.
      if (traceEnabled()) {
        trace('compose.request', this.deps.traceId ?? 'no-turn', {
          task: input.task,
          model: this.cfg.model,
          protocol: this.cfg.protocol,
          source_lang: input.source_lang,
          target_lang: input.target_lang,
          budget_ms: budgetMs,
          dict_replaced: user !== input.source_text,
          system: tracedText(this.system),
          user: tracedText(user),
        });
      }
      for await (const ev of streamer(opts)) {
        if (ev.kind === 'delta') {
          streamed += ev.text;
          yield ev.text;
        } else if (ev.kind === 'done') {
          if (ev.usage) {
            this._usage.tokensIn = ev.usage.tokens_in;
            this._usage.tokensOut = ev.usage.tokens_out;
          }
          sawTerminal = true;
          // W2-2 (FB-5 second knife): translate/organize had NO output
          // validation at all — whatever the model produced went straight to
          // compose:chunk. The guard runs here, on the complete text, because
          // that is the earliest moment a complete text exists.
          //
          // 🔴 Rejection is LOUD and it is FINAL: throwing turns into
          // compose:error at the handler, and the source text is never
          // substituted for the output. Handing back the untranslated source is
          // not a degraded result, it IS the failure owner reported
          // (CLAUDE.md red line: `LLM failure must not silently fall back to injecting the raw STT text`).
          //
          // Prefer `streamed` over `ev.full`: a streamer that ends without a
          // `full` must still be judged, and `streamed` is by construction the
          // string the handler will send as output_text.
          // Recorded BEFORE the guard runs, so a guard rejection leaves both
          // halves on disk: what the model produced, and (from the guard's own
          // WARN line) why it was refused. Tracing after the guard would delete
          // the evidence for exactly the turns worth investigating.
          if (traceEnabled()) {
            trace('compose.response', this.deps.traceId ?? 'no-turn', {
              task: input.task,
              tokens_in: this._usage.tokensIn,
              tokens_out: this._usage.tokensOut,
              ...tracedText(streamed !== '' ? streamed : ev.full),
            });
          }
          this.assertOutputDeliverable(input, streamed !== '' ? streamed : ev.full, user);
          return;
        } else {
          // Fail loud: propagate the LLM error code. The handler catches this and
          // emits compose:error — the raw source_text is NEVER yielded as output.
          sawTerminal = true;
          throw new ServerError(asErrorCode(ev.code), ev.message);
        }
      }
      // A streamer that stops without a terminal event must not silently look
      // like an empty success — surface a loud timeout.
      if (!sawTerminal) {
        throw new ServerError('LLM_TIMEOUT', 'LLM stream ended without a terminal event');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run the W2-2 output guard, or throw.
   *
   * 🔴 `draft_polish` USED TO BE SKIPPED HERE, on this reasoning, kept verbatim
   * because the sentence is the defect: "that path already carries three gates
   * of its own (stt-polish-guard.ts), and a fourth opinion would give one
   * question two answers."
   *
   * Those gates belong to the REALTIME STT polish (`stt/stt-polish.ts`), a
   * different path that shares only the word "polish". Measured 2026-08-28:
   * `grep -rn "draft_polish" apps/server-core/src/stt/` returns 0. So this
   * `return` was not choosing between two opinions — it was the only thing
   * standing where the single opinion should have been, and the task shipped
   * with no output validation at all. See guardComposeOutput's header for what
   * the task is and is not checked for now.
   *
   * ⚠️ Called UNCONDITIONALLY — deliberately not behind an injectable seam. A
   * defaulted-off guard is this repo's #1 façade class (a dial that cannot
   * move); there must be no configuration in which compose runs unvalidated.
   *
   * 🔴 `sentToModel` IS THE THIRD ARGUMENT BECAUSE THE GUARD WAS JUDGING THE
   * WRONG STRING, and the contract it was breaking is written on the field it
   * fills: [[ComposeGuardInput.source]] says, verbatim, "the text we sent the
   * model (the compose input, POST dictionary-replace)". This method passed
   * `input.source_text` — the utterance as spoken, BEFORE the replacer ran — so
   * the guard compared the model's answer against a question the model was
   * never asked.
   *
   * What that cost, measured: with any alias that maps a CJK surface to a Latin
   * canonical — which is what the SHIPPED `tech-dev` pack does (多克→Docker,
   * 库伯耐提斯→Kubernetes, 吉特哈布→GitHub) — the replacer hands the model
   * "这个跑在Kubernetes上面", the model correctly returns a sentence containing
   * "Kubernetes", and rule 8 (`invented_latin_tokens`) then finds that token
   * absent from the raw Han source and REFUSES THE WHOLE TURN. Enabling a
   * built-in dictionary pack therefore broke organize for Chinese speech:
   * compose:error, nothing delivered, and the named reason blamed the model for
   * inventing a word the user's own settings had put there.
   *
   * ⚠️ The two strings stay DISTINCT rather than one being dropped: the raw
   * utterance is still the row that gets persisted and is still what the user
   * said. Only the guard's question moves, because the guard's question is
   * "did the model answer what it was given" — and what it was given is this.
   */
  private assertOutputDeliverable(
    input: { task: 'translate' | 'organize' | 'draft_polish'; source_text: string; source_lang?: string; target_lang?: string },
    complete: string,
    sentToModel: string,
  ): void {
    const verdict = guardComposeOutput({
      task: input.task,
      source: sentToModel,
      output: complete,
      ...(input.source_lang !== undefined ? { source_lang: input.source_lang } : {}),
      ...(input.target_lang !== undefined ? { target_lang: input.target_lang } : {}),
    });
    if (verdict.ok) {
      // 🔴 The repaired text has to actually BE the result, or `repairs` is a
      // façade: my first draft computed the unwrapped text, used it for judging,
      // and threw it away — so a fenced-but-correct translation was "repaired"
      // and still reached the user wearing its ``` marks. The handler reads this
      // via readComposeOutput and sends it as compose:done's output_text, which
      // is the field both phone consumers take VERBATIM in preference to the
      // chunks they accumulated (utterance_compose.dart / ai_compose_controller
      // .dart, AiComposeDone branch) — so the repair lands on what the user gets.
      this._deliverable = verdict.text;
      return;
    }
    // Named, greppable, and it answers "what justified rejecting this one" for a deployment that
    // only has the log. The output itself is NOT logged: it is user content.
    log.warn('compose output rejected — nothing delivered, source text NOT substituted', {
      task: input.task,
      rule: verdict.rule,
      detail: verdict.detail,
      output_chars: [...complete].length,
    });
    throw new ComposeOutputRejectedError(verdict.rule, verdict.detail);
  }

  usage(): ComposeUsage {
    return this._usage;
  }

  deliverableText(): string | null {
    return this._deliverable;
  }
}

export function createComposeRun(
  cfg: LlmConfig,
  system: string,
  isByok: boolean,
  deps: ComposeRunDeps,
): ComposeRun {
  return new ComposeRunImpl(cfg, system, isByok, deps);
}

/** Best-effort usage read for the billing site. Any ComposeOrchestrator that is
 *  a ComposeRun exposes real counts; anything else yields the safe 0/0/false
 *  default (never fabricated). */
export function readComposeUsage(orchestrator: ComposeOrchestrator): ComposeUsage {
  const maybe = orchestrator as Partial<ComposeRun>;
  if (typeof maybe.usage === 'function') return maybe.usage();
  return { tokensIn: 0, tokensOut: 0, isByok: false };
}

/**
 * Best-effort read of the guard-approved output text, symmetric with
 * readComposeUsage (same seam-widening-free pattern).
 *
 * Returns null for any orchestrator that does not carry one — including a run
 * that failed — and the handler then falls back to the text it accumulated from
 * the deltas. Never fabricates: null means "this layer has nothing to say", not
 * "the output was empty".
 */
export function readComposeOutput(orchestrator: ComposeOrchestrator): string | null {
  const maybe = orchestrator as Partial<ComposeRun>;
  if (typeof maybe.deliverableText === 'function') return maybe.deliverableText();
  return null;
}
