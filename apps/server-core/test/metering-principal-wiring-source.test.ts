// Card W4-05 — the wiring nothing else can prove.
//
// SPEC-REF: apps/server-core/src/auth/metering-principal.ts
//           apps/server-core/src/socket/handlers/mobile.handler.ts
//           apps/server-core/src/socket/handlers/audio.handler.ts
//             (`anonymousUser` — OPTIONAL in both, and this file is why that is
//              allowed)
//
// ── WHY OPTIONAL, AND WHY THAT NEEDS A GUARD ───────────────────────────────
// `anonymousUser` cannot be required: thirteen existing test files construct
// these handler deps, and a required partner would make every one of them
// declare an opinion about a rule they are not about. Absence has an honest
// meaning too — "this relay has no such rule", which is the pre-card answer and
// the same one an older relay gives. But an optional dep that bootstrap forgets
// is this repo's #1 historical bug shape: a capability defined and never called,
// with every gate green.
//
// What forgetting it would cost: a visitor who signs in on the phone goes on
// being metered against the two-minute demo identity, and once that is spent,
// EVERY sentence they speak is refused QUOTA_EXCEEDED on an allowance the
// privacy policy tells them stopped applying ("Trying FlowMic on the website"
// item 4). Silent, green, and directly contrary to a published statement.
//
// ⚠️ WHAT THIS DOES NOT PROVE. It proves the text is there, not that the
// behaviour is right — `anonymousUser: () => false` would pass. The behaviour is
// pinned by golden G26-b, which drives a real relay with a real account JWT and
// asserts the ledger the seconds land in. Two halves; neither is the other.
//
// Precedent for reading the tree: test/presence-wiring-source.test.ts, whose
// header carries the full argument for this shape.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripTsComments } from '../../../verify/lint/strip-ts-comments.mjs';

/** 🔴 CODE ONLY — a comment that merely NAMES the dep must not satisfy this
 *  ("would a correct product also match this string?"). Same helper
 *  presence-wiring-source.test.ts uses, for the same reason. */
function code(rel: string): string {
  return stripTsComments(readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8'));
}

describe('the anonymous-row reader reaches both handlers that decide with it', () => {
  // 2026-09-09 — both call sites moved VERBATIM from bootstrap.ts's
  // `io.on('connection', ...)` callback to bootstrap-connection-handlers.ts
  // (800-line cap split; see that file's own header). Same precedent as
  // test/presence-wiring-source.test.ts reading bootstrap-http-deps.ts for a
  // call site an earlier split moved out of bootstrap.ts.
  const boot = code('bootstrap-connection-handlers.ts');

  it('bootstrap builds it from users.anonymous through the ONE reader', () => {
    // The VALUE must come from `anonymousRowReader`, not from a second inline
    // `findById(...)?.anonymous` — two authors of one column read is how the two
    // exceptions would come to disagree about the same row.
    expect(boot).toContain("from './auth/metering-principal'");
    expect(boot.match(/anonymousRowReader\(db\.users\)/g)?.length).toBe(2);
    expect(boot).not.toMatch(/anonymousUser:\s*\(/);
  });

  it('🔴 the mobile handlers get it (the admission that stamps the principal)', () => {
    const call = boot.slice(boot.indexOf('registerMobileHandlers(socket, {'));
    expect(call.slice(0, call.indexOf('\n'))).toContain('anonymousUser: anonymousRowReader(db.users)');
  });

  it('🔴 the audio handlers get it (the QTA-2 gate and the target-end reading)', () => {
    const call = boot.slice(boot.indexOf('registerAudioHandlers(socket, {'));
    expect(call.slice(0, call.indexOf('});'))).toContain('anonymousUser: anonymousRowReader(db.users)');
  });

  it('🔴 neither handler writes the account onto the pairing row', () => {
    // The design's §7 item 2: writing `mobile_pairings.user_id` would make the
    // demo pairing occupy a mobile slot on the signed-in account, and leave a
    // foreign-account row on a PC the 48-hour sweep deletes. The principal is a
    // per-admission derivation and nothing else.
    //
    // ⚠️ card R-1 (2026-09-10) narrows what this asserts, and says so rather than
    // quietly dropping it: the ACCOUNT is still never written to a pairing row,
    // and `mobile_pairings.user_id` is still never written by either handler.
    // What IS written now is `trial_user_id` — a different column with a
    // different delete rule — and it holds an anonymous identity, never an
    // account. The regex below is unchanged and still forbids the thing the
    // design rejected.
    const mobile = code('socket/handlers/mobile.handler.ts');
    expect(mobile).not.toMatch(/user_id:\s*(account|principal)/);
    expect(mobile).toContain('meteringPrincipal(meteringInput(pc, mobile, { mayMint: true }))');
    // The pair leg may mint an identity; the reconnect leg may only spend one.
    // Pinned in SOURCE because the difference is invisible at runtime on a
    // single-node deployment — a replica is where a minting reconnect would
    // lose the visitor's minutes every 30 seconds, and no unit test here has a
    // replica.
    const reconnect = code('socket/handlers/mobile-reconnect.ts');
    expect(reconnect).toContain('meteringPrincipal(meteringInput(pc, mobile, { mayMint: false }))');
  });

  it('🔴 the mobile handlers get the trial minter (card R-1)', () => {
    // Same shape as the anonymous reader above and for the same reason: an
    // unwired minter is not a crash, it is an unsigned web session quietly
    // spending the PC owner's month — which is the defect the card closes.
    const call = boot.slice(boot.indexOf('registerMobileHandlers(socket, {'));
    expect(call.slice(0, call.indexOf('\n'))).toContain('webTrial');
    expect(boot).toContain('webTrial');
  });
});
