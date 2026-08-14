// SEG-1 (R5, docs/strategy/2026-08-11-unified-transcription-session-design.md):
// the audio half of the `mobile:reconnect` ack — `audio_last_contiguous_seq`.
//
// The contract under test (protocol-schemas-auth.ts, on the field):
//   · ABSENCE is the no-session signal — an ack without the field must parse,
//     and must come OUT without the key (not with an undefined-valued key);
//   · `-1` is a legal VALUE (SeqTracker starts at -1: session live, zero chunks
//     observed) — it must round-trip, because collapsing it into absence would
//     erase the difference between 「no session」 and 「session with no audio yet」;
//   · below -1, non-integers and non-numbers are refused — a malformed watermark
//     must fail parse (the phone-side consumer then falls back to full replay,
//     the fail-toward-duplication direction);
//   · zod strips unknown keys, so parsing a whole ack literal through this
//     partial schema yields only the declared field — the same property
//     PcPairedMobileSchema leans on for its zero-secret projection.

import { describe, expect, it } from 'vitest';
import { MobileReconnectAckAudioFieldsSchema } from '../src/protocol-schemas';

describe('mobile:reconnect ack — audio_last_contiguous_seq (SEG-1 R5)', () => {
  it('round-trips with the field present, including the legal -1', () => {
    for (const seq of [-1, 0, 1, 41, 999_999]) {
      const parsed = MobileReconnectAckAudioFieldsSchema.parse({ audio_last_contiguous_seq: seq });
      expect(parsed.audio_last_contiguous_seq).toBe(seq);
      // Key PRESENCE asserted structurally, not by value — `-1` and `0` are
      // falsy-adjacent traps for a value-only check.
      expect('audio_last_contiguous_seq' in parsed).toBe(true);
    }
  });

  it('parses with the field absent, and the key stays ABSENT on the way out', () => {
    const parsed = MobileReconnectAckAudioFieldsSchema.parse({});
    // `in` / stringify, not a `=== undefined` read: an undefined-valued key and
    // a missing key read identically through property access, and the wire
    // contract is about the KEY (absence = no session).
    expect('audio_last_contiguous_seq' in parsed).toBe(false);
    expect(JSON.stringify(parsed)).toBe('{}');
  });

  it('refuses below--1, non-integer and non-number watermarks', () => {
    for (const bad of [-2, 1.5, '3', null, Number.NaN]) {
      expect(
        MobileReconnectAckAudioFieldsSchema.safeParse({ audio_last_contiguous_seq: bad }).success,
      ).toBe(false);
    }
  });

  it('strips the base-ack keys it does not declare (partial-schema projection)', () => {
    // A caller may hand the WHOLE reconnect-ack literal to this schema; only
    // the declared field survives, and an ack without it survives as {}.
    const wholeAck = {
      pairing_id: 'm1',
      pc_id: 'pc1',
      pc_instance_id: null,
      pc_machine_uid: null,
      pc_name: 'PC',
      room_uuid: 'room-1',
      pc_online: true,
      audio_last_contiguous_seq: 7,
    };
    expect(MobileReconnectAckAudioFieldsSchema.parse(wholeAck)).toEqual({ audio_last_contiguous_seq: 7 });
    const { audio_last_contiguous_seq: _drop, ...withoutField } = wholeAck;
    expect(MobileReconnectAckAudioFieldsSchema.parse(withoutField)).toEqual({});
  });
});
