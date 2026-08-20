// SPEC-REF:
//   docs/decisions/2026-08-02-in-app-update-both-ends.md (owner 2026-08-02:
//     "the official site is the authoritative place to get the update URL, but
//     the download link may be some other URL")
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §1 (manifest contract) /
//     §2 (hash gate)
//   CLAUDE.md red line "no silent failure" — both directions forbidden
//
// GET /api/updates/latest — "which version is the latest FlowMic artifact,
// where to get it, and what is its SHA256".
//
// ── which question this route answers (read this before reading further) ──
//
// /api/health's `version` answers "which version is **this server** running"
// (router.ts:216). This route answers "which version is the **latest published
// artifact**". Looks like the same number, but it isn't: the relay's deployment
// and the artifact's publication going out of sync is the normal case
// (0.2.37's round was never deployed at all). Letting one value answer both
// of these questions is the #1 bug shape that has shown up five times across
// this repo's ten releases —
// so it is **absolutely forbidden** to generate the manifest from
// SERVER_VERSION, not even one byte of it.
//
// ⇒ The manifest is **data**, not code. It is a JSON file ops places on disk
//   (`FLOWMIC_UPDATE_MANIFEST_PATH`, in production = /etc/flowmic-app/updates.json,
//   alongside the existing /etc/flowmic-app/env), produced by the release
//   pipeline's scripts/build-update-manifest.mjs. Shipping a new version
//   **does not require redeploying the relay**.
//
// ── why this must live behind /api/, not the website's static directory ────
//
// Production nginx's `location /` is `try_files $uri $uri/ /index.html`
// (the private deployment repo's nginx config) ⇒ **a nonexistent static
// path returns 200 + a whole page of HTML**. A client that only checks res.ok
// would think the lookup succeeded.
// "The file is gone" disguised as "found it" — that is exactly this repo's
// silent-failure red line.
// `/api/` reverse-proxies to server-core (same file, :72-79), which returns a
// real status code.
//
// ── mounting condition ──────────────────────────────────────────────────
//
// Mounted when FLOWMIC_UPDATE_MANIFEST_PATH is configured, not mounted when it
// isn't (the path falls through to the router's 404, the same answer as
// auth/console/ops's "this deployment has no such route"). Deliberately
// **no mode gate**: this route carries neither a secret nor any
// per-deployment truth, it just reads back a file ops placed there — the only
// answer to "should this respond at all" is "did ops place that file or not".
// In practice only the cloud VPS configures it: both client apps **always ask
// the official site**, because "what is the latest FlowMic version" is a
// global fact, independent of which server you happen to be connected to.
// This is the same precedent diag-routes' FLOWMIC_LOG_PATH
// (bootstrap.ts:402) already established, reused verbatim.
//
// ── three answers, none of them allowed to be vague ────────────────────
//
//   200  a valid manifest
//   405  right path, wrong method (say so, rather than pretending "no such route")
//   503  UPDATE_MANIFEST_UNAVAILABLE —— file missing / unreadable / not valid
//        JSON / shape invalid (**including any sha256 that isn't 64-hex-digit**)
//
// 🔴 **503, not "200 + empty manifest"** — this is one whole reason this file
// exists:
// an empty manifest would be read by the client as "no update, you're already
// up to date", when the truth is "we don't know". **Unknown ≠ latest.** This
// same-family rule was already established in volume 15 ("don't know" must
// never be cast as a definite yes-answer).
//
// ── this is hash-gate ② ───────────────────────────────────────────────
//
// The download center is **HTTP only** (443 is dropped outright), and the
// phase-one Windows package is **unsigned** ⇒ until code signing lands, the
// sha256 in the manifest is the **only** guarantee of installer integrity. So:
//   ① the generator must not produce an entry with no sha256
//      (scripts/build-update-manifest.mjs)
//   ② this route must not **emit** any manifest with a suspicious sha256 ← you are here
//   ③ the client must recompute it itself after downloading, and on mismatch
//      delete the package + fail loudly
// Three gates, three processes, three separate pieces of code, each
// independently testable and each independently able to go red. Only ③
// actually protects the user;
// ①② protect "we will never emit a manifest that cannot be verified".
// ⚠️ It must be stated explicitly what this does **not** protect against: a
// compromised VPS can hand out a malicious package AND its matching sha256 at
// the same time.
// What closes that hole is phase-two code signing, not this file. This route
// must never be described as "the update chain is hardened".

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { sendJson } from './body';

