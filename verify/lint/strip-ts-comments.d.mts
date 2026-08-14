// Hand-written declaration for strip-ts-comments.mjs — verify/lint is plain
// Node ESM with no build step, so this file (not a generated one) is what lets
// apps/server-core/test/*.ts import it under `tsc --noEmit` without an
// implicit-any error (TS7016). Keep this in sync with the .mjs by hand; there
// is no build to regenerate it from.
export declare function stripTsComments(src: string): string;
