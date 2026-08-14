// Card UP-10 — does the download center actually HAVE the bytes this manifest is
// about to point every client at?
//
// ── the hole this closes ────────────────────────────────────────────────────
//
// scripts/build-update-manifest.mjs reads ./publish, recomputes each artifact's
// sha256 from the local file, composes a URL, and writes update-manifest.json.
// Every one of those steps is honest about the thing it measures — and not one
// of them ever asks the SITE anything. The script's own header used to say so
// plainly: 「这条脚本拦不住它 —— 它是流程约束，写在发布 runbook 里」.
//
// So "artifacts before manifest" held only WITHIN a single publish run, by call
// order. Run the manifest step alone — after a failed upload, before an upload,
// against a site that rejected the publish key, or in a round where somebody
// uploaded only some of the files — and it emits a perfectly well-formed
// manifest full of URLs that dereference to nothing. That has already happened
// once; it is why this card exists.
//
// 🔴 The two failure modes are not equally loud, and that asymmetry is the whole
// argument for checking at all. It was measured in commit 25904fa:
//
//     404  /dl/flowmic/release/FlowMic-0.2.58-release.apk
//     200  /files/flowmic/release/0.2.58/FlowMic-0.2.58-release.apk
//
//   · WRONG BYTES at a live URL → the client computes sha256, sees the mismatch,
//     and REPORTS it. Loud. The user learns the update is broken.
//   · A 404 → the in-app updater quietly does nothing at all. Silent. The user
//     learns nothing, and neither does anyone else, until someone wonders why
//     nobody has upgraded.
//
// The quieter failure is the one the local-only check cannot see, because it is
// not a property of the local file. It is a property of the site.
//
// ── why this asks for the BYTES and not merely for a status code ────────────
//
// A HEAD request, or a GET whose body is thrown away, answers "is something
// there?". The manifest does not claim something is there — it claims THIS
// FILE, with THIS sha256, is there. Those are different claims and the weaker
// one must not be dressed as the stronger (the argument
// scripts/apk-self-update-marker.mjs makes about attestations, applied to a URL).
//
// A stale artifact left at a version-pinned path from an earlier round answers
// 200, has the right name, and is the wrong file. Only downloading and hashing
// separates it from the right one — so that is what happens here: the response
// body is streamed through sha256 and counted, and both must equal what the
// local file in ./publish measured.
//
// ── 🔴 REDIRECTS ARE FOLLOWED, and the final answer is what counts ──────────
//
// The `/dl/` shape 302s to the versioned path. The current URL shape is already
// version-pinned so it should not redirect at all, but "should not" is an
// assumption about a site we do not control, and an assumption is what this file
// exists to remove. `redirect: 'follow'` is explicit rather than inherited from
// the default, and the final URL is recorded and printed on success — a URL that
// silently starts redirecting somewhere new is something an operator should see
// in the log, not something that gets absorbed.
//
// ── the four verdicts, in the order they are decided ────────────────────────
//
// 🔴 The ORDER is the contract, and it is the same contract UP-9's scanner
// carries: "I could not ask" must NEVER be reported as "the answer is no". They
// demand opposite actions, and the wrong one is expensive in both directions —
// re-uploading artifacts that are already correct, or shrugging at a genuinely
// missing file because the network looked flaky.
//
//   'unreachable'       the request produced no answer (refused, timed out, DNS,
//                       the body broke off mid-download). Says NOTHING about
//                       whether the artifact is published. The check did not run.
//   'not-found'         an answer arrived and it was not 200. The URL is dead.
//   'content-mismatch'  200, but the bytes are not the local file's bytes.
//                       Re-uploading is the action; "is it uploaded" is already
//                       answered, so this must not read like a 404.
//   'ok'                200, byte count and sha256 both equal the local file.
//
// ── on the escape hatch ─────────────────────────────────────────────────────
//
// UP-9's gate has no bypass, deliberately, and the reasoning there is sound: the
// thing it inspects is a local file, always present, always inspectable, so a
// skip could only ever mean "do not look". This gate is different in one respect
// that actually matters — it depends on a NETWORK, and a machine with no route
// to the download center cannot run it at all. Refusing to emit forever on a
// developer's offline machine would push people to delete the check rather than
// use it, which is the outcome a gate must never engineer.
//
// So --skip-remote-verify exists, and it is built to be impossible to use by
// accident: it is opt-in, never a default, never inferred from a failure (an
// 'unreachable' verdict does NOT silently downgrade into a skip — that would
// make the flag redundant and the gate meaningless), and it prints a banner that
// states exactly what was not verified. It is for offline drills. It is not a
// way past a red check: a red check means the site and ./publish disagree, and
// shipping that disagreement is precisely what breaks in-app update.
//
// ── 🔴 KNOWN UNCOVERED SURFACE, stated rather than left to be discovered ────
//
// · `notes_url` is composed by the same builder, from the same base, and is NOT
//   verified here. Its failure is real but of a different order (release notes
//   404 while the update still installs), and widening the gate silently would
//   be implying coverage it does not have. Whoever wants it can pass it through
//   verifyRemoteArtifact() — there is no local sha256 for it, so it needs a
//   status-only variant, and a status-only check is a weaker claim that should
//   be named as one rather than blended in with these.
// · Nothing here stamps the manifest with "remotely verified". That would be an
//   additive field on a cross-language contract read by server-core and the
//   desktop Rust updater, and this card did not carry authorisation to change
//   that shape. The verification is a gate, not a payload.

