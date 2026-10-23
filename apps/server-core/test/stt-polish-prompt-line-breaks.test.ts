// ML-2 (MAIN 2026-10-14): the PC-bound prompt keeps layout commands as words
// and never asks for a line break; the Notes prompt converts them. The exported
// constants are the PC-bound ones, so a caller that says nothing is safe.
import { describe, expect, it } from 'vitest';
import { POLISH_SMOOTH_SYSTEM_PROMPT, POLISH_SYSTEM_PROMPT, polishSystemPrompt, polishSystemPromptWithScenario } from '../src/stt/stt-polish-prompts';

describe('polish prompt and line breaks', () => {
  it('default (PC-bound): the same objects as before, and they forbid a line break', () => {
    expect(polishSystemPrompt('strict')).toBe(POLISH_SYSTEM_PROMPT);
    expect(polishSystemPrompt('smooth')).toBe(POLISH_SMOOTH_SYSTEM_PROMPT);
    for (const p of [POLISH_SYSTEM_PROMPT, POLISH_SMOOTH_SYSTEM_PROMPT]) expect(p).toContain('never output a line break');
  });

  it('Notes: layout commands become line breaks, at both strengths and with a scenario', () => {
    for (const strength of ['strict', 'smooth'] as const) {
      const p = polishSystemPrompt(strength, true);
      expect(p).not.toContain('never output a line break');
      expect(p).toContain('replace the spoken command with the symbol or line break');
      expect(polishSystemPromptWithScenario(strength, 'BLOCK', true)).toContain('symbol or line break');
      expect(polishSystemPromptWithScenario(strength, 'BLOCK')).toContain('never output a line break');
    }
  });
});
