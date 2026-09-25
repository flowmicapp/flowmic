// SPEC-REF: docs/strategy/2026-08-15-site-analytics-first-party-design.md §2, §7
import { describe, it, expect } from 'vitest';
import {
  SITE_PATH_ALLOWLIST,
  sanitizePath,
  sanitizeLocale,
  sanitizeReferrerHost,
  sanitizeUtm,
  sanitizeDownloadSrc,
  sanitizeCollectKind,
  originAllowed,
} from '../src/site/sanitize';

describe('site sanitize — path whitelist + strip query', () => {
  it('keeps allowlisted paths', () => {
    expect(sanitizePath('/')).toBe('/');
    expect(sanitizePath('/faq')).toBe('/faq');
    expect(sanitizePath('/signin')).toBe('/signin');
    expect(sanitizePath('/reset')).toBe('/reset-password');
  });

  it('🔴 reverse control: query strings (incl. reset tokens) NEVER land in dim_value', () => {
    // If someone "simplifies" sanitizePath by dropping the `?` peel, this is the
    // test that goes red — and that red is the whole point of the peel.
    const withToken = sanitizePath('/reset-password?email=a@b.c&token=SECRET_RESET_TOKEN');
    expect(withToken).toBe('/reset-password');
    expect(withToken).not.toContain('token');
    expect(withToken).not.toContain('SECRET');
    expect(sanitizePath('/faq?utm_source=x')).toBe('/faq');
    expect(sanitizePath('/console/overview')).toBe('(other)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SITE-COUNT-2 (2026-09-21) — 44 OF THE SITE'S 50 PAGES WERE COUNTED NOWHERE.
//
// 🔴 WHY THESE ASSERTIONS NAME PATHS INSTEAD OF WALKING THE LIST. A loop over
// SITE_PATH_ALLOWLIST asserting `sanitizePath(p) === p` agrees with whatever
// the list happens to contain — it passed just as happily on the six-entry list
// that caused this card. The list is the thing under test, so the test has to
// say the names out loud; one per family, so deleting a family is red.
//
// ⚠️ AND THIS IS ONLY HALF THE PROOF. That a path survives the sanitizer says
// nothing about whether the browser ever sends it — the other half is
// the `@flowmic/web` repo's src/lib/site-collect.test.ts, which drives the REAL
// router and watches the beacon. The defect this card fixed lived exactly in
// the gap between the two halves, where each end was fine on its own.
describe('site sanitize — the whole site, not six pages (SITE-COUNT-2)', () => {
  it('keeps the standalone pages that were folded into (other) for 37 days', () => {
    expect(sanitizePath('/pricing')).toBe('/pricing');
    expect(sanitizePath('/refunds')).toBe('/refunds');
    expect(sanitizePath('/try')).toBe('/try');
  });

  it('keeps one page from each per-slug family, root and child alike', () => {
    expect(sanitizePath('/guide')).toBe('/guide');
    expect(sanitizePath('/guide/install-win')).toBe('/guide/install-win');
    expect(sanitizePath('/download')).toBe('/download');
    expect(sanitizePath('/download/macos')).toBe('/download/macos');
    expect(sanitizePath('/use-cases')).toBe('/use-cases');
    expect(sanitizePath('/use-cases/ai-coding')).toBe('/use-cases/ai-coding');
    expect(sanitizePath('/vs')).toBe('/vs');
    expect(sanitizePath('/vs/pc-dictation')).toBe('/vs/pc-dictation');
  });

  // 🔴 THE NEGATIVE HALF, AND IT IS THE REASON THIS IS A LIST AND NOT A PATTERN.
  // `/guide/<anything>` would have counted these too, and the client is whoever
  // is holding an HTTP library: a pattern turns dim_value into somewhere an
  // unbounded number of invented slugs can be written. Design §2 says whitelist.
  it('a slug that is not a real page is still (other)', () => {
    expect(sanitizePath('/guide/not-a-chapter')).toBe('(other)');
    expect(sanitizePath('/download/linux')).toBe('(other)');
    expect(sanitizePath('/use-cases/')).toBe('(other)');
    expect(sanitizePath('/vs/some-competitor')).toBe('(other)');
    expect(sanitizePath('/guide/install-win/extra')).toBe('(other)');
  });

  // The two buckets with 37 days of history behind them (2026-08-16 →
  // 2026-09-21: `/` 418 views, `/signin` 122). Widening the list must not move
  // what they mean, or the history stops being comparable with the present.
  it('the buckets that already have history keep their meaning', () => {
    expect(sanitizePath('/')).toBe('/');
    expect(sanitizePath('/signin')).toBe('/signin');
    expect(sanitizePath('/faq')).toBe('/faq');
  });

  // 🔴 `/reset` IS AN ALIAS, NOT AN ENTRY. sanitizePath rewrites it before the
  // whitelist is consulted, so it must NOT appear on the list: an entry that
  // can never be matched reads as coverage. verify/lint/site-path-allowlist-mirror.mjs
  // fails on exactly this, from the other side.
  it('an aliased path is not itself on the list', () => {
    expect(sanitizePath('/reset')).toBe('/reset-password');
    expect(SITE_PATH_ALLOWLIST as readonly string[]).not.toContain('/reset');
  });
});

describe('site sanitize — other dims', () => {
  it('locale: coarse shape or (unknown)', () => {
    expect(sanitizeLocale('zh-CN')).toBe('zh-CN');
    expect(sanitizeLocale('en')).toBe('en');
    expect(sanitizeLocale('<script>')).toBe('(unknown)');
  });

  it('referrer host: direct / self / hostname', () => {
    expect(sanitizeReferrerHost('')).toBe('(direct)');
    expect(sanitizeReferrerHost('https://flowmic.app/faq')).toBe('(self)');
    expect(sanitizeReferrerHost('https://news.ycombinator.com/item?id=1')).toBe('news.ycombinator.com');
  });

  it('utm compact form', () => {
    expect(sanitizeUtm({ utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch' })).toBe(
      'hn/social/launch',
    );
    expect(sanitizeUtm(null)).toBe('(none)');
  });

  it('download src whitelist', () => {
    expect(sanitizeDownloadSrc('band')).toBe('band');
    expect(sanitizeDownloadSrc('evil')).toBe('(other)');
  });

  it('download src whitelist: site-demo card and phone hops (M4-02)', () => {
    expect(sanitizeDownloadSrc('demo_card')).toBe('demo_card');
    expect(sanitizeDownloadSrc('demo_phone')).toBe('demo_phone');
  });

  it('download src whitelist: homepage hero try line after the demo ends', () => {
    expect(sanitizeDownloadSrc('hero_try')).toBe('hero_try');
  });

  it('collect kind: pageview and the five site-demo funnel kinds from the client', () => {
    expect(sanitizeCollectKind('pageview')).toBe('pageview');
    expect(sanitizeCollectKind('register_ok')).toBeNull();
    expect(sanitizeCollectKind('login_ok')).toBeNull();
  });

  it('collect kind: site-demo funnel (M4-02) — reverse control below proves this is load-bearing', () => {
    expect(sanitizeCollectKind('demo_mint')).toBe('demo_mint');
    expect(sanitizeCollectKind('demo_paired')).toBe('demo_paired');
    expect(sanitizeCollectKind('demo_flight')).toBe('demo_flight');
    expect(sanitizeCollectKind('demo_expired')).toBe('demo_expired');
    expect(sanitizeCollectKind('demo_cta')).toBe('demo_cta');
    expect(sanitizeCollectKind('demo_bogus')).toBeNull();
  });

  it('origin allow-list', () => {
    expect(originAllowed('https://flowmic.app', false)).toBe(true);
    expect(originAllowed('https://evil.example', false)).toBe(false);
    expect(originAllowed('http://localhost:5173', true)).toBe(true);
    expect(originAllowed('http://localhost:5173', false)).toBe(false);
  });
});
