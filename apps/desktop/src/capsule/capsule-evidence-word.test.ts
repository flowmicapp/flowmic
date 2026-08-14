// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5c (PC-side same source / acceptance lands on the rendered result)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0 (two-segment terminology table)
//
// 🔴 IJ-02-a — 甲-3's ③evidence, MEASURED ON THE FACE THE USER ACTUALLY READS.
//
// What was untested before this file (book seven §2 IJ-02-a): `controller.ts` computes
// `confirmed: r.focus_evidence === 'editable'` and `CapsuleApp.vue` picks
// `S.cap_injected` / `S.cap_delivered` from that bit — and the ONLY assertion about
// any of it was a source grep in lib/inject-evidence-face.test.ts:
//
//     expect(ctl).toContain("confirmed: r.focus_evidence === 'editable'");
//
// That grep proves a line of code EXISTS. It cannot prove a user sees the right word,
// and it stays green through every way the chain below it could be broken: a template
// that inverts the ternary, a face that stops reading `confirmed`, a word catalogue
// that resolves both branches to the same string. book 15 §2.5c says the acceptance for
// "whether the user can actually read this sentence" lands on the RENDERED RESULT — so these cases drive the real
// `onInjectResult` and then render the real `CapsuleApp.vue`, and assert on the text
// inside the green card's own `<span class="oktxt">`.
//
// ── WHY THE RENDER, AND NOT `expect(state.injected.confirmed).toBe(false)` ──────────
// Asserting the boolean would be this window's own §1-bis-10 trap: a plausible stand-in
// for the thing being measured. `confirmed` is an INTERNAL bit; between it and the user
// sits the ternary in CapsuleApp.vue, which is the half that has never been exercised.
// A test that stops at the boolean goes green while the template says "injected" (已注入) for all four
// readings. (Reverse-controlled below — see the block at the bottom of this file.)
//
// ── 🔴 ABSENCE IS NOT `unknown`, AND THAT IS A CONTRACT ─────────────────────────────
// "never asked" (no `focus_evidence` key on the wire at all) and "asked but couldn't answer" (`'unknown'`)
// are two different facts; lib/timeline-normalize.ts passes `'unknown'` through EXACTLY
// and keeps an absent field absent, precisely so the durable surface can tell them apart.
// They happen to select the SAME capsule word today — the capsule asks one question
// ("which word") and both answers are "not confirmed". They are written as two separate
// cases anyway: if the two ever diverge, one of them goes red on its own instead of
// being carried silently by the other.

import { beforeEach, describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

import CapsuleApp from './CapsuleApp.vue';
import { onInjectResult, state } from './controller';
import { S } from '../lib/strings';

/** The green card's own text node — NOT the whole document. Asserting on the full
 *  html would let a match anywhere on the surface (a tooltip, the recent strip, a
 *  diagnostic row) stand in for the word on the card, which is the same substitution
 *  this file exists to reject. */
function okText(html: string): string {
  const m = /<span class="oktxt"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  if (!m) throw new Error(`green card 「oktxt」 span not rendered; html was:\n${html}`);
  // strip SSR fragment anchors (<!--[--> / <!--]-->) and tags, keep the words
  return m[1]!.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').trim();
}

async function renderGreenCard(): Promise<string> {
  // The morph phase is set by [[tick]], which also resizes the real capsule window
  // through the Tauri bridge. This test is about WHICH WORD the green card shows, not
  // about WHEN it shows, so the phase is set directly rather than running the render
  // loop. `onInjectResult` has already called `morph.onInjected`, so this is the phase
  // that loop would land on — not a face invented for the test.
  state.form = 'just_injected';
  return okText(await renderToString(createSSRApp(CapsuleApp)));
}

/** A delivered (ok:true) verdict. `focus_evidence` is supplied by each case — and the
 *  ABSENT case supplies no key at all, which is asserted rather than assumed below. */
function deliveredFrame(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    mode: 'sendinput',
    inject_target: { window_title: 'Notepad', process_name: 'notepad.exe' },
    ...extra,
  };
}

