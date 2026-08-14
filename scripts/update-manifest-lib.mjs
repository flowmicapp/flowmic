// scripts/update-manifest-lib.mjs — shared facts about the update manifest.
//
// WHY THIS MODULE EXISTS (owner ruling ① + its companion gate, 2026-08-10 —
// docs/decisions/2026-08-10-owner-seven-rulings-after-0261.md):
//
//   ① manifest semantics = "latest DOWNLOADABLE per platform", which means the
//     builder (scripts/build-update-manifest.mjs) must ask the LIVE endpoint
//     what it currently advertises and merge, instead of emitting only what
//     this round built. Measured cost of the old semantics: 0.2.61 shipped
//     windows+android only and `macos-arm64` — still live at 0.2.59 —
//     vanished from the manifest wholesale.
//   ①-companion: publish.mjs must END by asserting the PUBLIC endpoint
//     advertises this round's version for every platform that shipped —
//     measured failure (device-line handoff §8-1): every artifact gate was
//     green while /api/updates/latest kept advertising 0.2.59.
//
// Both consumers need the same three facts — "which platform is this artifact
// for" (classify), "which artifacts belong to this round" (isRoundArtifactName),
// and "what does the live endpoint say" (fetchLiveManifest) — and the builder
// is ALL top-level statements, so nothing can import from it without running
// it. Hence this module: pure at import (zero side effects, zero I/O), the
// same argument scripts/verify-remote-artifact.mjs makes for itself, so the
// drills can DRIVE the real functions against a loopback server instead of
// re-deriving the judgment. A test that re-implements its subject proves only
// that the test agrees with itself.

import { refuseDirectRun } from './module-entrypoint-guard.mjs';
import { describeTransportError } from './verify-remote-artifact.mjs';
// The portable-zip naming contract has one owner = scripts/pack-portable.mjs (it both produces the name and recognizes it).
// Import here rather than copy the regex: two hand-written copies of the same regex are 「同一个问题两个答案」.
// PORTABLE_PLATFORMS likewise comes from there, rather than being maintained a second time here: two hand-maintained
// copies of the same table will drift (the version-sync FACES table is the precedent). Add a platform in that one place.
import { PORTABLE_PLATFORMS, isPortableZipName, parsePortableZipName } from './pack-portable.mjs';

refuseDirectRun(
  import.meta.url,
  'node scripts/build-update-manifest.mjs  (build/merge)  or  node scripts/verify-live-update-manifest.mjs  (gate)',
);

// ── which artifacts belong to a round ───────────────────────────────────────
//
// Only accept this version's artifacts. Mixing in a cross-version leftover is
// the manifest-shaped version of the old 「装了哪一版」 problem
// (publish.mjs:266-268 handles the same fact).
// ⚠️ Portable zips are accepted by the **narrow** isPortableZipName() predicate,
// not a blanket `\.zip$`: ./publish is an artifact area shared across windows
// (measured 2026-08-08: during this card's work another window dropped
// FlowMic-<version>-macos-arm64.zip in), and a blanket match would drag
// something someone else has not delivered yet into classify(), which then
// **refuses the whole manifest** because it cannot classify it — that would
// make this generator go red for a reason that has nothing to do with it.
export function isRoundArtifactName(name, version) {
  return (/\.(msi|apk)$/i.test(name) || isPortableZipName(name)) && name.includes(version);
}

/** Artifact → which platform it belongs to, what kind it is, what locale.
 *  filename is the only input — and publish.mjs guarantees the version in the
 *  filename comes from the root package.json (MSI filtered by `f.includes(VERSION)`;
 *  APK is only renamed after aapt reads back the real versionName), so this
 *  does not need to guess 「这是哪一版」 a second time. */
