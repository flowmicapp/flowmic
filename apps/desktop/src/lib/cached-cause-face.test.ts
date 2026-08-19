// 🔴 docs/rebuild/15 §2.5e-4 —— `cached` now has **three causes**, and they must be displayable distinctly (必须能区分展示).
//
// THIS FILE IS THE ACCEPTANCE EVIDENCE, and it exists because the requirement is not
// "this line exists in the copy table" but "the user actually gets to see that
// sentence". Before 0.2.49 the answer was NO on
// both PC surfaces, and the two failures composed into a pointer to nowhere:
//   · the capsule's cached face rendered NO reason line at all (卡 L7 removed it when
//     cached had one cause), and its unmapped-code fallback reads "see the timeline for details" (详见时间线);
//   · the timeline rendered `statusLine(status, target)` only — one word for all three
//     causes, and nothing anywhere read `error`.
// ⇒ the capsule says "see the timeline for details", and the timeline says nothing.
// So the assertions below are about RENDERING:
// which template branch draws it, and what the branch resolves to in all four locales.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// The protocol's own derived view of "which codes are answered by the PC itself" — imported rather than
// re-listed, because a second list is what let four codes go unrouted in the first place.
import { PC_INJECTION_VERDICT_CODES } from '@flowmic/protocol';
import { cachedCauseTooltip, failedCauseInline } from './inject-provenance';
import { statusLine } from './status';
import { CACHED_CAUSE_CODES, INJECT_FAIL_REASON_CATALOGUES } from './strings/capsule';
import { UI_LOCALES, setLocale, type UiLocale } from './strings/locale';
import { INJECT_FAIL_REASON } from './strings';
import { normalizeCachedRow } from './timeline-normalize';

