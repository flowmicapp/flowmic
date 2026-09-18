// NR-50 — the local engine's TERMINAL decode runs on the libuv worker
// (`OfflineRecognizer.decodeAsync`), and everything that becomes possible once
// it yields is pinned here: the preview standing down while it runs, a second
// flush() waiting for the first, a result arriving after close() being dropped,
// and a failed decode being TERMINAL (`retryable: false`).
//
// The native addon is NOT involved: the recognizer is injected through the
// same seam `sherpa-silence-gate.test.ts` uses, and `decodeAsync` here is a
// deferred promise the test resolves by hand. What this file proves is the
// engine's CONTRACT around an asynchronous decode. What it cannot prove — that
// the real `decodeAsync` frees the event loop — is measured, not argued:
// `scripts/drills/local-engine-lifecycle-probe.mjs --decode-cost` (dev-pc-a
// 2026-09-16: SenseVoice 45 s, sync `ticks 0` / async 65 ticks, same wall).
//
// 🔴 Reverse control, actually seen red (2026-09-16, dev-pc-a): with the
// terminal decode put back on the synchronous `decodeSpan` path, the first case
// below fails `expected +0 to be 1` on the decodeAsync count and `expected 1 to
// be +0` on the sync count — i.e. the decode was back on the JS thread. Restored.

import { describe, expect, it } from 'vitest';
import type { FinalResult, InterimResult } from '../src/stt/engines/base';
import { SttEngineError } from '../src/stt/engines/base';
import { SherpaLocalEngine, type OfflineRecognizer, type OfflineStream } from '../src/stt/engines/sherpa-local';

const CHUNK_BYTES = 6_400; // 200 ms @ 16 kHz s16le

function voiced(peak = 8_000, bytes = CHUNK_BYTES): Buffer {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes / 2; i += 1) b.writeInt16LE(i % 2 === 0 ? peak : -peak, i * 2);
  return b;
}

interface Deferred { resolve: () => void; reject: (e: Error) => void }

/** A recognizer whose `decodeAsync` parks until the test releases it. The
 *  synchronous `decode` still exists (previews use it) and is counted apart. */
function makeRig(opts: { withAsync?: boolean; text?: string } = {}) {
  const withAsync = opts.withAsync ?? true;
  const text = opts.text ?? '跟你说个事啊，明天下午3点的。';
  let syncDecodes = 0;
  let asyncDecodes = 0;
  const pending: Deferred[] = [];
  const rec: OfflineRecognizer = {
    createStream: () => ({ acceptWaveform: () => {} }),
    decode: () => { syncDecodes += 1; },
    getResult: () => ({ text }),
    ...(withAsync
      ? { decodeAsync: (_s: OfflineStream) => new Promise<void>((resolve, reject) => { asyncDecodes += 1; pending.push({ resolve, reject }); }) }
      : {}),
  };
  const eng = new SherpaLocalEngine(
    { id: 'sherpa-local', language: 'zh', sample_rate: 16_000 },
    { openRecognizer: async () => rec },
  );
  const finals: FinalResult[] = [];
  const interims: InterimResult[] = [];
  const errors: SttEngineError[] = [];
  eng.on('final', (e: FinalResult) => finals.push(e));
  eng.on('interim', (e: InterimResult) => interims.push(e));
  eng.on('error', (e: SttEngineError) => errors.push(e));
  return {
    eng, finals, interims, errors,
    sync: () => syncDecodes, async: () => asyncDecodes,
    /** Release the oldest parked decode. */
    release: () => { const d = pending.shift(); if (!d) throw new Error('no decode parked'); d.resolve(); },
    fail: (msg: string) => { const d = pending.shift(); if (!d) throw new Error('no decode parked'); d.reject(new Error(msg)); },
    parked: () => pending.length,
  };
}

const tick = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

describe('NR-50 · the terminal decode is decodeAsync, and the final waits for it', () => {
  it('flush() consults decodeAsync (not the sync decode) and emits the final only once it resolves', async () => {
    const r = makeRig();
    await r.eng.open();
    r.eng.push(voiced());
    const sync0 = r.sync(); const async0 = r.async();
    const flushed = r.eng.flush();
    await tick();
    expect(r.async() - async0).toBe(1);
    expect(r.sync() - sync0).toBe(0);
    expect(r.finals).toHaveLength(0); // parked ⇒ nothing yet
    r.release();
    await flushed;
    expect(r.finals).toHaveLength(1);
    expect(r.finals[0]!.text).toBe('跟你说个事啊，明天下午3点的。');
  });

  it('an addon without decodeAsync decodes synchronously, exactly as before this card', async () => {
    const r = makeRig({ withAsync: false });
    await r.eng.open();
    r.eng.push(voiced());
    const sync0 = r.sync();
    await r.eng.flush();
    expect(r.sync() - sync0).toBe(1);
    expect(r.finals).toHaveLength(1);
  });

  it('the preview stands down while the terminal decode is in flight (positive control: it runs otherwise)', async () => {
    // Control: the same pushes on a fresh engine DO drive preview decodes.
    const c = makeRig();
    await c.eng.open();
    for (let i = 0; i < 20; i += 1) c.eng.push(voiced());
    expect(c.sync()).toBeGreaterThan(0);
    expect(c.interims.length).toBeGreaterThan(0);

    const r = makeRig();
    await r.eng.open();
    r.eng.push(voiced());
    const flushed = r.eng.flush();
    await tick();
    expect(r.parked()).toBe(1);
    const sync0 = r.sync(); const interims0 = r.interims.length;
    for (let i = 0; i < 20; i += 1) r.eng.push(voiced());
    expect(r.sync() - sync0).toBe(0);
    expect(r.interims.length - interims0).toBe(0);
    r.release();
    await flushed;
    expect(r.finals).toHaveLength(1);
  });

  it('a second flush() waits for the first; exactly one final for the one utterance', async () => {
    const r = makeRig();
    await r.eng.open();
    r.eng.push(voiced());
    const first = r.eng.flush();
    const second = r.eng.flush();
    await tick();
    expect(r.parked()).toBe(1); // the second did not start a decode of its own
    r.release();
    await Promise.all([first, second]);
    expect(r.finals).toHaveLength(1);
    expect(r.parked()).toBe(0);
  });

  it('a decode that finishes after close() is dropped: no final, no error, flush still resolves', async () => {
    const r = makeRig();
    await r.eng.open();
    r.eng.push(voiced());
    const flushed = r.eng.flush();
    await tick();
    await r.eng.close();
    r.release();
    await flushed;
    expect(r.finals).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
  });

  it('a failed decode is a TERMINAL engine error (retryable: false), never a final', async () => {
    const r = makeRig();
    await r.eng.open();
    r.eng.push(voiced());
    const flushed = r.eng.flush();
    await tick();
    r.fail('onnx session blew up');
    await flushed;
    expect(r.finals).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toBeInstanceOf(SttEngineError);
    expect(r.errors[0]!.code).toBe('STT_ENGINE_TIMEOUT');
    expect(r.errors[0]!.retryable).toBe(false);
  });

  it('declares its interims as previews — the fact raceFlushFinal keys the refusal on', async () => {
    const r = makeRig();
    expect(r.eng.interimIsPreviewOnly).toBe(true);
  });
});
