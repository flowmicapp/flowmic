// SPEC-REF:
//   docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md item 3 (宽限期 = 3 天)
//     and item 4 (到期降级形状: 云端拒新会话 + 具名提示; 已连会话不掐; LAN 永不受限)
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §2
//     ("不挡核心体验" — the grace exists so a new user reaches 「说话上屏」 before
//      anything is asked of them)
//   src/billing/quota-guard.ts — the sibling gate, at the SAME two call sites,
//     and the file whose 2026-08-07 correction block describes the ack-visibility
//     gap this card inherits and deliberately does not try to fix
//   src/auth/email-verification.ts — `isEmailVerified`, the ONE column→verdict
//     conversion this file builds on rather than repeats
//   *** HUMAN-AUDIT SENSITIVE (auth: who may start a managed cloud session) ***
//
// THE 3-DAY UNVERIFIED GRACE. An account that has not verified its email address
// still gets the full managed cloud product for three days; after that, managed
// cloud SESSION STARTS are refused by name. LAN is never gated, in any mode, for
// any account — it costs us nothing and does not depend on a reachable mailbox.
//
// 🔴 ONE CONVERSION SITE. `verificationGrace()` below is the only place
// (email_verified_at, created_at, now) becomes a verdict. The guard refuses
// through it and `publicUser` reports through it, so the number the client
// paints a banner from and the number the server enforces cannot disagree —
// the same discipline `isEmailVerified` states one file over, and the failure
// it prevents is the one CLAUDE.md R11 names: a layer judging without the fact.
//
// ── 🔴 THE GRANDFATHERING TRAP, AND THE MECHANISM CHOSEN FOR IT ──────────────
// Naively, grace runs from `users.created_at`. Deploy that and EVERY existing
// unverified account — every one of them older than three days — is refused on
// its very next sentence, with no warning and no mail having ever been sent. The
// feature would ship as an outage.
//
// So the clock starts at max(created_at, FEATURE EPOCH). Options considered and
// why this one:
//   · a new `grace_started_at` column defaulted at migration — correct, and a
//     schema change plus a backfill for a value that is the same constant for
//     every pre-existing row;
//   · a row written at first boot ("this feature was first seen at …") — a
//     write during boot whose failure mode is a server that cannot start;
//   · A CONSTANT, overridable by env — chosen. No schema, no backfill, nothing
//     to migrate, and the semantics are readable in one line.
//
// ⚠️ WHAT THE CONSTANT ACTUALLY MEANS, stated because a date in a source file is
// the archetype of an expiring truth: it is the instant this gate is allowed to
// start biting. NOBODY, however old their account, can be refused before
// EPOCH + 3 days. If this code ships LATER than that date, pre-existing
// unverified accounts are refused on the first cloud session after the deploy —
// which is the very outage above, arriving quietly because a constant went stale.
// `FLOWMIC_VERIFY_GRACE_EPOCH` exists for exactly that: on the day this deploys,
// an operator who is late sets it to the deploy date and every existing account
// gets its three days from then. The boot log prints the resolved value in both
// cases, so「which epoch is this machine using」is answerable from the log alone.

import type { ServerMode } from '@flowmic/protocol';
import type { UserRepo } from '../db/repos/user.repo';
import { log } from '../log';
import { isEmailVerified } from './email-verification';

/** owner 2026-08-27 ruling item 3, verbatim: 「宽限期 = 3 天」. Not a
 *  first-responsible number — this one was ruled on. */
export const VERIFICATION_GRACE_DAYS = 3;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const VERIFICATION_GRACE_MS = VERIFICATION_GRACE_DAYS * DAY_MS;

/** The default feature epoch: the day card NR-2a was written. See the header
 *  block for what this date means and why it is overridable. */
export const DEFAULT_VERIFICATION_GRACE_EPOCH_ISO = '2026-08-27T00:00:00.000Z';
export const VERIFICATION_GRACE_EPOCH_ENV = 'FLOWMIC_VERIFY_GRACE_EPOCH';

