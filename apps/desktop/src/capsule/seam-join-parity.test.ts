// Book 08 §3 correction (2026-10-14, card POL-3 review) — the PC capsule's copy of
// the four-way row-seam rule (./seam-join.ts, used by ./utterance-view.ts) against
// the ONE shared fixture, verify/fixtures/seam-join-cases.json. The other readers:
// the Rust reference (apps/desktop/src-tauri/src/inject/delivery_spacing.rs cargo
// test), the phone (apps/mobile/test/unit_join_shared_fixture_test.dart) and the
// relay (apps/server-core/test/pol3-unit-join-shared.test.ts).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seamTakesSpace } from './seam-join';
import { joinerBetween } from './utterance-view';

interface Case { left: string; right: string; joiner: string; pc_space: boolean }
const { cases } = JSON.parse(readFileSync(resolve(__dirname, '../../../../verify/fixtures/seam-join-cases.json'), 'utf8')) as { cases: Case[] };

describe('row-seam rule — the PC capsule copy against the shared fixture', () => {
  it('the fixture is not empty (a vacuous pass is not a pin)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });
  for (const c of cases) {
    it(`${JSON.stringify(c.left)} + ${JSON.stringify(c.right)} → ${JSON.stringify(c.joiner)}`, () => {
      expect(seamTakesSpace(c.left)).toBe(c.pc_space);
      expect(joinerBetween(c.left, c.right)).toBe(c.joiner);
    });
  }
});
