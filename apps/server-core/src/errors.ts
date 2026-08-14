// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §5 (error-code namespaces — bilingual,
//     sourced from @flowmic/protocol)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D1 (no silent failure — every error
//     path carries an explicit, whitelisted code)
//   CLAUDE.md red line: no silent failure
//
// The single server-side error type. Every failure surfaced to a client MUST
// carry an `ErrorCode` that exists in @flowmic/protocol's ERROR_CODES table
// (the i18n-error-keys lint guarantees each code is bilingual). i18n is NOT
// duplicated here — the wire carries the code; the client renders zh-CN/en from
// the protocol package. `errorPayload()` is the one shape every ack/emit uses.

import { ERROR_CODES, type ErrorCode } from '@flowmic/protocol';

/** A failure whose `code` is a protocol-whitelisted, bilingual error code. */
export class ServerError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  constructor(code: ErrorCode, message?: string, retryable = false) {
    super(message ?? code);
    this.name = 'ServerError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Compile-time + run-time guard: the code must exist in the protocol table. */
export function isErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

/** The canonical wire shape for a failed ack / error emit. Code only — the
 *  client localizes. `message` is developer context, never shown verbatim. */
export interface ErrorPayload {
  error: ErrorCode;
  message?: string;
  retryable?: boolean;
}

export function errorPayload(err: unknown): ErrorPayload {
  if (err instanceof ServerError) {
    return err.retryable
      ? { error: err.code, message: err.message, retryable: true }
      : { error: err.code, message: err.message };
  }
  // An unexpected throw must still fail loud with a real code, never a bare
  // 500 or a swallowed promise (13-LESSONS-LEARNED §3 D1).
  return { error: 'SETTINGS_SYNC_FAIL', message: err instanceof Error ? err.message : String(err) };
}
