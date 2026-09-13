// Card M-3 — the version-less APK copy and the fixed download URL.
//
// SUBJECT: scripts/publish-github-release.mjs (public — it ships in the
// open-source export, so this drill ships beside it; IT-12: a test and its
// subject travel together or not at all) and the two facts it imports from
// scripts/update-manifest-lib.mjs (LATEST_APK_ASSET_NAME, latestApkDownloadUrl).
//
// OWNER RULING 2026-09-08 (docs/decisions/2026-09-08-owner-web-client-signed-in-
// controls-and-stable-apk-url.md): every public release carries the Android
// build a SECOND time under a version-less name, so the /go download popup can
// bake ONE address into a QR code and never re-mint it.
//
// ── what this drills, and why each half is here ─────────────────────────────
//
//   1. the fixed name is really in the upload list (not just defined);
//   2. a HEAD on the fixed URL whose Content-Length disagrees with the local
//      APK FAILS the run — the check is a gate, not a log line;
//   3. --dry-run still makes ZERO network calls (the sentence it prints);
//   4. the draft path uploads the fixed copy but does NOT pretend to have
//      verified the URL — on a draft a mismatch is guaranteed and meaningless,
//      and a gate that is red in normal operation is a gate people switch off;
//   5. overwrite semantics are explicit: an already-present asset of the fixed
//      name is DELETED before the upload of that same name (never a silent
//      duplicate, never a 422 the operator has to read GitHub's docs to decode);
//   6. REVERSE CONTROL — the same red scenario is driven through a copy of the
//      script with the size comparison neutered, and must go GREEN there. A
//      drill that only ever sees the fixed code proves that the code agrees
//      with itself. This is the half that says "if I were wrong, this file is
//      what would tell me".
//
// SAFETY: no network. global fetch is replaced in the child process before the
// script's top-level code runs (the s8-release-script-defects.test.mjs
// preload pattern), every run points ROOT at a throwaway fixture under the OS
// temp dir, and the only token that exists is a fixture-only fake string passed
// as an ephemeral env var. No release is created anywhere, nothing is uploaded,
// and github.com is never contacted.
//
// ⚠️ WHAT THIS CANNOT PROVE, stated so nobody reads it as more than it is: that
// GitHub really resolves `releases/latest/download/<name>` the way the header
// of publish-github-release.mjs says it does. That is an assertion about
// somebody else's server and only a real published release can settle it. What
// is proved here is that OUR side measures it and refuses on a mismatch.
//
// Run: `node scripts/m3-latest-apk-asset.test.mjs`

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUBJECT = 'publish-github-release.mjs';
const REPO = 'flowmicapp/flowmic';
const FIXED_NAME = 'flowmic-release-latest.apk';
const FIXED_URL = `https://github.com/${REPO}/releases/latest/download/${FIXED_NAME}`;

let failures = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); failures++; }
}

// ── the fixture mirrors the MODULE GRAPH, it does not remember a file list ──
// publish-github-release.mjs imports update-manifest-lib.mjs, which imports
// three more. Copying a hand-kept list of files is the same hand-maintained
// second answer that s8-release-script-defects.test.mjs had to learn about
// (its fixture copied one file and stopped resolving the day the subject grew
// an import). Walking the relative imports means the fixture is correct on the
// day the graph changes, not on the day someone remembers it changed.
function copyClosure(destScriptsDir, entry, mutate) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    let src = readFileSync(join(REPO_ROOT, 'scripts', name), 'utf8');
    if (name === entry && mutate) src = mutate(src);
    writeFileSync(join(destScriptsDir, name), src);
    for (const m of src.matchAll(/from\s+'\.\/([A-Za-z0-9._-]+\.mjs)'/g)) queue.push(m[1]);
  }
  return seen;
}

const APK_BYTES = Buffer.from('fixture apk bytes, not a real Android package, card M-3 drill');
const MSI_BYTES = Buffer.from('fixture msi bytes');
const FIXTURE_VERSION = '9.9.9-fixture';

