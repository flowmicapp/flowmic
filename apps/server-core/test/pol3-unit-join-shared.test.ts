// Book 08 §3 correction (2026-10-14, card POL-3 review) — the relay's copy of the
// four-way row-seam rule (engine/stt-seam-join.ts) against the ONE shared fixture,
// verify/fixtures/seam-join-cases.json. The other readers: the Rust reference
// (apps/desktop/src-tauri/src/inject/delivery_spacing.rs, its cargo test pins
// `pc_space`), the PC capsule (apps/desktop/src/capsule/seam-join-parity.test.ts)
// and the phone (apps/mobile/test/unit_join_shared_fixture_test.dart).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seamTakesSpace } from '../src/engine/stt-seam-join';
import { contextForUnit, joinerBetween } from '../src/engine/stt-session-units';

interface Case { left: string; right: string; joiner: string; pc_space: boolean }
const { cases } = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'verify', 'fixtures', 'seam-join-cases.json'), 'utf8')) as { cases: Case[] };

describe('row-seam rule — the relay copy against the shared fixture', () => {
  it('the fixture is not empty (a vacuous pass is not a pin)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it('the fixture is self-consistent: joiner = pc_space plus the two display-only rules', () => {
    for (const c of cases) {
      const last = [...c.left].at(-1) ?? '';
      const display = c.left === '' || c.right === '' ? ''
        : '。！？'.includes(last) ? '\n'
        : /^\p{White_Space}/u.test(c.right) ? ''
        : c.pc_space ? ' ' : '';
      expect(display, JSON.stringify(c)).toBe(c.joiner);
    }
  });

  for (const c of cases) {
    it(`${JSON.stringify(c.left)} + ${JSON.stringify(c.right)} → ${JSON.stringify(c.joiner)} (pc_space ${c.pc_space})`, () => {
      expect(seamTakesSpace(c.left)).toBe(c.pc_space);
      expect(joinerBetween(c.left, c.right)).toBe(c.joiner);
    });
  }

  it('the context of two non-empty rows is left + joiner + right', () => {
    for (const c of cases.filter((x) => x.left.trim() !== '' && x.right.trim() !== '' && x.right === x.right.trimStart())) {
      expect(contextForUnit([{ raw: c.left, frozen: c.left }, { raw: c.right, frozen: c.right }]).text, JSON.stringify(c)).toBe(c.left + c.joiner + c.right);
    }
  });
});
