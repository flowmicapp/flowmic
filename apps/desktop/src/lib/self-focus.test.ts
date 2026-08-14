// 🔴 owner 2026-08-02 (F1a): our own input boxes must be able to receive injection —— the WebView half.
//
// Everything here drives the PURE functions, so nothing depends on a browser. The
// DOM plumbing (`wireSelfFocusReporter`) is four `addEventListener` calls and one
// interval; what it has to be right about — WHEN a value is pushed — is the reporter
// below, which is why the policy was separated from the plumbing in the first place.

import { describe, expect, it } from 'vitest';
import {
  computeSelfFocusEditable,
  isTypeableElement,
  SelfFocusReporter,
  SELF_FOCUS_HEARTBEAT_MS,
  type FocusDocumentLike,
  type FocusElementLike,
} from './self-focus';

function doc(activeElement: FocusElementLike | null, hasFocus = true): FocusDocumentLike {
  return { hasFocus: () => hasFocus, activeElement };
}
const searchBox: FocusElementLike = { tagName: 'INPUT', type: 'search' };

describe('isTypeableElement — 「这个元素现在收得下打进去的字吗」', () => {
  it('accepts the controls a spoken sentence can actually land in', () => {
    // owner's own example is the timeline search box (<input type="search">).
    for (const el of [
      { tagName: 'INPUT', type: 'search' },
      { tagName: 'INPUT', type: 'text' },
      { tagName: 'INPUT' }, // absent type defaults to text (HTML)
      { tagName: 'input', type: '' },
      { tagName: 'TEXTAREA' },
      { tagName: 'DIV', isContentEditable: true },
    ]) {
      expect(isTypeableElement(el), JSON.stringify(el)).toBe(true);
    }
  });

  it('refuses controls that would swallow the characters', () => {
    // 🔴 The failure this prevents is not「少注了一句」("a sentence got under-injected") — it is claiming `injected`
    // for characters that went nowhere, i.e. no-silent-failure's second direction. A
    // checkbox or a button eats every keystroke and may ACT on some of them.
    for (const el of [
      null,
      undefined,
      {},
      { tagName: 'DIV' },
      { tagName: 'BUTTON' },
      { tagName: 'INPUT', type: 'checkbox' },
      { tagName: 'INPUT', type: 'radio' },
      { tagName: 'INPUT', type: 'button' },
      { tagName: 'INPUT', type: 'file' },
      { tagName: 'INPUT', type: 'range' },
      // disabled / readOnly LOOK focusable and accept nothing.
      { tagName: 'INPUT', type: 'text', disabled: true },
      { tagName: 'INPUT', type: 'text', readOnly: true },
      { tagName: 'TEXTAREA', readOnly: true },
      { tagName: 'TEXTAREA', disabled: true },
    ]) {
      expect(isTypeableElement(el as FocusElementLike), JSON.stringify(el)).toBe(false);
    }
  });
});

describe('computeSelfFocusEditable', () => {
  it('is true only when the document HAS focus and holds a typeable element', () => {
    expect(computeSelfFocusEditable(doc(searchBox, true))).toBe(true);
    expect(computeSelfFocusEditable(doc(null, true))).toBe(false);
  });

  it('🔴 a document without focus is never editable, however good its activeElement looks', () => {
    // `activeElement` keeps naming the last focused input after the window is
    // deactivated — that is what restores the caret on return. Reading it alone would
    // claim a typeable focus for a window nobody is typing into, and the Rust side
    // would then type a sentence into a background FlowMic.
    expect(computeSelfFocusEditable(doc(searchBox, false))).toBe(false);
  });
});

describe('SelfFocusReporter — when a value is pushed', () => {
  it('pushes the first sample, then only on a CHANGE', () => {
    const pushed: boolean[] = [];
    const r = new SelfFocusReporter((v) => pushed.push(v));
    r.sample(doc(searchBox));
    r.sample(doc(searchBox));
    r.sample(doc(searchBox));
    expect(pushed).toEqual([true]);
  });

  it('🔴 a focus that moves AWAY is pushed immediately — 「用户点走了就必须及时变」', () => {
    const pushed: boolean[] = [];
    const r = new SelfFocusReporter((v) => pushed.push(v));
    r.sample(doc(searchBox));
    r.sample(doc({ tagName: 'DIV' }));
    expect(pushed).toEqual([true, false]);
    // …and back again.
    r.sample(doc(searchBox));
    expect(pushed).toEqual([true, false, true]);
  });

  it('the heartbeat refreshes a live editable focus so a long utterance never expires', () => {
    // The Rust side stops believing a report after SELF_FOCUS_TTL (10s). Without this
    // beat, speaking for eleven seconds into FlowMic's own search box would come back
    // not injected · cached — correct-looking and wrong.
    const pushed: boolean[] = [];
    const r = new SelfFocusReporter((v) => pushed.push(v));
    r.sample(doc(searchBox));
    r.beat(doc(searchBox));
    r.beat(doc(searchBox));
    expect(pushed).toEqual([true, true, true]);
  });

  it('the heartbeat does NOT re-push a false — letting it expire lands on the same verdict', () => {
    const pushed: boolean[] = [];
    const r = new SelfFocusReporter((v) => pushed.push(v));
    r.sample(doc(null));
    r.beat(doc(null));
    r.beat(doc(null));
    expect(pushed).toEqual([false]);
  });

  it('a heartbeat that finds the answer CHANGED pushes the change, not a stale refresh', () => {
    const pushed: boolean[] = [];
    const r = new SelfFocusReporter((v) => pushed.push(v));
    r.sample(doc(searchBox));
    r.beat(doc(null));
    expect(pushed).toEqual([true, false]);
    expect(r.lastPushed()).toBe(false);
  });

  it('the beat interval leaves room for three misses inside the Rust TTL', () => {
    // The RATIO is the contract, not either number: 10s / 3s ⇒ a wedged renderer
    // expires in bounded time while a healthy one never does.
    expect(SELF_FOCUS_HEARTBEAT_MS * 3).toBeLessThan(10_000);
  });
});
