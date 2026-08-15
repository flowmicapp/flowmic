// FlowMic in-app update manifest generator (L-④, owner 2026-08-02).
//
// SPEC-REF:
//   docs/decisions/2026-08-02-in-app-update-both-ends.md
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §1 (contract) / §2.2 ① (hash gate, first stage)
//   apps/server-core/src/http/update-routes.ts (endpoint, the second stage of the same shape rules)
//   docs/decisions/2026-08-10-owner-seven-rulings-after-0261.md ① (manifest semantics)
//
// Reads artifacts in ./publish that **have already been verified by publish.mjs** + their .sha256 sidecars,
// and writes publish/update-manifest.json — this file's contents are exactly what both clients
// receive when they GET /api/updates/latest.
//
// Since owner ruling ① (2026-08-10) the manifest's meaning is "latest
// DOWNLOADABLE per platform", not "what this round built": the script fetches
// the LIVE manifest and merges — a platform with no artifact in this round's
// ./publish keeps its live entry (re-verified byte-for-byte below like
// everything else), and a platform present in both takes the higher version.
// Measured cost of the old semantics: 0.2.61 shipped windows+android only and
// macos-arm64 (live at 0.2.59) vanished from the manifest wholesale.
//
// Two ways to run it, both valid:
//        node scripts/build-update-manifest.mjs           # standalone, writes the file
//        node scripts/build-update-manifest.mjs --check   # verify only, do not write
//    ⚠️ **Both ways still do the remote verification** (闸 ②, card UP-10). `--check` especially
//    must not be an exception: it answers "can this manifest be generated", and **a manifest
//    that points at 404s does not count as generable**.
//    Offline drills add `--skip-remote-verify` (off by default; prints a loud banner).
//    And publish.mjs chains it via `--with-manifest` (called **only after the LAN download
//    center upload has succeeded**, so 「先产物后清单」 is a call-order fact in that file,
//    not an oral rule).
//
// 🔴 This paragraph originally said 「**本轮刻意不接进 publish.mjs**……接进 publish.mjs 是一行
//    execFileSync，等 0.2.49 发完再动」. That sentence was true when written, **today it is false**:
//    `--with-manifest` has long been wired in〔measured 2026-08-08, this machine dev-pc-a:
//    `grep -n with-manifest scripts/publish.mjs` hits the `WITH_MANIFEST` constant and
//    the trailing `execFileSync(..., 'build-update-manifest.mjs')`〕.
//    The original is not kept: it described a "not yet done" state, and that work is finished —
//    leaving it would only make the next person think they still have to wire it themselves.
//    **A stale truth is more dangerous than an obvious falsehood,
//    because it reads as if someone already checked.**
//
// ── Why a script produces this instead of hand-maintaining it ──────────────
//
// A hand-maintained manifest will drift, and it drifts in the worst way: it points at a file
// that does not exist, or carries a sha256 that does not match, and then every client refuses
// to install — a "updates are broken" failure that looks locally like everything is fine.
// Same shape as the version-sync rule: **two means answering the same question is what bites**.
// The publish chain has already computed the hashes and already uploaded RELEASE_NOTES;
// this step only structures facts that already exist.
//
// ── 🔴 Hash gate, stage ① ──────────────────────────────────────────────────
//
// Artifact has no .sha256 sidecar / sidecar does not match the file ⇒ **the whole manifest
// is not produced**, rather than emitting an entry with no hash. Reason: the download center
// is HTTP-only, and stage-one Windows is unsigned ⇒ until code signing lands, sha256 is the
// only integrity guarantee for the installer.
// A manifest entry with no sha256 is quietly taking that only gate off.
//
// ── 🔴 Ordering iron rule ──────────────────────────────────────────────────
//
// **Upload the artifacts first, then update the manifest.** The other way around hands every
// client that checks for updates during the gap a URL that points at a file that does not exist.
//
// 🔴 这一段原本收尾于 「**这条脚本拦不住它 —— 它是流程约束，写在发布 runbook
//    里**」. That sentence was true when written, **and is false after card UP-10 (2026-08-09)**:
//    it can be blocked now, see **gate ②** below. The original is not kept, for the same reason
//    as the correction above, word for word — leaving a stale truth that says "there is no gate
//    here" means the next person will never even ask "is there already a gate",
//    and that is exactly where a stale truth costs the most: it keeps a question from being asked.
//
// ⚠️ The order itself **has not been cancelled; it only moved from "someone has to remember"
//    to "no manifest comes out unless you do it"**.
//    In `publish.mjs`, `--with-manifest` still only calls this script after the download-center
//    upload has succeeded, and `--with-manifest` paired with `--skip-lan` is already refused
//    explicitly on that side. Gate ② is the **third stage**; it covers the cases those two
//    cannot: **this script is run on its own** (after a failed upload, before an upload,
//    after the publish key was rejected by the site, or after only half the artifacts went up).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// classify() and the round-artifact predicate moved VERBATIM (comments included)
// to scripts/update-manifest-lib.mjs for owner ruling ① (2026-08-10): the
// end-of-publish gate (scripts/verify-live-update-manifest.mjs) needs the same
// "which platform is this artifact for" answer, and this file is all top-level
// statements — nothing can import from it without running it. The lib is where
// the pack-portable.mjs naming-contract import now lives, for the same
// one-owner reason it lived here.
import {
  classify,
  fetchLiveManifest,
  isRoundArtifactName,
  mergeLivePlatforms,
  nonPublicUpdateUrls,
  resolveLiveManifestUrl,
  resolveUpdateDownloadBase,
  updateArtifactUrl,
  updateNotesUrl,
} from './update-manifest-lib.mjs';
// Card UP-10's gate ②. Lives in a separate module rather than in this file, for the
// same reason as portable-self-update-marker.mjs: this file **is entirely top-level
// statements**, so importing it is running it once, and a drill script cannot import
// this file to drive the gate. That module is pure (zero side effects, zero I/O at
// import), so the up10 drill can drive the real function against a real loopback
// HTTP server, instead of rewriting the same judgment in the test — a test that
// re-implements its own subject only proves it agrees with itself.
import {
  REMOTE_VERIFY_SKIP_FLAG,
  gateRemoteArtifacts,
  remoteVerifySkipBanner,
} from './verify-remote-artifact.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'publish');
const MANIFEST = join(OUT, 'update-manifest.json');
// `PROJECT` / `CHANNEL` lived here to compose the download-centre path segments
// (`/files/<project>/<channel>/…`). Since the URLs moved to the public release
// area (2026-08-15) nothing in this file consumes them, and a constant with no
// consumer is the same shape as a capability with no caller. They still exist
// where they are still true: publish-download-center.mjs, which is what
// actually uploads to that site.

