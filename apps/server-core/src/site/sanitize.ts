// SPEC-REF: docs/strategy/2026-08-15-site-analytics-first-party-design.md §2
//
// Every string that can enter `site_daily_counts.dim_value` goes through here.
// The reverse-control that proves strip-query is load-bearing lives in
// test/site-sanitize.test.ts: drop the `?…` peel and a reset-password token
// lands in the bucket.

import type { SiteCountDim, SiteCountKind } from '../db/repos/site-counts.repo';

export const SITE_PATH_ALLOWLIST = Object.freeze([
  '/',
  '/faq',
  '/privacy',
  '/terms',
  '/signin',
  '/reset-password',
] as const);

export type SitePathAllowed = (typeof SITE_PATH_ALLOWLIST)[number];

const PATH_SET = new Set<string>(SITE_PATH_ALLOWLIST);

export const DOWNLOAD_SRC_ALLOWLIST = Object.freeze(['hero', 'band', 'nav'] as const);

const SRC_SET = new Set<string>(DOWNLOAD_SRC_ALLOWLIST);

/** Max length of any stored dim_value (UTM can be long; we refuse to grow the
 *  table with arbitrary query junk). */
export const SITE_DIM_VALUE_MAX = 120;

// One base per line, www. derived.
//
// The retired relay domain was removed from this list on 2026-08-17 (owner
// ruling: docs/decisions/2026-08-17-owner-retires-flowmic-online-public-service.md).
// This is a REFERRER classifier, so the change is exactly this: a referrer from
// that host is now counted as an external site rather than as this one — which is
// what it is, since the domain no longer serves anything publicly. It never
// affected who may reach an endpoint.
const SELF_HOST_BASES = ['flowmic.app'] as const;
const SELF_HOSTS = new Set(SELF_HOST_BASES.flatMap((h) => [h, `www.${h}`]));

export function utcDay(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Peel query + hash, then whitelist. Unknown paths collapse to `(other)`. */
export function sanitizePath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '(other)';
  let p = raw.trim();
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h >= 0) p = h === 0 ? '/' : p.slice(0, h);
  if (p.length === 0) p = '/';
  // Alias the reset path the SPA still serves.
  if (p === '/reset') p = '/reset-password';
  if (!PATH_SET.has(p)) return '(other)';
  return p;
}

export function sanitizeLocale(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '(unknown)';
  const s = raw.trim().slice(0, 16);
  // Coarse: letters, digits, hyphen only — refuse free-form UA junk.
  if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(s)) return '(unknown)';
  return s.replace('_', '-');
}

/** Hostname only. Empty → `(direct)`; our own hosts → `(self)`. */
export function sanitizeReferrerHost(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') return '(direct)';
  let host = raw.trim().toLowerCase();
  try {
    if (host.includes('://')) host = new URL(host).hostname;
    else if (host.includes('/')) host = host.split('/')[0] ?? host;
  } catch {
    return '(other)';
  }
  host = host.replace(/:\d+$/, '');
  if (host.length === 0) return '(direct)';
  if (SELF_HOSTS.has(host) || host.endsWith('.flowmic.app')) {
    return '(self)';
  }
  if (host.length > SITE_DIM_VALUE_MAX) host = host.slice(0, SITE_DIM_VALUE_MAX);
  return host;
}

/** Compact `s/m/c` from the three UTM keys. Empty → `(none)`. */
export function sanitizeUtm(raw: unknown): string {
  if (raw == null || raw === '') return '(none)';
  let source = '';
  let medium = '';
  let campaign = '';
  if (typeof raw === 'string') {
    // Already compacted, or a single free-form blob we refuse to store raw.
    const parts = raw.split('/');
    if (parts.length === 3) {
      source = scrubUtmPart(parts[0] ?? '');
      medium = scrubUtmPart(parts[1] ?? '');
      campaign = scrubUtmPart(parts[2] ?? '');
    } else {
      return '(none)';
    }
  } else if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    source = scrubUtmPart(typeof o.utm_source === 'string' ? o.utm_source : typeof o.source === 'string' ? o.source : '');
    medium = scrubUtmPart(typeof o.utm_medium === 'string' ? o.utm_medium : typeof o.medium === 'string' ? o.medium : '');
    campaign = scrubUtmPart(
      typeof o.utm_campaign === 'string' ? o.utm_campaign : typeof o.campaign === 'string' ? o.campaign : '',
    );
  } else {
    return '(none)';
  }
  if (!source && !medium && !campaign) return '(none)';
  const packed = `${source || '-'}/${medium || '-'}/${campaign || '-'}`;
  return packed.length > SITE_DIM_VALUE_MAX ? packed.slice(0, SITE_DIM_VALUE_MAX) : packed;
}

function scrubUtmPart(s: string): string {
  return s.trim().slice(0, 40).replace(/[^\w.-]/g, '_');
}

export function sanitizeDownloadSrc(raw: unknown): string {
  if (typeof raw !== 'string') return '(other)';
  const s = raw.trim().toLowerCase();
  return SRC_SET.has(s) ? s : '(other)';
}

/** Collect body may only carry pageview (client-reported). Auth kinds are
 *  server-authored and refused here. */
export function sanitizeCollectKind(raw: unknown): 'pageview' | null {
  return raw === 'pageview' ? 'pageview' : null;
}

export function isSiteCountKind(raw: unknown): raw is SiteCountKind {
  return raw === 'pageview' || raw === 'download_click' || raw === 'register_ok' || raw === 'login_ok';
}

export function isSiteCountDim(raw: unknown): raw is SiteCountDim {
  return (
    raw === 'path' ||
    raw === 'locale' ||
    raw === 'referrer_host' ||
    raw === 'utm' ||
    raw === 'src' ||
    raw === '_'
  );
}

/** Production allow-list for the Origin / Referer of collect. Localhost is for
 *  vitest + `pnpm dev` only. */
export function originAllowed(origin: string | undefined, allowLocalhost: boolean): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.hostname === 'flowmic.app' || u.hostname === 'www.flowmic.app') return true;
    if (allowLocalhost && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
    return false;
  } catch {
    return false;
  }
}
