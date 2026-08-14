// SPEC-REF:
//   docs/strategy/spikes/sherpa-onnx-spike.md §3 (model dual-source URL / size / checksum),
//     §6.3 (downloader: on-demand, multi-source failover, SHA-256, resumable
//     download; app data directory %APPDATA%/FlowMic/models/)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (engine #7 sherpa-local)
//
// Static manifest + install-dir resolution for the built-in SenseVoice-small
// int8 model. All sizes / the pinned model SHA-256 are the spike's own locally-measured values
// (verified against the HF official git-lfs hash). LAN/model URLs are R&D config,
// not secrets (CLAUDE.md).

import { homedir } from 'node:os';
import { join } from 'node:path';

/** k2-fsa pre-exported SenseVoice model repo id. */
export const SHERPA_REPO = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';

export interface ModelFile {
  /** repo-relative path (also the on-disk relative path). */
  path: string;
  /** authoritative byte length (size gate). */
  size?: number;
  /** pinned SHA-256 (fail-loud gate) — only the LFS model file is pinned. */
  sha256?: string;
}

/** Files the built-in engine needs to load a recognizer (spike §3.1). */
export const SHERPA_MODEL_FILES: readonly ModelFile[] = [
  {
    path: 'model.int8.onnx',
    size: 239_233_841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
  },
  { path: 'tokens.txt', size: 315_894 },
];

export interface ModelSource {
  name: string;
  /** base URL; the file's repo-relative path is appended. */
  base: string;
}

/** Ordered per-file sources: HF (canonical) → hf-mirror (CN). ModelScope has no
 *  drop-in sherpa ONNX (spike §3.3). GitHub is the archive fallback below. */
export const SHERPA_PER_FILE_SOURCES: readonly ModelSource[] = [
  { name: 'huggingface', base: `https://huggingface.co/csukuangfj/${SHERPA_REPO}/resolve/main` },
  { name: 'hf-mirror', base: `https://hf-mirror.com/csukuangfj/${SHERPA_REPO}/resolve/main` },
];

/** Third source (spike §3.2): the GitHub asr-models release int8 tarball. Used
 *  as a whole-archive failover when per-file sources are unreachable. */
export const SHERPA_GITHUB_TARBALL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/' +
  'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2';

/**
 * Resolve the model install directory. `FLOWMIC_SHERPA_MODEL_DIR` overrides
 * (used by the re-runnable measure/transcribe scripts to reuse the spike's
 * already-downloaded 228 MB model). Otherwise the per-user app data dir
 * (%APPDATA%/FlowMic/models on Windows, ~/.local/share/FlowMic/models elsewhere)
 * plus the repo subdir (spike §6.3).
 */
export function resolveSherpaModelDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FLOWMIC_SHERPA_MODEL_DIR;
  if (override && override.length > 0) return override;
  const appData = process.platform === 'win32'
    ? (env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
    : (env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
  return join(appData, 'FlowMic', 'models', SHERPA_REPO);
}
