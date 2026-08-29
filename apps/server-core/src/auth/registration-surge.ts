// SPEC-REF:
//   docs/decisions/2026-08-27-owner-web-rulings-batch-2.md item 4, third clause
//     (owner, verbatim: 「控制台也需要控制整体的一个策略，如果当天注册用户太多如
//      达到 50 个以上就需要立即做验证码确认」)
//   src/auth/captcha.ts — the provider seam. This module decides WHEN a
//     challenge is demanded; that one only answers whether a token is good.
//   src/auth/register-rate-limit.ts — the PER-IP floor this stands behind, and
//     the reason it is not enough on its own
//   src/http/auth-routes.ts + src/http/google-auth-routes.ts — the two mint
//     paths, BOTH of which count here
//   src/socket/cloud-image-policy.ts — the in-memory-counter precedent, whose
//     header carries the same restart-forgets-everything admission
//   *** SENSITIVE SURFACE (auth: it can close account creation) ***
//
// The GLOBAL daily registration gate: count every account this deployment mints
// today, and once the day's total reaches the threshold, demand that the next
// person prove they are human before another one is minted.
//
// ── 🔴 WHY A GLOBAL COUNTER WHEN THERE IS ALREADY A PER-IP CAP ──────────────
// Because the per-IP cap is defeated by the one thing every farming toolkit
// already does: rotate addresses. Two accounts per address is a price, not a
// wall — a botnet with a thousand addresses pays it two thousand times without
// noticing. This counter does not care which address a mint came from, so
// rotation buys nothing against it. The two are the pair the owner's ruling
// describes: a per-source ceiling AND an aggregate one.
//
// ⚠️ AND IT IS NOT A CAP. Reaching 50 does not refuse anybody. It raises the
// cost of the 51st account from「a POST」to「a POST plus a solved challenge」,
// which is the difference between farming and not farming, and costs a real
// person about two seconds. Below the threshold NOTHING is demanded and no
// widget is ever drawn (the console renders it only after a refusal says to).
//
// ── WHY THE DAY IS UTC, AND WHY THAT IS SAID OUT LOUD ──────────────────────
// `utcDay` is what site analytics, the cloud-image quota and every other daily
// bucket in this repo already use, so「today」has ONE meaning here. The visible
// consequence, stated rather than discovered: the counter resets at 00:00 UTC,
// which is the middle of the afternoon in the operator's own timezone. That is
// correct for a gate that exists to bound a DAY's cost and would be wrong for
// anything a user is told about — nobody is told about this one.
//
// ── 🔴 IN MEMORY, AND A RESTART FORGETS THE DAY ─────────────────────────────
// The same admission socket/cloud-image-policy.ts makes about its own window,
// in the same words, because it is the same trade and the same cost: a relay
// restart hands the attacker a fresh 50. It is accepted knowingly —
//   · the alternative is a table and a migration, and a migration to hold a
//     counter that is ALLOWED to be forgotten is the wrong trade
//     (cloud-image-policy.ts §「WHY IN MEMORY」 argues this in full);
//   · a script cannot restart the relay, so the hole is not on the attacker's
//     path, it is on ours: a deploy in the middle of an attack re-opens the
//     door until 50 more accounts are minted, and whoever deploys should know
//     that. This paragraph is how they know.
// If the day comes that this matters, the fix is a table and a migration, not a
// bigger comment.

import { log } from '../log';
import { utcDay } from '../site/sanitize';
import { resolveCaptchaVerifier, type CaptchaVerifier } from './captcha';

/**
 * 🔴 AN OWNER NUMBER, NOT OURS. docs/decisions/2026-08-27-owner-web-rulings-batch-2.md
 * item 4: 「如果当天注册用户太多如达到 50 个以上就需要立即做验证码确认」.
 *
 * The comparison is `>=`, i.e. the challenge is armed the moment the day's
 * 50th account exists and the 51st registration is the first one to meet it.
 * 「达到 50 个以上」 reads either way; this is the stricter reading, and on a
 * gate whose whole purpose is to bound a cost the stricter reading is the one
 * that cannot be wrong in the expensive direction.
 */
export const REGISTRATION_SURGE_THRESHOLD = 50;

/** The surge is on and this request brought no challenge token — 403. The
 *  client's move is to render the widget and try again, which is why the body
 *  carries `captcha_required: true` rather than leaving the console to infer it
 *  from a string. HTTP-local, on the VERIFY_ / GOOGLE_ precedent: it never
 *  crosses a socket and the owner-gated protocol `ERROR_CODES` table does not
 *  move for it. */
export const REGISTER_CAPTCHA_REQUIRED = 'REGISTER_CAPTCHA_REQUIRED';
/** A token was presented and the provider would not vouch for it — 403. Kept
 *  SEPARATE from the name above even though both mean「solve a challenge」,
 *  because they are different sentences to a person: one is「we need one more
 *  step」and the other is「that did not work, try again」. A single name would
 *  make the console show the first sentence to somebody who just failed. */
