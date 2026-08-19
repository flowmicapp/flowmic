// Drill for scripts/audio-ab-assemblyai.mjs — no network, no real key.
//
// EXIT: 0 PASS, 1 FAIL. Never skips — every assertion is hermetic.

import {
  assemblyaiSttAdapter,
  buildStreamingUrl,
  ASSEMBLYAI_WS_DEFAULT,
  ASSEMBLYAI_DEFAULT_MODEL,
  ASSEMBLYAI_CLEAN_FINISH,
} from './audio-ab-assemblyai.mjs';

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error(`FAIL  ${msg}`);
  } else {
    console.log(`ok    ${msg}`);
  }
}

const pcm = Buffer.alloc(3200);

{
  const url = buildStreamingUrl(ASSEMBLYAI_WS_DEFAULT, {
    sampleRate: 16_000,
    speechModel: ASSEMBLYAI_DEFAULT_MODEL,
    mode: 'balanced',
  });
  assert(url.startsWith(ASSEMBLYAI_WS_DEFAULT), 'url keeps the Edge host');
  assert(url.includes('speech_model=universal-3-5-pro'), 'realtime uses singular speech_model');
  assert(!url.includes('speech_models'), 'and never the pre-recorded plural');
  assert(url.includes('mode=balanced'), 'mode is on the query string');
}

{
  const ad = assemblyaiSttAdapter({ apiKey: '' });
  const p = await ad.probe();
  assert(p.ready === false, 'probe refuses an empty key');
  assert(typeof p.reason === 'string' && p.reason.includes('empty'), `reason names emptiness: ${p.reason}`);
}

{
  const ad = assemblyaiSttAdapter({ apiKey: 'test-assemblyai-key-not-a-vendor-prefix' });
  assert(ad.assembler.kind === 'bed-local', 'assembler admits bed-local');
  assert(ad.assembler.note.includes('Termination'), 'and names the clean terminal');
  assert(ad.assembler.note.includes('TokenAccumulator'), 'and names the product class it does not run');
  assert(!ad.describe().includes('test-assemblyai-key-not-a-vendor-prefix'), 'describe never prints the key');
  const p = await ad.probe();
  assert(p.ready === true, 'probe is ready when a key is supplied — it does not open a socket');
}

function fakeConnect(script) {
  const sent = [];
  let handlers = {};
  const ws = {
    sent,
    on(event, fn) { handlers[event] = fn; },
    send(data) {
      sent.push(data);
      script.onSend?.(data, ws);
    },
    close() { queueMicrotask(() => handlers.close?.()); },
    emit(event, payload) { handlers[event]?.(payload); },
  };
  return {
    connect: (url, opts) => {
      script.onConnect?.(url, opts, ws);
      queueMicrotask(async () => {
        await handlers.open?.();
        script.afterOpen?.(ws);
      });
      return ws;
    },
    sent,
  };
}

{
  let seenUrl = '';
  let seenAuth = '';
  const fake = fakeConnect({
    onConnect(url, opts) {
      seenUrl = url;
      seenAuth = opts.headers.Authorization;
    },
    onSend(data, ws) {
      if (typeof data === 'string' && data.includes('"Terminate"')) {
        ws.emit('message', JSON.stringify({
          type: 'Begin',
          configuration: { model: 'universal-3-5-pro', mode: 'balanced' },
        }));
        ws.emit('message', JSON.stringify({
          type: 'Turn',
          turn_order: 0,
          end_of_turn: false,
          turn_is_formatted: false,
          transcript: 'partial must not land',
        }));
        ws.emit('message', JSON.stringify({
          type: 'Turn',
          turn_order: 0,
          end_of_turn: true,
          turn_is_formatted: true,
          transcript: '明天三点开会',
          utterance: '明天三点开会',
        }));
        ws.emit('message', JSON.stringify({
          type: 'Termination',
          audio_duration_seconds: 1,
          session_duration_seconds: 1,
        }));
      }
    },
  });
  const ad = assemblyaiSttAdapter({
    apiKey: 'test-assemblyai-key-not-a-vendor-prefix',
    pace: 'fast',
    connect: fake.connect,
  });
  const r = await ad.transcribe(pcm, { id: '1', fmt: { sampleRate: 16_000 } });
  assert(seenUrl.includes('speech_model=universal-3-5-pro'), `connected with flagship model: ${seenUrl}`);
  assert(seenAuth === 'test-assemblyai-key-not-a-vendor-prefix', 'Authorization is the raw key, no Bearer');
  assert(fake.sent.some((s) => typeof s === 'string' && s.includes('"Terminate"')), 'session is explicitly Terminated');
  assert(r.completed === true, `${ASSEMBLYAI_CLEAN_FINISH} is a completed session`);
  assert(r.text === '明天三点开会', 'text is the formatted final turn, not the partial');
}

{
  const fake = fakeConnect({
    afterOpen(ws) {
      ws.emit('message', JSON.stringify({ type: 'Error', error_code: 1008, error: 'Unauthorized' }));
    },
  });
  const ad = assemblyaiSttAdapter({
    apiKey: 'test-assemblyai-key-not-a-vendor-prefix',
    pace: 'fast',
    connect: fake.connect,
  });
  const r = await ad.transcribe(pcm, { id: '1', fmt: { sampleRate: 16_000 } });
  assert(r.completed === false, 'Error frame is VOID, not recall 0');
  assert(typeof r.incompleteWhy === 'string' && r.incompleteWhy.includes('1008'), `why names the code: ${r.incompleteWhy}`);
}

{
  const fake = fakeConnect({
    afterOpen(ws) {
      queueMicrotask(() => ws.close());
    },
  });
  const ad = assemblyaiSttAdapter({
    apiKey: 'test-assemblyai-key-not-a-vendor-prefix',
    pace: 'fast',
    connect: fake.connect,
  });
  const r = await ad.transcribe(pcm, { id: '1', fmt: { sampleRate: 16_000 } });
  assert(r.completed === false, 'a close without Termination is VOID');
  assert(typeof r.incompleteWhy === 'string' && r.incompleteWhy.includes('closed'), `why names the close: ${r.incompleteWhy}`);
}

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nPASS');
process.exit(0);