import { createHash } from 'node:crypto';

/** Opt-in, never a default. Spelled once, here, so the flag the builder parses,
 *  the banner that warns about it, and the refusal text that mentions it cannot
 *  drift into three different strings. */
export const REMOTE_VERIFY_SKIP_FLAG = '--skip-remote-verify';

/** Generous on purpose. The download center is on the LAN and these transfers
 *  run at wire speed, so the only thing this bounds is a hang: a dropped SYN
 *  behind a firewall, or a connection that opens and then stalls. Too tight and
 *  a legitimately slow link produces 'unreachable', which is a verdict that says
 *  "I could not ask" about a site that was answering perfectly well. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 180_000;

/** Transport failures arrive wrapped and mostly unreadable (`TypeError: fetch
 *  failed`, cause underneath). The operator needs the CODE — ECONNREFUSED and
 *  ETIMEDOUT point at different problems — so it is dug out rather than shown a
 *  message that names only the API that gave up.
 *  Exported for scripts/update-manifest-lib.mjs (ruling ① 2026-08-10), whose
 *  live-manifest fetch owes the operator the same code — one digger, not two. */
export function describeTransportError(e, timeoutMs) {
  if (e?.name === 'TimeoutError') return `no answer within ${timeoutMs} ms`;
  if (e?.name === 'AbortError') return 'the request was aborted';
  const code = e?.cause?.code ?? e?.code;
  const detail = e?.cause?.message ?? e?.message ?? String(e);
  return code ? `${code} — ${detail}` : detail;
}

/**
 * Ask the site for one artifact and compare what comes back with the local file.
 *
 * @param {{url:string, sha256:string, size:number,
 *          fetchImpl?:typeof fetch, timeoutMs?:number}} spec
 * @returns {Promise<{verdict:'ok'|'not-found'|'content-mismatch'|'unreachable',
 *   url:string, finalUrl:string|null, redirected:boolean, status:number|null,
 *   expectedSha256:string, expectedSize:number,
 *   remoteSha256:string|null, remoteSize:number|null, error:string|null}>}
 *
 * Never throws. A gate that crashes produces a stack trace where it owes a
 * verdict — and worse here than usual, since the most likely cause of a throw is
 * exactly the network condition that must be reported as 'unreachable' rather
 * than as anything about the artifact.
 */
