// 卡 fix-019 — the guard for the four error codes and the one enum value owner
// approved on 2026-08-10 (docs/decisions/2026-08-10-owner-ruling-requests-from-
// lan-window.md, result table at the top, per-code reasoning in 一 #5).
//
// ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
//
// The registration itself is already guarded three ways: the catalog count in
// error-codes.test.ts, the compile-time `satisfies Record<ErrorCode, …>` in
// inject-verdict-authorship.ts, and the `i18n-error-keys` lint. None of those can
// see the two properties that make THIS round dangerous:
//
//   ① the four codes have ZERO PRODUCERS today, which is normally the façade
//      shape this repo deletes codes for. It is accepted here only because
//      fix-020…fix-024 are carded and depend on this card — so the accepted state
//      has to be MEASURED and re-read, not remembered. What is pinned below is the
//      consequence of that state (`authorship = 'none'` for all four), so the day
//      a producer puts one of them on `inject:result`, a test goes red and the
//      person reading it is sent to the three-part checklist at
//      `PC_IMAGE_STORE_FAILED` in inject-verdict-authorship.ts — instead of the
//      phone quietly showing 「待投递」 forever (the 0.2.48 P0);
//
//   ② the ≤28-character NAME LIMIT is a product constraint with a shipped
//      release behind it (0.2.53 rendered a code as three letters), and NOTHING
//      in the repo measures it. `chat_message_tile.dart` `_truncateFailureReason`
//      cuts a raw code at 28; the drafted `INJECT_ACCESSIBILITY_NOT_GRANTED` (32)
//      was renamed to `INJECT_NO_ACCESSIBILITY` (23) by hand, remembered by one
//      person, on the one failure a user can actually fix.
//
// 🔴 THE LIMIT IS NOT ASSERTED OVER THE WHOLE TABLE, AND THAT IS DELIBERATE.
// Two existing keys are already over it. Making them pass would mean renaming
// live protocol values to satisfy a new test — the ruler dictating the product —
// so instead the exceptions are pinned BY NAME: adding a THIRD over-length code
// turns that set assertion red, which is the moment somebody must argue it.
//
// SPEC-REF:
//   packages/protocol/src/error-codes.ts             (the registry + per-code argument)
//   packages/protocol/src/inject-verdict-authorship.ts (segment truth)
//   packages/protocol/src/protocol-schemas-audio.ts  (the enum value)

import { describe, it, expect } from 'vitest';
import { ERROR_CODES, ERROR_CODE_LIST, type ErrorCode } from '../src/error-codes';
import {
  PC_ADMISSION_REFUSAL_CODES,
  PC_INJECTION_VERDICT_CODES,
  RELAY_AUTHORED_INJECT_RESULT_CODES,
  injectVerdictAuthorOf,
  isPcInjectionVerdictCode,
} from '../src/inject-verdict-authorship';
import { EVENT_SCHEMAS } from '../src/protocol-schemas';

/** The four, with the length each was CHOSEN at — not computed here on purpose. */
const APPROVED_2026_08_10: ReadonlyArray<readonly [ErrorCode, number]> = [
  ['REGISTER_EMAIL_INVALID', 22],
  ['LAN_CERT_PIN_MISMATCH', 21],
  ['STT_NO_ENGINE_REACHED', 21],
  ['PC_IMAGE_STORE_FAILED', 21],
] as const;

/** `chat_message_tile.dart` `_truncateFailureReason`: `reason.length <= 28`. */
const PHONE_RAW_CODE_CHARS = 28;

/**
 * The two keys already over the limit, and why each is tolerated rather than
 * renamed. Both were checked at the surface, not assumed:
 *   · INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED (33) — has human copy in the phone's
 *     `cloudImageRelayErrorNote`, so the raw identifier is never rendered;
 *   · INJECT_DEFERRED_NOT_AUTOINJECTED (32) — has a face of its own
 *     (`status_badge.dart` `_isDeferredNotInjectedReason`) and is excluded from
 *     `_reasonLineFor`'s raw-identifier branch by three numbered arguments there.
 */
