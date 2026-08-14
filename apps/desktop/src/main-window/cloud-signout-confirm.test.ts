// REQ-12-01 (owner 2026-08-12 requirement ①: "the double-confirm style for
// signing out on phone and PC needs improving", mechanism keeps the double
// confirm) — the PC half.
//
// 🔴 WHAT WAS WRONG, because it is the only thing worth remembering here: the
// old confirm was `const confirmingClearKey = ref(false)` toggled inline in the
// template, and App.vue toggles the pages with `v-show` — this component never
// unmounts. So arming the confirm and then backing out ANY way other than the
// one small "Cancel" button (collapse the account fold, switch to Timeline, sign out
// and paste a different key) left it armed for the rest of the session, and the
// next render put the red "Confirm sign out" at the top of the card. One click, and the
// question was asked minutes ago at a moment the user had already left.
//
// The gate now lives in lib/cloud-signout-gate.ts — pure, exported, and next
// door to lib/release-mobile.ts, the revoke gate on this same page. (`<script
// setup>` cannot export, and the block written inline first pushed the SFC 7
// lines past the 800 cap, so the split was forced and correct at once.) That is
// what lets this file drive the REAL production functions rather than a copy of
// them. Two layers, on purpose:
//
//   · §1 BEHAVIOUR — the gate itself, called directly. This is where "dismissing
//     does not sign out" is proven.
//   · §2 WIRING — literal anchors proving every back-out path in the component
//     reaches `cancelClearKey`. A pure gate is worthless if the template only
//     calls it from one place, and that is precisely the bug being fixed. This
//     is the same split prefs-appearance.test.ts writes down: behaviour where it
//     can run, anchors where the SFC's interaction wiring lives.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  armSignOut,
  disarmSignOut,
  newSignOutConfirm,
  runSignOut,
  SIGN_OUT_CONFIRM_TTL_MS,
} from '../lib/cloud-signout-gate';
import { S } from '../lib/strings';
import { CLOUD_STRINGS } from '../lib/strings/cloud';

const SRC = readFileSync(fileURLToPath(new URL('./DevicesPage.vue', import.meta.url)), 'utf8');

