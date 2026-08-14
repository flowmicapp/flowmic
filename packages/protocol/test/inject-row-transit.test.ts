// 卡 P — the row-transit field-add on `inject:request`, pinned as a CONTRACT.
//
// owner's architecture ruling, 2026-07-31 (docs/decisions/2026-07-31-owner-two-channels-transit-
// not-storage.md): both channels hand a message over WITHOUT storing it, and a PC
// timeline row is created by the delivery frame itself — there is no history-sync
// stream left to make one. So this one frame must carry everything a row is made
// of. Six additive optional fields do that, plus one removed cross-field clause.
//
// This file is the SSOT the three ends will be written against (cards M / S / D),
// so a drift shows up here rather than as frames one end sends and another
// silently strips.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.5; F-2350 (image field-add);
//   A-58 (entry_id/request_id correlation echo).

import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMAS } from '../src/index';
import { THUMB_B64_MAX_CHARS } from '../src/protocol-primitives';
import { ENTRY_CAPTION_MAX_CHARS } from '../src/protocol-schemas-inject';

const schema = EVENT_SCHEMAS['inject:request'];

/** Exactly what a 0.2.28 phone puts on the wire for a direct STT send — the
 *  frame shape that existed BEFORE this card. Used as the compat baseline. */
const LEGACY_FRAME = {
  text: '你好世界',
  source: 'stt',
  request_id: 'u12-1753900000000',
  entry_id: 'loc_d_u12',
} as const;

const frame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...LEGACY_FRAME,
  ...over,
});

describe('卡 P — a 0.2.28 frame is untouched (the compatibility floor)', () => {
  it('the pre-card frame still parses', () => {
    expect(schema.safeParse(LEGACY_FRAME).success).toBe(true);
  });

  it('and parses to EXACTLY its own keys — no field is defaulted in', () => {
    const parsed = schema.parse(LEGACY_FRAME);
    // The claim is 「逐字节照旧」, so assert the OUTPUT, not just success: a
    // `.default()` on any of the six new fields would silently put a value on
    // rows sent by phones that never said it, which is a fabricated fact.
    expect(parsed).toEqual(LEGACY_FRAME);
    expect(Object.keys(parsed).sort()).toEqual([...Object.keys(LEGACY_FRAME)].sort());
  });

  it('the minimal legal frame (text + source only) still parses', () => {
    expect(schema.safeParse({ text: 'x', source: 'manual' }).success).toBe(true);
  });
});

