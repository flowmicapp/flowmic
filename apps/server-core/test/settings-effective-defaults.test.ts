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
//
// 🔴 NR-132 (2026-09-29): the default is a constant again — `STT_POLISH_DEFAULT`,
// ON — because the switch that renders it now lives on the phone and shows ON
// when untouched. It stays PASSED IN (the handler hands the constant), and the
// case that used to assert 「no model ⇒ the list says OFF」 now asserts the
// opposite: the list and the session state ONE answer, and that answer no longer
// depends on the model. `capability.llm` is the separate fact about the model.

import { describe, expect, it } from 'vitest';
import { SETTINGS_KEY_CAPABILITY_LLM, SETTINGS_KEY_STT_POLISH } from '@flowmic/protocol';
import { withEffectiveDefaults } from '../src/socket/handlers/settings.handler';
import { STT_POLISH_DEFAULT } from '../src/stt/stt-polish-settings';
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
    const out = withEffectiveDefaults([row('llm.config', { endpoint: 'http://x/v1' })], STT_POLISH_DEFAULT, true);
    // 🔴 The whole point: absence on the wire used to be indistinguishable from
    // 「off」, and the desktop guessed. Now the effective value is stated.
    expect(find(out, SETTINGS_KEY_STT_POLISH)).toEqual(STT_POLISH_DEFAULT);
  });

  it('carries the default it was HANDED, not one of its own — both directions', () => {
    // Both values are exercised, so a re-frozen literal cannot pass: whichever
    // constant an implementation hard-coded, the other case reddens.
    for (const d of [STT_POLISH_DEFAULT, { enabled: !STT_POLISH_DEFAULT.enabled }]) {
      const v = find(withEffectiveDefaults([], d, d.enabled), SETTINGS_KEY_STT_POLISH) as { enabled: boolean };
      expect(v.enabled).toBe(d.enabled);
    }
  });

  it('🔴 NR-132: no usable LLM ⇒ the list still states the session default (ON), and capability.llm says why it cannot run', () => {
    // Until NR-132 this asserted OFF (POLISH-CFG). The phone renders an untouched
    // switch as ON and the session now arms on that; the list must not state a
    // second answer. The model's absence is reported by capability.llm instead.
    const out = withEffectiveDefaults([row('stt.routings', [])], STT_POLISH_DEFAULT, false);
    expect(find(out, SETTINGS_KEY_STT_POLISH)).toEqual({ enabled: true });
    expect(find(out, SETTINGS_KEY_CAPABILITY_LLM)).toEqual({ usable: false, rejected: false });
  });

  it("🔴 NEGATIVE CONTROL: a user's own row always wins — the gap-filler must not clobber it", () => {
    // Without this, an implementation that unconditionally appended (or, worse,
    // overwrote) would pass every other test in this file while silently deleting
    // the one thing the user actually chose. It is written to fail whichever way
    // the default is currently set: the row asserts the OPPOSITE of the default.
    const opposite = { enabled: !STT_POLISH_DEFAULT.enabled };
    const out = withEffectiveDefaults([row(SETTINGS_KEY_STT_POLISH, opposite)], STT_POLISH_DEFAULT, true);
    expect(find(out, SETTINGS_KEY_STT_POLISH)).toEqual(opposite);
    expect(out.filter((i) => i.key === SETTINGS_KEY_STT_POLISH)).toHaveLength(1);
  });

  it('passes every other key through untouched, and invents nothing else', () => {
    const rows = [row('stt.routings', [{ language: 'zh' }]), row('scenario.card', { terms: [] })];
    const out = withEffectiveDefaults(rows, STT_POLISH_DEFAULT, true);
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
      const out = withEffectiveDefaults([], STT_POLISH_DEFAULT, usable);
      expect(find(out, SETTINGS_KEY_CAPABILITY_LLM)).toEqual({ usable, rejected: false });
    }
    // NR-130: the `rejected` half is carried through, not re-derived here.
    expect(find(withEffectiveDefaults([], STT_POLISH_DEFAULT, true, true), SETTINGS_KEY_CAPABILITY_LLM))
      .toEqual({ usable: true, rejected: true });
  });

  it('🔴 NR-132: the polish default no longer follows the capability fact — two facts, two keys', () => {
    // Until NR-132 this case asserted the opposite (polish.enabled === cap.usable),
    // because the desktop rendered a polish toggle beside the 「not configured」
    // line. That toggle was deleted on 2026-09-03; the switch is the phone's and
    // shows ON when untouched. Pinned in both directions so neither half can
    // quietly start deriving from the other again.
    for (const usable of [true, false]) {
      const out = withEffectiveDefaults([], STT_POLISH_DEFAULT, usable);
      expect(find(out, SETTINGS_KEY_STT_POLISH)).toEqual({ enabled: true });
      expect((find(out, SETTINGS_KEY_CAPABILITY_LLM) as { usable: boolean }).usable).toBe(usable);
    }
  });

  it('🔴 a stored row can never shadow the capability fact', () => {
    // A capability key is not storable. If someone ever persisted one, the
    // synthesised answer must still be the one that reaches the wire — and there
    // must be exactly one of it.
    const out = withEffectiveDefaults(
      [row(SETTINGS_KEY_CAPABILITY_LLM, { usable: true })],
      STT_POLISH_DEFAULT,
      false,
    );
    expect(out.filter((i) => i.key === SETTINGS_KEY_CAPABILITY_LLM)).toHaveLength(2);
  });

  // ── G2 (04 §3.7-a): stored rows answer with a time, computed rows do not ────
  describe('updated_at', () => {
    it('a STORED row carries its own stamp onto the wire', () => {
      // The column has been per-key since the table was created (05 §5.1); the
      // only thing G2 changed is that this projection stops dropping it. No
      // migration was involved, and anyone reading this test as evidence for one
      // has it backwards.
      const out = withEffectiveDefaults([row('llm.config', { endpoint: 'http://x/v1' })], STT_POLISH_DEFAULT, true);
      const stored = out.find((i) => i.key === 'llm.config');
      expect(stored?.updated_at).toBe('2026-08-08T00:00:00.000Z');
    });

    it('🔴 a SYNTHESIZED row carries NO stamp — absent = unknown, never invented', () => {
      // Both computed rows, in the case where neither has a row behind it.
      // There is no moment at which a human set either value, so there is no
      // honest time to report. A fabricated stamp would be worse than useless:
      // client convergence compares these, so it would let a computed fact win
      // or lose against a real edit.
      const out = withEffectiveDefaults([], STT_POLISH_DEFAULT, true);
      const polish = out.find((i) => i.key === SETTINGS_KEY_STT_POLISH);
      const cap = out.find((i) => i.key === SETTINGS_KEY_CAPABILITY_LLM);
      expect(polish).toBeDefined();
      expect(cap).toBeDefined();
      // `in`, not `=== undefined`: the key must be ABSENT, not present-and-empty.
      // `updated_at: undefined` survives toEqual but would serialise differently
      // and reads to the next person as "we had one and lost it".
      expect('updated_at' in polish!).toBe(false);
      expect('updated_at' in cap!).toBe(false);
    });

    it('🔴 the capability fact stays un-stamped even when a stored row shadows it', () => {
      // Pairs with the shadowing test above: the synthesised copy must not
      // inherit a time from the row it is refusing to defer to.
      const out = withEffectiveDefaults(
        [row(SETTINGS_KEY_CAPABILITY_LLM, { usable: true })],
        STT_POLISH_DEFAULT,
        false,
      );
      const copies = out.filter((i) => i.key === SETTINGS_KEY_CAPABILITY_LLM);
      expect(copies).toHaveLength(2);
      // The stored one keeps its stamp; the synthesised one has none.
      expect(copies.filter((c) => 'updated_at' in c)).toHaveLength(1);
    });
  });
});
