// The server-core build stamp: which repo version AND which source commit
// produced the bundle you are about to deploy, written INTO the bundle's own
// bytes at build time.
//
// ── the hole this closes (ledger NR-51, §39) ────────────────────────────────
//
// The production relay is fed `apps/server-core/dist/index.js`, and the deploy
// script asserted only that this file EXISTS — never that it is the build of
// THIS commit. The stt-cloud stamp (this repo, ledger P6) closes the VERSION
// half of that hole and is honest about its limit: two builds inside one
// version are indistinguishable to it. NR-26 closed the web half by stamping
// the commit; this is the relay's equivalent, and it stamps BOTH the version
// and the commit, so "src/ changed after the build, dist left behind" finally
// has a byte the deploy gate can read and refuse.
//
// ── how it works ────────────────────────────────────────────────────────────
//
// `__SERVER_CORE_BUILD_STAMP__` is not a runtime global. tsup replaces it at
// build time with a string literal built by scripts/build-stamp/source-stamp.mjs
// from this package's package.json version, `git rev-parse HEAD`, and whether
// `git status --porcelain` is non-empty (⇒ `.dirty`). The reader is
// verify/lint/server-core-bundle-stamp.mjs in this repo, plus the same
// assertion in the web repo's deploy/deploy-vps-app.py — the deploy reads the
// bytes, parses version+sha[.dirty|.nogit], and refuses anything that is not
// this HEAD, clean. The export exists so the constant survives tree-shaking
// into the bundle; index.ts logs it once at startup (and deliberately NOT into
// /api/health's return shape — provenance is a log fact, not a health field).
//
// The consumer of the emitted string is deliberately NOT the health endpoint:
// it is the byte scanner named above. The source fallback below deliberately
// carries no stamp prefix, so "no stamp at all in the bytes" stays a distinct,
// separately-diagnosable verdict from "stamped, but with the wrong tree".

declare const __SERVER_CORE_BUILD_STAMP__: string;

/**
 * `<prefix><version>+<sha40>[.dirty]` in a built bundle; the sentence below when
 * this module is loaded from TypeScript source (vitest imports src/ directly,
 * where no tsup `define` has run).
 */
export const SERVER_CORE_BUILD_STAMP: string =
  typeof __SERVER_CORE_BUILD_STAMP__ === 'string'
    ? __SERVER_CORE_BUILD_STAMP__
    : 'server-core loaded from TypeScript source — no tsup define ran, so there is no stamp';
