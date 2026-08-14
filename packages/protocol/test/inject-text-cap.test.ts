// WP-R2-1 review (MAJOR #3): the inject text DoS ceiling. Verifies the bound is
// enforced by the schema (server relay side) — the desktop enforces the same
// INJECT_TEXT_MAX_CHARS on its own Rust parse path.
import { describe, it, expect } from 'vitest';
import { INJECT_TEXT_MAX_CHARS, InjectRequestSchema } from '../src/protocol-schemas-inject';

describe('inject:request text length cap', () => {
  it('accepts text at the limit', () => {
    const at = InjectRequestSchema.safeParse({ text: 'x'.repeat(INJECT_TEXT_MAX_CHARS), source: 'stt' });
    expect(at.success).toBe(true);
  });

  it('rejects text one char over the limit', () => {
    const over = InjectRequestSchema.safeParse({ text: 'x'.repeat(INJECT_TEXT_MAX_CHARS + 1), source: 'stt' });
    expect(over.success).toBe(false);
  });

  it('pins the cap constant so both consumers stay in sync', () => {
    expect(INJECT_TEXT_MAX_CHARS).toBe(100_000);
  });
});
