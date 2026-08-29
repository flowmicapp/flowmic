// The IPC surface for browser sign-in (owner 2026-08-27, the UAT correction
// block in docs/decisions/2026-08-27-owner-no-password-login-on-clients.md).
//
// ⚠️ ITS OWN FILE, and the reason is mechanical rather than aesthetic:
// `lib/bridge.ts` was at 745 of the 800 lines `verify:lint file-size` allows,
// and these three commands plus the reasoning they need do not fit. Same
// precedent as CloudSignInGuide.vue itself, which exists because DevicesPage.vue
// hit the same cap.
//
// 🔴 THESE THREE DO NOT USE `invokeSafe`, DELIBERATELY. That helper answers
// `undefined` for every failure — outside Tauri, a thrown command, anything —
// and this flow's whole contract is that a failure arrives as a NAMED reason the
// user can read. Folding「the OS refused a socket」and「there is no Rust side
// here」into one `undefined` would be the friendly-empty default this repo bans
// outright (13 §7 F1 ②).
//
// ⚠️ THEY DO NOT IMPORT `invoke` EITHER. `invoke-funnel-door.test.ts` keeps
// `lib/bridge.ts` the only module that touches `@tauri-apps/api/core`, and it
// caught this file's first draft cutting a second hole. The right move was the
// one that gate names: take a door from bridge.ts. `invokeResult` is that door —
// it exists because this flow needed data on success AND a name on failure,
// which is what neither `invokeSafe` nor `invokeVerbose` can carry.

import { invokeResult } from './bridge';

/** The failure names Rust can produce — `SignInFailure::code()` in
 *  `src-tauri/src/cloud_signin.rs`. Mirrored by hand because Rust and TS share
 *  no type system, and pinned by `cloud-signin.test.ts`, which reads the Rust
 *  source and asserts the two lists are the same set. A mirror nothing checks is
 *  how a new variant reaches a screen as a bare word. */
export const SIGN_IN_FAILURES = [
  'TIMEOUT',
  'STATE_MISMATCH',
  'REFUSED',
  'UNREACHABLE',
  'LISTEN',
  'BAD_ENDPOINT',
] as const;
export type SignInFailureCode = (typeof SIGN_IN_FAILURES)[number];

/** Anything Rust did not name. Not silently mapped onto one of the six: a
 *  reason we do not recognise is a different fact from any of them, and the copy
 *  layer answers it with its own sentence. */
export const UNKNOWN_FAILURE = 'UNKNOWN';

export interface SignInPageCopy {
  lang: string;
  ok_title: string;
  ok_body: string;
  fail_title: string;
  fail_body: string;
}

export interface SignInBegun {
  port: number;
  state: string;
  window_ms: number;
}

export type BeginResult = { ok: true; data: SignInBegun } | { ok: false; reason: string };

export type SignInPhase = 'idle' | 'waiting' | 'exchanging' | 'done' | 'failed';

export interface SignInPoll {
  phase: SignInPhase;
  /** Present only in `done` — the same DTO `saveCloudKey` returns, so the caller
   *  feeds it to the same handler a paste already goes through. */
  cloud: unknown;
  reason: string | null;
}

/** Bind the loopback listener and mint a state. Returns what the caller needs to
 *  build the console URL — the URL is built in `cloud-signin.ts`, never in Rust,
 *  because `socket/channel.rs` forbids an endpoint literal in that crate. */
export async function beginBrowserSignIn(
  endpoint: string,
  page: SignInPageCopy,
): Promise<BeginResult> {
  // Rust returns `Err(String)` carrying a `SignInFailure::code()`, and
  // `invokeResult` hands that string through untouched. Anything else that can
  // fail here — no Tauri, a transport fault — produces a reason we do not
  // recognise, and the copy layer answers those with a sentence rather than
  // dressing them up as one of our six names.
  return invokeResult<SignInBegun>('cloud_browser_signin_begin', { endpoint, page });
}

/** Where the attempt is. Polled rather than pushed: a poll cannot be missed by a
 *  component that mounted a moment late, and this flow has one reader. */
export async function pollBrowserSignIn(): Promise<SignInPoll> {
  const r = await invokeResult<SignInPoll>('cloud_browser_signin_poll');
  // ⚠️ A POLL THAT COULD NOT BE ASKED READS AS `idle`, NOT AS A FAILURE, and
  // that is deliberate: the caller only polls while it believes a flow is
  // running, and turning a transient IPC hiccup into a red sentence would
  // abandon a sign-in that is still perfectly alive on the Rust side. The
  // window's own deadline is what ends a flow nobody can reach.
  return r.ok ? r.data : { phase: 'idle', cloud: null, reason: null };
}

/** Stop waiting. Returns the flow to idle rather than to a failure — a
 *  deliberate cancellation is not an error and must not paint a red line. */
export async function cancelBrowserSignIn(): Promise<void> {
  // Nothing to report if it fails: they asked to stop, and the listener closes
  // on its own deadline regardless.
  await invokeResult<null>('cloud_browser_signin_cancel');
}
