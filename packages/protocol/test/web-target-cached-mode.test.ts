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

  // Two senders, shaped like flowmic-web 172f75b: the admission arm sends the
  // built payload directly; the sink's noTarget arm holds it in a const and
  // picks the code with a conditional. `sink` is the one knob each case turns.
  const WIRE = 'export function buildInjectResultPayload(input) { return { ok: input.ok, mode: input.mode, error: input.error }; }';
  const session = (sink: { mode?: string; ok?: string; extra?: string } = {}) => `
export class TargetSession {
  onInjectRequest(raw) {
    const frame = raw;
    if (this.admission !== 'open') {
      this.send(
        'inject:result',
        buildInjectResultPayload({ ok: false, mode: 'cached', requestId: frame.requestId, error: 'INJECT_TARGET_NOT_READY' }),
      );
      return;
    }
    const outcome = this.sink.append(frame.text);
    if (outcome.kind === 'noTarget') {
      const receipt = buildInjectResultPayload({
        ok: ${sink.ok ?? 'false'},
        mode: '${sink.mode ?? 'cached'}',
        requestId: frame.requestId,
        error: outcome.cached ? 'INJECT_TARGET_NOT_READY' : NO_TEXT_TARGET_CODE,
      });
      if (outcome.cached) this.injectReceipts.recordCached(frame, receipt);
      ${sink.extra ?? ''}
      this.send('inject:result', receipt);
      return;
    }
  }
}`;

  it('accepts a second sender only because it too sends cached, ok:false', () => {
    const result = inspectProducer(session(), WIRE);
    expect(result.line).toBe(6);
    expect(result.senders).toEqual([6, 22]);
  });

  it('fails when any one sender uses another mode, even with the admission arm correct', () => {
    expect(() => inspectProducer(session({ mode: 'failed' }), WIRE)).toThrow("must emit mode:'cached'; found 'failed'");
    expect(() => inspectProducer(session({ ok: 'true' }), WIRE)).toThrow('the refusal must emit ok:false');
  });

  it('fails when a held receipt is rewritten before it is sent', () => {
    expect(() => inspectProducer(session({ extra: "receipt.mode = 'dom';" }), WIRE)).toThrow('is written to before it is sent');
  });

  it('fails when the code has no admission-arm sender or a sender outside onInjectRequest', () => {
    const noAdmission = session().replace("error: 'INJECT_TARGET_NOT_READY' }", "error: 'INJECT_NOT_PRIMARY' }");
    expect(() => inspectProducer(noAdmission, WIRE)).toThrow('admission-arm sender: expected one production node, found 0');
    const elsewhere = session().replace(/\n}$/, "\n  other() { this.send('inject:result', buildInjectResultPayload({ ok: false, mode: 'cached', error: 'INJECT_TARGET_NOT_READY' })); }\n}");
    expect(() => inspectProducer(elsewhere, WIRE)).toThrow('is outside TargetSession.onInjectRequest');
    const none = session().replaceAll("'INJECT_TARGET_NOT_READY'", "'INJECT_NOT_PRIMARY'");
    expect(() => inspectProducer(none, WIRE)).toThrow('expected at least one production sender, found 0');
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
