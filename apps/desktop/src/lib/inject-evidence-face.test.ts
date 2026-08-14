// SPEC-REF:
//   docs/decisions/2026-08-07-owner-inject-status-wording-evidence-and-window-title.md
//   docs/strategy/2026-08-07-inject-status-truth-and-evidence-design.md §4-1 / §4-1b / §4-5
//
// 🔴 IJ-01 / IJ-02 ACCEPTANCE — "injected" (已注入) splits by ③EVIDENCE, "injection failed" (注入失败) is gone, and
// the window title never reaches disk.
//
// ── WHY THE "unconfirmed" (未确认) BUCKET IS THE MOST IMPORTANT ASSERTION IN THIS FILE ──────────
// 甲-3 divides one word into three faces. If the split never fires, the product looks
// EXACTLY like the product where the split was implemented correctly and every bucket
// happens to be empty — and every test that only asserts "the strong word renders when
// evidence is editable" is green in both worlds. So the load-bearing test is the one
// that proves the WEAK word appears when it should, and separately that ABSENT evidence
// lands there too (design doc §5-1-2).
//
// ⚠️ This repo's own precedent (本仓成例) (0.2.4x, the English-punctuation branch):
// a branch had 11/11 green while its corpus held
// zero English questions — deleting the branch entirely would also have passed. Hence
// the per-value counts below are stated, and a value with no case is "unmeasured", never
// "passed".
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT ASSERT ──────────────────────────────────
// It does not mount the timeline. Every claim here is about a pure composition
// (lib/status.ts), a pure projection (lib/timeline-normalize.ts), the real store, or
// the SOURCE of the template — so nothing can pass vacuously because a row scrolled
// out of a lazy list.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { statusBadge, statusLine } from './status';
import { focusProvenanceOf, normalizeCachedRow } from './timeline-normalize';
import { TIMELINE_STRINGS } from './strings/timeline';
import { S_BY_LOCALE } from './strings';
import { CAPSULE_STRINGS, INJECT_FAIL_REASON_CATALOGUES } from './strings/capsule';
import { setLocale, UI_LOCALES, type UiLocale } from './strings/locale';
import { TimelineStore } from './timeline-store';
import { ROWS_KEY } from './timeline-hydration';
import type {
  FocusEvidence, InjectResult, ReportingKvStore, TimelineRow, TimelineTransport,
} from './types';
import { rowToEntry } from './portable/fpr';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

class MemStore implements ReportingKvStore {
  m = new Map<string, string>();
  get(k: string): string | null { return this.m.get(k) ?? null; }
  set(k: string, v: string): boolean { this.m.set(k, v); return true; }
}

/** The store's ONE native call, stubbed. Nothing here drives deferred redelivery (补投). */
const noTransport: TimelineTransport = {
  async reInjectLocally() { return null; },
  async rowImage() { return null; },
  dropRowImages() { /* nothing to drop in these fixtures */ },
};

/** A store holding exactly one row, addressed the way a verdict addresses it. */
function storeWithRow(): { store: TimelineStore; kv: MemStore } {
  const kv = new MemStore();
  const store = new TimelineStore(noTransport, kv, () => 1_000);
  store.onHistoryUpdated(
    {
      id: 'req:1',
      mode: 'realtime',
      status: 'cached',
      source_text: null,
      output_text: 'hello',
      created_at: '2026-08-07T00:00:00.000Z',
      updated_at: '2026-08-07T00:00:00.000Z',
    },
    'lan',
  );
  return { store, kv };
}

/** 🔴 THROWS rather than returning undefined. A fixture that silently produced no row
 *  would make every assertion below pass by never running — the vacuous-green shape. */
const row = (store: TimelineStore): TimelineRow => {
  const r = store.entries().find((x) => x.id === 'req:1');
  if (!r) throw new Error('fixture row missing — the assertions below would be vacuous');
  return r;
};

