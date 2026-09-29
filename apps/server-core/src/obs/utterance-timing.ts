// NR118-1: bounded, text-free metadata. Identity keys are held only in memory.
export function tcorr(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) ? value.slice(0, 6) : null;
}

export function baseLanguage(value: unknown): string | null {
  const base = typeof value === 'string' ? value.toLowerCase().split(/[-_]/)[0] : '';
  return base && /^[a-z]{2,3}$/.test(base) ? base : null;
}

export function enumValue(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

export function finiteMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

export function uplinkLagMs(start: number, stop: number, audio: number): number {
  return Math.round(stop - start - audio);
}
