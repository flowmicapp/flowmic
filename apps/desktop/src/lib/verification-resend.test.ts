// NR-109 (MAIN decision ①) — the `unverified` card's resend action: one sentence
// per answer, and only a real 200 may say a mail went out. Plus the anchors that
// keep the three copies of this contract (server route, Rust command, this
// whitelist) in step — each is a file another card can edit.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { asResendRaw, RESEND_OUTCOMES, resendFeedback, type ResendOutcome } from './verification-resend';
import { S, setLocale } from './strings';

beforeEach(() => {
  setLocale('zh-CN');
});

const fb = (outcome: ResendOutcome, retry_after_ms: number | null = null) => resendFeedback({ outcome, retry_after_ms });

describe('NR-109 resend feedback', () => {
  it('sent ⇒ the sent line, ok tone', () => {
    expect(fb('sent')).toEqual({ text: S.cloud_verify_resend_sent, tone: 'ok', recheck: false });
  });

  it('🔴 no other outcome may say sent', () => {
    for (const o of [...RESEND_OUTCOMES, 'no_bridge'] as ResendOutcome[]) {
      if (o === 'sent') continue;
      expect(fb(o).text, o).not.toBe(S.cloud_verify_resend_sent);
    }
  });

  it('no_answer says "unknown", distinct from unreachable (nothing sent) and from failed', () => {
    expect(fb('no_answer').text).toBe(S.cloud_verify_resend_no_answer);
    expect(fb('unreachable').text).toBe(S.cloud_verify_resend_unreachable);
    expect(fb('send_failed').text).toBe(S.cloud_verify_resend_failed);
    expect(new Set([fb('no_answer').text, fb('unreachable').text, fb('send_failed').text]).size).toBe(3);
  });

  it('cooldown carries the server\'s wait in whole seconds, and never invents one', () => {
    expect(fb('cooldown', 41_200).text).toBe(S.cloud_verify_resend_cooldown.replace('{s}', '42'));
    expect(fb('cooldown', null).text).toBe(S.cloud_verify_resend_limited);
  });

  it('already verified ⇒ no sentence, read the account again', () => {
    expect(fb('already_verified')).toEqual({ text: null, tone: 'ok', recheck: true });
    expect(fb('sent').recheck).toBe(false);
  });

  it('a real 401 on resend is the real "expired"', () => {
    expect(fb('unauthorized').text).toBe(S.cloud_err_expired);
  });

  it('the parser keeps every Rust outcome and turns anything else into bad_response, never sent', () => {
    for (const o of RESEND_OUTCOMES) expect(asResendRaw({ outcome: o }).outcome).toBe(o);
    expect(asResendRaw({ outcome: 'sentt' }).outcome).toBe('bad_response');
    expect(asResendRaw(null).outcome).toBe('bad_response');
    expect(asResendRaw({ outcome: 'cooldown', retry_after_ms: 'x' }).retry_after_ms).toBeNull();
  });
});

describe('NR-109 resend anchors: server route ↔ Rust ↔ TS ↔ screen', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const route = read('../../../server-core/src/http/email-verification-routes.ts');
  const decision = read('../../src-tauri/src/cloud_account_outcome.rs');
  const command = read('../../src-tauri/src/shell/cloud.rs');
  const libRs = read('../../src-tauri/src/lib.rs');
  const bridge = read('./bridge.ts');
  const lines = read('../main-window/components/CloudAccountLines.vue');
  const button = read('../main-window/components/VerificationResend.vue');

  it('the Rust path is the server route', () => {
    expect(route).toContain("export const EMAIL_VERIFICATION_SEND_PATH = '/api/auth/email-verification/send';");
    expect(decision).toContain('pub const RESEND_PATH: &str = "/api/auth/email-verification/send";');
  });

  it('every code the Rust decision matches is one the route sends', () => {
    for (const code of ['VERIFY_ALREADY_VERIFIED', 'VERIFY_COOLDOWN', 'VERIFY_NO_EMAIL', 'VERIFY_SEND_FAILED']) {
      expect(route, code).toContain(`export const ${code} = '${code}';`);
      expect(decision, code).toContain(`Some("${code}")`);
    }
    // Rate limiting is matched on the STATUS (any 429 that is not the cooldown),
    // so the route only has to keep the code it answers with.
    expect(route).toContain("export const VERIFY_RATE_LIMITED = 'VERIFY_RATE_LIMITED';");
    expect(route).toContain('retry_after_ms:');
  });

  it('every outcome Rust can produce is on the TS whitelist', () => {
    const fromDecision = [...decision.matchAll(/=> \(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const fromCommand = [
      ...[...command.matchAll(/done\("([a-z_]+)"/g)].map((m) => m[1]),
      ...[...command.matchAll(/VerificationResendDto \{ outcome: "([a-z_]+)"/g)].map((m) => m[1]),
    ];
    expect(fromDecision.length).toBeGreaterThan(5);
    expect(fromCommand.length).toBeGreaterThan(2);
    for (const o of new Set([...fromDecision, ...fromCommand])) {
      expect(RESEND_OUTCOMES as readonly string[], o).toContain(o);
    }
  });

  it('the command is registered, called by the bridge, and the card renders the button in the unverified phase', () => {
    expect(libRs).toContain('shell::cloud::cloud_verification_resend,');
    expect(bridge).toContain("invokeSafe<unknown>('cloud_verification_resend')");
    expect(lines).toContain('<VerificationResend v-if="card.phase === \'unverified\'" @recheck="emit(\'retry\')" />');
    expect(button).toContain('await resendVerificationEmail()');
  });
});
