// L8 — `inject:request.inject_origin`, pinned as a CONTRACT.
//
// owner's 2026-08-02 ruling (docs/decisions/2026-08-02-deferred-delivery-must-not-
// autoinject.md):「之前没发送成功、后面（连上网）补投到 PC 的消息，PC 端不能随便注入
// ……直接注进当前输入窗口可能引起事故。」 The frame therefore has to say WHY it is on
// the wire, and the receiver refuses to type an automatic re-delivery.
//
// This file is the SSOT the three ends are written against: the phone stamps it
// (apps/mobile outbox_inject_origin.dart + the three live emit sites), the relay
// forwards it verbatim (`parsed.data`), the desktop reads it
// (src-tauri/src/socket/wire.rs → inject/pipeline.rs). A drift shows up here rather
// than as a frame one end sends and another silently strips.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.5; the two-part terminology contract
//   (docs/decisions/2026-08-02-delivery-vs-injection-terminology-contract.md).

import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../src/error-codes';
import { EVENT_NAMES, EVENT_SCHEMAS } from '../src/index';

const schema = EVENT_SCHEMAS['inject:request'];

/** What a 0.2.47 phone puts on the wire — the compatibility floor for this card. */
const LEGACY_FRAME = {
  text: '你好世界',
  source: 'stt',
  request_id: 'u12-1753900000000',
  entry_id: 'loc_d_u12',
  target_pc_id: 'pc-0123',
} as const;

describe('inject_origin — additive, and a pre-0.2.48 frame is untouched', () => {
  it('the pre-card frame still parses to EXACTLY its own keys', () => {
    // The claim is 「逐字节照旧」, so assert the OUTPUT rather than success: a
    // `.default('live')` here would put a value on a frame the phone never said,
    // and the receiver's 「这一帧没说」 branch would become unreachable — i.e. the
    // ONE state that tells us a relay stripped the field would stop existing.
    const parsed = schema.parse(LEGACY_FRAME);
    expect(parsed).toEqual(LEGACY_FRAME);
    expect(Object.keys(parsed)).not.toContain('inject_origin');
  });

  it('accepts both values and nothing else', () => {
    for (const v of ['live', 'deferred']) {
      expect(schema.safeParse({ ...LEGACY_FRAME, inject_origin: v }).success, v).toBe(true);
    }
    // A third value is not a third policy — it is a sender this receiver cannot
    // reason about, and the safe reading of an unknown intent does not exist.
    // Refused at the boundary rather than quietly coerced.
    for (const v of ['auto', 'manual', 'LIVE', '', 1, true, null]) {
      expect(schema.safeParse({ ...LEGACY_FRAME, inject_origin: v }).success, String(v)).toBe(false);
    }
  });

  it('survives a round trip verbatim on BOTH values', () => {
    for (const v of ['live', 'deferred'] as const) {
      const parsed = schema.parse({ ...LEGACY_FRAME, inject_origin: v });
      expect(parsed).toEqual({ ...LEGACY_FRAME, inject_origin: v });
    }
  });

  it('is orthogonal to `source` — every pairing is legal', () => {
    // 🔴 The whole reason this is its own field. `source` says where the BYTES came
    // from; this says whether a user is standing there expecting them. They
    // disagree in both directions and neither may be derived from the other:
    //   · source:'stt' + deferred   — the queued utterance that finally drained;
    //   · source:'history' + live   — a backfill the user just pressed.
    for (const source of ['stt', 'llm', 'manual', 'history']) {
      for (const inject_origin of ['live', 'deferred']) {
        expect(
          schema.safeParse({ ...LEGACY_FRAME, source, inject_origin }).success,
          `${source}/${inject_origin}`,
        ).toBe(true);
      }
    }
  });

  it('rides an image frame too — a picture pasted unexpectedly is the same accident', () => {
    const img = {
      text: '', source: 'image', request_id: 'r1', target_pc_id: 'pc-0123',
      entry_type: 'image', image_b64: 'QUJDRA==', image_mime: 'image/png',
      inject_origin: 'deferred',
    };
    expect(schema.safeParse(img).success).toBe(true);
  });
});

describe('inject_origin — the field-add is ADDITIVE at the event level', () => {
  it('adds no socket event', () => {
    // 54 is asserted by events-count.test.ts; this states the LOCAL claim — that
    // this card introduced no name — where the card's own reader will look.
    expect(EVENT_NAMES).toContain('inject:request');
    expect(EVENT_NAMES.filter((e) => e.startsWith('inject:'))).toEqual([
      'inject:request', 'inject:result',
    ]);
  });

  it('the deferred refusal has its own code, distinct from the other cached cause', () => {
    // rebuild doc 15: `cached` now has TWO causes and they must stay distinguishable —
    // 「找不到焦点」 (click into a box and it lands) vs 「这是补投，刻意没注」 (nothing
    // about the window helps). One status word must not answer two questions.
    expect(ERROR_CODES.INJECT_DEFERRED_NOT_AUTOINJECTED).toBeDefined();
    expect(ERROR_CODES.INJECT_DEFERRED_NOT_AUTOINJECTED.zh_CN)
      .not.toBe(ERROR_CODES.INJECT_FOCUS_LOST.zh_CN);
    // 🔴 It is NOT a failure sentence. The delivery succeeded; only the injection
    // was withheld. A copy that says 「未送达/失败」 would be false, and any renderer
    // shows these verbatim.
    for (const locale of ['zh_CN', 'en'] as const) {
      const msg = ERROR_CODES.INJECT_DEFERRED_NOT_AUTOINJECTED[locale];
      expect(msg.length).toBeGreaterThan(0);
      expect(/失败|未送达|not delivered|failed/i.test(msg), `${locale}: ${msg}`).toBe(false);
    }
  });

  it('🔴 the copy promises NO action, because the action does not exist for image rows', () => {
    // THE BUG THIS PINS, in the words of the red line it would break: 「文案承诺一个
    // 不存在的动作」. The first draft said 「请在电脑的时间线上点『重新注入』」 — true for a
    // transcript row, FALSE for a picture one:
    //   · TimelinePage.vue `rowCanReinject` = `entry_type !== 'image' && …` ⇒ an
    //     image row renders no such button at all;
    //   · and on the phone this verdict settles the queue item terminally, so
    //     `resendableImageEntryIds` (which requires `isPending`) drops it too.
    // The gap is real and is logged at the code; what must never happen again is a
    // SENTENCE that sends the user to look for a button that is not drawn.
    for (const locale of ['zh_CN', 'en'] as const) {
      const msg = ERROR_CODES.INJECT_DEFERRED_NOT_AUTOINJECTED[locale];
      expect(/重新注入|re-inject|重发|resend/i.test(msg), `${locale}: ${msg}`).toBe(false);
    }
  });
});
