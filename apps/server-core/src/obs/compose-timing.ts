import { log } from '../log';
import { isErrorCode } from '../errors';
import type { ComposeOrchestrator } from '../engine/orchestrator';
import type { ComposeRun } from '../compose/orchestrator';

export class ComposeTiming {
  private readonly started = Date.now();
  private first: number | null = null;
  private chars = 0;
  constructor(private readonly task: 'translate' | 'organize' | 'draft_polish', private readonly charsIn: number) {}
  chunk(delta: string): void {
    try {
      if (delta.length) this.first ??= Date.now() - this.started;
      this.chars += delta.length;
    } catch { /* Timing observation cannot change compose delivery. */ }
  }
  finish(orchestrator: ComposeOrchestrator | undefined, outcome: 'done' | 'rejected' | 'error', code: unknown = null, charsOut = this.chars): void {
    try {
      const run = orchestrator as Partial<ComposeRun> | undefined;
      const model = run?.timingModel?.() ?? { llm_source: null, model: 'byok' };
      const finishReason = run?.timingFinishReason?.() ?? 'none';
      log.info('compose.timing', {
        task: this.task, outcome, error_code: typeof code === 'string' && isErrorCode(code) ? code : null,
        elapsed_ms: Date.now() - this.started, ttfb_ms: this.first,
        chars_in: this.charsIn, chars_out: charsOut, ...model, finish_reason: finishReason,
      });
    } catch { /* Observation cannot turn a completed compose into an error. */ }
  }
}