export function classify(filename) {
  if (filename.endsWith('.msi')) {
    // FlowMic_0.2.48_x64_zh-CN.msi — one per locale【measured: two under bundle/msi every version】
    const m = filename.match(/_x64_([A-Za-z-]+)\.msi$/);
    return { platform: 'windows-x64', kind: 'msi', locale: m ? m[1] : null };
  }
  if (filename.endsWith('.apk')) {
    return { platform: 'android', kind: 'apk', locale: null };
  }
  // ── portable bundle (card UP-1, 2026-08-08) ──────────────────────────────
  //
  // 🔴 `kind` is a **cross-language contract**, and **nothing binds its faces
  // together** — the same-shaped account as the protocol error-code registry vs
  // the phone's own copy table (CLAUDE.md has the original wording).
  // So this names, one by one, the faces that **actually exist today** (by
  // symbol, not by line number: a cross-territory line number goes stale the
  // moment another window edits it, and then the unrelated window goes red):
  //   · producer = this function classify(), the only place in the repo that assigns kind;
  //   · shape gate = validateUpdateManifest() in apps/server-core/src/http/update-routes.ts
  //     — it only requires kind to be a non-empty string, **does not enumerate values**
  //     (its doc comment lists `dmg` as a future value), so 'portable-zip' passes
  //     naturally; no need to touch that file (and should not: that is another territory);
  //   · the place server-core tests hard-code a kind literal = goodManifest() in
  //     apps/server-core/test/update-manifest-routes.test.ts, one case of which
  //     specifically pins 「不认识的 kind 原样透传」;
  //   · **the desktop (Rust) consumer already exists** (commit 353008a, card UP-3a):
  //     `apps/desktop/src-tauri/src/update/` — `fetch.rs`'s `interpret()` reads this
  //     endpoint, `download.rs`'s `UpdatePackage::kind()` hands kind out as-is,
  //     and `manifest.rs` itself writes that kind is an **open set**.
  //
  // 🔴 The line above is a **correction**; the original was 「桌面与手机的更新客户端今天一块砖都没有」.
  // That sentence was true when written, became false about forty minutes later via 353008a,
  // and would not have changed on its own — textbook anti-façade ④, this window's third hit.
  //
  // ⚠️ So this roster **no longer uses a "what exists" wording**: that wording goes
  // stale every time a consumer is added. For the current answer, run this (it does
  // not go stale itself):
  //       grep -rn "portable-zip" --include=*.rs --include=*.dart --include=*.ts --include=*.mjs .
  // 〔measured 2026-08-08 this machine dev-pc-a: hits this file (the producer), the
  //  desktop update module, and several files on the phone side. ⚠️ Anyone who runs
  //  that grep will see the phone hits, but when this paragraph was written
  //  **they were all still untracked** (`git ls-files --error-unmatch` does not
  //  recognize them; another window is in flight)
  //  ⇒ this deliberately does not name their symbols: naming a coordinate that is
  //  not yet committed is writing the next 「过期的真话」, which is exactly the
  //  disease this paragraph is here to fix. Once they land, grep will count them
  //  on its own — which is also why this uses "one grep" rather than "a roster":
  //  a roster goes stale every time a consumer is added, and the first time this
  //  paragraph was written wrong, only about forty minutes had passed.〕
  //
  // 🔴 The thing that truly has not changed: **there is still no mechanism that
  // binds these faces together**. Cross-language kind is remembered by people,
  // and that is the same unpaid account as the protocol error-code registry vs
  // the phone copy table.
  //
  // Platform values go through a **whitelist**, not a wildcard parse of the
  // filename. The two mistakes have asymmetric cost: a whitelist meeting an
  // unseen platform ⇒ the caller above refuses the whole manifest and names
  // this file (loud, no bad data); a wildcard parse meeting a misspelled
  // filename (`-portable-windwos-x64.zip`) ⇒ the manifest quietly grows a
  // platform key that serves nobody (quiet, bad data). A loud failure beats
  // quiet bad data. The roster itself is PORTABLE_PLATFORMS in pack-portable.mjs
  // (the only copy).
  //
  // 🔴 Card UP-6 (2026-08-08): macos-arm64 / linux-x64 are on the roster; `kind`
  // is still 'portable-zip' — first-responsible ruling 「platform 说怎么换，kind 说它是原地替换型」,
  // **deliberately no separate kind for mac**.
  // ⚠️ Downstream **must know** this: under this one `portable-zip` kind sit
  // **two different inner shapes** — the Windows copy unpacks to `FlowMic-portable/`,
  // the macOS copy unpacks to `FlowMic.app/`.
  // Whoever writes the UP-3 updater **must not assume the top-level directory
  // name is the same for every portable-zip**.
  const portable = parsePortableZipName(filename);
  if (portable) {
    if (!PORTABLE_PLATFORMS.has(portable.platform)) return null;
    return { platform: portable.platform, kind: 'portable-zip', locale: null };
  }
  return null;
}

