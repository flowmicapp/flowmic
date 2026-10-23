// NR-245 review: the self-correction search costs one full guard check per
// reading. It only makes sense when the as-written verdict was a meaning
// refusal (closed-class-drift:*), the only kind a dropped marker and
// reparandum can cause; a refusal on the cardinality bounds must not pay it.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stt/stt-polish-guard-repair', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/stt/stt-polish-guard-repair')>();
  return { ...real, repairReadings: vi.fn(real.repairReadings) };
});

const { checkMeaningPreserved } = await import('../src/stt/stt-polish-guard');
const { repairReadings } = await import('../src/stt/stt-polish-guard-repair');

describe('the self-correction search runs only after a meaning refusal', () => {
  it('a refusal on the bounds does not search', () => {
    const raw = '发给李明，我是说张伟。'.repeat(36);
    const pol = raw.split('我是说').join('');
    vi.mocked(repairReadings).mockClear();
    const r = checkMeaningPreserved(raw, pol, { strength: 'smooth' });
    expect(r.ok).toBe(false);
    expect(r.reason?.startsWith('closed-class-drift:')).toBe(false);
    expect(vi.mocked(repairReadings)).not.toHaveBeenCalled();
  });

  it('control: a meaning refusal does search, and resolves', () => {
    vi.mocked(repairReadings).mockClear();
    const r = checkMeaningPreserved("let's meet at 2, no wait, 3", "let's meet at 3", { strength: 'smooth' });
    expect(vi.mocked(repairReadings)).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, selfCorrection: true });
  });
});
