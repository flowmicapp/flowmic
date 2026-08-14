// 🔴 owner 2026-08-02 (F1a reversal ruling, docs/strategy/2026-08-02-0248-status-truth-analysis.md
// 「owner 澄清」("owner clarification") item 1):「FlowMic 自家输入框（如时间线搜索框）必须能注入——它本身就是
// PC 端的一个窗口，光标定位到这里我说的话肯定能注入，这是非常正常的要求。」("FlowMic's own input boxes (like the timeline search box) must be able to receive injection — it's a window on the PC side itself; with the cursor positioned there, what I say obviously must be injectable — this is a perfectly normal requirement.")
//
// This module is the WebView half of that ruling: it tells Rust 「我这个窗口里现在
// 有没有一个可输入的焦点」("whether there is currently a typeable focus in this window of mine"). The Rust half (src-tauri/src/inject/self_focus.rs) holds
// the judgement, the live cross-check against the OS foreground, and the TTL; this
// file only OBSERVES and pushes.
//
// ── WHY THE OBSERVATION HAS TO HAPPEN HERE ───────────────────────────────────
// Every injection judgement in this product before today was made from OUTSIDE the
// target's process, and that boundary cost two P0s in two days (0.2.19 refused every
// browser dictation; 0.2.21 called landed text 「未注入」("not injected") — see
// docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md). None of
// it applies to our own window: `document.activeElement` is not an inference, it is
// the answer.
//
// ── ONE QUESTION, ONE ANSWER (CLAUDE.md's #1 red line) ─────────────────────────────
// The boolean pushed from here answers 「这个窗口里现在有没有一个可输入的焦点」("whether there is currently a typeable focus in this window") and
// nothing else. It is deliberately NOT the capsule's `state.target` (「注入目标是哪个
// 外部程序」("which external program is the injection target")), NOT `focus-target.ts` (which exists to make sure our own window is
// never SHOWN as a destination), and it never travels on the wire.
//
// ── 🔴 THE FAILURE DIRECTION IS OWNED BY THE RUST SIDE, AND IT IS SAFE ────────
// If this module is never wired, never runs, or stops running (a wedged renderer),
// Rust sees 「absent」 / 「stale」 and answers not injected · cached — byte-for-byte what
// 0.2.48 already does for this case. Nothing regresses. The heartbeat below exists
// so a GENUINELY focused input survives an arbitrarily long utterance; it is not a
// liveness check for anything else.

/** The subset of `Element` this module reads. Declared structurally so the logic is
 *  node-testable without a DOM — the whole criterion is four fields. */
export interface FocusElementLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  readonly type?: string;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
}

/** The subset of `Document` this module reads. */
export interface FocusDocumentLike {
  hasFocus(): boolean;
  readonly activeElement: FocusElementLike | null;
}

/** Where a computed answer goes. Production wires `reportSelfFocus` (lib/bridge.ts
 *  → the `self_focus_report` Tauri command); tests wire a recorder. */
export type SelfFocusSink = (editable: boolean) => void;

/** How often a STILL-focused input re-asserts itself, refreshing the Rust-side TTL
 *  (`SELF_FOCUS_TTL`, 10s — three missed beats). It runs ONLY while the last computed
 *  answer was `true`, so the common case (FlowMic not in front, or in front with
 *  nothing focused) costs zero IPC. */
export const SELF_FOCUS_HEARTBEAT_MS = 3_000;

/** `<input type=...>` values that accept typed characters. Everything else — button,
 *  checkbox, radio, submit, reset, file, image, color, range, hidden — is a control
 *  the user operates but never TYPES into, and synthetic characters aimed at one land
 *  nowhere (or trigger it). Absent `type` defaults to `text` per HTML. */
const TYPEABLE_INPUT_TYPES = new Set([
  '', 'text', 'search', 'url', 'tel', 'email', 'password', 'number',
  'date', 'datetime-local', 'month', 'week', 'time',
]);

/** Does this element accept typed text RIGHT NOW?
 *
 *  `disabled` and `readOnly` are part of the judgement rather than an afterthought:
 *  a readonly search box looks focusable and swallows every character, and claiming
 *  `injected` for those characters is the forbidden direction of no silent failure. */
