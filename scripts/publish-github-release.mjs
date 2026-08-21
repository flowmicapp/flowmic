// FlowMic → GitHub Releases publisher (S7, 0.3.0).
//
// STATUS: this is new tooling written for the S1/S7 gap "GitHub Releases upload
// has zero tooling" (docs/strategy/2026-08-04-0.3.0-task-book-cn.md S1/S7). It
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

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, openAsBlob } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'publish');
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
const REPO_OVERRIDE = typeof flag('repo') === 'string' ? flag('repo') : undefined;

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
  if (body.length > MAX_BODY_CHARS) {
    problems.push(`it is ${body.length} characters (limit ${MAX_BODY_CHARS})`);
  }
  if (items.length > MAX_BODY_LINES) {
    problems.push(`it is ${items.length} items (limit ${MAX_BODY_LINES}; wrapped continuation lines are indented and not counted)`);
  }
  if (problems.length === 0) return;
  console.error('✗ the release body is not the short, human summary a release page is for:');
  for (const p of problems) console.error(`  · ${p}`);
  console.error('  Write three to five short lines at the top of the CHANGELOG section, above the first `###`;');
  console.error('  that lead is what gets published. Everything below it stays in the file for whoever wants it.');
  console.error('  (owner ruling 2026-08-16 — docs/decisions/2026-08-16-owner-concise-human-release-notes.md).');
  process.exit(1);
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
  const artifacts = collectArtifacts();
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

  assertConcise(body);

  console.log(`\n── GitHub Release preview ──`);
  console.log(`repo   : ${repo}`);
  console.log(`tag    : ${TAG}`);
  console.log(`draft  : ${!PUBLISH}`);
  console.log('assets :');
  for (const a of artifacts) console.log(`  ${a.name}  ${(a.size / 1024 / 1024).toFixed(1)} MB  sha256=${a.hash.slice(0, 16)}…`);
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
  const contentType = (name) => (name.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/x-msi');
  for (const a of artifacts) {
    const blob = await openAsBlob(a.path, { type: contentType(a.name) });
    const res = await api(repo, token, 'POST', `${uploadBase}?name=${encodeURIComponent(a.name)}`, blob, {
      'Content-Type': contentType(a.name),
    });
    if (!res.ok) {
      console.error(`✗ upload of ${a.name} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      console.error(`  the release itself was already created (${release.html_url}) — fix and re-upload manually, or delete the draft and re-run.`);
      process.exit(1);
    }
    const asset = await res.json();
    if (asset.size !== a.size) {
      console.error(`✗ ${a.name} uploaded but GitHub reports size ${asset.size}, local is ${a.size} — re-upload, do not trust this asset.`);
      process.exit(1);
    }
    ok(`uploaded ${a.name} (${asset.size} bytes, matches local)`);
  }

  console.log(`\nRelease ready: ${release.html_url}`);
  if (!PUBLISH) console.log('It is a DRAFT — review it in the GitHub UI, then publish it there (or re-run with --publish next time).');
}

main().catch((e) => {
  console.error(`✗ ${e.stack || e.message}`);
  process.exit(1);
});
