// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §5 (stt.refine: after the final state,
//     fire-and-forget full re-transcription + aligned diff + write-back; text
//     already injected into the PC is never rewritten)
//   docs/rebuild/05-DATA-MODEL.md §5 (`stt.refine` {enabled, min_utterance_ms})
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-14
//   CLAUDE.md red line: no silent failures
//
// TWO-PASS REFINE — the decision core, with no engine and no socket in it.
//
// A streaming engine has to commit to words before the sentence is over. A batch
// engine sees the whole utterance at once and is simply better at it. Refine is
// that second look: after the utterance has SETTLED (already delivered, already
// on screen), the retained PCM goes through a batch engine one more time, and if
// the result differs the phone is told.
//
// Four rules, all of them about not making things worse:
//
//   · NEVER on a short utterance. `min_utterance_ms` (default 15 s) is not a
//     performance tweak — a second full transcription is a second engine bill,
//     and "OK" (好的) was never wrong in the first place.
//   · NEVER blank a row. An empty or whitespace-only second pass is a FAILED
//     second pass, not a better transcript. The user can read the first one.
//   · NEVER emit a no-op. Identical text (modulo the whitespace either pass may
//     add) produces nothing at all: an "optimized" (已优化) signal for text that
//     did not
//     change is noise that teaches the user to ignore the real ones.
//   · NEVER touch what was injected. This module returns TEXT; what the phone
//     does with it is a timeline update, and the PC keeps the words it typed.
//     That is 06 §5's "text already injected into the PC is never rewritten"
//     (已注入 PC 的文本永不回改) and it is why refine is not
//     allowed anywhere near the inject path.

import type { SttRefine } from '@flowmic/protocol';
import { AUDIO_DEFAULTS, STT_REFINE_MIN_UTTERANCE_MS } from '@flowmic/protocol';

/** Bytes per sample, keyed by the capture encoding the protocol declares.
 *
 *  🔴 The key type is `typeof AUDIO_DEFAULTS.encoding`, not `string`, ON PURPOSE:
 *  if the captured format is ever changed in `packages/protocol`, this literal
 *  stops satisfying the Record and the build FAILS here. A bare `32` (or a bare
 *  `2`) would keep compiling and silently convert bytes into the wrong number of
 *  milliseconds — and the only symptom would be a quality feature running on the
 *  wrong utterances, which is precisely the class of defect [[RetainedAudio]] and
 *  the refine gate exist to avoid. */
const BYTES_PER_SAMPLE: Record<typeof AUDIO_DEFAULTS.encoding, number> = { pcm_s16le: 2 };

/** Bytes of retained PCM that make up one millisecond of audio (= 32 today:
 *  16 kHz × 1 channel × 2 bytes). Derived, never written down. */
export const RETAINED_BYTES_PER_MS =
  (AUDIO_DEFAULTS.sample_rate_hz * AUDIO_DEFAULTS.channels * BYTES_PER_SAMPLE[AUDIO_DEFAULTS.encoding]) / 1000;

/** The effective floor for this config, with the shipped default. */
export function refineFloorMs(cfg: SttRefine): number {
  return cfg.min_utterance_ms ?? STT_REFINE_MIN_UTTERANCE_MS;
}

/**
 * Is this utterance worth a second pass?
 *
 * 🔴 Card N1-B1b — `durationMs` must be the duration of THE AUDIO THAT WILL BE
 * RE-TRANSCRIBED, i.e. [[RetainedAudio.durationMs]]. It is not 「the session」 and
 * it is not 「the final that triggered this」. The distinction was free while a
 * whole utterance was one final; card N1-B1 made every soft segment carry its own
 * `duration_ms`, and feeding THAT number here asks the floor a question about a
 * 2-second tail while the buffer holds ten minutes — the gate would then refuse
 * exactly the long recordings this feature exists to serve, and refuse them
 * silently, because refine is fire-and-forget by construction.
 */
export function shouldRefine(cfg: SttRefine | null, durationMs: number): boolean {
  if (cfg === null || !cfg.enabled) return false;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return false;
  return durationMs >= refineFloorMs(cfg);
}

