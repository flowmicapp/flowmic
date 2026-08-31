// SPEC-REF: apps/server-core/src/billing/paddle/api-key-format.ts
//
// 🔴 THE FIXTURES ARE THE POINT OF THIS FILE.
//
// The repo has been bitten twice by test matrices built from values that "look
// like that sort of thing" while the value that actually occurs in production
// went untested (see CLAUDE.md, law L-② from 0.3.24: `en-US`/`ja-JP` were tested
// and the every-single-day value `en` was not). So:
//
//   · `REAL_SHAPE_*` are structurally the documented format, with the character
//     classes Paddle actually uses — lowercase+digits for the ULID segment,
//     mixed case for the other two.
//   · `OBSERVED_DEFECT` is the EXACT shape found in `.local/paddle-sandbox.env`
//     and in production's `/etc/flowmic-app/env` on 2026-08-31: 65 characters,
//     four underscores gone, the last one surviving. It is the case this whole
//     module exists for, so it is asserted by name and not folded into a loop.
//
// ⚠️ These are synthetic strings, not credentials. A real key never enters the
// repo — the production one was verified against Paddle by an operator, and what
// that verification proved (HTTP 200) is not something a unit test can restate.

import { describe, expect, it } from 'vitest';

import { describePaddleApiKeyVerdict, paddleApiKeyVerdict } from '../src/billing/paddle/api-key-format';

const ULID = '01m1bcy7wrv092nv29xvx99pg4'; // 26, [a-z0-9]
const MID = '82mc6WmKCTCqEfzFzd55nv'; //     22, [a-zA-Z0-9]
const TAIL = 'AHn'; //                        3, [a-zA-Z0-9]

const REAL_SHAPE_LIVE = `pdl_live_apikey_${ULID}_${MID}_${TAIL}`;
const REAL_SHAPE_SANDBOX = `pdl_sdbx_apikey_${ULID}_${MID}_${TAIL}`;

/** 🔴 Verbatim shape of the defect that reached production. */
const OBSERVED_DEFECT = `pdlsdbxapikey${ULID}${MID}_${TAIL}`;

describe('paddleApiKeyVerdict', () => {
  it('accepts a documented key for the environment it is configured for', () => {
    expect(paddleApiKeyVerdict(REAL_SHAPE_SANDBOX, 'sandbox')).toEqual({ kind: 'ok', env: 'sandbox' });
    expect(paddleApiKeyVerdict(REAL_SHAPE_LIVE, 'live')).toEqual({ kind: 'ok', env: 'live' });
  });

  it('the documented format is 69 characters with five underscores', () => {
    // Pins the fixtures themselves: if these drift, every other case below is
    // measuring something other than a Paddle key.
    expect(REAL_SHAPE_LIVE).toHaveLength(69);
    expect(REAL_SHAPE_LIVE.split('_')).toHaveLength(6);
  });

  it('names a key that belongs to the OTHER environment, both directions', () => {
    expect(paddleApiKeyVerdict(REAL_SHAPE_LIVE, 'sandbox')).toEqual({
      kind: 'wrong_env',
      env: 'live',
      configured: 'sandbox',
    });
    expect(paddleApiKeyVerdict(REAL_SHAPE_SANDBOX, 'live')).toEqual({
      kind: 'wrong_env',
      env: 'sandbox',
      configured: 'live',
    });
  });

  it('🔴 recognises the exact defect found in production on 2026-08-31', () => {
    expect(OBSERVED_DEFECT).toHaveLength(65);
    expect(paddleApiKeyVerdict(OBSERVED_DEFECT, 'sandbox')).toEqual({
      kind: 'underscores_stripped',
      expectedLength: 69,
      actualLength: 65,
    });
  });

  it('also recognises the all-underscores-removed variant', () => {
    expect(paddleApiKeyVerdict(`pdlsdbxapikey${ULID}${MID}${TAIL}`, 'sandbox').kind).toBe('underscores_stripped');
  });

  it('does not mistake other Paddle secrets for an API key', () => {
    // A notification (webhook) secret and a client-side token both start `pdl_`
    // and are the two things most likely to be pasted into the wrong variable.
    expect(paddleApiKeyVerdict(`pdl_ntfset_01kyyd4b8f6phjwwxn6wwe7gez_zbCfkI7oza+bH9p6uepiWhLxZBNbLUzZ`, 'sandbox').kind).toBe(
      'malformed',
    );
    expect(paddleApiKeyVerdict(`live_${ULID}`, 'live').kind).toBe('malformed');
  });

  it('calls the dashboard identifier what it is: not a key', () => {
    // What the Authentication page displays after creation, which is what an
    // operator will reach for first because it is the only thing still visible.
    expect(paddleApiKeyVerdict(`pdl_sdbx_apikey_${ULID}`, 'sandbox').kind).toBe('malformed');
  });

  it('treats empty as malformed rather than throwing', () => {
    expect(paddleApiKeyVerdict('', 'live')).toEqual({ kind: 'malformed', actualLength: 0 });
  });
});

describe('describePaddleApiKeyVerdict', () => {
  it('🔴 never contains the key', () => {
    for (const [key, env] of [
      [REAL_SHAPE_LIVE, 'live'],
      [REAL_SHAPE_SANDBOX, 'live'],
      [OBSERVED_DEFECT, 'sandbox'],
      ['garbage', 'sandbox'],
    ] as const) {
      const sentence = describePaddleApiKeyVerdict(paddleApiKeyVerdict(key, env));
      expect(sentence).not.toContain(ULID);
      expect(sentence).not.toContain(MID);
      expect(sentence).not.toContain(key);
    }
  });

  it('tells the operator to REPAIR a stripped key and to REPLACE a wrong-env one', () => {
    // The two verdicts exist precisely because the actions differ; a message
    // that blurred them would make the split pointless.
    expect(describePaddleApiKeyVerdict(paddleApiKeyVerdict(OBSERVED_DEFECT, 'sandbox'))).toMatch(/recoverable/);
    expect(describePaddleApiKeyVerdict(paddleApiKeyVerdict(REAL_SHAPE_LIVE, 'sandbox'))).toMatch(
      /different key, not a repair/,
    );
  });
});
