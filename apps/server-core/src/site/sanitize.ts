// SPEC-REF: docs/strategy/2026-08-15-site-analytics-first-party-design.md §2
//
// Every string that can enter `site_daily_counts.dim_value` goes through here.
// The reverse-control that proves strip-query is load-bearing lives in
// test/site-sanitize.test.ts: drop the `?…` peel and a reset-password token
// lands in the bucket.

import type { SiteCountDim, SiteCountKind } from '../db/repos/site-counts.repo';

// 🔴 THE PAGES OF THE SITE, AND IT IS NOT THIS REPO THAT DECIDES WHAT THEY ARE.
// The website's page registry does (the `@flowmic/web` repo, src/lib/site-routes.ts
// `PUBLIC_PAGES`), together with the two public pages that are not registry
// pages (`/signin`, `/reset-password`). The browser derives what it reports
// from that registry and therefore cannot go stale; THIS list can, because it
// is in another repository and cannot import it. What keeps it honest is
// `verify/lint/site-path-allowlist-mirror.mjs`, which reads that registry and
// fails naming the exact strings to add. A missing entry is not a broken page:
// the beacon still arrives, and `sanitizePath` files the visit under `(other)`.
//
// 🔴 WIDENED 2026-09-21, CARD SITE-COUNT-2, FROM SIX ENTRIES. Measured on
// production that day — 37 days of `site_daily_counts`, 2026-08-16 → 2026-09-21,
// 640 pageviews on the `path` dimension — the entire site had resolved to six
// values: `/` 418, `/signin` 122, `(other)` 76, `/faq` 10, `/privacy` 8,
// `/terms` 6. The registry held 50 pages and the build prerendered 426 files, so
// `/pricing`, every `/download*`, every `/use-cases*`, every `/vs*`, `/refunds`
// and 25 of the 26 guide chapters had never been counted once, in any language,
// since the day they shipped — silently, because a whitelist that has stopped
// describing the site keeps working perfectly on the pages it still names.
//
// 🔴 PER PAGE, NOT PER FAMILY, AND THAT IS THE DECISION. Collapsing the slug
// pages into `/guide/(chapter)`, `/use-cases/(case)` and so on would have made
// this list immune to new pages — and would have answered a question nobody
// asked. The guide chapters, the use-case pages and the comparison pages EXIST
// to be landed on from search one at a time; "how much traffic does the guide
// get" is not a substitute for "which chapter". The cost of per-page is that
// the 51st page needs an edit here plus a deploy, and the lint above is what
// makes that cost visible instead of silent.
//
// ⚠️ ACCEPTING A PATTERN (`/guide/<slug>`) INSTEAD OF NAMES WAS ALSO REJECTED.
// It would count a new chapter with no edit at all, but it is the client that
// says what path this was, and a client is anybody with an HTTP library: a
// pattern lets an unbounded number of invented slugs become rows in a table
// whose whole defence against that is this list. §2 says whitelist, and a
// regular expression is not one.
//
// ⚠️ WHAT DID NOT CHANGE: `/` and `/signin` mean exactly what they have meant
// since 2026-08-16, so their 37-day history stays comparable. `(other)` shrinks
// — it is "everything not on this list" and always was, so its CONTENTS move
// whenever the list moves; that is this card's deliverable, not a drift, and it
// is the one bucket whose history is not comparable across this change.
export const SITE_PATH_ALLOWLIST = Object.freeze([
  '/',
  '/faq',
  '/pricing',
  '/try',
  // Legal, English-only, unprefixed (owner 2026-08-27).
  '/privacy',
  '/terms',
  '/refunds',
  // Not registry pages: they are public but not indexable content. `/reset` is
  // an alias handled BEFORE this list is consulted — see sanitizePath — so it
  // deliberately does not appear here.
  '/signin',
  '/reset-password',
  // The guide: `/guide` is the introduction chapter and the rest are children.
  // Chapter order is the registry's (GUIDE_DOC_IDS), not alphabetical, so a
  // diff against it reads straight down.
  '/guide',
  '/guide/how',
  '/guide/install',
  '/guide/install-win',
  '/guide/install-mac',
  '/guide/install-and',
  '/guide/install-ios',
  '/guide/install-linux',
  '/guide/upgrade',
  '/guide/lan-models',
  '/guide/lan-pc',
  '/guide/lan-scan',
  '/guide/lan-list',
  '/guide/cloud-how',
  '/guide/cloud-register',
  '/guide/cloud-verify',
  '/guide/cloud-key',
  '/guide/cloud-login',
  '/guide/cloud-pair',
  '/guide/cloud-after',
  '/guide/use',
  '/guide/use-screen',
  '/guide/use-demo',
  '/guide/use-type',
  '/guide/model',
  '/guide/faq',
  // Downloads: `/download` is the overview, the rest are one platform each.
  '/download',
  '/download/windows',
  '/download/macos',
  '/download/android',
  '/download/ios',
  // Use cases: `/use-cases` is the overview, the rest are one situation each.
  '/use-cases',
  '/use-cases/ai-coding',
  '/use-cases/private-work',
  '/use-cases/cross-language',
  '/use-cases/typing-hurts',
  '/use-cases/talk-it-through',
  '/use-cases/many-computers',
  // Comparisons: `/vs` is the overview, the rest are one comparison each.
  '/vs',
  '/vs/phone-as-mic',
  '/vs/pc-dictation',
  '/vs/remote-typing',
  '/vs/hardware-mic',
] as const);

export type SitePathAllowed = (typeof SITE_PATH_ALLOWLIST)[number];

const PATH_SET = new Set<string>(SITE_PATH_ALLOWLIST);

export const DOWNLOAD_SRC_ALLOWLIST = Object.freeze([
  'hero',
  'band',
  'nav',
  'demo_card',
  'demo_phone',
  // the homepage hero try line's CTA after the demo ends
  'hero_try',
] as const);

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

/** Collect body may only carry `pageview` and the five `demo_*` site-demo
 *  funnel kinds (M4-02: a demo starting, pairing, text landing, the trial
 *  running out, a click through to download) — all client-reported. Auth
 *  kinds (`register_ok` / `login_ok`) are server-authored and refused here. */
const CLIENT_COLLECT_KINDS = new Set([
  'pageview',
  'demo_mint',
  'demo_paired',
  'demo_flight',
  'demo_expired',
  'demo_cta',
]);

export type ClientCollectKind =
  | 'pageview'
  | 'demo_mint'
  | 'demo_paired'
  | 'demo_flight'
  | 'demo_expired'
  | 'demo_cta';

export function sanitizeCollectKind(raw: unknown): ClientCollectKind | null {
  return typeof raw === 'string' && CLIENT_COLLECT_KINDS.has(raw) ? (raw as ClientCollectKind) : null;
}

export function isSiteCountKind(raw: unknown): raw is SiteCountKind {
  return (
    raw === 'pageview' ||
    raw === 'download_click' ||
    raw === 'register_ok' ||
    raw === 'login_ok' ||
    CLIENT_COLLECT_KINDS.has(raw as string)
  );
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
