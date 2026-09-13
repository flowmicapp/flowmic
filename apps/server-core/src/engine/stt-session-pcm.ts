// ⚠️ THE SPLIT FROM `stt-session.ts` WAS FORCED BY THE 800-LINE CAP
// (verify/lint/file-size.mjs), not by an architectural claim — the same reason
// `stt-session-autostop.ts`, `-deps.ts`, `-intake.ts`, `-receipt.ts`,
// `-refine.ts` and `-detached-polish.ts` are separate files. The function below
// moved VERBATIM, its doc comment with it. Read the seam as "this happened to
// move as one block", not as "PCM arithmetic is now a layer".
//
// It sat between two import statements in the middle of `stt-session.ts`'s
// import block, which is where it had ended up rather than where anybody put
// it. One caller: the bridge's `stt:level` path.

/** Loudest |sample| in a PCM16-LE buffer (0..32767). The one number that tells
 *  "the microphone is recording but the room is quiet" apart from "it was never recording at all". */
export function peakSample16(buf: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}
