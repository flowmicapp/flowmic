// Window D1 Lane B — config.ts: the `paddle` block and the `planLimits` overlay.
//
// Four things here are load-bearing and only one of them is about happy paths:
//
//   ① an ENABLED webhook endpoint with NO secret verifies nothing, i.e. accepts
//      any subscription event anyone posts. That must not boot.
//   ② `enabled` is saas-only. A standalone box has no merchant of record and
//      nothing to bill; an open endpoint there is pure attack surface. It is
//      CLAMPED (with a warning), not rejected — a dev with the flag left in
//      their shell must still be able to start their LAN server.
//   ③ every price_id must map to a REAL tier. A typo'd tier that we accepted
//      would surface only as a user who paid and stayed on free.
//   ④ 🔴 the secret never reaches a log line. Only its length and presence.
//
// Plus the A1 seam: FLOWMIC_PLAN_LIMITS must reach planLimits() by the time
// loadConfig returns — a parsed-but-unapplied overlay is 「configured but not in effect」.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PADDLE_TOLERANCE_SEC, loadConfig } from '../src/config';
import { planLimits, resetPlanLimits } from '../src/billing/plans';

const SECRET = 'paddle-config-secret-32-bytes-minimum-xx';
// fix-010 `trustedProxies: []` — the declared proxy posture of an in-process
// config resolution (nothing is in front of it). Declared, not exempted; without
// it every saas case here would refuse before reaching the paddle guards these
// tests exist to pin, i.e. one requirement would shadow another's assertion.
const SAAS = { mode: 'saas' as const, secret: SECRET, dbPath: ':memory:', trustedProxies: [] };
const STANDALONE = { mode: 'standalone' as const, secret: SECRET };

const PADDLE_ENV_VARS = [
  'FLOWMIC_PADDLE_ENABLED',
  'FLOWMIC_PADDLE_ENV',
  'FLOWMIC_PADDLE_WEBHOOK_SECRET',
  'FLOWMIC_PADDLE_API_KEY',
  'FLOWMIC_PADDLE_WRITE_ENABLED',
  'FLOWMIC_PADDLE_TOLERANCE_SEC',
  'FLOWMIC_PADDLE_PRICE_TIERS',
  'FLOWMIC_PLAN_LIMITS',
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of PADDLE_ENV_VARS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of PADDLE_ENV_VARS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // loadConfig installs a plan-limits table as a side effect; leaving an
  // overridden one behind would poison every later test in this file.
  resetPlanLimits();
  vi.restoreAllMocks();
});

describe('paddle config — defaults', () => {
  it('is off, sandbox, 5s tolerance, no mapping, no secrets', () => {
    const c = loadConfig(SAAS);
    expect(c.paddle).toEqual({
      enabled: false,
      env: 'sandbox',
      webhookSecret: null,
      apiKey: null,
      writeEnabled: false,
      toleranceSec: DEFAULT_PADDLE_TOLERANCE_SEC,
      priceTiers: {},
    });
    expect(c.planLimits).toBeNull();
  });

  // 🔴 0.3.25 B2 — THE DEFAULT THAT MATTERS MOST IN THIS FILE, asserted on its
  // own as well as inside the shape above. Everything else here defaults to
  // 「inert」; this one defaults to 「cannot spend money or cancel anybody」, and
  // it is the property an owner ruling rests on (writes stay off until owner
  // opens them). A shape assertion can be 「fixed」 by pasting a new field in
  // with whatever value made it pass — this one names the value and why.
  it('🔴 outbound writes default OFF, and are a SEPARATE switch from intake', () => {
    expect(loadConfig(SAAS).paddle.writeEnabled).toBe(false);
    // Turning intake on must not turn writes on. They are different risks:
    // intake is read-only, a write can cancel a paying customer or move money.
    // Driven through the ENV, like every other case in this file — the same
    // path production takes, rather than an override the real deployment never
    // uses.
    process.env.FLOWMIC_PADDLE_ENABLED = '1';
    process.env.FLOWMIC_PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_abc';
    const intakeOn = loadConfig(SAAS);
    expect(intakeOn.paddle.enabled).toBe(true);
    expect(intakeOn.paddle.writeEnabled).toBe(false);
    // Positive control: the switch DOES respond to its own variable, so the
    // false above is 「intake did not turn it on」 and not 「nothing can」.
    process.env.FLOWMIC_PADDLE_WRITE_ENABLED = '1';
    expect(loadConfig(SAAS).paddle.writeEnabled).toBe(true);
  });

  it("defaults to sandbox — production has to be said out loud", () => {
    expect(loadConfig(SAAS).paddle.env).toBe('sandbox');
    process.env.FLOWMIC_PADDLE_ENV = 'production';
    expect(loadConfig(SAAS).paddle.env).toBe('production');
  });

  it('rejects an unrecognised FLOWMIC_PADDLE_ENV', () => {
    process.env.FLOWMIC_PADDLE_ENV = 'staging';
    expect(() => loadConfig(SAAS)).toThrow(/FLOWMIC_PADDLE_ENV/);
  });
});

