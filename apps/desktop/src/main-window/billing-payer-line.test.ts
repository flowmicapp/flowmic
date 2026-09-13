// Cards MP-3 / MP-8 — **is the sentence really on the screen**, and is it really
// absent the rest of the time.
//
// Why this cannot be replaced by billing-payer.test.ts being green: that file
// proves 「the word was read correctly」; this one proves 「the sentence a user can
// read is painted, from that word, through the real card」. The gap between the
// two is anti-façade ⑥ — the two ends of a wire tested separately while nothing
// walks the middle — and the standing bill for it is CR-7/CR-8, where a feature
// that was green at both ends did not exist on the screen it was for.
//
// Chain walked here: a `billing:budget` payload → `billing-payer.ts` (fold +
// watchdog) → `deriveAccountCard` → `CloudAccountLines.vue` render. Only the
// socket transport is absent, and `billing-payer-wire.test.ts` is the assertion
// that the transport exists.
//
// Render path: vitest's SSR transform + `vue/server-renderer`, the same route
// cloud-account-card.test.ts takes.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

import CloudAccountLines from './components/CloudAccountLines.vue';
import { deriveAccountCard, parseLiveAccount, type CloudAccountRaw } from '../lib/cloud-account';
import { farEndIsPaying, foldBudgetFrame, guestIsSpending, PAYER_FRESH_MS } from '../lib/billing-payer';
import { EMPTY_CLOUD_STATUS, type CloudStatus } from '../lib/channel';
import { S, setLocale } from '../lib/strings';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

const hadWindow = 'window' in globalThis;
(globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  setLocale('en');
});

/**
 * The sentence as it appears IN THE HTML — 先核你的尺子.
 *
 * `renderToString` escapes the text it paints, so a copy revision that puts an
 * apostrophe back into either sentence would make `toContain(S.…)` fail while the
 * sentence is on the screen, perfectly rendered. That is a false red dressed as a
 * real one, and it cost this file one round-trip to find (measured: `computer's`
 * arrives as `computer&#39;s`). The ruler has to speak the same language as the
 * thing it measures.
 */
const onScreen = (sentence: string): string =>
  sentence
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const T0 = 1_700_000_000_000;
const ACCOUNT_UUID = '3f9c1a2e-8b0d-4c77-9a51-6d2e0f7ab7d4';

const SIGNED_IN: CloudStatus = {
  ...EMPTY_CLOUD_STATUS,
  key_set: true,
  subject: ACCOUNT_UUID,
  plan: 'free',
  expires_at: Math.floor(T0 / 1000) + 3600,
  readiness: 'ready',
};

/** A FREE account with room left — the exact account the B-uses-A's-computer case
 *  is about: this computer's own meter is fine and simply is not the one moving. */
const FREE_DTO = {
  outcome: 'ok' as const,
  fetched_at: Math.floor(T0 / 1000),
  detail: null,
  me: { user: { id: ACCOUNT_UUID, email: 'owner@example.com', display_name: 'owner', plan: 'free' } },
  summary: {
    plan: { plan: 'free', source: 'none', quota_exempt: false, cycle: 'monthly', state: 'active', expires_at: null },
    quota: { stt: { used_min: 3, limit_min: 20 }, llm: { used: 100_000, limit: 1_000_000 }, month: '2026-09' },
    devices: { pc_count: 1, mobile_count: 1 },
  },
};

/** The whole chain for one budget frame, exactly as `use-cloud-account.ts` runs it. */
async function renderAfterFrame(frame: unknown, opts: { atMs?: number; nowMs?: number } = {}): Promise<string> {
  const atMs = opts.atMs ?? T0;
  const nowMs = opts.nowMs ?? T0;
  const latch = foldBudgetFrame(null, frame, atMs);
  const raw = FREE_DTO as unknown as CloudAccountRaw;
  const account = parseLiveAccount(raw);
  expect(account, 'the fixture must parse — otherwise this test proves nothing').not.toBeNull();
  const card = deriveAccountCard({
    cloud: SIGNED_IN,
    raw,
    lastLive: null,
    loading: false,
    nowMs,
    farEndPays: farEndIsPaying(latch, nowMs),
    guestSpends: guestIsSpending(latch, nowMs),
  });
  return renderToString(createSSRApp(CloudAccountLines, { card }));
}

beforeEach(() => {
  setLocale('en');
});

