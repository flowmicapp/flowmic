import { defineConfig } from 'tsup';

// Multi-entry build so every legacy subpath export keeps a stable dist entry
// (`@flowmic/protocol/events`, `/error-codes`, `/engine-presets`, …). All of
// package.json's `main`/`module`/`types`/`exports` point at dist — never src
// (the old @flowmic/shared shipped `main: ./src/index.ts`, the #1 cross-repo
// consumption hazard this package is chartered to fix, WP-R0-1).
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/events.ts',
    'src/protocol-schemas.ts',
    'src/error-codes.ts',
    'src/engine-presets.ts',
    'src/types.ts',
    'src/constants.ts',
    'src/dictionary-packs.ts',
    'src/schema-negotiation.ts',
    'src/scenario.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: true,
  treeshake: true,
});