export const UPDATE_MANIFEST_PATH = '/api/updates/latest';

/** 64-character lowercase hex —— the only legal shape for a sha256. Uppercase,
 *  spaces, truncated, or empty are all rejected:
 *  this is not a field where "a bit loose is fine" — it IS the gate. */
const SHA256_RE = /^[0-9a-f]{64}$/;
/** Same shape as bump-version.mjs's 9 version faces (x.y.z, three numeric segments). */
const VERSION_RE = /^\d+\.\d+\.\d+$/;
/** Platform key: lowercase + digits + hyphens. `windows-x64` / `android` / a future `macos-arm64`. */
const PLATFORM_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface UpdateArtifact {
  /** `msi` / `apk` / a future `dmg`. The client uses this to know how to handle it. */
  kind: string;
  /** Windows has two MSIs, en-US / zh-CN; the APK has only one ⇒ null. */
  locale: string | null;
  /** The client writes this name to disk ⇒ **must not contain a path separator**
   *  (see validateUpdateManifest). */
  filename: string;
  /** Absolute http(s) URL. Plain http is allowed — the download center IS plain
   *  http, which is exactly why sha256 exists. */
  url: string;
  sha256: string;
  size: number;
}

export interface UpdatePlatform {
  version: string;
  notes_url: string | null;
  artifacts: UpdateArtifact[];
}

/** A platform whose updates a STORE delivers (TestFlight / an app store), so
 *  the manifest only carries the news, never a downloadable artifact.
 *
 *  🔴 WHY THIS IS A SEPARATE TOP-LEVEL BLOCK and not an artifact-less entry in
 *  `platforms`: every fielded client (mobile ≤0.3.11 mirrors this validator
 *  line for line) rejects the WHOLE manifest on `empty_artifacts` — an ios
 *  entry with `artifacts: []` would blind every phone already in the field.
 *  An unknown top-level key, by contrast, is ignored by every old validator
 *  (this one rebuilds the object from known fields, so an old SERVER strips
 *  the block rather than choking on it — the client's own honest slot for
 *  that is 「this deployment doesn't mention my platform」). Additive-field
 *  first is the protocol law; this is that law applied to the manifest. */
export interface UpdateStorePlatform {
  version: string;
  notes_url: string | null;
  /** The store page a user can walk to (TestFlight invite / store listing).
   *  Optional: the news is real even while nobody has minted the link yet. */
  store_url: string | null;
}

export interface UpdateManifest {
  manifest_version: 1;
  generated_at: string;
  /** A mapping rather than two fixed fields: mac has to ship directly in phase
   *  one (release-three-phases §3), so adding `macos-arm64` must be additive,
   *  not a structural change. */
  platforms: Record<string, UpdatePlatform>;
  /** Optional — see UpdateStorePlatform. Absent and `{}` mean the same thing
   *  (no store-delivered platform is being announced), and the served JSON
   *  omits the key when the file omits it, so pre-existing manifests stay
   *  byte-for-byte what they were. */
  store_platforms?: Record<string, UpdateStorePlatform>;
}

