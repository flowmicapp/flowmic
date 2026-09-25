// The cross-repo producer check (verify/delivery-checks/web-target-cached-mode.mjs)
// reads the actual web-client checkout. An explicit FLOWMIC_WEB_CLIENT_REPO
// replaces discovery, so a bad path cannot fall back to somebody else's
// checkout and claim the intended producer was verified.
//
// This file pins the three answers of that check WITHOUT depending on which
// flowmic-web branch happens to be checked out on the machine running the unit
// suite. The live answer against the real producer is the delivery-gate stage
// `verify:web-target-cached-mode` itself; asserting it here too would turn one
// fact about a sibling repository into two red lines in two places.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const checkUrl = new URL('../../../verify/delivery-checks/web-target-cached-mode.mjs', import.meta.url);
const { default: run, inspectProducer, PRODUCER_BRANCH } = await import(checkUrl.href);
const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const scratch: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('web target cached admission receipt', () => {
  it('skips with a named reason when the selected checkout does not exist', async () => {
    const missing = path.join(tmpdir(), 'flowmic-web-client-that-does-not-exist');
    vi.stubEnv('FLOWMIC_WEB_CLIENT_REPO', missing);
    const result = await run();
    expect(result.status).toBe('SKIP');
    expect(result.detail).toContain('no flowmic-web checkout on this machine');
    expect(result.detail).toContain(missing);
    expect(result.detail).toContain('FLOWMIC_WEB_CLIENT_REPO');
  });

  it('fails by name when a checkout is present but carries no producer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flowmic-web-no-producer-'));
    scratch.push(dir);
    const target = path.join(dir, 'packages/core/src/target');
    mkdirSync(target, { recursive: true });
    // A comment naming the code is not a producer.
    writeFileSync(path.join(target, 'session.ts'), "// INJECT_TARGET_NOT_READY lands later\nexport class TargetSession {}\n");
    writeFileSync(path.join(target, 'wire.ts'), 'export function buildInjectResultPayload(x) { return x; }\n');
    vi.stubEnv('FLOWMIC_WEB_CLIENT_REPO', dir);
    const result = await run();
    expect(result.status).toBe('FAIL');
    expect(result.detail).toContain('producer not found');
    expect(result.detail).toContain(`flowmic-web branch ${PRODUCER_BRANCH}`);
    expect(result.detail).toContain("default branch before this check can pass without FLOWMIC_WEB_CLIENT_REPO");
  });

  it('does not accept a cached literal in a comment or unused fixture', () => {
    expect(() => inspectProducer("// mode:'cached'; error:'INJECT_TARGET_NOT_READY'", '')).toThrow('exported TargetSession');
    expect(() => inspectProducer("export class TargetSession {} const fixture = { mode:'cached', error:'INJECT_TARGET_NOT_READY' };", '')).toThrow('onInjectRequest');
  });

  it('runs in both delivery gates and never in the per-commit lint gate', () => {
    const lint = readFileSync(path.join(repoRoot, 'verify/lint/run-all.mjs'), 'utf8');
    expect(lint).not.toContain('web-target-cached-mode');
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['verify:web-target-cached-mode']).toBe('node verify/delivery-checks/web-target-cached-mode.mjs');
    expect(pkg.scripts['verify:delivery']).toContain('pnpm verify:web-target-cached-mode');
    const fast = readFileSync(path.join(repoRoot, 'verify/run-delivery-fast.mjs'), 'utf8');
    expect(fast).toContain("pnpm('verify:web-target-cached-mode')");
  });
});
