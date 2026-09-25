// L-9: execute the real lint module. Only its filesystem input is extended by
// one virtual Rust file; the scanner, counters and verdict remain production.
// A new Linux branch must demand Linux evidence even on this Windows host.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('the production cfg tripwire detects an additional Linux branch', () => {
  const root = new URL('../../../../', import.meta.url);
  const lint = new URL('verify/lint/platform-cfg-count.mjs', root).href;
  const util = new URL('verify/lint/_util.mjs', root).href;
  const shim = `
    export * from ${JSON.stringify(util)};
    import * as real from ${JSON.stringify(util)};
    export async function walk(p) { return [...await real.walk(p), '/virtual-linux-tripwire.rs']; }
    export async function readText(p) {
      return p === '/virtual-linux-tripwire.rs' ? globalThis.extraCfg : real.readText(p);
    }
  `;
  const program = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === './_util.mjs' && context.parentURL === ${JSON.stringify(lint)})
        return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(shim)}`)}, shortCircuit: true };
      return next(specifier, context);
    }});
    const { default: run } = await import(${JSON.stringify(lint)});
    globalThis.extraCfg = '';
    const baseline = await run();
    globalThis.extraCfg = '#[cfg(target_os = "linux")] fn new_linux_branch() {}';
    const added = await run();
    console.log(JSON.stringify({ baseline, added }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: fileURLToPath(root), encoding: 'utf8',
  }));
  expect(result.baseline.status, result.baseline.detail).toBe('PASS');
  expect(result.added.status, result.added.detail).toBe('FAIL');
  expect(result.added.detail).toContain('cfg(target_os = "linux"): expected');
  expect(result.added.detail).toContain('./scripts/linux-verify.sh');
});
