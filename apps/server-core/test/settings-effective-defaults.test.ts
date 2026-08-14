// 0.3.0 L2 — `settings:list` must answer 「what will the server DO」, not 「is there
// a row」.
//
// 🔴 THE DEFECT THIS PINS (RT ledger §6.1 item 6, the one entry on that list that
// four-language copy could not fix). `stt.polish` is never seeded, so for an
// account that has never touched the switch there is no row. The list handler used
// to return exactly the rows in the table, so the desktop received nothing for the
// key, kept its own hard-coded `false`, and rendered the toggle OFF — while the
// server polished every closing final for that same account. A control that says
// OFF while the thing runs is booklet 15 R11 ("every status word must answer why we say it") and
// the mirror image of 0.2.27's "a control that changes nothing".
//
// ⚠️ THE ASSERTIONS ARE ON THE VALUE, NOT ON THE KEY BEING PRESENT. Asserting only
// that `stt.polish` appears would stay green if the handler shipped a frozen
// literal that no longer tracked the server's own default — which is the same
// class of bug (a second copy of one truth) one layer down.
//
// 🔴 POLISH-CFG (2026-08-09): the default stopped being a constant and became a
// function of "whether a usable llm.config exists", so it is now PASSED IN. These cases
// therefore feed both values explicitly. That is not a weakening: the property
// worth pinning was never 「the value equals this constant」 but 「the value the
// caller resolved is the value that reaches the wire」, and passing it in is what
// makes that testable at all.

import { describe, expect, it } from 'vitest';
import { SETTINGS_KEY_CAPABILITY_LLM, SETTINGS_KEY_STT_POLISH } from '@flowmic/protocol';
import { withEffectiveDefaults } from '../src/socket/handlers/settings.handler';
import {
  STT_POLISH_DEFAULT_WITH_LLM,
  STT_POLISH_DEFAULT_WITHOUT_LLM,
  sttPolishDefaultFrom,
} from '../src/stt/stt-polish-settings';
import type { SettingRow } from '../src/db/repos/settings.repo';

const row = (key: string, value: unknown): SettingRow => ({
  user_id: 'u1',
  key,
  value,
  updated_at: '2026-08-08T00:00:00.000Z',
});

const find = (items: { key: string; value: unknown }[], key: string): unknown =>
  items.find((i) => i.key === key)?.value;

describe('settings:list effective defaults', () => {
  it('an account with NO stt.polish row is told what the server will actually do', () => {
    const out = withEffectiveDefaults([row('llm.config', { endpoint: 'http://x/v1' })], STT_POLISH_DEFAULT_WITH_LLM, true);
    // 🔴 The whole point: absence on the wire used to be indistinguishable from
    // 「off」, and the desktop guessed. Now the effective value is stated.
    expect(find(out, SETTINGS_KEY_STT_POLISH)).toEqual(STT_POLISH_DEFAULT_WITH_LLM);
  });

  it('carries the default it was HANDED, not one of its own — both directions', () => {
    // Both values are exercised, so a re-frozen literal cannot pass: whichever
    // constant an implementation hard-coded, the other case reddens.
    for (const d of [STT_POLISH_DEFAULT_WITH_LLM, STT_POLISH_DEFAULT_WITHOUT_LLM]) {
      const v = find(withEffectiveDefaults([], d, d.enabled), SETTINGS_KEY_STT_POLISH) as { enabled: boolean };
      expect(v.enabled).toBe(d.enabled);
    }
  });

  it('🔴 no usable LLM ⇒ the switch is told OFF, so it never reads ON over a model that is not there', () => {
    // The 0.2.27 dead-control shape, which is the reason POLISH-CFG exists: a
    // stock install has no llm.config and no managed default, so the resolved
    // default is OFF and the desktop must be told exactly that.
    const out = withEffectiveDefaults([row('stt.routings', [])], STT_POLISH_DEFAULT_WITHOUT_LLM, false);
    expect(find(out, SETTINGS_KEY_STT_POLISH)).toEqual({ enabled: false });
  });

  it("🔴 NEGATIVE CONTROL: a user's own row always wins — the gap-filler must not clobber it", () => {
    // Without this, an implementation that unconditionally appended (or, worse,
    // overwrote) would pass every other test in this file while silently deleting
    // the one thing the user actually chose. It is written to fail whichever way
    // the default is currently set: the row asserts the OPPOSITE of the default.
    const opposite = { enabled: !STT_POLISH_DEFAULT_WITH_LLM.enabled };
    const out = withEffectiveDefaults([row(SETTINGS_KEY_STT_POLISH, opposite)], STT_POLISH_DEFAULT_WITH_LLM, true);
    expect(find(out, SETTINGS_KEY_STT_POLISH)).toEqual(opposite);
    expect(out.filter((i) => i.key === SETTINGS_KEY_STT_POLISH)).toHaveLength(1);
  });

  it('passes every other key through untouched, and invents nothing else', () => {
    const rows = [row('stt.routings', [{ language: 'zh' }]), row('scenario.card', { terms: [] })];
    const out = withEffectiveDefaults(rows, STT_POLISH_DEFAULT_WITH_LLM, true);
    expect(find(out, 'stt.routings')).toEqual([{ language: 'zh' }]);
    expect(find(out, 'scenario.card')).toEqual({ terms: [] });
    // Exactly TWO keys are synthesised — the polish gap-filler and the
    // `capability.llm` fact. A future default that quietly joins this helper
    // without a decision behind it shows up here as a failure.
    expect(out).toHaveLength(rows.length + 2);
  });

  it('🔴 capability.llm is emitted ALWAYS and carries the fact it was handed', () => {
    // Unlike the polish gap-filler this is unconditional: it is not filling a
    // hole a row could occupy, it is stating something no row can hold.
    for (const usable of [true, false]) {
      const out = withEffectiveDefaults([], sttPolishDefaultFrom(usable), usable);
      expect(find(out, SETTINGS_KEY_CAPABILITY_LLM)).toEqual({ usable });
    }
  });

  it('🔴 the switch value and the capability fact cannot disagree', () => {
    // The defect this whole card exists to prevent, asserted directly: the
    // desktop renders "not configured" from one of these and the toggle from the other,
    // so a build where they can differ would show a reason that contradicts the
    // control right beside it.
    for (const usable of [true, false]) {
      const out = withEffectiveDefaults([], sttPolishDefaultFrom(usable), usable);
      const polish = find(out, SETTINGS_KEY_STT_POLISH) as { enabled: boolean };
      const cap = find(out, SETTINGS_KEY_CAPABILITY_LLM) as { usable: boolean };
      expect(polish.enabled).toBe(cap.usable);
    }
  });

  it('🔴 a stored row can never shadow the capability fact', () => {
    // A capability key is not storable. If someone ever persisted one, the
    // synthesised answer must still be the one that reaches the wire — and there
    // must be exactly one of it.
    const out = withEffectiveDefaults(
      [row(SETTINGS_KEY_CAPABILITY_LLM, { usable: true })],
      sttPolishDefaultFrom(false),
      false,
    );
    expect(out.filter((i) => i.key === SETTINGS_KEY_CAPABILITY_LLM)).toHaveLength(2);
  });
});
