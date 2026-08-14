// SPEC-REF:
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §5.5 (open-source boundary: the
//     legacy default secret 'flowmic-standalone-dev-secret' MUST become a
//     first-boot auto-generated, persisted secret)
//   docs/rebuild/13-LESSONS-LEARNED.md §6.3 (default secret → forced explicit /
//     auto-generate)
//   CLAUDE.md red line: no hardcoded default secret (standalone auto-generates
//     one on first boot and persists it)
//
// Standalone deployments have no operator to supply a JWT/settings secret, so
// the server mints one on first boot and persists it to disk. There is NO
// hardcoded fallback secret anywhere in this codebase — an unresolvable secret
// is a hard boot failure (fail-loud), never a silent dev default. saas mode
// supplies its secret explicitly via env and never touches this module.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SECRET_BYTES = 32; // 256-bit

export interface ResolveSecretOpts {
  /** Explicit secret (saas: FLOWMIC_JWT_SECRET; test overrides). Wins outright. */
  explicitSecret?: string;
  /** File the standalone secret is read from / persisted to. */
  secretPath?: string;
  /** Home dir the default secretPath lives under. */
  home?: string;
}

/** Resolve the default on-disk secret path: <home>/standalone.secret. The
 *  default home lives under the repo-gitignored `.local/` so a bare dev run
 *  never drops an untracked secret file; a real deployment sets FLOWMIC_HOME or
 *  FLOWMIC_SECRET_PATH to its own install dir. */
export function defaultSecretPath(home?: string): string {
  const base = home ?? process.env.FLOWMIC_HOME ?? resolve(process.cwd(), '.local', 'flowmic');
  return join(base, 'standalone.secret');
}

/**
 * Resolve the deployment secret used to derive the user_settings AES key
 * (enc:v1:) and, in saas mode, sign account JWTs.
 *
 *   1. explicitSecret / FLOWMIC_SETTINGS_SECRET / FLOWMIC_JWT_SECRET → use it.
 *   2. else read the persisted standalone secret from disk.
 *   3. else mint 32 random bytes, persist (0600 best-effort), and return.
 *
 * Never returns a hardcoded fallback. A persisted-but-empty file is treated as
 * corruption and regenerated rather than accepted.
 */
export function resolveStandaloneSecret(opts: ResolveSecretOpts = {}): string {
  const explicit =
    opts.explicitSecret ?? process.env.FLOWMIC_SETTINGS_SECRET ?? process.env.FLOWMIC_JWT_SECRET;
  if (explicit && explicit.length > 0) return explicit;

  const path = opts.secretPath ?? process.env.FLOWMIC_SECRET_PATH ?? defaultSecretPath(opts.home);
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const minted = randomBytes(SECRET_BYTES).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, minted, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows/edge filesystems may not honor mode; the file is still ours.
  }
  return minted;
}
