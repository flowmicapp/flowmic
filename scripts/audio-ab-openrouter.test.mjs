// Drill for scripts/audio-ab-openrouter.mjs — no network, no real key.
//
// The adapter's job is to turn a finished wav into a vendor `text` and to
// DECLARE whether the session completed. A test that hits the live API would
// spend money and would go red when OpenRouter is down, which is exactly why
// the live A/B is a reported measurement and this file is not.
//
// EXIT: 0 PASS, 1 FAIL. Never skips — every assertion is hermetic.

import { openrouterSttAdapter, buildWav, OPENROUTER_STT_URL, OPENROUTER_DEFAULT_STT } from './audio-ab-openrouter.mjs';

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error(`FAIL  ${msg}`);
  } else {
    console.log(`ok    ${msg}`);
  }
}

const pcm = Buffer.alloc(3200); // 100 ms of silence @ 16 kHz s16le

{
  const wav = buildWav(pcm, 16_000);
  assert(wav.length === 44 + pcm.length, 'wav is 44-byte header plus pcm');
  assert(wav.toString('ascii', 0, 4) === 'RIFF', 'RIFF magic');
  assert(wav.toString('ascii', 8, 12) === 'WAVE', 'WAVE magic');
}

{
  const ad = openrouterSttAdapter({ apiKey: '' });
  const p = await ad.probe();
  // Empty override still counts as "a key was supplied but empty".
  assert(p.ready === false, 'probe refuses an empty key');
  assert(typeof p.reason === 'string' && p.reason.includes('empty'), `reason names emptiness: ${p.reason}`);
}

{
  const ad = openrouterSttAdapter({ apiKey: 'test-openrouter-key-not-a-vendor-prefix' });
  assert(ad.assembler.kind === 'bed-local', 'assembler admits bed-local');
  assert(ad.assembler.note.includes('BATCH'), 'and says this is batch, not the product stream');
  assert(ad.assembler.note.includes('TokenAccumulator'), 'and names the product class it does not run');
  const p = await ad.probe();
  assert(p.ready === true, 'probe is ready when a key is supplied — it does not call the network');
}

{
  const calls = [];
  const ad = openrouterSttAdapter({
    apiKey: 'test-openrouter-key-not-a-vendor-prefix',
    model: 'openai/whisper-large-v3-turbo',
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, hasAuth: String(init.headers.Authorization ?? '').startsWith('Bearer ') });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: '明天三点开会' }),
      };
    },
  });
  const r = await ad.transcribe(pcm, { id: '1', fmt: { sampleRate: 16_000 } });
  assert(r.completed === true, 'HTTP 200 with text is a completed session');
  assert(r.text === '明天三点开会', 'text is the vendor field, not a fabricated echo');
  assert(calls.length === 1 && calls[0].url === OPENROUTER_STT_URL, `posted to ${OPENROUTER_STT_URL}`);
  assert(calls[0].hasAuth, 'Authorization is a Bearer token (value not asserted)');
}

{
  const ad = openrouterSttAdapter({
    apiKey: 'test-openrouter-key-not-a-vendor-prefix',
    fetch: async () => ({
      ok: false,
      status: 429,
      text: async () => '{"error":{"message":"rate limited"}}',
    }),
  });
  const r = await ad.transcribe(pcm, { id: '1', fmt: { sampleRate: 16_000 } });
  assert(r.completed === false, 'HTTP 429 is VOID, not recall 0');
  assert(typeof r.incompleteWhy === 'string' && r.incompleteWhy.includes('429'), `why names the status: ${r.incompleteWhy}`);
  assert(r.text === '', 'partial text stays empty on a refused request');
}

{
  const ad = openrouterSttAdapter({
    apiKey: 'test-openrouter-key-not-a-vendor-prefix',
    timeoutMs: 20,
    fetch: async (_url, init) => {
      await new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    },
  });
  const r = await ad.transcribe(pcm, { id: '1', fmt: { sampleRate: 16_000 } });
  assert(r.completed === false, 'an abort is VOID');
  assert(typeof r.incompleteWhy === 'string' && /TIMEOUT|abort|fetch failed/i.test(r.incompleteWhy), `why is a timeout/abort: ${r.incompleteWhy}`);
}

assert(OPENROUTER_DEFAULT_STT.includes('whisper'), 'default STT slug is the known cheap whisper turbo, not a random catalog [0]');

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nPASS');
process.exit(0);
