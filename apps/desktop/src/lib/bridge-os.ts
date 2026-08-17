// The doors to things the OPERATING SYSTEM owns: a folder, a settings pane, a
// permission.
//
// ── WHY THIS IS ITS OWN FILE, AND WHY THESE THREE ────────────────────────────
//
// The 800-line src cap bit `bridge.ts` again (the same move that produced
// `bridge-portable.ts`, `capsule-copy.ts` and, in Rust, `inject/preflight.rs`).
// As in that precedent the knife goes where the RULES differ rather than at the
// midpoint of the file, and what these three share is a CALLING CONVENTION:
//
//   · bridge.ts — the live product surface, whose doors degrade to a safe
//     default so a down bridge still leaves a renderable UI (`invokeSafe` folds
//     every rejection into `undefined` plus a console.warn);
//   · this file — the OS is the one answering, so a failure's ONLY product is
//     what it said. 「文件管理器起不来」/「这个面板不存在」/「没法问」 need three
//     different sentences and a console.warn is not somewhere a user can read.
//     For the permission read the same rule takes its sharpest form: 「还没给」
//     and 「没法问」 must NOT collapse into one, or a macOS banner appears on
//     Windows the first time a command name drifts.
//
// ⚠️ IT IMPORTS FROM bridge.ts AND IS NOT RE-EXPORTED BACK — one edge, one
// direction, so `verify:lint circular` stays green. It also keeps the header
// claim 「the only frontend module that imports @tauri-apps」 true: the raw
// `invoke` stays over there behind `invokeSafe` / `invokeVerbose`.
//
// Today the permission half is macOS Accessibility only. Microphone, screen
// recording and input monitoring belong here beside it when they arrive — the
// shape of the question is the same and it is not a property of any one page.

import { invokeVerbose, invokeSafe, appendForensic } from './bridge';
import { asAccessibilityStatus, type AccessibilityStatus } from './accessibility-notice';

/** Open the desktop diagnostics directory in the system file manager.
 *
 * The reason goes to the user AND to window-forensics.log: this is the forensic
 * path, and a forensic feature whose own failure is unreadable is the joke it
 * exists to prevent. 「日志目录压根不存在」 and 「文件管理器打不开」 are different
 * problems with different fixes.
 *
 * ⚠️ VERBATIM MOVE from bridge.ts (0.3.8, the 800-line cap) apart from being
 * rewritten onto `invokeVerbose`, which is the same code it used to inline. */
export async function openLogDirectory(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await invokeVerbose('open_log_directory');
  if (!r.ok) appendForensic('logdir', `open failed: ${r.reason}`);
  return r;
}

/** Ask the OS, now.
 *
 *  `null` = we could not ask (no bridge / command missing / unrecognised shape)
 *  and the caller renders NOTHING for it — never a guess in either direction.
 *
 *  🔴 Deliberately not cached anywhere. The user grants this permission WHILE
 *  the app is running — that is the entire flow — so an answer read once at
 *  start-up is the failure mode, not the optimisation. */
export async function fetchAccessibilityStatus(): Promise<AccessibilityStatus | null> {
  return asAccessibilityStatus(await invokeSafe<unknown>('accessibility_status'));
}

/** Open System Settings ▸ Privacy & Security ▸ Accessibility.
 *
 * ⚠️ `ok:true` means the OPEN WAS ACCEPTED, not that the pane is in front of the
 * user — the Rust side measures the same distinction and says so. That is why
 * the notice keeps the menu path on screen in words next to this button: a
 * future macOS that renames the pane would leave a reader with nothing at all
 * if the button were the only route. */
export async function openAccessibilitySettings(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await invokeVerbose('open_accessibility_settings');
  if (!r.ok) appendForensic('inject', `opening the Accessibility pane failed: ${r.reason}`);
  return r;
}
