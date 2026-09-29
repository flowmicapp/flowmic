// NR-110 — the one inline script on the browser sign-in success page, EXECUTED.
//
// The page is a Rust-built string (src-tauri/src/cloud_signin.rs `CLOSE_SCRIPT`),
// and the Rust tests can only assert what the script SAYS. This file reads that
// exact literal out of the Rust source and runs it against a stand-in DOM, so
// what it DOES is pinned too: clicking the button calls `window.close()` once,
// and — because a browser normally refuses to close a tab a script did not open
// — the 「you can close this page now」 line is revealed shortly after. If the
// tab really closed, the timer dies with it and nothing further happens.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rust = readFileSync(fileURLToPath(new URL('../../src-tauri/src/cloud_signin.rs', import.meta.url)), 'utf8');

/** The Rust literal with its `\`-newline continuations folded, as rustc does. */
function closeScript(): string {
  const m = /pub const CLOSE_SCRIPT: &str = "([\s\S]*?)";/.exec(rust);
  expect(m, 'CLOSE_SCRIPT literal not found in cloud_signin.rs').not.toBeNull();
  return m![1]!.replace(/\\\r?\n\s*/g, '');
}

function run(script: string) {
  const button: { onclick: (() => void) | null } = { onclick: null };
  const line = { hidden: true };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let closes = 0;
  const document = {
    getElementById: (id: string) => (id === 'fm-close' ? button : id === 'fm-closed' ? line : null),
  };
  const window = { close: () => { closes += 1; } };
  const setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('document', 'window', 'setTimeout', script)(document, window, setTimeout);
  return { button, line, timers, closes: () => closes };
}

describe('NR-110 the success page close script, executed', () => {
  it('does nothing until the button is pressed', () => {
    const r = run(closeScript());
    expect(r.closes()).toBe(0);
    expect(r.timers).toHaveLength(0);
    expect(r.line.hidden).toBe(true);
    expect(typeof r.button.onclick).toBe('function');
  });

  it('pressing it asks the browser to close the tab, then reveals the line if the tab is still there', () => {
    const r = run(closeScript());
    r.button.onclick!();
    expect(r.closes()).toBe(1);
    expect(r.line.hidden).toBe(true); // not before the browser had its chance
    expect(r.timers).toHaveLength(1);
    expect(r.timers[0]!.ms).toBeGreaterThan(0);
    expect(r.timers[0]!.ms).toBeLessThanOrEqual(1000);
    r.timers[0]!.fn(); // the tab survived: the browser refused to close it
    expect(r.line.hidden).toBe(false);
  });
});
