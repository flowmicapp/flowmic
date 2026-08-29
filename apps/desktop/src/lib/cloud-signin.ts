// SPEC-REF:
//   docs/decisions/2026-08-27-owner-no-password-login-on-clients.md (owner
//     ruling, card NR-2b, PC half: keep the Cloud Key paste and polish it —
//     「粘贴即校验、错误具名提示」 (validate on paste, name the error) — and add a
//     guided route to the browser. No in-app email form.)
//     🔴 AND ITS CORRECTION BLOCK, owner at UAT the same day: 「浏览器里 Gmail
//     都登录成功了，为什么还要我去复制 Key」 ⇒ the browser route now COMPLETES
//     the sign-in through a loopback callback. The paste is the fallback.
//
// The DECISIONS behind the PC's signed-out block, kept out of the SFC so they
// can be driven directly: which address the guide button opens, what a paste is
// about to put in the field, and which sentence a failed sign-in gets.

import { isJwtShaped } from './channel';
import { S } from './strings';
import type { SignInFailureCode, SignInPageCopy } from './bridge-signin';
import { UNKNOWN_FAILURE } from './bridge-signin';
import { getLocale } from './strings/locale';

/** Where 「sign in with browser」 goes.
 *
 * A constant, not the endpoint box next door: that box is free text the user
 * may be mid-edit in, and handing whatever it currently holds to the system
 * browser would make this button open an address chosen by a typo. The ruling
 * names flowmic.app; a self-hosted operator reaches their own console the way
 * they already do.
 *
 * ⚠️ `https://` is not decoration — `shell/external_open.rs` refuses anything
 * else, so an http:// value here would be a button that silently does nothing.
 */
export const CONSOLE_SIGNIN_URL = 'https://flowmic.app/signin';

/** The one thing the guide button does, with the door handed in.
 *
 * 🔴 THE OPENER IS AN ARGUMENT SO THIS IS TESTABLE AT ALL. vitest runs this
 * suite in `node` and SFCs compile to their SSR form here, so a click inside
 * the component cannot be simulated — the branch that matters (`ok:false` ⇒ say
 * so) would otherwise have no test anywhere. There is deliberately NO default:
 * a default of `openExternalUrl` would let a caller forget to pass anything and
 * still look right, and a default that quietly succeeded would be the friendly
 * empty this repo bans outright.
 *
 * ⚠️ `ok:true` means the OS ACCEPTED the URL — not that a browser is now in
 * front of the user. Nothing measures that, and the copy never claims it.
 */
export async function openConsoleSignIn(
  open: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>,
  url: string = CONSOLE_SIGNIN_URL,
): Promise<boolean> {
  const r = await open(url);
  return r.ok;
}

/**
 * The console address for an AUTOMATIC sign-in: same page, plus the two things
 * the console needs to hand the result back to this PC.
 *
 * 🔴 BUILT HERE, NOT IN RUST. `socket/channel.rs` forbids an endpoint literal in
 * that crate — the addresses are `@flowmic/protocol` constants on this side, and
 * Rust receives values rather than holding them. It is also why `beginBrowserSignIn`
 * returns a port and a state instead of a URL.
 *
 * ⚠️ `encodeURIComponent` ON THE STATE, even though a minted state is 32 hex
 * characters and cannot contain anything that needs escaping today. The
 * generator is one line away in `mint_state`, and the console echoes this value
 * verbatim into a callback that the desktop compares byte-for-byte: if the
 * generator ever changes, an unescaped `&` here would split the value in two and
 * the desktop would refuse its own callback — which looks exactly like the
 * attack the check exists to stop.
 *
 * The mirror of this parsing is `readDesktopHandoff`, in the web console repo's
 * `src/lib/signin-handoff.ts`, which refuses a malformed port by name.
 */
export function buildDesktopSignInUrl(port: number, state: string): string {
  const q = `flow=desktop&port=${port}&state=${encodeURIComponent(state)}`;
  return `${CONSOLE_SIGNIN_URL}?${q}`;
}

