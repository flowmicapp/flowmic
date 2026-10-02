// WV-7 independent acceptance arithmetic. Missing observations never become zero.
import { percentile, padWavWithSilence, parseWav } from './emb13-live-rig-lib.mjs';
export function leadingSilence(buf, ms) {
  const out = padWavWithSilence(buf, ms), speech = parseWav(buf).data;
  const silentBytes = out.length - 44 - speech.length;
  out.fill(0, 44); speech.copy(out, 44 + silentBytes);
  return out;
}
/**
 * Card WV-T4 (rounds 2-3): where the first sound of a 16-bit PCM fixture is, in
 * ms (the first sample louder than `threshold`, about -30 dBFS by default), and
 * the same recording ROTATED so it starts there: the lead-in samples before
 * that point are moved, unchanged, to the end. Same samples, same length, only
 * the order differs.
 *
 * WHY: the first-word claim is "a word that begins within 200 ms of the press is
 * kept", judged on the page's own speech onset (`judgeFirstWord`,
 * `pressToOnsetMs`). The default fixture zh-6s.wav begins with 180 ms of
 * low-level sound (2884 frames, peak |684|), so press -> onset was already
 * 180 ms plus the microphone's own start before the product did anything: a
 * correct build could not pass, and a pass would not test the first 180 ms at
 * all. Rotating keeps the length, so every loop period computed from it holds,
 * and it removes nothing: round 2 zero-filled the moved part instead, which
 * silently dropped those 180 ms (1136 non-zero samples; review of round 2, P3).
 * Aligning does not make 200 ms reachable by itself -- the live onset probe
 * still has to measure it.
 */
function onsetFrame(wav, threshold) {
  if (wav.bitsPerSample !== 16) throw new Error('fixture onset needs 16-bit PCM');
  const frame = wav.channels * 2;
  for (let i = 0; i + 1 < wav.data.length; i += 2)
    if (Math.abs(wav.data.readInt16LE(i)) > threshold) return (i - (i % frame)) / frame;
  return null;
}
export function fixtureOnsetMs(buf, threshold = 1000) {
  const wav = parseWav(buf);
  const at = onsetFrame(wav, threshold);
  return at === null ? null : (at / wav.sampleRate) * 1000;
}
export function onsetAlignedWav(buf, threshold = 1000) {
  const wav = parseWav(buf);
  const at = onsetFrame(wav, threshold);
  if (at === null) throw new Error('fixture has no sound above the onset threshold');
  const lead = at * wav.channels * 2;
  const out = padWavWithSilence(buf, 0); // a clean header over the same data length
  const rotated = Buffer.concat([wav.data.subarray(lead), wav.data.subarray(0, lead)]);
  rotated.copy(out, out.length - rotated.length);
  return out;
}
export function budget(values, p50Limit, p95Limit) {
  const measured = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const p50 = percentile(measured, 50), p95 = percentile(measured, 95);
  return { n: measured.length, p50, p95, verdict: !measured.length ? 'not measured' : measured.length === values.length && measured.every((v) => v >= 0) && p50 <= p50Limit && p95 <= p95Limit ? 'PASS' : 'FAIL' };
}
export function overlap(a, b) {
  if (!a || !b) return null;
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}
export function placement(s) {
  if (!s?.capsule || !s?.field || !s?.button) return { verdict: 'not measured' };
  const fieldOverlap = overlap(s.capsule, s.field), buttonOverlap = overlap(s.capsule, s.button);
  const fullyVisible = !!s.viewport && s.capsule.left >= 0 && s.capsule.top >= 0 && s.capsule.right <= s.viewport.width && s.capsule.bottom <= s.viewport.height;
  return { fieldOverlap, buttonOverlap, fullyVisible, pointerEvents: s.pointerEvents, side: s.side,
    verdict: fullyVisible && fieldOverlap === 0 && buttonOverlap === 0 && s.pointerEvents === 'none' && s.pressHitsButton ? 'PASS' : 'FAIL' };
}