describe('MP-3 — the computer says whose minutes are being spent', () => {
  it('paints the sentence when the far end is paying', async () => {
    const html = await renderAfterFrame({ remaining_ms: 1_020_000, mode: 'plan', reason: 'started', payer: 'far_end' });
    expect(html).toContain(onScreen(S.cloud_usage_paid_by_peer));
  });

  // 🔴 THE POINT OF THE WHOLE CARD, as one assertion: the meter is still there,
  // still readable, still not moving — and now something on the screen says why.
  it('the sentence sits with a meter that is legitimately standing still', async () => {
    const html = await renderAfterFrame({ remaining_ms: 1_020_000, mode: 'plan', payer: 'far_end' });
    expect(html).toContain('qg-track'); // ④ is rendered
    expect(html).toContain('3 / 20 min'); // and it is THIS computer's own reading
    expect(html).toContain(onScreen(S.cloud_usage_paid_by_peer));
  });

  // 🔴 NO AMOUNT MAY REACH THIS SENTENCE (design §4 「不透对方余量」). The frame that
  // lights it carries a number — this computer's own — and a sentence that grew a
  // placeholder would print it beside a claim about somebody else's ledger.
  it('carries no figure of any kind', async () => {
    const html = await renderAfterFrame({ remaining_ms: 1_020_000, mode: 'plan', payer: 'far_end' });
    // ⚠️ 先核你的尺子. The FIRST draft of this assertion ran `/\d/` over the row's
    // markup and failed on a correct product: Vue stamps `data-v-87c4453f` (a
    // scoped-style hash, digits and all) on every element it renders. The
    // question is 「does a number reach the reader」, so the ruler has to be the
    // glyphs between the tags, not the tags.
    const row = /<div class="ca-line ca-payer"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    const text = /<span class="ca-v"[^>]*>([\s\S]*?)<\/span>/.exec(row)?.[1] ?? '';
    expect(text, 'the payer row must be in the rendered html').toBe(onScreen(S.cloud_usage_paid_by_peer));
    expect(text).not.toMatch(/\d/);
    // and the string itself, in every locale that authors it, is placeholder-free
    // — a `{n}` here would be a number waiting for somebody to fill in.
    for (const locale of ['en', 'zh-CN'] as const) {
      setLocale(locale);
      expect(S.cloud_usage_paid_by_peer).not.toMatch(/[{}]/);
      expect(S.cloud_usage_paid_by_peer).not.toMatch(/\d/);
    }
  });
});

describe('MP-3 — and stays quiet the rest of the time', () => {
  // Three ways of not being told, one rendering: today's product, unchanged.
  it.each([
    ['this computer is paying', { remaining_ms: 1_020_000, mode: 'plan', payer: 'self' }],
    ['an old relay says nothing', { remaining_ms: 1_020_000, mode: 'plan' }],
    ['a word this build does not know', { remaining_ms: 1_020_000, mode: 'plan', payer: 'integrator_key' }],
  ])('renders no such row when %s', async (_why, frame) => {
    const html = await renderAfterFrame(frame);
    expect(html).not.toContain(onScreen(S.cloud_usage_paid_by_peer));
    expect(html).not.toContain('ca-payer');
    // Positive control: the card really did render, so the absence above is the
    // product being right rather than the probe being blind.
    expect(html).toContain('3 / 20 min');
  });

  it('goes quiet once the frames stop, without anyone telling it the recording ended', async () => {
    const frame = { remaining_ms: 1_020_000, mode: 'plan', payer: 'far_end' };
    const still = await renderAfterFrame(frame, { atMs: T0, nowMs: T0 + PAYER_FRESH_MS });
    expect(still).toContain(onScreen(S.cloud_usage_paid_by_peer));
    const gone = await renderAfterFrame(frame, { atMs: T0, nowMs: T0 + PAYER_FRESH_MS + 1 });
    expect(gone).not.toContain(onScreen(S.cloud_usage_paid_by_peer));
    expect(gone).toContain('3 / 20 min');
  });

  // A signed-out card has no meter on it, so there is nothing for this sentence
  // to explain and it must not appear alone.
  it('says nothing on a card that is showing no account', async () => {
    const card = deriveAccountCard({
      cloud: EMPTY_CLOUD_STATUS,
      raw: null,
      lastLive: null,
      loading: false,
      nowMs: T0,
      farEndPays: true,
    });
    expect(card.payerNote).toBeNull();
    const html = await renderToString(createSSRApp(CloudAccountLines, { card }));
    expect(html).not.toContain('ca-payer');
  });
});

// ── card MP-8 — the other sentence in the same slot ─────────────────────────
//
// MP-3 explains a meter that is standing still. This one explains a meter that is
// MOVING while nobody who owns this computer is talking: since card MP-6 a visitor
// who never signed in is metered against the account of the computer they are
// paired to (design §10-1 step 4). Both are 「the number is correct and the reason
// is invisible」, which is R11 in its quietest form, and both are answered in one
// slot — because they answer one question.

