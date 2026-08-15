// SPEC-REF: docs/strategy/2026-08-15-site-analytics-first-party-design.md §4
//
// Public first-party site analytics intake. saas-only. No credential.
// Deliberately NOT in ADMIN_GATED_ROUTES / ROUTE_SOURCES — same standing as
// `/api/status` (status-routes.ts): a public write that takes no account
// identity must not pretend to be behind the admin fence.
//
// 🔴 TWO ROUTES, TWO FAILURE DIRECTIONS:
//   POST /api/site/collect     — pageviews from the SPA; switch off ⇒ 204, no write
//   GET  /api/site/go/download — hop then 302; switch off ⇒ still 302, no write
// Download must keep working when analytics is off. A hop that 500s because the
// switch is 0 would turn a statistics feature into a broken download button.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RegisterRateLimiter } from '../auth/register-rate-limit';
import type { SiteCountsRepo } from '../db/repos/site-counts.repo';
import { SITE_TOTAL_DIM, SITE_TOTAL_VALUE } from '../db/repos/site-counts.repo';
import { clientIpFromRequest } from './trusted-proxy';
import {
  originAllowed,
  sanitizeCollectKind,
  sanitizeDownloadSrc,
  sanitizeLocale,
  sanitizePath,
  sanitizeReferrerHost,
  sanitizeUtm,
  utcDay,
} from '../site/sanitize';

export const SITE_COLLECT_PATH = '/api/site/collect';
export const SITE_DOWNLOAD_HOP_PATH = '/api/site/go/download';

/** Default GitHub latest — must match web SITE_FLAGS.releasesLatestUrl. A
 *  mismatch would make the hop send people somewhere the landing page does not. */
export const DEFAULT_DOWNLOAD_DEST = 'https://github.com/flowmicapp/flowmic/releases/latest';

const BODY_CAP = 4_000;

export interface SiteCollectRoutesDeps {
  counts: SiteCountsRepo;
  /** Per-IP throttle — SEPARATE instance from register/login. */
  limiter: RegisterRateLimiter;
  /** When false: collect returns 204 with zero writes; hop still 302s. */
  enabled: boolean;
  /** Absolute URL the hop redirects to. */
  downloadDest?: string;
  /** Allow localhost Origin (dev / tests). Production leaves this false. */
  allowLocalhostOrigin?: boolean;
  now?: () => number;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > BODY_CAP) raw = raw.slice(0, BODY_CAP);
    });
    req.on('end', () => {
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function pathOnly(url: string): string {
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

function queryOf(url: string): URLSearchParams {
  const q = url.indexOf('?');
  return new URLSearchParams(q >= 0 ? url.slice(q + 1) : '');
}

/**
 * @returns true iff this module handled the request.
 */
export function tryHandleSiteCollectRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SiteCollectRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  const path = pathOnly(url);
  const dest = deps.downloadDest ?? DEFAULT_DOWNLOAD_DEST;
  const now = deps.now ?? Date.now;
  const allowLocal = deps.allowLocalhostOrigin ?? false;

  if (path === SITE_COLLECT_PATH && method === 'POST') {
    void (async (): Promise<void> => {
      const ip = clientIpFromRequest(req);
      if (!deps.limiter.check(ip).allowed) {
        return sendJson(res, 429, { error: 'REGISTER_RATE_LIMITED' });
      }
      deps.limiter.record(ip);

      const origin = req.headers.origin;
      if (typeof origin === 'string' && !originAllowed(origin, allowLocal)) {
        return sendEmpty(res, 204);
      }

      const body = await readJsonBody(req);
      if (!deps.enabled) return sendEmpty(res, 204);

      const kind = sanitizeCollectKind(body.kind);
      if (!kind) return sendEmpty(res, 204);

      const day = utcDay(now());
      const pathVal = sanitizePath(body.path);
      const localeVal = sanitizeLocale(body.locale);
      const refVal = sanitizeReferrerHost(body.referrer_host ?? body.referrer);
      const utmVal = sanitizeUtm(body.utm);

      deps.counts.bump({ day, kind, dim: 'path', dim_value: pathVal });
      deps.counts.bump({ day, kind, dim: 'locale', dim_value: localeVal });
      deps.counts.bump({ day, kind, dim: 'referrer_host', dim_value: refVal });
      deps.counts.bump({ day, kind, dim: 'utm', dim_value: utmVal });
      // Platform total for the kind (summary reads this without summing dims).
      deps.counts.bump({ day, kind, dim: SITE_TOTAL_DIM, dim_value: SITE_TOTAL_VALUE });

      sendEmpty(res, 204);
    })();
    return true;
  }

  if (path === SITE_DOWNLOAD_HOP_PATH && method === 'GET') {
    const qs = queryOf(url);
    const src = sanitizeDownloadSrc(qs.get('src'));
    if (deps.enabled) {
      const day = utcDay(now());
      deps.counts.bump({ day, kind: 'download_click', dim: 'src', dim_value: src });
      deps.counts.bump({
        day,
        kind: 'download_click',
        dim: SITE_TOTAL_DIM,
        dim_value: SITE_TOTAL_VALUE,
      });
    }
    redirect(res, dest);
    return true;
  }

  return false;
}