/**
 * The refusal a managed cloud session start answers with once the grace has run
 * out.
 *
 * An HTTP-LOCAL / ACK-LOCAL string on the precedent set by the refusal name
 * auth/email-verification.ts owns.
 *
 * 🔴 CORRECTION (WP-8, 2026-09-02): the two paragraphs below described a real
 * gap that is now closed — this name IS a protocol `ErrorCode` as of this
 * round (`packages/protocol/src/error-codes.ts`), registered under the exact
 * same string this constant holds (pinned by
 * `test/verification-grace.test.ts`'s "pins" describe block, which used to
 * assert the opposite). The phone already had bespoke sentences for it before
 * today (`recording_strings.dart` `sttStallVerifyEmail`,
 * `compose_strings.dart` `case 'EMAIL_VERIFY_GRACE_EXPIRED'`) — what it lacked
 * was a row in the registry, which is what the count guard, the
 * i18n-error-keys lint and `inject-verdict-authorship.ts`'s exhaustive
 * `satisfies` all actually read. Original paragraphs kept verbatim below: they
 * were true when written, and they are the reason this correction exists
 * rather than a silent edit.
 *
 * ⚠️ THE SIBLING'S NAME IS DELIBERATELY NOT SPELLED OUT ANYWHERE IN THIS FILE.
 * test/email-verification.test.ts runs a source-tree CENSUS of which files name
 * it, whose whole point is that every device surface stays exempt BY
 * CONSTRUCTION; a prose mention here would have to be added to that list and
 * would weaken it into 「files that name it, plus the ones that only talk about
 * it」. Pointing at the file instead costs a reader one grep and costs the
 * census nothing.
 *
 * 🔴 AND THE COST OF THAT IS STATED RATHER THAN HIDDEN. Unlike
 * that one — whose only possible receiver is the repo-owned web
 * console — this string CAN reach a phone, because `audio:start` and
 * `compose:start` are phone events. What the phone does with a name it does not
 * know is render its generic failure sentence, not this one. That is a real
 * gap, it is the reason the field `verify_grace_days_left` exists on every user
 * projection (so a client can warn BEFORE the refusal rather than decode it
 * after), and closing it properly means asking the owner for a real error code
 * on the day the client half of this card is built. Widening one of the existing
 * codes to cover it would be the 「一码两问」 shape this repo hunts.
 */
export const EMAIL_VERIFY_GRACE_EXPIRED = 'EMAIL_VERIFY_GRACE_EXPIRED';

export type VerificationGraceState = 'verified' | 'in_grace' | 'expired';

export interface VerificationGraceVerdict {
  state: VerificationGraceState;
  /**
   * Whole days left, rounded UP, while `state === 'in_grace'`; `null` when the
   * account is verified (or has no address to verify); `0` when expired.
   *
   * ⚠️ NULL AND 0 ARE DIFFERENT ANSWERS and must not be collapsed. `null` means
   * 「there is no countdown」 and 0 means 「the countdown finished」 — a client that
   * treated null as 0 would paint 「0 days left」 at a verified user.
   */
  daysLeft: number | null;
}

export interface VerificationGraceInput {
  /** `users.email_verified_at`, raw. */
  emailVerifiedAt: number | null;
  /** `users.created_at` as ms-since-epoch. NaN (an unparseable column) is
   *  treated as「unknown」and yields `verified`-shaped permissiveness — see the
   *  body: refusing a session because we could not read our own timestamp would
   *  be a wall whose stated reason is not what happened. */
  createdAtMs: number;
  /** Whether the account has an address at all. An account with no email has
   *  nothing to verify and never enters grace — this covers standalone's
   *  single 'default' row and any future email-less account shape. */
  hasEmail: boolean;
  nowMs: number;
  /** Resolved feature epoch; defaults to the constant/env pair below. */
  epochMs?: number;
}

/**
 * 🔴 THE ONE (email_verified_at, created_at, now) → verdict conversion.
 *
 * Deliberately pure and clock-injected: every caller passes its own `now`, so
 * this function has no hidden dependency on real time and every branch is
 * reachable in a test without waiting three days.
 */