// ═════════════════════════════════════════════════════════════════════════════
// ① each of the three tiers appears on its own (§D-1, §D-2)
// ═════════════════════════════════════════════════════════════════════════════
describe('甲-3 — one verdict, three faces, and each one really appears', () => {
  it('editable → the STRONG word "injected" (已注入), with "confirmed input-capable" (已确认可输入)', () => {
    setLocale('zh-CN');
    expect(statusLine('injected', '微信', 'editable')).toBe('✓ 已注入 → 微信（已确认可输入）');
    expect(statusBadge('injected', 'editable').label).toBe('已注入');
  });

  // 🔴 THE ONE. Without it, "all three buckets empty" and "the implementation is correct" are the same screenshot.
  it('🔴 unknown → the WEAK word "delivered" (已送入), with "unconfirmed" (未确认) — the bucket owner will actually see', () => {
    setLocale('zh-CN');
    expect(statusLine('injected', '微信', 'unknown')).toBe('✓ 已送入 → 微信（未确认）');
    expect(statusBadge('injected', 'unknown').label).toBe('已送入');
    // …and it is a DIFFERENT sentence from the strong one. Asserting only "the weak
    // string renders" would still pass if both getters pointed at one word.
    expect(statusLine('injected', '微信', 'unknown')).not.toBe(
      statusLine('injected', '微信', 'editable'),
    );
  });

  it('🔴 ABSENT evidence lands on the WEAK word too — "we never asked" is not "confirmed"', () => {
    setLocale('zh-CN');
    // undefined = the probe never ran (deferred delivery / admission refusal / RV-83
    // replay). It is a DIFFERENT fact from 'unknown' (types.ts FocusEvidence) and they
    // deliberately share one rendering; what must never happen is either of them
    // reading as confirmation.
    expect(statusLine('injected', '微信', undefined)).toBe('✓ 已送入 → 微信（未确认）');
    expect(statusLine('injected', '微信', null)).toBe('✓ 已送入 → 微信（未确认）');
  });

  it('not_editable → the WEAK word as well', () => {
    setLocale('zh-CN');
    // ⚠️ Noted for the record (明账): this value cannot reach an `injected` row
    // through today's pipeline — a
    // provably non-input focus is REFUSED upstream (INJECT_NO_TEXT_TARGET ⇒ failed).
    // It is asserted anyway because the renderer must not have an unhandled third
    // branch the day IJ-05 wires MSAA and this value starts arriving.
    expect(statusLine('injected', '微信', 'not_editable')).toBe('✓ 已送入 → 微信（未确认）');
  });

  it('the split touches ONLY the word — glyph, colour and dot are identical', () => {
    // "delivered" (已送入) is not a worse OUTCOME, it is the same outcome with less
    // evidence. Recolouring it would be a second, unauthorised claim (design doc §4-1).
    const strong = statusBadge('injected', 'editable');
    const weak = statusBadge('injected', 'unknown');
    expect([weak.glyph, weak.cls, weak.dot]).toEqual([strong.glyph, strong.cls, strong.dot]);
  });

  it('🔴 evidence never rewrites the STATUS — the five-state red line is untouched', () => {
    setLocale('zh-CN');
    // design doc §4-1: "it must never happen that because evidence is unknown, ok
    // gets rewritten to false".
    // The observable form of that rule: the non-injected faces are byte-identical
    // whatever evidence says, and none of them is ever the ✗ face because of it.
    for (const ev of [undefined, 'editable', 'not_editable', 'unknown'] as const) {
      expect(statusLine('cached', null, ev), `cached/${ev}`).toBe('⏳ 未注入 · 已缓存');
      expect(statusLine('failed', null, ev), `failed/${ev}`).toBe('✗ 未注入');
      expect(statusLine('noted', null, ev), `noted/${ev}`).toBe('📥 仅记录');
    }
  });

  it('the evidence parenthetical rides `injected` ALONE', () => {
    setLocale('zh-CN');
    // "not injected (unconfirmed)" would invite "uncertain whether it went in or
    // not" — the one thing we DO know
    // about these rows. §C-2 excludes the parenthetical from cached explicitly.
    expect(statusLine('cached', 'chrome', 'unknown')).toBe('⏳ 未注入 · 已缓存 → chrome');
    expect(statusLine('failed', 'chrome', 'unknown')).toBe('✗ 未注入 → chrome');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ② owner deletes the word: not a single "failed" may remain in any language (§C-1; nine languages as of 2026-08-14)
// ═════════════════════════════════════════════════════════════════════════════
describe('owner 2026-08-07 — the word "failed" is gone from the INJECT surface, in every locale', () => {
  // design doc §6-2 ⑤ names translation as the likeliest place to leave it behind, so this
  // is asserted per locale in the locale's OWN script rather than once in Chinese.
  const BANNED: Record<UiLocale, readonly string[]> = {
    'zh-CN': ['失败', '错误'],
    en: ['fail', 'error'],
    ja: ['失敗', 'エラー'],
    ko: ['실패', '오류'],
    // 2026-08-14 — the same ruling, in the five languages added that day. Each
    // row is that language's OWN word for "failure", which is the whole point:
    // owner's ruling is about a word, and a word only exists per language. The
    // stems are cut short on purpose (`fehlgeschl`, `ошибк`) so an inflected
    // form cannot slip past the guard the way an exact match would.
    'zh-TW': ['失敗', '錯誤'],
    fr: ['échec', 'échoué', 'erreur'],
    es: ['fallo', 'fallido', 'error'],
    de: ['fehler', 'fehlgeschl'],
    ru: ['ошибк', 'сбой', 'не удалось'],
  };

  /** 🔴 THE COVERED SET IS WHAT A FORBIDDEN-WORD GUARD IS. This one used to cover
   *  FOUR strings — `st_failed`, `st_delivered`, `ev_confirmed`, `ev_unconfirmed` —
   *  while owner's ruling is about a WORD, not about four keys. So it stepped around
   *  `INJECT_FAIL_REASON`, the reason line that rides the SAME ✗ face, where en / ja /
   *  ko still read failed / 失敗 / 실패. Only zh had been fixed, and zh is the locale
   *  owner reads: the ruling LOOKED satisfied while its purpose was defeated in three
   *  languages out of four.
   *  ⇒ rule: a guard whose covered set is not the set it claims to protect is worse than
   *  no guard — it is also the reason nobody looks again.
   *
   *  WHAT IS IN, and how much of it is DERIVED rather than listed (a listed set rots;
   *  a derived one already covers the string somebody adds next week):
   *    · every `st_*` / `ev_*` in the timeline catalogue — derived by prefix;
   *    · `tl_fail_inject`, the make-up-delivery line on the same page;
   *    · the capsule's inject faces. Four of the six are REFERENCES to the timeline
   *      words and are still re-read here on purpose: "false shared-source" (假同源) — a literal pasted in
   *      that happens to be equal today — is the defect capsule.ts's own header
   *      records, and a value read is a value checked;
   *    · EVERY reason line for EVERY code, derived from the whole catalogue, which is
   *      the half that was missing.
   *
   *  WHAT IS OUT, and why that is a judgement and not an oversight: `cap_stt_*`
   *  ("STT engine · failed" (STT 引擎 · 失败) reports a real engine error and answers a different
   *  question), `op_copy_failed`, `tl_store_write_failed`, `pd_*_failed`. None of them
   *  names an inject result, and owner's reason for deleting the word was that an
   *  inject result is usually not an error at all (owner's exact words: often it's
   *  due to an external cause, 原话: 很多时候是外部原因). */
  const CAPSULE_INJECT_KEYS = [
    'cap_injected', 'cap_delivered', 'cap_delivering',
    'cap_cached', 'cap_inject_failed', 'cap_reason_unknown',
  ] as const;

  const injectSurface = (loc: UiLocale): readonly { key: string; text: string }[] => {
    const out: { key: string; text: string }[] = [];
    for (const [k, v] of Object.entries(TIMELINE_STRINGS[loc])) {
      if (/^(st_|ev_)/.test(k) || k === 'tl_fail_inject') out.push({ key: `S.${k}`, text: v });
    }
    for (const k of CAPSULE_INJECT_KEYS) {
      out.push({ key: `S.${k}`, text: CAPSULE_STRINGS[loc][k] });
    }
    for (const [code, text] of Object.entries(INJECT_FAIL_REASON_CATALOGUES[loc])) {
      out.push({ key: `INJECT_FAIL_REASON.${code}`, text });
    }
    return out;
  };

  it('no user-visible inject string says "failed", in any locale', () => {
    for (const loc of UI_LOCALES as readonly UiLocale[]) {
      const strings = injectSurface(loc);
      // 🔴 POSITIVE CONTROL on the SCOPE, not on the words (G13 rule ②). A guard that
      // inspects nothing is green, and that is the failure mode this rewrite exists
      // to close — so the count is asserted to be far above the four status words the
      // narrow version checked. A scope that quietly shrank back trips here.
      expect(strings.length, `${loc}: the covered inject surface is too small`).toBeGreaterThan(15);
      for (const { key, text } of strings) {
        for (const ban of BANNED[loc]) {
          expect(
            text.toLowerCase().includes(ban.toLowerCase()),
            `${loc} ${key}: 「${text}」 must not contain 「${ban}」 (owner: must not make the user think an error occurred)`,
          ).toBe(false);
        }
      }
    }
  });

  it('every locale composes a complete line — no `undefined` leaks on a switch', () => {
    // The parenthetical carries its own per-locale punctuation (zh/ja full-width and
    // no leading space, en/ko ASCII with one), so the composed line is pinned VERBATIM
    // rather than by a shape check — a dropped leading space is exactly the kind of
    // tidy-up that a `toContain` would wave through.
    //
    // 🔴 THE VERBATIM PINS COVER THE FOUR LANGUAGES THEY WERE WRITTEN FOR, and
    // that is deliberate rather than laziness (2026-08-14). A verbatim golden
    // for a language added later could only be produced BY RUNNING THE CODE and
    // pasting what came out — an assertion that the composer does whatever it
    // currently does, which is not a test. So the five newer languages get the
    // property this test actually guards, asserted structurally: the line is
    // composed out of THAT LOCALE's own three pieces, in order, with nothing
    // missing. `Partial` is the honest annotation for that split.
    const expected: Partial<Record<UiLocale, string>> = {
      'zh-CN': '✓ 已送入 → chrome（未确认）',
      en: '✓ Input sent → chrome (unconfirmed)',
      ja: '✓ 入力済み → chrome（未確認）',
      ko: '✓ 입력됨 → chrome (미확인)',
    };
    for (const loc of UI_LOCALES as readonly UiLocale[]) {
      setLocale(loc);
      const line = statusLine('injected', 'chrome', 'unknown');
      const pin = expected[loc];
      if (pin !== undefined) {
        expect(line, loc).toBe(pin);
      } else {
        const cat = S_BY_LOCALE[loc];
        expect(line, `${loc}: composed from this locale's own pieces`).toBe(
          `✓ ${cat.st_delivered} → chrome${cat.ev_unconfirmed}`,
        );
      }
      expect(line, loc).not.toMatch(/undefined/);
    }
    setLocale('zh-CN');
  });

  it('the "injected / delivered" (已注入 / 已送入) pair is two words in every locale, never one', () => {
    for (const loc of UI_LOCALES as readonly UiLocale[]) {
      expect(TIMELINE_STRINGS[loc].st_delivered, loc).not.toBe(TIMELINE_STRINGS[loc].st_injected);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ③ persisted to storage: the process name gets in, the window title does not (§B, owner ruling (c))
// ═════════════════════════════════════════════════════════════════════════════
describe('owner ruling (c) — the row keeps the PROCESS, never the TITLE', () => {
  const verdict = (over: Partial<InjectResult> = {}): InjectResult => ({
    ok: false,
    mode: 'cached',
    error: 'INJECT_SELF_WINDOW_NO_INPUT',
    row_id: 'req:1',
    channel: 'lan',
    focus_window: { window_title: '张三的病历 - 医院系统', process_name: 'chrome.exe' },
    focus_evidence: 'unknown',
    ...over,
  });

  it('🔴 a NOT-injected verdict now records where it was aimed — the gate is open', () => {
    const { store } = storeWithRow();
    store.onInjectResult(verdict());
    expect(row(store).focus_process).toBe('chrome.exe');
    expect(row(store).focus_evidence).toBe('unknown');
  });

  it('🔴 the window title reaches NEITHER the row NOR the persisted bytes', () => {
    const { store, kv } = storeWithRow();
    store.onInjectResult(verdict());
    const r = row(store);
    // The row object first…
    expect(JSON.stringify(r)).not.toContain('张三的病历');
    // …and then EVERY BYTE THAT ACTUALLY HIT STORAGE. `onInjectResult` calls persist(),
    // so a title that is merely not on the row's declared type could still be on disk;
    // asserting the object alone would be checking the wrong artefact.
    const dumped = [...kv.m.values()].join('\n');
    expect(dumped, 'no persisted key held the title').not.toContain('张三的病历');
    // 🔴 POSITIVE CONTROL (G13 rule ②): a negative assertion needs proof the probe can
    // see anything at all — otherwise "zero" might mean the dump was empty, not that
    // the title was absent.
    expect(dumped, 'the persisted snapshot is non-empty and holds the process').toContain('chrome.exe');
    expect(kv.m.get(ROWS_KEY) ?? '', 'the rows key itself is populated').toContain('req:1');
  });

  it('the projection drops the title and keeps the process — one implementation', () => {
    expect(focusProvenanceOf({
      focus_window: { window_title: 'secret', process_name: 'chrome.exe' },
      focus_evidence: 'editable',
    })).toEqual({ focus_process: 'chrome.exe', focus_evidence: 'editable' });
  });

  it('an ABSENT key omits rather than erases — a later verdict cannot un-observe', () => {
    // Object.assign of a partial: "not observed this time" must never overwrite
    // "what was seen last time was chrome". An admission refusal / RV-83 replay carries neither key (§A-1).
    expect(focusProvenanceOf({})).toEqual({});
    const { store } = storeWithRow();
    store.onInjectResult(verdict());
    store.onInjectResult(verdict({ focus_window: undefined, focus_evidence: undefined }));
    expect(row(store).focus_process).toBe('chrome.exe');
    expect(row(store).focus_evidence).toBe('unknown');
  });

  it('an empty process name is not written — an arrow pointing at nothing', () => {
    expect(focusProvenanceOf({ focus_window: { window_title: 't', process_name: '   ' } })).toEqual({});
  });

  it('the success path is byte-for-byte what it was — this card did not reopen it', () => {
    const { store } = storeWithRow();
    store.onInjectResult({
      ok: true,
      mode: 'sendinput',
      row_id: 'req:1',
      channel: 'lan',
      inject_target: { window_title: '未命名 - 记事本', process_name: 'notepad.exe', injected_at: '2026-08-07T00:00:01.000Z' },
    });
    // `inject_target.window_title` on an ok:true row has ALWAYS been persisted (book 04
    // §3.5). owner ruling (c) governs the newly-widened failure path only, and a card
    // that quietly tightened this would be answering a question nobody asked.
    expect(row(store).target?.window_title).toBe('未命名 - 记事本');
  });

  it('a row written by an older build reads as "never probed", never as "already asked"', () => {
    const r = normalizeCachedRow(
      { id: 'r1', mode: 'realtime', status: 'cached', output_text: 'x', created_at: '2026-08-07T00:00:00.000Z' },
      'lan',
    );
    expect(r?.focus_process).toBeNull();
    // 🔴 null, NOT 'unknown'. 'unknown' claims we asked and could not tell; this row
    // predates the probe entirely (types.ts FocusEvidence).
    expect(r?.focus_evidence).toBeNull();
  });

  it('a junk / future evidence value degrades to "never probed"', () => {
    const r = normalizeCachedRow(
      {
        id: 'r1', mode: 'realtime', status: 'cached', output_text: 'x',
        created_at: '2026-08-07T00:00:00.000Z',
        focus_evidence: 'probably_editable_lol', focus_process: '',
      },
      'lan',
    );
    expect(r?.focus_evidence).toBeNull();
    expect(r?.focus_process).toBeNull();
  });

  it('🔴 a title smuggled into a persisted row is NOT read back', () => {
    // The narrowing is the enforcement point, not the comment beside it: a build that
    // wrote `focus_window_title` (or any title-shaped key) gets nothing back.
    const r = normalizeCachedRow(
      {
        id: 'r1', mode: 'realtime', status: 'cached', output_text: 'x',
        created_at: '2026-08-07T00:00:00.000Z',
        focus_process: 'chrome.exe', focus_window: { window_title: 'secret', process_name: 'chrome.exe' },
      },
      'lan',
    );
    expect(r?.focus_process).toBe('chrome.exe');
    expect(JSON.stringify(r)).not.toContain('secret');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ④ export: explicit answers, no default inheritance allowed (§B / design doc §4-5 implementation boundary 3)
// ═════════════════════════════════════════════════════════════════════════════
describe('book 16 FPR v1 — the two new fields are IN the export, and the title is not', () => {
  const base = (over: Partial<TimelineRow> = {}): TimelineRow => ({
    id: 'req:1', mode: 'realtime', status: 'cached', edited: false,
    source_text: null, output_text: 'x',
    created_at: '2026-08-07T00:00:00.000Z', updated_at: '2026-08-07T00:00:00.000Z',
    entry_type: 'transcript', control_kind: null, control_outcome: null,
    thumb_b64: null, full_image: false, target: null,
    mobile_id: null, device_label: null, channel: 'lan', ...over,
  });

  it('focus_process / focus_evidence are written into source_ext', () => {
    const e = rowToEntry(base({ focus_process: 'chrome.exe', focus_evidence: 'unknown' }), null, null);
    expect(e.source_ext.focus_process).toBe('chrome.exe');
    expect(e.source_ext.focus_evidence).toBe('unknown');
  });

  it('…as explicit null when the row has none — "this key exists, and this row just doesn\'t have it"', () => {
    const e = rowToEntry(base(), null, null);
    expect('focus_process' in e.source_ext).toBe(true);
    expect(e.source_ext.focus_process).toBeNull();
    expect(e.source_ext.focus_evidence).toBeNull();
  });

  it('a round trip does not destroy what an imported file carried (§5.4)', () => {
    // import.ts cannot put these back on a row (they are written only by
    // onInjectResult), so without the `carried` term a re-export would silently drop a
    // fact the file really recorded — the same trap `inject_target` documented.
    const e = rowToEntry(base(), null, {
      top: {},
      ext: { focus_process: 'cursor.exe', focus_evidence: 'editable' },
    });
    expect(e.source_ext.focus_process).toBe('cursor.exe');
    expect(e.source_ext.focus_evidence).toBe('editable');
  });

  it('🔴 no window title VALUE rides along on a failure/cached row — end to end', () => {
    // Driven through the real store rather than a hand-built row, because the question
    // is whether a title that WAS on the wire can reach a file. A hand-built row could
    // not have carried one in the first place, so it would prove nothing.
    //
    // ⚠️ Measure your ruler first (先核你的尺子): asserting `not.toContain('window_title')` on the serialized entry
    // is WRONG and was my first attempt — §4.2 requires the top-level `window_title`
    // KEY to be present on every line as a declaration slot, so that assertion fails on
    // a correct implementation. What must be absent is the TITLE, not the key name.
    const { store } = storeWithRow();
    store.onInjectResult({
      ok: false, mode: 'cached', error: 'INJECT_SELF_WINDOW_NO_INPUT',
      row_id: 'req:1', channel: 'lan',
      focus_window: { window_title: '张三的病历 - 医院系统', process_name: 'chrome.exe' },
      focus_evidence: 'unknown',
    });
    const e = rowToEntry(row(store), null, null);
    const line = JSON.stringify(e);
    expect(line, 'the title must not reach the file').not.toContain('张三的病历');
    // Positive control: the same line DOES carry the process, so the assertion above
    // is reading a populated record.
    expect(line).toContain('chrome.exe');
    // The §4.2 declaration slot itself is untouched: key always present, value null.
    expect(e.window_title).toBeNull();
  });

  it('a SUCCESSFUL row still exports its window title — the asymmetry is the ruling', () => {
    const e = rowToEntry(
      base({ status: 'injected', target: { window_title: '未命名 - 记事本', process_name: 'notepad.exe' } }),
      null,
      null,
    );
    expect(e.source_ext.inject_target).toEqual({ window_title: '未命名 - 记事本', process_name: 'notepad.exe' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ⑤ anti-façade — production really reads it (book 13 §7 F1 ①③)
// ═════════════════════════════════════════════════════════════════════════════
describe('anti-façade — the new fields have production readers, not just definitions', () => {
  it('TimelinePage passes ③evidence into the ONE composition', () => {
    const page = src('../main-window/TimelinePage.vue');
    expect(page).toContain('statusLine(e.status, targetLabel(e), e.focus_evidence)');
    // …and the arrow can now name a window on a NOT-injected row, which is the whole
    // of owner's addendum ① ("which window it was injected into", 注到哪个窗口). Before this card `targetLabel` could only ever
    // answer for `injected`, because nothing else had a target to name.
    expect(page).toContain('e.focus_process');
  });

  it('the capsule splits the same verdict the same way (book 15 §2.5c)', () => {
    const vue = src('../capsule/CapsuleApp.vue');
    const ctl = src('../capsule/controller.ts');
    // One event, one word, on both PC surfaces. If the capsule kept saying "injected" (已注入)
    // while the timeline said "delivered" (已送入), this card would have SHIPPED the drift it exists
    // to remove — that is the 0.2.1 defect this repo already paid for once.
    expect(vue).toContain("state.injected?.confirmed ? S.cap_injected : S.cap_delivered");
    expect(ctl).toContain("confirmed: r.focus_evidence === 'editable'");
    // The failure card's target slot — a `v-if` that was permanently false until
    // `focus_window` gave it something to show (design doc §1.4 lists it as a gap).
    expect(vue).toContain('v-if="state.injectFailed?.target"');
    expect(ctl).toContain('resultTarget || focusTarget');
  });

  it('the store writes provenance ABOVE the ok/!ok split, not inside it', () => {
    const store = src('./timeline-store.ts');
    const write = store.indexOf('Object.assign(r, focusProvenanceOf(result))');
    expect(write, 'the provenance write exists').toBeGreaterThan(0);
    // 🔴 THE GATE THIS CARD OPENED, pinned as an ORDER rather than a presence. A
    // future edit that moves the line back inside the `ok` arm would keep every value
    // assertion in this file green (the ok path still writes it) and silently restore
    // "only a successful row can say which window it was aimed at" (只有成功的行说得出对着哪个窗口) — the defect itself.
    expect(store.indexOf('if (result.ok) {', write), 'the ok/!ok branch comes AFTER it')
      .toBeGreaterThan(write);
  });

  it('🔴 …and the not-injected path really records it end to end', () => {
    // The source scan above pins the shape; this pins the BEHAVIOUR through the real
    // store. Both are needed: neither one alone would have caught the original defect.
    const { store } = storeWithRow();
    store.onInjectResult({
      ok: false, mode: 'cached', error: 'INJECT_SELF_WINDOW_NO_INPUT',
      row_id: 'req:1', channel: 'lan',
      focus_window: { window_title: 'x', process_name: 'cursor.exe' },
      focus_evidence: 'unknown',
    });
    const r = row(store);
    expect(r.status).toBe('cached');
    expect(r.focus_process).toBe('cursor.exe');
    setLocale('zh-CN');
    expect(statusLine(r.status, r.focus_process, r.focus_evidence))
      .toBe('⏳ 未注入 · 已缓存 → cursor.exe');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ⑥ per-tier sample counts — zero samples must be reported as "unmeasured", never as "passed"
// ═════════════════════════════════════════════════════════════════════════════
//
// 🔴 THE COUNT IS MEASURED FROM THIS FILE, NOT WRITTEN DOWN BESIDE IT.
//
// ⚠️ Measure your ruler first (先核你的尺子) — this instrument has been wrong TWICE, and the second time it was
// wrong in the one direction that makes an instrument useless:
//   ① the counts were written by hand first (editable 4 / not_editable 1 / unknown 9)
//      and were wrong in all three positions — a hand-maintained tally beside the
//      thing it counts starts slightly false and rots from there while READING as
//      measured;
//   ② the machine version that replaced them COUNTED ITSELF. Its own `it()` block was
//      one of the blocks it scanned, and that block spells all three literals inside
//      its own `casesUsing("'editable'")` calls ⇒ every value scored ≥ 1 whatever the
//      file contained. Deleting every real case for a value still reported "covered".
//      That is the vacuous green this describe exists to prevent, rebuilt inside the
//      guard against it. It also counted MENTIONS IN COMMENTS, and two of those
//      comments argue the OPPOSITE point ("It is a DIFFERENT fact from 'unknown'" in
//      §① and "null, NOT 'unknown'" in §③) — a value's own denial scored as a test
//      of that value.
// ⇒ three corrections, in this order: cut each block at its own closing `});` (a
//   block used to swallow the describe-level fixture that follows it, e.g. §③'s
//   `verdict()`), strip comments, and exclude the blocks of THIS describe BY TITLE.
//
// 🔴 WHY BY TITLE AND NOT BY INDEX. Both can stop matching; only one can do it
// quietly. An index silently slides onto a DIFFERENT, real block the moment a case is
// inserted above — and excluding a real block just lowers a number, which looks like
// a normal edit. A title that is renamed excludes nothing, and the
// `EXCLUDED_SELF_BLOCKS` assertion below turns that into an immediate red naming the
// missing title. The rule this file already teaches applies to its own instrument:
// "a negative assertion must bring its own positive control" (负向断言必须自带正向对照).
//
// 🔴 WHAT IT COUNTS, EXACTLY — and it is NOT "tests of this value", which is why it
// is no longer named that. It counts `it()` BLOCKS WHOSE CODE CONTAINS THE LITERAL.
// That over-counts on one side (a literal can sit in an assertion ABOUT a value
// without driving it) and under-counts on the other (a fixture that simply OMITS
// `focus_evidence` exercises ABSENCE while spelling nothing at all — §③/§④ are full
// of those). The one thing it may be trusted for is the ZERO: a value whose literal
// appears in no block's code is certainly not exercised here, and then the honest
// report is "unmeasured", never "passed" (design doc §5-1-2, §1-bis-5). The repo has paid for
// that distinction once: an English-punctuation branch was 11/11 green over a corpus
// with zero English questions, so deleting the branch outright would have passed too.
//
// ⚠️ NO PER-VALUE NUMBER IS WRITTEN DOWN HERE ON PURPOSE (CLAUDE.md "if a number can
// be removed, remove it", 能去掉数字就去掉). Every run prints the live figures; a copy in this comment would be a
// second answer to the same question, with a shelf life measured in commits.

/** One `it(` in this file: its title, and its own body with comments removed. */
interface CountedBlock { title: string; code: string }

/** Comments out, so a MENTION of a value can never be scored as an exercise of it.
 *  The `[^:]` guard keeps a `https://` inside a string from being read as a comment
 *  start; this file contains no other `//` inside a literal. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const COUNTED_BLOCKS: readonly CountedBlock[] = src('./inject-evidence-face.test.ts')
  .split(/\n {2}it\(/)
  .slice(1)
  .map((raw) => {
    // A block ends at ITS OWN closing `\n  });`. Without the cut it runs on into the
    // describe-level code that follows and is credited with literals it never runs.
    const end = raw.indexOf('\n  });');
    const body = end >= 0 ? raw.slice(0, end) : raw;
    // The title is excluded from `code` too: what a test is CALLED is not what it
    // does, and one title here literally contains the word `undefined`.
    const m = /^\s*(['"`])([\s\S]*?)\1/.exec(body);
    return {
      title: m ? m[2]! : '',
      code: stripComments(m ? body.slice(m[0].length) : body),
    };
  });

/** 🔴 The two blocks of §⑥ itself. They are not tests OF an evidence value; they are
 *  the instrument, and the literals in them are its dial markings. */
const SELF_TITLES = [
  'every one of the three evidence values is exercised, and none is at zero',
  'ABSENCE — the fourth state — is exercised too',
] as const;

const MEASURED_BLOCKS = COUNTED_BLOCKS.filter((b) => !SELF_TITLES.includes(b.title as never));
const EXCLUDED_SELF_BLOCKS = COUNTED_BLOCKS.length - MEASURED_BLOCKS.length;

const blocksWhoseCodeMatches = (re: RegExp): number =>
  MEASURED_BLOCKS.filter((b) => re.test(b.code)).length;

/** A real `undefined` VALUE, not the word inside a regex literal: §② asserts
 *  `not.toMatch(/undefined/)`, which is the OPPOSITE of exercising absence — it
 *  demands the rendered line never contains that word. Counting it would have been
 *  the same mistake as counting a comment. */
const ABSENT_VALUE = /(?<![\w/])undefined(?![\w/])/;

describe('per-evidence-value occurrence count — measured from this file, never assumed', () => {
  it('every one of the three evidence values is exercised, and none is at zero', () => {
    // `satisfies Record<FocusEvidence, …>` so a fourth value added upstream cannot
    // slip past this guard uncounted — it would fail to compile here first.
    const PATTERNS = {
      editable: /'editable'/,
      not_editable: /'not_editable'/,
      unknown: /'unknown'/,
    } satisfies Record<FocusEvidence, RegExp>;

    const counted = Object.fromEntries(
      Object.entries(PATTERNS).map(([value, re]) => [value, blocksWhoseCodeMatches(re)]),
    ) as Record<FocusEvidence, number>;

    // Re-emitted every run. This line, not any sentence in this repo, is the source
    // of the per-value figures. (`console.log` in a test has precedent here:
    // portable/export.test.ts prints its `[perf]` measurement the same way.)
    console.log(
      `[evidence-coverage] blocks=${COUNTED_BLOCKS.length} measured=${MEASURED_BLOCKS.length} `
      + `${Object.entries(counted).map(([k, v]) => `${k}=${v}`).join(' ')} `
      + `absence=${blocksWhoseCodeMatches(ABSENT_VALUE)}`,
    );

    for (const [value, n] of Object.entries(counted)) {
      expect(n, `${value} has ZERO cases ⇒ report it as unmeasured, never as passed`).toBeGreaterThan(0);
    }

    // ── POSITIVE CONTROLS on the instrument itself (G13 rule ②) ──────────────────
    // If the splitter stopped matching, every count would be 0 — the loop above would
    // fail loudly rather than silently. This pins the denominator as well.
    expect(COUNTED_BLOCKS.length, 'the block splitter still finds cases').toBeGreaterThan(20);
    // 🔴 And if a SELF_TITLES entry is renamed, the exclusion silently stops working
    // and the self-counting defect comes straight back. This is the assertion that
    // will not let that happen quietly.
    expect(EXCLUDED_SELF_BLOCKS, `SELF_TITLES no longer matches this file's own blocks: ${SELF_TITLES.join(' / ')}`)
      .toBe(SELF_TITLES.length);
  });

  it('ABSENCE — the fourth state — is exercised too', () => {
    // Not a FocusEvidence value, and that is exactly why it needs its own line:
    // "we never asked" is a distinct fact from "asked but couldn't answer" (types.ts), it is the state
    // every pre-0.2.5x row and every unprobed branch is in, and it renders the weak
    // word. A suite that only drove the three enum values would leave the commonest
    // real-world case untested.
    //
    // ⚠️ THIS NEEDLE IS THE WEAKEST OF THE FOUR and the count it yields is a floor,
    // not a measure: the blocks that exercise absence most convincingly (a persisted
    // row with no `focus_evidence` key at all, `focusProvenanceOf({})`, an export of a
    // row that never carried one) spell no `undefined` anywhere.
    expect(
      blocksWhoseCodeMatches(ABSENT_VALUE),
      'absent evidence has zero cases',
    ).toBeGreaterThan(0);
  });
});