export async function verifyRemoteArtifact({
  url,
  sha256,
  size,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_REMOTE_TIMEOUT_MS,
}) {
  const base = {
    url,
    finalUrl: null,
    redirected: false,
    status: null,
    expectedSha256: sha256,
    expectedSize: size,
    remoteSha256: null,
    remoteSize: null,
    error: null,
  };

  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ...base, verdict: 'unreachable', error: describeTransportError(e, timeoutMs) };
  }

  const seen = {
    ...base,
    // `res.url` is the FINAL url after redirects. Empty only for exotic impls.
    finalUrl: typeof res.url === 'string' && res.url.length > 0 ? res.url : url,
    redirected: res.redirected === true,
    status: res.status,
  };

  if (res.status !== 200) {
    // Release the socket. An abandoned body keeps a keep-alive connection pinned
    // and, in a run of several artifacts, leaks one per refusal.
    try { await res.body?.cancel(); } catch { /* already gone */ }
    return { ...seen, verdict: 'not-found' };
  }
  if (!res.body) {
    return { ...seen, verdict: 'unreachable', error: 'a 200 with no body to read' };
  }

  // Streamed, not buffered: these artifacts run to ~90 MB and there is no reason
  // to hold one in memory to hash it.
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length;
      hash.update(chunk);
    }
  } catch (e) {
    // 🔴 A truncated download is 'unreachable', NOT 'content-mismatch'. The bytes
    // that did arrive may have been perfectly correct; what failed was the
    // reading of them. Calling that a mismatch would send someone to re-upload a
    // file that was never wrong.
    return {
      ...seen,
      verdict: 'unreachable',
      remoteSize: bytes,
      error: `the download broke off after ${bytes} byte(s): ${describeTransportError(e, timeoutMs)}`,
    };
  }

  const measured = { ...seen, remoteSize: bytes, remoteSha256: hash.digest('hex') };
  if (bytes !== size || measured.remoteSha256 !== sha256) {
    return { ...measured, verdict: 'content-mismatch' };
  }
  return { ...measured, verdict: 'ok' };
}

/** The refusal text for each non-ok verdict. Separated from the builder so the
 *  drill can assert on the exact words an operator reads at 2am — the whole value
 *  of a red gate is that its message names the ACTION, and these three actions
 *  are mutually exclusive: fix the network / upload the artifacts / re-upload
 *  the artifacts. */
export function remoteRefusalMessage(filename, r) {
  if (r.verdict === 'unreachable') {
    return (
      `${filename}: COULD NOT ASK THE DOWNLOAD CENTER — GET ${r.url} never produced ` +
      `a usable answer (${r.error}). This says NOTHING about whether the artifact is ` +
      `published: the check did not run. Do NOT read it as "the file is missing" and ` +
      `do NOT re-upload on the strength of it — those are answers to a question this ` +
      `check failed to ask. Restore the route to the download center and re-run. If ` +
      `you are genuinely offline and running a drill, ${REMOTE_VERIFY_SKIP_FLAG} exists ` +
      `for that and for nothing else; a manifest produced under it has NOT been ` +
      `verified against the site.`
    );
  }
  if (r.verdict === 'not-found') {
    const via = r.redirected ? ` (after a redirect to ${r.finalUrl})` : '';
    return (
      `${filename}: NOT ON THE DOWNLOAD CENTER — GET ${r.url} answered ` +
      `${r.status}${via}. Writing this manifest would hand every client a URL that ` +
      `dereferences to nothing, and an in-app updater pointed at a 404 does nothing ` +
      `and says nothing — the silent half of the two failure modes measured in ` +
      `25904fa. The artifacts have not been uploaded (or not all of them): upload ` +
      `them first, then re-run this. 「先产物后清单」is what this refusal is ` +
      `enforcing — it used to be an oral rule and this is the mechanism that means ` +
      `nobody has to remember it.`
    );
  }
  const sameSize = r.remoteSize === r.expectedSize;
  const shape = sameSize
    ? `the same length but different bytes (${r.expectedSize} bytes both sides) — a ` +
      `corrupted or genuinely different build, not a truncated transfer`
    : `a different length entirely (local ${r.expectedSize} bytes / remote ${r.remoteSize} bytes) — ` +
      `most likely a stale upload from an earlier round sitting at this version's path, ` +
      `or a transfer that was cut short`;
  return (
    `${filename}: THE SITE IS SERVING DIFFERENT BYTES — GET ${r.url} answered 200, but ` +
    `what came back is not the file in ./publish. local sha256 ` +
    `${r.expectedSha256.slice(0, 12)}… / remote sha256 ${r.remoteSha256.slice(0, 12)}…: ` +
    `${shape}. 🔴 This is NOT a 404 — the URL resolves, so "have they been uploaded ` +
    `yet" is already answered YES and uploading again is the action, not uploading ` +
    `for the first time. Left alone, every client would hash these remote bytes ` +
    `against the manifest's sha256 and refuse to install: the update would be ` +
    `permanently broken rather than merely absent. Re-upload and re-run.`
  );
}

