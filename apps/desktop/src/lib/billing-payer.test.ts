// Card MP-3 — the pure half: one word off the wire, one boolean on the screen.
//
// What these assertions are FOR: every branch here is a way of saying nothing,
// and saying nothing is the correct answer in all but one case. The single case
// that speaks is a phone signed into its own account speaking into this
// computer, and it is the case that had no sentence at all before this card.

import { describe, expect, it } from 'vitest';

import {
  asBudgetPayer,
  asGuestSpeaker,
  asSignedInSpeaker,
  farEndIsPaying,
  foldBudgetFrame,
  guestIsSpending,
  PAYER_FRESH_MS,
} from './billing-payer';

const T0 = 1_700_000_000_000;

describe('MP-3 — reading `payer` off a budget frame', () => {
  it('reads the three contract values', () => {
    expect(asBudgetPayer({ payer: 'self' })).toBe('self');
    expect(asBudgetPayer({ payer: 'far_end' })).toBe('far_end');
    expect(asBudgetPayer({ payer: 'trial' })).toBe('trial');
  });

  // 🔴 The four ways of "not being told", which must be ONE answer because they
  // have one correct rendering. An old relay does not send the key at all; a
  // room-join reading has no payer yet; a later relay may invent a fourth word;
  // and a frame may not be an object at all. None of them is 'self'.
  it.each([
    ['an old relay omits the field', { remaining_ms: 60_000, mode: 'plan' }],
    ['a word this build does not know', { payer: 'integrator_key' }],
    ['an empty string', { payer: '' }],
    ['a non-string', { payer: 1 }],
    ['null', null],
    ['not an object', 'far_end'],
  ])('says nothing when %s', (_why, frame) => {
    expect(asBudgetPayer(frame)).toBeNull();
  });

  // The reading takes ONE key. A neighbour field that a later relay adds, or one
  // that arrives malformed, must not be able to silence this sentence.
  it('ignores everything else on the frame', () => {
    expect(
      asBudgetPayer({ payer: 'far_end', remaining_ms: 'lots', mode: null, resets_at: {} }),
    ).toBe('far_end');
  });
});

describe('MP-3 — the latch', () => {
  it('a far_end frame lights the sentence, a self frame puts it out', () => {
    const far = foldBudgetFrame(null, { payer: 'far_end' }, T0);
    expect(farEndIsPaying(far, T0)).toBe(true);
    const self = foldBudgetFrame(far, { payer: 'self' }, T0 + 1000);
    expect(farEndIsPaying(self, T0 + 1000)).toBe(false);
  });

  // 🔴 A relay that did not speak must not be read as having said either thing.
  // Clearing here would delete a true sentence mid-recording; setting here would
  // invent one. The latch is left exactly as it was, and the watchdog — not this
  // frame — is what eventually retires it.
  it('a frame with no payer leaves the latch untouched', () => {
    const far = foldBudgetFrame(null, { payer: 'far_end' }, T0);
    expect(foldBudgetFrame(far, { remaining_ms: 1 }, T0 + 5000)).toBe(far);
    expect(foldBudgetFrame(null, { remaining_ms: 1 }, T0 + 5000)).toBeNull();
  });

  // 'trial' is a value of the contract; it is not a value of this screen. It must
  // parse (so nothing downstream ever sees a bare identifier) and render nothing.
  it('trial parses and still says nothing here', () => {
    const t = foldBudgetFrame(null, { payer: 'trial' }, T0);
    expect(t?.payer).toBe('trial');
    expect(farEndIsPaying(t, T0)).toBe(false);
  });
});

describe('MP-3 — the local watchdog on a remote latch', () => {
  // The relay has no "the recording ended" frame on this channel: it pushes on
  // start, then every ~10 s, then simply stops. Without the ageing test the
  // sentence would describe a recording that finished, for the rest of the
  // session.
  it('a far_end word stops speaking once the frames stop', () => {
    const far = foldBudgetFrame(null, { payer: 'far_end' }, T0);
    expect(farEndIsPaying(far, T0 + PAYER_FRESH_MS)).toBe(true);
    expect(farEndIsPaying(far, T0 + PAYER_FRESH_MS + 1)).toBe(false);
  });

  it('each heartbeat renews it, so a running recording keeps its sentence', () => {
    let latch = foldBudgetFrame(null, { payer: 'far_end' }, T0);
    for (let i = 1; i <= 6; i += 1) {
      const at = T0 + i * 10_000; // DEFAULT_BUDGET_HEARTBEAT_MS
      latch = foldBudgetFrame(latch, { payer: 'far_end' }, at);
      expect(farEndIsPaying(latch, at)).toBe(true);
    }
    expect(farEndIsPaying(latch, T0 + 60_000 + PAYER_FRESH_MS + 1)).toBe(false);
  });

  it('nothing was ever said ⇒ nothing is said', () => {
    expect(farEndIsPaying(null, T0)).toBe(false);
  });

  // A clock that steps backwards is a clock, not evidence that the far end
  // stopped paying. Deleting a true sentence because the machine's time moved is
  // the worse of the two failures.
  it('a frame stamped in the future is treated as fresh', () => {
    const far = foldBudgetFrame(null, { payer: 'far_end' }, T0 + 60_000);
    expect(farEndIsPaying(far, T0)).toBe(true);
  });
});

