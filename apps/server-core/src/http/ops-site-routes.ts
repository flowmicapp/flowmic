// SPEC-REF: docs/strategy/2026-08-15-site-analytics-first-party-design.md §4
//
// Operator read side of site_daily_counts. Admin-gated. Paths are LITERALS in
// the if-conditions so console-admin-gate-coverage.test.ts can see them — do
// not refactor into template constants (ops-routes.ts header argues why).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SiteCountsRepo, SiteCountDim, SiteCountKind } from '../db/repos/site-counts.repo';
import type { AccountVerifier } from './account-auth';
import { adminGate, type OpsAuditSink } from './ops-audit-trail';
import { sendJson } from './body';
import { isSiteCountDim, isSiteCountKind, utcDay } from '../site/sanitize';

export interface OpsSiteRoutesDeps {
  auth: AccountVerifier;
  counts: Pick<SiteCountsRepo, 'summary' | 'breakdown'>;
  audit: OpsAuditSink;
  now?: () => number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function queryOf(url: string): URLSearchParams {
  const q = url.indexOf('?');
  return new URLSearchParams(q >= 0 ? url.slice(q + 1) : '');
}

function defaultRange(nowMs: number): { from: string; to: string } {
  const to = utcDay(nowMs);
  const fromMs = nowMs - 29 * 86_400_000;
  return { from: utcDay(fromMs), to };
}

function parseRange(
  qs: URLSearchParams,
  nowMs: number,
): { ok: true; from: string; to: string } | { ok: false; message: string } {
  const fallback = defaultRange(nowMs);
  const from = qs.get('from') ?? fallback.from;
  const to = qs.get('to') ?? fallback.to;
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) {
    return { ok: false, message: 'from and to must be UTC YYYY-MM-DD' };
  }
  if (from > to) return { ok: false, message: 'from must be <= to' };
  return { ok: true, from, to };
}

function gateOrRefuse(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsSiteRoutesDeps,
  route: 'GET /api/ops/site/summary' | 'GET /api/ops/site/breakdown',
): boolean {
  const verdict = adminGate(req, deps.auth, deps.audit, route);
  if (verdict.ok) return true;
  sendJson(res, verdict.status, { error: verdict.error });
  return false;
}

export function tryHandleOpsSiteRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsSiteRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  const now = deps.now ?? Date.now;

  if (
    (url === '/api/ops/site/summary' || url.startsWith('/api/ops/site/summary?')) &&
    method === 'GET'
  ) {
    if (!gateOrRefuse(req, res, deps, 'GET /api/ops/site/summary')) return true;
    const range = parseRange(queryOf(url), now());
    if (!range.ok) {
      sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: range.message });
      return true;
    }
    const rows = deps.counts.summary(range.from, range.to);
    const byKind: Record<string, number> = {};
    for (const r of rows) byKind[r.kind] = r.count;
    sendJson(res, 200, {
      from: range.from,
      to: range.to,
      pageviews: byKind.pageview ?? 0,
      download_clicks: byKind.download_click ?? 0,
      register_ok: byKind.register_ok ?? 0,
      login_ok: byKind.login_ok ?? 0,
      by_kind: rows,
    });
    return true;
  }

  if (
    (url === '/api/ops/site/breakdown' || url.startsWith('/api/ops/site/breakdown?')) &&
    method === 'GET'
  ) {
    if (!gateOrRefuse(req, res, deps, 'GET /api/ops/site/breakdown')) return true;
    const qs = queryOf(url);
    const range = parseRange(qs, now());
    if (!range.ok) {
      sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: range.message });
      return true;
    }
    const kindRaw = qs.get('kind');
    const dimRaw = qs.get('dim');
    if (!isSiteCountKind(kindRaw) || !isSiteCountDim(dimRaw) || dimRaw === '_') {
      sendJson(res, 400, {
        error: 'SETTINGS_SCHEMA_INVALID',
        message: 'kind and dim are required; dim may not be _',
      });
      return true;
    }
    const kind = kindRaw as SiteCountKind;
    const dim = dimRaw as SiteCountDim;
    const rows = deps.counts.breakdown(kind, dim, range.from, range.to);
    sendJson(res, 200, {
      from: range.from,
      to: range.to,
      kind,
      dim,
      rows,
    });
    return true;
  }

  return false;
}
