// IJ-01 — `inject:result.focus_window` / `.focus_evidence`, pinned as a CONTRACT.
//
// owner 2026-08-07 裁定④ (docs/decisions/2026-08-07-owner-inject-status-wording-
// evidence-and-window-title.md; design §4-3/§4-4/§4-5). Two additive optional keys
// so a delivery that was NOT injected can still say 「注到哪个窗口 / 什么状态 /
// 什么结果」 — the desktop had both facts on every attempt and threw them away on
// every non-success.
//
// This file is the SSOT the three ends are written against: the desktop produces
// them (src-tauri/src/socket/wire.rs `build_inject_result`, one producer), the
// relay forwards `parsed.data`, the phone and the PC's own timeline render them.
// A drift shows up here rather than as a frame one end sends and another strips.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (F-3112 inject_target
//   provenance — deliberately NOT widened by this round).

import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMAS } from '../src/index';

const schema = EVENT_SCHEMAS['inject:result'];

/** What a 0.2.58 desktop puts on the wire today — the compatibility floor. */
const LEGACY_RESULT = {
  ok: false,
  mode: 'cached',
  error: 'INJECT_FOCUS_LOST',
  request_id: 'u12-1753900000000',
  entry_id: 'loc_d_u12',
} as const;

describe('focus_window / focus_evidence — additive, and a pre-card frame is untouched', () => {
  it('the pre-card frame still parses to EXACTLY its own keys', () => {
    // Assert the OUTPUT, not merely success: a `.default(...)` on either key would
    // put a value on a frame the desktop never said, and the receiver's 「这一帧
    // 没说」 branch — the ONE state that means 「我们没问」 — would stop existing.
    const parsed = schema.parse(LEGACY_RESULT);
    expect(parsed).toEqual(LEGACY_RESULT);
    expect(Object.keys(parsed)).not.toContain('focus_window');
    expect(Object.keys(parsed)).not.toContain('focus_evidence');
  });

  it('survives a round trip verbatim with both keys present', () => {
    const frame = {
      ...LEGACY_RESULT,
      focus_window: { window_title: 'Untitled - Notepad', process_name: 'notepad' },
      focus_evidence: 'not_editable',
    };
    expect(schema.parse(frame)).toEqual(frame);
  });

  it('accepts exactly the three evidence values and nothing else', () => {
    for (const v of ['editable', 'not_editable', 'unknown']) {
      expect(schema.safeParse({ ...LEGACY_RESULT, focus_evidence: v }).success, v).toBe(true);
    }
    // 🔴 A fourth value is not a fourth reading — it is a sender this receiver
    // cannot reason about. In particular `null` and `''` are refused rather than
    // quietly read as 「未知」: 「我们没问」 is expressed by OMITTING the key, and
    // giving it a second spelling would put two answers on one question.
    for (const v of ['editable ', 'Editable', 'not-editable', 'none', '', null, 0, true]) {
      expect(schema.safeParse({ ...LEGACY_RESULT, focus_evidence: v }).success, String(v)).toBe(false);
    }
  });

  it('allows an EMPTY window_title but never an empty process_name', () => {
    // A real window may have no title (04 §3.5 / focus:state has always allowed
    // ""), and refusing the frame over that would lose the process name too —
    // which is the half that actually answers 「为什么没注进去」 and the only half
    // owner ruled may be persisted (裁定③ 取 (c)).
    expect(
      schema.safeParse({
        ...LEGACY_RESULT,
        focus_window: { window_title: '', process_name: 'chrome' },
      }).success,
    ).toBe(true);
    // …but a nameless process is 「我们没认出来」, which the ABSENCE of the whole
    // object already says. A half-filled object would be a third state nobody
    // reads.
    expect(
      schema.safeParse({
        ...LEGACY_RESULT,
        focus_window: { window_title: 'Some Title', process_name: '' },
      }).success,
    ).toBe(false);
    // Both halves are required — a `focus_window` missing its process name is not
    // a smaller answer, it is an unusable one.
    expect(
      schema.safeParse({ ...LEGACY_RESULT, focus_window: { process_name: 'chrome' } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...LEGACY_RESULT, focus_window: { window_title: 'x' } }).success,
    ).toBe(false);
  });

  it('carries the observation on a SUCCESS too, without touching inject_target', () => {
    // 🔴 The old key keeps its narrow contract (F-3112: `inject_target` only on
    // ok:true, and it carries an `injected_at`). The new one is orthogonal — that
    // is exactly why widening the old one was rejected: a non-delivery would have
    // had to ship an injection TIME.
    const success = {
      ok: true,
      mode: 'sendinput',
      target_window: 'Untitled - Notepad',
      inject_target: {
        window_title: 'Untitled - Notepad',
        process_name: 'notepad',
        injected_at: '2026-08-07T00:00:00.000Z',
      },
      focus_window: { window_title: 'Untitled - Notepad', process_name: 'notepad' },
      focus_evidence: 'editable',
    };
    expect(schema.parse(success)).toEqual(success);
  });

  it('a FAILED result may name a window while still claiming no landing', () => {
    // The defect this card fixes, as a parse: `focus_window` present, `ok:false`,
    // and no `inject_target`/`target_window` anywhere. Before this round the only
    // legal frame for this situation carried the verdict and nothing else.
    const failed = {
      ok: false,
      mode: 'sendinput',
      error: 'INJECT_NO_TEXT_TARGET',
      focus_window: { window_title: '360极速浏览器X', process_name: '360ChromeX' },
      focus_evidence: 'unknown',
    };
    const parsed = schema.parse(failed);
    expect(parsed).toEqual(failed);
    expect(Object.keys(parsed)).not.toContain('inject_target');
    expect(Object.keys(parsed)).not.toContain('target_window');
  });

  it('the desktop enum and the wire enum are the same three tokens', () => {
    // The Rust side maps `FocusInputState` → these strings in ONE function
    // (`inject::target_probe::wire_evidence`); this is the boundary half of that
    // pair. Spelled out rather than derived so a rename on either side has to be
    // made deliberately on both.
    const accepted = ['editable', 'not_editable', 'unknown'];
    for (const v of accepted) {
      expect(schema.safeParse({ ok: true, mode: 'sendinput', focus_evidence: v }).success).toBe(true);
    }
    expect(accepted).toHaveLength(3);
  });
});
