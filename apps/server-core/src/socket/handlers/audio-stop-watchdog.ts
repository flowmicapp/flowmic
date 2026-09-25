// SPEC-REF:
//   ./audio.handler.ts `AUDIO_STOP_FINISH_WATCHDOG_MS` (card P0-1 fallback: why a
//     watchdog races `finish()` at all, and what its base window covers)
//   ../../stt/flush-final.ts `networkFlushCapMs` / `localFlushCapMs` (the caps the
//     orchestrator races its terminal flush against)
//   _dispatch/2026-09-24-codex-review-rc1.out.md item 4
//
// 🔴 Codex review item 4 (2026-09-24). The base window was sized when every flush
// cap was a flat 3 s. Card RC-2 then made a network engine's cap `backlog + 3 s`
// and NR-50 made a local decode's cap `2 × leg audio`, so a HEALTHY terminal
// flush can now outlive a fixed 20 s — and the watchdog disposed the session
// under it: orchestrator closed, vendor socket closed, the terminal final (the
// whole point of the flush) lost. Measured by test/audio-stop-backlog-flush.test.ts
// (a vendor 30 s behind answering at 25 s, disposed at 20 s).
//
// The allowance is now the base PLUS how far the flush cap can have grown past
// the cap the base already assumed, derived from the same two cap functions the
// orchestrator uses, fed with the audio this recording handed to any engine.
// That audio bounds every leg's audio from above (each leg's counter is a
// subset of the session's), and both caps grow with it, so the bound is ≥ the
// cap actually raced. It is looser than the real cap — this layer cannot see
// which engine the leg is, so it takes the larger of the two families — and the
// cost of that looseness lands only on a finish() that is genuinely stuck.
//
// STILL ENDS: on expiry the allowance is recomputed (a replay after the stop can
// still hand an engine audio), and the watchdog re-arms only for the remainder.
// Audio after a stop comes only from the bounded replay ring, so it converges.
// ⚠️ NOT COVERED: an EXPLICITLY configured flush cap (`engineFlushTimeoutMs`
// set by env) above the base; this layer cannot read it. Same as before.

import { localFlushCapMs, networkFlushCapMs } from '../../stt/flush-final';

/** How far the terminal flush cap can have grown above the one the base window
 *  already assumed, for a recording that handed `fedAudioMs` to its engines. */
export function flushCapGrowthMs(fedAudioMs: number): number {
  const fed = Math.max(0, fedAudioMs);
  return Math.max(
    networkFlushCapMs(0, fed) - networkFlushCapMs(0, 0),
    localFlushCapMs(fed) - localFlushCapMs(0),
  );
}

/** The finish watchdog's window: the fixed base when the session does not say
 *  how much audio it fed (test fakes, older implementations), else base + growth. */
export function finishWatchdogAllowanceMs(baseMs: number, fedAudioMs: number | undefined): number {
  return fedAudioMs === undefined ? baseMs : baseMs + flushCapGrowthMs(fedAudioMs);
}

/**
 * Arm the fallback that disposes a `finish()` that never settles. Returns the
 * canceller the finish chain calls when `finish()` does settle.
 */
export function armFinishWatchdog(
  s: { readonly fedAudioMs?: number },
  baseMs: number,
  onExpire: () => void,
): () => void {
  let waited = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    const remaining = finishWatchdogAllowanceMs(baseMs, s.fedAudioMs) - waited;
    if (remaining <= 0) { timer = null; onExpire(); return; }
    timer = setTimeout(() => { waited += remaining; arm(); }, remaining);
  };
  arm();
  return () => { if (timer !== null) clearTimeout(timer); timer = null; };
}