function buildFixture(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'm3-latest-apk-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: FIXTURE_VERSION }));
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  copyClosure(scripts, SUBJECT, mutate);

  const out = join(root, 'publish');
  mkdirSync(out, { recursive: true });
  const stage = (name, bytes) => {
    writeFileSync(join(out, name), bytes);
    writeFileSync(join(out, `${name}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  };
  const apkName = `FlowMic-${FIXTURE_VERSION}-release.apk`;
  stage(apkName, APK_BYTES);
  stage(`FlowMic_${FIXTURE_VERSION}_x64_en-US.msi`, MSI_BYTES);
  return { root, scriptPath: join(scripts, SUBJECT), apkName };
}

// ── the fetch stub ──────────────────────────────────────────────────────────
// Answers the four GitHub REST shapes this script uses plus the HEAD on the
// fixed URL, records every call, and throws loudly on anything else — an
// unexpected call must not look like a passing run.
function writeFetchStub(dir, log, opts) {
  const p = join(dir, 'fetch-stub-preload.mjs');
  writeFileSync(p, `
import { appendFileSync } from 'node:fs';
const LOG = ${JSON.stringify(log)};
const OPTS = ${JSON.stringify(opts)};
const rec = (method, url) => appendFileSync(LOG, method + ' ' + url + '\\n');
const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  rec(method, u);
  if (method === 'HEAD') {
    if (OPTS.headStatus !== 200) return { ok: false, status: OPTS.headStatus, headers: { get: () => null }, text: async () => '' };
    const len = OPTS.headLength === null ? null : String(OPTS.headLength);
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-length' ? len : null) }, text: async () => '' };
  }
  if (method === 'GET' && /\\/releases\\/tags\\//.test(u)) return json(404, { message: 'Not Found' });
  if (method === 'POST' && /\\/repos\\/[^/]+\\/[^/]+\\/releases$/.test(u)) {
    return json(201, { id: 4242, html_url: 'https://example.invalid/release', upload_url: 'https://uploads.invalid/assets{?name,label}' });
  }
  if (method === 'GET' && /\\/releases\\/4242\\/assets/.test(u)) return json(200, OPTS.existingAssets);
  if (method === 'DELETE' && /\\/releases\\/assets\\//.test(u)) return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
  if (method === 'POST' && u.startsWith('https://uploads.invalid/assets')) {
    const size = init.body && typeof init.body.size === 'number' ? init.body.size : 0;
    return json(201, { size, name: decodeURIComponent(u.split('name=')[1] || '') });
  }
  throw new Error('M3-TEST-STUB: unexpected ' + method + ' ' + u);
};
`);
  return p;
}

function run(label, { args, headLength = APK_BYTES.length, headStatus = 200, existingAssets = [], mutate, withToken = true }) {
  const { root, scriptPath, apkName } = buildFixture(mutate);
  const log = join(root, 'fetch-calls.log');
  writeFileSync(log, '');
  const preload = writeFetchStub(root, log, { headLength, headStatus, existingAssets });
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  // Fixture-only fake, never real, only ever an env var of this throwaway child.
  if (withToken) env.FLOWMIC_GITHUB_RELEASE_TOKEN = 'fixture-fake-token-not-real-3ab91c';
  else delete env.FLOWMIC_GITHUB_RELEASE_TOKEN;

  const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, scriptPath, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000,
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  rmSync(root, { recursive: true, force: true });
  return { label, apkName, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status, calls };
}

const NOTES = '--notes=## 9.9.9-fixture\n\n- One user-visible line, so the body gates have something legal to read.';
const BASE = [`--repo=${REPO}`, NOTES];

// ═══════════════════════════════════════════════════════════════════════════
section('1 — --dry-run lists the fixed-name copy AND the fixed URL, and dials nothing');
{
  const r = run('dry', { args: ['--dry-run', ...BASE] });
  console.log(r.stdout.slice(0, 1400));
  console.log(`--- exit ${r.status}; fetch calls: ${JSON.stringify(r.calls)} ---`);
  assertTrue(r.status === 0, 'exit 0');
  assertTrue(r.calls.length === 0, 'ZERO network calls (--dry-run keeps its own sentence true)');
  assertTrue(r.stdout.includes(FIXED_NAME), `the upload list names ${FIXED_NAME}`);
  assertTrue(r.stdout.includes(`(second copy of ${r.apkName}`), 'and says it is a second copy of this round’s APK, not a different build');
  assertTrue(r.stdout.includes(FIXED_URL), 'the preview prints the fixed URL it is promising');
}

section('2 — the real upload path attaches BOTH names, then verifies the fixed URL');
{
  const r = run('publish-ok', { args: ['--publish', ...BASE] });
  console.log(r.stdout.slice(0, 1600));
  console.log(`--- exit ${r.status} ---`);
  const uploads = r.calls.filter((c) => c.startsWith('POST https://uploads.invalid/assets'));
  assertTrue(r.status === 0, 'exit 0');
  assertTrue(uploads.some((c) => c.includes(encodeURIComponent(r.apkName))), 'the version-pinned APK is uploaded (unchanged behaviour)');
  assertTrue(uploads.some((c) => c.includes(encodeURIComponent(FIXED_NAME))), `the fixed name ${FIXED_NAME} is uploaded too`);
  assertTrue(r.calls.some((c) => c === `HEAD ${FIXED_URL}`), 'a HEAD is issued against the fixed URL');
  assertTrue(new RegExp(`serves ${APK_BYTES.length} bytes = this round`).test(r.stdout), 'the receipt states the byte count it compared');
}

section('3 — RED: the fixed URL serves a DIFFERENT byte count ⇒ the run fails');
{
  const r = run('publish-mismatch', { args: ['--publish', ...BASE], headLength: APK_BYTES.length + 17 });
  console.log(r.stderr.slice(0, 1200));
  console.log(`--- exit ${r.status} ---`);
  assertTrue(r.status !== 0, 'exit non-zero (a gate, not a log line)');
  assertTrue(r.stderr.includes(`serves ${APK_BYTES.length + 17} bytes`), 'stderr names what the URL served');
  assertTrue(r.stderr.includes(`is ${APK_BYTES.length} bytes`), 'and what this round actually built');
  assertTrue(/DRAFT or prerelease is excluded/.test(r.stderr), 'stderr names cause (a): the previous release is still "latest"');
  assertTrue(/did not land \(or landed truncated\)/.test(r.stderr), 'stderr names cause (b): the upload failed');
}

section('4 — RED: a HEAD with no Content-Length is NOT a pass');
{
  const r = run('publish-no-length', { args: ['--publish', ...BASE], headLength: null });
  console.log(r.stderr.slice(0, 700));
  assertTrue(r.status !== 0, 'exit non-zero');
  assertTrue(/no Content-Length header/.test(r.stderr), 'stderr says the measurement never happened');
  assertTrue(/an unverified gate and a green gate must not look the same/.test(r.stderr), 'and refuses to let those two look alike');
}

section('5 — RED: the fixed URL 404s (latest release carries no such asset)');
{
  const r = run('publish-404', { args: ['--publish', ...BASE], headStatus: 404 });
  console.log(r.stderr.slice(0, 700));
  assertTrue(r.status !== 0, 'exit non-zero');
  assertTrue(r.stderr.includes(`carries no asset named "${FIXED_NAME}"`), 'stderr distinguishes 404 from a size mismatch');
}

section('6 — the DRAFT path uploads the fixed copy but refuses to claim the URL is verified');
{
  const r = run('draft', { args: BASE });
  console.log(r.stdout.slice(0, 1800));
  console.log(`--- exit ${r.status} ---`);
  assertTrue(r.status === 0, 'exit 0');
  assertTrue(r.calls.some((c) => c.includes(encodeURIComponent(FIXED_NAME))), 'the fixed-name asset is still uploaded on a draft');
  assertTrue(!r.calls.some((c) => c.startsWith('HEAD ')), 'NO HEAD is issued (on a draft a mismatch is guaranteed and means nothing)');
  assertTrue(/NOT verified yet/.test(r.stdout), 'stdout says out loud that the URL is unverified');
  assertTrue(/--check-latest-apk/.test(r.stdout), 'and hands over the exact command that verifies it after publishing');
}

section('7 — overwrite semantics: an existing asset of the fixed name is DELETED before its upload');
{
  const existing = [{ id: 77, name: FIXED_NAME }, { id: 78, name: 'FlowMic-9.9.9-fixture-release.apk' }];
  const r = run('overwrite', { args: ['--publish', ...BASE], existingAssets: existing });
  console.log(r.stdout.slice(0, 1600));
  const del = r.calls.findIndex((c) => c.startsWith('DELETE ') && c.includes('/releases/assets/77'));
  const up = r.calls.findIndex((c) => c.startsWith('POST https://uploads.invalid/assets') && c.includes(encodeURIComponent(FIXED_NAME)));
  console.log(`--- delete@${del} upload@${up} ---`);
  assertTrue(r.status === 0, 'exit 0');
  assertTrue(del !== -1, 'the colliding asset is deleted (GitHub answers 422 on a name collision; "upload again" does not exist)');
  assertTrue(up !== -1 && del < up, 'and the delete happens BEFORE its own upload, not as a separate sweep');
  assertTrue(!r.calls.some((c) => c.startsWith('DELETE ') && c.includes('/releases/assets/78')), 'nothing else is deleted — only the fixed name is ever replaced');
}

section('8 — --check-latest-apk is a standalone gate: no writes, and it can fail');
{
  const good = run('check-ok', { args: ['--check-latest-apk', `--repo=${REPO}`] });
  console.log(good.stdout.slice(0, 600));
  console.log(`--- exit ${good.status}; calls ${JSON.stringify(good.calls)} ---`);
  assertTrue(good.status === 0, 'exit 0 when the served size matches');
  assertTrue(good.calls.length === 1 && good.calls[0] === `HEAD ${FIXED_URL}`, 'exactly one call, and it is the HEAD (no release created, nothing uploaded)');

  const bad = run('check-bad', { args: ['--check-latest-apk', `--repo=${REPO}`], headLength: 1 });
  console.log(bad.stderr.slice(0, 500));
  assertTrue(bad.status !== 0, 'exit non-zero when it does not');

  const clash = run('check-dry', { args: ['--check-latest-apk', '--dry-run', `--repo=${REPO}`] });
  assertTrue(clash.status !== 0 && /mutually exclusive/.test(clash.stderr), '--check-latest-apk with --dry-run is refused, not silently resolved');
}

// ═══════════════════════════════════════════════════════════════════════════
// CARD M-3b — the gap a cross-check found in M-3: the sections above all pass
// `--repo=flowmicapp/flowmic`, which IS the public repo `latestApkDownloadUrl()`
// defaults to, so the old bug (rebuilding the fixed URL from `--repo`/git origin
// instead of using the public one) never showed up here. On the machine that
// actually runs this script, `origin` is the PRIVATE repo
// (flowmicapp/<private-dev-repo>) — HEADing a URL built from THAT would be a
// real network call, a real 200, and a "verified" receipt for an address the
// web client's QR code never points at.
const PRIVATE_REPO = 'flowmicapp/<private-dev-repo>';

section('8b — M-3b RED-turned-fix: releasing against a NON-public repo skips the HEAD and says so');
{
  const r = run('private-repo', { args: ['--publish', `--repo=${PRIVATE_REPO}`, NOTES] });
  console.log(r.stdout.slice(-1200));
  console.log(`--- exit ${r.status}; fetch calls: ${JSON.stringify(r.calls)} ---`);
  assertTrue(r.status === 0, 'exit 0 (a skip is a notice, not a failure)');
  assertTrue(!r.calls.some((c) => c.startsWith('HEAD ')), 'NO HEAD is issued against ANY url -- least of all one built from the private repo');
  assertTrue(new RegExp(`this release targets ${PRIVATE_REPO.replace('/', '\\/')}, not the public repo`).test(r.stdout), 'stdout names the mismatch out loud');
  assertTrue(r.stdout.includes(FIXED_URL), 'and names the actual public URL that is NOT being verified');
  assertTrue(/Skipping the check/.test(r.stdout), 'and says the check was skipped, not silently passed');
}

section('8c — M-3b: releasing against the PUBLIC repo HEADs exactly what latestApkDownloadUrl() returns');
{
  const lib = await import('./update-manifest-lib.mjs');
  const r = run('public-repo-exact-url', { args: ['--publish', ...BASE] });
  assertTrue(r.status === 0, 'exit 0');
  assertTrue(r.calls.some((c) => c === `HEAD ${lib.latestApkDownloadUrl()}`), 'the HEAD target is the literal string latestApkDownloadUrl() returns, not one rebuilt from --repo');
  assertTrue(lib.latestApkDownloadUrl() === FIXED_URL, 'sanity: for this fixture the public URL and --repo=flowmicapp/flowmic happen to compose to the same string');
}

section('8d — M-3b: --check-latest-apk reads no token, proven by actually running it without one');
{
  const r = run('check-no-token', { args: ['--check-latest-apk', `--repo=${REPO}`], withToken: false });
  console.log(r.stdout.slice(0, 400));
  console.log(`--- exit ${r.status} ---`);
  assertTrue(r.status === 0, 'exit 0 with FLOWMIC_GITHUB_RELEASE_TOKEN and GITHUB_TOKEN both absent from the environment');
  assertTrue(r.calls.length === 1 && r.calls[0] === `HEAD ${FIXED_URL}`, 'it still did exactly the one HEAD, nothing else');
  assertTrue(!/no token/.test(r.stdout) && !/no token/.test(r.stderr), 'no "no token" refusal was ever printed (the mode never calls loadToken())');
}

// REVERSE CONTROL for M-3b itself: put the pre-fix behaviour back (rebuild the
// HEAD target from --repo/detectRepo() instead of using latestApkDownloadUrl()
// with no argument) and show that 8b's negative assertion ("NO HEAD is issued
// for the private repo") goes RED under that old code -- i.e. 8b actually
// catches the bug this card exists to fix, not just a differently-worded pass.
section('8e — REVERSE CONTROL (M-3b): rebuild the HEAD url from --repo again ⇒ a HEAD fires for the private repo');
{
  const ANCHOR = 'const url = latestApkDownloadUrl();';
  let applied = 0;
  const mutate = (src) => {
    applied = src.split(ANCHOR).length - 1;
    return src.replace(ANCHOR, 'const url = latestApkDownloadUrl(`https://github.com/${repo}/releases`);');
  };
  const r = run('reverse-repo-rebuild', { args: ['--publish', `--repo=${PRIVATE_REPO}`, NOTES], mutate });
  console.log(r.stdout.slice(-500));
  console.log(`--- exit ${r.status}; fetch calls: ${JSON.stringify(r.calls)} ---`);
  assertTrue(applied === 1, `the mutation anchor was found exactly once (found ${applied}) — otherwise this control proves nothing`);
  assertTrue(r.calls.some((c) => c.startsWith('HEAD ')), 'reverting to the old repo-rebuilt URL DOES issue a HEAD for the private-repo case -- exactly the bug 8b now catches');
  assertTrue(r.calls.some((c) => c.includes(PRIVATE_REPO)), 'and that HEAD is against the PRIVATE repo\'s releases path -- a real network call to the wrong address, dressed as "verified"');
}

// ═══════════════════════════════════════════════════════════════════════════
// REVERSE CONTROL — break the size comparison, prove scenario 3 goes green.
//
// Not a claim, an execution: the same mismatching stub is driven through a copy
// of the subject whose comparison has been neutered, and the assertion below
// FAILS if that copy still refuses. The mutation is itself asserted to have
// applied — a reverse control that silently mutated nothing would be the
// friendliest possible lie ("先核你的尺子").
section('9 — REVERSE CONTROL: with the size compare neutered, the same red run goes green');
{
  const ANCHOR = 'if (served !== apk.size) {';
  let applied = 0;
  const mutate = (src) => {
    applied = src.split(ANCHOR).length - 1;
    return src.replace(ANCHOR, 'if (false && served !== apk.size) {');
  };
  const r = run('reverse', { args: ['--publish', ...BASE], headLength: APK_BYTES.length + 17, mutate });
  console.log(r.stdout.slice(-500));
  console.log(`--- exit ${r.status} ---`);
  assertTrue(applied === 1, `the mutation anchor was found exactly once (found ${applied}) — otherwise this control proves nothing`);
  assertTrue(r.status === 0, 'the mutated copy ACCEPTS the wrong byte count (i.e. scenario 3 is caught by that comparison and nothing else)');
}

// ── the constant lives in one place, and this is where that is checked ──────
section('10 — the name and the URL come from update-manifest-lib.mjs, not from a copy');
{
  const lib = await import('./update-manifest-lib.mjs');
  assertTrue(lib.LATEST_APK_ASSET_NAME === FIXED_NAME, `LATEST_APK_ASSET_NAME === "${FIXED_NAME}" (owner ruling 2026-09-08)`);
  assertTrue(lib.latestApkDownloadUrl(`https://github.com/${REPO}/releases`) === FIXED_URL, 'latestApkDownloadUrl composes the releases/latest/download form');
  assertTrue(lib.latestApkDownloadUrl().startsWith(lib.PUBLIC_RELEASE_BASE), 'its default base is the public release base (one owner for the repo slug)');
  const subject = readFileSync(join(REPO_ROOT, 'scripts', SUBJECT), 'utf8');
  assertTrue(!subject.includes(`'${FIXED_NAME}'`) && !subject.includes(`"${FIXED_NAME}"`), 'the publisher IMPORTS the name and never spells it out a second time');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
