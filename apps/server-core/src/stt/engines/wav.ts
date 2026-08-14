// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (batch-style engines: PCM accumulation → 44-byte WAV header → POST)
//   Shared WAV/lang helpers for the batch HTTP engines (whisper / custom-openai
//   / funspeech) — de-duplicated from the legacy per-engine copies. The 44-byte
//   canonical RIFF/WAVE header is contract-verified by the batch WAV-header test.
//
// Layout per http://soundfile.sapp.org/doc/WaveFormat/:
//   RIFF<size>WAVEfmt <16><1><1><rate><byteRate><2><16>data<size>

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;

/** 'zh-CN' → 'zh', 'en-US' → 'en'. Bare codes pass through lower-cased. */
export function toShortLang(lang: string): string {
  const idx = lang.indexOf('-');
  return (idx > 0 ? lang.slice(0, idx) : lang).toLowerCase();
}

export function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/** Build a canonical 44-byte WAV header + s16le PCM body at `sampleRate` mono. */
export function buildWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  let o = 0;
  header.write('RIFF', o); o += 4;
  header.writeUInt32LE(36 + dataSize, o); o += 4;
  header.write('WAVE', o); o += 4;
  header.write('fmt ', o); o += 4;
  header.writeUInt32LE(16, o); o += 4;            // PCM fmt chunk size
  header.writeUInt16LE(1, o); o += 2;             // audio format = PCM
  header.writeUInt16LE(numChannels, o); o += 2;
  header.writeUInt32LE(sampleRate, o); o += 4;
  header.writeUInt32LE(byteRate, o); o += 4;
  header.writeUInt16LE(blockAlign, o); o += 2;
  header.writeUInt16LE(bitsPerSample, o); o += 2;
  header.write('data', o); o += 4;
  header.writeUInt32LE(dataSize, o);
  return Buffer.concat([header, pcm], header.length + dataSize);
}

/** Convenience: 16 kHz mono s16le WAV. */
export function buildWav16kMono(pcm: Buffer): Buffer {
  return buildWav(pcm, SAMPLE_RATE);
}