// ── card MP-8 — the mirror: the meter moves, and the words are not the owner's ──
//
// What these assertions are FOR: the same shape as MP-3 above, aimed the other
// way. `guest_speaker` is the ONLY thing on the wire that says an unsigned
// visitor's words are being charged to this computer (design §10-3
// 「不许由客户端推断」), so every branch here is either 「we were told」 or 「we were
// not told, and therefore say nothing」.

describe('MP-8 — reading `guest_speaker` off a budget frame', () => {
  it('reads the one shape the relay actually emits', () => {
    expect(asGuestSpeaker({ payer: 'self', guest_speaker: true })).toBe(true);
  });

  // 🔴 IT ONLY COUNTS ON A `payer:'self'` FRAME. That is the producer's whole
  // contract for the field (`payerHintFor` returns the pair, and the schema says
  // so in as many words), and reading it that way is what makes the two sentences
  // in this slot structurally unable to both be true — rather than merely being
  // told not to be.
  it.each([
    ['it rides on a far_end frame (self-contradictory)', { payer: 'far_end', guest_speaker: true }],
    ['it rides on a trial frame', { payer: 'trial', guest_speaker: true }],
    ['no payer word at all — an old relay', { guest_speaker: true }],
    ['the flag is absent', { payer: 'self', remaining_ms: 60_000 }],
    ['the flag is false', { payer: 'self', guest_speaker: false }],
    ['the flag is a truthy non-boolean', { payer: 'self', guest_speaker: 1 }],
    ['the flag is the STRING "false"', { payer: 'self', guest_speaker: 'false' }],
    ['null', null],
    ['not an object', 'guest'],
  ])('says nothing when %s', (_why, frame) => {
    expect(asGuestSpeaker(frame)).toBe(false);
  });
});

describe('MP-8 — the latch carries both words off the same frame', () => {
  it('a marked frame lights the guest sentence', () => {
    const latch = foldBudgetFrame(null, { payer: 'self', guest_speaker: true }, T0);
    expect(guestIsSpending(latch, T0)).toBe(true);
    // and never the other one: this end IS paying, which is the ordinary case.
    expect(farEndIsPaying(latch, T0)).toBe(false);
  });

  // 🔴 THE EDGE THAT NEEDS NO TIMER. The guest stops, the owner speaks, and the
  // very next heartbeat carries `payer:'self'` with no flag — which is a relay
  // saying 「no guest」, not a relay staying silent. Carrying the flag forward here
  // would leave 「a visitor is spending your plan」 on screen while the owner is
  // the one talking.
  it('an unmarked self frame puts it out immediately', () => {
    const lit = foldBudgetFrame(null, { payer: 'self', guest_speaker: true }, T0);
    const out = foldBudgetFrame(lit, { payer: 'self', remaining_ms: 60_000 }, T0 + 10_000);
    expect(guestIsSpending(out, T0 + 10_000)).toBe(false);
  });

  // A relay too old to send `payer` at all says nothing about either fact, so it
  // must not be able to delete a true sentence a newer frame put there.
  it('a frame with no payer word leaves the guest flag exactly as it was', () => {
    const lit = foldBudgetFrame(null, { payer: 'self', guest_speaker: true }, T0);
    expect(foldBudgetFrame(lit, { remaining_ms: 1 }, T0 + 5000)).toBe(lit);
    expect(guestIsSpending(lit, T0 + 5000)).toBe(true);
  });

  it('the far end paying and a guest spending are never both true', () => {
    for (const frame of [
      { payer: 'far_end' },
      { payer: 'far_end', guest_speaker: true },
      { payer: 'self', guest_speaker: true },
      { payer: 'self' },
      { payer: 'trial', guest_speaker: true },
    ]) {
      const latch = foldBudgetFrame(null, frame, T0);
      expect(farEndIsPaying(latch, T0) && guestIsSpending(latch, T0)).toBe(false);
    }
  });
});

describe('MP-8 — the same watchdog, because the relay still never says 「it ended」', () => {
  it('a guest sentence stops speaking once the frames stop', () => {
    const lit = foldBudgetFrame(null, { payer: 'self', guest_speaker: true }, T0);
    expect(guestIsSpending(lit, T0 + PAYER_FRESH_MS)).toBe(true);
    expect(guestIsSpending(lit, T0 + PAYER_FRESH_MS + 1)).toBe(false);
  });

  it('nothing was ever said ⇒ nothing is said', () => {
    expect(guestIsSpending(null, T0)).toBe(false);
  });
});