/**
 * The sentence for a failed browser sign-in.
 *
 * 🔴 AN EXHAUSTIVE `Record`, WHICH IS THE WHOLE MECHANISM. Adding a variant to
 * `SignInFailure` in Rust without a sentence here fails `vue-tsc` — the same
 * compile-time exhaustiveness `inject-verdict-authorship.ts` uses, and the door
 * that 0.2.53 did not have when `INJECT_SELF_WINDOW_NO_INPUT` reached a user's
 * screen as `INJ…`.
 *
 * ⚠️ THE TYPE CANNOT REACH ACROSS THE FFI, so the mirror is checked by a test
 * instead: `cloud-signin.test.ts` reads `cloud_signin.rs` and asserts the two
 * lists are the same set. A compile gate on this side plus a source gate on the
 * boundary is the most the language pair allows.
 */
const FAILURE_TEXT: Record<SignInFailureCode, () => string> = {
  TIMEOUT: () => S.cloud_signin_err_timeout,
  STATE_MISMATCH: () => S.cloud_signin_err_state,
  REFUSED: () => S.cloud_signin_err_refused,
  UNREACHABLE: () => S.cloud_signin_err_unreachable,
  LISTEN: () => S.cloud_signin_err_listen,
  BAD_ENDPOINT: () => S.cloud_signin_err_endpoint,
};

/**
 * ⚠️ AN UNRECOGNISED REASON GETS THE 「could not be completed」 SENTENCE AND NOT
 * ITS OWN IDENTIFIER. Printing the raw token would be 0.2.53 exactly: a user
 * reading a symbol we invented. `REFUSED`'s sentence is the honest fallback —
 * it names no cause and its instruction (start again) is right for anything that
 * can reach this line.
 */
export function signInFailureText(reason: string | null): string {
  if (reason !== null && reason !== UNKNOWN_FAILURE && reason in FAILURE_TEXT) {
    return FAILURE_TEXT[reason as SignInFailureCode]();
  }
  return S.cloud_signin_err_refused;
}

/**
 * The page the browser lands on, in the language the PC is set to.
 *
 * 🔴 READ FROM THE SAME CATALOGUE AS EVERY OTHER STRING and handed to Rust as an
 * argument. The alternative — a second locale table in `i18n/desktop-rust/` —
 * would be a second place these five sentences exist, in nine languages, with
 * nothing to keep them in step. The listener holds no English.
 */
export function signInPageCopy(): SignInPageCopy {
  return {
    lang: getLocale(),
    ok_title: S.cloud_signin_page_ok_title,
    ok_body: S.cloud_signin_page_ok_body,
    fail_title: S.cloud_signin_page_fail_title,
    fail_body: S.cloud_signin_page_fail_body,
  };
}

/**
 * What the Cloud Key field will hold once this paste lands, computed from the
 * field's current value and the selection the paste replaces.
 *
 * 🔴 WHY THE SELECTION IS PART OF IT, rather than validating the clipboard text
 * on its own: pasting over a selected wrong key is the ordinary correction
 * gesture, and validating only the incoming fragment would call a correct paste
 * malformed whenever the field was not empty. This computes the value the user
 * is actually about to have.
 *
 * Deliberately synchronous and pure — no `nextTick`, no timer. The alternative
 * (let the paste land, then read the input back) depends on when the browser
 * dispatches `input` relative to a microtask checkpoint, which is exactly the
 * kind of「works on my machine」timing this repo keeps paying for.
 */
export function valueAfterPaste(
  current: string,
  pasted: string,
  selectionStart: number | null,
  selectionEnd: number | null,
): string {
  const start = selectionStart ?? current.length;
  const end = selectionEnd ?? start;
  const lo = Math.max(0, Math.min(start, end, current.length));
  const hi = Math.max(0, Math.min(Math.max(start, end), current.length));
  return current.slice(0, lo) + pasted + current.slice(hi);
}

/** Whether a paste should light the named inline error, right now.
 *
 * 🔴 EMPTY IS NOT MALFORMED. A paste of nothing (or of whitespace) says nothing
 * about the key, and shouting at a user who has not given us anything to judge
 * is how an inline error becomes noise people learn to ignore.
 *
 * ⚠️ WHAT THIS DOES NOT CLAIM, and the reason the save path is untouched:
 * `isJwtShaped` is a SHAPE test. A well-formed string can still be the wrong
 * key, an expired one, or one for another account — that answer only comes from
 * the relay, and the existing `cloud_err_expired` / `cloud_err_refused`
 * sentences are where it lands. This only catches what can be known here: a
 * password, a console URL, half a token.
 */
export function pasteLooksMalformed(nextValue: string): boolean {
  const trimmed = nextValue.trim();
  if (trimmed.length === 0) return false;
  return !isJwtShaped(trimmed);
}
