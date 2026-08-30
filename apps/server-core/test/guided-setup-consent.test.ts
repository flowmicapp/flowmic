// SPEC-REF:
//   src/billing/guided-setup.ts (the wording, and its immutability doctrine)
//   src/mail/service-mailer.ts (the two letters gs-5 promises)
//   Directive 2011/83/EU art. 7(3), 11a, 16(a)
//
// WHAT A BUYER AGREED TO, AND WHAT WE SAID BACK.
//
// 🔴 §1 IS THE MECHANISM BEHIND A DOCTRINE THAT WAS OTHERWISE ONLY A COMMENT.
// guided-setup.ts insists that a published version's text is IMMUTABLE — that a
// stamp stored against `gs-2` keeps meaning the words gs-2 had that day. Until
// this file that rule was enforced by nobody: any edit to those strings would
// have retroactively changed what every stored stamp attested to, silently, and
// every test in this repo would have stayed green.
//
// Adding a NEW version is one new line here. Changing an OLD one turns this red,
// which is exactly the asymmetry the doctrine asks for.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GUIDED_SETUP_AFTERCARE_DAYS,
  GUIDED_SETUP_CONSENT_TEXT,
  GUIDED_SETUP_CONSENT_VERSION,
  GUIDED_SETUP_META,
  PROMISED_DEADLINES,
} from '../src/billing/guided-setup';
import {
  buildServiceWithdrawalEmail,
  buildSetupCompletedEmail,
  WITHDRAWAL_DECLARATION,
} from '../src/mail/service-mailer';

// 🔴 THE SEPARATOR IS A VISIBLE LITERAL, and that is not fussiness. The first
// version of this function joined the three affirmations with what LOOKED like
// a space and was actually a NUL byte — same length, different hash, invisible
// in every editor. The pins below disagreed with a second computation of the
// same thing and it took a byte dump to see why. A separator you can read is a
// separator you can check.
const SEP = "|";

function digest(version: string): string {
  const t = GUIDED_SETUP_CONSENT_TEXT[version]!;
  return createHash("sha256")
    .update([t.earlyStart, t.waiverAck, t.whatRemains].join(SEP))
    .digest("hex")
    .slice(0, 16);
}

describe('§1 🔴 a published version’s text never changes', () => {
  // ⚠️ IF ONE OF THESE FAILS, THE FIX IS ALMOST NEVER TO UPDATE THE HASH. It is
  // to put the edit in a NEW version and bump GUIDED_SETUP_CONSENT_VERSION —
  // because somewhere there may be a stored stamp asserting that a person
  // agreed to the old words. Updating a hash here rewrites what that person
  // agreed to, after the fact, in their absence.
  // 🔴 LITERALS, computed once from the file as committed on 2026-08-30. A first
  // draft of this block derived them from the same table it was checking, which
  // is a test that compares a file to itself and passes forever. It is written
  // down here because that is the only version of this test that can fail.
  const PINNED: Record<string, string> = {
    'gs-1': '891bf66a9c400b73',
    'gs-2': 'e4b45ae7861a0386',
    'gs-3': '25b6932c331c826e',
    'gs-4': 'ab44683d7153dce8',
    // 2026-08-30 — computed from the contract's canonical strings, not from the
    // table (§2 below also compares the table to those strings byte for byte).
    'gs-5': '9135bb8422207e64',
  };

  for (const version of Object.keys(PINNED)) {
    it(`${version} still says exactly what it said`, () => {
      expect(digest(version)).toBe(PINNED[version]);
    });
  }

  it('every version in the table is one this test knows about', () => {
    // The guard against a version arriving with no pin: a new entry has to be
    // registered here, which is the moment somebody reads this paragraph.
    expect(Object.keys(GUIDED_SETUP_CONSENT_TEXT).sort()).toEqual(Object.keys(PINNED).sort());
  });

  it('and every one of them is complete — three separate affirmations, none empty', () => {
    for (const [version, text] of Object.entries(GUIDED_SETUP_CONSENT_TEXT)) {
      expect(text.earlyStart.length, version).toBeGreaterThan(40);
      expect(text.waiverAck.length, version).toBeGreaterThan(40);
      expect(text.whatRemains.length, version).toBeGreaterThan(40);
      // 🔴 THE TWO AFFIRMATIONS DO DIFFERENT LEGAL WORK AND MUST STAY DISTINCT.
      // A merged checkbox could not evidence either one cleanly.
      expect(text.earlyStart, version).not.toBe(text.waiverAck);
    }
  });
});

