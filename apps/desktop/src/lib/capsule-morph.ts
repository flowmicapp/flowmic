// WP-R2-2 capsule FORM state (07 §4 — the first of the two orthogonal capsule
// state spaces). Pure + time-injected so it is unit-testable with no timers.
//
// Form (形态): speaking → just_injected (800 ms window, click-through) | inject_failed
// (1500 ms window, spec E-5 — the truthful FAILURE flash) → idle_with_history
// (last ≤5 entries always shown) → idle. Sizes are 07 §1.
//
// R6-R1 fix (CLAUDE.md red line: no silent failure): before this there was no failure form,
// so a non-`ok` inject:result still flashed the green "injected" (已注入) — a silent lie.
// inject_failed is a distinct transient form the controller opens ONLY for a
// non-injected outcome; the controller carries the honest reason/severity for
// rendering (red hard-fail vs amber cached).

export type Morph =
  | 'idle'
  | 'idle_with_history'
  | 'speaking'
  | 'just_injected'
  | 'inject_failed';

export const CAPSULE_WIDTH = 560;
/** 07 §1 heights per form (+ the with_drawer height when the history drawer is
 *  open). ⚠️ These are the CARD's heights, not the WINDOW's — the window needs
 *  [[CAPSULE_CHROME]] more. Size the window through [[windowHeightFor]]. */
export const CAPSULE_HEIGHT = {
  idle: 56,
  idle_with_history: 120,
  speaking: 200,
  // ── RV-81 (window B4, 2026-08-01, owner ruled path A) ──────────────────────────────
  // These three used to be 140 / 140 / 560 — round numbers nobody had measured
  // against what actually renders. Real Chromium render (verbatim capsule.css +
  // tokens.css + the CapsuleApp.vue markup, `getBoundingClientRect`, DPR 1) said
  // otherwise: `just_injected`/`inject_failed` render as ONE FIXED-HEIGHT row
  // (`.caps-ok .crow`/`.caps-fail .crow { height: 56px }` — not content-flow, a
  // literal CSS height, so 56 is exact, not an estimate) — the old 140 window
  // (150 with chrome) left 94px of fully transparent, non-rendering space below
  // the pill. `just_injected` is click-through the whole time (07 §4) so that
  // space was harmless; `inject_failed` is NOT (a failure must be readable, not
  // dismissible by a stray click-through) — so its 94px was real: clicks aimed
  // at whatever sits below the capsule landed on dead air instead.
  //
  // `with_drawer` is the header row + the `.diag` diagnostics panel, whose row
  // count is RUNTIME-VARIABLE (`endpointLine` / `state.lastLoudReason` in
  // CapsuleApp.vue are both `v-if` — 4 to 6 rows depending on live connection
  // state). Measured worst case (all 6 rows shown) = 286.18px; the always-shown
  // 4-row case measures 231.43px. A static constant cannot track a
  // runtime-variable content height exactly — see capsule-content-height.test.ts
  // for the honest limits of what this file's own test now asserts.
  //
  // 🔴 owner's asymmetric-risk ruling (RV-79 vs RV-81, 2026-08-01): a card
  // TALLER than its window is a real visual defect the owner has SEEN (RV-79 —
  // square bottom corners on a real machine); a window a few dozen px taller
  // than its card is, at worst, an unfelt strip of dead clicks. ⇒ round UP, not
  // to the nearest px, when in doubt — never re-introduce a value smaller than
  // the measured worst case, even by one row's worth of slack.
  //   just_injected / inject_failed: 56 — EXACT (CSS-forced height, not a
  //     measurement with error bars; there is no "worst case" to round for).
  //   with_drawer: 290 — the measured 6-row worst case (286.18) rounded up,
  //     same small-margin convention `idle_with_history`(120 vs measured 113.3)
  //     and `speaking`(200 vs measured 197.5) already used above. Residual: when
  //     only 4 rows actually show (the common case), the window still carries
  //     ~68px of dead-click slack (290+10 chrome − 231.43) — Path A (static
  //     table value sized to the worst case) cannot close that; only resizing
  //     to the LIVE content height (ResizeObserver, "Path B") would. Path B was
  //     not chosen this round.
  just_injected: 56,
  inject_failed: 56,
  with_drawer: 290,
} as const;
/** The transparent gutter the card needs AROUND itself, in logical px —
 *  VERTICAL ONLY (top + bottom), because that is the axis `windowHeightFor`
 *  answers for. `styles/capsule.css` gives `.wrap` 4px above and 14px below (so
 *  the card's drop shadow has somewhere to fall) and `.caps` a 1px border:
 *  4+14+1+1 = 20 px the WINDOW must have and the CARD height does not describe.
 *
 *  🔴 10 → 20 (REQ-13-15, 2026-08-13). The old gutter was 4px on all four
 *  sides, which is 12px LESS than the drop shadow reached below the card, so on
 *  Windows the semi-transparent gradient was still well above zero alpha when
 *  the window rect ended — owner saw that discontinuity as「明显的切边」. The fix
 *  moves two dials at once (a smaller shadow AND a bigger gutter); the gutter
 *  is deliberately per-side, since a downward-offset shadow does not need the
 *  same room above as below. The HORIZONTAL gutter (8px each side) is not in
 *  this constant at all: the window WIDTH is pinned at [[CAPSULE_WIDTH]] and it
 *  is the CARD that gives up those 16px (552 → 544 painted) — an explicit trade,
 *  because the window width is the number positioning, clamping and 07 §1 are
 *  all written against.
 *
 *  Why this exists (owner 2026-07-31, 0.2.31 real device (真机): "restarting
 *  the APP or opening the PC side for the first time, the capsule window
 *  appears…the bottom is square…if you transcribe a few times the window is
 *  fine"): `capsule_resize` sizes the
 *  WINDOW, and it was being handed the CARD height. In the idle form the card's
 *  content is exactly `.crow{height:56px}` = the whole 56px budget, so the card
 *  ran 10px past the bottom of its own window and the window edge sliced it off
 *  — measured in a real WebView at 560×56: `.caps` bottom sat 9.3px below the
 *  client area. A 16px radius is only ~3.5px inset from the sides that far up
 *  the curve, so the bottom two corners rendered SQUARE while the top two were
 *  whole. The "if you transcribe a few times it's fine" half is the same arithmetic run forwards: one
 *  recent row moves the form to idle_with_history, whose 120px window has room
 *  for that form's 94.6px card, so all four corners come back.
 *
 *  ⚠️ Kept honest by `capsule-chrome.test.ts`, which PARSES those declarations
 *  out of capsule.css — CSS cannot import this constant, so the agreement has to
 *  be asserted rather than compiled. Change the padding or the border and that
 *  test goes red pointing here. The gutter being BIG ENOUGH FOR THE SHADOW is a
 *  different question with a different test:
 *  `capsule-shadow-fits-window.test.ts`. */