const KNOWN_OVERLONG_CODES: readonly string[] = [
  'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED',
  'INJECT_DEFERRED_NOT_AUTOINJECTED',
];

describe('fix-019 · the four codes owner approved on 2026-08-10', () => {
  it('all four are registered and carry a non-empty zh_CN + en message', () => {
    for (const [code] of APPROVED_2026_08_10) {
      expect(ERROR_CODE_LIST, code).toContain(code);
      expect(ERROR_CODES[code].zh_CN.trim().length, `${code} zh_CN`).toBeGreaterThan(0);
      expect(ERROR_CODES[code].en.trim().length, `${code} en`).toBeGreaterThan(0);
      // Positive control on the pair itself: a copy-paste that left both halves
      // identical would satisfy every emptiness check above and ship one language.
      expect(ERROR_CODES[code].zh_CN, `${code} zh_CN === en`).not.toBe(ERROR_CODES[code].en);
    }
  });

  it('🔴 every new name fits the phone\'s 28-character raw-code slot', () => {
    for (const [code, expectedLength] of APPROVED_2026_08_10) {
      // The exact length is asserted, not just the ceiling: a rename that stays
      // under 28 is fine, but it should be a DELIBERATE edit of this line rather
      // than something that slides through because it happens to still fit.
      expect(code.length, `${code} length`).toBe(expectedLength);
      expect(code.length, `${code} exceeds the phone slot`).toBeLessThanOrEqual(PHONE_RAW_CODE_CHARS);
    }
    // Positive control — the guard must be able to FAIL. This is the name that
    // was actually drafted and rejected in the 62→64 window; if the ceiling ever
    // stopped being enforced, this line would be the one that noticed.
    expect('INJECT_ACCESSIBILITY_NOT_GRANTED'.length).toBeGreaterThan(PHONE_RAW_CODE_CHARS);
  });

  it('the over-28 exceptions are exactly the two known ones (a third must be argued)', () => {
    const over = ERROR_CODE_LIST.filter((c) => c.length > PHONE_RAW_CODE_CHARS).sort();
    expect(over).toEqual([...KNOWN_OVERLONG_CODES].sort());
  });

  it('PC_IMAGE_STORE_FAILED is deliberately NOT in the INJECT_ namespace', () => {
    // The prefix is not decoration: when a code has no human copy the phone
    // renders the identifier itself, so the namespace is the first thing the user
    // reads. `INJECT_*` claims 「这一句有没有打进那个窗口」; this code answers
    // 「电脑有没有把这张图留下来」, and the two come apart (the paste can succeed
    // while the write fails). Pinned so 「统一一下前缀」 cannot happen quietly.
    expect('PC_IMAGE_STORE_FAILED'.startsWith('INJECT_')).toBe(false);
  });
});

describe('fix-019 · zero producers today, and the pin that says so', () => {
  it('🔴 all four are authorship `none` — none of them rides inject:result', () => {
    // 🔴 IF YOU ARE HERE BECAUSE THIS WENT RED, READ THIS BEFORE CHANGING IT.
    // Flipping one of these to `pc-injection` is legitimate — it is exactly what
    // fix-021 may need for PC_IMAGE_STORE_FAILED — but it is NOT a one-line edit.
    // Three things move in the same commit, and the second one is the one that
    // gets forgotten:
    //   ① this expectation and the row in inject-verdict-authorship.ts;
    //   ② `kPcInjectionVerdictCodes` in
    //      apps/mobile/lib/src/session/outbox_inject_authorship.dart — a CLOSED
    //      set. A code missing from it settles back to `queued`, so the row reads
    //      「待投递」 forever while the message is already on the user's PC;
    //   ③ four-language copy in `injectVerdictNote`
    //      (apps/mobile/lib/src/settings/strings/inject_note_strings.dart), which
    //      `error_code_copy_binding_test.dart` demands the moment authorship is
    //      not 'none'.
    // The long form of the argument, including why `pc-admission` would be false,
    // is at PC_IMAGE_STORE_FAILED in inject-verdict-authorship.ts.
    for (const [code] of APPROVED_2026_08_10) {
      expect(injectVerdictAuthorOf(code), code).toBe('none');
      expect(isPcInjectionVerdictCode(code), code).toBe(false);
    }
  });

  it('this round added nothing to the three inject-verdict families', () => {
    // The mirror direction of the test above, and the reason it is separate: the
    // per-code assertion would still pass if somebody added one of the four to a
    // family AND removed another. These three counts are what the phone's mirror
    // (`outbox_inject_authorship.dart`) and the Rust/Dart cross-language guards
    // are keyed to, so a change in any of them has to be a deliberate edit here.
    expect(PC_INJECTION_VERDICT_CODES).toHaveLength(10);
    expect(PC_ADMISSION_REFUSAL_CODES).toHaveLength(1);
    expect(RELAY_AUTHORED_INJECT_RESULT_CODES).toHaveLength(9);
  });
});