/**
 * GATE: every artifact URL in the composed manifest resolves to the local bytes.
 *
 * @param {{platforms:object, fetchImpl?:typeof fetch, timeoutMs?:number,
 *          fail:(m:string)=>void, ok:(m:string)=>void}} io
 * @returns {Promise<{checked:number, refused:number, results:object[]}>}
 *
 * Sequential rather than concurrent, on purpose. There are a handful of
 * artifacts, they are large, and the log is read top to bottom by someone
 * deciding what to do — interleaved progress from six parallel downloads buys a
 * few seconds and costs the one property that matters when this goes red.
 *
 * Returns a count instead of exiting: the builder owns the exit, the same way
 * every other gate in that script reports through fail() and lets one place
 * decide. Every artifact is checked even after the first refusal, so one run
 * tells the operator everything that is wrong rather than one thing at a time.
 */
export async function gateRemoteArtifacts({ platforms, fetchImpl = fetch, timeoutMs, fail, ok }) {
  const results = [];
  let refused = 0;
  for (const [platform, p] of Object.entries(platforms)) {
    for (const artifact of p.artifacts) {
      const r = await verifyRemoteArtifact({
        url: artifact.url,
        sha256: artifact.sha256,
        size: artifact.size,
        fetchImpl,
        timeoutMs,
      });
      results.push({ platform, filename: artifact.filename, ...r });
      if (r.verdict === 'ok') {
        const via = r.redirected ? `  [followed a redirect → ${r.finalUrl}]` : '';
        ok(
          `${platform}  ${artifact.filename}  逐字节相符 on the site (${r.remoteSize} bytes, ` +
            `sha256 ${r.remoteSha256.slice(0, 12)}…)${via}`
        );
      } else {
        refused += 1;
        fail(remoteRefusalMessage(artifact.filename, r));
      }
    }
  }
  return { checked: results.length, refused, results };
}

/** The banner --skip-remote-verify prints. Loud by construction: it names what
 *  was not done, what could therefore be wrong, and the one situation the flag
 *  is for. Kept here beside the flag so a future edit cannot move the flag and
 *  leave the warning behind. */
export function remoteVerifySkipBanner() {
  return [
    '',
    `🔴 ${REMOTE_VERIFY_SKIP_FLAG}: this run's URLs were not verified against the download center.`,
    '   No step asked the site whether these files exist or whether the bytes match —',
    '   this manifest may point at 404s, which is exactly why this gate exists (it has already happened once:',
    '   artifacts were not uploaded yet, and the manifest was generated straight from ./publish).',
    '   The only legitimate use is 离线演练. It is 不是「红了绕过去」的路子 —',
    '   red means the site bytes disagree with ./publish, and shipping that disagreement is how in-app update breaks.',
    '',
  ];
}