/** Version is read from the root package.json — the same reference face as
 *  publish.mjs:49 / publish-download-center.mjs:35, and the one version-sync
 *  lint compares the other 8 faces against.
 *  🔴 Never hard-code: `使用说明.txt` once shipped a hard-coded `0.1.0` with
 *  the artifacts for four versions (CLAUDE.md version-number discipline). */
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/** Where a client is told to fetch the bytes (owner, 2026-08-15 — full account,
 *  including the measured dead link that prompted it, in update-manifest-lib.mjs).
 *  🔴 This used to be the LAN download centre, which meant the manifest's URLs
 *  only worked for someone on 100.64.7.0/24. The download centre is still where
 *  publish.mjs uploads — the two are now separate questions: 「产物存到哪」 and
 *  「告诉客户端去哪拿」, and only the second one is what this file answers. */
const DOWNLOAD_BASE = resolveUpdateDownloadBase();

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
/** 🔴 Card UP-10's escape hatch, **off by default**. Exists only for offline
 *  drills; it is never derived from any failure (one 'unreachable' **will not**
 *  automatically degrade into a skip — that would make this flag redundant,
 *  and make this gate a gate that cannot fail). Full reasoning is in the
 *  header of verify-remote-artifact.mjs. */
const SKIP_REMOTE_VERIFY = args.includes(REMOTE_VERIFY_SKIP_FLAG);

