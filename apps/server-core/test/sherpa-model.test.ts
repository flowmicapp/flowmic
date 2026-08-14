// WP-R1-3 sherpa built-in engine unit tests (no native addon / no network):
// the model manifest + integrity gate + the fail-loud path when the model is
// absent and auto-download is disabled (no silent failure). The real transcription is
// exercised by scripts/smoke-sherpa-local.mjs against the spike model.

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SHERPA_MODEL_FILES, SHERPA_REPO, resolveSherpaModelDir,
} from '../src/stt/sherpa/model-manifest';
import { ensureSherpaModel, isFileValid, isModelComplete } from '../src/stt/sherpa/model-downloader';
import { SherpaLocalEngine, sherpaAutoDownloadEnabled } from '../src/stt/engines/sherpa-local';
import { SttEngineError } from '../src/stt/engines/base';

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe('sherpa model manifest', () => {
  it('pins the SenseVoice int8 SHA-256 + repo id (spike §3)', () => {
    const model = SHERPA_MODEL_FILES.find((f) => f.path === 'model.int8.onnx');
    expect(model?.size).toBe(239_233_841);
    expect(model?.sha256).toBe('c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51');
    expect(SHERPA_REPO).toBe('sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17');
  });

  it('resolveSherpaModelDir honours FLOWMIC_SHERPA_MODEL_DIR', () => {
    setEnv('FLOWMIC_SHERPA_MODEL_DIR', 'D:/custom/models');
    expect(resolveSherpaModelDir()).toBe('D:/custom/models');
    setEnv('FLOWMIC_SHERPA_MODEL_DIR', undefined);
    expect(resolveSherpaModelDir()).toContain(SHERPA_REPO);
  });
});

describe('sherpa integrity gate', () => {
  it('isFileValid enforces the size gate; isModelComplete false for an empty dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmic-sherpa-'));
    const tokens = join(dir, 'tokens.txt');
    writeFileSync(tokens, Buffer.alloc(315_894)); // correct size, no sha pinned → valid
    expect(await isFileValid(tokens, { path: 'tokens.txt', size: 315_894 })).toBe(true);
    writeFileSync(tokens, Buffer.alloc(10)); // wrong size → invalid
    expect(await isFileValid(tokens, { path: 'tokens.txt', size: 315_894 })).toBe(false);
    expect(await isModelComplete(dir)).toBe(false); // model.int8.onnx absent
  });
});

describe('SherpaLocalEngine — fail-loud when model absent', () => {
  it('open() throws a non-network SttEngineError with auto-download disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmic-sherpa-empty-'));
    mkdirSync(dir, { recursive: true });
    setEnv('FLOWMIC_SHERPA_MODEL_DIR', dir);
    setEnv('FLOWMIC_SHERPA_AUTO_DOWNLOAD', 'false');
    const engine = new SherpaLocalEngine({ id: 'sherpa-local', language: 'zh', sample_rate: 16_000 });
    await expect(engine.open()).rejects.toBeInstanceOf(SttEngineError);
    await engine.open().catch((err: SttEngineError) => {
      expect(err.code).toBe('STT_CONFIG_MISSING'); // model missing, not a network drop
      expect(err.retryable).toBe(false);
    });
  });

  // 🔴 Owner ruling 2026-08-09 (DISC-2): download is OPT-IN. The DEFAULT — env
  // unset, nobody decided anything — must refuse loudly, never fetch. This test
  // would have been RED on every build shipped before the ruling (autoDownload
  // used to default ON), which is exactly the flip it pins.
  it('open() with NO env set refuses loudly instead of downloading (the shipped default)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmic-sherpa-default-'));
    mkdirSync(dir, { recursive: true });
    setEnv('FLOWMIC_SHERPA_MODEL_DIR', dir);
    setEnv('FLOWMIC_SHERPA_AUTO_DOWNLOAD', undefined);
    const engine = new SherpaLocalEngine({ id: 'sherpa-local', language: 'zh', sample_rate: 16_000 });
    await engine.open().then(
      () => { throw new Error('open() must not succeed with no model on disk'); },
      (err: SttEngineError) => {
        expect(err).toBeInstanceOf(SttEngineError);
        expect(err.code).toBe('STT_CONFIG_MISSING'); // refused, not a network attempt
        expect(err.message).toContain('auto-download is off');
        expect(err.message).toContain('FLOWMIC_SHERPA_AUTO_DOWNLOAD=1'); // actionable, both exits named
      },
    );
  });

  it('the opt-in parse is strict: only "1"/"true" download, everything else stays off', () => {
    expect(sherpaAutoDownloadEnabled(undefined)).toBe(false); // the shipped default
    expect(sherpaAutoDownloadEnabled('')).toBe(false);
    expect(sherpaAutoDownloadEnabled('false')).toBe(false);
    expect(sherpaAutoDownloadEnabled('0')).toBe(false);
    expect(sherpaAutoDownloadEnabled('yes')).toBe(false); // a typo must not fetch 228 MB
    expect(sherpaAutoDownloadEnabled('TRUE')).toBe(false); // strict, same idiom as managed-default.ts
    expect(sherpaAutoDownloadEnabled('1')).toBe(true);
    expect(sherpaAutoDownloadEnabled('true')).toBe(true);
  });

  // Defense in depth: the LIBRARY is fail-closed too. A future caller that
  // forgets the option gets the refusal, not a silent fetch — without this, the
  // env parse above would be the only thing standing between a fresh install
  // and huggingface.
  it('ensureSherpaModel with no autoDownload option refuses on an incomplete dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmic-sherpa-lib-default-'));
    mkdirSync(dir, { recursive: true });
    await expect(ensureSherpaModel(dir, {})).rejects.toThrow(/auto-download is off/);
  });
});
