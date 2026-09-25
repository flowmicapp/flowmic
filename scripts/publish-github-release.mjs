// FlowMic → GitHub Releases publisher (S7, 0.3.0).
//
// STATUS: this is new tooling written for the S1/S7 gap "GitHub Releases upload
// has zero tooling" (docs/archive/strategy/2026-08-04-0.3.0-task-book-cn.md S1/S7). It
// has been syntax-checked and dry-run tested against THIS repo's real
// CHANGELOG.md and git remote, but has never made a real network call — there
// is no GitHub Releases entry anywhere that this script produced. The owner
// runs this for real, when ready, with their own token.
// ⚠️ The paragraph above is history as of 2026-08-15: the first real run
// created the v0.3.0 DRAFT on flowmicapp/flowmic and uploaded five
// byte-verified assets (two MSI, APK, two portable zips incl. the notarized
// mac zip). Kept in place because it explains the tool's design stance; the
// "never ran" claim is what expired.
//
// WHY NOT THE `gh` CLI: `gh` is the obvious tool for this, but on the machine
// this was written on `gh` is authenticated to an unrelated GitHub account —
// shelling out to it would silently act as whoever `gh` happens to be logged
// in as on whatever machine runs this script next. Talking to the REST API
// directly with an explicit token (read from an env var, never from ambient
// CLI auth state) means the identity making the release is always the one the
// operator explicitly handed to this process, on every machine, every time.
//
// WHAT IT UPLOADS: the same `.msi`/`.apk` artifacts `publish.mjs` already
// staged into ./publish and sha256-sidecar-verified — this script re-verifies
// those sidecars itself (collectArtifacts below) rather than trusting the
// directory listing, same discipline as publish-download-center.mjs's own
// collectArtifacts. It does not build anything and does not read ./publish
// looking for arbitrary files: only names containing the current
// package.json version, exactly like the LAN publisher.
//
// SAFETY DEFAULTS:
//   · Releases are created as DRAFT unless --publish is passed — a draft is
//     reviewable and deletable from the GitHub UI before anyone sees it; a
//     published release with a wrong asset is a support ticket.
//   · --dry-run prints the exact repo/tag/assets/body this run would produce
//     and makes ZERO network requests (not even a GET) — this is how the tool
//     was validated. See the report this script's card was delivered under
//     for the transcript of `--dry-run` output.
//   · Refuses if a release already exists for this tag, so a re-run can never
//     silently duplicate or overwrite one (delete it in the GitHub UI first if
//     that is genuinely what you want, then re-run).
//
// USAGE (owner, later, never run by the agent that wrote this):
//   $env:FLOWMIC_GITHUB_RELEASE_TOKEN = "<a token with 'contents: write'>"
//   node scripts/publish-github-release.mjs --dry-run        # preview, no network calls
//   node scripts/publish-github-release.mjs                  # creates a DRAFT release + uploads assets
//   node scripts/publish-github-release.mjs --publish         # creates a PUBLISHED release (public, if repo is public)
//   node scripts/publish-github-release.mjs --repo=owner/name # override repo autodetection (equals form only — see flag())
//   node scripts/publish-github-release.mjs --check-latest-apk # ONLY re-run the fixed-URL gate (card M-3), no writes

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, openAsBlob } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The ONE place the fixed asset name and the fixed URL are written down (card
// M-3). This file's header says every scripts/publish-*.mjs is independently
// runnable with no cross-script import graph; that stands -- update-manifest-lib
// is a LIBRARY, pure at import with zero side effects (it refuses to be run
// directly), not another publisher. Copying the name here instead would make
// two hand-kept copies of one string, and the web repo's QR code a third.
import { LATEST_APK_ASSET_NAME, latestApkDownloadUrl } from './update-manifest-lib.mjs';
import { scanZipForCjk, zipCjkRefusalMessage, zipUnreadableRefusalMessage } from './release-portable-cjk-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Override for the ./publish root: scripts/it07-publish-github-release-flags.test.mjs
// used to run its "bare --dry-run is NOT rejected" positive control against this
// repo's REAL ./publish -- so on 2026-09-09, the day the CJK portable-zip gate
// (release-portable-cjk-scan.mjs) landed, that control started measuring whatever
// artefact happened to be sitting on disk (a pre-ruling zip with a Chinese
// README.txt) instead of flag parsing. The gate was correct to refuse it; the
// drill was coupled to state it did not create. FLOWMIC_PUBLISH_GITHUB_RELEASE_DIR
// lets that drill point OUT at a throwaway directory it builds itself, with no
// portable zip in it, so the control only ever measures argument parsing.
const OUT = process.env.FLOWMIC_PUBLISH_GITHUB_RELEASE_DIR
  ? join(process.env.FLOWMIC_PUBLISH_GITHUB_RELEASE_DIR)
  : join(ROOT, 'publish');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const TAG = `v${VERSION}`;
const API_VERSION = '2022-11-28';

const args = process.argv.slice(2);
// Value-carrying flags accept ONLY `--name=value`. The bare space-separated
// form (`--repo owner/name`) is REJECTED loudly, not parsed: it used to return
// `true`, the caller's typeof-string check turned that into "no override", and
// the script fell back to git-remote autodetection — silently targeting
// whatever repo this machine's origin happens to be. Measured 2026-08-15:
// `--dry-run --repo flowmicapp/flowmic` previewed a release against
// <private-dev-repo>. For a release tool, a silently-wrong target is the
// worst failure shape available; the usage header taught the space form at
// the time, so the comment was the bug's accomplice.
const flag = (name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  if (!hit.includes('=')) {
    console.error(`✗ --${name} needs a value: use --${name}=<value> (space-separated form is not parsed). Got: ${hit}`);
    process.exit(1);
  }
  return hit.slice(hit.indexOf('=') + 1);
};
// Presence-only booleans. `--name` → true; `--name=…` is REJECTED (never coerced).
// Same trap as publish-download-center.mjs: `flag('dry-run') === true` treated
// `--dry-run=1` as DRY=false (real upload). `--publish` had the identical shape
// (IT-07): leave that neighbour unfixed and the same bite lands twice.
const boolFlag = (name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return false;
  if (hit.includes('=')) {
    console.error(`✗ --${name}=… is not accepted. Use bare --${name} (no =value). Got: ${hit}`);
    process.exit(1);
  }
  return true;
};
const DRY = boolFlag('dry-run');
const PUBLISH = boolFlag('publish'); // default: draft
// 🔴 --catch-up-release — owner ruling 2026-09-07, and it is an OPT-IN, never a
// default. The 2026-08-16 ruling that assertConcise() enforces answers "what
// does THIS version do for me" and caps the page at six items; it assumes one
// released version per release page. 0.3.77 is not that: 0.3.63 was the last
// public release and 0.3.64 through 0.3.76 never went out, so the page has to
// list fourteen versions' worth of user-visible change or the reader is simply
// not told. The owner asked for all of it, today, naming this release.
//
// WHAT IT DOES NOT LIFT, stated here so a future reader does not have to go
// and check: the English-only refusal (2026-08-15) still runs, unchanged, for
// every run; the `###`-subsection refusal still runs, because the internal
// ledger is not a release page at any length; and the flag ADDS two refusals
// that the normal path does not have (assertCatchUpBodyClean below). A longer
// page is a bigger surface for exactly the two things owner rulings have
// already had to strip off a release page once each — console/billing detail
// (2026-08-23, iron rule §1-19) and machine-written punctuation (2026-09-01) —
// so the flag that permits the length pays for it with those two checks.
const CATCH_UP = boolFlag('catch-up-release');
// Card M-3: run ONLY the fixed-URL gate against whatever is published right
// now. No release is created, no asset uploaded, no token read. It exists
// because the gate cannot be meaningful on the default (draft) path -- see
// assertLatestApkUrlServesThisBuild -- so the operator who publishes the draft
// in the GitHub UI needs a way to run the check afterwards that is a command,
// not a memory.
const CHECK_LATEST_APK = boolFlag('check-latest-apk');
const REPO_OVERRIDE = typeof flag('repo') === 'string' ? flag('repo') : undefined;

if (CHECK_LATEST_APK && DRY) {
  // Refuse rather than pick one. --dry-run's contract is ZERO network requests
  // (that is the sentence it prints, and s8-release-script-defects.test.mjs is
  // there because that sentence was once false next door); --check-latest-apk
  // is nothing but a network request. Silently honouring one would make the
  // other a lie.
  console.error('✗ --check-latest-apk and --dry-run are mutually exclusive: the check IS a network request, and --dry-run promises none. Pick one.');
  process.exit(1);
}

const ok = (m) => console.log(`✓ ${m}`);
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ── repo autodetection ───────────────────────────────────────────────────────
// Reads it from `git remote get-url origin` instead of hardcoding an
// owner/name string in this file — a hardcoded string is exactly the kind of
// fact that drifts silently if the remote is ever renamed or forked from.
function detectRepo() {
  if (REPO_OVERRIDE) return REPO_OVERRIDE;
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    console.error(`✗ could not read git remote "origin": ${e.message}`);
    console.error('  pass --repo owner/name explicitly if this checkout has no "origin" remote.');
    process.exit(1);
  }
  // Accepts both "git@github.com:owner/name.git" and "https://github.com/owner/name.git".
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/);
  if (!m) {
    console.error(`✗ origin (${url}) does not look like a github.com remote.`);
    console.error('  pass --repo owner/name explicitly.');
    process.exit(1);
  }
  return `${m[1]}/${m[2]}`;
}

