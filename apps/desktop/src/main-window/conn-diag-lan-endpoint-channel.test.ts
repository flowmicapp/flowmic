// P3 #19 (2026-09-02) — `ConnDiagPage.vue` fills a variable it names
// `lanEndpoint` from `fetchPairingInfo()` with NO channel argument.
// bridge.ts's own doc comment on `fetchPairingInfo` says plainly what an
// omitted channel means: "the Rust side falls back to the stored channel
// preference" — NOT "lan". Whoever last paired over cloud would have this
// diagnostic page silently show the CLOUD endpoint labelled as the LAN one:
// the one-value-answers-two-questions shape this repo names as its #1 bug
// class, on the one page whose entire job is telling the truth about the link.
//
// Source-reading rather than a full component mount: ConnDiagPage.vue pulls in
// the sidecar/cloud/engine-probe machinery this page is the union of, and the
// one fact worth pinning here is which literal reaches the IPC call, which a
// mount would only re-derive through several more layers of mocking. The
// "reverse control" below operates entirely on an in-memory string — it never
// touches the file on disk.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('./ConnDiagPage.vue', import.meta.url)), 'utf8');

function callsIn(text: string): string[] {
  return text.match(/fetchPairingInfo\([^)]*\)/g) ?? [];
}

describe('ConnDiagPage: the field it calls `lanEndpoint` is fetched for the LAN channel by name', () => {
  it('both fetchPairingInfo() call sites pass the literal channel "lan"', () => {
    const calls = callsIn(src);
    expect(calls.length, 'expected two fetchPairingInfo(...) call sites').toBe(2);
    for (const call of calls) {
      expect(
        call,
        `${call} must name its channel — an omitted argument follows the stored channel preference, not "lan"`,
      ).toBe("fetchPairingInfo('lan')");
    }
  });

  it('🔴 reverse control, in memory only: a bare fetchPairingInfo() call is exactly what the assertion above is built to catch', () => {
    const withoutChannel = src.replace(/fetchPairingInfo\('lan'\)/g, 'fetchPairingInfo()');
    expect(withoutChannel, 'the substitution must actually change something, or this control proves nothing').not.toBe(src);
    const calls = callsIn(withoutChannel);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c === "fetchPairingInfo('lan')")).toBe(false);
  });
});