let failed = false;
const fail = (m) => { console.error(`✗ ${m}`); failed = true; };
const ok = (m) => console.log(`✓ ${m}`);

/* classify(filename) lived here until ruling ① (2026-08-10); it is now the
 * shared scripts/update-manifest-lib.mjs export imported above, moved verbatim
 * — every comment line, including the kind-is-a-cross-language-contract
 * ledger, travels with the function it explains. */

if (!existsSync(OUT)) {
  console.error('✗ no ./publish — run node scripts/publish.mjs first');
  process.exit(1);
}

// Only accept this version's artifacts. Mixing in a cross-version leftover is
// the manifest-shaped version of the old 「装了哪一版」 problem
// (publish.mjs:266-268 handles the same fact). The predicate itself (including
// the reason for 「narrow zip match, not a blanket `\.zip$`」) moved with
// classify() into update-manifest-lib.mjs as isRoundArtifactName — which files
// to accept and how to classify them are two halves of one question; split
// across two places they will drift.
const files = readdirSync(OUT).filter((f) => isRoundArtifactName(f, VERSION));
if (files.length === 0) {
  console.error(`✗ ./publish has no ${VERSION} installer — run node scripts/publish.mjs first`);
  process.exit(1);
}

const platforms = {};
for (const name of files.sort()) {
  const cls = classify(name);
  if (!cls) { fail(`${name} 认不出平台/kind — the manifest must not carry an artifact nobody knows how to use`); continue; }

  const path = join(OUT, name);
  const sidecar = `${path}.sha256`;

  // 🔴 Gate ①-a: no sidecar ⇒ this is not an artifact publish.mjs verified.
  if (!existsSync(sidecar)) {
    fail(`${name} 缺 .sha256 侧车 — it is not an artifact publish.mjs verified; refuse to write it into the manifest`);
    continue;
  }
  const declared = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');

  // 🔴 Gate ①-b: sidecar does not match the file ⇒ the artifact was mutated.
  // Here we **deliberately recompute** rather than copy the sidecar: a copied
  // hash only proves "what the sidecar says"; the recomputed one proves "what
  // the bytes about to be downloaded actually are". The manifest answers the latter.
  if (declared !== actual) {
    fail(`${name} 与侧车哈希不符 (sidecar ${declared.slice(0, 12)}… / recomputed ${actual.slice(0, 12)}…) — the artifact was mutated; refuse to write it into the manifest`);
    continue;
  }
  if (!/^[0-9a-f]{64}$/.test(actual)) {
    fail(`${name} computed sha256 has the wrong shape (${actual})`);
    continue;
  }

  const p = (platforms[cls.platform] ??= {
    version: VERSION,
    // The release page for this version — it carries the same notes
    // publish-download-center.mjs uploads as FlowMic-<v>-RELEASE_NOTES.md, on a
    // host a user outside the office can actually open. Version-pinned; the
    // reason is word-for-word the same as artifacts[].url below.
    notes_url: updateNotesUrl(DOWNLOAD_BASE, VERSION),
    artifacts: [],
  });
  p.artifacts.push({
    kind: cls.kind,
    locale: cls.locale,
    filename: name,
    // 🔴 Version-pinned: `<release base>/download/v<version>/<file>`.
    //
    // ⚠️ THE HOST CHANGED (owner, 2026-08-15), THE PINNING LESSON DID NOT. The
    // paragraph below is kept because the lesson it paid for is what makes the
    // GitHub shape the right one too; only the base moved, from the LAN
    // download centre to the public release area (full account, with the
    // measured dead link, in update-manifest-lib.mjs).
    //
    // This originally wrote `/dl/<project>/<channel>/<file>`, and **the comment
    // above it defended that**: roughly 「带了文件名就不是那个永远指向最新的稳定链了，所以固定的
    // sha256 配得上它」. **The first half of that defense is true; the conclusion is false**,
    // and what overturned it was a measurement, not a deduction【measured, 2026-08-09, dev-pc-a, site 100.64.7.68】:
    //
    //   404  /dl/flowmic/release/FlowMic-0.2.58-release.apk
    //   200  /files/flowmic/release/0.2.58/FlowMic-0.2.58-release.apk
    //   200  /dl/flowmic/release/FlowMic-0.2.59-release.apk   ← only because 0.2.59 is latest at that moment
    //   (RELEASE_NOTES, same two shapes: /files form 200, /dl form 404)
    //
    // ⇒ hanging a named file under `/dl/` **stops 「发错字节」, it does not stop 404**:
    // the moment the version is no longer latest, the whole chain vanishes. A hash
    // mismatch is reported honestly by the client, while a 404 is "the update feature
    // does nothing" — **two failure modes, the latter quieter**.
    //
    // 🔴 This conflicts directly with the repo's existing 「零协议改动 ⇒ 中继不需要重新部署」:
    // with `/dl/`, any round that 「上传了产物、按那条规矩跳过中继部署」 would hand **every
    // old client a 404**. Pinning the version makes the conflict disappear — the right
    // fix is to change the URL shape, **not to add another rule someone has to remember**.
    url: updateArtifactUrl(DOWNLOAD_BASE, VERSION, name),
    sha256: actual,
    size: statSync(path).size,
  });
  ok(`${cls.platform}  ${name}  ${actual.slice(0, 12)}…  ${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`);
}

