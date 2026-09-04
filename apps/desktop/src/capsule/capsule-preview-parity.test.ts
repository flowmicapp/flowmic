// What the CAPSULE actually renders while somebody is speaking.
//
// 🔴 WHY THIS FILE RENDERS THE SFC INSTEAD OF ASSERTING ON `state`. The
// deliverable is "the text on the PC capsule matches the phone, and its colour
// says which half is confirmed". A test that read `state.finalText` would have
// been green throughout the whole defect: the two flat strings were being set,
// they were just being set to the wrong thing and painted as one line. So the
// assertions land on the rendered markup (CapsuleApp.vue through
// vue/server-renderer, the same path prefs-appearance.test.ts uses) and on the
// stylesheet that colours it — the two artefacts a user's eyes actually meet.
//
// The frame sequence is the SHARED fixture, so a step whose expected `display`
// changes here changes on the phone too, or one of the two suites goes red:
// verify/fixtures/utterance-view-parity.json.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, beforeEach } from 'vitest';
import CapsuleApp from './CapsuleApp.vue';
import {
  fireRealAudioStartForTest,
  fireSttFinalForTest,
  fireSttInterimForTest,
  state,
} from './controller';

interface Step {
  frame: string;
  idx?: number;
  text?: string;
  is_segment?: boolean;
  committed: string;
  pending: string;
  display: string;
}
interface Scenario { name: string; mode: string; steps: Step[] }

const ROOT = resolve(__dirname, '../../../..');
const scenarios: Scenario[] = (
  JSON.parse(
    readFileSync(resolve(ROOT, 'verify/fixtures/utterance-view-parity.json'), 'utf8'),
  ) as { scenarios: Scenario[] }
).scenarios;
const CSS = readFileSync(resolve(__dirname, '../styles/capsule.css'), 'utf8');

function drive(scenario: Scenario, upTo: number): void {
  scenario.steps.slice(0, upTo + 1).forEach((step) => {
    if (step.frame === 'audio:start') fireRealAudioStartForTest({ mode: scenario.mode });
    else if (step.frame === 'stt:interim')
      fireSttInterimForTest({ segment_idx: step.idx, text: step.text });
    else
      fireSttFinalForTest({
        segment_idx: step.idx,
        text: step.text,
        is_segment: step.is_segment === true,
      });
  });
}

/** The `<div class="interim">…</div>` block, verbatim from the rendered page. */
function previewHtml(html: string): string {
  const m = /<div class="interim"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  expect(m, 'the speaking preview must be in the rendered markup').not.toBeNull();
  return m![1]!;
}

/** Undo SSR's HTML escaping so the assertion compares the characters the user
 *  reads, not the encoding the browser will decode for them. */
function decode(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

async function render(): Promise<string> {
  return renderToString(createSSRApp(CapsuleApp));
}

beforeEach(() => {
  state.form = 'speaking';
  state.visible = true;
});

describe('capsule preview — the whole utterance, split black/grey', () => {
  for (const s of scenarios) {
    it(`renders every fixture step of: ${s.name}`, async () => {
      for (let i = 0; i < s.steps.length; i++) {
        drive(s, i);
        state.form = 'speaking';
        const inner = previewHtml(await render());
        // ① the WHOLE display string is on screen, character for character —
        //    the phone's `display` at the same step, from the same file.
        expect(decode(inner.replace(/<[^>]+>/g, '')), `step ${i} display`).toBe(
          s.steps[i]!.display,
        );
        // ② the black run is exactly the committed half…
        const fin = /<span class="fin"[^>]*>([\s\S]*?)<\/span>/.exec(inner);
        expect(decode(fin ? fin[1]! : '').trimEnd(), `step ${i} committed`).toBe(
          s.steps[i]!.committed,
        );
        // ③ …and everything outside that span is the pending half.
        const outside = inner.replace(/<span class="fin"[^>]*>[\s\S]*?<\/span>/, '');
        expect(decode(outside.replace(/<[^>]+>/g, '')).replace(/^\n/, ''), `step ${i} pending`).toBe(
          s.steps[i]!.pending,
        );
      }
    });
  }

  it('a committed segment is NOT deleted when the next segment closes', async () => {
    // The reproduction of the reported defect, kept as a permanent guard: the
    // old handler did `state.finalText = text` on every final, so this second
    // final erased the first segment outright.
    fireRealAudioStartForTest({ mode: 'translate' });
    fireSttInterimForTest({ segment_idx: 0, text: '这个方案' });
    fireSttFinalForTest({ segment_idx: 0, text: '这个方案可以。', is_segment: true });
    fireSttFinalForTest({ segment_idx: 1, text: '我们下周开始。', is_segment: false });
    state.form = 'speaking';
    const inner = previewHtml(await render());
    expect(decode(inner.replace(/<[^>]+>/g, ''))).toBe('这个方案可以。\n我们下周开始。');
  });

  it('a final CLEARS the interim it superseded (no stale grey echo)', async () => {
    fireRealAudioStartForTest({ mode: 'translate' });
    fireSttInterimForTest({ segment_idx: 0, text: '嗯 我 我觉得这个方案可以' });
    fireSttFinalForTest({ segment_idx: 0, text: '我觉得这个方案可行。', is_segment: false });
    state.form = 'speaking';
    const inner = previewHtml(await render());
    expect(decode(inner.replace(/<[^>]+>/g, ''))).toBe('我觉得这个方案可行。');
  });
});

describe('capsule preview — the colour and overflow contract', () => {
  it('grey is the default and black is the .fin span', () => {
    expect(CSS).toMatch(/\.interim\s*\{[^}]*color:\s*var\(--t3\)/);
    expect(CSS).toMatch(/\.interim \.fin\s*\{[^}]*color:\s*var\(--t1\)/);
  });

  it('the joiner newline survives — the box is pre-wrap, not collapsed', () => {
    // Without this the capsule would run two sentences together while the phone
    // broke them, i.e. the two ends would stop being character-identical.
    expect(CSS).toMatch(/\.interim\s*\{[^}]*white-space:\s*pre-wrap/);
  });

  it('an overflowing utterance scrolls instead of truncating, and is pinned to the tail', () => {
    // "keep the newest words visible, elide the head, never drop committed text":
    // the box has a height cap AND scrolls, and CapsuleApp.vue drives it to the
    // bottom on every change of the rendered string.
    expect(CSS).toMatch(/\.interim\s*\{[^}]*max-height:/);
    expect(CSS).toMatch(/\.interim\s*\{[^}]*overflow-y:\s*auto/);
    const sfc = readFileSync(resolve(__dirname, 'CapsuleApp.vue'), 'utf8');
    expect(sfc).toContain('el.scrollTop = el.scrollHeight');
    expect(sfc).toMatch(/watch\(\s*\(\)\s*=>\s*`\$\{state\.finalText\}\$\{state\.interim\}`/);
    // And nothing may quietly cap the text: an ellipsis/line-clamp on this box
    // would drop characters the user is entitled to scroll back to.
    expect(CSS).not.toMatch(/\.interim\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(CSS).not.toMatch(/\.interim\s*\{[^}]*-webkit-line-clamp/);
  });
});