const SELF = 'INJECT_SELF_WINDOW_NO_INPUT';
const DEFERRED = 'INJECT_DEFERRED_NOT_AUTOINJECTED';
const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('three causes, three sentences, four languages', () => {
  it('every named cached cause has a sentence in ALL FOUR ui locales', () => {
    // ⚠️ protocol's ERROR_CODES only has zh_CN+en; the PC UI is four languages.
    // Filling in only two languages means ja/ko users get undefined, and the UI
    // falls back to silence — exactly the state this card exists to fix.
    for (const loc of UI_LOCALES as readonly UiLocale[]) {
      // `CACHED_CAUSE_CODES` is a `Set<string>` while the catalogue is now keyed by the
      // `PcInjectionCode` union (see lib/strings/capsule.ts), so the lookup is widened
      // HERE rather than the table being loosened — narrowing the table is the guard.
      const table = INJECT_FAIL_REASON_CATALOGUES[loc] as Record<string, string | undefined>;
      for (const code of CACHED_CAUSE_CODES) {
        const s = table[code];
        expect(typeof s === 'string' && s.trim().length > 0, `${loc}/${code}`).toBe(true);
      }
    }
  });

  it('the three causes never share a sentence — one status word may not answer three questions', () => {
    for (const loc of UI_LOCALES as readonly UiLocale[]) {
      const table = INJECT_FAIL_REASON_CATALOGUES[loc];
      const said = [table[SELF], table[DEFERRED], table.INJECT_FOCUS_LOST];
      expect(new Set(said).size, `${loc} — three causes collapsed into fewer sentences`).toBe(3);
    }
  });

  it('🔴 INJECT_FOCUS_LOST is deliberately NOT a named cause', () => {
    // 卡 L7's reasoning still holds for it: "not injected · cached" + "no input focus found" is
    // one sentence twice. Adding it back would restore the redundancy L7 removed.
    expect(CACHED_CAUSE_CODES.has('INJECT_FOCUS_LOST')).toBe(false);
    // 🔴 THIS LIST GREW, AND THE OLD ASSERTION HAD PINNED AN OMISSION AS A SPEC.
    // It read `toEqual([DEFERRED, SELF])` while the protocol had since registered
    // two more cached-mode codes (63/64, the macOS preflight pair). Nothing bound
    // the registry to this set, so the two arrived unrouted — and this assertion
    // then LOCKED THEIR ABSENCE IN as the expected result, exactly the 0.2.52 §3
    // shape: the reverse control picked the wrong direction, turning the defect into the acceptance criterion (反向对照选错了方向，把缺陷写成了验收标准).
    expect([...CACHED_CAUSE_CODES].sort()).toEqual([
      DEFERRED, 'INJECT_NO_ACCESSIBILITY', 'INJECT_SECURE_INPUT_ACTIVE', SELF,
    ].sort());
  });

  // 🔴 THE STRUCTURAL HALF — what actually stops the next code doing this again.
  // The four-sentence fix is worth less than this: the root cause was that nothing
  // bound `packages/protocol`'s code registry to this end's reason table, which is
  // the same gap CLAUDE.md records for the phone's table ("the next new code
  // will become a bare identifier on the user's screen the same way, while
  // every gate stays all-green" (下一个新码会以同样的方式变成用户屏幕上的裸标识符，而所有门禁全绿)).
  //
  // The primary guard is COMPILE-TIME (lib/strings/capsule.ts types the catalogue by
  // a `PcInjectionCode` union derived from INJECT_VERDICT_AUTHORSHIP, so a newly
  // registered code fails `vue-tsc` until it is routed). This test is the second
  // half, and it is not redundant: a type error names a type, while this names the
  // CODE and says what to do about it.
  it('🔴 every PC-authored inject code has a sentence on this end, in all four locales', () => {
    for (const loc of UI_LOCALES as readonly UiLocale[]) {
      const table = INJECT_FAIL_REASON_CATALOGUES[loc] as Record<string, string | undefined>;
      const missing = PC_INJECTION_VERDICT_CODES.filter(
        (c) => typeof table[c] !== 'string' || table[c]!.trim().length === 0,
      );
      expect(
        missing,
        `${loc}: these codes are registered in packages/protocol but have no PC-side `
        + `sentence, so the capsule falls back to "see the timeline for details" (or draws nothing) and `
        + `the timeline says nothing — a pointer to nowhere: ${missing.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('…and every sentence is reachable through the exported getters', () => {
    // anti-façade: the exported object is a hand-written getter list, so a catalogue
    // row without a getter is copy production can never render.
    for (const c of PC_INJECTION_VERDICT_CODES) {
      expect(typeof INJECT_FAIL_REASON[c], `no getter exposed for ${c}`).toBe('string');
    }
  });

  it('the zh-CN sentence for the self-window cause says owner\'s exact sentence (owner 的那句话)', () => {
    setLocale('zh-CN');
    expect(INJECT_FAIL_REASON[SELF]).toBe('焦点在 FlowMic 自己的窗口');
  });

  it('the sentence follows a language switch (getter, not a boot-time snapshot)', () => {
    setLocale('zh-CN');
    const zh = INJECT_FAIL_REASON[SELF];
    setLocale('ja');
    expect(INJECT_FAIL_REASON[SELF]).not.toBe(zh);
    setLocale('zh-CN');
  });
});

describe('Timeline: the cached row\'s hover tooltip really can answer "why"', () => {
  it('renders the cause for a cached row', () => {
    setLocale('zh-CN');
    expect(cachedCauseTooltip('cached', SELF, INJECT_FAIL_REASON)).toBe(
      '焦点在 FlowMic 自己的窗口',
    );
    expect(cachedCauseTooltip('cached', DEFERRED, INJECT_FAIL_REASON)).toBe(
      '自动补投的消息，刻意没有注入',
    );
  });

  it('says nothing extra where there is nothing extra to say', () => {
    setLocale('zh-CN');
    // Not cached → this question does not apply (the injected row's tooltip answers
    // "where did it get injected into" instead — a different function, one question each;
    // since 2026-08-19 the failed row's reason renders INLINE via failedCauseInline,
    // so the tooltip staying null for `failed` is division of surfaces, not silence).
    expect(cachedCauseTooltip('injected', SELF, INJECT_FAIL_REASON)).toBeNull();
    expect(cachedCauseTooltip('failed', SELF, INJECT_FAIL_REASON)).toBeNull();
    // No cause recorded (every row cached before 0.2.49), or an unmapped code — a raw
    // `INJECT_*` token on a tooltip is not an explanation.
    expect(cachedCauseTooltip('cached', null, INJECT_FAIL_REASON)).toBeNull();
    expect(cachedCauseTooltip('cached', '', INJECT_FAIL_REASON)).toBeNull();
    expect(cachedCauseTooltip('cached', 'INJECT_NEVER_HEARD_OF_IT', INJECT_FAIL_REASON)).toBeNull();
  });

  it('a row cached by an older build round-trips as "nothing more to say about the cause", never as a lie', () => {
    const row = normalizeCachedRow(
      { id: 'r1', mode: 'realtime', status: 'cached', output_text: 'x', created_at: '2026-08-02T00:00:00.000Z' },
      'lan',
    );
    expect(row?.cached_cause).toBeNull();
  });

  // 🔴 anti-façade ④ — the sentence "the timeline can answer it" must be greppable in the
  // TEMPLATE, not only in a pure function nobody wired. This is the assertion that
  // was FALSE before this card: the status chip's title came from
  // `injectProvenanceTooltip` alone, which returns null for every non-injected row.
  it('TimelinePage really binds the cause to the status chip', () => {
    const page = src('../main-window/TimelinePage.vue');
    expect(page).toContain('cachedCauseTooltip(e.status, e.cached_cause, INJECT_FAIL_REASON)');
    expect(page).toContain(':title="provenanceTip(e) ?? undefined"');
  });
});

// 🔴 2026-08-19 — the ✗ ROW names its reason inline (book 15 §2.5's `failed` row:
// 「✗ 未注入 · <具名原因>」, sentence from INJECT_FAIL_REASON, unmapped ⇒ bare fallback).
// Until this date the reason existed on the capsule's 1.5s flash and nowhere durable;
// the phone had named it since 0.2.53. Same one-definition table as the capsule and
// the cached tooltip (§2.5c) — these tests assert the RENDERED line, not a call.
describe('Timeline: the failed row names its reason INLINE (§C-2 reason slot)', () => {
  it('resolves a mapped code for a failed row, through the shared table', () => {
    setLocale('zh-CN');
    expect(failedCauseInline('failed', 'INJECT_SENDINPUT_FAIL', INJECT_FAIL_REASON)).toBe(
      '打字与粘贴都没成功',
    );
  });

  it('answers only the question it owns — cached/injected rows land on the other surfaces', () => {
    setLocale('zh-CN');
    // cached explains itself on the TOOLTIP (卡 L7); injected has a provenance tooltip.
    expect(failedCauseInline('cached', 'INJECT_SENDINPUT_FAIL', INJECT_FAIL_REASON)).toBeNull();
    expect(failedCauseInline('injected', 'INJECT_SENDINPUT_FAIL', INJECT_FAIL_REASON)).toBeNull();
    // Unmapped / absent code — a raw INJECT_* token is not an explanation (0.2.53).
    expect(failedCauseInline('failed', null, INJECT_FAIL_REASON)).toBeNull();
    expect(failedCauseInline('failed', '', INJECT_FAIL_REASON)).toBeNull();
    expect(failedCauseInline('failed', 'INJECT_NEVER_HEARD_OF_IT', INJECT_FAIL_REASON)).toBeNull();
  });

  it('statusLine composes 「✗ 未注入 · <具名原因> → target」 in §C-2 order', () => {
    setLocale('zh-CN');
    const reason = failedCauseInline('failed', 'INJECT_SENDINPUT_FAIL', INJECT_FAIL_REASON);
    expect(statusLine('failed', 'chrome', null, reason)).toBe('✗ 未注入 · 打字与粘贴都没成功 → chrome');
    // No reason ⇒ the spec's own stated fallback, byte-identical to before 2026-08-19.
    expect(statusLine('failed', 'chrome', null, null)).toBe('✗ 未注入 → chrome');
    // The slot belongs to `failed` alone — a reason passed with cached must not render
    // (its badge already says 「· 已缓存」; a second clause would be two explanations).
    expect(statusLine('cached', 'chrome', null, reason)).toBe('⏳ 未注入 · 已缓存 → chrome');
  });

  it('…and the sentence follows a language switch (the row stores the CODE)', () => {
    setLocale('en');
    expect(failedCauseInline('failed', 'INJECT_SENDINPUT_FAIL', INJECT_FAIL_REASON)).toBe(
      'Neither typing nor paste succeeded',
    );
    setLocale('zh-CN');
  });

  // Anti-façade ④ — the resolver must be WIRED in the template, or every test above
  // proves a function nobody calls (the exact state the ✗ row was in before this card).
  it('TimelinePage really passes the failed reason into statusLine', () => {
    const page = src('../main-window/TimelinePage.vue');
    expect(page).toContain(
      'statusLine(e.status, targetLabel(e), e.focus_evidence, failedCauseInline(e.status, e.cached_cause, INJECT_FAIL_REASON))',
    );
  });
});

describe('Capsule: the 📥 face can now answer "why"', () => {
  // 🔴 THE OTHER HALF OF THE POINTER. `capsule/controller.ts` used to say, in its own
  // words, `Reason line is for the ✗ face; the view omits it on 📥 not injected · cached`.
  it('CapsuleApp draws a line for a NAMED cached cause', () => {
    const vue = src('../capsule/CapsuleApp.vue');
    expect(vue).toContain('state.injectFailed?.cachedCause');
    // …and it is a branch of its own, not the ✗ reason line relabelled: that one is
    // still gated on `!cached`.
    expect(vue).toContain('v-if="!state.injectFailed?.cached && state.injectFailed?.reason"');
  });

  it('the controller fills it from the SHARED cause set + the SHARED sentence table', () => {
    const ctl = src('../capsule/controller.ts');
    expect(ctl).toContain('CACHED_CAUSE_CODES.has(code)');
    // 15 册 §2.5c: one definition, both PC surfaces. The timeline reads
    // INJECT_FAIL_REASON through TimelinePage; the capsule reads it here.
    expect(ctl).toContain('INJECT_FAIL_REASON[code]');
  });

  it('a cached verdict with NO named cause still draws nothing extra', () => {
    // INJECT_FOCUS_LOST keeps the L7 shape — this is the reverse control for the
    // template branch above (if `cachedCause` were just `reason`, this would break).
    expect(CACHED_CAUSE_CODES.has('INJECT_FOCUS_LOST')).toBe(false);
  });
});
