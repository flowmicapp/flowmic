// SPEC-REF:
//   src/mail/provider.ts (the interface, and why no no-op implements it)
//   src/mail/config.ts (FLOWMIC_MAIL_PROVIDER=file / FLOWMIC_MAIL_FILE_DIR)
//   docs/decisions/2026-09-02-owner-plain-language-lan-ci-and-two-security-questions.md
//     §3 问题一 (owner: delete the reset-token/verification-code echo switches)
//
// 2026-09-02 — the replacement for FLOWMIC_INTERNAL_RESET_TOKEN_ECHO and
// FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO, which owner ordered DELETED
// (docs/decisions/…-two-security-questions.md §3, problem 1): those two flags
// read per request with no mode gate at all, so a single misconfigured `=1` in
// a production env file let anyone who knew a registered email take the
// account over with two anonymous requests. They existed only because the
// golden suite (G11/G17/G18) and a handful of unit tests have no real mailbox
// to read a token or code back from.
//
// 🔴 THIS IS A TEST FIXTURE, NOT A PRODUCTION TRANSPORT — and it says so on the
// wire: `id` is `'file'`, distinct from `'resend'`, so a log line or a test
// assertion can never confuse the two. `mailConfigFromEnv` requires
// FLOWMIC_MAIL_FILE_DIR only when FLOWMIC_MAIL_PROVIDER=file.
//
// 🔴 2026-09-02 CORRECTION: this used to also say "nothing in this repo sets
// that combination outside a test harness (grep it)" — a promise that a grep
// can verify today and a copied `.env` can violate tomorrow, silently, in
// production. `mailConfigFromEnv` (mail/config.ts) now enforces it instead of
// merely documenting it: `FLOWMIC_MAIL_PROVIDER=file` is refused at boot
// unless the process also sets `FLOWMIC_TEST_BENCH=1`. That second flag is
// NOT a re-creation of the FLOWMIC_INTERNAL_*_ECHO switches this file
// replaces — a bench declaration only permits writing to the on-disk mailbox
// below, it never puts a secret on the wire and it gates nothing a caller can
// reach over HTTP.
//
// WHAT IT DOES: writes ONE JSON file per message, containing exactly the
// `MailMessage` fields plus `sent_at` — the reset token / verification code
// live inside `text` (the mailer that built the message already put the link
// or code there; this file does not re-derive or re-parse anything), so a test
// harness reads them the same way a real recipient would: out of the letter.
//
// ⚠️ FILENAME COLLISION AVOIDANCE: `Date.now()` alone is not unique across two
// sends in the same millisecond (a forgot-password retry, a resend), so the
// name also carries a random suffix. Neither half is meant to be parsed by a
// reader — `to`/`subject`/`sent_at` inside the JSON are the stable fields a
// test should filter on.

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { MailMessage, MailProvider } from './provider';

/** One written mail, exactly what lands in each JSON file. A named type rather
 *  than an inline shape so a test importing it (instead of hand-typing the
 *  fields) cannot drift from what this file actually writes. */
export interface FileMailRecord extends MailMessage {
  /** ISO-8601, this process's clock at the moment of the write. Not the
   *  message's own concept of a send time (there isn't one) — purely so a
   *  human skimming the directory can sort by eye. */
  sent_at: string;
}

/**
 * A `MailProvider` that writes each message to `dir` as one JSON file, instead
 * of handing it to a vendor.
 *
 * `dir` is created (recursively) on first send if it does not exist — the
 * same "fail loud on misconfiguration, not on an empty test fixture" trade the
 * rest of this module makes, since a fresh CI checkout has no reason to have
 * pre-created a mailbox directory.
 */
export function createFileMailProvider(dir: string): MailProvider {
  return {
    id: 'file',
    async send(message: MailMessage): Promise<void> {
      mkdirSync(dir, { recursive: true });
      const record: FileMailRecord = { ...message, sent_at: new Date().toISOString() };
      const name = `${Date.now()}-${randomBytes(6).toString('hex')}.json`;
      // Sync, deliberately: this transport exists for tests that send one
      // message and immediately read it back, and a fire-and-forget async
      // write would reintroduce exactly the race a real vendor's HTTP call
      // already has (password-reset-routes.ts's `void dispatchResetMail(...)`
      // docs that trade-off for the real transport; a test fixture should not
      // need the same care to avoid flaking).
      writeFileSync(join(dir, name), JSON.stringify(record, null, 2), 'utf8');
    },
  };
}
