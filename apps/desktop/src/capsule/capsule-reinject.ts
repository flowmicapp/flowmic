// Capsule strip per-row RE-INJECT (owner 2026-08-24: 「PC 端胶囊窗口下方显示的
// 历史中，在复制小图标旁增加 1 个注入的小图标，点击可尝试再注入」 — "in the history
// shown below the PC capsule window, add a re-inject icon next to the copy icon;
// clicking it attempts to re-inject").
//
// Pure logic only, extracted so it is unit-testable without mounting the SFC —
// same split, same reason, as its sibling capsule-copy.ts. The emit, the await
// and the transient per-row icon state stay in CapsuleApp.vue.
//
// ── 🔴 WHY THIS DOES NOT CALL `timeline_reinject` ITSELF ────────────────────
//
// The copy button next door DOES call its Tauri command directly, and copying
// is genuinely a leaf act: the OS clipboard has no other author. Injection is
// the opposite, and the difference is written down in two places already:
//
//   · `src-tauri/src/shell/reinject.rs`'s header — "WHY THIS IS ONE COMMAND AND
//     NOT A SECOND PIPELINE": `injected` must keep exactly one meaning, which
//     is a hard constraint from the RV-45 ruling.
//   · `lib/timeline-store.ts`'s `reInject` — its transcript-only guard lives at
//     the STORE, and its comment says why in as many words: "any window, any
//     future button, any keyboard shortcut that ends up calling
//     TimelineStore.reInject must get the same answer without having to
//     remember to re-derive TimelinePage.vue's check".
//
// This card is precisely the "any window / any future button" that comment was
// written for. Calling the Rust command from here would mean re-deriving that
// guard (and getting a picture's caption typed into the user's document the day
// the copy drifted), and it would leave the timeline row's status authored by
// nobody — the main window's store would never see the verdict, so the row
// would keep saying what it said before an injection that really happened.
// That is R11 (a status word whose evidence does not support it).
//
// ⇒ The capsule ASKS. The main window's store — the one authority — acts and
// answers. The round trip is two frontend-only Tauri events (`UI_TIMELINE_REINJECT`
// / `UI_TIMELINE_REINJECT_DONE`, lib/bridge.ts), correlated by a nonce.
//
// ⚠️ Is the main window there to answer? Yes, structurally: its close handler is
// `api.prevent_close(); window.hide()` (src-tauri/src/lib.rs), so the WebView is
// hidden, never destroyed, and its listener outlives every close. That is a fact
// about somebody else's file, so it is NOT relied on — [[reinjectOutcome]] has a
// `timeout` arm, and a timeout is reported as its own sentence rather than as a
// failure to inject. If that ever changes, the button says "no answer", which is
// true, instead of silently doing nothing, which is the façade.

import type { HistoryStatus } from '@flowmic/protocol';

import type { RecentLine } from './recent-line';

/** Whether a row's re-inject control should appear at all.
 *
 *  TWO conditions, and each is somebody else's rule read literally:
 *
 *  ① the kind is one the store ACCEPTS — `transcript`, or (since 0.3.36)
 *     `image`, whose arm pastes the row's original picture rather than typing
 *     anything. Everything else would be answered `not-a-transcript`, so
 *     showing the button there would be offering an act that is defined to
 *     fail. 🔴 Still written as EQUALITIES on the kinds that work, never an
 *     inequality: REQ-12-13 already paid for that — an inequality on one known
 *     kind fails OPEN, and the day `entry_type` gained `'control'` the old
 *     guard let a remote-key row through.
 *
 *  ② the rendered text is non-empty — the same test `canCopyLine` applies, for
 *     the same reason: an un-captioned image row has nothing to act on, and a
 *     button that would type an empty string is a control that cannot do
 *     anything (R8). ⚠️ Note it is the STORE's `output_text` that actually gets
 *     typed, not this string; they are the same field off the same wire row, and
 *     this test is about whether to OFFER the act, not about what gets typed.
 *
 *  ⚠️ Deliberately NOT keyed on `status`. `lib/status.ts::canReinject` returns
 *  true for all four delivery states — a re-send of an already-injected line is
 *  a legitimate thing to ask for — so a status test would be a condition that is
 *  always true, and `status` may additionally be **null** here (the frame did not
 *  say). A gate whose answer never changes is not a gate; adding one would only
 *  create a second place to keep in sync with `canReinject`. */