describe('paddle config — the two boot guards', () => {
  it('🔴 enabled + missing webhook secret ⇒ refuses to start', () => {
    process.env.FLOWMIC_PADDLE_ENABLED = '1';
    expect(() => loadConfig(SAAS)).toThrow(/FLOWMIC_PADDLE_WEBHOOK_SECRET/);
    // Positive control: the same config WITH a secret starts fine, so the throw
    // above is the guard and not some unrelated saas requirement.
    process.env.FLOWMIC_PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_whatever';
    expect(loadConfig(SAAS).paddle.enabled).toBe(true);
  });

  it('a set-but-blank secret is a broken deploy, not "no secret"', () => {
    process.env.FLOWMIC_PADDLE_WEBHOOK_SECRET = '   ';
    expect(() => loadConfig(SAAS)).toThrow(/set but empty/);
  });

  it('🔴 standalone clamps enabled to false, warns, and does NOT demand a secret', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.env.FLOWMIC_PADDLE_ENABLED = '1';
    const c = loadConfig(STANDALONE); // no secret configured — must still boot
    expect(c.paddle.enabled).toBe(false);
    const lines = warn.mock.calls.map((c2) => String(c2[0])).join('');
    expect(lines).toMatch(/saas-only/);
  });

  it('saas + enabled + secret ⇒ enabled stays true', () => {
    process.env.FLOWMIC_PADDLE_ENABLED = '1';
    process.env.FLOWMIC_PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_abc';
    expect(loadConfig(SAAS).paddle.enabled).toBe(true);
  });
});

describe('paddle config — price_id → tier mapping', () => {
  it('maps every configured price id to a real tier', () => {
    process.env.FLOWMIC_PADDLE_PRICE_TIERS = '{"pri_pro_monthly":"pro","pri_max_monthly":"max"}';
    expect(loadConfig(SAAS).paddle.priceTiers).toEqual({
      pri_pro_monthly: 'pro',
      pri_max_monthly: 'max',
    });
  });

  it('rejects a tier name that is not a tier — including a case variant', () => {
    process.env.FLOWMIC_PADDLE_PRICE_TIERS = '{"pri_x":"enterprise"}';
    expect(() => loadConfig(SAAS)).toThrow(/not a plan tier/);
    process.env.FLOWMIC_PADDLE_PRICE_TIERS = '{"pri_x":"Pro"}';
    expect(() => loadConfig(SAAS)).toThrow(/not a plan tier/);
  });

  it('rejects malformed JSON and a non-object', () => {
    process.env.FLOWMIC_PADDLE_PRICE_TIERS = '{oops';
    expect(() => loadConfig(SAAS)).toThrow(/not valid JSON/);
    process.env.FLOWMIC_PADDLE_PRICE_TIERS = '["pri_x"]';
    expect(() => loadConfig(SAAS)).toThrow(/must be a JSON object/);
  });

  it('rejects a tolerance outside 1..3600', () => {
    process.env.FLOWMIC_PADDLE_TOLERANCE_SEC = '0';
    expect(() => loadConfig(SAAS)).toThrow(/TOLERANCE_SEC/);
    process.env.FLOWMIC_PADDLE_TOLERANCE_SEC = 'abc';
    expect(() => loadConfig(SAAS)).toThrow(/TOLERANCE_SEC/);
    process.env.FLOWMIC_PADDLE_TOLERANCE_SEC = '30';
    expect(loadConfig(SAAS).paddle.toleranceSec).toBe(30);
  });
});

