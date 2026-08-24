// The capsule ↔ main-window RE-INJECT round trip (0.3.30).
//
// Everything about WHY the capsule asks instead of acting is in
// capsule/capsule-reinject.ts's header. What lives here is only the transport.
//
// ── WHY THIS IS NOT IN lib/bridge.ts, AND WHAT THAT COSTS ────────────────
//
// That file is at **exactly 800 lines**, which is `verify/lint/file-size.mjs`'s
// cap for src — [measured: `git show HEAD:…/bridge.ts | wc -l` = 800]. It can
// take zero new lines, not even a one-line pointer to this file.
//
// ⚠️ THE COST IS REAL AND IS NOT HIDDEN HERE: somebody reading `bridge.ts` will
// not learn that this module exists. That is a discoverability debt, and the
// alternative was to split something ELSE out of a file this card does not
// otherwise touch — a bigger change, in the one module every window depends on,
// for a comment. Registered, not pretended away.
//
// 🔴 RV-97 (「一个有第二个入口的漏斗不是漏斗」— "a funnel with a second entry point
// is not a funnel") is NOT broken by this, and the difference matters. That rule's
// content is that PRODUCT code never touches `@tauri-apps/api` itself — the
// capsule's copy button's comment says so in as many words. This file is bridge
// code, not product code: it is where the Tauri call is allowed to be. [measured
// 2026-08-24: three other non-test files already import `@tauri-apps/api`
// directly — `bridge.ts`, `main-window/update-store.ts`,
// `main-window/components/WindowTitlebar.vue` — so the funnel has never been one
// FILE; it is one LAYER.]

import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { ChannelId } from './channel';

function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Frontend-only Tauri events (0.3.30), CAPSULE → MAIN and back: the capsule's
 *  per-row re-inject button asks the main window to run the act, and the main
 *  window answers.
 *
 *  🔴 WHY A ROUND TRIP AND NOT A DIRECT `invoke` FROM THE CAPSULE. The capsule
 *  copies to the clipboard directly (`capsule_copy_text`) because the clipboard
 *  has no other author. Injection has exactly one author on purpose:
 *  `TimelineStore.reInject` holds the transcript-only guard AT THE STORE — its
 *  own comment says the guard is there so that "any window, any future button…
 *  must get the same answer without having to remember to re-derive
 *  TimelinePage.vue's check" — and it is the only thing that puts the verdict
 *  onto the row. A second window invoking the Rust command would re-derive that
 *  guard and would leave the row's status authored by nobody, so an injection
 *  that really happened would leave the timeline saying it had not (R11).
 *
 *  🔴 WHY THERE ARE TWO EVENTS AND A NONCE. `emit` is fire-and-forget. A button
 *  whose entire outcome is "we emitted something" cannot report, and a control
 *  that cannot report is the façade shape (R8) this repo keeps finding. The
 *  nonce correlates the answer so two quick clicks on two rows cannot swap
 *  results — the failure that would otherwise be invisible, because both
 *  answers look plausible on the wrong row.
 *
 *  Deliberately NOT in `CH` — that mirrors bridge.rs and both ends of these are
 *  Vue, so a Rust constant would be a dead façade. Same `flowmic://` shape so
 *  the protocol-whitelist lint never mistakes them for wire events. Same
 *  treatment as UI_NAVIGATE / UI_PREFS_SYNC / UI_TIMELINE_ROW_GONE.
 *
 *  ⚠️ The payload carries `(id, channel)` — the row's FULL address. An id alone
 *  names two rows once both servers are in one list, and owner's 2026-07-31 iron
 *  rule forbids re-deriving the other half from "who is current now" at the
 *  moment of acting. */
export const UI_TIMELINE_REINJECT = 'flowmic://ui-timeline-reinject';
export const UI_TIMELINE_REINJECT_DONE = 'flowmic://ui-timeline-reinject-done';

/** Capsule side: ask, and wait for the answer that carries our nonce.
 *
 *  Returns the raw reply payload, or `'not-sent'` when there is no Tauri to emit
 *  through, or `null` when nobody answered within `timeoutMs`. Three outcomes
 *  and not two: "we could not ask" and "we asked and nobody answered" send the
 *  user to different places, so they never share a return value.
 *
 *  The listener is registered BEFORE the emit and torn down on every path —
 *  including the timeout — so a late answer cannot resolve a promise that has
 *  already settled, and no window accumulates listeners one click at a time. */
export async function requestRowReinject(
  id: string,
  channel: ChannelId,
  nonce: string,
  timeoutMs = 8000,
): Promise<unknown | null | 'not-sent'> {
  if (!hasTauri()) return 'not-sent';
  let unlisten: UnlistenFn | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const answered = new Promise<unknown | null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      void listen(UI_TIMELINE_REINJECT_DONE, (ev) => {
        const p = ev.payload as { nonce?: unknown; reply?: unknown } | null;
        // Somebody else's answer is not ours. Ignored rather than resolved:
        // resolving on the wrong nonce is how a verdict lands on the wrong row.
        if (p === null || typeof p !== 'object' || p.nonce !== nonce) return;
        resolve(p.reply ?? null);
      }).then((u) => {
        unlisten = u;
      });
    });
    await emit(UI_TIMELINE_REINJECT, { id, channel, nonce });
    return await answered;
  } catch (e) {
    console.warn('[flowmic] reinject request failed', e);
    return 'not-sent';
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (unlisten !== null) (unlisten as UnlistenFn)();
  }
}

/** Main-window side: listen for a capsule's request. The handler is given the
 *  row address and must return the verdict, which is emitted back with the same
 *  nonce. A handler that throws still answers — with nothing — because the
 *  alternative is a capsule button that spins until its timeout for a reason
 *  nobody will ever see. */
export async function serveRowReinject(
  run: (id: string, channel: ChannelId) => Promise<unknown>,
): Promise<UnlistenFn> {
  if (!hasTauri()) return () => {};
  return listen(UI_TIMELINE_REINJECT, (ev) => {
    const p = ev.payload as { id?: unknown; channel?: unknown; nonce?: unknown } | null;
    if (p === null || typeof p !== 'object') return;
    const id = typeof p.id === 'string' ? p.id : '';
    const nonce = typeof p.nonce === 'string' ? p.nonce : '';
    const channel = p.channel === 'lan' || p.channel === 'cloud' ? p.channel : null;
    if (id === '' || nonce === '' || channel === null) return;
    void run(id, channel)
      .then((reply) => emit(UI_TIMELINE_REINJECT_DONE, { nonce, reply }))
      .catch((e) => {
        console.warn('[flowmic] reinject serve failed', e);
        return emit(UI_TIMELINE_REINJECT_DONE, { nonce, reply: null });
      });
  });
}