if (failed) {
  console.error('\n✗ 清单未生成 — each line above is 「这份清单会让客户端装上一个没法验的包」。');
  process.exit(1);
}

// Not a single entry for any platform ⇒ do not emit a manifest.
// 🔴 An empty manifest is worse than no manifest: the client will read it as
//    "no platform has an update", when the truth is "this manifest has no content".
//    Unknown ≠ latest.
if (Object.keys(platforms).length === 0) {
  console.error('✗ no artifact that can be written into the manifest — 拒绝产出一份空清单 (the client would read it as 「已是最新」)');
  process.exit(1);
}

// ── 🔴 owner ruling ① (2026-08-10): manifest semantics = latest DOWNLOADABLE per platform ──
//
// docs/decisions/2026-08-10-owner-seven-rulings-after-0261.md ①. Measured cost
// of the old "this round's artifacts" semantics: 0.2.61 shipped windows+android
// only, and `macos-arm64` — still live at 0.2.59 — vanished from the manifest
// wholesale. Clients ask "is there an update for MY platform", not "how many
// platforms did this round build". So: the live manifest is fetched and merged
// IN PLACE into `platforms` — a platform absent from this round keeps its live
// entry verbatim (including its own notes_url: it describes THAT version), and
// a platform present in both takes the higher version.
//
// This runs BEFORE gate ② below, deliberately: retained entries flow through
// the same remote byte-verification as this round's artifacts, so "latest
// DOWNLOADABLE" is a measured claim every round, not an assumption inherited
// from the round that originally published the entry.
//
// "Could not ask" is a hard refusal, NOT a fallback to building local-only:
// a manifest built blind may silently shrink — the exact shape ruling ① exists
// to end. 'absent' (404/503) is different: that is a DEFINITE answer that
// nothing usable is live, so there is nothing to preserve and this round's
// platforms are the whole truth, said out loud.
if (SKIP_REMOTE_VERIFY) {
  console.log(`\n🔴 ${REMOTE_VERIFY_SKIP_FLAG}: live-manifest merge (ruling ① 2026-08-10) SKIPPED too —`);
  console.log('   any platform not in this round\'s ./publish would be DROPPED from this manifest.');
  console.log('   Offline drills only; a manifest produced under this flag must not be deployed.');
} else {
  const liveUrl = resolveLiveManifestUrl();
  console.log(`\n── manifest semantics (ruling ① 2026-08-10): merge live entries — GET ${liveUrl} ──`);
  const live = await fetchLiveManifest({ url: liveUrl });
  if (live.verdict === 'unreachable') {
    fail(
      `could not ask the live endpoint what is currently downloadable (${live.error}). ` +
        `Refusing to build blind: a manifest built without knowing the live entries may silently ` +
        `DROP a platform (the 0.2.61 macos-arm64 loss ruling ① exists to end). Restore the route ` +
        `and re-run; for offline drills ${REMOTE_VERIFY_SKIP_FLAG} exists and prints what it costs.`,
    );
  } else if (live.verdict === 'invalid') {
    fail(
      `the live endpoint answered in a shape this script cannot honestly merge ` +
        `(HTTP ${live.status ?? '?'}, ${live.detail}). Inspect GET ${liveUrl} by hand — building ` +
        `over an answer we do not understand risks silently dropping a live platform entry.`,
    );
  } else if (live.verdict === 'absent') {
    const detail = live.detail ? `, ${live.detail}` : '';
    console.log(
      `· live endpoint serves no usable manifest (HTTP ${live.status}${detail}) — nothing to merge; ` +
        `this round's platforms are the whole manifest`,
    );
  } else {
    const merged = mergeLivePlatforms({ platforms, liveManifest: live.manifest });
    for (const r of merged.retained) {
      ok(
        `${r.platform}  retained from the live manifest @ ${r.version} — no ${r.platform} artifact ` +
          `this round, and clients on it still deserve an answer (ruling ①)`,
      );
    }
    if (merged.retained.length > 0) {
      console.log(
        '  · retained entries are re-verified at their own published URLs below. If one has been ' +
          'rotated out (the center keeps only the latest 3 versions), the verification will refuse ' +
          'the whole manifest — the action then is to re-upload that version\'s artifact, or ship ' +
          'a new artifact for that platform.',
      );
    }
    for (const k of merged.keptLiveNewer) {
      console.log(
        `⚠ ${k.platform}: live manifest already advertises ${k.live}, NEWER than this round's ` +
          `${k.built} — keeping the live entry (ruling ①: higher version wins). If that surprises ` +
          `you, establish which round is actually the latest before deploying anything.`,
      );
    }
    for (const s of merged.superseded) {
      if (s.from !== s.to) console.log(`· ${s.platform}: ${s.from} (live) superseded by ${s.to} (this round)`);
    }
  }
  if (failed) {
    console.error('\n✗ 清单未生成 — refuse to merge when live entries cannot be asked / cannot be read (an absent platform would be silently dropped, the exact shape ruling ① exists to end).');
    process.exit(1);
  }
}

