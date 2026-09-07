// owner 2026-09-07 — the speaking row's live 「时长 · 数量」, and the requirement
// that came with it: 「那边多长时间，这边多长时间」.
//
// 🔴 WHAT THIS FILE IS ACTUALLY GUARDING. The easy version of these tests asserts
// that `speakingElapsedMs` does arithmetic, and it would stay green through every
// way this feature can really break — because the arithmetic is not the risky
// part. The risky parts are the three the repo has been burned by before:
//   ① the value is computed and then never reaches the screen (the 「能力定义了
//      没人调用」 shape) ⇒ there is a RENDER assertion here, driven through the
//      real component, not through a hand-built copy of its template;
//   ② a delivery with no clock prints a fabricated number (the E2 defect, which
//      shipped once as ≈1.7e9 seconds on the settled card) ⇒ the null case is
//      asserted on the RENDERED MARKUP, i.e. that nothing is drawn at all;
//   ③ the two ends drift apart on what the numbers MEAN ⇒ the count is asserted
//      to be the finalised-segment count arriving on `stt:final`, driven through
//      the real controller handlers, and the duration grammar is asserted to be
//      `formatRowDuration`, which is the phone's `formatEntryDuration` character
//      for character (apps/desktop/src/lib/entry-metrics.ts's own header).

import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CapsuleApp from './CapsuleApp.vue';
import { speakingElapsedMs } from './session-stats';
import {
  fireRealAudioStartForTest,
  fireSttFinalForTest,
  fireTickForTest,
  state,
} from './controller';
import { CAPSULE_MSG_CATALOGUES } from '../lib/strings/capsule';
import { UI_LOCALES, setLocale } from '../lib/strings/locale';

async function render(): Promise<string> {
  return renderToString(createSSRApp(CapsuleApp));
}

/** The ministat row's right-hand stat, as text, or null when it is not drawn. */
function statText(html: string): string | null {
  const row = /<div class="ministat"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/.exec(html);
  expect(row, 'the ministat row must be in the rendered markup').not.toBeNull();
  const m = /<span class="mstat-end"[^>]*>([\s\S]*?)<\/span>/.exec(row![1]!);
  if (m === null) return null;
  return m[1]!
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

beforeEach(() => {
  setLocale('en');
  state.form = 'speaking';
  state.visible = true;
});
afterEach(() => {
  setLocale('en');
  vi.useRealTimers();
});

describe('speakingElapsedMs — the clock behind the live duration', () => {
  it('measures from the audio:start that opened this speaking form', () => {
    expect(speakingElapsedMs({ hadAudio: true, startedAt: 1_000, now: 1_000 })).toBe(0);
    expect(speakingElapsedMs({ hadAudio: true, startedAt: 1_000, now: 162_000 })).toBe(161_000);
  });

  it('is null — never 0 — for a delivery that never ran onAudioStart', () => {
    // The E2 case: an image send / a manual-text inject. `startedAt` is then a
    // PRIOR utterance's value, or the initial 0 that once rendered as ~1.7e9 s.
    expect(speakingElapsedMs({ hadAudio: false, startedAt: 0, now: 1.7e12 })).toBeNull();
    expect(speakingElapsedMs({ hadAudio: false, startedAt: 1_000, now: 2_000 })).toBeNull();
  });

  it('clamps a backwards clock to 0 rather than reporting a negative duration', () => {
    expect(speakingElapsedMs({ hadAudio: true, startedAt: 5_000, now: 4_000 })).toBe(0);
  });
});

describe('the live pair on screen (rendered, not restated)', () => {
  it('draws duration · count at the right end of the ministat row', async () => {
    fireRealAudioStartForTest({ mode: 'realtime' });
    fireSttFinalForTest({ segment_idx: 0, text: 'one', is_segment: true });
    fireSttFinalForTest({ segment_idx: 1, text: 'two', is_segment: true });
    state.form = 'speaking';
    // Pin the clock rather than sleeping: tick() is what writes this field in
    // production and it is asserted separately below.
    state.speakElapsedMs = 161_000;

    expect(statText(await render())).toBe('2:41 · 2 parts');
  });

  it('singular and plural both read naturally', async () => {
    fireRealAudioStartForTest({ mode: 'realtime' });
    fireSttFinalForTest({ segment_idx: 0, text: 'one', is_segment: true });
    state.form = 'speaking';
    state.speakElapsedMs = 42_000;
    expect(statText(await render())).toBe('42s · 1 part');
  });

  it('sub-second uses the phone tenths grammar, not a bare 0', async () => {
    fireRealAudioStartForTest({ mode: 'realtime' });
    state.form = 'speaking';
    state.speakElapsedMs = 400;
    expect(statText(await render())).toBe('0.4s · 0 parts');
  });

  it('draws NOTHING when there is no clock — it must not print a zero', async () => {
    fireRealAudioStartForTest({ mode: 'realtime' });
    state.form = 'speaking';
    state.speakElapsedMs = null; // the E2 case reaching the view
    expect(statText(await render())).toBeNull();
  });
});

describe('the clock is LIVE - tick() is the production writer', () => {
  // THE TEST THIS FILE WAS MISSING. Every other assertion here reads a
  // `speakElapsedMs` that the test itself put there, so deleting tick()'s write
  // left all of them green (measured 2026-09-07) - the duration would have sat
  // frozen at 0 on screen for a whole recording with a fully green suite.
  it('advances on its own between ticks, with the test writing nothing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    fireRealAudioStartForTest({ mode: 'realtime' });
    expect(state.speakElapsedMs).toBe(0);

    vi.setSystemTime(new Date(1_002_000));
    fireTickForTest();
    expect(state.speakElapsedMs).toBe(2_000);

    vi.setSystemTime(new Date(1_004_500));
    fireTickForTest();
    expect(state.speakElapsedMs).toBe(4_500);
  });
});

