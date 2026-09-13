import { describe, it, expect } from 'vitest';
import { EVENT_NAMES, EVENT_NAME_SET, isKnownEvent } from '../src/events';
import { EVENT_SCHEMAS } from '../src/protocol-schemas';

// The whitelist + count guard is the load-bearing protocol invariant
// (04-PROTOCOL-SPEC.md §3/§4, D2 lesson). It forces every protocol change to
// pass through this exact-count gate.
// 55 → 56 (R6 T-8): one additive name, `pc:list-mobiles`.
// 56 → 57: GA-14 `stt:refined` (owner approved 2026-07-26). The guard exists to
// make an addition a conscious act, not to make it impossible — and this one
// could not be an additive FIELD: riding `stt:final` would hand the mobile FSM a
// second terminal for a settled utterance (the wedging class GA-03 fixed), and
// riding `history:updated` assumes the SERVER owns the row, which it does not
// (only the mobile emits history:create).
// 57 → 58: `mobile:unpair` (owner approved 2026-07-29). It could NOT be an
// additive field: there was no verb at all that retires a pairing — deleting on
// the phone dropped the local token and left the server row forever, so the PC
// listed phones the user had removed and nothing in the protocol could say
// otherwise. Nor could it ride `mobile:reconnect` (the opposite intent) or
// `pc:release-mobile` (that one is the PC revoking a phone; this is the phone
// retiring itself, and the two have different authorization).
//
// 58 → 54 (owner approved 2026-07-31, stage-5 protocol cleanup): the first time
// this number has ever gone DOWN. Every previous note above justifies an
// addition, so state the subtractive rule plainly — a name is removed only when
// a three-end grep (server-core / desktop TS+Rust / mobile) shows neither a
// sender nor a receiver in production code. Four qualified:
//   · `history:create-local`  — never ported (no emitter, no handler anywhere);
//   · `mobile:switch-pc`      — reserved vocabulary; switching PCs is a
//                               disconnect/reconnect (04 §3.1 said so since GA-17);
//   · `audio:heartbeat`       — mobile emitted every 5 s, server never listened;
//   · `audio:resend-request`  — mobile handled it, server never emitted it.
// The audio pair was ONE loop façading in both directions; the recovery it was
// meant to provide already ships as the reconnect full-ring replay + SeqTracker
// dedupe, and liveness already rides plain `heartbeat`, which has a handler.
// `timeline:grant-request` / `timeline:grant` are equally unbuilt but were
// RETAINED by ruling (E5): they carry the `e2e:v1:` red-line prefix contract.
// The guard exists to make either direction a conscious act — deletions are not
// cheaper than additions, and an old client that still emits a removed name now
// gets silence from the server's whitelist, which is why owner approval gates it.
//
// 55 → 56: `billing:budget` (card S2-02; owner approved 2026-09-06, ruling 2 of
// docs/decisions/2026-09-06-owner-web-client-rulings-repo-protocol-domains.md).
// It could NOT be an additive field, and the argument is the same one every
// note above had to make. The number has to be readable at three moments and
// only one of them has a frame to ride: at rest, before anyone speaks (no frame
// exists); repeatedly mid-recording (the frames that flow then, `stt:interim`
// and `stt:level`, are about the utterance's text and loudness — an account
// balance on one of those is a frame with two subjects); and just after a
// reconnect — which IS a field, `BudgetAckFieldsSchema`, chosen over the
// alternative `billing:budget-request` event precisely so this costs ONE name.
// Nor could it ride `stt:error`: the refusal already has two owners
// (`QUOTA_EXCEEDED` on a turned-away press, `audio:auto-stopped
// {reason:'quota_exhausted'}` on a recording that hits the ceiling), and this
// name deliberately answers a different question — "how much is left" — so that
// "why did this end" keeps exactly one answer.
// Owner's approval carried a condition that is itself part of the guard's
// point: it lands in the SAME commit as its first real emitter, never as a
// registered placeholder waiting for one.
//
// 56 → 57: `control:key-result` (card MP-14; owner approved it on 2026-09-11,
// ruling 3 of docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-
// polish.md §11 追认三 item 8). It could NOT be an additive field, and for once
// the reason is the simplest one this guard has ever been given: THERE WAS NO
// FRAME TO ADD A FIELD TO. `control:key` is one-way — the far end receives a
// keypress and answers nothing — so 「this end cannot press that key」 had no way
// to be said at all, and the product said 「sent」 for it. Riding `inject:result`
// was the only other candidate and it is worse than it looks: that frame is a
// delivery verdict for an UTTERANCE (required `mode`, plus the ids that settle a
// timeline row), and a keypress has no text, no mode and no row — three
// placeholder values, which is how a filler becomes a judgement (0.2.49 F2b).
// The refusal vocabulary deliberately did NOT go into the error-code registry
// either: it is a three-valued enum local to this one event, and a delivery
// code would hand a keypress the vocabulary of a delivery (15 §2.0).
const CANONICAL_EVENT_COUNT = 57;