describe('MP-8 — the computer says a visitor is spending its plan', () => {
  const GUEST = { remaining_ms: 1_020_000, mode: 'plan', reason: 'started', payer: 'self', guest_speaker: true };

  it('paints the sentence when an unsigned visitor is the one speaking', async () => {
    const html = await renderAfterFrame(GUEST);
    expect(html).toContain(onScreen(S.cloud_usage_spent_by_other));
  });

  // 🔴 THE POINT OF THE CARD, as one assertion: ④ is there, it is this computer's
  // own reading, and it IS going down — and now something on screen says whose
  // words are doing that.
  it('the sentence sits with a meter that is legitimately going down', async () => {
    const html = await renderAfterFrame(GUEST);
    expect(html).toContain('qg-track');
    expect(html).toContain('3 / 20 min');
    expect(html).toContain(onScreen(S.cloud_usage_spent_by_other));
  });

  // 🔴 MUTUALLY EXCLUSIVE, ASSERTED ON THE RENDERED HTML rather than on the two
  // booleans: 「the decision is exclusive」 and 「the screen shows one line」 are two
  // different claims, and it is the second one the user can read.
  it.each([
    ['a guest is spending this plan', GUEST, S.cloud_usage_spent_by_other, S.cloud_usage_paid_by_peer],
    ['the far end is paying', { remaining_ms: 1_020_000, mode: 'plan', payer: 'far_end' }, S.cloud_usage_paid_by_peer, S.cloud_usage_spent_by_other],
  ])('shows exactly one line when %s', async (_why, frame, shown, hidden) => {
    const html = await renderAfterFrame(frame);
    expect(html).toContain(onScreen(shown));
    expect(html).not.toContain(onScreen(hidden));
    expect(html.match(/class="ca-line ca-payer"/g) ?? []).toHaveLength(1);
  });

  // 🔴 NO AMOUNT. Here the temptation is worse than in MP-3: the frame's number IS
  // this computer's own, so a placeholder would have a real value to fill itself
  // with — and would turn a sentence about WHOSE words these are into a second
  // meter beside ④, free to disagree with it the first time the two are read at
  // different moments.
  it('carries no figure of any kind', async () => {
    const html = await renderAfterFrame(GUEST);
    // 先核你的尺子: the ruler is the glyphs between the tags. Vue stamps a scoped
    // -style hash (digits and all) on every element it renders.
    const row = /<div class="ca-line ca-payer"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    const text = /<span class="ca-v"[^>]*>([\s\S]*?)<\/span>/.exec(row)?.[1] ?? '';
    expect(text, 'the payer row must be in the rendered html').toBe(onScreen(S.cloud_usage_spent_by_other));
    expect(text).not.toMatch(/\d/);
    for (const locale of ['en', 'zh-CN'] as const) {
      setLocale(locale);
      expect(S.cloud_usage_spent_by_other).not.toMatch(/[{}]/);
      expect(S.cloud_usage_spent_by_other).not.toMatch(/\d/);
    }
  });
});

describe('MP-8 — and stays quiet the rest of the time', () => {
  it.each([
    ['the owner is the one speaking', { remaining_ms: 1_020_000, mode: 'plan', payer: 'self' }],
    ['an old relay says nothing', { remaining_ms: 1_020_000, mode: 'plan' }],
    ['the flag rides a frame it contractually cannot', { remaining_ms: 1_020_000, mode: 'plan', payer: 'far_end', guest_speaker: true }],
    ['the flag is not a boolean', { remaining_ms: 1_020_000, mode: 'plan', payer: 'self', guest_speaker: 'true' }],
  ])('renders no guest row when %s', async (_why, frame) => {
    const html = await renderAfterFrame(frame);
    expect(html).not.toContain(onScreen(S.cloud_usage_spent_by_other));
    // Positive control: the card really did render, so the absence above is the
    // product being right rather than the probe being blind.
    expect(html).toContain('3 / 20 min');
  });

  it('goes quiet once the frames stop, without anyone telling it the recording ended', async () => {
    const frame = { remaining_ms: 1_020_000, mode: 'plan', payer: 'self', guest_speaker: true };
    const still = await renderAfterFrame(frame, { atMs: T0, nowMs: T0 + PAYER_FRESH_MS });
    expect(still).toContain(onScreen(S.cloud_usage_spent_by_other));
    const gone = await renderAfterFrame(frame, { atMs: T0, nowMs: T0 + PAYER_FRESH_MS + 1 });
    expect(gone).not.toContain(onScreen(S.cloud_usage_spent_by_other));
    expect(gone).toContain('3 / 20 min');
  });

  // A signed-out card has no meter for this sentence to explain, and a lone line
  // about somebody spending 「this computer's plan」 when no plan is on screen would
  // raise the question it exists to close.
  it('says nothing on a card that is showing no account', async () => {
    const card = deriveAccountCard({
      cloud: EMPTY_CLOUD_STATUS,
      raw: null,
      lastLive: null,
      loading: false,
      nowMs: T0,
      guestSpends: true,
    });
    expect(card.payerNote).toBeNull();
    const html = await renderToString(createSSRApp(CloudAccountLines, { card }));
    expect(html).not.toContain('ca-payer');
  });
});