// ── the live endpoint ───────────────────────────────────────────────────────

/** Env override so a loopback drill (and a staging check, should one ever
 *  exist) can point the whole mechanism somewhere else. Spelled once, here —
 *  the same one-spelling argument REMOTE_VERIFY_SKIP_FLAG makes. */
export const LIVE_MANIFEST_URL_ENV = 'FLOWMIC_LIVE_MANIFEST_URL';

/** The public "what is the latest FlowMic" endpoint. Clients always ask the
 *  official site (update-routes.ts: 「最新 FlowMic 是哪版」是个全局事实), so this
 *  is the ONE face both the merge and the end-of-publish gate must read.
 *
 *  ⚠️ NAMED MIRROR, drift risk stated: the host mirrors DEFAULT_SAAS_ENDPOINT
 *  (packages/protocol/src/constants.ts) and the path mirrors
 *  UPDATE_MANIFEST_PATH (apps/server-core/src/http/update-routes.ts). Scripts
 *  cannot import TypeScript, so this cannot be a real import — the same reason
 *  the mobile app mirrors protocol strings by hand. If either source moves,
 *  this string is where the copy goes stale. */
export function resolveLiveManifestUrl(env = process.env) {
  return env[LIVE_MANIFEST_URL_ENV] ?? 'https://flowmic.app/api/updates/latest';
}

/** The manifest is a few KB of JSON, not a 90 MB artifact — this bounds a hang,
 *  nothing else. Deliberately NOT DEFAULT_REMOTE_TIMEOUT_MS (180 s): that one is
 *  sized for streaming installers off the LAN download center. */
export const LIVE_MANIFEST_TIMEOUT_MS = 30_000;

/** Numeric x.y.z comparison — `0.2.9` < `0.2.10`, which string comparison gets
 *  wrong. Returns -1 / 0 / 1. Segments beyond three are ignored because the
 *  version faces this repo pins (bump-version.mjs) are strictly three-segment. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Light structural check on a fetched manifest.
 *
 *  The AUTHORITATIVE validator is validateUpdateManifest() in
 *  apps/server-core/src/http/update-routes.ts — a 200 from the relay has
 *  already passed it, because that route refuses (503) to serve anything that
 *  does not. This re-check exists for two reasons only: the URL is
 *  env-overridable (a drill server owes no such guarantee), and entries
 *  retained by the merge flow straight into gateRemoteArtifacts(), which
 *  needs url / sha256 / size to be present and sane to do its job. It checks
 *  the essentials it CONSUMES, not the full contract — re-deriving the whole
 *  server-side validator here would be a second answer to one question. */
function liteValidateManifest(raw) {
  if (!isObject(raw)) return { ok: false, reason: 'not_an_object' };
  if (!isObject(raw.platforms)) return { ok: false, reason: 'missing_platforms' };
  const keys = Object.keys(raw.platforms);
  if (keys.length === 0) return { ok: false, reason: 'empty_platforms' };
  for (const key of keys) {
    const p = raw.platforms[key];
    if (!isObject(p)) return { ok: false, reason: `bad_platform:${key}` };
    if (typeof p.version !== 'string' || !VERSION_RE.test(p.version)) {
      return { ok: false, reason: `bad_version:${key}` };
    }
    if (!Array.isArray(p.artifacts) || p.artifacts.length === 0) {
      return { ok: false, reason: `empty_artifacts:${key}` };
    }
    for (const a of p.artifacts) {
      if (!isObject(a)) return { ok: false, reason: `bad_artifact:${key}` };
      if (typeof a.filename !== 'string' || a.filename.trim() === '') {
        return { ok: false, reason: `bad_filename:${key}` };
      }
      if (typeof a.url !== 'string' || !/^https?:\/\//.test(a.url)) {
        return { ok: false, reason: `bad_url:${key}:${a.filename}` };
      }
      if (typeof a.sha256 !== 'string' || !SHA256_RE.test(a.sha256)) {
        return { ok: false, reason: `bad_sha256:${key}:${a.filename}` };
      }
      if (typeof a.size !== 'number' || !Number.isInteger(a.size) || a.size <= 0) {
        return { ok: false, reason: `bad_size:${key}:${a.filename}` };
      }
    }
  }
  return { ok: true };
}

