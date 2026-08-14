// SPEC-REF:
//   settings/byok.ts (empty-on-register, enable switch, probe URL guard)
//   http/console-routes.ts (this file is the WP-W1b BYOK block, split out so
//     console-routes stays under the 800-line cap)
//   http/probe-routes.ts `probeStt` (the TEST reuses the desktop probe; it
//     persists nothing and bills nothing)
//   *** HUMAN-AUDIT SENSITIVE (auth-adjacent: BYOK keys + server-side dial) ***
//
// GET/POST /api/cloud/stt-routings — console BYOK editor.
// POST /api/cloud/stt-routings/test — reachability probe from THIS server.
//
// ⚠️ THIS FILE IS IN `ROUTE_SOURCES` (test/console-admin-gate-coverage.test.ts).
// Adding it there is part of shipping it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from '../auth/auth-service';
import { restrictionRefusalBody, restrictionVerdict } from '../auth/account-restriction';
import { EMAIL_NOT_VERIFIED, isEmailVerified, type EmailVerifiedReader } from '../auth/email-verification';
import { accountFromBearer, type UserIdVerdict } from './account-auth';
import { readJsonBody, sendJson } from './console-http';
import type { SettingsRepo } from '../db/repos/settings.repo';
import { stampSettingProvenance } from '../settings/defaults';
import {
  authoredRoutings,
  BYOK_ENABLED_KEY,
  byokProbeEndpointAllowed,
  consoleByokEnabled,
} from '../settings/byok';
import { STT_ROUTINGS_KEY } from '../settings/provenance';
import { probeStt, type ProbeResult } from './probe-routes';

export interface ByokRoutesDeps {
  auth: AuthService;
  settings: SettingsRepo;
  verifiedEmail: EmailVerifiedReader;
  broadcastSettingsUpdated?: (userId: string, payload: { key: string; value: unknown }) => void;
}

function authUser(req: IncomingMessage, deps: ByokRoutesDeps): UserIdVerdict {
  return accountFromBearer(req, deps.auth);
}

function refuseUnverified(res: ServerResponse, deps: ByokRoutesDeps, userId: string): boolean {
  if (isEmailVerified(deps.verifiedEmail.emailVerifiedAt(userId))) return false;
  sendJson(res, 403, { error: EMAIL_NOT_VERIFIED });
  return true;
}

function refuseRestricted(res: ServerResponse, deps: ByokRoutesDeps, userId: string): boolean {
  const verdict = restrictionVerdict(deps.auth, userId);
  if (verdict === null) return false;
  sendJson(res, 403, restrictionRefusalBody(verdict.reason));
  return true;
}

function editorPayload(deps: ByokRoutesDeps, userId: string, stored: unknown): { routings: unknown[]; enabled: boolean } {
  const routings = authoredRoutings(stored);
  return { routings, enabled: consoleByokEnabled(deps.settings, userId, routings) };
}

export function tryHandleByokRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ByokRoutesDeps,
): boolean {
  const url = (req.url ?? '/').split('?')[0] ?? '/';
  const method = req.method ?? 'GET';

  if (url === '/api/cloud/stt-routings' && method === 'GET') {
    const who = authUser(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    if (refuseRestricted(res, deps, who.userId)) return true;
    if (refuseUnverified(res, deps, who.userId)) return true;
    const row = deps.settings.read(who.userId, STT_ROUTINGS_KEY);
    sendJson(res, 200, editorPayload(deps, who.userId, row?.value));
    return true;
  }

  if (url === '/api/cloud/stt-routings' && method === 'POST') {
    const who = authUser(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    if (refuseRestricted(res, deps, who.userId)) return true;
    if (refuseUnverified(res, deps, who.userId)) return true;
    void (async (): Promise<void> => {
      const body = await readJsonBody(req);
      const routings = body.routings;
      const wellFormed = Array.isArray(routings)
        && routings.length <= 64
        && routings.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r));
      if (!wellFormed) {
        return sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: 'routings must be an array of objects (≤64)' });
      }
      const stamped = stampSettingProvenance(STT_ROUTINGS_KEY, routings) as unknown[];
      deps.settings.write(who.userId, STT_ROUTINGS_KEY, stamped);
      deps.broadcastSettingsUpdated?.(who.userId, { key: STT_ROUTINGS_KEY, value: stamped });
      if (typeof body.enabled === 'boolean') {
        deps.settings.write(who.userId, BYOK_ENABLED_KEY, body.enabled);
      }
      sendJson(res, 200, { ok: true, ...editorPayload(deps, who.userId, stamped) });
    })();
    return true;
  }

  if (url === '/api/cloud/stt-routings/test' && method === 'POST') {
    const who = authUser(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    if (refuseRestricted(res, deps, who.userId)) return true;
    if (refuseUnverified(res, deps, who.userId)) return true;
    void (async (): Promise<void> => {
      const body = await readJsonBody(req);
      const routing = body.routing;
      if (routing === null || typeof routing !== 'object' || Array.isArray(routing)) {
        return sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: 'routing object required' });
      }
      const endpoint = typeof (routing as { endpoint?: unknown }).endpoint === 'string'
        ? (routing as { endpoint: string }).endpoint
        : '';
      const allowed = byokProbeEndpointAllowed(endpoint);
      if (!allowed.ok) {
        return sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: allowed.reason });
      }
      // Reuses the desktop probe: nothing persisted, nothing billed. A dead
      // engine is a 200 with ok:false — an unreachable box is a reading, not
      // a server fault (probe-routes.ts header).
      let result: ProbeResult;
      try {
        result = await probeStt({ routing, language: (routing as { language?: string }).language });
      } catch (err) {
        result = {
          ok: false,
          code: 'STT_PROBE_FAIL',
          message: err instanceof Error ? err.message : String(err),
          latency_ms: 0,
        };
      }
      sendJson(res, 200, result);
    })();
    return true;
  }

  return false;
}
