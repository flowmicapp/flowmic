// scripts/loadtest/lib/audio-synth.mjs
//
// One synthetic 200ms PCM chunk, reused by every simulated client.
//
// Shape is fixed by the wire contract (packages/protocol AudioStartSchema):
// 16kHz mono s16le. 200ms of that = 16000 * 0.2 samples * 2 bytes/sample =
// 6400 raw bytes — the exact figure the task names, and it is not a
// coincidence: audio:chunk is meant to carry a fixed-cadence PTT stream, and
// the mobile client (apps/mobile) chunks at the same 200ms cadence.
//
// A continuous sine tone (not silence) is used on purpose: this repo's own VAD
// treats a flat-zero buffer as silence (see the probe run recorded in the
// harness's README — a real silent chunk against the real seeded engine came
// back as stt:level{amplitude_db:-100}), and a load test whose "speech" a VAD
// stage immediately classifies as non-speech would under-count exactly the
// per-chunk work (VAD + decode) this tool exists to load. A constant sine
// amplitude is not real speech either, but it keeps every sample above the
// silence floor for the whole utterance, which is the property that matters
// for loading the VAD path — see README.md "what this does and does not
// exercise" for the honest boundary.

export const SAMPLE_RATE_HZ = 16_000;
export const CHUNK_MS = 200;
export const BYTES_PER_SAMPLE = 2; // s16le
export const SAMPLES_PER_CHUNK = Math.round((SAMPLE_RATE_HZ * CHUNK_MS) / 1000); // 3200
export const CHUNK_BYTES = SAMPLES_PER_CHUNK * BYTES_PER_SAMPLE; // 6400

const TONE_HZ = 220; // A3 — arbitrary, audible-range, nothing product-meaningful
const AMPLITUDE = 0.35; // headroom below full-scale int16, avoids clipping artifacts

/** Precomputed ONCE at module load. Every client reuses the same bytes for
 *  every chunk — the content is not the point (no real engine ever reads it
 *  for recognition in the default "off" engine mode; see README), only its
 *  size, cadence, and base64 encode/decode cost are. */
function buildSineChunkBase64() {
  const buf = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < SAMPLES_PER_CHUNK; i++) {
    const t = i / SAMPLE_RATE_HZ;
    const sample = Math.round(AMPLITUDE * 32767 * Math.sin(2 * Math.PI * TONE_HZ * t));
    buf.writeInt16LE(sample, i * BYTES_PER_SAMPLE);
  }
  return buf.toString('base64');
}

export const SINE_CHUNK_B64 = buildSineChunkBase64();

/** How many 200ms chunks make up an utterance of the given length. */
export function chunkCountFor(utteranceMs) {
  return Math.max(1, Math.round(utteranceMs / CHUNK_MS));
}
