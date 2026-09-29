// NR-109 (owner report 2026-09-26, 0.3.95 Linux; the code is shared by every
// desktop platform) — the account card's `unverified` phase, and the anchors that
// keep its three copies of one fact in step.
//
// What went wrong, in one line: `/api/cloud/summary` answers
// `403 EMAIL_NOT_VERIFIED` to every account whose mailbox is not verified yet, the
// desktop read folded that into `unauthorized`, and the card told a user who had
// signed in a minute earlier 「登录已过期，请重新登录。」 under a green 「已就绪」.
//
// The three copies this file pins against each other:
//   · the server's code — apps/server-core/src/auth/email-verification.ts;
//   · the Rust decision — apps/desktop/src-tauri/src/cloud_account_outcome.rs;
//   · this side's whitelist — RUST_ACCOUNT_OUTCOMES in ./cloud-account.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { asCloudAccountRaw, deriveAccountCard, RUST_ACCOUNT_OUTCOMES, type CloudAccountRaw } from './cloud-account';
import { EMPTY_CLOUD_STATUS, type CloudStatus } from './channel';
import { S, setLocale } from './strings';

beforeEach(() => {
  setLocale('zh-CN');
});

const SIGNED_IN: CloudStatus = {
  ...EMPTY_CLOUD_STATUS,
  key_set: true,
  // The key the owner saw: 90 days out, i.e. a date, not "long-lived".
  expires_at: Math.floor(Date.UTC(2026, 11, 24, 21, 53) / 1000),
  readiness: 'ready',
};

const UNVERIFIED: CloudAccountRaw = { outcome: 'unverified', fetched_at: null, detail: null, me: null, summary: null };

function card(raw: CloudAccountRaw | null, loading = false) {
  return deriveAccountCard({ cloud: SIGNED_IN, raw, lastLive: null, loading, nowMs: Date.UTC(2026, 8, 26) });
}

describe('NR-109 the unverified phase', () => {
  it('is its own phase — not `expired`, and no red line at all', () => {
    const c = card(UNVERIFIED);
    expect(c.phase).toBe('unverified');
    expect(c.loud).toBeNull();
  });

  it('says what happened in the as-of slot and offers re-query (verify, then press it)', () => {
    const c = card(UNVERIFIED);
    expect(c.statusText).toBe(S.cloud_acct_unverified);
    expect(c.canRetry).toBe(true);
  });

  it('shows no plan numbers it was not given, but keeps the Cloud Key row', () => {
    const c = card(UNVERIFIED);
    expect(c.account).toBeNull();
    expect(c.planBadge).toBeNull();
    expect(c.gauge).toBeNull();
    expect(c.keyExpiresText).not.toBeNull();
  });

  it('a re-query in flight says "loading", not the previous answer', () => {
    expect(card(UNVERIFIED, true).phase).toBe('loading');
  });

  it('positive control: a real 401 still reads as expired with the red line', () => {
    const c = card({ outcome: 'unauthorized', fetched_at: null, detail: 'http 401 AUTH_TOKEN_EXPIRED', me: null, summary: null });
    expect(c.phase).toBe('expired');
    expect(c.loud).toBe(S.cloud_err_expired);
  });

  it('comes through the parser door intact (not rewritten into bad_response)', () => {
    expect(asCloudAccountRaw({ outcome: 'unverified', fetched_at: null, detail: null, me: null, summary: null }).outcome)
      .toBe('unverified');
  });
});

describe('NR-109 anchors: server code ↔ Rust decision ↔ TS whitelist', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const server = read('../../../server-core/src/auth/email-verification.ts');
  const rust = read('../../src-tauri/src/cloud_account_outcome.rs');
  const getJson = read('../../src-tauri/src/shell/cloud.rs');

  it('the server still sends the code the Rust decision matches', () => {
    expect(server).toContain("export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';");
    expect(rust).toContain('Some("EMAIL_NOT_VERIFIED") => Some(("unverified", None))');
  });

  it('every outcome the Rust decision can return is on the TS whitelist', () => {
    const produced = [...rust.matchAll(/Some\(\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(produced.length).toBeGreaterThan(0);
    for (const o of new Set(produced)) {
      expect(RUST_ACCOUNT_OUTCOMES as readonly string[], `${o} from cloud_account_outcome.rs`).toContain(o);
    }
  });

  it('get_json actually routes its 401/403 through that decision (the wiring, not just the function)', () => {
    expect(getJson).toContain('cloud_account_outcome::refusal_outcome(status.as_u16(), body.as_ref())');
  });
});