/**
 * 🔴 THE CONTRACT'S CANONICAL gs-5 STRINGS, COPIED HERE VERBATIM — NOT imported
 * from the table. §2 compares the table to these byte for byte. A test that
 * read the expected text from the thing it was checking would pass forever;
 * this one fails the moment somebody 「tidies」 a word in guided-setup.ts.
 * (setup-service-contract-v1 §2, 2026-08-30.)
 */
const GS5 = {
  earlyStart:
    'I ask FlowMic to begin this setup service before the 14-day withdrawal period ends, so that it can be scheduled straight away rather than after that period.',
  waiverAck:
    'I understand that once FlowMic confirms my setup is complete, I can no longer withdraw from this service. FlowMic will email me when that happens, and the two weeks of support that follow are help, not a refund period.',
  whatRemains:
    'Until then you can get all of your money back at any time, from your console, without giving a reason — you have to ask; we do not assume. If we have not started within 14 days of your order, we refund you without being asked. We issue the refund ourselves; if the payment channel cannot return it the way you paid, we will arrange another way with you. After the two weeks of support the service is closed; you can still email us if you need help. This does not affect your legal rights: if the setup was not provided as described, was not delivered, or does not work, you keep every remedy the law gives you and we will put it right or refund you.',
} as const;

describe('§2 the current wording is gs-5, and it says the things it has to', () => {
  const current = GUIDED_SETUP_CONSENT_TEXT[GUIDED_SETUP_CONSENT_VERSION]!;

  it('is gs-5', () => {
    // ⚠️ A DELIBERATE PIN. Bumping the version is a change to a consumer
    // contract; this line is what makes that an act rather than a side effect.
    expect(GUIDED_SETUP_CONSENT_VERSION).toBe('gs-5');
    expect(GUIDED_SETUP_CONSENT_TEXT[GUIDED_SETUP_CONSENT_VERSION]).toBeDefined();
  });

  it('🔴 is byte-identical to the contract’s canonical text', () => {
    expect(current.earlyStart).toBe(GS5.earlyStart);
    expect(current.waiverAck).toBe(GS5.waiverAck);
    expect(current.whatRemains).toBe(GS5.whatRemains);
  });

  it('🔴 does NOT purport to shut out statutory remedies', () => {
    // Kept from gs-4: an unqualified 「cannot be refunded」 reads as a term
    // excluding remedies a consumer keeps by law however old the purchase —
    // the shape Directive 93/13/EEC Annex 1(b) names as potentially unfair.
    // Completion ends 「changed my mind」; it does not end 「it does not work」.
    expect(current.whatRemains).toContain('does not affect your legal rights');
    expect(current.whatRemains).toContain('not provided as described');
  });

  it('① asks to begin inside the withdrawal period (CRD art. 7(3))', () => {
    expect(current.earlyStart).toContain('before the 14-day withdrawal period ends');
  });

  it('② ties the loss of the right to CONFIRMED COMPLETION, and names the fortnight as help', () => {
    // 🔴 THE WHOLE POINT OF gs-5 (owner 2026-08-30). gs-3/gs-4 tied it to an
    // email plus fourteen days; now completion itself ends it, the email is how
    // the buyer learns of it, and the two weeks after are support only.
    expect(current.waiverAck).toContain('once FlowMic confirms my setup is complete');
    expect(current.waiverAck).toContain('no longer withdraw');
    expect(current.waiverAck).toContain('email');
    expect(current.waiverAck).toContain('help, not a refund period');
    // And it does NOT promise a period after the email in which to withdraw.
    expect(current.waiverAck).not.toContain('days after that email');
  });

  it('③ promises a full refund before then, from the console, with no reason asked — and says the buyer has to ask', () => {
    expect(current.whatRemains).toContain('all of your money back');
    expect(current.whatRemains).toContain('without giving a reason');
    expect(current.whatRemains).toContain('you have to ask; we do not assume');
  });

  it('③ promises ONE unasked deadline (no-start), the channel fallback, and that the service closes', () => {
    expect(current.whatRemains).toContain(`within ${PROMISED_DEADLINES.startDeadlineDays} days of your order`);
    // 🔴 THE 40-DAY FIGURE IS INTERNAL AND MUST NOT BE IN THE COPY (gs-5).
    expect(current.whatRemains).not.toContain('40 days');
    expect(current.whatRemains).not.toContain('never send that email');
    // The one sentence that commits us to doing something by hand when the
    // payment channel cannot pay somebody back the way they paid.
    expect(current.whatRemains).toContain('arrange another way');
    expect(current.whatRemains).toContain('After the two weeks of support the service is closed');
  });

  it('the aftercare period is fourteen days, and it is the only post-completion number', () => {
    expect(GUIDED_SETUP_AFTERCARE_DAYS).toBe(14);
    expect(PROMISED_DEADLINES).not.toHaveProperty('disputeDays');
  });

  it('the metadata keys are prefixed so ours are distinguishable', () => {
    expect(GUIDED_SETUP_META.consentVersion).toMatch(/^fm_/);
    expect(GUIDED_SETUP_META.earlyStartAt).toMatch(/^fm_/);
    expect(GUIDED_SETUP_META.waiverAckAt).toMatch(/^fm_/);
  });
});