export const REGISTER_CAPTCHA_INVALID = 'REGISTER_CAPTCHA_INVALID';
/**
 * The surge is on and this deployment CANNOT run a challenge — 503, nothing
 * minted.
 *
 * 🔴 FAIL CLOSED, AND THE TRADE IS THE WHOLE ARGUMENT. The two directions are
 * not symmetric: an OPEN registration door during an attack costs real money
 * (every minted account carries a free managed-STT allowance, which is exactly
 * the cost the owner named), and it costs it continuously and invisibly until
 * somebody looks at a bill. A CLOSED one costs sign-ups — visibly, immediately,
 * and only for as long as it takes an operator to set one environment variable.
 * We take the failure we can see over the one we cannot.
 *
 * ⚠️ It is 503 and not 403 because it is OUR failure, not the caller's: they
 * did nothing wrong and there is nothing they can do differently. Dressing it
 * up as a refused challenge would send them to solve a puzzle that does not
 * exist. And it is the LAST arm, not the first: below the threshold an
 * unconfigured deployment is completely unaffected — a box that never surges
 * never needs a secret.
 */
export const REGISTER_TEMPORARILY_CLOSED = 'REGISTER_TEMPORARILY_CLOSED';

/**
 * The day's mint total, in memory.
 *
 * ONE counter per process, held beside the per-IP limiters and for the same
 * reason they are single instances: a per-request one would count to one and
 * gate nothing (the ReleaseSuppression trap this repo has paid for before).
 */
export class RegistrationSurgeCounter {
  private day = '';
  private mints = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly threshold: number = REGISTRATION_SURGE_THRESHOLD,
  ) {}

  /**
   * Count one minted account.
   *
   * 🔴 CALLED FROM EVERY MINT PATH, WITHOUT EXCEPTION — the password route AND
   * the Google route. A path that mints without counting does not merely
   * under-report: it is a way to walk the day's total past the threshold while
   * the gate still reads「calm」, i.e. the gate's own bypass. The Google arm
   * was the uncapped mint path this repo had already written down as a known
   * hole (http/auth-routes.ts header); for THIS counter it is closed.
   */
  record(): void {
    this.roll();
    this.mints += 1;
  }

  /** Accounts minted so far today (UTC). */
  today(): number {
    this.roll();
    return this.mints;
  }

  /** True = the next registration must carry a solved challenge. */
  surging(): boolean {
    return this.today() >= this.threshold;
  }

  /**
   * The number THIS counter arms at.
   *
   * Exposed so every log line below can report the value actually in force
   * instead of {@link REGISTRATION_SURGE_THRESHOLD}. With an override in play
   * those two differ, and a refusal line quoting the constant would be a true
   * sentence about the wrong deployment — the shape this repo keeps paying for.
   */
  get armsAt(): number {
    return this.threshold;
  }

  /** Reset on the first touch of a new UTC day. Lazy rather than on a timer:
   *  a timer would be a second thing to shut down, and nothing reads this
   *  counter except the two routes that are about to touch it anyway. */
  private roll(): void {
    const today = utcDay(this.now());
    if (today === this.day) return;
    this.day = today;
    this.mints = 0;
  }
}

/** What the gate hands back. `ok:false` carries a ready-to-send status and
 *  body so the two routes cannot render the same refusal two different ways. */
export type SurgeGateVerdict =
  | { ok: true }
  | { ok: false; status: number; body: { error: string; captcha_required?: true } };

/** The two collaborators the gate needs, grouped so a route takes ONE optional
 *  dep rather than two that could arrive half-wired. */
export interface RegistrationSurgeGate {
  counter: RegistrationSurgeCounter;
  verifier: CaptchaVerifier;
}

/**
 * The gate itself — shared by `/api/register` and `/api/auth/google`.
 *
 * 🔴 ONE FUNCTION FOR BOTH DOORS. Two copies of this four-branch decision is
 * two places for the fail-closed arm to be forgotten, and the one that would be
 * forgotten is the Google route (it is the door nobody thinks of as「register」
 * — which is exactly how it ended up uncapped in the first place).
 *
 * @param captchaToken the client's `captcha_token` field, `''` when absent.
 * @param ip the caller's address, passed to the provider as corroboration only.
 */
