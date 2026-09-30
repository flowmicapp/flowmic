import { defineConfig } from 'vitest/config';

// CI-only knobs, read from the environment so a local run never sees them.
// They are set in exactly one place: the "Server tests" step of
// .github/workflows/verify.yml (the hosted Windows runner). A missing, non-numeric
// or non-positive value falls back to vitest's own default, so the seam can raise
// the ceiling for a slow box but can not switch a timeout off.
//
// Why they exist: the public Windows `verify` job failed on this suite with
// "Test timed out in 5000ms" on three separate runs, each in a different
// migration test (migration-idempotency.test.ts, recovery-schema-migration.test.ts,
// and the same job on a rerun of the docs-only commit 49b059419091, runs
// 36662649345 attempts 1 and 2), while the
// same suite is green on macOS and Linux and green on a Windows rerun. Those tests
// open a fresh node:sqlite file per case, run the full migration ladder
// synchronously and delete the directory afterwards, which is exactly the
// file-I/O shape that Windows Defender scanning and several vitest workers
// contending for the same runner disk make slow at random. A single 5000 ms
// deadline turns that jitter into a red X.
function positiveIntFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const ciTestTimeoutMs = positiveIntFromEnv('FLOWMIC_CI_TEST_TIMEOUT_MS');
const ciMaxWorkers = positiveIntFromEnv('FLOWMIC_CI_TEST_MAX_WORKERS');

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // node:sqlite emits an experimental warning; keep output readable.
    silent: false,
    ...(ciTestTimeoutMs !== undefined ? { testTimeout: ciTestTimeoutMs, hookTimeout: ciTestTimeoutMs } : {}),
    ...(ciMaxWorkers !== undefined ? { maxWorkers: ciMaxWorkers } : {}),
  },
});