/** Whitespace-insensitive sameness. The two passes may punctuate or space
 *  differently without meaning anything different; only a real change is news. */
export function isSameTranscript(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/gu, '').trim();
  return norm(a) === norm(b);
}

/**
 * Decide what (if anything) the second pass produced that is worth sending.
 * Returns the refined text, or `null` for 「nothing to say」.
 *
 * Separated from the engine call so every rule above is provable without a
 * transcription service.
 */
export function refinedTextOrNull(firstPass: string, secondPass: string): string | null {
  const next = secondPass.trim();
  if (next === '') return null;                       // a failed pass, not a better one
  if (isSameTranscript(firstPass, next)) return null; // no news
  return next;
}

export interface RefineRun {
  /** The utterance's retained PCM (16 kHz mono s16le), oldest byte first. */
  pcm: Buffer;
  /** The text the user already has. */
  firstPass: string;
  /** The batch second pass. Rejects on any engine problem. */
  transcribe: (pcm: Buffer) => Promise<string>;
  /** Reported, never thrown — refine is best-effort by construction. */
  onError?: (err: unknown) => void;
}

/**
 * Run one second pass. Resolves to the refined text, or `null` when there is
 * nothing worth telling the phone — INCLUDING when the engine failed.
 *
 * A refine failure is deliberately quiet ON THE WIRE and loud IN THE LOG. This
 * is the one place in the product where that is the honest split: the user's
 * utterance already succeeded, was already delivered and is already on screen.
 * Raising an error banner for a failed OPTIONAL improvement would report a
 * failure that did not happen to anything the user asked for.
 */
export async function runRefine(run: RefineRun): Promise<string | null> {
  if (run.pcm.length === 0) return null;
  try {
    const second = await run.transcribe(run.pcm);
    return refinedTextOrNull(run.firstPass, second);
  } catch (err) {
    run.onError?.(err);
    return null;
  }
}

/**
 * The retained-audio buffer for ONE utterance.
 *
 * In flight only: it lives from the first chunk to just after the terminal final
 * and is dropped with the session. Nothing is written to disk, so refine adds NO
 * audio-at-rest surface — the most sensitive artifact in the product stays in
 * memory for the length of one utterance, exactly as it already did while being
 * streamed to the engine.
 *
 * The cap is a second belt beside the 5-minute recording limit: 6 minutes of
 * 16 kHz mono s16le ≈ 11.5 MB, and past it the buffer STOPS growing rather than
 * evicting from the front — a refine of the last N seconds of a longer utterance
 * would silently transcribe the wrong span, which is worse than not refining.
 */
export class RetainedAudio {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly capBytes = 6 * 60 * 1000 * RETAINED_BYTES_PER_MS) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    if (this.bytes + chunk.length > this.capBytes) {
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  /** The utterance's audio, or an EMPTY buffer when the cap was hit — a partial
   *  span must never be refined as if it were the whole thing. */
  take(): Buffer {
    if (this.truncated) return Buffer.alloc(0);
    return Buffer.concat(this.chunks, this.bytes);
  }

  get byteLength(): number {
    return this.truncated ? 0 : this.bytes;
  }

  /**
   * How much audio is actually in here, in milliseconds — the ONE number
   * [[shouldRefine]] may be asked with (Card N1-B1b).
   *
   * It lives on the buffer rather than at the call site because the buffer is
   * what knows the format: the same constant sizes the cap two dozen lines up,
   * so 「how many bytes is a minute」 has one answer in this file and no second
   * copy to drift.
   *
   * 0 when the cap was hit — [[byteLength]] already reports an overflowed buffer
   * as empty, which is the same refusal [[take]] makes, stated in the same
   * direction: a partial span is not a shorter utterance, it is NO utterance.
   */
  get durationMs(): number {
    return this.byteLength / RETAINED_BYTES_PER_MS;
  }

  get overflowed(): boolean {
    return this.truncated;
  }

  clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
    this.truncated = false;
  }
}
