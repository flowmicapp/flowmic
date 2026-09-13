// Card MP-3 — **the transport exists**, across three languages that no compiler
// checks against each other.
//
// The sentence this card ships is decided in TypeScript and painted in a Vue
// template, and both of those are green whether or not a single `billing:budget`
// frame ever reaches this process. Four separate strings have to agree for it to
// arrive, and each of them lives in a file the other three cannot see:
//   ① `billing:budget` in the canonical whitelist (packages/protocol);
//   ② the same name mirrored in the desktop crate (`events.rs`);
//   ③ a `.on(...)` registration that actually subscribes to it (`client.rs`);
//   ④ the Tauri channel name, byte-identical in `bridge.rs` and `bridge.ts`.
//
// ② is guarded in Rust (`desktop_events_are_a_subset_of_the_protocol_whitelist`)
// and ④ has the offline-switch precedent. ③ is the one with NO guard anywhere: a
// `ClientBuilder::on` handler only runs inside a live socket.io client, so a
// deleted subscription compiles, passes clippy, passes every unit test in both
// languages, and produces a desktop that quietly never says who is paying —
// which is indistinguishable, on screen, from nobody ever being on the far end.
// That is the whole reason this file scans source rather than asserting
// behaviour: there is no seam to assert (the same argument fanout.rs's signature
// anchor records for the timeline forward).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CH } from '../lib/bridge';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const RUST_EVENTS = read('../../src-tauri/src/events.rs');
const RUST_BRIDGE = read('../../src-tauri/src/socket/bridge.rs');
const RUST_CLIENT = read('../../src-tauri/src/socket/client.rs');
const PROTOCOL_EVENTS = read('../../../../packages/protocol/src/events.ts');
const PROTOCOL_BILLING_SCHEMA = read('../../../../packages/protocol/src/protocol-schemas-billing.ts');
const USE_CLOUD_ACCOUNT = read('../lib/use-cloud-account.ts');
const BILLING_PAYER = read('../lib/billing-payer.ts');

describe('MP-3 · the payer hint really reaches the window', () => {
  it('① the wire name is the canonical one, spelled once', () => {
    const m = /BILLING_BUDGET:\s*&str\s*=\s*"([^"]+)"/.exec(RUST_EVENTS);
    expect(m, 'events.rs must declare BILLING_BUDGET').not.toBeNull();
    expect(m![1]).toBe('billing:budget');
    expect(PROTOCOL_EVENTS).toContain(`'${m![1]}'`);
  });

  it('② it is in DESKTOP_EVENTS, so the Rust subset guard covers it', () => {
    const list = /pub const DESKTOP_EVENTS: &\[&str\] = &\[([\s\S]*?)\];/.exec(RUST_EVENTS);
    expect(list, 'events.rs must declare DESKTOP_EVENTS').not.toBeNull();
    expect(list![1]).toContain('BILLING_BUDGET,');
  });

  // 🔴 THE ONE WITH NO OTHER GUARD. Deleting this line is a silent feature
  // removal: everything downstream keeps compiling and keeps passing, and the
  // product simply stops saying anything.
  it('③ client.rs subscribes to it and forwards it onto the bridge channel', () => {
    expect(RUST_CLIENT).toMatch(
      /on_forward\(\s*builder,\s*events::BILLING_BUDGET,\s*bridge::channel::BILLING_BUDGET,/,
    );
  });

  it('④ the Tauri channel is byte-identical in bridge.rs and bridge.ts', () => {
    const m = /BILLING_BUDGET:\s*&str\s*=\s*"(flowmic:\/\/[^"]+)"/.exec(RUST_BRIDGE);
    expect(m, 'bridge.rs must declare the BILLING_BUDGET channel').not.toBeNull();
    expect(CH.billingBudget).toBe(m![1]);
  });

  // ⑤ and something on this side is listening. `CH.billingBudget` existing is not
  // evidence that anybody subscribed to it — a channel name with no consumer is
  // the repo's oldest bug class, and the one this card is a consumer FOR.
  it('⑤ the account card subscribes and folds the frame', () => {
    expect(USE_CLOUD_ACCOUNT).toContain('CH.billingBudget');
    expect(USE_CLOUD_ACCOUNT).toContain('foldBudgetFrame');
    expect(USE_CLOUD_ACCOUNT).toContain('farEndIsPaying');
    // MP-8 rides the same frame and the same subscription, so it has the same
    // no-seam problem: dropping this reading compiles, passes clippy, passes both
    // unit suites, and produces a desktop that never mentions the guest.
    expect(USE_CLOUD_ACCOUNT).toContain('guestIsSpending');
  });

  // ⑥ card MP-10 (folded in by G-2b2) rides the exact same frame, the exact
  // same channel, and the exact same subscription as ⑤ above — there is no
  // separate wire to check. What has NO seam of its own is the fold inside
  // `foldBudgetFrame`: `guestIsSpending` reading `true` proves only that ONE of
  // its two wire flags fired, and `use-cloud-account.ts` never mentions
  // `signed_in_speaker` by name (it only ever sees the folded boolean). Deleting
  // the `|| asSignedInSpeaker(frame)` half of that fold compiles, passes
  // clippy, passes ⑤ above unchanged, and produces a desktop that quietly never
  // says a colleague is speaking — indistinguishable on screen from nobody being
  // on the far end. This is the one assertion standing between that deletion and
  // silence.
  it('⑥ the signed-in-speaker flag is actually read, on the same frame as the guest flag', () => {
    expect(PROTOCOL_BILLING_SCHEMA).toContain('signed_in_speaker: z.boolean().optional()');
    expect(BILLING_PAYER).toContain('asSignedInSpeaker');
    expect(BILLING_PAYER).toMatch(/f\.signed_in_speaker\s*===\s*true/);
    // The fold, not just the reader: `guestIsSpending` must not be reachable by
    // `guest_speaker` alone.
    expect(BILLING_PAYER).toMatch(/asGuestSpeaker\(frame\)\s*\|\|\s*asSignedInSpeaker\(frame\)/);
  });
});
