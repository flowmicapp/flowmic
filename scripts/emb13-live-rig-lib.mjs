// Pure helpers for scripts/emb13-live-rig.mjs (card EMB-13, local variant).
//
// Split out so the parts that decide "did the rig measure what it says it
// measured" can be drilled without a browser, a relay or a single managed
// minute: scripts/emb13-live-rig.test.mjs imports this file and nothing else.
// Nothing here touches the network, the filesystem or process.env by itself.

/** The opt-in switch. The rig spends managed transcription minutes, so a bare
 *  invocation must do nothing. Exactly '1', not "any truthy value": a stray
 *  FLOWMIC_EMB13_LIVE=0 in a shell profile must not start a paid run. */
export const RIG_FLAG = 'FLOWMIC_EMB13_LIVE';

export function liveEnabled(env) {
  return env?.[RIG_FLAG] === '1';
}

/** Nearest-rank percentile (the definition that always returns a value that was
 *  actually observed; an interpolated p95 over five samples is a number no run
 *  ever produced). `values` may be unsorted; empty input answers null. */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * xs.length));
  return xs[Math.min(rank, xs.length) - 1];
}

/** {n, p50, max}: what the card asks for per field type. `n` is reported so a
 *  p50 over two survivors cannot pass for a p50 over five. */
export function summarize(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  return { n: xs.length, p50: percentile(xs, 50), max: xs.length ? Math.max(...xs) : null };
}

/** KEY=VALUE lines (the shape of .local/*.env). Blank lines and # comments
 *  skipped; no quoting or expansion, matching the files it reads. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Replace every occurrence of each secret with a fixed marker. The rig prints
 *  server output on failure, and a key in a log line is a leaked key. Secrets
 *  shorter than 8 characters are ignored: replacing "1" would shred the log. */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (typeof s === 'string' && s.length >= 8) out = out.split(s).join('<redacted>');
  return out;
}

/** Locate the PCM data of a RIFF/WAVE buffer. Throws on anything the fake
 *  capture device would not treat as plain PCM, rather than guessing. */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let fmt = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data chunk before fmt chunk');
      if (fmt.format !== 1) throw new Error(`WAV format ${fmt.format} is not PCM`);
      const start = off + 8;
      const end = Math.min(buf.length, start + size);
      return { ...fmt, data: buf.subarray(start, end) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

/** Audio length of the PCM in a parsed WAV, in milliseconds. */
export function wavDurationMs(wav) {
  const bytesPerSecond = wav.sampleRate * wav.channels * (wav.bitsPerSample / 8);
  return Math.round((wav.data.length / bytesPerSecond) * 1000);
}

/** The same recording followed by `silenceMs` of digital silence, as a WAV.
 *
 *  WHY: Chromium's fake capture device loops the file. A 6 s sentence looped
 *  under a 6.4 s press would put the first word of the sentence into the
 *  recording twice. The padding is silence, so the speech is the fixture's own
 *  and nothing is recorded or synthesised. */
export function padWavWithSilence(buf, silenceMs) {
  const wav = parseWav(buf);
  const frame = wav.channels * (wav.bitsPerSample / 8);
  const silence = Buffer.alloc(Math.round((silenceMs / 1000) * wav.sampleRate) * frame);
  const data = Buffer.concat([wav.data, silence]);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(wav.channels, 22);
  header.writeUInt32LE(wav.sampleRate, 24);
  header.writeUInt32LE(wav.sampleRate * frame, 28);
  header.writeUInt16LE(frame, 32);
  header.writeUInt16LE(wav.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** One Socket.IO text packet -> {event, payload} for an EVENT (`42["name",{}]`),
 *  or null for anything else (pings, acks, binary attachments, polling noise).
 *  A namespace prefix (`42/ns,`) is tolerated; the rig only ever uses `/`. */
export function parseSocketIoEvent(text) {
  if (typeof text !== 'string' || !text.startsWith('42')) return null;
  let body = text.slice(2);
  if (body.startsWith('/')) {
    const comma = body.indexOf(',');
    if (comma < 0) return null;
    body = body.slice(comma + 1);
  }
  const bracket = body.indexOf('[');
  if (bracket < 0) return null;
  try {
    const arr = JSON.parse(body.slice(bracket));
    return Array.isArray(arr) && typeof arr[0] === 'string' ? { event: arr[0], payload: arr[1] } : null;
  } catch {
    return null;
  }
}

/** Milliseconds of PCM carried by one `audio:chunk` frame's base64 payload,
 *  for 16 kHz mono s16le (the SDK's wire format, core audio/format.ts). */
export function chunkMs(dataB64) {
  const bytes = Buffer.from(String(dataB64 ?? ''), 'base64').length;
  return (bytes / 2 / 16000) * 1000;
}

/** What the recognised text is allowed to look like for the bundled Chinese
 *  fixture. Deliberately loose: this rig judges where words LAND and how fast,
 *  not recognition accuracy (design 4.3 leaves accuracy to a two-path
 *  comparison). It only refuses an empty or non-Chinese answer. */
export function looksLikeChineseSpeech(text) {
  return (String(text).match(/\p{Script=Han}/gu) ?? []).length >= 6;
}

/** The text the insert rule should produce, computed from the sentence(s) the
 *  page saw as `text` events. `before` is the field's value with the caret at
 *  `caret`. Latin-script sentences get one leading space unless the text before
 *  the caret already ends in whitespace or the sentence starts with
 *  punctuation; CJK sentences get none. This mirrors packages/sdk targets.ts on
 *  the web side ON PURPOSE as an independent statement of the rule (design 3.4
 *  "write where"), so a change to the SDK's separator turns the rig red
 *  instead of silently redefining the expectation. */
export function expectedInsert(before, caret, sentences) {
  let head = before.slice(0, caret);
  const tail = before.slice(caret);
  for (const s of sentences) {
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);
    const sep = head.length > 0 && !/\s$/u.test(head) && !/^\s|^[.,!?;:\uff0c\u3002\uff01\uff1f]/u.test(s) && !cjk ? ' ' : '';
    head += sep + s;
  }
  return { value: head + tail, caret: head.length };
}

/** A run passes only if every named check passed; keeps the failing check
 *  names so a red row says which claim broke instead of "failed". */
export function verdict(checks) {
  const failed = Object.entries(checks).filter(([, ok]) => ok !== true).map(([name]) => name);
  return { pass: failed.length === 0, failed };
}
