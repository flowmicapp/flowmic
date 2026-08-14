// WP-R6 C3 capsule position — first-surface placement + drag persistence (07 §4).
// Pure + KvStore-injected so the placement math is unit-testable with no window /
// localStorage. This module owns the default placement and the persisted
// round-trip; the DRAG itself is no longer computed here (REQ-12-15, below).
//
// Coordinate space: LOGICAL pixels — exactly what capsule.move consumes. Persisting
// the logical position we commanded makes restore an exact round-trip (no
// scale-factor drift). The task wording says "physical pixels" (物理像素); physical would require the
// live scale factor to convert back for the logical set_position and is a source of
// drift — logical is the honest, consistent choice.
//
// ⚠ 2026-07-25 (real-machine UAT) — THE HAZARD THIS MODULE WAS BUILT AROUND.
// The header once claimed the WebView reports screenX/screenY as "DPI-independent
// CSS px". It does NOT on a scaled Windows display — they are PHYSICAL device px,
// and trusting that claim is what put the capsule off-screen (the measurement is
// kept verbatim on `clampToWork`, which still rescues the exact point that drag
// persisted: 1678,1919 on a 2560×1440 logical desktop).
//
// 🔴 REQ-12-15 (2026-08-12) — THAT CONVERSION IS GONE, ALONG WITH ITS QUESTION.
// The capsule is now dragged by the OS's own move loop (`capsule.startDrag()` →
// Rust `start_dragging`), and the position that gets persisted is READ BACK from
// the OS in logical px (`capsule.position()` → Rust converts once, by the capsule
// window's real scale factor). So this module no longer converts a screen-space
// pointer delta at all: `screenDeltaToLogical` and `applyDelta` were deleted with
// their last production caller rather than left behind as tested-but-unused math
// (anything with no production caller must go away together with its production caller (没有生产方的东西要跟着生产方一起走)). The rule that survives is stronger than the
// helper was — a position we never handled cannot be a position we inflated.
// R6 T-1: the caret rect arrives from Win32 in PHYSICAL px and is converted ONCE,
// in `shell::caret_rect` (Rust), by the capsule window's scale factor — so
// everything in THIS module, including anchorToCaret, is logical px throughout.
//
// R6 T-1 — the SEAM left here is now FILLED per owner ruling D1 (caret anchoring).
// The first-surface priority chain is:
//   ① a persisted drag position  → wins FOREVER (explicit intent > automation);
//                                   caret anchoring is not even attempted;
//   ② no persisted position      → anchorToCaret (below the caret, flip above when
//                                   it does not fit, clamp into the caret's own
//                                   monitor work area — never obscure the caret);
//   ③ no usable caret            → defaultTopCenter.
// The anchor fires ONCE, on the first hidden→visible edge (D1: never re-anchor
// to focus mid-session) — see capsule/controller.ts `setFirstSurfaceAnchor`.

import type { KvStore } from './types';

export const CAPSULE_POS_KEY = 'flowmic.capsule.pos';
/** Top margin (logical px) for the first-surface top-center fallback. */
export const CAPSULE_TOP_MARGIN = 12;
/** Clearance (logical px) kept between the caret and the capsule edge (T-1 §3). */
export const CAPSULE_CARET_GAP = 12;

export interface CapsulePos {
  x: number;
  y: number;
}

/** A rect in logical px. Screen-space coordinates may be NEGATIVE (a monitor left
 *  of / above the primary), so no placement math may assume a 0-based origin. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

function clamp(v: number, lo: number, hi: number): number {
  // hi < lo (capsule bigger than the work area) → pin to lo, never invert.
  return Math.max(lo, Math.min(v, Math.max(lo, hi)));
}

/** Caret anchoring (owner ruling D1) — PURE placement math, no OS.
 *
 *  `caret` and `work` come from the Rust `caret_rect` command (rcCaret converted to
 *  screen coords + the rcWork of the monitor the CARET is on). `size` is the box the
 *  capsule may occupy — callers pass the TALLEST ambient form, so that
 *  (a) the below-placement is only chosen when the capsule can still grow to
 *  「speaking」 without falling off-screen, and (b) the above-placement reserves that
 *  same growth, so a capsule that grows downward can never expand over the caret
 *  (red line: never obscure the caret).
 *
 *  Vertical: caret bottom + gap; if that overflows the work area, FLIP to caret
 *  top − height − gap. If neither side fits (a very short work area) the roomier
 *  side is taken and clamped — occlusion is then geometrically unavoidable, but we
 *  still never leave the visible area.
 *  Horizontal: centred on the caret, clamped inside the work area. */
