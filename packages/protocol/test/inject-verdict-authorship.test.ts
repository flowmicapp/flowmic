// Card F2 — guards for the `inject:result` verdict authorship table.
//
// owner's iron rule 2026-08-02: 「转录消息的状态一定要对。」("the status of a transcribed
// message must be correct.") This table is that iron rule's criterion at the
// settlement layer, and **a criterion is not allowed to be a guess**: adding a new
// error code without declaring its authorship must go red.
//
// Three guards, each biting a different thing:
//   ① `satisfies Record<ErrorCode, …>` (in the source file) — **compile time** full
//      coverage, tsc bites;
//   ② this file — **run time** full coverage + the three named sets equal
//      byte-for-byte (changing a set can only be a deliberate edit);
//   ③ apps/mobile/test/inject_verdict_authorship_mirror_test.dart — **cross-language**
//      mirror, checks the phone-side constant against this file's source.
//
// SPEC-REF: docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0.1 / §2.6

import { describe, expect, it } from 'vitest';
import { ERROR_CODE_LIST, ERROR_CODES } from '../src/error-codes';
import {
  INJECT_VERDICT_AUTHORSHIP,
  PC_ADMISSION_REFUSAL_CODES,
  PC_INJECTION_VERDICT_CODES,
  RELAY_AUTHORED_INJECT_RESULT_CODES,
  injectVerdictAuthorOf,
  isPcInjectionVerdictCode,
} from '../src/inject-verdict-authorship';

describe('inject verdict authorship — full-coverage guard', () => {
  it('every ERROR_CODE declares an authorship, no more and no fewer', () => {
    // 🔴 This is the run-time form of 「漏声明见红」("a missing declaration goes red").
    // tsc already bites the same thing, and the reason both are kept is the same as
    // the protocol-whitelist count guard: the type-layer guarantee does not exist
    // once `dist` is what gets consumed.
    const declared = Object.keys(INJECT_VERDICT_AUTHORSHIP).sort();
    const codes = [...ERROR_CODE_LIST].sort();
    expect(declared).toEqual(codes);
    expect(declared.length).toBe(Object.keys(ERROR_CODES).length);
  });

  it('there are only four authorship values, never a fifth', () => {
    const seen = new Set(Object.values(INJECT_VERDICT_AUTHORSHIP));
    for (const v of seen) {
      expect(['pc-injection', 'pc-admission', 'relay', 'none']).toContain(v);
    }
  });
});

describe('inject verdict authorship — the three named sets (a change must be deliberate)', () => {
  it('the injection-stage verdicts the PC answers itself are exactly these ten', () => {
    // Every one of these is labelled with its Rust emit site in the source file.
    // Adding one in = claiming 「收到这个码就算投递成功」("receiving this code counts as
    // a successful delivery"), a conclusion that requires re-grepping the emit site,
    // not casually adding a line.
    // 2026-08-02 F1a: `INJECT_SELF_WINDOW_NO_INPUT` is the eighth, emit site
    // `inject/pipeline.rs` `self_window_no_input` (← `self_window_stage0`).
    // It is the least doubtful entry in this table: the verdict is made **inside the
    // PC's own process**, and the frame obviously arrived.
    // 2026-08-07 MAC-05 (owner-approved 63/64): the ninth and tenth, emit site is the
    // same `inject/preflight.rs` `synthetic_input_verdict`, called from
    // `inject/pipeline.rs`'s `synthetic_input_preflight()` on **both the text and
    // image paths** — both after admission, inside the PC's own process, from two OS
    // reads. ⇒ same authorship class as the eight above.
    // ⚠️ The direct consequence of them entering this set is exactly what this card
    // wants: the phone queue **converges** (`kPcInjectionVerdictCodes` is a closed
    // set; an unrecognised code leaves the row permanently 「待投递」("pending
    // delivery")).
    expect([...PC_INJECTION_VERDICT_CODES].sort()).toEqual([
      'INJECT_CLIPBOARD_FAIL',
      'INJECT_DEFERRED_NOT_AUTOINJECTED',
      'INJECT_FOCUS_LOST',
      'INJECT_IMAGE_UNSUPPORTED',
      'INJECT_NO_ACCESSIBILITY',
      'INJECT_NO_TEXT_TARGET',
      'INJECT_SECURE_INPUT_ACTIVE',
      'INJECT_SELF_WINDOW_NO_INPUT',
      'INJECT_SENDINPUT_FAIL',
      'INJECT_TARGET_INVALID',
    ]);
  });

  it('the PC has exactly one admission-layer refusal, and it deliberately does not count as delivered', () => {
    expect([...PC_ADMISSION_REFUSAL_CODES]).toEqual(['INJECT_NOT_PRIMARY']);
    // 🔴 A reverse assertion, pinning down owner 2026-08-02's 「被占用 ⇒ 待投递」
    // ("occupied ⇒ pending delivery"): it is spoken by the PC itself, but
    // **it speaks about the admission layer**, so it must never be read as 「投递段
    // 完结」("delivery segment finished").
    expect(isPcInjectionVerdictCode('INJECT_NOT_PRIMARY')).toBe(false);
  });

  it('the nine relay-authored codes must never be read as a successful delivery', () => {
    expect([...RELAY_AUTHORED_INJECT_RESULT_CODES].sort()).toEqual([
      'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED',
      'INJECT_CLOUD_IMAGE_TOO_LARGE',
      'INJECT_FRAME_INVALID',
      'INJECT_FRAME_TOO_LARGE',
      'INJECT_NOT_IN_ROOM',
      'INJECT_PC_MISMATCH',
      'INJECT_PC_OFFLINE',
      'INJECT_PC_UNSPECIFIED',
      'INJECT_SERVER_BUSY',
    ]);
    for (const code of RELAY_AUTHORED_INJECT_RESULT_CODES) {
      expect(isPcInjectionVerdictCode(code), code).toBe(false);
    }
  });

  it('the three sets are pairwise disjoint', () => {
    const all = [
      ...PC_INJECTION_VERDICT_CODES,
      ...PC_ADMISSION_REFUSAL_CODES,
      ...RELAY_AUTHORED_INJECT_RESULT_CODES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('inject verdict authorship — the failure direction for an unknown code', () => {
  it('an unrecognised code has null authorship, and it does **not** count as delivered', () => {
    // 🔴 The second direction of red line R2: never claim something that did not
    // happen, happened. For a new code this end does not recognise, the only safe
    // reading is 「还欠着」("still owed") — that only reverts to today's behaviour,
    // whereas the reverse would falsely declare delivery out of nothing.
    for (const unknown of ['INJECT_SOMETHING_NEW', 'LINK_DOWN', 'INJECT_NO_RESULT', '']) {
      expect(injectVerdictAuthorOf(unknown), unknown).toBeNull();
      expect(isPcInjectionVerdictCode(unknown), unknown).toBe(false);
    }
  });

  it('the two phone-local terminal codes are not in the table (they never cross the wire)', () => {
    // outbox_item.dart's own text spells out why they never enter ERROR_CODES; this
    // pins that down too, so nobody moves the queue's internal state into the
    // protocol table for the sake of 「统一」("uniformity").
    expect(injectVerdictAuthorOf('OUTBOX_OVERFLOW')).toBeNull();
    expect(injectVerdictAuthorOf('OUTBOX_IMAGE_BYTES_GONE')).toBeNull();
  });
});