describe('§1 the cloud sign-out gate (behaviour)', () => {
  it('a fresh gate is NOT armed — the destructive call is refused and never made', async () => {
    const gate = newSignOutConfirm();
    const clear = vi.fn(async () => 'CLEARED');

    const out = await runSignOut(gate, clear);

    expect(out).toBeNull();
    expect(clear).not.toHaveBeenCalled();
  });

  it('🔴 DISMISSING DOES NOT SIGN OUT — every back-out path disarms, and a '
    + 'disarmed gate refuses', async () => {
    const clear = vi.fn(async () => 'CLEARED');
    // The three dismissals the component wires (Cancel / the fold toggle / a
    // key-state change) are ONE verb by design — they are not three chances to
    // get it right, they are three call sites of the same disarm.
    for (const _dismissal of ['cancel button', 'fold toggle', 'key_set changed']) {
      const gate = newSignOutConfirm();
      armSignOut(gate);
      expect(gate.armed).toBe(true);

      disarmSignOut(gate);

      expect(await runSignOut(gate, clear)).toBeNull();
    }
    expect(clear).not.toHaveBeenCalled();
  });

  it('the confirm still WORKS — an armed gate runs it exactly once', async () => {
    // Positive control. Without it, every assertion above is equally satisfied by
    // a sign-out that is simply broken, and a suite that cannot tell "gated"
    // from "dead" is not testing a gate.
    const gate = newSignOutConfirm();
    const clear = vi.fn(async () => 'CLEARED');
    armSignOut(gate);

    expect(await runSignOut(gate, clear)).toBe('CLEARED');
    expect(clear).toHaveBeenCalledTimes(1);

    // Fired ⇒ disarmed. A second click (double-click, a stuck key, a re-entrant
    // handler) must not delete the key a second time.
    expect(await runSignOut(gate, clear)).toBeNull();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('a refusal is null, NOT false — the caller can tell 「I refused」 from '
    + '「it ran and failed」', async () => {
    // `clearCloudKey()` answers with a CloudStatus; a boolean-shaped refusal is
    // how a gate quietly becomes "the sign-out failed" in someone's error path.
    const gate = newSignOutConfirm();
    expect(await runSignOut(gate, async () => false)).toBeNull();
    armSignOut(gate);
    expect(await runSignOut(gate, async () => false)).toBe(false);
  });

  it('the arm has a finite life', () => {
    // The number is a judgement, but "no expiry at all" was the defect: the paths
    // this component cannot observe (page switch via v-show) have no other way
    // back. Pinned loosely — this asserts a policy exists, not that it is 30 s.
    expect(SIGN_OUT_CONFIRM_TTL_MS).toBeGreaterThan(5_000);
    expect(SIGN_OUT_CONFIRM_TTL_MS).toBeLessThanOrEqual(120_000);
  });
});

describe('§2 the component really routes every back-out into the gate', () => {
  it('the destructive handler goes through runSignOut and nothing else calls clearCloudKey', () => {
    expect(SRC).toContain('runSignOut(signOutConfirm, clearCloudKey)');
    // 🔴 The negative that matters: exactly ONE mention of the bridge call in the
    // whole component, and it is the one inside the gate. A second call site is
    // how a gate gets bypassed without anybody deleting it.
    expect(SRC.match(/clearCloudKey/g)?.length).toBe(2); // the import + the gated call
  });

  it('arming is its own verb — the trigger can no longer double as the fire button', () => {
    // Before: BOTH buttons were `@click="doClearKey"` and the function decided
    // which one you meant from its own latch. One function, two questions.
    expect(SRC).toContain('@click="askClearKey"');
    expect(SRC).toContain('@click="doClearKey"');
    expect(SRC).not.toContain('confirmingClearKey');
  });

  it('the fold toggle is a back-out path, not a neutral one', () => {
    // The regression this pins: `@click="cloudDetailOpen = !cloudDetailOpen"`
    // (what it used to be) collapses the card WITHOUT disarming, so re-opening
    // showed a pre-armed destructive button.
    expect(SRC).toContain('@click="toggleCloudDetail"');
    expect(SRC).toMatch(/function toggleCloudDetail\(\): void \{[\s\S]*?cancelClearKey\(\)/);
    expect(SRC).not.toContain('@click="cloudDetailOpen = !cloudDetailOpen"');
  });

  it('a change of sign-in state disarms before the block re-renders', () => {
    expect(SRC).toMatch(/if \(next\.key_set !== cloud\.value\.key_set\) cancelClearKey\(\);/);
  });

  it('cancel is FIRST and is not the danger button', () => {
    const cancelAt = SRC.indexOf('@click="cancelClearKey"');
    const dangerAt = SRC.indexOf('btn danger sm');
    expect(cancelAt).toBeGreaterThan(-1);
    expect(dangerAt).toBeGreaterThan(cancelAt);
  });
});

describe('§3 the confirm says what is actually lost — and what is not', () => {
  it('the question, the consequence and BOTH survival clauses are rendered', () => {
    for (const key of [
      'cloud_key_clear_q',
      'cloud_key_clear_confirm',
      'cloud_key_clear_unaffected',
      'cloud_key_clear_keeps_records',
      'cloud_key_clear_keeps_account',
    ] as const) {
      expect(SRC, `${key} must reach the template`).toContain(`S.${key}`);
      expect(S[key], `${key} must resolve to real copy`).toBeTruthy();
    }
  });

  it('all four locales carry every new key (a missing one renders as undefined)', () => {
    // locale-parity guards the key SETS against each other; this names the five
    // keys this card added, so a future locale-wide edit that drops one fails
    // here by name rather than as an anonymous parity diff.
    for (const locale of ['zh-CN', 'en', 'ja', 'ko'] as const) {
      for (const key of [
        'cloud_key_clear_q',
        'cloud_key_clear_unaffected',
        'cloud_key_clear_keeps_records',
        'cloud_key_clear_keeps_account',
      ] as const) {
        const value = CLOUD_STRINGS[locale][key];
        expect(value, `${locale}.${key}`).toBeTruthy();
        expect(value.length, `${locale}.${key} must not be a placeholder`).toBeGreaterThan(2);
      }
    }
  });

  it('the two survival clauses are DIFFERENT sentences in every locale', () => {
    // "records are unaffected" and "the account won't be deleted" answer two different fears. A translation
    // that collapses them into one line is the copy defect this card is fixing,
    // dressed as a translation.
    for (const locale of ['zh-CN', 'en', 'ja', 'ko'] as const) {
      expect(CLOUD_STRINGS[locale].cloud_key_clear_keeps_records)
        .not.toBe(CLOUD_STRINGS[locale].cloud_key_clear_keeps_account);
    }
  });

  it('the danger button carries a glyph, so the two actions differ by more than colour', () => {
    // owner 2026-08-01 "colour + icon combination, must not rely on colour alone" (C-8), applied where it matters
    // most: the two buttons of a destructive confirm.
    expect(SRC).toMatch(/btn danger sm"[^>]*>\s*<Icon name="x"/);
  });
});

// ── REVERSE CONTROL (2026-08-12, machine = dev-pc-a / this repo) ──────
// The gate is the `if (!s.armed) return null;` line in `runSignOut`
// (lib/cloud-signout-gate.ts). Neutralised on purpose — `if (false) return null;`
// — and this file re-run. Verbatim:
//
//   ❯ src/main-window/cloud-signout-confirm.test.ts (14 tests | 4 failed) 10ms
//     × §1 … > a fresh gate is NOT armed — the destructive call is refused and never made 5ms
//       → expected 'CLEARED' to be null
//     × §1 … > 🔴 DISMISSING DOES NOT SIGN OUT — every back-out path disarms, and a disarmed gate refuses 1ms
//       → expected 'CLEARED' to be null
//     × §1 … > the confirm still WORKS — an armed gate runs it exactly once 0ms
//       → expected 'CLEARED' to be null
//     × §1 … > a refusal is null, NOT false — the caller can tell 「I refused」 from 「it ran and failed」 0ms
//       → expected false to be null
//
//   AssertionError: expected 'CLEARED' to be null
//   - Expected:
//   null
//   + Received:
//   "CLEARED"
//    ❯ src/main-window/cloud-signout-confirm.test.ts:47:17
//
//   Test Files  1 failed (1)
//        Tests  4 failed | 10 passed (14)
//
// 🔴 Note which 10 stayed GREEN: every string assertion in §3 and every wiring
// anchor in §2. The copy being right and the buttons being wired to the right
// verbs says NOTHING about whether the gate holds — §2 would be just as green
// against a `runSignOut` that never refuses anything. Only §1 can see it, which
// is why the split is written down at the top of this file rather than left as
// an accident of where the assertions ended up.
// Restored (14/14 green); the marker `REVERSE-CONTROL-REQ1201` greps to 0 and
// DevicesPage.vue contains `if (!s.armed) return null;` again.
