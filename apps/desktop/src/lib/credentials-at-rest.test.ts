import { describe, expect, it } from 'vitest';
import {
  credentialsStoredPlaintext,
  resolveHostPlatform,
} from './credentials-at-rest';

describe('credentialsStoredPlaintext (MAC-08 gate)', () => {
  it('positive control: on darwin / linux this sentence should appear (the plaintext identity branch)', () => {
    expect(credentialsStoredPlaintext('darwin')).toBe(true);
    expect(credentialsStoredPlaintext('linux')).toBe(true);
  });

  it('reverse control: on windows this sentence must never appear (real DPAPI)', () => {
    // 🔴 If this assertion is ever inverted to expect(true), the Windows build
    // would tell users their DPAPI-wrapped files are plaintext — a lie. The
    // witness for a wrong gate is this test going red, not a Mac screenshot.
    expect(credentialsStoredPlaintext('windows')).toBe(false);
  });

  it('unknown stays silent — unclassified ≠ plaintext claim', () => {
    expect(credentialsStoredPlaintext('unknown')).toBe(false);
    expect(credentialsStoredPlaintext('')).toBe(false);
  });
});

describe('resolveHostPlatform', () => {
  it('prefers the Tauri target stamp over the builder Node platform', () => {
    // Cross-compile shape: build mac artifacts on a Linux/Windows box.
    expect(resolveHostPlatform('darwin', 'win32')).toBe('darwin');
    expect(resolveHostPlatform('linux', 'win32')).toBe('linux');
    expect(resolveHostPlatform('windows', 'darwin')).toBe('windows');
  });

  it('falls back to Node platform when the stamp is missing', () => {
    expect(resolveHostPlatform(undefined, 'win32')).toBe('windows');
    expect(resolveHostPlatform(null, 'darwin')).toBe('darwin');
    expect(resolveHostPlatform('', 'linux')).toBe('linux');
  });
});
