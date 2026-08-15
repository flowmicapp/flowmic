// SPEC-REF: docs/strategy/2026-08-15-site-analytics-first-party-design.md §2, §7
import { describe, it, expect } from 'vitest';
import {
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

  it('collect kind: only pageview from the client', () => {
    expect(sanitizeCollectKind('pageview')).toBe('pageview');
    expect(sanitizeCollectKind('register_ok')).toBeNull();
    expect(sanitizeCollectKind('login_ok')).toBeNull();
  });

  it('origin allow-list', () => {
    expect(originAllowed('https://flowmic.app', false)).toBe(true);
    expect(originAllowed('https://evil.example', false)).toBe(false);
    expect(originAllowed('http://localhost:5173', true)).toBe(true);
    expect(originAllowed('http://localhost:5173', false)).toBe(false);
  });
});
