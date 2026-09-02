// mail/file.ts — the test-fixture MailProvider that replaces
// FLOWMIC_INTERNAL_RESET_TOKEN_ECHO / FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO
// (owner-ordered deletion, 2026-09-02 — docs/decisions/2026-09-02-owner-plain-
// language-lan-ci-and-two-security-questions.md §3, problem 1).
//
// SPEC-REF: src/mail/file.ts, src/mail/provider.ts (the interface)
//
// What this file pins:
//   ① `id` is 'file', distinct from 'resend' — a log line or an assertion can
//      never confuse a test fixture for the real transport;
//   ② each `send()` writes ONE JSON file, and reading it back gives the exact
//      `MailMessage` fields plus `sent_at`;
//   ③ two sends in the same millisecond (a resend) do not collide — no file
//      is silently overwritten;
//   ④ `dir` is created on first use, so a fresh CI checkout with no
//      pre-existing mailbox directory still works.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileMailProvider } from '../src/mail/file';

function readAll(dir: string): Array<{ to: string; subject: string; text: string; sent_at: string }> {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
}

describe('createFileMailProvider', () => {
  it("id is 'file' — never mistakable for the real transport", () => {
    const provider = createFileMailProvider(mkdtempSync(join(tmpdir(), 'flowmic-mail-file-')));
    expect(provider.id).toBe('file');
  });

  it('writes exactly the message fields, plus sent_at, and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmic-mail-file-'));
    try {
      const provider = createFileMailProvider(dir);
      await provider.send({ to: 'a@b.co', subject: 'Reset your password', text: 'link: https://x/reset?token=abc' });
      const records = readAll(dir);
      expect(records).toHaveLength(1);
      const record = records[0];
      if (record === undefined) throw new Error('unreachable: length asserted above');
      expect(record).toMatchObject({ to: 'a@b.co', subject: 'Reset your password', text: 'link: https://x/reset?token=abc' });
      expect(typeof record.sent_at).toBe('string');
      expect(Number.isNaN(Date.parse(record.sent_at))).toBe(false);
      expect(Object.keys(record).sort()).toEqual(['sent_at', 'subject', 'text', 'to']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two sends to the same address both land — no filename collision drops one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmic-mail-file-'));
    try {
      const provider = createFileMailProvider(dir);
      // Fired without awaiting between them, the shape a resend or a race
      // produces — a filename keyed only on Date.now() would collide here.
      await Promise.all([
        provider.send({ to: 'a@b.co', subject: 'first', text: 'one' }),
        provider.send({ to: 'a@b.co', subject: 'second', text: 'two' }),
      ]);
      const records = readAll(dir);
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.subject).sort()).toEqual(['first', 'second']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the directory on first send — a fresh checkout has no pre-existing mailbox', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'flowmic-mail-file-'));
    const dir = join(parent, 'not-yet-created', 'mail');
    try {
      const provider = createFileMailProvider(dir);
      await expect(provider.send({ to: 'a@b.co', subject: 's', text: 't' })).resolves.toBeUndefined();
      expect(readAll(dir)).toHaveLength(1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
