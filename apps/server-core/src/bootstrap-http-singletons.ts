// SPEC-REF: ./bootstrap-http-deps.ts (the one caller)
//
// 🔴 STRUCTURAL SPLIT ONLY (card MP-1, 2026-09-11) — moved VERBATIM out of
// `composeHttpDeps`, comments included, because that file stood at exactly 800
// of the 800-line `file-size` cap and MP-1 had to add one field to the console
// dep literal. NO BEHAVIOUR MOVED WITH THE CODE: same construction, same
// condition, same lifetime — `composeHttpDeps` is called exactly once per
// server, so a call here is once per server too, which is the property the
// original comment argues is the one that matters.
//
// The split is the same one `bootstrap-web-room-deps.ts` already made, and for
// the same reason: this family is 「a thing built once per process, HERE rather
// than in bootstrap.ts because that function is at its own cap」, and it is now
// two files deep for the same reason it was one.

import type { ServerConfig } from './config';
import { resolveRegistrationSurgeGate } from './auth/registration-surge';

/** The global daily registration surge gate, or `undefined` in standalone.
 *  Everything below this line is the original block, unchanged. */
export function registrationSurgeGateFor(
  config: Pick<ServerConfig, 'mode'>,
  now?: () => number,
): ReturnType<typeof resolveRegistrationSurgeGate> | undefined {
// ── 2026-08-27 batch-2 item 4 — the GLOBAL daily registration surge gate ───
//
// 🔴 ONE INSTANCE PER PROCESS, and it is built HERE rather than in
// bootstrap.ts for one measured reason: that function is at 799 of its
// 800-line cap, and this file exists precisely to hold what does not fit
// (see the header's move record). `composeHttpDeps` is called exactly once
// per server, immediately before `makeHttpHandler`, so a construction here
// has the same lifetime a construction there would — which is the property
// that matters. A per-request counter would count to one and gate nothing.
//
// 🔴 SAAS ONLY. Standalone is a LAN sidecar with no accounts and no
// registration route, so a gate there would be a mechanism nobody can reach;
// more importantly, `resolveCaptchaVerifier` WARNS about a missing secret,
// and firing that on every desktop launch would train the one reader of that
// log to ignore it. Both dep literals below are already saas-gated, so an
// `undefined` here reaches nothing.
//
// Env: FLOWMIC_TURNSTILE_SECRET, FLOWMIC_REGISTER_SURGE_THRESHOLD (both
// documented at their readers — auth/captcha.ts and auth/registration-surge.ts).
const surgeGate = config.mode === 'saas' ? resolveRegistrationSurgeGate(process.env, now) : undefined;
  return surgeGate;
}