export function isTypeableElement(el: FocusElementLike | null | undefined): boolean {
  if (!el) return false;
  if (el.disabled === true) return false;
  const tag = (el.tagName ?? '').toLowerCase();
  if (tag === 'textarea') return el.readOnly !== true;
  if (tag === 'input') {
    if (el.readOnly === true) return false;
    return TYPEABLE_INPUT_TYPES.has((el.type ?? '').toLowerCase());
  }
  // contenteditable hosts (none today; the timeline's inline edit is a real
  // <input>). Kept because the judgement must be about what the DOM IS, not about
  // which components happen to exist this week.
  return el.isContentEditable === true;
}

/** The whole answer for one document, as a pure function.
 *
 *  🔴 `hasFocus()` IS PART OF IT, not a belt-and-braces extra. `activeElement` keeps
 *  naming the last focused input after the document loses focus — that is what makes
 *  refocusing restore the caret — so reading it alone would claim a typeable focus for
 *  a window nobody is typing into. (Rust cross-checks the OS foreground too; these are
 *  two different facts, and the one this side owns is 「文档自己有没有焦点」("whether the document itself has focus").) */
export function computeSelfFocusEditable(doc: FocusDocumentLike): boolean {
  if (!doc.hasFocus()) return false;
  return isTypeableElement(doc.activeElement);
}

/**
 * The push policy, separated from the DOM plumbing so every rule below can be
 * asserted without a browser.
 *
 * Two rules, and both are about not lying rather than about saving IPC:
 *   · a CHANGE is pushed immediately — 「用户点走了就必须及时变」("once the user clicks away, it must change promptly") is the requirement,
 *     and a debounce here would leave a window in which we would type into a field
 *     the user has already left;
 *   · an UNCHANGED `true` is re-pushed on the heartbeat, because the Rust side stops
 *     believing a report after `SELF_FOCUS_TTL`. An unchanged `false` is NOT re-pushed:
 *     letting it expire lands on exactly the same verdict (`Stale` and `Reported`
 *     are both not injected · cached), so a beat would buy nothing.
 */
export class SelfFocusReporter {
  private last: boolean | null = null;

  constructor(private readonly sink: SelfFocusSink) {}

  /** Recompute and push if the answer moved. Returns what was computed. */
  sample(doc: FocusDocumentLike): boolean {
    const next = computeSelfFocusEditable(doc);
    if (next !== this.last) {
      this.last = next;
      this.sink(next);
    }
    return next;
  }

  /** Heartbeat tick: refresh the TTL only while an input really is focused. */
  beat(doc: FocusDocumentLike): void {
    const next = computeSelfFocusEditable(doc);
    if (next !== this.last) {
      this.last = next;
      this.sink(next);
      return;
    }
    if (next) this.sink(true);
  }

  /** Test/guard surface: the last value this reporter believes it pushed. */
  lastPushed(): boolean | null {
    return this.last;
  }
}

/** DOM plumbing. Returns a teardown so a caller (or a test) can unwire it.
 *
 *  ⚠️ `focusout` is read on the NEXT TASK, not inline: at `focusout` time the browser
 *  has not moved focus yet and `activeElement` is still <body>, so an inline read
 *  reports 「没有输入焦点」("no input focus") for every click that moves between two input boxes — a
 *  false negative that would make the feature look flaky rather than broken.
 *
 *  ⚠️ WIRED FROM THE MAIN WINDOW ONLY (main-window/main.ts). The capsule is
 *  `WS_EX_NOACTIVATE` (shell/mod.rs) — it can never BE the OS foreground, so a report
 *  from it could never pass the Rust cross-check. Wiring it would add a pusher whose
 *  every message is discarded, which is a façade with a heartbeat. */
export function wireSelfFocusReporter(
  doc: Document,
  win: Window,
  sink: SelfFocusSink,
): () => void {
  const reporter = new SelfFocusReporter(sink);
  const view = doc as unknown as FocusDocumentLike;
  const now = (): void => {
    reporter.sample(view);
  };
  const soon = (): void => {
    win.setTimeout(now, 0);
  };
  doc.addEventListener('focusin', now, true);
  doc.addEventListener('focusout', soon, true);
  win.addEventListener('focus', now);
  win.addEventListener('blur', now);
  const timer = win.setInterval(() => reporter.beat(view), SELF_FOCUS_HEARTBEAT_MS);
  // Seed: the window may already be focused with an input active (a reload while the
  // user was typing). Without this the first report waits for an event that may never
  // come.
  now();
  return () => {
    doc.removeEventListener('focusin', now, true);
    doc.removeEventListener('focusout', soon, true);
    win.removeEventListener('focus', now);
    win.removeEventListener('blur', now);
    win.clearInterval(timer);
  };
}
