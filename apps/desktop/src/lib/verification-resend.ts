// SPEC-REF:
//   apps/desktop/src-tauri/src/shell/cloud.rs `cloud_verification_resend` (the
//     command, and the outcome list this file whitelists)
//   apps/desktop/src-tauri/src/cloud_account_outcome.rs `resend_outcome` (one
//     outcome per answer of POST /api/auth/email-verification/send)
//   CLAUDE.md red line: no silent failure in either direction; 15 册 §4 R11.
//
// NR-109 (MAIN decision ①, 2026-09-26) — the `unverified` account card's way
// forward: resend the verification email from the PC, with honest feedback. The
// desktop does NOT block the sign-in hand-off on verification; this is the
// action the card offers instead.
//
// Pure: which sentence each outcome gets, and whether it should re-check the
// account. The component (main-window/components/VerificationResend.vue) only
// paints it and calls the bridge.

import { S } from './strings';

/** Every outcome the Rust command can put on the wire, verbatim, plus
 *  `no_bridge` (the frontend's own: the command could not be invoked at all). */
export const RESEND_OUTCOMES = [
  'sent',
  'already_verified',
  'cooldown',
  'rate_limited',
  'no_email',
  'send_failed',
  'unauthorized',
  'bad_response',
  'unreachable',
  'no_answer',
  'no_key',
  'no_endpoint',
] as const;

export type ResendOutcome = (typeof RESEND_OUTCOMES)[number] | 'no_bridge';

export interface ResendRaw {
  outcome: ResendOutcome;
  retry_after_ms: number | null;
}

/** Normalise an IPC payload. An unreadable one is `bad_response`, never `sent`. */
export function asResendRaw(raw: unknown): ResendRaw {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const outcome = RESEND_OUTCOMES.find((k) => k === o?.outcome) ?? 'bad_response';
  const retry = o?.retry_after_ms;
  return {
    outcome,
    retry_after_ms: typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? retry : null,
  };
}

export interface ResendFeedback {
  /** The line under the button, or `null` for none. */
  text: string | null;
  /** `ok` = the thing asked for happened; `warn` = it did not, or we cannot know. */
  tone: 'ok' | 'warn';
  /** The account should be read again now (it turned out to be verified already). */
  recheck: boolean;
}

/**
 * One outcome, one sentence.
 *
 * 🔴 ONLY `sent` MAY SAY A MAIL WENT OUT. The route answers 200 only after the
 * mail transport accepted it and 502 when it refused (storing nothing), so every
 * other outcome is either 「it did not」 or — `no_answer` — 「we cannot tell」, and
 * the latter must not be dressed as either of the former.
 *
 * `already_verified` has no sentence: the true next step is to read the account
 * again, which replaces this whole block with the live card.
 */
export function resendFeedback(r: ResendRaw): ResendFeedback {
  switch (r.outcome) {
    case 'sent':
      return { text: S.cloud_verify_resend_sent, tone: 'ok', recheck: false };
    case 'already_verified':
      return { text: null, tone: 'ok', recheck: true };
    case 'cooldown':
      return r.retry_after_ms === null
        // No wait on the wire ⇒ no number on screen (never an invented 60).
        ? { text: S.cloud_verify_resend_limited, tone: 'warn', recheck: false }
        : {
            text: S.cloud_verify_resend_cooldown.replace('{s}', String(Math.max(1, Math.ceil(r.retry_after_ms / 1000)))),
            tone: 'warn',
            recheck: false,
          };
    case 'rate_limited':
      return { text: S.cloud_verify_resend_limited, tone: 'warn', recheck: false };
    case 'no_email':
      return { text: S.cloud_acct_no_email, tone: 'warn', recheck: false };
    case 'send_failed':
      return { text: S.cloud_verify_resend_failed, tone: 'warn', recheck: false };
    case 'unauthorized':
      // A 401 here is the real thing: the key did not verify.
      return { text: S.cloud_err_expired, tone: 'warn', recheck: false };
    case 'unreachable':
      return { text: S.cloud_verify_resend_unreachable, tone: 'warn', recheck: false };
    case 'no_answer':
      return { text: S.cloud_verify_resend_no_answer, tone: 'warn', recheck: false };
    default:
      // bad_response / no_key / no_endpoint / no_bridge: we asked and could not
      // use the answer, or could not ask. Not 「sent」 and not 「unreachable」.
      return { text: S.cloud_verify_resend_unexpected, tone: 'warn', recheck: false };
  }
}
