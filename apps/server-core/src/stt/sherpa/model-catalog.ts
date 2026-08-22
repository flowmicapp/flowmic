// SPEC-REF:
//   docs/strategy/2026-08-22-per-language-stt-model-catalog-task.md (LM-CAT)
//     §3 (product rules: per-spoken-language index, tiers, license classes as
//     DATA, streaming as its own column), §4 (this contract: field names are
//     pinned by test), §8 (the seed table)
//   docs/strategy/2026-08-13-w4-local-stt-model-recommendation-ssot.md §1
//     (B1–B6: we do not host weights, we do not auto-download, engine licence
//     ≠ weight licence)
//   CLAUDE.md red line: 一个值只回答一个问题 / one value answers one question
//
// THE CATALOG: one data structure answering, per spoken language, "which local
// STT model packs can be downloaded, what loader opens each, how big it is,
// which licence class it carries, and whether it is offline / quasi / true
// streaming". The download mechanics (model-fetch.ts), the single-flight
// controller (model-downloader.ts) and the language→ready-model resolution
// (model-resolve.ts) all read THIS table; none of them keeps its own copy of
// any row fact.
//
// ── EVERY ROW BELOW WAS VERIFIED AGAINST ITS REAL SOURCE ────────────────────
// (2026-08-22, dev-pc-a): file lists and byte sizes come from the
// HuggingFace tree API of the named repo, or — for tarball-only rows — from
// the k2-fsa/sherpa-onnx `asr-models` GitHub release asset list plus the
// sherpa-onnx docs' directory listings. Sizes are the upstream's declared
// values; SHA-256 pins are added ONLY after a local download of the actual
// bytes (the SenseVoice pin predates this file; new pins carry their own
// dates). Licence classes were checked against each upstream model page.
//
// ── WHAT IS DELIBERATELY NOT IN THE TABLE ───────────────────────────────────
// · Kroko ASR models (CC-BY-SA — copyleft, excluded by task §8) and
//   Fun-ASR-Nano (task §8 exclusion). Rows for them must not be added.
// · The 2026-02-27 Moonshine packs (moonshine-{tiny,base}-{zh,es,ja,ko,…}-
//   quantized-2026-02-27). The task's seed table lists them as `lite` rows,
//   but their published layout is TWO `.ort` files (encoder_model.ort +
//   decoder_model_merged.ort) — verified against the csukuangfj2 HF repos —
//   while sherpa-onnx-node 1.13.4's OfflineMoonshineModelConfig loads FOUR
//   files (preprocessor / encoder / uncachedDecoder / cachedDecoder). A row
//   this runtime cannot open would be a download button wired to a loader
//   that throws; the older 4-file moonshine-tiny-en-int8 IS loadable and is
//   the `en` lite row. Languages whose only lite candidate was a 2026 pack
//   have no lite row, which task §8 explicitly allows (「可空」).
//
// ── ACCURACY IS NOT CLAIMED HERE ────────────────────────────────────────────
// `spoken` is what the model's own card claims, not what we measured. The
// multilingual benchmark is a sealed post-open-source task (decision
// 2026-08-14); nothing in this file grades one row against another.

import type { ModelFile, ModelSource } from './model-manifest-types';

/**
 * How the recognizer opens a pack — the switch key of
 * `loader-config.ts`. A CLOSED SET with an exhaustiveness check there.
 *
 * `canary` is not in task §5's table (which lists nemo-ctc / nemo-transducer),
 * but the task's own §8 seeds Canary-180m rows and NVIDIA Canary is its own
 * config family in sherpa-onnx-node (encoder/decoder + srcLang/tgtLang), not a
 * NeMo CTC — folding it into `nemo-ctc` would build a config the addon
 * rejects. Registered in the LM-CAT delivery report.
 *
 * `streaming-transducer` rows may EXIST but can neither be downloaded nor
 * loaded in this phase (task §1 / §5: OnlineRecognizer is phase D) — both
 * doors refuse BY NAME, they do not pretend an OfflineRecognizer can eat a
 * streaming pack.
 */
export type LoaderKind =
  | 'senseVoice'
  | 'whisper'
  | 'offline-transducer'
  | 'nemo-ctc'
  | 'nemo-transducer'
  | 'canary'
  | 'moonshine'
  | 'streaming-transducer';

