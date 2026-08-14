// SPEC-REF:
//   src/auth/auth-service.ts (`verifyCredentials` + `setPassword`)
//   src/auth/password-policy.ts (the ONE policy — same function register/reset use)
//   src/http/password-reset-routes.ts (forgot/reset is a DIFFERENT question:
//     unauthenticated recovery via mailed token. This file is the signed-in
//     owner proving they still know the current password.)
//   *** HUMAN-AUDIT SENSITIVE (auth: password change) ***
//
// POST /api/account/password — console 「change password」 for a session that
// already exists.
//
// 🔴 WHY THIS IS NOT `/api/password/forgot`. The account page used to mint a
// reset by calling forgot and reading `reset_token` off the JSON. Production
// forgot answers `{ok:true}` with NO token (anti-enumeration; echo flag OFF).
// The page then painted 「Could not start password reset」 — a button that
// cannot act. Tests stayed green because they mocked the token back in.
// A signed-in change is current-password + new-password. It never mails,
// never echoes a token, and never shares a response shape with forgot.
//
// 🔴 EXEMPT from the email-verification gate AND the A2-3 restriction gate,
// same family as export/delete: credential hygiene is not a product feature.
// An unverified or restricted account must still be able to rotate a password
// they already know. Identity (Bearer) is required; those two walls are not.
// Pins: test/email-verification.test.ts + test/account-restriction.test.ts.
//
// ⚠️ THIS FILE IS IN `ROUTE_SOURCES` (test/console-admin-gate-coverage.test.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from '../auth/auth-service';
import { RegisterValidationError } from '../auth/auth-service';
import { checkPasswordPolicy, passwordPolicyMessage } from '../auth/password-policy';
import { accountUserFromBearer, type AccountUserVerdict } from './account-auth';
import { readJsonBody, sendJson, str } from './console-http';

export interface AccountPasswordRoutesDeps {
  auth: AuthService;
}

function authUserRow(req: IncomingMessage, deps: AccountPasswordRoutesDeps): AccountUserVerdict {
  return accountUserFromBearer(req, deps.auth);
}

export function tryHandleAccountPasswordRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountPasswordRoutesDeps,
): boolean {
  const url = (req.url ?? '/').split('?')[0] ?? '/';
  const method = req.method ?? 'GET';

  if (url === '/api/account/password' && method === 'POST') {
    const who = authUserRow(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    void (async (): Promise<void> => {
      const body = await readJsonBody(req);
      const current = str(body.current_password);
      const next = str(body.new_password);
      if (current === '' || next === '') {
        return sendJson(res, 400, {
          error: 'SETTINGS_SCHEMA_INVALID',
          message: 'current_password and new_password required',
        });
      }
      const verdict = checkPasswordPolicy(next);
      if (!verdict.ok) {
        return sendJson(res, 400, {
          error: 'SETTINGS_SCHEMA_INVALID',
          message: passwordPolicyMessage('new_password', verdict),
        });
      }
      const email = who.user.email;
      if (email === null || email === '') {
        return sendJson(res, 400, {
          error: 'SETTINGS_SCHEMA_INVALID',
          message: 'this account has no password login',
        });
      }
      const matched = await deps.auth.verifyCredentials(email, current);
      if (!matched || matched.id !== who.user.id) {
        // Same code login uses: the password did not match this account.
        // The console maps it to 「current password is wrong」, not the
        // sign-in sentence — one code, two surfaces, one fact.
        return sendJson(res, 401, { error: 'AUTH_LOGIN_FAILED' });
      }
      try {
        await deps.auth.setPassword(who.user.id, next);
      } catch (err) {
        if (err instanceof RegisterValidationError) {
          return sendJson(res, 400, { error: err.code, message: err.message });
        }
        throw err;
      }
      sendJson(res, 200, { ok: true });
    })();
    return true;
  }

  return false;
}
