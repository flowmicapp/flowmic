import { defineConfig } from 'tsup';

// Single entry: this package is a catalogue, not a toolkit. Everything a
// consumer needs (messages, locale rows, formatMessage) comes off `.`, so there
// is no subpath export to keep stable and no reason to invent one.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  treeshake: true,
});
