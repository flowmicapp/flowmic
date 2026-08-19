// RT-6-a leg: AssemblyAI Universal-3.5 Pro realtime (WebSocket v3).
//
// This is a LIVE streaming session, billed on how long the socket stays open
// (not on audio seconds). The clean terminal is the server's `Termination`
// frame AFTER we send `{type:'Terminate'}`. Closing without Terminate leaves
// the session accruing charges until the 3-hour cap — that is why every
// finish path tries to send Terminate first.
//
// Official refs (fetched 2026-08-15, do not memorise):
//   https://www.assemblyai.com/docs/streaming/message-sequence
//   https://www.assemblyai.com/docs/streaming/select-the-speech-model
// Auth is the raw key in `Authorization` — no `Bearer` prefix.
// Realtime takes singular `speech_model` (required). Pre-recorded's
// `speech_models[]` must not be used here.
//
// Lives in its own file so audio-ab-adapters.mjs's probe-contract drill
// (no `fetch(` in that file) stays honest. Tests inject `config.connect`
// and spend nothing.
//
// Node 22 ESM.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const wsRequire = createRequire(join(REPO_ROOT, 'apps', 'server-core', 'package.json'));

export const ASSEMBLYAI_ENV = join(REPO_ROOT, '.local', 'assemblyai.env');
export const ASSEMBLYAI_WS_DEFAULT = 'wss://streaming.assemblyai.com/v3/ws';
export const ASSEMBLYAI_DEFAULT_MODEL = 'universal-3-5-pro';
export const ASSEMBLYAI_CLEAN_FINISH = 'Termination';

export function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export function buildStreamingUrl(base, { sampleRate, speechModel, mode }) {
  const u = new URL(base);
  u.searchParams.set('sample_rate', String(sampleRate));
  u.searchParams.set('speech_model', speechModel);
  u.searchParams.set('mode', mode);
  return u.toString();
}

/**
 * @param {object} config
 *   speechModel — realtime singular string (default universal-3-5-pro)
 *   mode        — min_latency | balanced | max_accuracy (default balanced)
 *   pace        — 'realtime' (default) | 'fast'
 *   timeoutMs   — default 120_000
 *   apiKey      — override; production reads .local/assemblyai.env
 *   connect     — injectable (url, {headers}) => ws-like; tests supply a fake
 */