export function verificationGrace(input: VerificationGraceInput): VerificationGraceVerdict {
  if (isEmailVerified(input.emailVerifiedAt)) return { state: 'verified', daysLeft: null };
  // No address ⇒ nothing to verify ⇒ no countdown. Reported as 'verified'
  // rather than as a fourth state: every consumer's question is 「may this
  // account start a cloud session」, and the answer is yes for the same reason.
  if (!input.hasEmail) return { state: 'verified', daysLeft: null };
  if (!Number.isFinite(input.createdAtMs)) return { state: 'verified', daysLeft: null };
  const epochMs = input.epochMs ?? verificationGraceEpochMs();
  // 🔴 max(created_at, epoch) — the whole grandfathering mechanism, in one
  // expression. See the file header for why it is here and not in a column.
  const startMs = Math.max(input.createdAtMs, epochMs);
  const deadlineMs = startMs + VERIFICATION_GRACE_MS;
  if (input.nowMs >= deadlineMs) return { state: 'expired', daysLeft: 0 };
  // Rounded UP so the last partial day reads 「1 day left」 and not 「0」: 0 is
  // reserved for expired, above, and a countdown that shows 0 while the product
  // still works is a status word that cannot answer 「凭什么这么说」.
  return { state: 'in_grace', daysLeft: Math.ceil((deadlineMs - input.nowMs) / DAY_MS) };
}

/**
 * Resolve the feature epoch: `FLOWMIC_VERIFY_GRACE_EPOCH` (any string `Date`
 * can parse, e.g. `2026-09-04` or a full ISO instant) or the constant.
 *
 * A value that does not parse falls back to the constant AND is not silent —
 * the caller that boots (`logVerificationGraceEpoch`) prints which one is in
 * force. Fail-safe direction: an operator's typo cannot accidentally set the
 * epoch to the Unix epoch and refuse every unverified account on the spot.
 */
export function verificationGraceEpochMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[VERIFICATION_GRACE_EPOCH_ENV];
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Date.parse(raw.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.parse(DEFAULT_VERIFICATION_GRACE_EPOCH_ISO);
}

/** The two facts a gate needs about an account, from whatever holds them
 *  (bootstrap wires this to `UserRepo.findById`). `null` = no such account. */
export interface VerificationGraceReader {
  graceInputs(userId: string): { emailVerifiedAt: number | null; createdAtMs: number; hasEmail: boolean } | null;
}

/** The named refusal, shaped like every other ack payload in this repo. */
export interface VerificationGraceRefusal {
  error: typeof EMAIL_VERIFY_GRACE_EXPIRED;
  message: string;
}

export interface VerificationGraceGuard {
  /** `null` = this account may start a managed cloud session. Non-null = the
   *  refusal to ack, verbatim. Never throws — see the factory's note. */
  check(userId: string): VerificationGraceRefusal | null;
  /** For the user projection: whole days left, or null when there is no
   *  countdown. Same conversion, same numbers. */
  daysLeft(userId: string): number | null;
}

/**
 * Build the gate.
 *
 * 🔴 STANDALONE NOOPS AT THE TOP, exactly as `makeQuotaGuard` does and for a
 * stronger reason: owner's ruling item 4 says 「LAN 永不受限」. A standalone box
 * has no account layer, no mail channel and no cost to us — a verification gate
 * there would be a wall in front of a product that works offline. Pinned by
 * test/verification-grace.test.ts, not by this comment.
 *
 * 🔴 IT RETURNS A REFUSAL, IT DOES NOT THROW. `ServerError` is typed to
 * `ErrorCode`, and this name deliberately is not one; a thrown non-ServerError
 * would fall through `errorPayload` and come out as `SETTINGS_SYNC_FAIL` — a
 * refusal whose stated reason is a lie about what happened. Returning the
 * payload keeps the name intact at both call sites.
 *
 * ⚠️ AN UNKNOWN USER IS ALLOWED THROUGH. `graceInputs` returning null means we
 * could not read the row, not that the account is unverified. Refusing on a
 * failed read would turn a database hiccup into 「verify your email」, which is
 * the R11 shape: a judgement made without the fact it needs.
 */