/**
 * Task §3-6: the licence tier is DATA the interface renders from, never a
 * copy-writer's adjective. `excluded` (CC-BY-SA / commercial-key / NC) is not
 * a value — excluded models are not rows.
 */
export type LicenseClass = 'osi' | 'cc-by' | 'funasr-model';

export type CatalogTier = 'lite' | 'recommended' | 'multilingual';

/** Task §3-7: latency behaviour is its own column, never folded into the
 *  licence or the tier. `quasi` = SenseVoice + the existing tail-re-decode
 *  preview; `offline` = text appears when the button is released. */
export type StreamingKind = 'offline' | 'quasi' | 'streaming';

/** Which slot of the loader config a file fills. `model`/`tokens` for
 *  single-file models; the rest name the multi-file layouts. Files with no
 *  role (spm/bpe extras) are downloaded and verified but not wired. */
export type ModelFileRole =
  | 'model'
  | 'encoder'
  | 'decoder'
  | 'joiner'
  | 'tokens'
  | 'preprocessor'
  | 'uncached-decoder'
  | 'cached-decoder';

export interface CatalogModelFile extends ModelFile {
  role?: ModelFileRole;
}

export interface CatalogModel {
  /** Catalog primary key AND the on-disk subdirectory name under the models
   *  root. Matches the upstream repo/tarball name so a user placing files by
   *  hand can search for exactly this string. */
  model_id: string;
  /** The spoken-language tags this pack CLAIMS to recognise — the phone's
   *  `kSpokenLangs` bare codes. (`yue` appears once, on the SenseVoice row:
   *  not a phone-offered value, but the model card claims it and the previous
   *  gate accepted it — removing it would break a working hand-config.) */
  spoken: readonly string[];
  tier: CatalogTier;
  loader: LoaderKind;
  license_class: LicenseClass;
  /** e.g. 'MIT' / 'Apache-2.0' / 'CC-BY-4.0' / 'FunASR-Model-1.1'. */
  license_spdx_or_name: string;
  /** Shown verbatim on the settings card — who made this and under what. */
  attribution: string;
  streaming: StreamingKind;
  /** Size + (once locally verified) SHA-256 gates — same semantics as the
   *  original SenseVoice manifest. Empty ONLY on streaming rows, which can
   *  never reach the integrity gate in this phase. */
  files: readonly CatalogModelFile[];
  /** Ordered per-file failover sources. May be empty: tarball-only rows go
   *  straight to the archive fallback (model-fetch emits per-file-exhausted
   *  with 'no per-file source is configured', which is exactly true). */
  sources: readonly ModelSource[];
  /** Whole-archive fallback: the k2-fsa GitHub release tarball and the root
   *  directory it extracts into (they differ on the SenseVoice int8 pack). */
  tarball?: { url: string; root: string };
}

const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

/** HF (canonical) → hf-mirror (CN) per-file sources for a repo. Only repos
 *  owned by the sherpa-onnx author's accounts (csukuangfj / k2-fsa) are used
 *  as per-file sources; third-party mirrors of the same artefacts are not,
 *  because a mirror owner can change bytes under a stable URL. Models with no
 *  trusted per-file repo are tarball-only. */
function hf(owner: string, repo: string): ModelSource[] {
  return [
    { name: 'huggingface', base: `https://huggingface.co/${owner}/${repo}/resolve/main` },
    { name: 'hf-mirror', base: `https://hf-mirror.com/${owner}/${repo}/resolve/main` },
  ];
}

/**
 * The eight spoken-language catalog keys — the bare codes of the phone's
 * `kSpokenLangs` (apps/mobile/lib/src/settings/app_settings.dart). The server
 * cannot import Dart, so this is a MIRROR maintained by hand and pinned by
 * `model-catalog.test.ts`; task LM-CAT forbids editing `kSpokenLangs` itself.
 * zh-TW is NOT a key (task §3-1): it is a script variant that shares the `zh`
 * acoustic model, and only the desktop UI knows the alias.
 */
export const CATALOG_SPOKEN_LANGS: readonly string[] = [
  'en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru',
];