// 🔴 THE SAMPLE COUNTER (§1-bis-5: a direction with zero samples is UNMEASURED (未测量), not PASSED (通过)).
//
// ⚠️ It counts RUNTIME EXECUTIONS, deliberately not source-code occurrences. A block
// scanner that greps this file for the strings 'editable' / 'not_editable' / 'unknown'
// would find them in its OWN table and report ≥1 for every reading even after the cases
// were deleted — book seven §1-bis-10, seventh example (第七例), verbatim. A tally written by the assertions
// themselves cannot say 「measured」 about a case that did not run.
const samples = new Map<string, number>();
function recordSample(reading: string): void {
  samples.set(reading, (samples.get(reading) ?? 0) + 1);
}

const READINGS = ["'editable'", "'not_editable'", "'unknown'", 'ABSENT'] as const;

beforeEach(() => {
  state.target = '';
  state.locked = false;
  state.injected = null;
  state.injectFailed = null;
  state.finalText = 'hello';
  state.interim = '';
  state.recent = [];
  state.form = 'idle';
});

describe('IJ-02-a — the capsule green card splits on ③evidence, on the rendered face', () => {
  it("③evidence = 'editable' ⇒ the card says the STRONG word (\"injected\")", async () => {
    onInjectResult(deliveredFrame({ focus_evidence: 'editable' }));
    const text = await renderGreenCard();
    expect(text).toContain(S.cap_injected);
    expect(text).not.toContain(S.cap_delivered);
    recordSample("'editable'");
  });

  it("③evidence = 'not_editable' ⇒ the card says the WEAK word (\"delivered\")", async () => {
    onInjectResult(deliveredFrame({ focus_evidence: 'not_editable' }));
    const text = await renderGreenCard();
    expect(text).toContain(S.cap_delivered);
    expect(text).not.toContain(S.cap_injected);
    recordSample("'not_editable'");
  });

  it("③evidence = 'unknown' (we asked, the OS could not answer) ⇒ the WEAK word", async () => {
    onInjectResult(deliveredFrame({ focus_evidence: 'unknown' }));
    const text = await renderGreenCard();
    expect(text).toContain(S.cap_delivered);
    expect(text).not.toContain(S.cap_injected);
    recordSample("'unknown'");
  });

  it('③evidence ABSENT (we never asked) ⇒ the WEAK word — "never asked" may not license "injected"', async () => {
    const frame = deliveredFrame({});
    // Measure the ruler: the case is only about absence if the key is really absent.
    // Spelling `focus_evidence: undefined` would put the key ON the object and quietly
    // turn this into a fifth reading that no longer tests what the name says.
    expect(Object.prototype.hasOwnProperty.call(frame, 'focus_evidence')).toBe(false);
    onInjectResult(frame);
    const text = await renderGreenCard();
    expect(text).toContain(S.cap_delivered);
    expect(text).not.toContain(S.cap_injected);
    recordSample('ABSENT');
  });

  // 🔴 The two words must stay two words. If a future edit resolved both branches of
  // the ternary to the same string, every assertion above would still pass its
  // `toContain` and the `not.toContain` pair would be the only thing left standing —
  // this states the property directly so the failure names itself.
  it('the strong and the weak word are not the same string', () => {
    expect(S.cap_injected).not.toBe(S.cap_delivered);
  });

  it('all four readings of ③evidence were really exercised (no direction was skipped over)', () => {
    const report = READINGS.map((r) => `${r}=${samples.get(r) ?? 0}`).join(' ');
    for (const reading of READINGS) {
      expect(samples.get(reading) ?? 0, `${reading} has ZERO samples — UNMEASURED, not PASSED [${report}]`)
        .toBeGreaterThan(0);
    }
  });
});
