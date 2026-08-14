// 🔴 MANDATORY (card §207 / §545): prove the desktop Tauri sidecar artifact does
// NOT contain the private cloud-STT adapter code.
//
// WHY THIS TEST IS NOT OPTIONAL. server-core reaches `@flowmic/stt-cloud`
// through an OPTIONAL DYNAMIC load. An optional load that silently no-ops is
// this repo's #1 bug shape, and the failure here is invisible from both ends:
//   - `"private": true` proves only that npm will not publish it;
//   - the opensource EXCLUDE proves only that the PUBLIC REPO lacks it;
//   - NEITHER says anything about what esbuild put in `resources/server.js`,
//     which is the file that lands on every self-hosted user's machine.
// card §42 says this explicitly: "trying to dodge this with 'drop it from the OSS export list' only solves item 1,
// it does not solve item 2".
//
// The mechanism being tested is precise: `engine-factory.ts` holds the specifier
// in a VARIABLE and loads it with `createRequire`. esbuild cannot follow a
// non-literal specifier, so the package is not pulled in. A literal
// `import('@flowmic/stt-cloud')` WOULD be inlined by `bundle:true` even though
// it is dynamic — so this test is what stands between us and someone
// "casually changing it to a static import".
//
// ⚠️ WHY WE RE-BUNDLE INSTEAD OF ONLY READING THE SHIPPED FILE.
// `apps/desktop/src-tauri/resources/server.js` is a gitignored build artifact
// that may predate the source it is supposed to cover. A test that only reads it
// is GREEN for the boring reason (the artifact was built before soniox existed)
// — vacuously green, which is worse than red. So the authoritative assertion
// re-runs the SAME esbuild configuration as
// `apps/desktop/scripts/build-sidecar.mjs` against the CURRENT source, in
// memory. It cannot go stale, and it cannot collide with a concurrent
// `tauri:build` (we never write to the artifact path).

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps', 'server-core', 'src', 'index.ts');
const PROTOCOL_DIST = path.join(REPO_ROOT, 'packages', 'protocol', 'dist', 'index.js');
const SIDECAR_ARTIFACT = path.join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'resources', 'server.js');
const SONIOX_SOURCE = path.join(REPO_ROOT, 'packages', 'stt-cloud', 'src', 'engines', 'soniox.ts');
// The whole private package — the discriminator between the two trees this
// suite runs in (private repo: present; OSS export: stripped by design).
const STT_CLOUD_PKG = path.join(REPO_ROOT, 'packages', 'stt-cloud');

/**
 * Strings that exist ONLY in the private package's implementation.
 *
 * ⚠️ Deliberately NOT the bare word 'soniox': the OPEN half legitimately
 * contains it (the `SttEngineId` union member and `case 'soniox':`, B15 ruling
 * (a)), so asserting on it would be a false positive — and the reflex fix for a
 * false positive is to weaken the test. These are implementation fingerprints:
 * if any of them is in the bundle, the ADAPTER is in the bundle.
 */
const PRIVATE_FINGERPRINTS = [
  'stt-rt.soniox.com',   // the vendor WS endpoint (card §3)
  'SonioxEngine',        // the class
  'TokenAccumulator',    // the §3a accumulator
  'stt-rt-v5',           // the vendor model id
];

/** Proof we are looking at a real server-core bundle and not an empty string. */
const SERVER_CORE_FINGERPRINT = 'FLOWMIC_MANAGED_STT_ENABLED';

interface EsbuildLike {
  build(opts: Record<string, unknown>): Promise<{ outputFiles?: { text: string }[] }>;
}

/**
 * Same resolution dance `build-sidecar.mjs` does: bare import first, then a glob
 * over the pnpm store. esbuild is not a DECLARED dependency of server-core (it
 * arrives via tsup), so a literal `import('esbuild')` does not typecheck — and
 * adding it to package.json just to satisfy a test would put a build tool into
 * the server's dependency graph. The specifier is therefore computed.
 */
async function loadEsbuild(): Promise<EsbuildLike> {
  const bare = 'esbuild';
  try {
    return (await import(/* @vite-ignore */ bare)) as unknown as EsbuildLike;
  } catch { /* fall through to the pnpm store glob */ }
  const store = path.join(REPO_ROOT, 'node_modules', '.pnpm');
  if (existsSync(store)) {
    const { readdirSync } = await import('node:fs');
    const { pathToFileURL } = await import('node:url');
    const dirs = readdirSync(store).filter((d) => /^esbuild@/.test(d)).sort().reverse();
    for (const d of dirs) {
      const main = path.join(store, d, 'node_modules', 'esbuild', 'lib', 'main.js');
      if (existsSync(main)) {
        return (await import(/* @vite-ignore */ pathToFileURL(main).href)) as unknown as EsbuildLike;
      }
    }
  }
  throw new Error('esbuild not found (bare import + pnpm store glob both failed) — cannot verify the sidecar bundle');
}

