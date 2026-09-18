import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

import { sourceStamp } from '../../scripts/build-stamp/source-stamp.mjs';

// 🔴 THE BUILD STAMP (ledger NR-51, §39). The relay is fed dist/index.js, and
// the deploy used to assert only that the file EXISTS. Stamping the version AND
// the source commit here is what lets the deploy read back "was this built from
// THIS HEAD" out of the bytes — the reasoning, and the shape of the stamp, is in
// src/build-stamp.ts's header and scripts/build-stamp/source-stamp.mjs.
// `STAMP_PREFIX` is pinned against the gate's own copy of it by
// scripts/server-core-bundle-stamp.test.mjs, so the two cannot drift apart.
const STAMP_PREFIX = 'flowmic-server-core-build@';

const pkg: { version?: unknown } = JSON.parse(
  readFileSync(new URL('package.json', import.meta.url), 'utf8'),
);
// Fail the BUILD rather than stamp something unusable: a bundle carrying an
// empty or malformed stamp would go red at the gate as "stale", which is a
// confident answer pointing at the wrong problem. Same stance the stt-cloud
// tsup.config.ts already takes.
if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg.version)) {
  throw new Error(
    `@flowmic/server-core: cannot stamp the bundle — package.json version is ${JSON.stringify(pkg.version)}, ` +
      'expected a semver string. Fix that version face before building (scripts/bump-version.mjs owns it).',
  );
}
// The paths whose content changes this bundle's bytes. Dirtiness is judged
// against THESE, not a bare `git status`, because tsup writes its own temp
// bundled-config into the package dir during config load (see
// scripts/build-stamp/source-stamp.mjs). Known gaps, same as the web repo's
// BUILD_INPUT_PATHS: node_modules (git cannot see it) and the root
// package.json version the deploy compares against (version-sync lint owns it).
const BUILD_INPUTS = [
  'apps/server-core/src',
  'apps/server-core/tsup.config.ts',
  'apps/server-core/tsconfig.json',
  'apps/server-core/package.json',
  'packages/protocol/src', // bundled via noExternal — its bytes land in dist/
  'packages/protocol/package.json',
  'scripts/build-stamp/source-stamp.mjs',
  'pnpm-lock.yaml',
];
const BUILD_STAMP = sourceStamp(STAMP_PREFIX, pkg.version, BUILD_INPUTS);

// server-core ships as a single ESM entry runnable via `node dist/index.js`
// (single-file self-host path). The migration SQL is inlined as a TS constant
// (db/schema.ts) rather than a copied .sql asset, so there is no runtime asset
// resolution to break on the bundled sidecar (13-LESSONS-LEARNED §4: "release
// must carry the migrations dir or crash" — eliminated by inlining).
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  // Single-file self-host: bundle @flowmic/protocol + zod INTO index.js so the
  // binary needs only socket.io at runtime (heavy, native-ish — kept external).
  // node:sqlite is loaded via a runtime require in db/connection.ts (esbuild
  // mangles its newer `node:` prefix, so it is deliberately not a static import).
  external: ['socket.io'],
  noExternal: ['@flowmic/protocol', 'zod'],
  // Replaced at build time; read back out of the emitted bytes by
  // verify/lint/server-core-bundle-stamp.mjs and by the web repo's deploy script.
  define: { __SERVER_CORE_BUILD_STAMP__: JSON.stringify(BUILD_STAMP) },
});