describe('卡 P — each new field parses present AND absent', () => {
  const PRESENT: Record<string, unknown> = {
    created_at: '2026-07-31T10:20:30.000Z',
    source_text: 'hello world',
    entry_type: 'transcript',
    thumb_b64: 'QUJD',
    device_label: 'Pixel 8-3f2a',
    target_pc_id: 'pc_7f3a91',
    // 0.2.43 (owner「语音时长要找回来」): the engine-reported speaking duration.
    duration_ms: 9490,
  };

  for (const [field, value] of Object.entries(PRESENT)) {
    it(`accepts \`${field}\` present`, () => {
      expect(schema.safeParse(frame({ [field]: value })).success, field).toBe(true);
    });
    it(`accepts \`${field}\` absent`, () => {
      const { [field]: _dropped, ...rest } = PRESENT;
      expect(schema.safeParse(frame(rest)).success, field).toBe(true);
    });
  }

  it('accepts all six together (the full row-transit frame)', () => {
    const parsed = schema.safeParse(frame(PRESENT));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Every field must SURVIVE the parse. zod strips unknown keys, so a field
      // that is declared-but-misspelled would vanish here rather than fail —
      // exactly how an old relay silently drops new fields (it re-emits
      // `parsed.data`), which is why this asserts the output object.
      for (const [k, v] of Object.entries(PRESENT)) {
        expect(parsed.data[k as keyof typeof parsed.data], k).toEqual(v);
      }
    }
  });

  it('an image row carries its thumbnail alongside the picture being injected', () => {
    // `thumb_b64` (what the row keeps) and `image_b64` (what is pasted now) are
    // different fields with different jobs and must be able to coexist.
    const parsed = schema.safeParse({
      text: '',
      source: 'image',
      image_b64: 'QUJD',
      image_mime: 'image/png',
      entry_type: 'image',
      thumb_b64: 'QUJDRA==',
      created_at: '2026-07-31T10:20:30.000Z',
      device_label: 'Pixel 8-3f2a',
      target_pc_id: 'pc_7f3a91',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('卡 P — each new field REFUSES out loud at its boundary', () => {
  it('created_at rejects an empty string', () => {
    expect(schema.safeParse(frame({ created_at: '' })).success).toBe(false);
    expect(schema.safeParse(frame({ created_at: 123 })).success).toBe(false);
  });

  it('duration_ms admits non-negative integers only — 0 is a value, -1/floats/strings are not', () => {
    // 0.2.43: 0ms is a legal stamp (a stamp is not the same claim as「说了很久」);
    // anything unparseable must refuse rather than be coerced — a coerced duration
    // is a number nobody measured.
    expect(schema.safeParse(frame({ duration_ms: 0 })).success).toBe(true);
    expect(schema.safeParse(frame({ duration_ms: 9490 })).success).toBe(true);
    for (const bad of [-1, 3.7, '9490', null]) {
      expect(schema.safeParse(frame({ duration_ms: bad })).success, String(bad)).toBe(false);
    }
  });

  it('source_text admits null (「no original」) but not a non-string', () => {
    expect(schema.safeParse(frame({ source_text: null })).success).toBe(true);
    expect(schema.safeParse(frame({ source_text: '' })).success).toBe(true);
    expect(schema.safeParse(frame({ source_text: 42 })).success).toBe(false);
  });

  it('entry_type has exactly two members — no third row kind', () => {
    expect(schema.safeParse(frame({ entry_type: 'transcript' })).success).toBe(true);
    expect(schema.safeParse(frame({ entry_type: 'image' })).success).toBe(true);
    for (const bad of ['file', 'audio', 'note', '', null]) {
      expect(schema.safeParse(frame({ entry_type: bad })).success, String(bad)).toBe(false);
    }
  });

  it('thumb_b64 is exact at the cap — at it passes, one char over is REFUSED', () => {
    const atCap = 'A'.repeat(THUMB_B64_MAX_CHARS);
    expect(schema.safeParse(frame({ thumb_b64: atCap })).success).toBe(true);
    const over = schema.safeParse(frame({ thumb_b64: `${atCap}A` }));
    expect(over.success).toBe(false);
    if (!over.success) {
      // no silent failures: the refusal must NAME the field, or the sender's log says
      // 「frame invalid」 about a 200 KB payload and nobody can tell which half.
      expect(over.error.issues.some((i) => i.path[0] === 'thumb_b64')).toBe(true);
    }
  });

  it('the thumb_b64 cap is the SAME cap history:create enforces (no drift)', () => {
    // One field, one cap, two events. Written as two literals these would drift,
    // and the failure mode is the worst kind: the sender's boundary accepts what
    // the receiver's boundary refuses, so the frame dies in flight for a reason
    // neither end can state. Both now read protocol-primitives.ts `ThumbB64`.
    const overCap = 'A'.repeat(THUMB_B64_MAX_CHARS + 1);
    const historyItem = {
      id: 'h1', pairing_id: null, pc_device_id: 'pc1', user_id: 'u1', mobile_id: null,
      mode: 'realtime', source_text: null, source_lang: null, output_text: 'x',
      output_lang: null, duration_ms: null, segments_count: 0, status: 'injected',
      entry_type: 'image',
      created_at: '2026-07-31T00:00:00.000Z', updated_at: '2026-07-31T00:00:00.000Z',
    };
    const atCap = 'A'.repeat(THUMB_B64_MAX_CHARS);
    expect(EVENT_SCHEMAS['history:create'].safeParse({ item: { ...historyItem, thumb_b64: atCap } }).success).toBe(true);
    expect(EVENT_SCHEMAS['history:create'].safeParse({ item: { ...historyItem, thumb_b64: overCap } }).success).toBe(false);
    expect(schema.safeParse(frame({ thumb_b64: atCap })).success).toBe(true);
    expect(schema.safeParse(frame({ thumb_b64: overCap })).success).toBe(false);
  });

  it('device_label is capped at 48 — the exact cap the phone truncates to', () => {
    // mobile session/device_label.dart `kDeviceLabelMax = 48` and
    // MobilePairSchema.mobile_name `.max(48)`. A real label can never be refused
    // here; a 49-char one did not come from buildDeviceLabel.
    expect(schema.safeParse(frame({ device_label: 'x'.repeat(48) })).success).toBe(true);
    expect(schema.safeParse(frame({ device_label: 'x'.repeat(49) })).success).toBe(false);
    expect(schema.safeParse(frame({ device_label: '' })).success).toBe(false);
  });

  it('target_pc_id rejects an empty string (an empty address is not an address)', () => {
    expect(schema.safeParse(frame({ target_pc_id: '' })).success).toBe(false);
    expect(schema.safeParse(frame({ target_pc_id: 42 })).success).toBe(false);
    expect(schema.safeParse(frame({ target_pc_id: 'pc_7f3a91' })).success).toBe(true);
  });
});

// 🔴 The red line's protocol half. The ENFORCEMENT (compare against the PC on
// this connection, refuse with INJECT_PC_MISMATCH) is 卡 S — a schema cannot know
// which PC is on the other end of a socket. What is pinned here is the part the
// schema DOES own: the field exists, it survives the parse, and it is a distinct
// thing from every other id already on this frame.
describe('卡 P — target_pc_id is its own question (no crosstalk)', () => {
  it('survives the parse verbatim — a stripped address cannot be checked', () => {
    const parsed = schema.parse(frame({ target_pc_id: 'pc_7f3a91' }));
    expect(parsed.target_pc_id).toBe('pc_7f3a91');
  });

  it('is independent of request_id / entry_id — three ids, three questions', () => {
    // request_id = WHICH utterance (idempotency), entry_id = WHICH row
    // (correlation), target_pc_id = WHICH machine (addressing). A frame carrying
    // all three with different values must parse with all three intact: collapsing
    // any two is this repo's #1 bug shape, and here it would be the red line.
    const parsed = schema.parse(
      frame({ request_id: 'req-1', entry_id: 'row-2', target_pc_id: 'pc-3' }),
    );
    expect(parsed.request_id).toBe('req-1');
    expect(parsed.entry_id).toBe('row-2');
    expect(parsed.target_pc_id).toBe('pc-3');
  });
});

// RV-68 (窗口B3, 0.2.33) — the SEVENTH row field. The phone's own row reads
// 「🖼 PNG · 214 KB」 and the PC's row had NOT ONE CHARACTER on it, because an
// image frame's `text` is `''` by design (sending the descriptor there would make
// the PC TYPE it into the user's document). The caption travels as display text.
describe('RV-68 — entry_caption is an IMAGE row\'s words, and ONLY an image row\'s', () => {
  const CAPTION = '🖼 PNG · 214 KB';
  /** The real thing an image send puts on the wire (image_send_controller.dart). */
  const imageFrame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    text: '',
    source: 'image',
    request_id: 'i7-1753900000000',
    entry_id: 'loc_i7',
    image_b64: 'QUJD',
    image_mime: 'image/png',
    entry_type: 'image',
    ...over,
  });

  it('an image row carries its caption, and it survives the parse verbatim', () => {
    const parsed = schema.safeParse(imageFrame({ entry_caption: CAPTION }));
    expect(parsed.success).toBe(true);
    // The OUTPUT, not just success: zod strips unknown keys, so a misspelled
    // declaration would vanish here rather than fail — and a stripped caption is
    // byte-identical to the bug this field exists to fix.
    if (parsed.success) expect(parsed.data.entry_caption).toBe(CAPTION);
  });

  it('an image row with NO caption still parses — 0.2.32 phones send none', () => {
    expect(schema.safeParse(imageFrame()).success).toBe(true);
    const parsed = schema.parse(imageFrame());
    // …and nothing is defaulted in: a fabricated caption would be this PC
    // inventing a description of a picture nobody described.
    expect('entry_caption' in parsed).toBe(false);
  });

  it('🔴 a TRANSCRIPT row may not carry one — `text` already answers 「显示什么」', () => {
    // The reverse control for the test above. Two answers to one question on the
    // receiver's desk with no rule for which wins is this repo's #1 bug shape.
    const refused = schema.safeParse(frame({ entry_caption: CAPTION }));
    expect(refused.success).toBe(false);
    if (!refused.success) {
      // BY NAME (no silent failures): the sender must learn WHICH field it may not send.
      expect(refused.error.issues.some((i) => i.path[0] === 'entry_caption')).toBe(true);
    }
    // Explicit `entry_type:'transcript'` is refused for the same reason as absent.
    expect(schema.safeParse(frame({ entry_type: 'transcript', entry_caption: CAPTION })).success).toBe(false);
  });

  it('🔴 `source:image` is NOT enough — the row must say entry_type:image out loud', () => {
    // The clause's stated COST, pinned so it is a decision rather than a surprise.
    // `source` says where the bytes came from; `entry_type` says what the row IS.
    // The receiver's own source⇒entry_type fallback (row_transit.rs) is this PC's
    // GUESS about a row, and a guess must not unlock display text.
    const { entry_type: _dropped, ...noType } = imageFrame();
    expect(schema.safeParse(noType).success, 'the frame itself is legal without entry_type').toBe(true);
    expect(schema.safeParse({ ...noType, entry_caption: CAPTION }).success).toBe(false);
  });

  it('the caption is bounded — at the cap it passes, one over is REFUSED by name', () => {
    const atCap = 'x'.repeat(ENTRY_CAPTION_MAX_CHARS);
    expect(schema.safeParse(imageFrame({ entry_caption: atCap })).success).toBe(true);
    const over = schema.safeParse(imageFrame({ entry_caption: `${atCap}x` }));
    expect(over.success).toBe(false);
    if (!over.success) {
      expect(over.error.issues.some((i) => i.path[0] === 'entry_caption')).toBe(true);
    }
    // An empty caption is not a caption — it would render as the same blank row
    // this field exists to fill, while claiming the sender described the picture.
    expect(schema.safeParse(imageFrame({ entry_caption: '' })).success).toBe(false);
    expect(schema.safeParse(imageFrame({ entry_caption: 42 })).success).toBe(false);
  });

  it('the real producer\'s string fits with room to spare (the cap is a ceiling, not a format)', () => {
    // mobile session/image_payload.dart `imageEntryLabel` — pinned so a cap chosen
    // for DoS reasons can never quietly refuse a label the product really emits.
    for (const real of ['🖼 PNG · 512 B', '🖼 JPEG · 214 KB', '🖼 WEBP · 1.2 MB']) {
      expect(real.length).toBeLessThan(ENTRY_CAPTION_MAX_CHARS);
      expect(schema.safeParse(imageFrame({ entry_caption: real })).success, real).toBe(true);
    }
  });

  it('caption and thumbnail are two different things and coexist', () => {
    // `thumb_b64` is what the row LOOKS like, `entry_caption` is what it SAYS. A
    // row with a preview still needs words (the phone shows both), and a row
    // without one needs them more.
    const parsed = schema.safeParse(imageFrame({ entry_caption: CAPTION, thumb_b64: 'QUJDRA==' }));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.entry_caption).toBe(CAPTION);
      expect(parsed.data.thumb_b64).toBe('QUJDRA==');
    }
  });
});

describe('卡 P — the F-2361 `mode` clause is GONE, and nothing replaced it', () => {
  const SOURCES = ['stt', 'llm', 'manual', 'history', 'image'] as const;
  const MODES = ['realtime', 'translate', 'organize'] as const;

  it('every mode × every source is accepted — there is no cross-field rule left', () => {
    // The honest form of「这里不再有约束」: assert the whole product space, so this
    // test cannot pretend to guard a rule that no longer exists. WHY the rule
    // went: its own stated reason was 「so the SERVER can record the delivered row
    // under the selected public mode」, and the server records no row at all now
    // (`transcript_history` dropped 2026-07-31). The PC owns the row and builds it
    // from THIS frame, and most producing paths (manual, backfill, the HTTP image
    // ingress, any queued re-delivery) have no `audio:start` beside them to carry
    // a mode instead.
    for (const source of SOURCES) {
      const imageBits = source === 'image'
        ? { text: '', image_b64: 'QUJD', image_mime: 'image/png' }
        : {};
      for (const mode of MODES) {
        const r = schema.safeParse(frame({ source, mode, ...imageBits }));
        expect(r.success, `${source} × ${mode}`).toBe(true);
      }
      // …and the same frame with no mode at all is equally legal.
      expect(schema.safeParse(frame({ source, ...imageBits })).success, source).toBe(true);
    }
  });

  it('the three-mode lock is untouched — relaxing WHERE is not relaxing WHAT', () => {
    for (const bad of ['draft', 'typing', 'summarize', 'REALTIME', '', null]) {
      expect(schema.safeParse(frame({ mode: bad })).success, String(bad)).toBe(false);
    }
  });

  it('the image pairing rule still holds in both directions', () => {
    // The only cross-field rule this event has left.
    expect(schema.safeParse(frame({ source: 'image', text: '' })).success).toBe(false);
    expect(schema.safeParse(frame({ image_b64: 'QUJD', image_mime: 'image/png' })).success).toBe(false);
  });
});
