// Cards CV-1 + PR-1 — the wire contract of docs/rebuild/04-PROTOCOL-SPEC.md
// §3.3-a: recovery identifiers on `audio:start`, the versioned coverage receipt
// on the TERMINAL `stt:final`, and the capability array on the acks.
//
// The load-bearing case in this file is `OldAudioStartSchema` below. Everything
// the recovery plan does on an old relay rests on ONE property — unknown keys
// are STRIPPED, not refused (audit draft E38) — and that property has so far
// been asserted only by a comment about somebody else's deployment
// (anti-façade ④). A fixture of the pre-card schema turns it into something a
// machine re-checks on every run.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AttemptKindSchema,
  AudioStartRecoveryFieldsSchema,
  CAPABILITY_RECOVERY_COVERAGE_RECEIPT,
  CAPABILITY_RECOVERY_DELIVERY_NONE_SAFE,
  COVERAGE_RECEIPT_VERSION,
  CoverageReceiptFieldsSchema,
  EVENT_NAMES,
  CAPABILITY_RECOVERY_IDEMPOTENT_OPERATION,
  SERVER_RECOVERY_CAPABILITIES,
  ServerCapabilityAckFieldsSchema,
  safeParseEvent,
} from '../src';

/** A minimal, valid pre-card `audio:start` body. */
const baseStart = {
  sample_rate: 16_000,
  channels: 1,
  encoding: 'pcm_s16le',
  mode: 'realtime',
  source_lang: 'zh',
} as const;

/** The eight identifiers, all present. */
const recovery = {
  recording_id: 'rec-7f3a',
  job_id: 'job-7f3a-0-320000-realtime.zh.v1',
  attempt_id: 'att-2',
  operation_id: 'op-2-1',
  attempt_kind: 'user_retranscribe',
  range_start_sample: 0,
  range_end_sample: 320_000,
  audio_format_version: 1,
} as const;

describe('audio:start — recovery identifiers (04 §3.3-a (a))', () => {
  it('round-trips all eight through the real event registry', () => {
    const r = safeParseEvent('audio:start', { ...baseStart, ...recovery });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toMatchObject(recovery);
    // The default this card is forbidden to touch: `delivery` is still absent
    // here, and absence still means the consumer applies `?? 'inject'`.
    expect('delivery' in r.data).toBe(false);
  });

  it('parses with every identifier absent, and the keys stay ABSENT on the way out', () => {
    const r = safeParseEvent('audio:start', baseStart);
    expect(r.success).toBe(true);
    if (!r.success) return;
    for (const k of Object.keys(recovery)) {
      // `in`, not a `=== undefined` read: an undefined-valued key and a missing
      // key are indistinguishable through property access, and the wire contract
      // is about the KEY.
      expect(k in r.data).toBe(false);
    }
  });

  it('holds attempt_kind to its three values', () => {
    expect(AttemptKindSchema.options).toEqual(['live', 'auto_retry', 'user_retranscribe']);
    const r = safeParseEvent('audio:start', { ...baseStart, attempt_kind: 'redo' });
    expect(r.success).toBe(false);
  });

  it('refuses a sample range that is not a non-negative integer', () => {
    for (const bad of [-1, 1.5, '0', null]) {
      expect(safeParseEvent('audio:start', { ...baseStart, range_start_sample: bad }).success).toBe(false);
      expect(safeParseEvent('audio:start', { ...baseStart, range_end_sample: bad }).success).toBe(false);
    }
  });

  it('accepts the empty half-open range [n, n) rather than inventing a minimum', () => {
    // A zero-length range is a legal STATEMENT ("this attempt fed nothing of the
    // recording"), and the schema is not the layer that decides whether making
    // it is sensible. Refusing it here would push the caller into omitting the
    // pair, i.e. into saying "I do not know" when it knows exactly.
    const r = safeParseEvent('audio:start', { ...baseStart, range_start_sample: 96_000, range_end_sample: 96_000 });
    expect(r.success).toBe(true);
  });
});

describe('audio:start — an OLD schema strips the new keys, it does not refuse them', () => {
  // 🔴 A VERBATIM COPY of `AudioStartSchema` as it stood before this card: the
  // same fields, the same absence of `.strict()`. It is a fixture on purpose —
  // importing the live schema would make this test assert that today equals
  // today, which is not the question. The question is what a relay built from
  // LAST WEEK's protocol package does with a frame built from this week's.
  const OldAudioStartSchema = z.object({
    sample_rate: z.literal(16_000),
    channels: z.literal(1),
    encoding: z.literal('pcm_s16le'),
    mode: z.enum(['realtime', 'translate', 'organize']),
    send_policy: z.enum(['manual', 'direct']).optional(),
    delivery: z.enum(['inject', 'none']).optional(),
    source_lang: z.string().min(1),
    target_lang: z.string().min(1).optional(),
  });

  it('parses a NEW audio:start and silently drops all eight identifiers', () => {
    const parsed = OldAudioStartSchema.safeParse({ ...baseStart, ...recovery });
    // Not refused — this is the whole compatibility argument (E38).
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    for (const k of Object.keys(recovery)) expect(k in parsed.data).toBe(false);
    // What survives is exactly the pre-card frame, byte for byte.
    expect(parsed.data).toEqual(baseStart);
  });

  it('is the same schema that WOULD refuse them if it were .strict()', () => {
    // The reverse control for the sentence above: the tolerance is a property of
    // the schema's mode, not a happy accident of these particular key names. If
    // anyone ever adds `.strict()` to the live AudioStartSchema, the deployment
    // order stops being "either end first" — and this assertion is what makes
    // that consequence visible instead of discovered in production.
    const strict = OldAudioStartSchema.strict();
    expect(strict.safeParse({ ...baseStart, ...recovery }).success).toBe(false);
    expect(strict.safeParse(baseStart).success).toBe(true);
  });
});