export function canReinjectLine(l: Pick<RecentLine, 'entryType' | 'text' | 'fullImage'>): boolean {
  // ✅ 0.3.36 (owner 2026-08-26, 15-vol §2.5e-7 ① closed): an image row CAN
  // re-inject now — the store's image arm reads the ORIGINAL from disk and
  // pastes it through the same pipeline. The gate is `fullImage`, not the
  // thumbnail: the Rust side is original-only by design (a pasted preview
  // impersonating the picture is R11), so a row that kept no original would be
  // offered an act that is defined to fail — the same R8 rule as ② below.
  // Still a whitelist of kinds: anything that is neither gets no button.
  if (l.entryType === 'image') return l.fullImage === true;
  return l.entryType === 'transcript' && l.text.trim() !== '';
}

/** What the main window answered, as it travels back over the event. Mirrors
 *  `ReinjectVerdict` (lib/timeline-store.ts) plus the two things only this side
 *  can observe: nobody answered, and the request never left. */
export type ReinjectReply =
  | { ran: true; status: HistoryStatus }
  | { ran: false; reason: 'no-such-row' | 'not-a-transcript' | 'nothing-typed' };

/** The three faces the row's icon can wear after a click.
 *
 *  🔴 THREE, NOT TWO, and that is the whole point of this type. Copy is binary —
 *  the clipboard either holds the text or it does not. Injection is not: the
 *  pipeline can run to completion and still land the utterance nowhere
 *  (`cached` — no reachable target). Collapsing that into the same green check
 *  an `injected` gets would be this repo's headline defect on the status
 *  surface: 「没做成的事说成做成了」("saying a thing that did not happen
 *  happened"), and R11 exists to forbid exactly it.
 *
 *   · `ok`    — the pipeline ran AND the row now says `injected`.
 *   · `warn`  — the pipeline ran and the row says something else (`cached` /
 *               `failed` / `noted`). Something真的 happened; it was not an
 *               injection. The row's own status word is the honest caption.
 *   · `err`   — nothing was typed at all, and the sub-reason says which kind. */
export type ReinjectTone = 'ok' | 'warn' | 'err';

export interface ReinjectFeedback {
  tone: ReinjectTone;
  /** Icon name for `<Icon name=…>`: the outcome, never the verb. */
  icon: 'check' | 'alert' | 'x';
  /** Which status word to caption with, when there is one (`warn` and `ok`). */
  status: HistoryStatus | null;
  /** Which failure this was, when nothing was typed. */
  reason: 'no-such-row' | 'not-a-transcript' | 'nothing-typed' | 'timeout' | 'not-sent' | null;
}

/** Map one reply (or one of the two local failures) to what the row shows.
 *
 *  A pure function so the mapping is asserted directly, without a window, a
 *  store, or an event bus — and so the `cached ⇒ warn` rule above is pinned by a
 *  test rather than by this comment.
 *
 *  `null` means「没人回答」("nobody answered") and `'not-sent'` means「请求根本
 *  没发出去」("the request never left"). They are separate because they point at
 *  different things: the first says the main window did not reply, the second
 *  says we are not running under Tauri at all. */
export function reinjectFeedback(reply: ReinjectReply | null | 'not-sent'): ReinjectFeedback {
  if (reply === 'not-sent') return { tone: 'err', icon: 'x', status: null, reason: 'not-sent' };
  if (reply === null) return { tone: 'err', icon: 'x', status: null, reason: 'timeout' };
  if (!reply.ran) return { tone: 'err', icon: 'x', status: null, reason: reply.reason };
  return reply.status === 'injected'
    ? { tone: 'ok', icon: 'check', status: 'injected', reason: null }
    : { tone: 'warn', icon: 'alert', status: reply.status, reason: null };
}

/** Narrow whatever arrived on the reply event. An unrecognised shape becomes
 *  `null` — i.e. 「没人给出可读的回答」("nobody gave a readable answer"), which is
 *  what it is — rather than being coerced into a success or a specific failure. */
export function parseReinjectReply(p: unknown): ReinjectReply | null {
  if (p === null || typeof p !== 'object') return null;
  const o = p as { ran?: unknown; status?: unknown; reason?: unknown };
  if (o.ran === true) {
    return typeof o.status === 'string' &&
      (['injected', 'cached', 'failed', 'noted'] as const).includes(o.status as HistoryStatus)
      ? { ran: true, status: o.status as HistoryStatus }
      : null;
  }
  if (o.ran === false) {
    return typeof o.reason === 'string' &&
      (['no-such-row', 'not-a-transcript', 'nothing-typed'] as const).includes(
        o.reason as 'no-such-row',
      )
      ? { ran: false, reason: o.reason as 'no-such-row' }
      : null;
  }
  return null;
}
