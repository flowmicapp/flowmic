import { describe, expect, it } from 'vitest';
import { APP_VERSION } from './version';
import pkg from '../../package.json';

describe('APP_VERSION (T-7)', () => {
  it('mirrors apps/desktop/package.json (no hard-coded literal)', () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_VERSION.length).toBeGreaterThan(0);
  });
});