export async function guardRegistrationSurge(
  gate: RegistrationSurgeGate | undefined,
  captchaToken: string,
  ip: string,
  source: 'register' | 'google',
): Promise<SurgeGateVerdict> {
  // Absent (unit tests that predate this card, and standalone, which mounts no
  // account surface at all) ⇒ the gate does not exist and registration is
  // exactly what it was. This is the one DI absence allowed here, for the
  // reason `verificationMail` states in http/auth-routes.ts; what it does NOT
  // cover — a PRODUCTION wire silently missing — is covered by a test that
  // boots the real bootstrap, not by this sentence.
  if (!gate) return { ok: true };
  // 🔴 THE CALM PATH IS FIRST AND COSTS NOTHING. On an ordinary day this is one
  // integer comparison and no captcha is demanded, no widget is drawn, no
  // provider is contacted. A gate that made every registration slower would be
  // paid for by every real user in exchange for a threat that arrives rarely.
  if (!gate.counter.surging()) return { ok: true };

  if (!gate.verifier.configured) {
    // LOUD, structured, and it names the env var: this line IS the runbook, and
    // it is the only thing standing between an operator and a silently shut
    // front door. WARN would be wrong — every one of these is a lost sign-up.
    log.error(
      'auth: REGISTRATION CLOSED — the daily surge threshold is met and this deployment cannot run a human check',
      {
        env: 'FLOWMIC_TURNSTILE_SECRET',
        minted_today: gate.counter.today(),
        threshold: gate.counter.armsAt,
        verifier: gate.verifier.id,
        source,
        ip,
      },
    );
    return { ok: false, status: 503, body: { error: REGISTER_TEMPORARILY_CLOSED } };
  }

  if (captchaToken === '') {
    // NOT an error line: on a surging day this is the NORMAL first response to
    // every honest registration, and logging each one at error level would bury
    // the one line above under thousands of routine ones.
    log.info('auth: registration surge active — asking for a human check', {
      minted_today: gate.counter.today(),
      threshold: gate.counter.armsAt,
      source,
    });
    return { ok: false, status: 403, body: { error: REGISTER_CAPTCHA_REQUIRED, captcha_required: true } };
  }

  const passed = await gate.verifier.verify(captchaToken, ip);
  if (!passed) {
    log.warn('auth: registration refused — the human check did not pass', {
      minted_today: gate.counter.today(),
      verifier: gate.verifier.id,
      source,
      ip,
    });
    // `captcha_required` stays TRUE here: the client's next move is still「show
    // the widget」. Dropping it would make the console hide the one control the
    // person needs in order to retry.
    return { ok: false, status: 403, body: { error: REGISTER_CAPTCHA_INVALID, captcha_required: true } };
  }
  return { ok: true };
}

/**
 * Build the process-wide gate from the environment.
 *
 * ── ENVIRONMENT ────────────────────────────────────────────────────────────
 *   FLOWMIC_REGISTER_SURGE_THRESHOLD — optional integer override of
 *     {@link REGISTRATION_SURGE_THRESHOLD}.
 *
 * ⚠️ THE DEFAULT IS THE OWNER'S 50 AND AN OVERRIDE IS AN OPS ACTION, NOT A
 * PRODUCT DECISION. It exists for the same two reasons FLOWMIC_VERIFY_GRACE_EPOCH
 * does: an operator watching an attack must be able to tighten the gate without
 * a release, and a test must be able to reach the surging state without minting
 * fifty accounts — a test that cannot afford to reach a state is a state nobody
 * ever proves the behaviour of.
 *
 * A junk or non-positive value falls back to the ruled default and SAYS SO. It
 * does not disable the gate: an unreadable number is an operator's typo, and
 * silently turning off the thing that bounds a bill because of a typo is the
 * fail-open direction this whole module refuses.
 *
 * The boot line is printed in BOTH directions (mail/index.ts's rule): on the
 * day a surge starts, 「was the gate even armed, and at what number」 has to
 * already be in the log.
 */
export function resolveRegistrationSurgeGate(
  env: NodeJS.ProcessEnv = process.env,
  now?: () => number,
): RegistrationSurgeGate {
  const raw = (env.FLOWMIC_REGISTER_SURGE_THRESHOLD ?? '').trim();
  let threshold = REGISTRATION_SURGE_THRESHOLD;
  if (raw !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) threshold = parsed;
    else
      log.error('auth: FLOWMIC_REGISTER_SURGE_THRESHOLD is not a positive integer — keeping the ruled default', {
        env: 'FLOWMIC_REGISTER_SURGE_THRESHOLD',
        value: raw,
        threshold,
      });
  }
  const verifier = resolveCaptchaVerifier(env);
  log.info('auth: daily registration surge gate armed', {
    threshold,
    ruled_default: REGISTRATION_SURGE_THRESHOLD,
    verifier: verifier.id,
    // The consequence spelled out at boot, so nobody has to derive it from two
    // separate lines at 3am: with no verifier, arming the gate means CLOSING
    // registration rather than challenging it.
    on_threshold: verifier.configured ? 'challenge' : 'close',
  });
  return { counter: new RegistrationSurgeCounter(now, threshold), verifier };
}
