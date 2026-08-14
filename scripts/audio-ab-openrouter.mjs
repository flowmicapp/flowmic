// RT-6-a leg: OpenRouter speech-to-text (batch transcription).
//
// OpenRouter's STT surface is POST /api/v1/audio/transcriptions — the same
// batch shape as apps/server-core/src/stt/engines/openai-whisper.ts. It is
// NOT a live streaming engine. A number from this leg is "how the vendor
// transcribes a finished wav", not "what a FlowMic user would see while
// speaking". The assembler declaration below is what keeps those two
// questions from sharing one column.
//
// Lives in its own file because audio-ab-adapters.mjs's probe-contract drill
// forbids `fetch(` in that file (it is how the drill proves sherpa's probe
// never downloads). The HTTP call belongs here, where a test can inject
// `config.fetch` and spend nothing.
//
// Node 22 ESM.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
export const OPENROUTER_ENV = join(REPO_ROOT, '.local', 'openrouter.env');
export const OPENROUTER_STT_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
export const OPENROUTER_DEFAULT_STT = 'openai/whisper-large-v3-turbo';

export function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Canonical 44-byte RIFF/WAVE header + s16le mono PCM. Same layout as wav.ts. */
export function buildWav(pcm, sampleRate) {
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
  header.writeUInt32LE(16, o); o += 4;
  header.writeUInt16LE(1, o); o += 2;
  header.writeUInt16LE(numChannels, o); o += 2;
  header.writeUInt32LE(sampleRate, o); o += 4;
  header.writeUInt32LE(byteRate, o); o += 4;
  header.writeUInt16LE(blockAlign, o); o += 2;
  header.writeUInt16LE(bitsPerSample, o); o += 2;
  header.write('data', o); o += 4;
  header.writeUInt32LE(dataSize, o);
  return Buffer.concat([header, pcm], header.length + dataSize);
}

/**
 * @param {object} config
 *   model     — OpenRouter STT slug (default: env, else whisper-large-v3-turbo)
 *   language  — optional ISO-639-1 hint. Omitted = vendor auto-detect (needed
 *               for the mixed zh/en segments this bed exists to catch).
 *   timeoutMs — default 120_000
 *   fetch     — injectable; production uses globalThis.fetch
 *   apiKey    — override; production reads .local/openrouter.env
 */
export function openrouterSttAdapter(config = {}) {
  const env = readEnvFile(OPENROUTER_ENV);
  const apiKey = config.apiKey
    ?? env.FLOWMIC_OPENROUTER_API_KEY
    ?? process.env.FLOWMIC_OPENROUTER_API_KEY
    ?? '';
  const model = config.model
    ?? env.FLOWMIC_OPENROUTER_STT_MODEL
    ?? OPENROUTER_DEFAULT_STT;
  const language = typeof config.language === 'string' && config.language.length > 0
    ? config.language
    : undefined;
  const timeoutMs = typeof config.timeoutMs === 'number' ? config.timeoutMs : 120_000;
  const fetchImpl = config.fetch ?? globalThis.fetch;

  return {
    name: config.__name ?? 'openrouter',
    describe: () =>
      `openrouter STT ${model}` +
      `${language ? ` · lang=${language}` : ' · lang=auto'}` +
      ` · batch /audio/transcriptions · key ${apiKey.length} chars (value never printed)`,
    assembler: {
      kind: 'bed-local',
      note:
        'this bed POSTs a finished wav to OpenRouter /audio/transcriptions and takes ' +
        'the vendor `text` field. It is a BATCH transcription, not the product streaming ' +
        'path (Soniox websocket + TokenAccumulator). Read the column as THE VENDOR\'S ' +
        'OFFLINE ANSWER, not as what a user would see while speaking.',
    },
    probe: async () => {
      // 🔴 "You handed me an empty key" and "nobody configured a key" are two
      // different answers, and until 2026-08-14 this decided between them by
      // looking at the filesystem — so `{ apiKey: '' }` reported "no key file"
      // whenever the dev machine happened to lack one. MEASURED that day, on the
      // first run of the gates inside an EXPORTED tree: the test asserting the
      // empty-override reason passed here and failed there, because the only
      // thing separating the two branches was a credential file that exists on
      // this machine and on no contributor's. The caller's own intent is the
      // honest judge: if `apiKey` was passed at all, answer about THAT.
      const overridden = Object.prototype.hasOwnProperty.call(config, 'apiKey');
      if (!overridden && !existsSync(OPENROUTER_ENV) && !process.env.FLOWMIC_OPENROUTER_API_KEY) {
        return { ready: false, reason: `no key: ${OPENROUTER_ENV} is absent and FLOWMIC_OPENROUTER_API_KEY is unset` };
      }
      if (!apiKey) return { ready: false, reason: 'no key: FLOWMIC_OPENROUTER_API_KEY is empty' };
      return { ready: true };
    },
    transcribe: async (pcm, seg) => {
      const sampleRate = seg?.fmt?.sampleRate ?? 16_000;
      const wav = buildWav(pcm, sampleRate);
      const body = {
        model,
        input_audio: { data: wav.toString('base64'), format: 'wav' },
      };
      if (language) body.language = language;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const t0 = Date.now();
      try {
        const res = await fetchImpl(OPENROUTER_STT_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://flowmic.app',
            'X-OpenRouter-Title': 'FlowMic RT-6-a',
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        const raw = await res.text();
        if (!res.ok) {
          return {
            text: '',
            tailMs: Date.now() - t0,
            completed: false,
            incompleteWhy: `openrouter http ${res.status} ${raw.slice(0, 180)}`,
            meta: { model, status: res.status },
          };
        }
        let parsed;
        try { parsed = JSON.parse(raw); } catch {
          return {
            text: '',
            tailMs: Date.now() - t0,
            completed: false,
            incompleteWhy: `openrouter returned non-JSON (${raw.slice(0, 80)})`,
            meta: { model },
          };
        }
        const text = typeof parsed?.text === 'string' ? parsed.text : '';
        return {
          text,
          tailMs: Date.now() - t0,
          completed: true,
          meta: { model, usage: parsed?.usage ?? null, chars: text.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const aborted = /abort/i.test(msg);
        return {
          text: '',
          tailMs: Date.now() - t0,
          completed: false,
          incompleteWhy: aborted ? `TIMEOUT ${timeoutMs}ms` : `fetch failed: ${msg}`,
          meta: { model },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