describe('the count is the phone\u2019s count', () => {
  it('starts at 0 on audio:start and follows the finalised segments', () => {
    fireRealAudioStartForTest({ mode: 'realtime' });
    expect(state.segs).toBe(0);
    expect(state.speakElapsedMs).toBe(0); // the clock is armed by the same event

    fireSttFinalForTest({ segment_idx: 0, text: 'a', is_segment: true });
    fireSttFinalForTest({ segment_idx: 1, text: 'b', is_segment: true });
    fireSttFinalForTest({ segment_idx: 2, text: 'c', is_segment: true });
    expect(state.segs).toBe(3);
  });

  it('a NEW recording resets both halves — no carry-over from the last one', () => {
    fireRealAudioStartForTest({ mode: 'realtime' });
    fireSttFinalForTest({ segment_idx: 0, text: 'a', is_segment: true });
    fireSttFinalForTest({ segment_idx: 1, text: 'b', is_segment: true });
    expect(state.segs).toBe(2);

    state.speakElapsedMs = 999_000;
    fireRealAudioStartForTest({ mode: 'realtime' });
    expect(state.segs).toBe(0);
    expect(state.speakElapsedMs).toBe(0);
  });
});

describe('nine locales', () => {
  it('every locale composes both numbers, in its own word order', () => {
    for (const loc of UI_LOCALES) {
      const out = CAPSULE_MSG_CATALOGUES[loc].sessionMeta('2:41', 7);
      expect(out, loc).toContain('2:41');
      expect(out, loc).toContain('7');
      // 🔴 The separator is the same 「 · 」 the phone's own card uses
      // (i18n/mobile/*.json articleCardMeta) — one glyph, both ends.
      expect(out, loc).toContain('\u00b7');
      // No label-colon construct: this is a stat, not a form field.
      expect(out, loc).not.toContain(':\u0020');
    }
  });
});