describe('event whitelist count guard', () => {
  it(`holds exactly ${CANONICAL_EVENT_COUNT} canonical event names`, () => {
    expect(EVENT_NAMES.length).toBe(CANONICAL_EVENT_COUNT);
    expect(EVENT_NAME_SET.size).toBe(CANONICAL_EVENT_COUNT);
    // No duplicates snuck in.
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });

  it('has one schema per event name and no orphan schemas', () => {
    const schemaKeys = Object.keys(EVENT_SCHEMAS);
    expect(schemaKeys.length).toBe(CANONICAL_EVENT_COUNT);
    for (const name of EVENT_NAMES) {
      expect(EVENT_SCHEMAS).toHaveProperty(name);
    }
    for (const key of schemaKeys) {
      expect(isKnownEvent(key)).toBe(true);
    }
  });

  it('does NOT contain the pre-rename legacy names', () => {
    for (const legacy of ['_health-ping', '_health-pong', 'flow-message']) {
      expect(EVENT_NAME_SET.has(legacy as never)).toBe(false);
      expect(EVENT_SCHEMAS).not.toHaveProperty(legacy);
    }
  });

  it('DOES contain the renamed names', () => {
    for (const renamed of ['sys:ping', 'sys:pong', 'control:key'] as const) {
      expect(EVENT_NAME_SET.has(renamed)).toBe(true);
      expect(EVENT_SCHEMAS).toHaveProperty(renamed);
    }
  });

  it('contains the R6 T-8 additive name (and its PC-side twin)', () => {
    // Additive, not a rename: the pre-existing mobile-side query is untouched.
    for (const name of ['pc:list-mobiles', 'mobile:list-pcs'] as const) {
      expect(EVENT_NAME_SET.has(name)).toBe(true);
      expect(EVENT_SCHEMAS).toHaveProperty(name);
    }
  });

  it('does NOT contain the four names removed in the stage-5 cleanup', () => {
    // The schema must go with the name. Leaving an orphan schema behind would
    // just move the façade from the event face to the type face — the reason
    // the「one schema per name, no orphans」case above is the real guard.
    for (const gone of [
      'history:create-local',
      'mobile:switch-pc',
      'audio:heartbeat',
      'audio:resend-request',
    ]) {
      expect(EVENT_NAME_SET.has(gone as never)).toBe(false);
      expect(EVENT_SCHEMAS).not.toHaveProperty(gone);
    }
  });

  it('RETAINS the two E2EE grant names (E5 ruling; server half built by GRANT-1)', () => {
    // Kept on purpose while four siblings were deleted for the「no emitter,
    // no handler」reason: these two carry the e2e:v1: prefix contract, and
    // since GRANT-1 (2026-08-11) the server registers handlers for both. If a
    // future sweep deletes them, that must be a ruling, not a tidy-up.
    for (const kept of ['timeline:grant-request', 'timeline:grant'] as const) {
      expect(EVENT_NAME_SET.has(kept)).toBe(true);
      expect(EVENT_SCHEMAS).toHaveProperty(kept);
    }
  });
});