export function anchorToCaret(
  caret: Rect,
  work: Rect,
  size: Size,
  gap: number = CAPSULE_CARET_GAP,
): CapsulePos {
  const workRight = work.x + work.width;
  const workBottom = work.y + work.height;
  const caretBottom = caret.y + caret.height;

  const below = caretBottom + gap;
  const above = caret.y - gap - size.height;

  let y: number;
  if (below + size.height <= workBottom) {
    y = below; // ① normal: below the caret
  } else if (above >= work.y) {
    y = above; // ② doesn't fit below → flip up
  } else {
    // ③ doesn't fit on either side → take the side with more room, then clamp into the work area.
    const roomBelow = workBottom - caretBottom;
    const roomAbove = caret.y - work.y;
    y = roomBelow >= roomAbove ? workBottom - size.height : work.y;
  }
  y = clamp(y, work.y, workBottom - size.height);

  // Horizontally centred on the caret, then clamped so no edge leaves the screen.
  const x = clamp(
    caret.x + caret.width / 2 - size.width / 2,
    work.x,
    workRight - size.width,
  );
  return { x: Math.round(x), y: Math.round(y) };
}

/** First-surface fallback: horizontally centered near the top of the primary
 *  screen (07 §4). Clamped to x ≥ 0 so a narrow screen never parks it off-left. */
export function defaultTopCenter(
  screenWidth: number,
  capsuleWidth: number,
  margin: number = CAPSULE_TOP_MARGIN,
): CapsulePos {
  return { x: Math.max(0, Math.round((screenWidth - capsuleWidth) / 2)), y: margin };
}

/** Read a persisted drag position, or null when absent / malformed → the caller
 *  falls back to top-center (never a fake origin). */
export function loadPos(kv: KvStore): CapsulePos | null {
  const raw = kv.get(CAPSULE_POS_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object') {
      const { x, y } = v as { x?: unknown; y?: unknown };
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
        return { x, y };
      }
    }
  } catch {
    // malformed JSON → treat as absent
  }
  return null;
}

/** Persist a position (rounded to whole logical px). */
export function savePos(kv: KvStore, pos: CapsulePos): void {
  kv.set(CAPSULE_POS_KEY, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }));
}

/** Drop the persisted drag position so the next surface re-anchors (caret →
 *  top-center). Empty string → loadPos returns null (KvStore has no delete). */
export function clearPos(kv: KvStore): void {
  kv.set(CAPSULE_POS_KEY, '');
}

/** Did a native drag actually move the capsule? (REQ-12-15)
 *
 *  This is the whole of what the frontend still decides about a drag, and it
 *  exists because a persisted position WINS FOREVER over caret anchoring (owner
 *  ruling D1): writing one the user never asked for would silently switch off
 *  first-surface anchoring for good, and nothing would ever say so.
 *
 *  It is also what carries the OLD ~3px pointer threshold's job across the
 *  mechanism change. That threshold answered「is this a click or a drag?」with a
 *  guess about pointer jitter; the OS move loop answers it with a fact — a
 *  press that never moved the pointer never moved the window, so the two
 *  positions are equal and nothing is persisted. Rounded to whole logical px on
 *  both sides because that is the resolution `savePos` writes: a sub-pixel
 *  difference that cannot survive persistence must not trigger it either.
 *
 *  `after` must come from the OS read-back (`capsule.position()`), never from a
 *  position we merely commanded — the point is to persist where the window IS. */
export function shouldPersistDrag(before: CapsulePos, after: CapsulePos): boolean {
  return Math.round(before.x) !== Math.round(after.x) || Math.round(before.y) !== Math.round(after.y);
}

/** Keep a position inside `work`, so a stale persisted point (saved under a
 *  different scale factor or on a monitor since disconnected) can never strand the
 *  capsule off-screen. Pure; callers pass the work area in LOGICAL px.
 *
 *  THE MEASUREMENT THIS NET WAS BUILT FOR (2026-07-25, real machine, 3840×2160
 *  @150% ⇒ 2560×1440 logical): a drag persisted `{x:1678, y:1919}` — y alone was
 *  479 px past the bottom edge, a value no logical coordinate could hold, because
 *  the drag had been adding PHYSICAL pointer deltas to a LOGICAL position. Tauri
 *  then multiplied it by the scale factor on restore, parking the capsule at
 *  physical 2517,2879: entirely off a 2160-tall screen, visible to Win32 and
 *  invisible to the user. REQ-12-15 removed the arithmetic that could produce
 *  such a number (the OS moves the window; we read the result back), so this
 *  clamp now guards only the cases it is named for — a changed scale factor, a
 *  monitor that went away. It stays because those cases did not go away, and
 *  because a persisted position from an OLDER build can still be one of these. */
export function clampToWork(pos: CapsulePos, work: Rect, size: Size): CapsulePos {
  return {
    x: Math.round(clamp(pos.x, work.x, work.x + work.width - size.width)),
    y: Math.round(clamp(pos.y, work.y, work.y + work.height - size.height)),
  };
}