export type ManifestVerdict =
  | { ok: true; manifest: UpdateManifest }
  /** `reason` is a machine-readable short code for ops to read. **Must never
   *  contain a file path** — the RV-32 lesson: /api/health's `script` once
   *  handed a Windows account name and install layout to anyone who asked. */
  | { ok: false; reason: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A pure validator —— no IO, so the whole shape-rule set can be unit tested
 *  with no filesystem at all.
 *
 *  It **rejects** rather than **patches**: a bad manifest quietly filled in
 *  with default values would reach the client looking "normal". Every return
 *  here is one refusal to publish. */
export function validateUpdateManifest(raw: unknown): ManifestVerdict {
  if (!isObject(raw)) return { ok: false, reason: 'not_an_object' };
  if (raw.manifest_version !== 1) return { ok: false, reason: 'unsupported_manifest_version' };
  if (typeof raw.generated_at !== 'string' || raw.generated_at.trim() === '') {
    return { ok: false, reason: 'missing_generated_at' };
  }
  if (!isObject(raw.platforms)) return { ok: false, reason: 'missing_platforms' };
  const platformKeys = Object.keys(raw.platforms);
  // An empty platforms object is the most dangerous kind of "valid": the client
  // would read it as "no platform has an update". That is not something we
  // know — what we know is that this manifest has no content.
  if (platformKeys.length === 0) return { ok: false, reason: 'empty_platforms' };

  const platforms: Record<string, UpdatePlatform> = {};
  for (const key of platformKeys) {
    if (!PLATFORM_RE.test(key)) return { ok: false, reason: `bad_platform_key:${key}` };
    const p = (raw.platforms as Record<string, unknown>)[key];
    if (!isObject(p)) return { ok: false, reason: `bad_platform:${key}` };
    if (typeof p.version !== 'string' || !VERSION_RE.test(p.version)) {
      return { ok: false, reason: `bad_version:${key}` };
    }
    if (p.notes_url !== null && typeof p.notes_url !== 'string') {
      return { ok: false, reason: `bad_notes_url:${key}` };
    }
    if (p.notes_url !== null && !isHttpUrl(p.notes_url)) {
      return { ok: false, reason: `bad_notes_url:${key}` };
    }
    if (!Array.isArray(p.artifacts) || p.artifacts.length === 0) {
      return { ok: false, reason: `empty_artifacts:${key}` };
    }
    const artifacts: UpdateArtifact[] = [];
    for (const a of p.artifacts) {
      if (!isObject(a)) return { ok: false, reason: `bad_artifact:${key}` };
      if (typeof a.kind !== 'string' || a.kind.trim() === '') return { ok: false, reason: `bad_kind:${key}` };
      if (a.locale !== null && typeof a.locale !== 'string') return { ok: false, reason: `bad_locale:${key}` };
      if (typeof a.filename !== 'string' || a.filename.trim() === '') {
        return { ok: false, reason: `bad_filename:${key}` };
      }
      // The client will use this name to write to disk in its own download
      // directory. `..`/`/`/`\` would let a tampered manifest direct the
      // client to write a file outside that directory — that is not "the
      // client's own job to be careful about", it is a shape this contract
      // should never have allowed in the first place (rejecting at the
      // boundary beats every call site being careful on its own).
      if (/[\\/]/.test(a.filename) || a.filename.includes('..')) {
        return { ok: false, reason: `unsafe_filename:${key}` };
      }
      // 🔴 Hash gate ②. Empty string, uppercase, truncated, or missing all die here.
      if (typeof a.sha256 !== 'string' || !SHA256_RE.test(a.sha256)) {
        return { ok: false, reason: `bad_sha256:${key}:${a.filename}` };
      }
      if (typeof a.url !== 'string' || !isHttpUrl(a.url)) {
        return { ok: false, reason: `bad_url:${key}:${a.filename}` };
      }
      if (typeof a.size !== 'number' || !Number.isInteger(a.size) || a.size <= 0) {
        return { ok: false, reason: `bad_size:${key}:${a.filename}` };
      }
      artifacts.push({
        kind: a.kind,
        locale: a.locale,
        filename: a.filename,
        url: a.url,
        sha256: a.sha256,
        size: a.size,
      });
    }
    platforms[key] = { version: p.version, notes_url: p.notes_url, artifacts };
  }

  // The optional store block. Same posture as everything above — reject, never
  // patch — because a store entry with a mangled version would make a phone
  // compare against garbage and say something it cannot back.
  let storePlatforms: Record<string, UpdateStorePlatform> | undefined;
  if (raw.store_platforms !== undefined && raw.store_platforms !== null) {
    if (!isObject(raw.store_platforms)) return { ok: false, reason: 'bad_store_platforms' };
    storePlatforms = {};
    for (const key of Object.keys(raw.store_platforms)) {
      if (!PLATFORM_RE.test(key)) return { ok: false, reason: `bad_store_platform_key:${key}` };
      const p = (raw.store_platforms as Record<string, unknown>)[key];
      if (!isObject(p)) return { ok: false, reason: `bad_store_platform:${key}` };
      if (typeof p.version !== 'string' || !VERSION_RE.test(p.version)) {
        return { ok: false, reason: `bad_store_version:${key}` };
      }
      if (p.notes_url !== null && (typeof p.notes_url !== 'string' || !isHttpUrl(p.notes_url))) {
        return { ok: false, reason: `bad_store_notes_url:${key}` };
      }
      if (p.store_url !== null && (typeof p.store_url !== 'string' || !isHttpUrl(p.store_url))) {
        return { ok: false, reason: `bad_store_url:${key}` };
      }
      storePlatforms[key] = { version: p.version, notes_url: p.notes_url, store_url: p.store_url };
    }
  }

  return {
    ok: true,
    manifest: {
      manifest_version: 1,
      generated_at: raw.generated_at,
      platforms,
      // Only present when the file carries it: JSON.stringify drops an
      // undefined field, so old manifests keep serving unchanged bytes.
      ...(storePlatforms !== undefined ? { store_platforms: storePlatforms } : {}),
    },
  };
}

/** Absolute http(s) URL, no other scheme accepted.
 *  owner's exact words were "the link may be some other URL" — that means
 *  "possibly on another host", not "possibly anything at all". `file:` would
 *  let a tampered manifest point the client at a local file. */
function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface UpdateRoutesDeps {
  /** Absolute path to the manifest file. Passed in by bootstrap from
   *  FLOWMIC_UPDATE_MANIFEST_PATH —— this dep's mere presence already means
   *  "this deployment provides an update manifest". */
  manifestPath: string;
  /** Test seam. Production passes nothing ⇒ falls through to the fs
   *  implementation below.
   *  ⚠️ It is **not** a friendly no-op default: the default genuinely reads
   *  disk, and throws if it cannot.
   *  (volume-13 §7 F1 ②: a DI default must never be a friendly empty
   *  implementation — it must be either the real thing or a throw.) */
  readFile?: (path: string) => string;
  /** Same as above —— used for the cheap "has the file changed" check. */
  statFile?: (path: string) => { mtimeMs: number; size: number };
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  verdict: ManifestVerdict;
}

/** One cache per server, held in the closure —— constructing a fresh one per
 *  request is equivalent to having no cache at all
 *  (the same ReleaseSuppression trap as bootstrap.ts:126, router.ts:197-199). */
export function makeUpdateRoutes(deps: UpdateRoutesDeps): (req: IncomingMessage, res: ServerResponse) => boolean {
  const readFile = deps.readFile ?? ((p: string): string => readFileSync(p, 'utf8'));
  const statFile =
    deps.statFile ??
    ((p: string): { mtimeMs: number; size: number } => {
      const s = statSync(p);
      return { mtimeMs: s.mtimeMs, size: s.size };
    });

  // mtime+size as the judging criterion rather than a TTL: once ops finishes
  // editing the file it should take effect **immediately**. A 5-minute TTL
  // would create an untraceable "I just updated the manifest, why doesn't the
  // client see it yet" problem, and the IO it saves is worthless at a
  // once-per-24-hours check frequency anyway.
  let cache: CacheEntry | null = null;

  return (req, res): boolean => {
    const url = (req.url ?? '/').split('?')[0];
    if (url !== UPDATE_MANIFEST_PATH) return false;
    if ((req.method ?? 'GET') !== 'GET') {
      // Say so, rather than returning false and letting it masquerade as "no such route".
      res.setHeader('allow', 'GET');
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return true;
    }

    let verdict: ManifestVerdict;
    try {
      const st = statFile(deps.manifestPath);
      if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
        verdict = cache.verdict;
      } else {
        // JSON.parse failing and shape-validation failing are two different
        // diagnoses, so report them separately: "ops hand-edited the file and
        // broke a comma" and "the manifest has an empty sha256" need to be
        // distinguishable.
        let parsed: unknown;
        let parseOk = true;
        try {
          parsed = JSON.parse(readFile(deps.manifestPath));
        } catch {
          parseOk = false;
        }
        verdict = parseOk ? validateUpdateManifest(parsed) : { ok: false, reason: 'unparsable_json' };
        cache = { mtimeMs: st.mtimeMs, size: st.size, verdict };
      }
    } catch {
      // File missing / unreadable / permission denied. **Not cached**: ops
      // putting the file back should take effect immediately, and when even
      // stat fails we have nothing to use as a cache key anyway.
      verdict = { ok: false, reason: 'manifest_unreadable' };
    }

    // The check interval is 24 hours; caching saves not one cent, and it
    // would only create an "I just shipped a release, why hasn't the client
    // been notified yet" problem.
    res.setHeader('cache-control', 'no-store');

    if (!verdict.ok) {
      // 🔴 503, not 200 + an empty manifest. Unknown ≠ latest.
      sendJson(res, 503, { error: 'UPDATE_MANIFEST_UNAVAILABLE', detail: verdict.reason });
      return true;
    }
    sendJson(res, 200, verdict.manifest);
    return true;
  };
}