describe('§3 the completion notice says what the wording promises it says', () => {
  const mail = buildSetupCompletedEmail({
    to: 'buyer@example.test',
    orderId: 'ord_1',
    aftercareDays: GUIDED_SETUP_AFTERCARE_DAYS,
  });

  it('names the order and the two weeks of support', () => {
    expect(mail.to).toBe('buyer@example.test');
    expect(mail.text).toContain('ord_1');
    expect(mail.text).toContain('For the next two weeks');
    expect(mail.text).toContain('reply to this email');
  });

  it('🔴 says the refund is CLOSED, out loud, and keeps the legal-rights carve-out', () => {
    // This is the letter that tells the buyer their right has ended (gs-5 ②).
    // A notice that ended a right without naming it would be worse than no
    // notice: it would look like we told them.
    expect(mail.text).toContain('refunds for this service are');
    expect(mail.text).toContain('closed');
    expect(mail.text).toContain('This does not affect your legal rights');
    // And it does NOT offer money back from the console any more.
    expect(mail.text).not.toContain('all of your money');
    expect(mail.text).not.toContain('final and cannot be refunded');
  });

  it('says the service closes after the support period', () => {
    expect(mail.text).toContain('After those two weeks of support the service is closed');
  });

  it('has a subject that survives a full inbox', () => {
    expect(mail.subject).toContain('complete');
    expect(mail.subject.length).toBeGreaterThan(20);
  });
});

