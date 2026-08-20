// Protocol contract: the server validates every inbound payload through the
// @flowmic/protocol zod schemas, rejects unknown events (whitelist), and the
// WP-R1-1 additive fields (delivery, status noted, edited) round-trip.

import { describe, expect, it } from 'vitest';
import { EVENT_NAMES, isKnownEvent, safeParseEvent } from '@flowmic/protocol';
import { encrypt, decrypt, deriveKey, ENVELOPE_PREFIX } from '../src/auth/crypto';

describe('event whitelist', () => {
  // 55 → 56 (R6 T-8): `pc:list-mobiles`. 56 → 57 (GA-14, owner-approved
  // 2026-07-26): `stt:refined` — the late second-pass transcript, which could
  // not be an additive field (see events.ts for why).
  it('locks the canonical 55-event whitelist', () => {
    // 57 → 58: `mobile:unpair` (owner approved 2026-07-29). 58 → 54: the
    // 2026-07-31 stage-5 deletion of four names with no sender AND no receiver.
    // Rationale in packages/protocol/test/events-count.test.ts, the primary guard.
    // 54 → 55 (owner approved 2026-08-20): `mobile:released` — the server saying
    // 「a person disconnected you」 BEFORE it closes the socket, so the phone can
    // tell that apart from its own network dying without dialling back in to ask.
    //
    // ⚠️ ADDING THAT ONE NAME TURNED FOUR TESTS RED IN THREE PACKAGES, because
    // the number 54 was written down in four places. Two of them (this one and
    // packages/protocol/test/events-count.test.ts) lock the contract on purpose
    // and are meant to move together. One (control-key-punctuation) uses it as a
    // backdrop for an unrelated subject. The fourth sat in
    // release-mobile-revoke.test.ts under a comment saying the count was NOT what
    // it guarded — that copy is deleted rather than bumped. The lesson is the one
    // this repo keeps relearning: a constant copied into a place that does not own
    // it goes red for reasons that have nothing to do with its subject, and the
    // person who bumps it learns nothing.
    expect(EVENT_NAMES.length).toBe(55);
    expect(isKnownEvent('audio:start')).toBe(true);
    expect(isKnownEvent('pc:list-mobiles')).toBe(true);
    expect(isKnownEvent('stt:refined')).toBe(true);
    expect(isKnownEvent('stt.routing')).toBe(false); // not an event
    expect(isKnownEvent('made:up')).toBe(false);
    // Removed names must read as「not an event」, exactly like an invented one —
    // this is the assertion that fails if a revert quietly puts one back.
    expect(isKnownEvent('audio:heartbeat')).toBe(false);
    expect(isKnownEvent('audio:resend-request')).toBe(false);
    expect(isKnownEvent('history:create-local')).toBe(false);
    expect(isKnownEvent('mobile:switch-pc')).toBe(false);
  });
});

describe('WP-R1-1 additive fields round-trip through the schemas the server uses', () => {
  it('audio:start delivery is optional (omission = inject) and accepts none', () => {
    const inject = safeParseEvent('audio:start', {
      sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh',
    });
    expect(inject.success).toBe(true);
    const noted = safeParseEvent('audio:start', {
      sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh', delivery: 'none',
    });
    expect(noted.success).toBe(true);
  });

  it('history item accepts status noted + optional edited overlay', () => {
    // Was parseEvent (the throwing variant) until 2026-07-31; that export was
    // deleted as dead, so this asserts the same round-trip through the function
    // the server actually uses. Failure is now an explicit success:false rather
    // than a throw, which is strictly the stronger check for a wire path.
    const parsed = safeParseEvent('history:create', {
      item: {
        id: 'h1', pairing_id: null, pc_device_id: 'p1', user_id: 'u1', mobile_id: null, mode: 'realtime',
        source_text: 's', source_lang: 'zh', output_text: 'o', output_lang: 'zh', duration_ms: 100,
        segments_count: 0, status: 'noted', edited: true, created_at: '2026-07-23T00:00:00Z', updated_at: '2026-07-23T00:00:00Z',
      },
    });
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.item.status).toBe('noted');
    expect(parsed.data.item.edited).toBe(true);
  });

  it('rejects a malformed audio:start payload (fail-loud, not silent-accept)', () => {
    const bad = safeParseEvent('audio:start', { sample_rate: 8000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' });
    expect(bad.success).toBe(false);
  });
});

describe('enc:v1: crypto envelope', () => {
  it('round-trips and produces distinct ciphertexts per call', () => {
    const key = deriveKey('deployment-secret');
    const a = encrypt('hello', key);
    const b = encrypt('hello', key);
    expect(a.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(a).not.toBe(b); // fresh IV per call
    expect(decrypt(a, key)).toBe('hello');
  });

  it('throws on a tampered envelope (GCM auth) — never returns garbage', () => {
    const key = deriveKey('deployment-secret');
    const env = encrypt('secret', key);
    const tampered = env.slice(0, -4) + 'AAAA';
    expect(() => decrypt(tampered, key)).toThrow();
  });
});