// ── 🔴 Gate ③: is every URL one an OUTSIDE user can actually fetch ─────────
//
// Card PUB-1 (owner, 2026-08-15). Gate ② asks 「这些字节真的在那个地址上吗」 and
// answers it honestly — **from this machine**. That is the loophole: the build
// machine sits on the office LAN, so a download-centre URL verifies perfectly
// here and is a dead link for every user who is not on that subnet.
// A gate that can only pass is not a gate; this one asks the question gate ②
// structurally cannot.
//
// 🔴 It runs on the MERGED map, not on this round's artifacts — that is the
// whole point. This round's URLs are composed by this script and are public by
// construction; the ones that can be stale are the entries ruling ① RETAINED
// from the live manifest, which are copied verbatim, url included. A
// single-platform round is exactly when that bites, and it would bite quietly.
//
// It runs BEFORE gate ② deliberately: no reason to stream 220 MB through sha256
// to prove that a URL nobody outside can open does contain the right bytes.
{
  const offenders = nonPublicUpdateUrls(platforms, DOWNLOAD_BASE);
  if (offenders.length > 0) {
    console.log('\n── public reachability (gate ③, card PUB-1) ──');
    for (const o of offenders) {
      fail(
        `${o.platform} ${o.filename}: ${o.field} points at ${o.url}, which is not under ${DOWNLOAD_BASE} — ` +
          `that is an address only this network can open, so every user off it gets 「更新功能什么都不做」. ` +
          `This entry was retained from the live manifest (ruling ①), so the action is to publish that ` +
          `platform's ${o.platform === 'android' ? 'APK' : 'artifact'} to the public release for its version ` +
          `(node scripts/publish-github-release.mjs --repo=flowmicapp/flowmic), or to ship a new artifact for ` +
          `that platform this round so this script composes the URL itself.`,
      );
    }
    console.error('\n✗ 清单未生成 — a manifest that is half public and half LAN-only is worse than one platform less: it looks complete.');
    process.exit(1);
  }
  ok(`public reachability: every url/notes_url sits under ${DOWNLOAD_BASE} (gate ③)`);
}

