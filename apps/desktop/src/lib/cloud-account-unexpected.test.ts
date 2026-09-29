// NR-109 item 2 — 「the server answered and we could not use the answer」 is not
// 「we could not reach the server」. The account card's status line used to say the
// latter for both (`bad_response`, and an `ok` whose body carried no plan).
// R11: every status word must answer 「how do you know」; for `unreachable` the
// answer is 「the request never got a response」, for these two it is 「it did,
// and here is the forensic line with its status」.

import { beforeEach, describe, expect, it } from 'vitest';
import { deriveAccountCard, type CloudAccountRaw } from './cloud-account';
import { EMPTY_CLOUD_STATUS, type CloudStatus } from './channel';
import { S, setLocale } from './strings';

beforeEach(() => {
  setLocale('zh-CN');
});

const SIGNED_IN: CloudStatus = { ...EMPTY_CLOUD_STATUS, key_set: true, readiness: 'ready' };
const FETCHED_AT = Math.floor(Date.UTC(2026, 8, 26, 8, 0) / 1000);

const raw = (outcome: CloudAccountRaw['outcome'], over: Partial<CloudAccountRaw> = {}): CloudAccountRaw => ({
  outcome, fetched_at: null, detail: null, me: null, summary: null, ...over,
});

/** A real-shaped good answer, only as far as `parseLiveAccount` needs. */
const OK = raw('ok', {
  fetched_at: FETCHED_AT,
  me: { user: { email: 'a@b.co' } },
  summary: { plan: { plan: 'free', source: 'none', quota_exempt: false, state: 'none' } },
});

function card(r: CloudAccountRaw | null, lastLive = false) {
  const remembered = lastLive
    ? { account: deriveAccountCard({ cloud: SIGNED_IN, raw: OK, lastLive: null, loading: false }).account!, at: FETCHED_AT }
    : null;
  return deriveAccountCard({ cloud: SIGNED_IN, raw: r, lastLive: remembered, loading: false });
}

describe('NR-109 item 2: an unusable answer is not an unreachable server', () => {
  it('bad_response, never answered before ⇒ the unexpected-answer line, NOT "cannot reach"', () => {
    const c = card(raw('bad_response', { detail: 'http 500' }));
    expect(c.phase).toBe('unknown');
    expect(c.statusText).toBe(S.cloud_acct_unexpected);
    expect(c.statusText).not.toBe(S.cloud_acct_unknown);
    expect(c.canRetry).toBe(true);
    expect(c.loud).toBeNull();
  });

  it('bad_response with an earlier answer ⇒ the stale-unexpected line, old values kept', () => {
    const c = card(raw('bad_response', { detail: 'http 403 ADMIN_ONLY' }), true);
    expect(c.phase).toBe('stale');
    const d = new Date(FETCHED_AT * 1000);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(c.statusText).toBe(S.cloud_acct_stale_unexpected.replace('{t}', hhmm));
    expect(c.statusText).not.toBe(S.cloud_acct_stale.replace('{t}', hhmm));
    expect(c.account).not.toBeNull();
  });

  it('an ok without a plan is NOT live and says unexpected (it used to vouch for an empty card with "as of HH:mm")', () => {
    const c = card(raw('ok', { fetched_at: FETCHED_AT, me: { user: {} }, summary: {} }));
    expect(c.phase).toBe('unknown');
    expect(c.statusText).toBe(S.cloud_acct_unexpected);
  });

  it('positive control: unreachable still says "cannot reach", fresh and stale', () => {
    expect(card(raw('unreachable', { detail: 'timeout' })).statusText).toBe(S.cloud_acct_unknown);
    expect(card(raw('unreachable', { detail: 'timeout' }), true).statusText).toContain(S.cloud_acct_stale.split('{t}')[0]);
  });

  it('positive control: a real ok is live', () => {
    expect(card(OK).phase).toBe('live');
  });
});
