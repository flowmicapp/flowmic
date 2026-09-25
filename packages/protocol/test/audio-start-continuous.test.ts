// Card RC-1 (2026-09-24) — `audio:start.continuous`, the one fact that tells the
// relay a long recording from a held button (book 04 audio:start row).
//
// The relay's reader is `apps/server-core/src/socket/handlers/audio.handler.ts`
// (`parsed.data.continuous === true`); what it switches on is pinned in
// `apps/server-core/test/stt-reconnect-unbounded.test.ts`. This file pins the
// wire half: the live schema KEEPS the flag, and a relay built before this card
// strips it instead of refusing the frame — the failure direction D-27 needs.

import { describe, expect, it } from 'vitest';
import { AudioStartSchema } from '../src/index';

const baseStart = {
  sample_rate: 16_000 as const,
  channels: 1 as const,
  encoding: 'pcm_s16le' as const,
  mode: 'realtime' as const,
  source_lang: 'zh',
};

describe('audio:start.continuous (RC-1)', () => {
  it('the live schema keeps continuous:true', () => {
    const r = AudioStartSchema.safeParse({ ...baseStart, continuous: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.continuous).toBe(true);
  });

  it('absent stays absent — push-to-talk is the default, not false-by-invention', () => {
    const r = AudioStartSchema.safeParse(baseStart);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect('continuous' in r.data).toBe(false);
  });

  it('a non-boolean is refused rather than coerced', () => {
    expect(AudioStartSchema.safeParse({ ...baseStart, continuous: 'yes' }).success).toBe(false);
    expect(AudioStartSchema.safeParse({ ...baseStart, continuous: 1 }).success).toBe(false);
  });

  it('a relay without the field strips it and still accepts the frame (old relay ⇒ PTT ladder, not a refusal)', () => {
    const OldSchema = AudioStartSchema.omit({ continuous: true });
    const r = OldSchema.safeParse({ ...baseStart, continuous: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect('continuous' in r.data).toBe(false);
  });
});