describe('🔴 secrets never reach a log line', () => {
  const WEBHOOK = 'pdl_ntfset_TOPSECRET_webhook_value_9f3a';
  const API_KEY = 'pdl_sdbx_apikey_ANOTHER_SECRET_7c21';

  it('logs the length and presence, never the value', () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    process.env.FLOWMIC_PADDLE_ENABLED = '1';
    process.env.FLOWMIC_PADDLE_WEBHOOK_SECRET = WEBHOOK;
    process.env.FLOWMIC_PADDLE_API_KEY = API_KEY;
    process.env.FLOWMIC_PADDLE_PRICE_TIERS = '{"pri_a":"pro"}';
    const c = loadConfig(SAAS);

    const logged = writes.join('');
    // Positive control FIRST: the boot line about paddle really was emitted, so
    // "the secret is absent" cannot be passing because nothing was logged at all.
    expect(logged).toMatch(/paddle webhook intake enabled/);
    expect(logged).toContain(`"webhook_secret_len":${WEBHOOK.length}`);
    expect(logged).toContain('"api_key_present":true');

    // The negative assertion, on the whole captured stream — not on one line.
    expect(logged).not.toContain(WEBHOOK);
    expect(logged).not.toContain(API_KEY);
    // Not even a prefix long enough to be useful.
    expect(logged).not.toContain(WEBHOOK.slice(0, 16));
    expect(logged).not.toContain(API_KEY.slice(0, 16));

    // And the config really is carrying them — the secret is withheld from the
    // log, not dropped on the floor.
    expect(c.paddle.webhookSecret).toBe(WEBHOOK);
    expect(c.paddle.apiKey).toBe(API_KEY);
  });
});

describe('A1 — FLOWMIC_PLAN_LIMITS reaches planLimits() by the time loadConfig returns', () => {
  it('applies the overlay to the live table (the seam is wired, not just parsed)', () => {
    process.env.FLOWMIC_PLAN_LIMITS = '{"free":{"stt_minutes":25},"pro":{"llm_tokens":3000000}}';
    const c = loadConfig(SAAS);
    expect(c.planLimits).toEqual({ free: { stt_minutes: 25 }, pro: { llm_tokens: 3_000_000 } });
    // The part that matters: the module every enforcement site reads answers
    // with the configured number, with nobody having called an installer.
    expect(planLimits('free').stt_minutes).toBe(25);
    expect(planLimits('pro').llm_tokens).toBe(3_000_000);
    expect(planLimits('max').stt_minutes).toBe(3_000); // untouched
  });

  it('an unconfigured boot leaves the defaults in force', () => {
    loadConfig(SAAS);
    expect(planLimits('free').stt_minutes).toBe(20);
    expect(planLimits('pro').stt_minutes).toBe(900);
    expect(planLimits('max').stt_minutes).toBe(3_000);
  });

  it('malformed JSON fails the boot instead of silently using defaults', () => {
    process.env.FLOWMIC_PLAN_LIMITS = '{"free":';
    expect(() => loadConfig(SAAS)).toThrow(/FLOWMIC_PLAN_LIMITS is not valid JSON/);
  });

  it('an unknown tier fails the boot', () => {
    process.env.FLOWMIC_PLAN_LIMITS = '{"enterprise":{"stt_minutes":1}}';
    expect(() => loadConfig(SAAS)).toThrow(/unknown tier "enterprise"/);
  });

  it('an unknown limit key fails the boot (a typo must not be ignored)', () => {
    process.env.FLOWMIC_PLAN_LIMITS = '{"free":{"stt_mins":25}}';
    expect(() => loadConfig(SAAS)).toThrow(/unknown limit "stt_mins"/);
  });

  // ⚠️ 2026-08-02 — this case used to be `{"max":{"pcs":5}}`. That override is now
  // LEGAL (owner ruled pcs is a 2/3/10 scale ladder, not a capability), so the
  // wall has to be demonstrated on a dimension that is still walled or the test
  // proves nothing. `mobiles` is the replacement; `history_days` would do equally.
  it('a capability wall fails the boot', () => {
    process.env.FLOWMIC_PLAN_LIMITS = '{"max":{"mobiles":5}}';
    expect(() => loadConfig(SAAS)).toThrow(/capability wall/);
  });

  // The check that took `pcs`'s place — asserted HERE too, not only in
  // plan-limits.test.ts, because this file is the one that proves the env var
  // actually reaches the validator instead of being parsed and dropped.
  it('a downhill pcs ladder fails the boot (the check that replaced the wall for pcs)', () => {
    process.env.FLOWMIC_PLAN_LIMITS = '{"max":{"pcs":1}}';
    expect(() => loadConfig(SAAS)).toThrow(/must not shrink/);
  });

  it('an UPHILL pcs override boots and reaches planLimits (positive control)', () => {
    process.env.FLOWMIC_PLAN_LIMITS = '{"max":{"pcs":25}}';
    loadConfig(SAAS);
    expect(planLimits('max').pcs).toBe(25);
  });

  it('an explicit override argument wins over the env var', () => {
    process.env.FLOWMIC_PLAN_LIMITS = '{"free":{"stt_minutes":25}}';
    loadConfig({ ...SAAS, planLimits: null });
    expect(planLimits('free').stt_minutes).toBe(20);
  });
});