/**
 * Ask the live endpoint what it currently advertises.
 *
 * @returns {Promise<{verdict:'ok'|'absent'|'invalid'|'unreachable',
 *   status:number|null, manifest:object|null, detail:string|null, error:string|null}>}
 *
 * The four verdicts carry the same contract UP-10's verifier carries — "I could
 * not ask" must NEVER be reported as "the answer is no":
 *
 *   'unreachable'  the request produced no answer. Says NOTHING about what is
 *                  live. The check did not run.
 *   'absent'       a DEFINITE answer that nothing usable is being served:
 *                  404 (route not mounted — no FLOWMIC_UPDATE_MANIFEST_PATH on
 *                  that deployment) or 503 (UPDATE_MANIFEST_UNAVAILABLE — the
 *                  file is missing / unreadable / rejected by the server-side
 *                  validator). Clients checking for updates get nothing.
 *   'invalid'      an answer arrived and this module cannot honestly consume it
 *                  (unexpected status, unparsable JSON, shape failure above).
 *   'ok'           200 with a consumable manifest.
 *
 * Never throws — same reasoning as verifyRemoteArtifact(): a gate that crashes
 * produces a stack trace where it owes a verdict.
 */
export async function fetchLiveManifest({
  url,
  fetchImpl = fetch,
  timeoutMs = LIVE_MANIFEST_TIMEOUT_MS,
}) {
  const base = { status: null, manifest: null, detail: null, error: null };
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ...base, verdict: 'unreachable', error: describeTransportError(e, timeoutMs) };
  }

  let text = '';
  try {
    text = await res.text();
  } catch (e) {
    return {
      ...base,
      verdict: 'unreachable',
      status: res.status,
      error: `the body broke off: ${describeTransportError(e, timeoutMs)}`,
    };
  }

  const seen = { ...base, status: res.status };
  if (res.status === 404 || res.status === 503) {
    // Both are the route ANSWERING "nothing usable here" — see the verdict table.
    let detail = null;
    try {
      const body = JSON.parse(text);
      detail = typeof body?.detail === 'string' ? body.detail : typeof body?.error === 'string' ? body.error : null;
    } catch { /* a plain 404 page has no JSON to offer */ }
    return { ...seen, verdict: 'absent', detail };
  }
  if (res.status !== 200) {
    return { ...seen, verdict: 'invalid', detail: `unexpected HTTP ${res.status}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...seen, verdict: 'invalid', detail: 'unparsable_json' };
  }
  const shape = liteValidateManifest(parsed);
  if (!shape.ok) return { ...seen, verdict: 'invalid', detail: shape.reason };
  return { ...seen, verdict: 'ok', manifest: parsed };
}

// ── ruling ①: the merge itself ──────────────────────────────────────────────

/**
 * Merge the live manifest's platforms into this round's `platforms` map,
 * IN PLACE — per platform, the higher version wins, and platforms absent from
 * this round keep their live entry verbatim (including their own notes_url:
 * it describes THEIR version, not this round's).
 *
 * Mutates rather than returns a new map, deliberately: the builder's remote
 * gate is pinned by the UP-10 drill as the literal
 * `gateRemoteArtifacts({ platforms, fail, ok })`, and feeding the MERGED set
 * through that same call is the whole point — a retained entry gets its bytes
 * re-verified against the download center every round, which is what makes
 * "latest DOWNLOADABLE" a measured claim instead of an assumed one.
 *
 * @returns {{retained: {platform:string, version:string}[],
 *            keptLiveNewer: {platform:string, live:string, built:string}[],
 *            superseded: {platform:string, from:string, to:string}[]}}
 */
export function mergeLivePlatforms({ platforms, liveManifest }) {
  const retained = [];
  const keptLiveNewer = [];
  const superseded = [];
  for (const [key, liveEntry] of Object.entries(liveManifest.platforms)) {
    const built = platforms[key];
    if (!built) {
      platforms[key] = liveEntry;
      retained.push({ platform: key, version: liveEntry.version });
    } else if (compareVersions(liveEntry.version, built.version) > 0) {
      // Live is NEWER than what this round built. That is a strange round
      // (publishing an older version than what is already advertised) — the
      // ruling's rule is 「同平台取较高版本」, so live wins, and the caller is
      // expected to say so loudly rather than let it pass as routine.
      platforms[key] = liveEntry;
      keptLiveNewer.push({ platform: key, live: liveEntry.version, built: built.version });
    } else {
      superseded.push({ platform: key, from: liveEntry.version, to: built.version });
    }
  }
  return { retained, keptLiveNewer, superseded };
}

// ── the ①-companion gate: does the live face advertise this round ───────────

/**
 * Pure judgment for the end-of-publish gate: given the platforms that shipped
 * artifacts this round, this round's version, and a fetchLiveManifest()
 * result, decide what an operator must be told.
 *
 * @param {{shipped:string[], version:string, fetched:object, url:string}} args
 * @returns {{failures:string[], okLines:string[]}}
 *
 * Every failure message names the ACTION, and the actions are mutually
 * exclusive — fix the route / deploy the manifest / stop and investigate —
 * because the whole value of a red gate is that its message tells a tired
 * operator which of those to do (the remoteRefusalMessage() precedent).
 */
export function gateShippedPlatformsLive({ shipped, version, fetched, url }) {
  const failures = [];
  const okLines = [];

  if (fetched.verdict === 'unreachable') {
    failures.push(
      `COULD NOT ASK the live update endpoint — GET ${url} produced no usable answer ` +
        `(${fetched.error}). This says NOTHING about what clients are being told: the check ` +
        `did not run, and a gate that cannot run is a FAILED gate, not a passed one. Do NOT ` +
        `read this as "the live manifest is stale" — that is an answer to a question this ` +
        `check failed to ask. Restore the route, then re-run ` +
        `node scripts/verify-live-update-manifest.mjs.`,
    );
    return { failures, okLines };
  }
  if (fetched.verdict === 'absent') {
    const detail = fetched.detail ? `, ${fetched.detail}` : '';
    failures.push(
      `the live endpoint serves NO usable manifest (GET ${url} → HTTP ${fetched.status}${detail}) ` +
        `while ${version} artifacts shipped this round. Every client checking for updates gets ` +
        `nothing at all. Generate the manifest (node scripts/build-update-manifest.mjs), deploy ` +
        `publish/update-manifest.json as /etc/flowmic-app/updates.json (production deploys ` +
        `belong to the device line — docs/FLEET.md), then re-run this gate.`,
    );
    return { failures, okLines };
  }
  if (fetched.verdict === 'invalid') {
    failures.push(
      `the live endpoint answered in a shape this gate cannot honestly consume ` +
        `(GET ${url} → HTTP ${fetched.status ?? '?'}, ${fetched.detail}). Inspect the response ` +
        `by hand before touching anything — deploying over a state you do not understand is ` +
        `how one incident becomes two.`,
    );
    return { failures, okLines };
  }

  for (const platform of shipped) {
    const entry = fetched.manifest.platforms[platform];
    if (!entry) {
      failures.push(
        `${platform}: shipped ${version} this round, but the live manifest has NO entry for it — ` +
          `clients on ${platform} are told nothing. Regenerate the manifest from this round's ` +
          `./publish (node scripts/build-update-manifest.mjs) and deploy it, then re-run.`,
      );
    } else if (entry.version === version) {
      okLines.push(`${platform}: live manifest advertises ${version}`);
    } else if (compareVersions(entry.version, version) < 0) {
      failures.push(
        `${platform}: shipped ${version} this round, but the live manifest still advertises ` +
          `${entry.version} — every ${platform} client asking "is there an update" is being told ` +
          `${entry.version} is the latest. This is the exact 0.2.61 P0 shape (all artifact gates ` +
          `green while the update service kept advertising the previous version). Regenerate the ` +
          `manifest (node scripts/build-update-manifest.mjs), deploy publish/update-manifest.json ` +
          `as /etc/flowmic-app/updates.json (device line — docs/FLEET.md), then re-run this gate.`,
      );
    } else {
      failures.push(
        `${platform}: live manifest advertises ${entry.version}, which is NEWER than this ` +
          `round's ${version}. This round is publishing artifacts for a version the live face has ` +
          `already moved past — this is not a deploy-the-manifest situation. Stop and establish ` +
          `which round is actually the latest before touching anything.`,
      );
    }
  }
  return { failures, okLines };
}
