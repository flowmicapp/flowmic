// The capsule strip's per-row RE-INJECT state and handler (owner 2026-08-24).
//
// Split out of CapsuleApp.vue, which was at the 800-line cap — and the split pays
// for itself: a composable can be DRIVEN by a test (click it, answer it, read the
// face it paints), where the copy button next door can only be asserted by reading
// the SFC as a string. Same direction as capsule-reinject.ts's pure half, one step
// further in.
//
// 🔴 The act is NOT performed here. The main window's store is the single author of
// both the injection and the row's status; this only asks and paints. The whole
// argument is in capsule-reinject.ts's header.

import { ref } from 'vue';

import { appendForensic } from '../lib/bridge';
import { requestRowReinject } from '../lib/bridge-reinject';
import { S } from '../lib/strings';
import {
  canReinjectLine,
  parseReinjectReply,
  reinjectFeedback,
  type ReinjectFeedback,
} from './capsule-reinject';
import type { RecentLine } from './recent-line';

/** How long an outcome face stays on the row before it reverts to the verb. */
export const REINJECT_FACE_MS = 2400;

export function useRowReinject(ask = requestRowReinject) {
  const injectStatus = ref<Record<string, ReinjectFeedback>>({});
  const injectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Rows with a request in flight — the button is disabled while one is, so a
   *  second click cannot start a second injection whose answer would arrive under
   *  a different nonce and overwrite the first row's face with the wrong one. */
  const injectBusy = ref<Set<string>>(new Set());

  function clearInjectStatus(id: string): void {
    if (!(id in injectStatus.value)) return;
    const next = { ...injectStatus.value };
    delete next[id];
    injectStatus.value = next;
  }

  /** The tooltip for a row's inject control: the verb before a click, and
   *  afterwards **the outcome in the row's own status word** — never the verb
   *  again. `S.st_*` are the same words the timeline uses for the same states
   *  (one status, one word, docs/rebuild/15 §2.5c). */
  function injectTitle(l: RecentLine): string {
    const f = injectStatus.value[l.id];
    if (!f) return S.op_reinject;
    if (f.status === 'injected') return S.st_injected;
    if (f.status === 'cached') return S.st_cached;
    if (f.status === 'failed') return S.st_failed;
    if (f.status === 'noted') return S.st_noted;
    // Nothing was typed at all. 🔴 `op_reinject_nothing` is NOT `st_failed`
    // (「未注入」): that is a VERDICT the pipeline reached about an utterance, this
    // says the pipeline never ran. One word on two different facts is the shape
    // this repo hunts. The remaining reasons (row gone, no answer, no Tauri) all
    // point at the same action — none — so they share one sentence, and the exact
    // cause is on the forensic record every time.
    return f.reason === 'nothing-typed' ? S.op_reinject_nothing : S.op_reinject_failed;
  }

  /** Click → ask the main window to run `TimelineStore.reInject` on THIS row's
   *  full address, and paint what it answers. `canReinjectLine` already gates the
   *  button out of the template; the guard here is the belt to those suspenders.
   *
   *  🔴 Every non-ok outcome is on the forensic record with its own words. A
   *  re-inject that quietly did nothing is precisely the thing this button must
   *  never be, and「点了没反应」("clicked, no reaction") is unanswerable after the
   *  fact without a line in the log. */
  async function reinjectLine(l: RecentLine): Promise<void> {
    if (!canReinjectLine(l) || injectBusy.value.has(l.id)) return;
    const prior = injectTimers.get(l.id);
    if (prior) clearTimeout(prior);
    injectBusy.value = new Set(injectBusy.value).add(l.id);
    clearInjectStatus(l.id);
    // A nonce per click, not per row: two clicks on one row must not be able to
    // resolve each other. Math.random is right here — this is a correlation tag
    // inside one process, not a secret.
    const nonce = `${l.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const raw = await ask(l.id, l.channel, nonce);
    const feedback = reinjectFeedback(raw === 'not-sent' ? 'not-sent' : parseReinjectReply(raw));
    if (feedback.tone !== 'ok') {
      appendForensic(
        'capsule',
        `re-inject row ${l.id} (${l.channel}) → tone=${feedback.tone} ` +
          `status=${feedback.status ?? '-'} reason=${feedback.reason ?? '-'}`,
      );
    }
    injectStatus.value = { ...injectStatus.value, [l.id]: feedback };
    const busy = new Set(injectBusy.value);
    busy.delete(l.id);
    injectBusy.value = busy;
    injectTimers.set(
      l.id,
      setTimeout(() => {
        injectTimers.delete(l.id);
        clearInjectStatus(l.id);
      }, REINJECT_FACE_MS),
    );
  }

  return { injectStatus, injectBusy, injectTitle, reinjectLine };
}