// ── artifacts ─────────────────────────────────────────────────────────────
// Same rule as publish-download-center.mjs collectArtifacts(): only files
// whose name contains the current version AND whose .sha256 sidecar
// (written by publish.mjs) matches the file on disk. Re-verifying here — not
// just trusting the directory listing — means a corrupted or hand-edited
// file in ./publish gets refused instead of shipped to a public release.
function collectArtifacts() {
  if (!existsSync(OUT)) {
    console.error('✗ no ./publish directory — run `node scripts/publish.mjs` first.');
    process.exit(1);
  }
  // .zip joined the family on 2026-08-15: the portable builds (owner's
  // three-platform portable ruling) and the notarized macOS zip (adopted via
  // adopt-artifact with a cross-machine hash) are release artifacts with the
  // same .sha256 sidecar discipline as the installers — the 0.3.0 milestone
  // release would have silently shipped without its mac half under the old
  // msi|apk filter.
  const files = readdirSync(OUT).filter((f) => /\.(msi|apk|zip)$/i.test(f) && f.includes(VERSION));
  if (files.length === 0) {
    console.error(`✗ no ${VERSION} installers in ./publish — run \`node scripts/publish.mjs\` first (did the version just bump? artifacts need rebuilding).`);
    process.exit(1);
  }
  return files.map((name) => {
    const p = join(OUT, name);
    const sidecar = `${p}.sha256`;
    if (!existsSync(sidecar)) {
      console.error(`✗ ${name} has no .sha256 sidecar — it was not verified by publish.mjs, refusing to release it.`);
      process.exit(1);
    }
    const expected = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
    const actual = sha256(p);
    if (actual !== expected) {
      console.error(`✗ ${name} does not match its .sha256 sidecar — file was modified after publish.mjs staged it, refusing.`);
      process.exit(1);
    }
    return { name, path: p, hash: actual, size: statSync(p).size };
  });
}

