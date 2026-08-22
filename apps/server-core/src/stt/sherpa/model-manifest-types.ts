// The two shapes model-fetch.ts verifies and dials against. Split out of
// model-manifest.ts (LM-CAT, 2026-08-22) so the catalog can declare per-model
// files/sources without importing the manifest — the manifest now DERIVES its
// legacy constants FROM the catalog, and a type-only module is what keeps that
// dependency a line instead of a cycle.

export interface ModelFile {
  /** repo-relative path (also the on-disk relative path). */
  path: string;
  /** authoritative byte length (size gate). Absent = not yet measured from a
   *  trusted source; the integrity gate then has only the SHA-256 (if pinned)
   *  and `bytes_total` honestly answers null. */
  size?: number;
  /** pinned SHA-256 (fail-loud gate). Pinned only from bytes downloaded and
   *  hashed locally — never copied out of a chat or a second-hand table. */
  sha256?: string;
}

export interface ModelSource {
  name: string;
  /** base URL; the file's repo-relative path is appended. */
  base: string;
}