// ── 🔴 Gate ②: are these bytes actually on the site (card UP-10) ───────────
//
// Gate ① asks "what is this file in ./publish". It answers honestly, and it
// **is not the question the manifest has to answer** — what the manifest hands
// the client is a **URL**, not a local path.
// "We have it locally" and "the site has it" are two different facts, and until
// now **no step asked the latter**.
//
// So here every already-composed URL is actually fetched: follow through to the
// final 200 (`/dl/`-shaped URLs 302, so redirects are followed explicitly),
// stream the returned bytes through sha256 and count them; both must match the
// local copy word for word. ⚠️ Deliberately not HEAD, and not "fetch then throw
// the body away": the manifest does not claim "something is there", it claims
// "**that file is there, and the hash is this**", and a stale leftover from the
// previous round still 200s, still has this name, and is simply the wrong copy.
//
// 🔴 Four verdicts, three actions, and "could not ask" must never be said as
// "there is none" — the same contract as the UP-9 gate. Full reasoning
// (including why this escape hatch exists and the UP-9 one does not) is in the
// header of the imported module.
if (SKIP_REMOTE_VERIFY) {
  for (const line of remoteVerifySkipBanner()) console.log(line);
} else {
  console.log('\n── remote verify: does the published URL actually serve these bytes (card UP-10) ──');
  const outcome = await gateRemoteArtifacts({ platforms, fail, ok });
  if (outcome.refused > 0) {
    console.error(
      `\n✗ 清单未生成 — ${outcome.checked} artifacts, ${outcome.refused} of them do not match at their published URL.`,
    );
    console.error('  Each line above is 「这份清单会把客户端指向一个取不到、或者取回来不是它的文件」。');
    console.error('  「先产物后清单」 is now delivered by this step, not by someone remembering.');
    process.exit(1);
  }
  ok(`remote verify passed: ${outcome.checked} artifacts match byte-for-byte at their published URL`);
}

const manifest = {
  manifest_version: 1,
  generated_at: new Date().toISOString(),
  platforms,
};

if (CHECK_ONLY) {
  console.log('\n' + JSON.stringify(manifest, null, 2));
  ok('--check: manifest is generable, not written');
  process.exit(0);
}

writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
ok(`update-manifest.json → ${MANIFEST}`);

// Say which platform is missing, rather than quietly shipping half a set.
// One 「APK 忘了重出」 would hand every phone a manifest with no android entry,
// and what they see is "check failed" —
// nobody would think to look at this step as the cause.
for (const expected of ['windows-x64', 'android']) {
  if (!platforms[expected]) {
    console.log(`· the manifest has no ${expected} — this round's ./publish has no artifact for it (if that was not intended, rebuild the artifact and re-run)`);
  }
}

console.log(`
next steps (this script only produces a file, it does not publish — the same split as publish.mjs RV-73):
  · put it where the relay can read it (live = /etc/flowmic-app/updates.json,
    same place as the existing /etc/flowmic-app/env); on the relay, FLOWMIC_UPDATE_MANIFEST_PATH points at it;
  · 🔴 order: **upload the artifacts to the download center first, then update the manifest**. The other way around
    hands every client that checks for updates during the gap a URL that points at a file that does not exist.`);