// ── release notes ────────────────────────────────────────────────────────
// Same source of truth as publish-download-center.mjs's changelogSection():
// the CHANGELOG.md section for this version. Duplicated rather than imported
// on purpose — every scripts/publish-*.mjs in this repo is independently
// runnable with no cross-script import graph, and this is a small enough
// function that copying it keeps that property instead of introducing a
// shared module two release tools would then both depend on.
function changelogSection() {
  let log;
  try {
    log = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  } catch {
    return null;
  }
  const hit = new RegExp(`(^|[^0-9.])${VERSION.replace(/\./g, '\\.')}([^0-9.]|$)`);
  for (const chunk of log.split(/^## /m).slice(1)) {
    const nl = chunk.indexOf('\n');
    const title = chunk.slice(0, nl).trim();
    if (hit.test(title)) return { title, body: chunk.slice(nl + 1).trim() };
  }
  return null;
}

// The PUBLIC half of a CHANGELOG section: everything above the first `###`.
//
// One file stays the source of truth, and it keeps carrying the engineering
// detail — that detail is simply not what a release page is for. A section
// written as
//
//     ## 0.3.9
//     <three to five short lines: what this version does for you>
//     ### <heading>          <- from here down is the internal ledger
//
// publishes only the lead. A section with no lead returns null, and the caller
// says so rather than quietly falling back to the whole thing.
function publicLead(section) {
  if (!section) return null;
  const cut = section.body.search(/^#{3,}\s/m);
  const lead = (cut === -1 ? section.body : section.body.slice(0, cut)).trim();
  return lead === '' ? null : lead;
}

function buildBody(section) {
  const explicit = flag('notes');
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (!section) {
    console.error(`✗ CHANGELOG.md has no section for ${VERSION} — a public release with no release notes is exactly what this tool exists to prevent.`);
    console.error('  Write the user-facing changes into CHANGELOG.md before releasing, or pass --notes="..." as a stopgap.');
    process.exit(1);
  }
  const lead = publicLead(section);
  if (lead === null) {
    console.error(`✗ the CHANGELOG section for ${VERSION} has no lead paragraph — nothing to publish as the release page.`);
    console.error('  Write three to five short lines at the top of the section, above the first `###`:');
    console.error('  what this version does for the person reading it. The `###` subsections below stay as they are.');
    console.error('  (owner ruling 2026-08-16 — docs/decisions/2026-08-16-owner-concise-human-release-notes.md).');
    process.exit(1);
  }
  return `## ${section.title}\n\n${lead}`;
}

// 🔴 Short and human — owner ruling, 2026-08-16
// (docs/decisions/2026-08-16-owner-concise-human-release-notes.md): the public
// release page answers 「what does this version do for me」 in three to five
// short lines. The engineering account — mechanism, root cause, the reverse
// control — is internal discipline; the reader of a release page neither needs
// it nor gets through it.
//
// 🔴 WHY THIS IS A GATE AND NOT A NOTE, measured 2026-08-17: the ruling was one
// day old and written down in two places, and v0.3.8 still went out as 3,621
// characters across eight `###` sections — because the publisher took the whole
// CHANGELOG section and nothing consulted the ruling at release time. Same
// shape as the English-only gate below: it lives on the bytes about to be
// published, not in anyone's memory.
const MAX_BODY_CHARS = 1200;
const MAX_BODY_LINES = 6;

function assertConcise(body) {
  // Count ITEMS, not wrapped physical lines. A continuation line of an
  // 80-column bullet is INDENTED, and hard-wrapping must not be what trips a
  // gate about brevity: measured 2026-08-21, the first time this gate met a
  // released section — 0.3.19's lead is exactly three bullets (the ruling's
  // 「three to five short lines」), wrapped to eight physical lines, and the
  // old per-line count refused it. The CHARS cap below stays the volume guard,
  // so un-wrapping buys nobody a longer page.
  const items = body
    .split('\n')
    .slice(1)                        // drop the `## <version>` title line
    .filter((l) => l.trim() !== '' && !/^\s/.test(l));
  const problems = [];
  if (/^#{3,}\s/m.test(body)) {
    problems.push('it carries `###` subsections — those are the internal ledger, not the release page');
  }
  // The two SIZE caps, and only these two, are what --catch-up-release lifts.
  // The `###` refusal above is deliberately outside this branch: a release page
  // that carries the internal ledger is wrong at six items and wrong at sixty.
  if (!CATCH_UP) {
    if (body.length > MAX_BODY_CHARS) {
      problems.push(`it is ${body.length} characters (limit ${MAX_BODY_CHARS})`);
    }
    if (items.length > MAX_BODY_LINES) {
      problems.push(`it is ${items.length} items (limit ${MAX_BODY_LINES}; wrapped continuation lines are indented and not counted)`);
    }
    if (problems.length > 0) {
      problems.push('if this release is a catch-up covering several unreleased versions, pass --catch-up-release (owner ruling 2026-09-07) - it lifts these two caps and adds two of its own');
    }
  }
  if (problems.length === 0) return;
  console.error('✗ the release body is not the short, human summary a release page is for:');
  for (const p of problems) console.error(`  · ${p}`);
  console.error('  Write three to five short lines at the top of the CHANGELOG section, above the first `###`;');
  console.error('  that lead is what gets published. Everything below it stays in the file for whoever wants it.');
  console.error('  (owner ruling 2026-08-16 — docs/decisions/2026-08-16-owner-concise-human-release-notes.md).');
  process.exit(1);
}

// The price of --catch-up-release. Both refusals below exist ONLY on the
// catch-up path; the normal six-item page is unaffected and keeps behaving
// exactly as it did before this flag existed.
//
// (a) DASHES. Owner ruling 2026-09-01 (docs/decisions/2026-09-01-owner-non-human-
//     copy-scent-ironrule.md) makes non-human copy scent a quality gate, and the
//     em dash is the one machine-punctuation tell a script can decide on its own:
//     `verify:lint outward-voice` already counts them in product copy, and a
//     release page is the most-read outward copy this project has. Nothing else
//     reads the release body, so without this line the longest page we ever
//     publish would be the only outward surface with no punctuation check at all.
//
// (b) CONSOLE / BILLING WORDS. Iron rule S1-19 (owner 2026-08-23): the public
//     release page carries PC-app and phone-app changes only. That rule was
//     written after two console/subscription sentences had to be pulled off a
//     live release page by hand, and S1-19 itself parks the gate as a "candidate,
//     write it the next time this bites", the reason given being false positives.
//     So this list is deliberately NARROW and deliberately opt-in: every term
//     below names a surface that is not the PC app or the phone app, with no
//     innocent reading in a release note.
//
// `plan` IS NOT ON THIS LIST, on purpose. S1-19 names it as the exact word whose
// legitimate uses ("planned", "we plan to") would make the gate miskill, and a
// refusal that fires on a correct page is worse than no refusal: it gets switched
// off, and then neither half is there. Judgement on that word stays with the
// operator, which is where S1-19 left it.
const CATCH_UP_BANNED = [
  'console', 'subscription', 'subscriptions', 'subscribe', 'billing',
  'invoice', 'refund', 'payment', 'checkout', 'quota',
  'relay', 'webhook', 'sidecar', 'paddle', 'creem',
];

function assertCatchUpBodyClean(body) {
  const problems = [];
  const dashes = body.match(/[—–]/g);
  if (dashes) {
    problems.push(`it contains ${dashes.length} em/en dash(es); release copy is written the way a person types it (owner ruling 2026-09-01)`);
  }
  // Word-for-word, with no boundary regex: a template literal turns a lone
  // backslash-b into the BACKSPACE character rather than a word boundary, and
  // the gate would then match nothing while looking exactly like it works.
  // Splitting the body into words says the same thing and cannot mis-escape.
  const words = body.toLowerCase().match(/[a-z]+/g) || [];
  for (const w of CATCH_UP_BANNED) {
    const n = words.filter((x) => x === w).length;
    if (n) problems.push(`it says "${w}" (${n}x); that surface is not the PC app or the phone app (iron rule S1-19, owner 2026-08-23)`);
  }
  if (problems.length === 0) return;
  console.error('✗ --catch-up-release refuses this body:');
  for (const p of problems) console.error(`  . ${p}`);
  console.error('  A catch-up page is longer, so it is checked harder, not less. Fix the body and re-run.');
  process.exit(1);
}

// ---- card M-3: the version-less APK copy, and the URL that never changes ----
//
// OWNER RULING 2026-09-08 (docs/decisions/2026-09-08-owner-web-client-signed-in-
// controls-and-stable-apk-url.md): every public release carries the Android
// build a SECOND time under a version-less name, so the /go download popup can
// bake ONE address into a QR code and never re-mint it.
//
// WHY THE URL NEVER CHANGES: GitHub itself resolves
//   https://github.com/<owner>/<repo>/releases/latest/download/<asset name>
// server-side, to the asset of that name on whatever release is currently
// "latest". Nothing about it carries a version, so nothing about it expires --
// which is the entire point, and also why the bytes behind it have to be
// checked rather than assumed: the address is guaranteed to resolve to
// SOMETHING, never to the right thing.
//
// WHAT A MISMATCH MEANS -- two causes, and they are not the same repair:
//   (a) the release we just made is not the one GitHub calls "latest". A DRAFT
//       or a prerelease is excluded from `releases/latest`, so the URL keeps
//       serving the PREVIOUS release's APK: a plausible file, of the wrong
//       version, with a 200 on it. This is the default path of this script
//       (draft unless --publish), which is why the gate refuses to pretend it
//       ran there; see the draft branch in main().
//   (b) the upload of the fixed-name asset did not land (or landed truncated).
// A 404 says a third thing: the latest release has no asset by that name at
// all -- typically the first release published after this feature, or a
// hand-edited release.

// The single APK of this round. Exactly one, or refuse: one value answers one
// question -- if ./publish somehow held two APKs there would be no honest
// answer to "which bytes does the fixed URL promise", and picking the first
// one would make that ambiguity invisible.
function pickReleaseApk(artifacts) {
  const apks = artifacts.filter((a) => /\.apk$/i.test(a.name));
  if (apks.length === 1) return apks[0];
  if (apks.length === 0) {
    console.error(`\u2717 no .apk among the ${VERSION} artifacts in ./publish -- a public release must carry the Android build`);
    console.error('  (iron rule S1-18: a release ships every platform), and the fixed-name copy the /go QR code points at');
    console.error('  is made from it (owner ruling 2026-09-08). Build and stage the APK, then re-run.');
    process.exit(1);
  }
  console.error(`\u2717 ${apks.length} .apk files in ./publish for ${VERSION}: ${apks.map((a) => a.name).join(', ')}`);
  console.error('  The fixed-name copy has to be made from one of them and there is no way to choose. Remove the stale one and re-run.');
  process.exit(1);
  return undefined;
}

// Overwrite semantics, stated out loud. GitHub does NOT replace an asset on a
// name collision -- it answers 422 already_exists -- so "just upload it again"
// is not a thing that exists. The fixed name is the one asset name that
// repeats across every release, so it is also the one that can plausibly
// already be sitting on a release someone attached by hand, and the only way
// to make this script idempotent for it is delete-then-upload. Each delete
// happens immediately before its own upload, and nothing else is ever deleted
// (card UP-6's ordering argument, same reason: a delete whose upload never
// arrives leaves the fixed URL pointing at nothing).
async function deleteAssetsNamed(repo, token, release, name) {
  const res = await api(repo, token, 'GET', `/releases/${release.id}/assets?per_page=100`);
  if (!res.ok) {
    console.error(`\u2717 could not list the assets already on ${TAG}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    console.error(`  Refusing to upload "${name}" blind: if one of that name is already there the upload fails with 422 and`);
    console.error('  the fixed URL keeps serving whatever is on it.');
    process.exit(1);
  }
  const hits = (await res.json()).filter((a) => a.name === name);
  for (const a of hits) {
    const del = await api(repo, token, 'DELETE', `/releases/assets/${a.id}`);
    if (!del.ok && del.status !== 404) {
      console.error(`\u2717 could not delete the existing "${name}" asset (id ${a.id}): HTTP ${del.status}`);
      process.exit(1);
    }
    ok(`removed the existing "${name}" from ${TAG} before re-uploading (delete-then-upload, never a silent duplicate)`);
  }
}

const contentTypeFor = (name) => (name.toLowerCase().endsWith('.apk')
  ? 'application/vnd.android.package-archive'
  : 'application/x-msi');

async function uploadAsset(repo, token, release, uploadBase, { assetName, path, size }) {
  const blob = await openAsBlob(path, { type: contentTypeFor(assetName) });
  const res = await api(repo, token, 'POST', `${uploadBase}?name=${encodeURIComponent(assetName)}`, blob, {
    'Content-Type': contentTypeFor(assetName),
  });
  if (!res.ok) {
    console.error(`\u2717 upload of ${assetName} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    console.error(`  the release itself was already created (${release.html_url}) -- fix and re-upload manually, or delete the draft and re-run.`);
    process.exit(1);
  }
  const asset = await res.json();
  if (asset.size !== size) {
    console.error(`\u2717 ${assetName} uploaded but GitHub reports size ${asset.size}, local is ${size} -- re-upload, do not trust this asset.`);
    process.exit(1);
  }
  ok(`uploaded ${assetName} (${asset.size} bytes, matches local)`);
}

// THE GATE. Not a log line: every path out of this function either prints a
// receipt or exits non-zero. A HEAD with redirects followed lands on the CDN
// object, and its Content-Length is the number of bytes an actual user would
// receive from the address printed on the QR code.
//
// 🔴 Card M-3b (gap found cross-checking M-3, 2026-09-08): the address that
// matters is the PUBLIC one -- `latestApkDownloadUrl()` with no argument,
// PUBLIC_RELEASE_BASE -- because that is the literal string the /go QR code
// bakes in and the update manifest ships. This function used to rebuild the
// URL from `repo` (= detectRepo()'s answer, or --repo=), so a release made
// against this machine's private-repo origin got HEADed on the PRIVATE repo's
// releases/latest/download path and printed "verified" -- a real HEAD, a real
// 200, and it answered a question nobody was asking. The drill always passed
// `--repo=flowmicapp/flowmic` so this never went red there.
//
// When `repo` is not the public repo, this gate cannot say anything about the
// public URL (that address is served by a release on a DIFFERENT repo, one
// this run did not touch) -- so it says that out loud and skips the HEAD,
// rather than HEADing the wrong address and calling it a pass.
async function assertLatestApkUrlServesThisBuild(repo, apk) {
  const url = latestApkDownloadUrl();
  const targetedUrl = latestApkDownloadUrl(`https://github.com/${repo}/releases`);
  if (targetedUrl !== url) {
    console.log(`⚠ this release targets ${repo}, not the public repo the fixed URL lives on.`);
    console.log(`  The public URL (${url}) is what the /go QR code and the update manifest actually use, and it is`);
    console.log(`  NOT verified by this run -- HEADing ${targetedUrl} would answer a question nobody is asking.`);
    console.log('  Skipping the check. Re-run --check-latest-apk from a checkout whose origin is the public repo');
    console.log('  (or with --repo=flowmicapp/flowmic) once this build is actually the one published there.');
    return;
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'flowmic-publish-github-release' },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    console.error(`\u2717 could not reach ${url}: ${e.message}`);
    console.error('  This gate has to answer yes or no. It answered neither, so the release is NOT verified.');
    process.exit(1);
  }
  if (res.status === 404) {
    console.error(`\u2717 ${url} -> 404.`);
    console.error(`  The release GitHub currently calls "latest" carries no asset named "${LATEST_APK_ASSET_NAME}".`);
    console.error('  Either this release is still a draft/prerelease (so "latest" is an older one), or the fixed-name upload did not land.');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`\u2717 ${url} -> HTTP ${res.status}. The fixed download URL is not serving the APK.`);
    process.exit(1);
  }
  const raw = res.headers.get('content-length');
  if (raw === null) {
    // Never pass on an absent measurement. A HEAD with no Content-Length is a
    // ruler that did not answer, and calling that green would make this gate
    // report success for a run in which it measured nothing at all.
    console.error(`\u2717 ${url} answered ${res.status} with no Content-Length header, so the byte size could not be compared.`);
    console.error('  Not treated as a pass: an unverified gate and a green gate must not look the same.');
    process.exit(1);
  }
  const served = Number(raw);
  if (served !== apk.size) {
    console.error(`\u2717 ${url}`);
    console.error(`  serves ${served} bytes; this round's ${apk.name} is ${apk.size} bytes.`);
    console.error('  Two causes, two different repairs:');
    console.error('   (a) the release just made is not the one GitHub calls "latest" -- a DRAFT or prerelease is excluded,');
    console.error('       so this URL is still serving the PREVIOUS release. Publish the release, then re-run with --check-latest-apk.');
    console.error(`   (b) the "${LATEST_APK_ASSET_NAME}" upload did not land (or landed truncated) -- re-upload it.`);
    process.exit(1);
  }
  ok(`${url} serves ${served} bytes = this round's ${apk.name} (fixed URL verified, card M-3)`);
}

function loadToken() {
  const t = process.env.FLOWMIC_GITHUB_RELEASE_TOKEN || process.env.GITHUB_TOKEN;
  if (!t) {
    console.error('✗ no token. Set FLOWMIC_GITHUB_RELEASE_TOKEN (or GITHUB_TOKEN) to a token with');
    console.error('  "contents: write" (fine-grained) or the classic "repo" scope, then re-run.');
    console.error('  This is deliberately a plain env var, not `gh auth token` — see the file header.');
    process.exit(1);
  }
  return t;
}

async function api(repo, token, method, path, body, extraHeaders = {}) {
  const isUpload = path.startsWith('https://');
  const url = isUpload ? path : `https://api.github.com/repos/${repo}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'flowmic-publish-github-release',
      ...extraHeaders,
    },
    body,
    signal: AbortSignal.timeout(3_600_000),
  });
  return res;
}

async function main() {
  const repo = detectRepo();

  // Card M-3, standalone gate. Deliberately BEFORE the body gates and before
  // anything that writes: this mode makes no release, uploads nothing and
  // reads no token -- its only job is to measure what the fixed URL is serving
  // right now against the APK this tree staged.
  if (CHECK_LATEST_APK) {
    const apkOnly = pickReleaseApk(collectArtifacts());
    await assertLatestApkUrlServesThisBuild(repo, apkOnly);
    return;
  }
  // Body BEFORE artifacts, deliberately. The body gates need no filesystem and
  // no network; collectArtifacts() hashes hundreds of megabytes. Refusing a
  // release page after paying for that is backwards, and it also made the
  // body gates untestable on any tree without a ./publish directory -- which
  // is every tree the public CI runs on (iron rule S1-13: a test that assumes
  // something only the private repo has is a test that dies with the wrong face).
  const section = changelogSection();
  const body = buildBody(section);

  // 🔴 English only — owner iron rule, 2026-08-15, laid down pointing at the
  // first public release page (its body had shipped in Chinese): version
  // introductions are written in English; English is the project's first
  // language. The gate lives HERE, on the bytes about to be published, not in
  // anyone's memory — same shape as opensource-sync's commit-message refusal.
  // CHANGELOG sections from 0.2.66 and earlier stay as written (history is
  // not retranslated); they are also never what this script publishes next.
  if (/[一-鿿㐀-䶿　-〿]/.test(body)) {
    console.error('✗ the release body contains CJK text. Release notes are English-only');
    console.error('  (owner iron rule 2026-08-15 — docs/decisions/2026-08-15-owner-english-first-release-notes.md).');
    console.error('  Rewrite the CHANGELOG section for this version in English, then re-run.');
    process.exit(1);
  }

  if (CATCH_UP) {
    console.log('');
    console.log('CATCH-UP RELEASE MODE IS ON (--catch-up-release).');
    console.log('  The six-item / 1200-character cap from the 2026-08-16 ruling is lifted for');
    console.log('  THIS run only, by the owner ruling of 2026-09-07: this page covers several');
    console.log('  versions that were never released publicly, so it lists all of their');
    console.log('  user-visible change. English-only and no-`###` still apply, plus two extra');
    console.log('  refusals (dashes, console/billing words) the normal path does not have.');
    assertCatchUpBodyClean(body);
  }

  assertConcise(body);

  const artifacts = collectArtifacts();

  // 🔴 Same 2026-09-09 owner ruling as the body gate above, extended from
  // "the Release page" to "the archive a user actually unpacks": every text
  // file INSIDE a portable zip must be English-only too, checked on the
  // bytes about to be uploaded — not on whoever wrote publish.mjs remembering
  // the rule. Runs before any network call, including under --dry-run, so a
  // bad archive is caught before it is even staged for publishing.
  for (const a of artifacts) {
    if (!/-portable-.*\.zip$/i.test(a.name)) continue;
    const zipBuf = readFileSync(a.path);
    const { findings, reason } = scanZipForCjk(zipBuf);
    if (reason) {
      console.error(zipUnreadableRefusalMessage(a.name, reason));
      process.exit(1);
    }
    if (findings.length > 0) {
      console.error(zipCjkRefusalMessage(a.name, findings));
      process.exit(1);
    }
  }

  // Card M-3: the same bytes, attached a second time under a fixed name.
  const apk = pickReleaseApk(artifacts);

  console.log(`\n── GitHub Release preview ──`);
  console.log(`repo   : ${repo}`);
  console.log(`tag    : ${TAG}`);
  console.log(`draft  : ${!PUBLISH}`);
  console.log('assets :');
  for (const a of artifacts) console.log(`  ${a.name}  ${(a.size / 1024 / 1024).toFixed(1)} MB  sha256=${a.hash.slice(0, 16)}…`);
  console.log(`  ${LATEST_APK_ASSET_NAME}  ${(apk.size / 1024 / 1024).toFixed(1)} MB  sha256=${apk.hash.slice(0, 16)}…  (second copy of ${apk.name}, card M-3)`);
  console.log(`fixed  : ${latestApkDownloadUrl(`https://github.com/${repo}/releases`)}`);
  console.log(`body   :\n${body}\n`);

  if (DRY) {
    ok('--dry-run: the above is what this run would do. Zero network requests were made — no release exists, nothing was uploaded.');
    return;
  }

  const token = loadToken();

  // Refuse instead of silently reusing/overwriting if this tag already has a release.
  const existing = await api(repo, token, 'GET', `/releases/tags/${TAG}`);
  if (existing.status === 200) {
    const j = await existing.json();
    console.error(`✗ a release for ${TAG} already exists: ${j.html_url}`);
    console.error('  delete it from the GitHub UI first if you really mean to replace it, then re-run.');
    process.exit(1);
  }
  if (existing.status !== 404) {
    console.error(`✗ unexpected HTTP ${existing.status} checking for an existing ${TAG} release: ${(await existing.text()).slice(0, 300)}`);
    process.exit(1);
  }

  const created = await api(repo, token, 'POST', '/releases', JSON.stringify({
    tag_name: TAG,
    name: section?.title ? `FlowMic ${section.title}` : `FlowMic ${VERSION}`,
    body,
    draft: !PUBLISH,
    prerelease: false,
  }), { 'Content-Type': 'application/json' });
  if (!created.ok) {
    console.error(`✗ could not create the release: HTTP ${created.status} ${(await created.text()).slice(0, 400)}`);
    process.exit(1);
  }
  const release = await created.json();
  ok(`created ${PUBLISH ? 'published' : 'draft'} release ${TAG} → ${release.html_url}`);

  const uploadBase = release.upload_url.replace(/\{.*\}$/, ''); // strip the "{?name,label}" URI template
  for (const a of artifacts) {
    await uploadAsset(repo, token, release, uploadBase, { assetName: a.name, path: a.path, size: a.size });
  }

  // Card M-3: the SAME file, a second time, under the version-less name. Not a
  // copy on disk and not a rebuild -- the identical bytes that were just
  // verified against their .sha256 sidecar, so "the fixed URL serves this
  // release's APK" is true by construction and then measured below anyway.
  await deleteAssetsNamed(repo, token, release, LATEST_APK_ASSET_NAME);
  await uploadAsset(repo, token, release, uploadBase, {
    assetName: LATEST_APK_ASSET_NAME, path: apk.path, size: apk.size,
  });

  console.log(`\nRelease ready: ${release.html_url}`);

  if (PUBLISH) {
    // The release is public as of this moment, so `releases/latest` should
    // already resolve to it. Gate, not a log line: a failure here exits 1.
    await assertLatestApkUrlServesThisBuild(repo, apk);
  } else {
    // Refuse to run the check rather than run it and fail: on the draft path a
    // mismatch is GUARANTEED and means nothing, and a gate that is red in
    // normal operation is a gate people learn to ignore. Say what is not yet
    // verified, and give the exact command that verifies it -- the check then
    // lives in a command instead of in someone's memory.
    console.log('It is a DRAFT — review it in the GitHub UI, then publish it there (or re-run with --publish next time).');
    console.log('');
    console.log('⚠ The fixed download URL is NOT verified yet, and cannot be while this release is a draft:');
    console.log(`  ${latestApkDownloadUrl()}`);
    console.log('  GitHub excludes drafts and prereleases from "latest", so that address is still serving the PREVIOUS');
    console.log("  release's APK right now. After you publish the draft, run:");
    console.log('      node scripts/publish-github-release.mjs --check-latest-apk');
    console.log("  It compares the bytes that URL serves against this round's APK and exits non-zero on any mismatch.");
  }
}

main().catch((e) => {
  console.error(`✗ ${e.stack || e.message}`);
  process.exit(1);
});
