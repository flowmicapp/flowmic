// Card IMG-COPY (owner P0, 2026-08-25) — WHAT a timeline row's copy button
// copies, decided in one pure place.
//
// SPEC-REF:
//   docs/strategy/2026-08-25-owner-rulings-and-execution-plan.md §1.2 / §2-③
//   TimelinePage.vue `copy()` — the one caller; the clipboard write stays there.
//   src-tauri/src/socket/row_image.rs — where the DELIVERED picture lives.
//
// ── WHAT WAS WRONG (measured, execution plan §1.2) ───────────────────────────
// `copy()` had two branches and an image row fell into THREE outcomes:
//   · thumb present            → wrote the 256 px PREVIEW, not the original;
//   · no thumb, output_text '' → `text === null` is false for '' ⇒ writeText('')
//                                 reported SUCCESS while EMPTYING the clipboard;
//   · no thumb, field missing  → silent return, nothing said.
// An un-captioned image row's output_text IS the empty string (capsule-copy.ts),
// and row_transit.rs records "image row has no preview" as a known gap — so the
// second and third outcomes are real paths, not theory.
//
// ── THE RULES ────────────────────────────────────────────────────────────────
// 1. An empty string NEVER reaches the clipboard. When there is nothing to
//    copy the button is not offered at all ([canCopyRow]); if a plan still
//    comes back `none`, the caller renders NO success tick.
// 2. An image row copies the ORIGINAL (`full_image` ⇒ `rowImage(id)`, the same
//    disk read the zoom path uses), falling back to the thumbnail only when
//    there is no original. The fallback stays because old rows and cloud-leg
//    rows genuinely have only a thumbnail — but nothing here restates the old
//    "the originals live nowhere" claim: the RV-93 correction in
//    TimelinePage.vue overturned it on 2026-08-01.
// 3. A text row copies `textOf(id, channel)` only when it is a non-empty string.
// 4. THE TYPE IS DECLARED FROM THE STORED FILE, never assumed (addendum ③,
//    measured on the owner's machine: the originals there are JPEG, and the
//    old copy() hard-coded image/png). Chromium's async clipboard accepts ONLY
//    image/png on write, so a JPEG/WebP original cannot go through
//    `navigator.clipboard.write` under its real type — and must not go under a
//    false one. Decision: PNG originals and thumbnails take the browser path
//    byte for byte; every other type takes the NATIVE command
//    (`capsule_copy_image`, src-tauri/src/shell/clipboard_image.rs), which
//    decodes the stored file through WIC and writes a CF_DIB — pixels
//    preserved, container not byte-identical, because no Windows clipboard
//    format that consumers read carries raw JPEG bytes. Said here rather than
//    hidden in a branch.

import type { TimelineRow } from '../lib/types';

export type RowCopyPlan =
  | { kind: 'image'; bytes: Uint8Array; mime: string; source: 'original' | 'thumb' }
  | { kind: 'text'; text: string }
  /** Nothing honest to copy. The caller must not write, must not tick. */
  | { kind: 'none'; reason: 'empty-text' | 'no-image' };

export interface RowCopyDeps {
  /** The delivered picture as a `data:` URL, or null when the row has none —
   *  `TimelineTransport.rowImage` (lib/bridge.ts → `timeline_image`). */
  rowImage(id: string): Promise<string | null>;
  /** The row's current text from the store, or null when the row is gone. */
  textOf(id: string, channel: TimelineRow['channel']): string | null;
}

/** Whether the row has anything to copy at all — the button's `v-if`. An image
 *  row needs a picture (original or preview); any other row needs non-empty
 *  text. A control row never has either (its face is composed at render time). */
export function canCopyRow(row: Pick<TimelineRow, 'entry_type' | 'output_text' | 'thumb_b64' | 'full_image'>): boolean {
  if (row.entry_type === 'image') return row.full_image === true || !!row.thumb_b64;
  if (row.entry_type === 'control') return false;
  return typeof row.output_text === 'string' && row.output_text !== '';
}

/** base64 → bytes. Pure, so a test can compare the result byte for byte. */
export function b64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** `data:<mime>;base64,<payload>` → the mime and the bytes, or null when the
 *  string is not that shape (a malformed answer is "no picture", never a
 *  clipboard write of garbage). */
export function dataUrlBytes(url: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]*)$/.exec(url);
  const mime = m?.[1];
  const payload = m?.[2];
  if (mime === undefined || payload === undefined) return null;
  try {
    return { mime, bytes: b64Bytes(payload) };
  } catch {
    return null;
  }
}

export async function planRowCopy(row: TimelineRow, deps: RowCopyDeps): Promise<RowCopyPlan> {
  if (row.entry_type === 'image') {
    if (row.full_image === true) {
      const url = await deps.rowImage(row.id);
      const decoded = url === null ? null : dataUrlBytes(url);
      if (decoded !== null) return { kind: 'image', bytes: decoded.bytes, mime: decoded.mime, source: 'original' };
      // The row said it had an original and the disk did not answer (deleted
      // beside its row, or unreadable): a smaller picture is still a picture.
    }
    if (row.thumb_b64) return { kind: 'image', bytes: b64Bytes(row.thumb_b64), mime: 'image/png', source: 'thumb' };
    return { kind: 'none', reason: 'no-image' };
  }
  const text = deps.textOf(row.id, row.channel);
  // 🔴 `''` is NOT copyable. This is the branch that used to writeText('') and
  // report success while emptying the user's clipboard.
  if (typeof text !== 'string' || text === '') return { kind: 'none', reason: 'empty-text' };
  return { kind: 'text', text };
}

/** The two doors a picture can leave through, injected so the routing is
 *  unit-testable without a clipboard: `browser` is `navigator.clipboard`
 *  (PNG only — see rule 4), `native` is lib/bridge-clipboard's `copyRowImage`. */
export interface RowCopyWriters {
  writeText(text: string): Promise<void>;
  writeImage(mime: string, bytes: Uint8Array): Promise<void>;
  native(id: string, thumb: string | null): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type RowCopyOutcome = { wrote: 'text' | 'image-browser' | 'image-native' } | { wrote: null; reason: string };

/** Perform a plan. `wrote: null` is the NO-TICK outcome: either nothing to copy
 *  or a refused write, each with its reason. Never writes an empty string. */
export async function performRowCopy(
  plan: RowCopyPlan,
  row: Pick<TimelineRow, 'id' | 'thumb_b64'>,
  w: RowCopyWriters,
): Promise<RowCopyOutcome> {
  if (plan.kind === 'none') return { wrote: null, reason: plan.reason };
  if (plan.kind === 'text') {
    await w.writeText(plan.text);
    return { wrote: 'text' };
  }
  if (plan.mime === 'image/png') {
    await w.writeImage(plan.mime, plan.bytes);
    return { wrote: 'image-browser' };
  }
  // A JPEG / WebP original: the browser refuses the real type and must not be
  // handed a false one — the native command decodes it and writes a DIB.
  const r = await w.native(row.id, row.thumb_b64);
  return r.ok ? { wrote: 'image-native' } : { wrote: null, reason: r.reason };
}