/** The one FunASR-licensed row's id — also the legacy `SHERPA_REPO`. Named so
 *  the derivations in model-manifest.ts read as what they are: aliases of this
 *  row, not a second registry. */
export const SENSE_VOICE_MODEL_ID = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';

export const MODEL_CATALOG: readonly CatalogModel[] = [
  // ── zh / en / ja / ko — SenseVoice stays, honestly labelled (task §3-4) ───
  {
    model_id: SENSE_VOICE_MODEL_ID,
    // `yue` kept — see the field note on [CatalogModel.spoken].
    spoken: ['zh', 'en', 'ja', 'ko', 'yue'],
    tier: 'recommended',
    loader: 'senseVoice',
    // 🔴 NOT open source and never described as such (task §1 / NOTICE §4):
    // the FunASR Model License is its own licence class and the UI renders
    // this class, never the word "Apache".
    license_class: 'funasr-model',
    license_spdx_or_name: 'FunASR-Model-1.1',
    attribution: 'SenseVoice-small (FunASR, Alibaba) — FunASR Model License v1.1',
    streaming: 'quasi',
    files: [
      {
        path: 'model.int8.onnx',
        size: 239_233_841,
        // The spike-era pin; the LM-CAT verification download (2026-08-22,
        // dev-pc-a) re-measured the same digest byte for byte.
        sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
        role: 'model',
      },
      {
        path: 'tokens.txt',
        size: 315_894,
        sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
        role: 'tokens',
      },
    ],
    sources: hf('csukuangfj', SENSE_VOICE_MODEL_ID),
    tarball: {
      url: `${GH}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`,
      root: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
    },
  },
  {
    model_id: 'sherpa-onnx-zipformer-zh-en-2023-11-22',
    spoken: ['zh', 'en'],
    tier: 'recommended',
    loader: 'offline-transducer',
    license_class: 'osi',
    license_spdx_or_name: 'Apache-2.0',
    attribution: 'Zipformer zh-en (k2-fsa/icefall) — Apache-2.0',
    streaming: 'offline',
    // Tarball-only: no trusted per-file repo exists (checked 2026-08-22 —
    // csukuangfj/... 404s and HF search finds no owner we trust). fp32
    // members (this pack ships no int8 export of these names). Sizes and
    // SHA-256 measured locally from the official release tarball, and the
    // pack was loaded + decoded with sherpa-onnx-node 1.13.4 before pinning
    // (LM-CAT verification pass, 2026-08-22, dev-pc-a).
    files: [
      { path: 'encoder-epoch-34-avg-19.onnx', size: 260_000_054, sha256: '144f2b5514820caaf1effd6596a579dbb12a03fdf9a7c40026b4301b210eb0e7', role: 'encoder' },
      { path: 'decoder-epoch-34-avg-19.onnx', size: 5_165_101, sha256: '110dc19143f0731ce0f64513e524d7d8f729e37107e1392da790f66d6c936a0b', role: 'decoder' },
      { path: 'joiner-epoch-34-avg-19.onnx', size: 4_104_454, sha256: '7079ff210a5060a427f912d27efc2b0ad778ccce640ba4c5656e40668f6aa0b6', role: 'joiner' },
      { path: 'tokens.txt', size: 25_645, sha256: '2d5d6245197582cea396b23fa29d592705be31bac9a97bb74a8d1bca3ca6a0e0', role: 'tokens' },
    ],
    sources: [],
    tarball: {
      url: `${GH}/sherpa-onnx-zipformer-zh-en-2023-11-22.tar.bz2`,
      root: 'sherpa-onnx-zipformer-zh-en-2023-11-22',
    },
  },
  {
    model_id: 'sherpa-onnx-zipformer-en-2023-06-26',
    spoken: ['en'],
    tier: 'recommended',
    loader: 'offline-transducer',
    license_class: 'osi',
    license_spdx_or_name: 'Apache-2.0',
    attribution: 'Zipformer en (k2-fsa/icefall) — Apache-2.0',
    streaming: 'offline',
    files: [
      { path: 'encoder-epoch-99-avg-1.int8.onnx', size: 68_778_564, sha256: '52a48f46c17b19a36fe3927c4d59479bb16eeb2493313ed82c4bf775c2cb8bc8', role: 'encoder' },
      { path: 'decoder-epoch-99-avg-1.int8.onnx', size: 1_307_236, sha256: '783cd6b23b8db8e14a43804ecf972ae96e71499cce799e334ab95c961800d797', role: 'decoder' },
      { path: 'joiner-epoch-99-avg-1.int8.onnx', size: 259_335, sha256: '48de5d6467a2ab1e72cb5c4d828330be06524d877bc458118b6a4198ca031357', role: 'joiner' },
      { path: 'tokens.txt', size: 5_048, sha256: '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb', role: 'tokens' },
    ],
    sources: hf('csukuangfj', 'sherpa-onnx-zipformer-en-2023-06-26'),
    tarball: {
      url: `${GH}/sherpa-onnx-zipformer-en-2023-06-26.tar.bz2`,
      root: 'sherpa-onnx-zipformer-en-2023-06-26',
    },
  },
  {
    model_id: 'sherpa-onnx-moonshine-tiny-en-int8',
    spoken: ['en'],
    tier: 'lite',
    loader: 'moonshine',
    license_class: 'osi',
    license_spdx_or_name: 'MIT',
    attribution: 'Moonshine tiny (Useful Sensors) — MIT',
    streaming: 'offline',
    files: [
      { path: 'preprocess.onnx', size: 6_800_738, sha256: 'f33addce61a143460fe753b5ee5b7db255e5140b5b779c065b94f6c83ff0bf4e', role: 'preprocessor' },
      { path: 'encode.int8.onnx', size: 18_249_187, sha256: '8774dfba578de027ec6595c2c654a0836434489bc963a0db124a7f181f571acb', role: 'encoder' },
      { path: 'uncached_decode.int8.onnx', size: 53_216_096, sha256: '216737000dd5881a17aa043f6bbd286add33e4c3b0ae257153e2ec15438bdc41', role: 'uncached-decoder' },
      { path: 'cached_decode.int8.onnx', size: 45_264_830, sha256: '2aff28bba6a03d8dcf5c9feac45462629bae37317442299f28115ad09da773f6', role: 'cached-decoder' },
      { path: 'tokens.txt', size: 436_688, sha256: '1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea', role: 'tokens' },
    ],
    sources: hf('csukuangfj', 'sherpa-onnx-moonshine-tiny-en-int8'),
    tarball: {
      url: `${GH}/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2`,
      root: 'sherpa-onnx-moonshine-tiny-en-int8',
    },
  },
  // ── the one pack that serves every spoken language (task §3-5) ────────────
  {
    model_id: 'sherpa-onnx-whisper-turbo',
    spoken: ['en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru'],
    tier: 'multilingual',
    loader: 'whisper',
    license_class: 'osi',
    license_spdx_or_name: 'MIT',
    attribution: 'Whisper large-v3-turbo (OpenAI) — MIT',
    streaming: 'offline',
    files: [
      { path: 'turbo-encoder.int8.onnx', size: 674_716_297, sha256: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b', role: 'encoder' },
      { path: 'turbo-decoder.int8.onnx', size: 361_080_764, sha256: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547', role: 'decoder' },
      { path: 'turbo-tokens.txt', size: 816_730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126', role: 'tokens' },
    ],
    sources: hf('csukuangfj', 'sherpa-onnx-whisper-turbo'),
    tarball: { url: `${GH}/sherpa-onnx-whisper-turbo.tar.bz2`, root: 'sherpa-onnx-whisper-turbo' },
  },
  {
    model_id: 'sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8',
    spoken: ['en', 'es', 'de', 'fr'],
    tier: 'multilingual',
    loader: 'canary',
    license_class: 'cc-by',
    license_spdx_or_name: 'CC-BY-4.0',
    attribution: 'Canary 180M flash (NVIDIA NeMo) — CC-BY-4.0',
    streaming: 'offline',
    files: [
      { path: 'encoder.int8.onnx', size: 132_678_643, sha256: '7a75b4e2a5857a6dcc0819503bbe3fad66943db4a3ccf21d3f27c633667d303f', role: 'encoder' },
      { path: 'decoder.int8.onnx', size: 74_437_848, sha256: 'e41a2ab9c0c2fe81a1e8ade5a45fb02a74bc4db7d1f91b89a54a25e2cf79cba2', role: 'decoder' },
      { path: 'tokens.txt', size: 53_555, sha256: '2dae6fc7815f9640645e0c765522b278ee0cef49b482d91f6913e334628d3e77', role: 'tokens' },
    ],
    sources: hf('csukuangfj', 'sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8'),
    tarball: {
      url: `${GH}/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2`,
      root: 'sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8',
    },
  },
  // ── es / de dedicated packs (CC-BY) ───────────────────────────────────────
  {
    model_id: 'sherpa-onnx-nemo-fast-conformer-ctc-es-1424-int8',
    spoken: ['es'],
    tier: 'recommended',
    loader: 'nemo-ctc',
    license_class: 'cc-by',
    license_spdx_or_name: 'CC-BY-4.0',
    attribution: 'FastConformer CTC es (NVIDIA NeMo) — CC-BY-4.0',
    streaming: 'offline',
    files: [
      { path: 'model.int8.onnx', size: 131_652_445, sha256: '9539b206ba7cb46231e24eb1f1d7269370bfd45209c549d70e2bfd0e9f3b021a', role: 'model' },
      { path: 'tokens.txt', size: 10_871, sha256: '6191b4853e3654f053c42f6fd184ca53b402987aefdd6ff6baa68034d803ee85', role: 'tokens' },
    ],
    sources: hf('csukuangfj', 'sherpa-onnx-nemo-fast-conformer-ctc-es-1424-int8'),
    tarball: {
      url: `${GH}/sherpa-onnx-nemo-fast-conformer-ctc-es-1424-int8.tar.bz2`,
      root: 'sherpa-onnx-nemo-fast-conformer-ctc-es-1424-int8',
    },
  },
  {
    model_id: 'sherpa-onnx-nemo-stt_de_fastconformer_hybrid_large_pc-int8',
    spoken: ['de'],
    tier: 'recommended',
    loader: 'nemo-ctc',
    license_class: 'cc-by',
    license_spdx_or_name: 'CC-BY-4.0',
    attribution: 'FastConformer hybrid de (NVIDIA NeMo) — CC-BY-4.0',
    streaming: 'offline',
    files: [
      { path: 'model.int8.onnx', size: 131_652_945, sha256: 'fcf42d4fd55b42b0b11fed368b04467f0a636a52f44bcacd3f4667697c26e259', role: 'model' },
      { path: 'tokens.txt', size: 10_686, sha256: 'abb1136142604d6d1766ad5060bd4f4b1048d7a096cd094b2d40eec3e666be9f', role: 'tokens' },
    ],
    sources: hf('csukuangfj', 'sherpa-onnx-nemo-stt_de_fastconformer_hybrid_large_pc-int8'),
    tarball: {
      url: `${GH}/sherpa-onnx-nemo-stt_de_fastconformer_hybrid_large_pc-int8.tar.bz2`,
      root: 'sherpa-onnx-nemo-stt_de_fastconformer_hybrid_large_pc-int8',
    },
  },
  // ── ja / ko dedicated packs (Apache) ──────────────────────────────────────
  {
    model_id: 'sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01',
    spoken: ['ja'],
    tier: 'recommended',
    loader: 'offline-transducer',
    license_class: 'osi',
    license_spdx_or_name: 'Apache-2.0',
    attribution: 'Zipformer ja, ReazonSpeech (k2-fsa/icefall) — Apache-2.0',
    streaming: 'offline',
    // Tarball-only: the only HF copy is a third-party mirror (not a source we
    // dial). Sizes and SHA-256 measured locally from the official release
    // tarball; loaded + decoded with sherpa-onnx-node 1.13.4 before pinning
    // (LM-CAT verification pass, 2026-08-22, dev-pc-a).
    files: [
      { path: 'encoder-epoch-99-avg-1.int8.onnx', size: 154_670_139, sha256: '2c7bd08a8a99f9ddd0d9e458456577b1f6279214e51426f114f9eced44c54e1d', role: 'encoder' },
      { path: 'decoder-epoch-99-avg-1.onnx', size: 11_767_836, sha256: '58b18211ae06265466bfa17172dab574df94f76c8bcb61a3640c28ba860e4124', role: 'decoder' },
      { path: 'joiner-epoch-99-avg-1.onnx', size: 10_720_115, sha256: 'd38a81d1191c9ed6de6a1719503692e07e3e973e2364adde0abae5eaaded1174', role: 'joiner' },
      { path: 'tokens.txt', size: 45_754, sha256: '2c3ac659818a48a0c04010e0593bbc4d7c8a24a054340b01131499c05fd52def', role: 'tokens' },
    ],
    sources: [],
    tarball: {
      url: `${GH}/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01.tar.bz2`,
      root: 'sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01',
    },
  },
  {
    model_id: 'sherpa-onnx-zipformer-korean-2024-06-24',
    spoken: ['ko'],
    tier: 'recommended',
    loader: 'offline-transducer',
    license_class: 'osi',
    license_spdx_or_name: 'Apache-2.0',
    attribution: 'Zipformer ko (k2-fsa/icefall) — Apache-2.0',
    streaming: 'offline',
    files: [
      { path: 'encoder-epoch-99-avg-1.int8.onnx', size: 70_784_728, sha256: '8b196d723421a0513c98ec25da2c43420c029e817f5e4a90b29ff80291c0af2b', role: 'encoder' },
      { path: 'decoder-epoch-99-avg-1.int8.onnx', size: 2_844_692, sha256: '2cc8c04ea080a657c18ebc59702e6b049cef08163eba5d68ac5bf707925cb0fb', role: 'decoder' },
      { path: 'joiner-epoch-99-avg-1.int8.onnx', size: 2_581_421, sha256: 'eb654db1ea2cc9d63474855f65958b6059084692a9f2eb4f3812aceb1e416a20', role: 'joiner' },
      { path: 'tokens.txt', size: 60_246, sha256: '016bdf0965029263b7ad01b742366ee542ef0bef38261510e8176ff6f2e9e668', role: 'tokens' },
    ],
    sources: hf('k2-fsa', 'sherpa-onnx-zipformer-korean-2024-06-24'),
    tarball: {
      url: `${GH}/sherpa-onnx-zipformer-korean-2024-06-24.tar.bz2`,
      root: 'sherpa-onnx-zipformer-korean-2024-06-24',
    },
  },
  // ── ru: a small pack and a strong pack (task §8) ──────────────────────────
  {
    model_id: 'sherpa-onnx-zipformer-ru-int8-2025-04-20',
    spoken: ['ru'],
    tier: 'lite',
    loader: 'offline-transducer',
    license_class: 'osi',
    license_spdx_or_name: 'Apache-2.0',
    attribution: 'Zipformer ru (k2-fsa/icefall) — Apache-2.0',
    streaming: 'offline',
    files: [
      { path: 'encoder.int8.onnx', size: 70_876_638, sha256: 'eb6c12fbad810d5bc3e427802e604604c69b5943a91feebc43424dd09d9ec407', role: 'encoder' },
      { path: 'decoder.onnx', size: 2_093_080, sha256: 'dcbe1ffa0211e77ca6d3a80164df13fbda3ec00e47d12b9f449f89572df12136', role: 'decoder' },
      { path: 'joiner.int8.onnx', size: 259_417, sha256: '93f2e1d12b78d53e7802f1606488c14bb3d764b15fadf5ef6c022f6ba1fa40f7', role: 'joiner' },
      { path: 'tokens.txt', size: 6_388, sha256: '93bbbc0bae6b78c0bbb743d4aa9fded3bb5ff3aac5f0200e3a769a5a05e0fdf6', role: 'tokens' },
    ],
    sources: hf('csukuangfj', 'sherpa-onnx-zipformer-ru-int8-2025-04-20'),
    tarball: {
      url: `${GH}/sherpa-onnx-zipformer-ru-int8-2025-04-20.tar.bz2`,
      root: 'sherpa-onnx-zipformer-ru-int8-2025-04-20',
    },
  },
  {
    model_id: 'sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19',
    spoken: ['ru'],
    tier: 'recommended',
    loader: 'nemo-ctc',
    license_class: 'osi',
    license_spdx_or_name: 'MIT',
    attribution: 'GigaAM v2 CTC ru (SberDevices) — MIT',
    streaming: 'offline',
    files: [
      { path: 'model.int8.onnx', size: 236_457_977, sha256: 'd0ce4aef25f58d495781ee8f05320d9e51b821f47804e07aa6549b53a72f67e8', role: 'model' },
      { path: 'tokens.txt', size: 196, sha256: '17cc514451bcceac9c280068c71502f8448f99e9fb1456b8d0761651fd0392f2', role: 'tokens' },
    ],
    sources: hf('csukuangfj', 'sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19'),
    tarball: {
      url: `${GH}/sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19.tar.bz2`,
      root: 'sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19',
    },
  },
  // ── fr: the dedicated pack is STREAMING — listed, and refused this phase ──
  {
    model_id: 'sherpa-onnx-streaming-zipformer-fr-2023-04-14',
    spoken: ['fr'],
    tier: 'recommended',
    loader: 'streaming-transducer',
    license_class: 'osi',
    license_spdx_or_name: 'Apache-2.0',
    attribution: 'Streaming Zipformer fr (k2-fsa/icefall) — Apache-2.0',
    streaming: 'streaming',
    // 🔴 files DELIBERATELY EMPTY, and the emptiness is guarded: an empty
    // manifest is vacuously "complete", so everything that computes readiness
    // must (and does) refuse streaming rows BEFORE the file check — a
    // streaming row can never read `ready` in this phase, because "ready"
    // promises the engine can open it and this engine cannot. Download and
    // load both refuse by name; the row exists so the interface can say the
    // pack exists and why it is not offered yet (phase D).
    files: [],
    sources: [],
    tarball: {
      url: `${GH}/sherpa-onnx-streaming-zipformer-fr-2023-04-14.tar.bz2`,
      root: 'sherpa-onnx-streaming-zipformer-fr-2023-04-14',
    },
  },
];

// ── lookups ──────────────────────────────────────────────────────────────────

const BY_ID = new Map(MODEL_CATALOG.map((m) => [m.model_id, m]));

export function catalogModelById(id: string): CatalogModel | null {
  return BY_ID.get(id) ?? null;
}

/** `'zh-CN'` → `'zh'` — the same region-strip the engine adapters use
 *  (`toShortLang` in engines/wav.ts). Empty/wildcard stays as given. */
export function baseLang(tag: string): string {
  const raw = tag.trim().toLowerCase();
  const dash = raw.indexOf('-');
  return dash === -1 ? raw : raw.slice(0, dash);
}

export function isWildcardLang(tag: string): boolean {
  const raw = tag.trim().toLowerCase();
  return raw === '' || raw === '*' || raw === 'auto';
}

/** Every catalog row claiming `language` (region-stripped), in table order. */
export function catalogRowsForLanguage(language: string): CatalogModel[] {
  const base = baseLang(language);
  return MODEL_CATALOG.filter((m) => m.spoken.includes(base));
}

/**
 * Can THIS pack recognise the requested language? Asks the row, never a
 * hardcoded language set (LM-CAT §PROMPT-3: the old five-language constant is
 * gone). Wildcards pass — "no specific language requested" is a fact about
 * the request, not about the model.
 */
export function sherpaModelCanRecognize(language: string, model: CatalogModel): boolean {
  if (isWildcardLang(language)) return true;
  return model.spoken.includes(baseLang(language));
}

/**
 * Does ANY catalog row claim this language? The engine factory's synchronous
 * gate: a language no row covers gets STT_LANGUAGE_UNSUPPORTED at construct
 * time. Whether a COVERING row is downloaded and ready is a different
 * question, answered asynchronously at open() (model-resolve.ts) — folding
 * the two would make "not downloaded yet" wear the "physically cannot"
 * sentence, and their next actions differ (download vs. give up).
 */
export function catalogCanServe(language: string): boolean {
  if (isWildcardLang(language)) return true;
  return catalogRowsForLanguage(language).length > 0;
}

/** A row this phase can actually download and open. One predicate so the
 *  download door, the load door and the resolver cannot drift apart. */
export function isLoadableThisPhase(model: CatalogModel): boolean {
  return model.loader !== 'streaming-transducer' && model.streaming !== 'streaming';
}