export function assemblyaiSttAdapter(config = {}) {
  const env = readEnvFile(ASSEMBLYAI_ENV);
  const overridden = Object.prototype.hasOwnProperty.call(config, 'apiKey');
  const apiKey = config.apiKey
    ?? env.FLOWMIC_ASSEMBLYAI_API_KEY
    ?? process.env.FLOWMIC_ASSEMBLYAI_API_KEY
    ?? '';
  const speechModel = config.speechModel
    ?? env.FLOWMIC_ASSEMBLYAI_SPEECH_MODEL
    ?? ASSEMBLYAI_DEFAULT_MODEL;
  const mode = config.mode ?? 'balanced';
  const pace = config.pace ?? 'realtime';
  const timeoutMs = typeof config.timeoutMs === 'number' ? config.timeoutMs : 120_000;
  const wsBase = config.wsBase ?? env.FLOWMIC_ASSEMBLYAI_WS ?? ASSEMBLYAI_WS_DEFAULT;

  return {
    name: config.__name ?? 'assemblyai',
    describe: () =>
      `assemblyai realtime ${speechModel} · mode=${mode} · pace=${pace} · ` +
      `edge ${wsBase} · key ${apiKey.length} chars (value never printed)`,
    assembler: {
      kind: 'bed-local',
      note:
        'this bed joins AssemblyAI Turn frames where end_of_turn && turn_is_formatted, ' +
        'then waits for Termination. It does NOT run the product TokenAccumulator. ' +
        'Read the column as THE VENDOR\'S REALTIME TURNS, not as what a user would see.',
    },
    probe: async () => {
      if (!overridden && !existsSync(ASSEMBLYAI_ENV) && !process.env.FLOWMIC_ASSEMBLYAI_API_KEY) {
        return { ready: false, reason: `no key: ${ASSEMBLYAI_ENV} is absent and FLOWMIC_ASSEMBLYAI_API_KEY is unset` };
      }
      if (!apiKey) return { ready: false, reason: 'no key: FLOWMIC_ASSEMBLYAI_API_KEY is empty' };
      if (!overridden) {
        try { wsRequire.resolve('ws'); } catch {
          return { ready: false, reason: "the 'ws' package is not resolvable from apps/server-core — run pnpm install" };
        }
      }
      return { ready: true };
    },
    transcribe: (pcm, seg) => new Promise((resolveP) => {
      const sampleRate = seg?.fmt?.sampleRate ?? 16_000;
      const url = buildStreamingUrl(wsBase, { sampleRate, speechModel, mode });
      const headers = { Authorization: apiKey };
      const connect = config.connect
        ?? ((u, o) => {
          const WebSocket = wsRequire('ws');
          return new WebSocket(u, o);
        });
      const ws = connect(url, { headers });

      const finals = [];
      const byOrder = new Map();
      let lastAudioAt = null;
      let settled = false;
      let terminated = false;
      let firstTokenAt = null;
      let frames = 0;
      let echoedModel = null;
      const t0 = Date.now();

      const sendTerminate = () => {
        if (terminated) return;
        terminated = true;
        try { ws.send(JSON.stringify({ type: 'Terminate' })); } catch { /* already closing */ }
      };

      const finish = (why) => {
        if (settled) return;
        settled = true;
        sendTerminate();
        try { ws.close(); } catch { /* already closing */ }
        const completed = why === ASSEMBLYAI_CLEAN_FINISH;
        const ordered = [...byOrder.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
        const text = (ordered.length > 0 ? ordered : finals).join('');
        resolveP({
          text,
          tailMs: lastAudioAt === null ? null : Date.now() - lastAudioAt,
          completed,
          incompleteWhy: completed ? undefined
            : `${why} — the session never reached ${JSON.stringify(ASSEMBLYAI_CLEAN_FINISH)}; ` +
              `${ordered.length || finals.length} final turn(s), ${frames} frame(s)`,
          meta: {
            why,
            speechModel,
            echoedModel,
            mode,
            pace,
            finalTurns: ordered.length || finals.length,
            firstTokenMs: firstTokenAt === null ? null : firstTokenAt - t0,
            frames,
          },
        });
      };

      const timer = setTimeout(() => finish(`TIMEOUT ${timeoutMs}ms`), timeoutMs);

      const onOpen = async () => {
        const bytesPerMs = (sampleRate * 2) / 1000;
        const frameMs = pace === 'realtime' ? 60 : 20;
        const FRAME = Math.max(1600, Math.round(bytesPerMs * frameMs));
        for (let off = 0; off < pcm.length; off += FRAME) {
          if (settled) return;
          ws.send(pcm.subarray(off, Math.min(off + FRAME, pcm.length)));
          await new Promise((r) => setTimeout(r, frameMs));
        }
        lastAudioAt = Date.now();
        sendTerminate();
      };

      const onMessage = (d) => {
        let f;
        try { f = JSON.parse(typeof d === 'string' ? d : d.toString('utf8')); } catch { return; }
        frames += 1;
        if (f.type === 'Begin') {
          echoedModel = f.configuration?.model ?? null;
          return;
        }
        if (f.type === 'Error') {
          clearTimeout(timer);
          finish(`server error ${f.error_code ?? ''} ${f.error ?? ''}`.trim());
          return;
        }
        if (f.type === 'Turn') {
          if (firstTokenAt === null && typeof f.transcript === 'string' && f.transcript.length > 0) {
            firstTokenAt = Date.now();
          }
          if (f.end_of_turn === true && f.turn_is_formatted === true) {
            const piece = (typeof f.utterance === 'string' && f.utterance.length > 0)
              ? f.utterance
              : (typeof f.transcript === 'string' ? f.transcript : '');
            if (typeof f.turn_order === 'number') byOrder.set(f.turn_order, piece);
            else if (piece) finals.push(piece);
          }
          return;
        }
        if (f.type === ASSEMBLYAI_CLEAN_FINISH) {
          clearTimeout(timer);
          finish(ASSEMBLYAI_CLEAN_FINISH);
        }
      };

      const onClose = () => { clearTimeout(timer); finish('ws closed'); };
      const onError = (e) => { clearTimeout(timer); finish(`ws error: ${e?.message ?? e}`); };

      if (typeof ws.on === 'function') {
        ws.on('open', onOpen);
        ws.on('message', onMessage);
        ws.on('close', onClose);
        ws.on('error', onError);
      } else {
        ws.addEventListener?.('open', onOpen);
        ws.addEventListener?.('message', (ev) => onMessage(ev.data));
        ws.addEventListener?.('close', onClose);
        ws.addEventListener?.('error', onError);
      }
    }),
  };
}