export const CAPSULE_CHROME = 20;
/** The WINDOW height that paints a card of `cardHeight` whole. The ONE place
 *  the chrome is added — every caller (the resize loop, the caret-anchor
 *  reservation, the drag clamp) must go through it so no surface can be sized
 *  with a number that means the other thing. */
export function windowHeightFor(cardHeight: number): number {
  return cardHeight + CAPSULE_CHROME;
}
export const JUST_INJECTED_MS = 800;
/** spec E-5: the failure flash is held 1.5 s so the reason + fallback are readable. */
export const INJECT_FAILED_MS = 1500;

export class CapsuleMorph {
  private speaking = false;
  private justInjectedUntil = 0;
  private injectFailedUntil = 0;
  private historyCount = 0;
  /** history drawer open — overrides the form height with with_drawer (07 §1). */
  drawerOpen = false;

  /** audio:start / first interim → speaking. */
  onSpeakingStart(): void {
    this.speaking = true;
  }

  /** speak ended WITHOUT an injection (e.g. empty final) — fall back to idle*. */
  onSpeakingEnd(): void {
    this.speaking = false;
  }

  /** an injection RESOLVED OK → open the 800 ms just_injected window (07 §4). */
  onInjected(now: number): void {
    this.speaking = false;
    this.injectFailedUntil = 0; // mutually exclusive with a failure flash
    this.justInjectedUntil = now + JUST_INJECTED_MS;
  }

  /** an injection did NOT deliver (ok=false: hard fail OR cached) → open the
   *  1500 ms inject_failed window (spec E-5). The controller stamps the honest
   *  reason + cached/hard-fail severity for rendering; this only owns the timing. */
  onInjectFailed(now: number): void {
    this.speaking = false;
    this.justInjectedUntil = 0; // never a green flash on a non-injected outcome
    this.injectFailedUntil = now + INJECT_FAILED_MS;
  }

  /** number of recent entries kept in the idle_with_history strip (≤5). */
  setHistoryCount(n: number): void {
    this.historyCount = Math.max(0, n);
  }

  state(now: number): Morph {
    if (this.speaking) return 'speaking';
    if (now < this.injectFailedUntil) return 'inject_failed';
    if (now < this.justInjectedUntil) return 'just_injected';
    return this.historyCount > 0 ? 'idle_with_history' : 'idle';
  }

  /** WINDOW height for the current form (or with_drawer when the drawer is
   *  open) — i.e. the card plus [[CAPSULE_CHROME]]. Named `windowHeight` and not
   *  `height` on purpose: the old name answered "how tall is this form" and was being used
   *  for "how tall should the window open", which are 10px apart and clipped the card's bottom
   *  corners for every form whose card filled its budget. */
  windowHeight(now: number): number {
    if (this.drawerOpen) return windowHeightFor(CAPSULE_HEIGHT.with_drawer);
    return windowHeightFor(CAPSULE_HEIGHT[this.state(now)]);
  }

  /** 07 §4: click-through (set_ignore_cursor_events) ONLY during the 800 ms
   *  just_injected window — the capsule must never eat a click the rest of the
   *  time, and must never block the target during the injected flash. The
   *  inject_failed flash is NOT click-through: the user should be able to read /
   *  keep it, and a failure must never be dismissed by a stray click passing through. */
  clickThrough(now: number): boolean {
    return !this.drawerOpen && this.state(now) === 'just_injected';
  }
}
