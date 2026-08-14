// RV-87 — the cloud-relay image policy, as a pure decision object.
//
// owner 2026-08-01 verbatim: "if it is the relay channel, the server uniformly intercepts the client; a picture over 1M is not allowed through,
// to stop the relay being used as a photo-sync tool" + "cap it at 200 pictures, because each send is one picture and sending
// 200 by hand is a tedious job… but add a limit that rules out machines auto-sending".
//
// This file pins the DECISION. What it deliberately does NOT prove is that the
// relay actually asks (a policy object nobody calls is this repo's #1 façade
// shape) — that is relay-cloud-image.test.ts at the handler and
// verify/golden/g15-cloud-image-policy.mjs over a real saas server.
//
// SPEC-REF: docs/decisions/2026-08-01-cloud-image-policy-size-cap-and-anti-sync.md;
//   apps/server-core/src/socket/cloud-image-policy.ts;
//   packages/protocol/src/constants.ts (CLOUD_IMAGE_*).

import { describe, it, expect } from 'vitest';
import {
  CLOUD_IMAGE_BYTES_MAX,
  CLOUD_IMAGE_QUOTA_MAX,
  CLOUD_IMAGE_QUOTA_WINDOW_MS,
} from '@flowmic/protocol';
import { decodedBase64Bytes, makeCloudImagePolicy } from '../src/socket/cloud-image-policy';

/** `n` decoded bytes as canonical base64 — the exact shape
 *  InjectImageBase64Schema admits (length % 4 === 0, canonical alphabet). */
function b64OfBytes(n: number): string {
  return Buffer.alloc(n).toString('base64');
}

const USER = 'user-1';

describe('decodedBase64Bytes — the number the ceiling is judged on', () => {
  it('🔴 counts the PICTURE, not the encoding (all three padding cases)', () => {
    // Every remainder class, because the padding arithmetic is where an
    // off-by-one would silently move the ceiling by a byte or two.
    for (const n of [1, 2, 3, 4, 5, 6, 100, 1023, 1024, 1_048_575, 1_048_576, 1_048_577]) {
      expect(decodedBase64Bytes(b64OfBytes(n)), `${n} bytes`).toBe(n);
    }
  });

  it('an empty string is zero bytes (not NaN, not a negative)', () => {
    expect(decodedBase64Bytes('')).toBe(0);
  });

  it('🔴 base64 is 4/3 of the picture — judging the STRING would refuse legal images', () => {
    // The concrete harm this asserts against: a 790 KB photo whose base64 is over
    // 1 MiB. If the ceiling were applied to the string, this user would be refused
    // "over 1 MB" about a file their phone shows as 790 KB.
    const bytes = 790_000;
    const b64 = b64OfBytes(bytes);
    expect(b64.length).toBeGreaterThan(CLOUD_IMAGE_BYTES_MAX);
    expect(decodedBase64Bytes(b64)).toBeLessThan(CLOUD_IMAGE_BYTES_MAX);
  });
});

describe('RV-87 · the 1 MiB ceiling (saas only)', () => {
  const saas = (): ReturnType<typeof makeCloudImagePolicy> =>
    makeCloudImagePolicy({ mode: 'saas', now: () => 1_000_000 });

  it('EXACTLY at the ceiling is admitted — the boundary is "over", not "at"', () => {
    expect(saas().judge(USER, b64OfBytes(CLOUD_IMAGE_BYTES_MAX))).toEqual({ admit: true });
  });

  it('one byte over ⇒ INJECT_CLOUD_IMAGE_TOO_LARGE, with both numbers for the log', () => {
    const v = saas().judge(USER, b64OfBytes(CLOUD_IMAGE_BYTES_MAX + 1));
    expect(v.admit).toBe(false);
    if (v.admit) throw new Error('unreachable');
    expect(v.error).toBe('INJECT_CLOUD_IMAGE_TOO_LARGE');
    expect(v.detail).toEqual({ bytes: CLOUD_IMAGE_BYTES_MAX + 1, max_bytes: CLOUD_IMAGE_BYTES_MAX });
  });

  it('🔴 NOT INJECT_FRAME_TOO_LARGE — that code says "the PC side did not receive it" about the WIRE cap', () => {
    const v = saas().judge(USER, b64OfBytes(CLOUD_IMAGE_BYTES_MAX + 1));
    if (v.admit) throw new Error('unreachable');
    // Pinned as a literal because the whole point of the split is that the two
    // sentences send the user to different places (switch to LAN vs pick a smaller picture).
    expect(v.error).not.toBe('INJECT_FRAME_TOO_LARGE');
  });

  it('🔴 standalone NOOPs — "switch to LAN and you can send it" has to remain TRUE', () => {
    // The refusal's own advice is the reason this branch exists. A LAN sidecar
    // that enforced the relay's ceiling would make the sentence a dead end.
    const lan = makeCloudImagePolicy({ mode: 'standalone', now: () => 1_000_000 });
    expect(lan.judge(USER, b64OfBytes(CLOUD_IMAGE_BYTES_MAX * 3))).toEqual({ admit: true });
  });
});