describe('fix-019 · the codes these four displace are untouched', () => {
  // 🔴 「加一个新码」("add a new code") and 「顺手改掉旧码那句话」("and, while at it,
  // change what an old code's sentence says") are two different changes, and only
  // the first one was approved. Each string below is the sentence the new code
  // takes work AWAY from — the exact place a well-meaning edit would land — so
  // they are pinned verbatim. fix-022 in particular is required to leave
  // STT_NETWORK_DROP meaning precisely what it means today.
  it('STT_NETWORK_DROP still says what it said (fix-022 narrows what reaches it)', () => {
    expect(ERROR_CODES.STT_NETWORK_DROP.zh_CN).toBe('网络中断，识别会话终止。');
    expect(ERROR_CODES.STT_NETWORK_DROP.en).toBe('Network drop, STT session terminated.');
  });

  it('SETTINGS_SCHEMA_INVALID still says what it said (fix-023 stops borrowing it)', () => {
    expect(ERROR_CODES.SETTINGS_SCHEMA_INVALID.zh_CN).toBe('设置内容不合法。');
    expect(ERROR_CODES.SETTINGS_SCHEMA_INVALID.en).toBe('Settings payload invalid.');
  });

  it('INJECT_IMAGE_UNSUPPORTED still says what it said (fix-021 does not reuse it)', () => {
    expect(ERROR_CODES.INJECT_IMAGE_UNSUPPORTED.zh_CN).toBe('图片注入失败。');
    expect(ERROR_CODES.INJECT_IMAGE_UNSUPPORTED.en).toBe('Image injection failed.');
  });
});

describe('fix-019 · audio:auto-stopped gains `quota_exhausted` (ruling #5-a)', () => {
  const schema = EVENT_SCHEMAS['audio:auto-stopped'];

  it('the new reason parses', () => {
    expect(schema.safeParse({ reason: 'quota_exhausted' }).success).toBe(true);
  });

  it('all four pre-existing reasons still parse — the widening is additive', () => {
    for (const reason of ['hard_limit', 'mobile_disconnect', 'engine_failed', 'auth_expired']) {
      expect(schema.safeParse({ reason }).success, reason).toBe(true);
    }
  });

  it('the enum is still CLOSED — an unknown reason is still refused', () => {
    // The negative control the additive claim needs. If this ever passes, the
    // field has been loosened to a free string and 「没有静默失败」 loses the
    // boundary that makes an unknown origin a visible failure rather than a
    // value that quietly rides through (fix-020 is forbidden from mapping an
    // unknown origin onto an existing reason precisely because this holds).
    expect(schema.safeParse({ reason: 'other' }).success).toBe(false);
    expect(schema.safeParse({ reason: 'quota_budget' }).success).toBe(false);
  });

  it('`quota_budget` is an ORIGIN and is deliberately not the reason value', () => {
    // `HardLimitOrigin` ('engine_session' | 'quota_budget', stt/audio/session.ts)
    // answers 「这个上限是哪来的」; `reason` answers 「录音为什么停了」. The assertion
    // above already proves the origin name is not accepted here; this one records
    // WHY that is correct rather than an oversight, so nobody "fixes" it by
    // widening the enum to accept both spellings — which would be one field
    // answering two questions, in two files.
    expect(schema.safeParse({ reason: 'quota_exhausted' }).success).toBe(true);
  });
});
