// R6 T-4 — the F-2350 image field-add on inject:request, pinned as a CONTRACT.
//
// The fields were added ahead of any consumer; T-4 is the card that finally
// wires both ends, so this is where the rules they encode get their guard. The
// two ends each re-implement these checks locally (apps/mobile
// image_payload.dart, apps/desktop src-tauri/src/inject/image.rs) — this file
// is the SSOT they are written against, so a drift shows up here rather than as
// frames one end sends and the other silently rejects.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.5; F-2350 (image field-add, NO
//   new socket event); F-2361 (`mode` was reserved for source:'manual' — that
//   clause was REMOVED by 卡 P, see the inverted assertion below and
//   docs/decisions/2026-07-31-owner-two-channels-transit-not-storage.md).

import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMAS, InjectImageMimeSchema } from '../src/index';

const schema = EVENT_SCHEMAS['inject:request'];

/** A real 2×2 RGBA PNG — the same artefact both clients test against. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMASUkJeJw9PL4AAAAASUVORK5CYII=';

const image = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  text: '',
  source: 'image',
  image_b64: PNG_B64,
  image_mime: 'image/png',
  ...over,
});

describe('inject:request image field-add (F-2350) — no new event', () => {
  it('the image fields ride an already-whitelisted event', () => {
    expect(EVENT_SCHEMAS['inject:request']).toBeDefined();
    // The three-value mime enum has no fourth member.
    expect(InjectImageMimeSchema.options).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });

  it('a well-formed image frame parses, with an EMPTY text', () => {
    const parsed = schema.safeParse(image({ request_id: 'i0-1', entry_id: 'loc_d_i0-1' }));
    expect(parsed.success).toBe(true);
    // `text` is required by the schema and empty is legal — which is exactly
    // what lets the phone send a picture without also sending words to type.
    expect(schema.safeParse(image({ text: undefined })).success).toBe(false);
  });

  it('the pairing rule holds in BOTH directions', () => {
    // source:'image' without the payload.
    expect(schema.safeParse({ text: '', source: 'image' }).success).toBe(false);
    expect(schema.safeParse(image({ image_mime: undefined })).success).toBe(false);
    expect(schema.safeParse(image({ image_b64: undefined })).success).toBe(false);
    // payload without source:'image'.
    expect(schema.safeParse(image({ source: 'stt', text: 'hi' })).success).toBe(false);
    expect(
      schema.safeParse({ text: 'hi', source: 'manual', image_mime: 'image/png' }).success,
    ).toBe(false);
  });

  // WAS: '`mode` stays reserved for manual and is illegal on an image frame'.
  // The F-2361 clause it pinned was REMOVED in the row-transit round (卡 P) —
  // the PC's timeline rows are now built from this frame, and an image row
  // carries a mode like any other row (`HistoryItemSchema.mode` is required even
  // for entry_type:'image'). The assertion is INVERTED rather than deleted: the
  // pairing rules below are what this file guards, and a reader arriving here
  // must not be left thinking `mode` on an image frame is still refused.
  it('`mode` is now LEGAL on an image frame (F-2361 clause removed, 卡 P)', () => {
    expect(schema.safeParse(image({ mode: 'realtime' })).success).toBe(true);
    // The image pairing rules are untouched by that relaxation.
    expect(schema.safeParse(image({ mode: 'realtime', image_mime: undefined })).success).toBe(false);
    // And the three-mode enum still has no fourth member.
    expect(schema.safeParse(image({ mode: 'draft' })).success).toBe(false);
  });

  it('only canonical base64 is accepted — no whitespace, no data: URL, no url-safe', () => {
    for (const bad of [
      '', // empty
      'QUJDR', // length % 4 != 0
      'QUJD QQ==', // embedded space
      'QUJD\nQQ==', // line wrapping
      'data:image/png;base64,QUJDRA==', // data URL prefix
      'Pz8_Pw==', // url-safe alphabet
      'QQ==QQ==', // padding in the middle
    ]) {
      expect(schema.safeParse(image({ image_b64: bad })).success, `accepted ${JSON.stringify(bad)}`).toBe(
        false,
      );
    }
    expect(schema.safeParse(image({ image_b64: 'QUJD' })).success).toBe(true);
  });

  it('the 5.5M ceiling is exact — at the cap passes, one quad over fails', () => {
    const atCap = 'A'.repeat(5_500_000);
    expect(schema.safeParse(image({ image_b64: atCap })).success).toBe(true);
    expect(schema.safeParse(image({ image_b64: `${atCap}AAAA` })).success).toBe(false);
  });

  it('a mime outside the three-value enum is rejected', () => {
    for (const mime of ['image/gif', 'image/bmp', 'image/heic', 'image/svg+xml', 'text/plain']) {
      expect(schema.safeParse(image({ image_mime: mime })).success, mime).toBe(false);
    }
  });

  it('the image source is one of the FIVE frozen provenances — not a sixth', () => {
    expect(schema.safeParse({ text: 'x', source: 'screenshot' }).success).toBe(false);
    for (const source of ['stt', 'llm', 'manual', 'history']) {
      expect(schema.safeParse({ text: 'x', source }).success, source).toBe(true);
    }
  });
});