describe('RV-87 · 200 pictures / 24h rolling window (per account)', () => {
  /** A picture well under the size ceiling, so only the COUNT is under test. */
  const tiny = b64OfBytes(12);

  function policyAt(clock: { t: number }): ReturnType<typeof makeCloudImagePolicy> {
    return makeCloudImagePolicy({ mode: 'saas', now: () => clock.t });
  }

  it(`admits exactly ${CLOUD_IMAGE_QUOTA_MAX}, refuses the next one BY NAME`, () => {
    const clock = { t: 1_000_000 };
    const p = policyAt(clock);
    for (let i = 0; i < CLOUD_IMAGE_QUOTA_MAX; i++) {
      expect(p.judge(USER, tiny), `picture #${i + 1}`).toEqual({ admit: true });
      p.record(USER);
      clock.t += 1_000; // a second apart, as a person sending one at a time would be
    }
    const v = p.judge(USER, tiny);
    expect(v.admit).toBe(false);
    if (v.admit) throw new Error('unreachable');
    expect(v.error).toBe('INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED');
    expect(v.detail.used).toBe(CLOUD_IMAGE_QUOTA_MAX);
    expect(v.detail.max).toBe(CLOUD_IMAGE_QUOTA_MAX);
    // How long until the OLDEST stamp leaves the window — the honest answer to
    // "how long to wait", even though the wire frame carries only the sentence.
    expect(v.detail.retry_after_ms).toBeGreaterThan(0);
    expect(v.detail.retry_after_ms).toBeLessThanOrEqual(CLOUD_IMAGE_QUOTA_WINDOW_MS);
  });

  it('🔴 ROLLING, not a daily reset: one slot frees exactly 24h after it was used', () => {
    const clock = { t: 1_000_000 };
    const p = policyAt(clock);
    for (let i = 0; i < CLOUD_IMAGE_QUOTA_MAX; i++) {
      p.record(USER);
      clock.t += 1_000;
    }
    expect(p.judge(USER, tiny).admit).toBe(false);
    // One millisecond BEFORE the first stamp ages out — still full. (The window
    // is half-open, `ts > now - windowMs`, the same boundary
    // auth/register-rate-limit.ts uses; asserted on both sides so a future
    // >/>= slip is a red test rather than a silently different ceiling.)
    clock.t = 1_000_000 + CLOUD_IMAGE_QUOTA_WINDOW_MS - 1;
    expect(p.judge(USER, tiny).admit, 'the oldest stamp is still inside the window').toBe(false);
    // …and exactly AT it: one slot is back, not the whole budget.
    clock.t = 1_000_000 + CLOUD_IMAGE_QUOTA_WINDOW_MS;
    expect(p.judge(USER, tiny).admit).toBe(true);
    p.record(USER);
    expect(p.judge(USER, tiny).admit, 'a rolling window gives back ONE slot, not 200').toBe(false);
  });

  it('🔴 the budget is per ACCOUNT and accounts do not bleed into each other', () => {
    const clock = { t: 1_000_000 };
    const p = policyAt(clock);
    for (let i = 0; i < CLOUD_IMAGE_QUOTA_MAX; i++) p.record('user-a');
    expect(p.judge('user-a', tiny).admit).toBe(false);
    expect(p.judge('user-b', tiny).admit, 'one account exhausting its budget must not refuse another').toBe(true);
  });

  it('🔴 `judge` STAMPS NOTHING — a picture refused downstream costs no slot', () => {
    // The whole reason judge/record are separate: an over-size frame, and a legal
    // frame that finds an empty room, must not eat a user's daily budget.
    const p = makeCloudImagePolicy({ mode: 'saas', now: () => 1_000_000, quotaMax: 2 });
    for (let i = 0; i < 50; i++) expect(p.judge(USER, tiny).admit).toBe(true);
    p.record(USER);
    p.record(USER);
    expect(p.judge(USER, tiny).admit, 'only the two RECORDED pictures counted').toBe(false);
  });

  it('standalone NOOPs on both halves (no counting, no refusing)', () => {
    const lan = makeCloudImagePolicy({ mode: 'standalone', now: () => 1_000_000, quotaMax: 1 });
    lan.record(USER);
    lan.record(USER);
    lan.record(USER);
    expect(lan.judge(USER, tiny)).toEqual({ admit: true });
  });

  it('🔴 size is judged BEFORE count — the actionable verdict wins when both are hit', () => {
    // A user who is out of budget AND sends an over-size picture must hear
    // "switch to LAN" (which works) rather than "try again later" (which will refuse the same
    // picture again tomorrow).
    const p = makeCloudImagePolicy({ mode: 'saas', now: () => 1_000_000, quotaMax: 1 });
    p.record(USER);
    const v = p.judge(USER, b64OfBytes(CLOUD_IMAGE_BYTES_MAX + 1));
    if (v.admit) throw new Error('unreachable');
    expect(v.error).toBe('INJECT_CLOUD_IMAGE_TOO_LARGE');
  });
});