// ── card MP-10 — a DIFFERENT signed-in account, folded into MP-8's slot ─────
//
// What these assertions are FOR: `signed_in_speaker` is a second wire flag for
// the same question `guest_speaker` already answers — 「is somebody other than
// the owner spending this plan right now」 — so [`asSignedInSpeaker`] gets its
// own reader (mirroring `asGuestSpeaker`'s own tests above) but the OUTCOME is
// asserted through the exact same door as MP-8: `guestIsSpending`. Card G-2b2
// is precisely the claim that a caller cannot tell, from that boolean, which of
// the two wire flags lit it — and that is intentional, not a gap this file
// missed.

describe('MP-10 — reading `signed_in_speaker` off a budget frame', () => {
  it('reads the one shape the relay actually emits', () => {
    expect(asSignedInSpeaker({ payer: 'self', signed_in_speaker: true })).toBe(true);
  });

  // 🔴 SAME SCOPING AS `asGuestSpeaker`, for the same reason: `payerHintFor` only
  // ever emits this flag alongside `payer:'self'`.
  it.each([
    ['it rides on a far_end frame (self-contradictory)', { payer: 'far_end', signed_in_speaker: true }],
    ['it rides on a trial frame', { payer: 'trial', signed_in_speaker: true }],
    ['no payer word at all — an old relay', { signed_in_speaker: true }],
    ['the flag is absent', { payer: 'self', remaining_ms: 60_000 }],
    ['the flag is false', { payer: 'self', signed_in_speaker: false }],
    ['the flag is a truthy non-boolean', { payer: 'self', signed_in_speaker: 1 }],
    ['the flag is the STRING "false"', { payer: 'self', signed_in_speaker: 'false' }],
    ['null', null],
    ['not an object', 'colleague'],
  ])('says nothing when %s', (_why, frame) => {
    expect(asSignedInSpeaker(frame)).toBe(false);
  });

  // 🔴 THE TWO FLAGS DO NOT ADD UP. `payerHintFor` sets at most one per frame; a
  // frame claiming both is not a stronger signal, it is malformed, and reading
  // one flag must not be swayed by the other being present.
  it('does not read the sibling flag', () => {
    expect(asSignedInSpeaker({ payer: 'self', guest_speaker: true })).toBe(false);
    expect(asGuestSpeaker({ payer: 'self', signed_in_speaker: true })).toBe(false);
  });
});

describe('MP-10 — the same latch and the same sentence slot as MP-8', () => {
  it('lights the exact same predicate a guest frame would', () => {
    const bySignedIn = foldBudgetFrame(null, { payer: 'self', signed_in_speaker: true }, T0);
    expect(guestIsSpending(bySignedIn, T0)).toBe(true);
    expect(farEndIsPaying(bySignedIn, T0)).toBe(false);
  });

  // 🔴 REVERSE CONTROL FOR THIS CARD: this is the assertion that goes red if
  // `foldBudgetFrame` reads `asGuestSpeaker(frame)` alone and drops the
  // `|| asSignedInSpeaker(frame)` half — see `billing-payer-line.test.ts` for
  // the rendered-HTML twin of this same claim.
  it('a colleague speaking is not silently treated as nobody speaking', () => {
    const latch = foldBudgetFrame(null, { payer: 'self', signed_in_speaker: true }, T0);
    expect(guestIsSpending(latch, T0)).toBe(true);
  });

  it('the owner speaking again retires it with no timer needed', () => {
    const lit = foldBudgetFrame(null, { payer: 'self', signed_in_speaker: true }, T0);
    const out = foldBudgetFrame(lit, { payer: 'self', remaining_ms: 60_000 }, T0 + 10_000);
    expect(guestIsSpending(out, T0 + 10_000)).toBe(false);
  });

  it('same watchdog: it stops speaking once the frames stop', () => {
    const lit = foldBudgetFrame(null, { payer: 'self', signed_in_speaker: true }, T0);
    expect(guestIsSpending(lit, T0 + PAYER_FRESH_MS)).toBe(true);
    expect(guestIsSpending(lit, T0 + PAYER_FRESH_MS + 1)).toBe(false);
  });

  it('never true at the same moment as farEndIsPaying', () => {
    for (const frame of [
      { payer: 'far_end' },
      { payer: 'far_end', signed_in_speaker: true },
      { payer: 'self', signed_in_speaker: true },
      { payer: 'trial', signed_in_speaker: true },
    ]) {
      const latch = foldBudgetFrame(null, frame, T0);
      expect(farEndIsPaying(latch, T0) && guestIsSpending(latch, T0)).toBe(false);
    }
  });
});
