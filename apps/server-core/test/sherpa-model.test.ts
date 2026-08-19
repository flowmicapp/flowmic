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
import { ensureSherpaModel, SherpaModelNotReadyError, speakTimeRefusal } from '../src/stt/sherpa/model-downloader';
import { isFileValid, isModelComplete } from '../src/stt/sherpa/model-fetch';
import { declaredTotalBytes } from '../src/stt/sherpa/model-status';
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
        // What the sentence must and must not contain is pinned in its own
        // describe below — the two assertions that used to sit here demanded an
        // environment variable in the text a speaker reads.
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
    await expect(ensureSherpaModel(dir, {})).rejects.toBeInstanceOf(SherpaModelNotReadyError);
  });
});

// ── the sentence a person reads while holding the microphone button ──────────
//
// 🔴 THIS SUITE USED TO ASSERT THE OPPOSITE, and the change is the point. Until
// 2026-08-19 two cases above pinned `err.message` containing 'auto-download is
// off' and 'FLOWMIC_SHERPA_AUTO_DOWNLOAD=1' — a developer sentence with a
// filesystem path and an environment variable in it, shown to somebody who had
// just spoken into a phone. The design (§5-C) moved those coordinates into the
// diagnostics and put the ACTION in the sentence. The old assertions are gone
// rather than relaxed: a test that still accepted the env var in user-facing
// text would be a standing invitation to put it back.
describe('the speak-time refusal says something a user can do', () => {
  it('names the action, and carries no path and no environment variable', () => {
    const text = speakTimeRefusal();
    expect(text).toMatch(/Settings/);
    expect(text).toMatch(/different speech engine/); // §2-5's second exit
    expect(text).not.toMatch(/FLOWMIC_/); // §5-D: no env var in the prose
    expect(text).not.toMatch(/[A-Za-z]:\\|\/home\/|AppData/); // §5-C: no path in the prose
    // §5-D: the size comes from the manifest, never written down. Asserted as a
    // COMPUTED value so the day the manifest changes this test moves with it
    // instead of pinning a stale number into the product's copy.
    // 🔴 THE DIVISOR IS 1024², AND IT WAS 1e6 UNTIL 2026-08-19. Same bytes,
    // two answers: 228 here, 240 decimal. The desktop's model card renders the
    // same figure with 1024² (apps/desktop/src/lib/model-status.ts `formatMb`,
    // which argues the choice: Explorer and `du -sh` both show 228/229, so it
    // is the number the user can check against). Shipping both divisors would
    // have told a user "about 240 MB" in the refusal and "about 228 MB" in
    // Settings — one file, two sizes. This test is what would have caught a
    // later drift back, so it moves WITH the product rather than pinning the
    // old arithmetic.
    const expected = Math.round((declaredTotalBytes() ?? 0) / (1024 * 1024));
    expect(text).toContain(`${expected} MB`);
  });

  it('still classifies as STT_CONFIG_MISSING, not as a retryable network drop', async () => {
    // 🔴 WHY THIS IS PINNED. `sherpa-local.ts` chooses the STT error code by
    // running /HTTP|fetch|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|tarball/i over the
    // message. The refusal is not a network event and must never be reported as
    // one — a `STT_NETWORK_DROP` is retryable:true, so the orchestrator would
    // start a reconnect ladder against a model that is simply not on disk. One
    // reworded sentence containing the word "fetch" would do it, and nothing
    // else in the tree would notice.
    const dir = mkdtempSync(join(tmpdir(), 'flowmic-sherpa-code-'));
    mkdirSync(dir, { recursive: true });
    setEnv('FLOWMIC_SHERPA_MODEL_DIR', dir);
    setEnv('FLOWMIC_SHERPA_AUTO_DOWNLOAD', undefined);
    const engine = new SherpaLocalEngine({ id: 'sherpa-local', language: 'zh', sample_rate: 16_000 });
    await engine.open().then(
      () => { throw new Error('open() must not succeed with no model on disk'); },
      (err: SttEngineError) => {
        expect(err.code).toBe('STT_CONFIG_MISSING');
        expect(err.retryable).toBe(false);
      },
    );
  });
});
