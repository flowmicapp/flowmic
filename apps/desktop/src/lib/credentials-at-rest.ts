// Whether pairing / Cloud Key files are stored as plaintext on THIS host.
//
// SPEC-REF:
//   docs/strategy/2026-08-06-mac-usable-work-breakdown.md MAC-08 (plan B)
//   apps/desktop/src-tauri/src/socket/credentials.rs — `dpapi_protect`:
//     cfg!(windows)      → CryptProtectData (ciphertext)
//     cfg!(not(windows)) → Ok(plain.to_vec()) (identity / plaintext)
//
// The UI sentence this module gates must appear ONLY when the Rust branch is
// the identity function. Reusing update's `unsupported_platform` form would be
// the wrong predicate: that value answers 「can we auto-update」, and will flip
// the day mac/linux updates ship while credentials are still plaintext.

export type HostPlatform = 'windows' | 'darwin' | 'linux' | 'unknown';

/**
 * True when at-rest credentials are the plaintext identity branch.
 *
 * Only the two platforms we ship besides Windows count. `unknown` is silent
 * rather than loud: showing the sentence on a Windows host we failed to
 * classify would be a lie, and silence-when-unsure is the cheaper failure.
 */
export function credentialsStoredPlaintext(platform: string): boolean {
  return platform === 'darwin' || platform === 'linux';
}

/**
 * Resolve the host platform from the build stamp (preferred) or a Node
 * `process.platform` fallback used by bare vite / vitest without the Tauri CLI.
 *
 * `TAURI_ENV_PLATFORM` is the *target* under `tauri build`, so a cross-compile
 * stamps the guest OS, not the builder's. The Node fallback is only for tooling
 * that never sets that env.
 */
export function resolveHostPlatform(
  envPlatform: string | undefined | null,
  nodePlatform: string | undefined | null,
): HostPlatform {
  const fromEnv = (envPlatform ?? '').toLowerCase();
  if (fromEnv === 'windows' || fromEnv === 'darwin' || fromEnv === 'linux') return fromEnv;
  if (nodePlatform === 'win32') return 'windows';
  if (nodePlatform === 'darwin') return 'darwin';
  if (nodePlatform === 'linux') return 'linux';
  return 'unknown';
}

declare global {
  // Stamped by apps/desktop/vite.config.ts (same shape as
  // __FLOWMIC_ADDITIONAL_PRIVATE_CIDRS__).
  var __FLOWMIC_HOST_PLATFORM__: string | undefined;
}

/** Production reader: the Vite `define` stamp, then Node platform if any. */
export function hostPlatform(): HostPlatform {
  const stamped =
    typeof globalThis !== 'undefined'
      ? (globalThis as { __FLOWMIC_HOST_PLATFORM__?: string }).__FLOWMIC_HOST_PLATFORM__
      : undefined;
  const node =
    typeof process !== 'undefined' && typeof process.platform === 'string'
      ? process.platform
      : undefined;
  return resolveHostPlatform(stamped, node);
}