describe('stt:final — coverage receipt (04 §3.3-a (b))', () => {
  const terminal = {
    text: 'hello',
    confidence: 0.9,
    language: 'en',
    segment_idx: 0,
    is_segment: false,
    duration_ms: 4_200,
  } as const;

  const receipt = {
    coverage_receipt_version: COVERAGE_RECEIPT_VERSION,
    fed_frames: 21,
    seq_gaps: 0,
    drops: 0,
    engine_leg_rollovers: 1,
    ended_normally: true,
    recording_id: 'rec-7f3a',
    attempt_id: 'att-2',
    range_start_sample: 0,
    range_end_sample: 320_000,
  } as const;

  it('round-trips through the real event registry', () => {
    const r = safeParseEvent('stt:final', { ...terminal, ...receipt });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toMatchObject(receipt);
  });

  it('keeps ended_normally:false distinguishable from an absent receipt', () => {
    // Two different facts: "the session was cut off" and "this server does not
    // issue receipts". A boolean read through `?? true` would merge them, so the
    // schema has to preserve the key, not just the value.
    const cut = safeParseEvent('stt:final', { ...terminal, ...receipt, ended_normally: false });
    expect(cut.success).toBe(true);
    if (cut.success) expect(cut.data.ended_normally).toBe(false);

    const none = safeParseEvent('stt:final', terminal);
    expect(none.success).toBe(true);
    if (none.success) expect('ended_normally' in none.data).toBe(false);
  });

  it('parses a final with no receipt at all, and adds no keys', () => {
    const r = safeParseEvent('stt:final', terminal);
    expect(r.success).toBe(true);
    if (!r.success) return;
    for (const k of Object.keys(receipt)) expect(k in r.data).toBe(false);
  });

  it('refuses a zero or negative receipt version and negative counters', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(safeParseEvent('stt:final', { ...terminal, coverage_receipt_version: bad }).success).toBe(false);
    }
    expect(safeParseEvent('stt:final', { ...terminal, fed_frames: -1 }).success).toBe(false);
    expect(safeParseEvent('stt:final', { ...terminal, drops: 0.5 }).success).toBe(false);
  });

  it('declares its version as 1 — a reader that does not know the number has no receipt', () => {
    expect(COVERAGE_RECEIPT_VERSION).toBe(1);
    // Every echo field the receipt carries also exists on the start frame, with
    // the same name and the same type. Asserted structurally so a rename on one
    // side cannot quietly become a second, differently-spelled fact.
    for (const k of ['recording_id', 'attempt_id', 'range_start_sample', 'range_end_sample'] as const) {
      expect(k in CoverageReceiptFieldsSchema.shape).toBe(true);
      expect(k in AudioStartRecoveryFieldsSchema.shape).toBe(true);
    }
  });
});

describe('capability bits (04 §3.3-a (c))', () => {
  it('round-trips a capability array and tolerates absence', () => {
    const parsed = ServerCapabilityAckFieldsSchema.parse({ capabilities: [...SERVER_RECOVERY_CAPABILITIES] });
    expect(parsed.capabilities).toEqual([
      CAPABILITY_RECOVERY_COVERAGE_RECEIPT,
      CAPABILITY_RECOVERY_DELIVERY_NONE_SAFE,
      CAPABILITY_RECOVERY_IDEMPOTENT_OPERATION,
    ]);
    const empty = ServerCapabilityAckFieldsSchema.parse({});
    expect('capabilities' in empty).toBe(false);
  });

  it('accepts a bit name this build has never heard of', () => {
    // Forward compatibility is the whole reason this is `string[]` and not an
    // enum: a phone must never reject an ack because a newer server named
    // something new. Recognition is the reader's job.
    const parsed = ServerCapabilityAckFieldsSchema.parse({ capabilities: ['recovery.something_new'] });
    expect(parsed.capabilities).toEqual(['recovery.something_new']);
  });

  it('refuses an empty bit name', () => {
    expect(ServerCapabilityAckFieldsSchema.safeParse({ capabilities: [''] }).success).toBe(false);
  });

  it('advertises the idempotency bit — and its SPELLING has not moved', () => {
    // 🔴 The one assertion in this file that guards a promise rather than a
    // shape, and it changed direction on 2026-09-06 when card PR-2 implemented
    // the thing (registry + metering ledger + deterministic replica key). Until
    // then it asserted ABSENCE, because a bit we do not honour turns the phone's
    // fail-closed hold into a false green.
    //
    // ⚠️ THE STRING ASSERTION IS THE HALF THAT MATTERS NOW. Phones already in the
    // field compare against this literal; renaming the constant is free, renaming
    // the wire value silently un-advertises the capability to every one of them.
    expect(CAPABILITY_RECOVERY_IDEMPOTENT_OPERATION).toBe('recovery.idempotent_operation');
    expect(SERVER_RECOVERY_CAPABILITIES).toContain(CAPABILITY_RECOVERY_IDEMPOTENT_OPERATION);
  });
});

describe('this card added no events', () => {
  it('leaves the event whitelist alone', () => {
    // The count guard lives in events-count.test.ts; this is the local statement
    // that these three surfaces are payload FIELDS. Named events only.
    for (const n of ['audio:start', 'stt:final'] as const) expect(EVENT_NAMES).toContain(n);
    expect(EVENT_NAMES.filter((n) => n.includes('coverage') || n.includes('capabilit'))).toEqual([]);
  });
});