async function bundleLikeSidecar(): Promise<string> {
  const esbuild = await loadEsbuild();
  const result = await esbuild.build({
    entryPoints: [SERVER_ENTRY],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['bufferutil', 'utf-8-validate'],
    legalComments: 'none',
    sourcemap: false,
    minify: false,
    logLevel: 'silent',
    write: false, // ← never touch the real artifact; another session may be building
    outfile: path.join(REPO_ROOT, 'node_modules', '.cache', 'sidecar-probe.js'),
  });
  const out = result.outputFiles?.[0];
  if (!out) throw new Error('esbuild produced no output for the sidecar probe');
  return out.text;
}

describe('sidecar bundle must not contain @flowmic/stt-cloud (card §207)', () => {
  it('positive control: the fingerprints really do exist in the private source', () => {
    // Without this, the negative assertions below could pass because the strings
    // were renamed and no longer exist anywhere — a probe that went blind
    // (CLAUDE.md a negative assertion must carry its own positive control).
    //
    // 🔴 TWO TREES, TWO MEANINGS (GATE-3 fallout, 2026-08-07). This suite now
    // also runs inside the EXPORTED tree (verify-export.mjs runs the exported
    // verify:delivery, which since GATE-3 includes server tests), and there
    // `@flowmic/stt-cloud` is absent BY DESIGN — opensource-export strips the
    // private package; its absence is the strongest form of the very exclusion
    // this file asserts, not a blinded probe. The staleness this control
    // guards against (fingerprints renamed in source while the scan still
    // hunts the old strings) cannot mask a leak in a tree where the source
    // does not exist at all. So: private tree ⇒ full control; exported tree ⇒
    // assert the WHOLE PACKAGE is gone, which is what "excluded" means there.
    if (!existsSync(STT_CLOUD_PKG)) {
      expect(existsSync(SONIOX_SOURCE)).toBe(false);
      return;
    }
    expect(existsSync(SONIOX_SOURCE)).toBe(true);
    const src = readFileSync(SONIOX_SOURCE, 'utf8');
    for (const f of PRIVATE_FINGERPRINTS) expect(src).toContain(f);
  });

  it('precondition: @flowmic/protocol is built (the bundler resolves its dist, not src)', () => {
    // Same fail-loud precondition build-sidecar.mjs has. A stale/absent protocol
    // dist has produced BOTH a false-green and a false-red in this repo.
    expect(
      existsSync(PROTOCOL_DIST),
      `@flowmic/protocol is not built (${PROTOCOL_DIST}) — run \`pnpm -F @flowmic/protocol build\``,
    ).toBe(true);
  });

  it('AUTHORITATIVE: a fresh sidecar-identical bundle of current source excludes the private adapter', async () => {
    const bundle = await bundleLikeSidecar();
    // Proves we bundled the right thing (not an empty/garbage output).
    expect(bundle).toContain(SERVER_CORE_FINGERPRINT);
    // Proves the OPEN half is present — the name and the fail-loud seam ship.
    expect(bundle).toContain('@flowmic/stt-cloud'); // the specifier string itself
    // …and the IMPLEMENTATION does not.
    for (const f of PRIVATE_FINGERPRINTS) expect(bundle).not.toContain(f);
  }, 120_000);

  it('the shipped artifact, when one exists, agrees', () => {
    if (!existsSync(SIDECAR_ARTIFACT)) {
      // Not a skip: a missing artifact is a real fact the reader must see. It is
      // also not a failure of THIS card — the authoritative check above already
      // ran against current source.
      expect(
        existsSync(SIDECAR_ARTIFACT),
        `no sidecar artifact at ${SIDECAR_ARTIFACT}; run \`pnpm -F @flowmic/desktop build:sidecar\` to check the shipped file too`,
      ).toBe(true);
      return;
    }
    const art = readFileSync(SIDECAR_ARTIFACT, 'utf8');
    for (const f of PRIVATE_FINGERPRINTS) expect(art).not.toContain(f);
  });
});