describe('§4 the withdrawal acknowledgement (CRD art. 11a)', () => {
  it('🔴 carries the DATE AND TIME it was submitted, not just the date', () => {
    // CRD art. 11(3) wants the date AND time. A date alone cannot settle a
    // dispute about a deadline that expires at a moment rather than on a day —
    // and this printed the date alone until 2026-08-30.
    const mail = buildServiceWithdrawalEmail({
      to: 'buyer@example.test',
      orderId: 'ord_1',
      receivedAt: '2026-09-15T13:22:00.000Z',
      amountMinor: 20000,
      currency: 'USD',
    });
    expect(mail.text).toContain('2026-09-15');
    expect(mail.text).toContain('13:22');
    // ⚠️ AND THE ZONE. 「13:22」 with no zone is the same defect one unit down:
    // the reader cannot tell whether a deadline was met.
    expect(mail.text).toContain('UTC');
    expect(mail.text).toContain('ord_1');
  });

  it('🔴 reproduces the CONTENT of the declaration', () => {
    // The third thing art. 11(3) asks for, and the one an acknowledgement is
    // least likely to have: not just THAT they withdrew and when, but what they
    // said. The console shows this same sentence before they confirm.
    const mail = buildServiceWithdrawalEmail({
      to: 'b@e.test',
      orderId: 'ord_1',
      receivedAt: '2026-09-15T13:22:00.000Z',
      amountMinor: null,
      currency: null,
    });
    expect(mail.text).toContain(WITHDRAWAL_DECLARATION);
    expect(WITHDRAWAL_DECLARATION).toContain('I hereby withdraw');
  });

  it('⚠️ and the COMPLETION notice still carries a date only', () => {
    // Two functions because they answer two questions: that message starts a
    // fortnight, not a deadline measured in hours, and a timestamp there would
    // imply a precision the promise does not have.
    const notice = buildSetupCompletedEmail({ to: 'b@e.test', orderId: 'o', aftercareDays: 14 });
    expect(notice.text).not.toContain('UTC');
  });

  it('🔴 says REQUESTED, never REFUNDED — the money has not moved yet', () => {
    const mail = buildServiceWithdrawalEmail({
      to: 'b@e.test',
      orderId: 'ord_1',
      receivedAt: '2026-09-15T00:00:00.000Z',
      amountMinor: 20000,
      currency: 'USD',
    });
    expect(mail.text).toContain('We have asked our payment provider to return');
    // The claim a reader could check and find false, in the artefact they keep.
    expect(mail.text).not.toContain('We have refunded');
    expect(mail.text).not.toContain('has been refunded');
  });

  it('prints the amount with a currency CODE, and copes with not knowing it', () => {
    const withAmount = buildServiceWithdrawalEmail({
      to: 'b@e.test',
      orderId: 'o',
      receivedAt: '2026-09-15T00:00:00.000Z',
      amountMinor: 20000,
      currency: 'USD',
    });
    expect(withAmount.text).toContain('USD 200.00');
    const without = buildServiceWithdrawalEmail({
      to: 'b@e.test',
      orderId: 'o',
      receivedAt: '2026-09-15T00:00:00.000Z',
      amountMinor: null,
      currency: null,
    });
    // 🔴 A DIFFERENT SENTENCE, not the same one with a hole in it. 「return your
    // payment of 」 with nothing after it is the shape R11 exists to stop.
    expect(without.text).toContain('return your payment in full');
    expect(without.text).not.toContain('undefined');
    expect(without.text).not.toContain('null');
  });

  it('keeps the promise about a channel that cannot pay you back', () => {
    const mail = buildServiceWithdrawalEmail({
      to: 'b@e.test',
      orderId: 'o',
      receivedAt: '2026-09-15T00:00:00.000Z',
      amountMinor: 1,
      currency: 'EUR',
    });
    expect(mail.text).toContain('arrange another way');
    expect(mail.text).toContain('You do not need to chase us');
  });

  it('and neither letter has an HTML part or a name in it', () => {
    // Both copied from the siblings for their mechanical reasons: an HTML mail
    // is the shape phishing filters are tuned for, and `display_name` is
    // unverified, so putting it in a message is a small self-service phishing kit.
    const a = buildSetupCompletedEmail({ to: 'b@e.test', orderId: 'o', aftercareDays: 14 });
    const b = buildServiceWithdrawalEmail({
      to: 'b@e.test',
      orderId: 'o',
      receivedAt: '2026-09-15T00:00:00.000Z',
      amountMinor: null,
      currency: null,
    });
    for (const m of [a, b]) {
      expect(m).not.toHaveProperty('html');
      expect(m.text).not.toContain('<');
    }
  });
});
