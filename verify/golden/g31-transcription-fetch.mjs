// G31 asks who pays and whether the key's quota stops admission. Its fake
// transcription vendor answers in the relay's own microtask queue, so a loaded
// machine cannot race the HTTP fixture against the engine flush deadline.
// All other fetches use the real fetch, including account and billing traffic.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  if (String(input) === 'http://g31-transcription.invalid/v1/audio/transcriptions') {
    const file = options?.body?.get?.('file');
    if (options?.method !== 'POST' || !(file instanceof Blob) || file.size <= 44) {
      throw new Error('G31 transcription fixture received no WAV audio');
    }
    return Response.json({ text: 'golden transcript' });
  }
  return realFetch(input, options);
};
