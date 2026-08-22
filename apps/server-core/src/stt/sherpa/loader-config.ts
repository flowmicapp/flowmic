// SPEC-REF:
//   docs/strategy/2026-08-22-per-language-stt-model-catalog-task.md (LM-CAT)
//     §5 (typed loading, phase A = offline kinds only; streaming rows must
//     fail LOUD AND NAMED, never be fed to an OfflineRecognizer)
//   CLAUDE.md red line: no silent failure
//
// The ONE place a catalog row becomes a sherpa-onnx-node OfflineRecognizer
// config. `sherpa-local.ts` used to inline a senseVoice-only config; that
// inline is gone and this switch is the only writer. The field names below
// are sherpa-onnx-node 1.13.4's OfflineModelConfig (read from the installed
// package's types.js, 2026-08-22): transducer{encoder,decoder,joiner} /
// nemoCtc{model} / canary{encoder,decoder,srcLang,tgtLang,usePnc} /
// whisper{encoder,decoder,language,task} / moonshine{preprocessor,encoder,
// uncachedDecoder,cachedDecoder} / senseVoice{model,language,
// useInverseTextNormalization}.

import { join } from 'node:path';
import {
  baseLang, isWildcardLang,
  type CatalogModel, type ModelFileRole,
} from './model-catalog';

/**
 * Thrown when a load is asked of a pack this phase cannot open. A NAMED type,
 * because "this pack needs the streaming loader, which this version does not
 * ship" and "the model files are broken" want opposite user actions —
 * matching a message string to tell them apart is how they get conflated the
 * first time someone rewords it.
 */
export class StreamingLoaderUnsupportedError extends Error {
  constructor(readonly modelId: string) {
    super(
      `'${modelId}' is a streaming pack and needs the streaming loader, ` +
      `which this version does not ship yet (LM-CAT phase D). It cannot be ` +
      `opened by the offline recognizer.`,
    );
    this.name = 'StreamingLoaderUnsupportedError';
  }
}

/** A required role missing from a row is a CATALOG bug, not a user problem —
 *  named so the test suite can pin that the message blames the right party. */
export class CatalogRoleMissingError extends Error {
  constructor(modelId: string, role: ModelFileRole) {
    super(`catalog row '${modelId}' declares no file with role '${role}' — the catalog row is wrong, not your download`);
    this.name = 'CatalogRoleMissingError';
  }
}

function fileByRole(model: CatalogModel, role: ModelFileRole, dir: string): string {
  const f = model.files.find((x) => x.role === role);
  if (!f) throw new CatalogRoleMissingError(model.model_id, role);
  return join(dir, f.path);
}

/**
 * Build the `modelConfig` half of an OfflineRecognizer config for one catalog
 * row installed in `dir`.
 *
 * `language` matters to two kinds only:
 *   · whisper — a concrete tag pins decoding to that language; a wildcard
 *     leaves '' and Whisper detects. (Its `language` is part of the model
 *     config, which is why sherpa-local's recognizer cache key carries the
 *     language facet for these kinds.)
 *   · canary — srcLang/tgtLang are REQUIRED and there is no auto: a wildcard
 *     request falls back to 'en', which is a documented limitation of the
 *     pack, not a guess dressed as a detection.
 */
export function offlineModelConfigFor(
  model: CatalogModel,
  dir: string,
  language: string,
  numThreads: number,
): Record<string, unknown> {
  // Phase D refusal FIRST — before any file/role lookup. A streaming row's
  // file list is deliberately empty, and letting the tokens lookup run first
  // would report "the catalog row is wrong" for a row that is exactly as
  // intended; the reader must get the named phase-D sentence.
  if (model.loader === 'streaming-transducer') {
    throw new StreamingLoaderUnsupportedError(model.model_id);
  }
  const common = {
    tokens: fileByRole(model, 'tokens', dir),
    numThreads,
    provider: 'cpu',
    debug: 0,
  };
  const kind = model.loader;
  switch (kind) {
    case 'senseVoice':
      return {
        senseVoice: {
          model: fileByRole(model, 'model', dir),
          useInverseTextNormalization: 1,
          language: 'auto',
        },
        ...common,
      };
    case 'whisper':
      return {
        whisper: {
          encoder: fileByRole(model, 'encoder', dir),
          decoder: fileByRole(model, 'decoder', dir),
          language: isWildcardLang(language) ? '' : baseLang(language),
          task: 'transcribe',
        },
        ...common,
      };
    case 'offline-transducer':
    case 'nemo-transducer':
      return {
        transducer: {
          encoder: fileByRole(model, 'encoder', dir),
          decoder: fileByRole(model, 'decoder', dir),
          joiner: fileByRole(model, 'joiner', dir),
        },
        ...common,
      };
    case 'nemo-ctc':
      return { nemoCtc: { model: fileByRole(model, 'model', dir) }, ...common };
    case 'canary': {
      const lang = isWildcardLang(language) ? 'en' : baseLang(language);
      return {
        canary: {
          encoder: fileByRole(model, 'encoder', dir),
          decoder: fileByRole(model, 'decoder', dir),
          srcLang: lang,
          tgtLang: lang,
          usePnc: 1,
        },
        ...common,
      };
    }
    case 'moonshine':
      return {
        moonshine: {
          preprocessor: fileByRole(model, 'preprocessor', dir),
          encoder: fileByRole(model, 'encoder', dir),
          uncachedDecoder: fileByRole(model, 'uncached-decoder', dir),
          cachedDecoder: fileByRole(model, 'cached-decoder', dir),
        },
        ...common,
      };
    // 'streaming-transducer' has no arm: the refusal at the top of the
    // function already narrowed it away, and the compiler enforces that.
    default: {
      // Exhaustiveness: a ninth LoaderKind without an arm here fails to
      // compile, which is the whole reason the union is closed.
      const _exhaustive: never = kind;
      throw new Error(`unknown loader kind: ${String(_exhaustive)}`);
    }
  }
}

/** Do the two kinds whose config embeds the language need a per-language
 *  recognizer instance? Read by sherpa-local's cache key. */
export function loaderConfigEmbedsLanguage(model: CatalogModel): boolean {
  return model.loader === 'whisper' || model.loader === 'canary';
}
