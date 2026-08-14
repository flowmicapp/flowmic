// v0.2.1 — the punctuation half of the control:key whitelist.
//
// owner 2026-07-28 裁定: tapping 。 must complete the sentence that is already on
// the PC, not fill a compose box on the phone. That reversed 08 §5's「标点行是
// LOCAL」and widened ControlKeySchema's enum, which makes this a protocol face —
// the kind CLAUDE.md puts behind a human diff review, and the kind that needs
// assertions rather than trust.
//
// What is deliberately NOT changed, and is asserted here: the EVENT count. This
// widens an existing schema's enum; it adds no event, so the 57-event whitelist
// and its count guard are untouched.

import { describe, expect, it } from 'vitest';
import {
  ControlKeySchema,
  CONTROL_KEY_CHORD_KINDS,
  CONTROL_KEY_PUNCTUATION,
  CONTROL_KEY_PUNCTUATION_KINDS,
} from '../src/protocol-schemas-inject';
import { EVENT_NAMES } from '../src/events';

describe('control:key — the punctuation family', () => {
  it('accepts every punctuation kind', () => {
    for (const kind of CONTROL_KEY_PUNCTUATION_KINDS) {
      expect(ControlKeySchema.safeParse({ kind }).success, kind).toBe(true);
    }
  });

  it('still accepts every chord kind (the widening broke nothing)', () => {
    for (const kind of CONTROL_KEY_CHORD_KINDS) {
      expect(ControlKeySchema.safeParse({ kind }).success, kind).toBe(true);
    }
  });

  it('rejects anything outside the whitelist — no catch-all keystroke', () => {
    for (const kind of ['punct_semicolon', 'punct_', 'punct', 'escape', 'PUNCT_COMMA', '']) {
      expect(ControlKeySchema.safeParse({ kind }).success, kind).toBe(false);
    }
  });

  it('the two families are disjoint', () => {
    // A kind in both would make the desktop's router prefer one arbitrarily and
    // turn the other branch into unreachable code.
    const chords = new Set<string>(CONTROL_KEY_CHORD_KINDS);
    for (const kind of CONTROL_KEY_PUNCTUATION_KINDS) {
      expect(chords.has(kind), `${kind} must not also be a chord`).toBe(false);
    }
  });

  it('every punctuation kind maps to exactly one distinct glyph', () => {
    const glyphs = Object.values(CONTROL_KEY_PUNCTUATION);
    expect(glyphs).toHaveLength(CONTROL_KEY_PUNCTUATION_KINDS.length);
    expect(new Set(glyphs).size, 'two kinds sharing a glyph would be a silent duplicate').toBe(
      glyphs.length,
    );
    // The exact table the desktop (inject/flow_key.rs punctuation_for) and the
    // phone (wire_payloads.dart controlKeyGlyph) each mirror by hand. Pinned
    // literally: a kind that means 「，」 here and 「。」 there is invisible to any
    // test that only checks 「something was typed」.
    expect(CONTROL_KEY_PUNCTUATION).toEqual({
      punct_comma: '，',
      punct_question: '？',
      punct_exclamation: '！',
      punct_enumeration: '、',
      punct_colon: '：',
      punct_period: '。',
    });
  });

  it('carries no glyph on the wire — only the kind', () => {
    // The character lives in a table on BOTH ends, keyed by name. If it rode the
    // payload instead, a phone could type anything it liked into the PC's
    // focused window, which is a much larger promise than 「六个标点」.
    const parsed = ControlKeySchema.parse({ kind: 'punct_period' });
    expect(Object.keys(parsed)).toEqual(['kind']);
    expect(JSON.stringify(parsed)).not.toContain('。');
  });

  it('adds NO event — the whitelist count is untouched by THIS change', () => {
    // Pinned in events-count.test.ts; here the point is only that widening an
    // enum is not an event addition.
    // 58 → 54 by the 2026-07-31 stage-5 deletion of four dead names; unrelated
    // to control:key, which is exactly what this case exists to show.
    expect(EVENT_NAMES).toHaveLength(54);
    expect(EVENT_NAMES).toContain('control:key');
  });
});

// ── REQ-12-13 (2026-08-12): `device_label` — WHICH PHONE pressed the key ──────
//
// Contract: docs/rebuild/15 §2.0-e + docs/rebuild/04 F-3115. The desktop now mints
// a PC timeline row per remote key press, and a PC is a shared destination.
describe('control:key — device_label (additive optional)', () => {
  it('is optional: every frame that parsed before still parses, byte-identical', () => {
    for (const kind of CONTROL_KEY_CHORD_KINDS) {
      const parsed = ControlKeySchema.parse({ kind });
      // 🔴 Not just `.success`: an additive field that zod DEFAULTED would change
      // what an old phone's frame looks like on the far side, and 「这一帧没说」
      // must stay distinguishable from 「这一帧说了空」.
      expect(Object.keys(parsed), kind).toEqual(['kind']);
    }
  });

  it('accepts a real label and carries it through', () => {
    expect(ControlKeySchema.parse({ kind: 'clear', device_label: 'Pixel 8' }).device_label)
      .toBe('Pixel 8');
  });

  it('refuses an empty label and one over the 48 cap', () => {
    // 48 is `MobilePairSchema.mobile_name` / `InjectRequestSchema.device_label` —
    // the SAME string, already truncated to exactly this by the phone's
    // buildDeviceLabel (kDeviceLabelMax = 48), so a real label can never be refused.
    expect(ControlKeySchema.safeParse({ kind: 'clear', device_label: '' }).success).toBe(false);
    expect(ControlKeySchema.safeParse({ kind: 'clear', device_label: 'x'.repeat(48) }).success)
      .toBe(true);
    expect(ControlKeySchema.safeParse({ kind: 'clear', device_label: 'x'.repeat(49) }).success)
      .toBe(false);
  });

  it('🔴 carries NO target_pc_id — the absence is the ruling, not an oversight', () => {
    // 15 册 §2.0-e / 04 册 F-3115: control:key has no queue (so nothing re-derives
    // 「whoever is connected now」 at drain time, which is what the 串号 red line
    // guards) and NO RESULT FRAME (so a mismatched address could only be refused
    // silently — the red line itself). An unknown key is STRIPPED by zod, so a
    // sender that stamps one is not refused, it is simply not heard: pinning it
    // here is what makes 「someone added addressing and thought it took effect」
    // impossible to do quietly.
    const parsed = ControlKeySchema.parse({ kind: 'clear', target_pc_id: 'pc_1' });
    expect(Object.keys(parsed)).toEqual(['kind']);
  });

  it('adds NO event and no error code', () => {
    // Pinned in events-count.test.ts; here the point is only that widening an
    // enum is not an event addition.
    // 58 → 54 by the 2026-07-31 stage-5 deletion of four dead names; unrelated
    // to control:key, which is exactly what this case exists to show.
    expect(EVENT_NAMES).toHaveLength(54);
    expect(EVENT_NAMES).toContain('control:key');
  });
});
