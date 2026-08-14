// GA-25 — the capsule's live "inject target" (注入目标) decision, kept pure so it is testable
// without Vue / Tauri.
//
// SPEC-REF: REDESIGN §5.3 (capsule element `[→ 目标App]` (target app) = the CURRENT focus, not
// the last injection) / 07 §3 (the SPEAKING lock does not follow mid-utterance
// foreground switches).
//
// Feed: the `flowmic://focus-changed` bridge channel, pushed by the Rust pump on
// the same change-only foreground sample that mirrors `focus:state` to the phone
// (apps/desktop/src-tauri/src/socket/pump.rs).
//
// TRACKING GRANULARITY (owner-facing boundary): the foreground WINDOW / PROCESS
// (EVENT_SYSTEM_FOREGROUND). Moving the caret between two input boxes INSIDE the
// same window raises no foreground event (known F-2344), so the shown target does
// not refresh — that is expected, not a bug. Acceptance is "switch to another
// application window".

/** The `flowmic://focus-changed` payload (mirrors the Rust `json!` in pump.rs). */
export interface FocusChanged {
  window_title: string;
  process_name: string;
}

/** Our own executable basenames. `current_app_name_inner` strips the directory
 *  and the `.exe`, so this is what the FlowMic desktop reports for itself. Our
 *  own window is never an injection destination — showing it would be a lie. */
const SELF_PROCESS = new Set(['flowmic-desktop', 'flowmic']);

/** The Windows shell desktop (Progman/WorkerW). `explorer` alone is NOT enough —
 *  a File Explorer window is a legitimate foreground; only the desktop itself,
 *  which carries this exact title, is not an injectable destination. */
const SHELL_DESKTOP_TITLE = 'Program Manager';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Normalize an untrusted bridge payload into a FocusChanged (missing / wrong
 *  types collapse to empty strings → treated as "no injectable foreground"). */
export function parseFocusChanged(p: unknown): FocusChanged {
  const o = (p ?? {}) as Record<string, unknown>;
  return {
    window_title: str(o.window_title ?? o.windowTitle),
    process_name: str(o.process_name ?? o.processName),
  };
}

/** Label to SHOW for this foreground, or `''` when there is no injectable
 *  destination. Prefer a non-empty `window_title` (Windows). When the title is
 *  empty and `process_name` is non-empty, fall back to the process name —
 *  macOS `current_window_title` is structurally always ""
 *  (apps/desktop/src-tauri/src/focus/macos.rs), so the process name is the only
 *  live answer there; the inject:result display path already does the same
 *  fallback (apps/desktop/src/lib/inject-provenance.ts,
 *  apps/desktop/src/main-window/TimelinePage.vue). On Windows an empty title
 *  with no usable process name still means shell/no-target. `''` renders as
 *  「—」. SELF_PROCESS (keyed by lowercased process_name) applies on both the
 *  title and process-name paths; SHELL_DESKTOP_TITLE only applies to titles. */
export function injectableTarget(p: unknown): string {
  const { window_title, process_name } = parseFocusChanged(p);
  if (SELF_PROCESS.has(process_name.toLowerCase())) return '';
  if (window_title) {
    if (window_title === SHELL_DESKTOP_TITLE) return '';
    return window_title;
  }
  return process_name || '';
}

/** `focus-changed` → the next `state.target`.
 *
 *  While `locked` (the SPEAKING latch is held) the display FREEZES on the locked
 *  target: the injection goes to the window that was foreground when speech
 *  started, so a target that drifted mid-utterance would be a lie. The capsule
 *  renders the 🔒 icon off the same `locked` flag. `inject:result` still
 *  overwrites the target afterwards — delivered truth outranks observation. */
export function nextFocusTarget(current: string, locked: boolean, p: unknown): string {
  return locked ? current : injectableTarget(p);
}