export function makeVerificationGraceGuard(
  reader: VerificationGraceReader,
  config: { mode: ServerMode; now?: () => number; epochMs?: number },
): VerificationGraceGuard {
  const clock = config.now ?? Date.now;
  function verdict(userId: string): VerificationGraceVerdict | null {
    const row = reader.graceInputs(userId);
    if (row === null) return null;
    return verificationGrace({
      emailVerifiedAt: row.emailVerifiedAt,
      createdAtMs: row.createdAtMs,
      hasEmail: row.hasEmail,
      nowMs: clock(),
      ...(config.epochMs !== undefined ? { epochMs: config.epochMs } : {}),
    });
  }
  return {
    check(userId): VerificationGraceRefusal | null {
      if (config.mode !== 'saas') return null; // standalone NOOP — LAN is never gated
      const v = verdict(userId);
      if (v === null || v.state !== 'expired') return null;
      return {
        error: EMAIL_VERIFY_GRACE_EXPIRED,
        // Developer context, never rendered verbatim (every message field in
        // this repo is). It names the number so a log reader does not have to
        // go and look the policy up.
        message: `the ${VERIFICATION_GRACE_DAYS}-day unverified grace period has ended for this account`,
      };
    },
    daysLeft(userId): number | null {
      // NOT mode-gated, unlike `check`. This is a REPORT, and reporting
      // 「2 days left」 on a box that will never enforce it would be a sentence
      // the product cannot keep. Standalone accounts have no email address, so
      // `verificationGrace` already answers null for them by fact rather than
      // by a second mode branch here — pinned by test.
      return verdict(userId)?.daysLeft ?? null;
    },
  };
}

/**
 * The production wiring, in one call: the `users` reader, the guard over it, and
 * the boot line that says which epoch this machine is using.
 *
 * 🔴 IT LIVES HERE AND NOT IN bootstrap.ts. The reader turns a `UserRecord` into
 * this module's three inputs — `created_at` is a TEXT column and
 * `email_verified_at` an INTEGER one, so somebody has to know both that and what
 * this file wants. Putting that knowledge in the wiring root would place a
 * second, silent conversion one file away from the one this module exists to be.
 * (bootstrap.ts is also at its 800-line cap, so a structural home was needed
 * either way — but the cap is the occasion, not the argument.)
 *
 * 🔴 THE READ IS PER SESSION START, NOT PER TOKEN. `graceInputs` goes to the
 * live row every time rather than trusting anything the JWT carries: a token
 * minted before the person verified would otherwise keep asserting
 * 「unverified」 for the whole life of that token — which, since owner ruling
 * 2026-08-27 §R1 made the default TTL 100 years, is effectively forever — the
 * same argument
 * auth/account-restriction.ts makes about why a restriction cannot ride in the
 * claims. It also means verifying takes effect on the very next press.
 */
export function wireVerificationGrace(deps: {
  users: Pick<UserRepo, 'findById'>;
  mode: ServerMode;
  now?: () => number;
}): VerificationGraceGuard {
  // Announced in BOTH directions, naming the env var and printing the RESOLVED
  // epoch — the usage-events / login-record switch shape, for its stated
  // reason: an operator must be able to answer 「when can this gate start
  // refusing people on this machine」 from the boot log alone, and a line that
  // appeared only when an override was set would make its absence ambiguous.
  log.info(
    `verification grace: ${VERIFICATION_GRACE_DAYS}-day unverified grace, ` +
      `${deps.mode === 'saas' ? 'ENFORCED' : 'NOT ENFORCED (standalone — LAN is never gated)'}`,
    {
      env: VERIFICATION_GRACE_EPOCH_ENV,
      epoch: new Date(verificationGraceEpochMs()).toISOString(),
      grace_days: VERIFICATION_GRACE_DAYS,
      mode: deps.mode,
    },
  );
  return makeVerificationGraceGuard(
    {
      graceInputs: (userId) => {
        const u = deps.users.findById(userId);
        if (!u) return null;
        return {
          emailVerifiedAt: u.email_verified_at,
          // TEXT column → ms. An unparseable value yields NaN, which
          // `verificationGrace` treats as 「unknown」 and admits — never as 0,
          // which would read as 1970 and refuse everybody.
          createdAtMs: Date.parse(u.created_at),
          hasEmail: u.email !== null,
        };
      },
    },
    { mode: deps.mode, ...(deps.now ? { now: deps.now } : {}) },
  );
}
