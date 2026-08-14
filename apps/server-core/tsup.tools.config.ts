import { defineConfig } from 'tsup';

// One-off operational tools, bundled to a SINGLE self-contained .mjs that can be
// copied to a box with no node_modules beside it (`pnpm --filter
// @flowmic/server-core build:tools`).
//
// Separate from tsup.config.ts on purpose: that one ships the server and runs
// with `clean: true` over `dist/`. This one writes into the repo's `scripts/`
// directory, where `clean` would delete tracked files — so it is `clean: false`,
// and the two must never share a config object.
//
// `node:sqlite` is loaded through a runtime require with a non-static specifier
// (src/tools/provenance-dryrun.ts), because esbuild strips the `node:` prefix off
// that newer builtin — the same trap db/connection.ts documents.
export default defineConfig({
  entry: { 'provenance-dryrun': 'src/tools/provenance-dryrun.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: '../../scripts',
  outExtension: () => ({ js: '.mjs' }),
  clean: false,
  sourcemap: false,
  dts: false,
  // Self-contained: @flowmic/protocol (engine presets) and its zod dependency are
  // bundled IN, so the emitted file needs nothing but Node itself.
  noExternal: ['@flowmic/protocol', 'zod'],
});
