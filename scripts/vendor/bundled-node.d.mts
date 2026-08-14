// Hand-written declaration for bundled-node.mjs — added the day a TypeScript
// consumer appeared (apps/server-core/test/sidecar-excludes-stt-cloud.test.ts
// imports stagedNodeFileName to tell "the build was not run" apart from "this
// platform cannot run the build"). Types only; the values, provenance rules
// and the pin discipline live in bundled-node.mjs and are authoritative there.

export interface BundledNodePin {
  /** As `node -v` answers it, tag form. */
  version: string;
  sha256: string;
  bytes: number;
  /** Filename inside scripts/vendor/ holding that build's verbatim LICENSE. */
  licenseFile: string;
  /** Repo-relative, POSIX separators — where the runtime is staged. */
  stagedPath: string;
}

/** One entry per MEASURED platform, keyed `${process.platform}-${process.arch}`. */
export declare const BUNDLED_NODE: Record<string, BundledNodePin | undefined>;

/** Staged runtime filename for the given platform, or null when no pin is
 *  declared for it (build-sidecar refuses to build there). */
export declare function stagedNodeFileName(platformKey?: string): string | null;

/** The key BUNDLED_NODE would be indexed by for the machine running this. */
export declare function hostPlatformKey(): string;