// ── card MP-10 — a DIFFERENT signed-in account, same slot as MP-8 ───────────
//
// `signed_in_speaker` is card MP-10's sibling wire flag to `guest_speaker`
// (packages/protocol/src/protocol-schemas-billing.ts): the owner's frame gets
// it instead when the speaker is not an unsigned visitor but a different
// signed-in account. Card G-2b2 is the claim that this build renders it through
// the exact same line as the guest case, with no second sentence and no visible
// difference — so every assertion below is a copy of MP-8's above with the wire
// flag swapped, proving the two really do land on one screen.

describe('MP-10 — the computer says a signed-in speaker is spending its plan', () => {
  const OTHER_ACCOUNT = { remaining_ms: 1_020_000, mode: 'plan', reason: 'started', payer: 'self', signed_in_speaker: true };

  it('paints the SAME sentence as the guest case when a signed-in account is the one speaking', async () => {
    const html = await renderAfterFrame(OTHER_ACCOUNT);
    expect(html).toContain(onScreen(S.cloud_usage_spent_by_other));
  });

  it('the sentence sits with a meter that is legitimately going down', async () => {
    const html = await renderAfterFrame(OTHER_ACCOUNT);
    expect(html).toContain('qg-track');
    expect(html).toContain('3 / 20 min');
    expect(html).toContain(onScreen(S.cloud_usage_spent_by_other));
  });

  // 🔴 STILL MUTUALLY EXCLUSIVE WITH THE PEER SENTENCE, on the rendered HTML.
  it.each([
    ['a signed-in account is spending this plan', OTHER_ACCOUNT, S.cloud_usage_spent_by_other, S.cloud_usage_paid_by_peer],
    ['the far end is paying', { remaining_ms: 1_020_000, mode: 'plan', payer: 'far_end' }, S.cloud_usage_paid_by_peer, S.cloud_usage_spent_by_other],
  ])('shows exactly one line when %s', async (_why, frame, shown, hidden) => {
    const html = await renderAfterFrame(frame);
    expect(html).toContain(onScreen(shown));
    expect(html).not.toContain(onScreen(hidden));
    expect(html.match(/class="ca-line ca-payer"/g) ?? []).toHaveLength(1);
  });

  it('carries no figure of any kind', async () => {
    const html = await renderAfterFrame(OTHER_ACCOUNT);
    const row = /<div class="ca-line ca-payer"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    const text = /<span class="ca-v"[^>]*>([\s\S]*?)<\/span>/.exec(row)?.[1] ?? '';
    expect(text, 'the payer row must be in the rendered html').toBe(onScreen(S.cloud_usage_spent_by_other));
    expect(text).not.toMatch(/\d/);
  });
});

describe('MP-10 — and stays quiet the rest of the time', () => {
  it.each([
    ['the owner is the one speaking', { remaining_ms: 1_020_000, mode: 'plan', payer: 'self' }],
    ['an old relay says nothing', { remaining_ms: 1_020_000, mode: 'plan' }],
    ['the flag rides a frame it contractually cannot', { remaining_ms: 1_020_000, mode: 'plan', payer: 'far_end', signed_in_speaker: true }],
    ['the flag is not a boolean', { remaining_ms: 1_020_000, mode: 'plan', payer: 'self', signed_in_speaker: 'true' }],
  ])('renders no such row when %s', async (_why, frame) => {
    const html = await renderAfterFrame(frame);
    expect(html).not.toContain(onScreen(S.cloud_usage_spent_by_other));
    expect(html).toContain('3 / 20 min');
  });

  it('goes quiet once the frames stop, without anyone telling it the recording ended', async () => {
    const frame = { remaining_ms: 1_020_000, mode: 'plan', payer: 'self', signed_in_speaker: true };
    const still = await renderAfterFrame(frame, { atMs: T0, nowMs: T0 + PAYER_FRESH_MS });
    expect(still).toContain(onScreen(S.cloud_usage_spent_by_other));
    const gone = await renderAfterFrame(frame, { atMs: T0, nowMs: T0 + PAYER_FRESH_MS + 1 });
    expect(gone).not.toContain(onScreen(S.cloud_usage_spent_by_other));
    expect(gone).toContain('3 / 20 min');
  });
});
