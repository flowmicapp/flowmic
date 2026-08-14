import { defineConfig } from 'tsup';

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
});
