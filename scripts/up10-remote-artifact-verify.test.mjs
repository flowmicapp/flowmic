// UP-10 drill for scripts/verify-remote-artifact.mjs and its wiring into
// scripts/build-update-manifest.mjs.
//
// WHAT UP-10 IS. The manifest generator read ./publish, recomputed each
// artifact's sha256 from the local file, composed a URL, and wrote the manifest
// — without ever asking the SITE anything. So 「先产物后清单」 held only within a
// single publish run, by call order; run the manifest step alone and it emits a
// well-formed manifest full of URLs that dereference to nothing. That has
// happened. This file's job is to prove it now goes RED, and — just as important
// — that the three red outcomes do not read alike, because they demand three
// different actions.
//
// SAFETY — read before touching this file:
//   - This test NEVER imports and NEVER spawns scripts/build-update-manifest.mjs.
//     That script is ALL top-level statements with no main-module guard, so
//     importing it runs it: it would read the real ./publish, and (the point of
//     this card) reach out to the real LAN download center. It is read here as
//     TEXT only, exactly as the IT-33 and UP-9 drills read publish.mjs.
//   - It DOES import scripts/verify-remote-artifact.mjs, which is why that module
//     exists as a separate file: it is pure (no side effects, no I/O at import),
//     so the mechanism can be DRIVEN against a real server instead of being
//     re-derived in the test. A test that re-implements its subject proves only
//     that the test agrees with itself.
//   - Every HTTP request this file makes goes to a loopback server it started on
//     127.0.0.1:0 (a kernel-assigned port) and shut down in a `finally`. Nothing
//     contacts the real download center. Nothing is written anywhere in this
//     repo; the fixtures are in-memory buffers.
//
// WHY A REAL SERVER AND NOT A STUBBED fetch. The claims under test are about
// what the runtime does with a real response: that redirects are followed to a
// final 200, that a non-200 is separated from a transport failure, that the body
// is streamed and hashed rather than trusted. A hand-written fake `fetch` would
// let this file assert its own beliefs about undici — precisely the shape
// CLAUDE.md records as「测试把我们的假设念回给我们听」. The one case that cannot
// use a server is 'unreachable', and that one uses a REAL closed port (a real
// ECONNREFUSED) rather than a thrown fake.
//
// EXIT CODES (card IT-38 — see scripts/run-script-tests.mjs's header):
// 0 = PASS, 1 = FAIL, 2 = SKIP. This file never skips: every section depends
// only on loopback sockets, in-memory buffers, and repo source text, all of
// which exist in a fresh clone.
//
// Run: `node scripts/up10-remote-artifact-verify.test.mjs`
// Also run automatically by `pnpm verify:scripts` (inside verify:delivery),
// which DISCOVERS scripts/*.test.mjs by glob rather than by a hand-kept list.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_REMOTE_TIMEOUT_MS,
  REMOTE_VERIFY_SKIP_FLAG,
  gateRemoteArtifacts,
  remoteRefusalMessage,
  remoteVerifySkipBanner,
  verifyRemoteArtifact,
} from './verify-remote-artifact.mjs';
// The URL shape is imported, not re-spelled: §6 used to pin it by matching the
// builder's source text, and that pin went stale the moment the base moved to
// the public release area (card PUB-1, 2026-08-15). Driving the real composer
// means these fixtures cannot model a path nobody builds — the same argument
// this drill makes for driving the real gate instead of re-implementing it.
import { updateArtifactUrl } from './update-manifest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER_SRC = readFileSync(join(ROOT, 'scripts', 'build-update-manifest.mjs'), 'utf8'); // text only
const MODULE_SRC = readFileSync(join(ROOT, 'scripts', 'verify-remote-artifact.mjs'), 'utf8');

let failures = 0;
let sectionsRun = 0;
const TOTAL_SECTIONS = 7;
const samples = {};
const section = (title) => {
  sectionsRun += 1;
  console.log(`\n=== ${title} ===`);
};
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────
// Random bytes, not a repeating pattern: a truncation bug that happened to stop
// on a period boundary could pass unnoticed against `'a'.repeat(n)`.
const PROJECT = 'flowmic';
const CHANNEL = 'release';
const FIXTURE_VERSION = '0.0.0-fixture';
const APK_NAME = `FlowMic-${FIXTURE_VERSION}-release.apk`;
const MSI_NAME = `FlowMic_${FIXTURE_VERSION}_x64_zh-CN.msi`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const APK_BYTES = randomBytes(300_000);
const MSI_BYTES = randomBytes(120_000);

/** The path shape build-update-manifest.mjs composes — produced by the very
 *  function the builder calls, with an empty base so what comes back is the
 *  path. Nothing here can drift from the real thing without this drill changing
 *  shape with it. */
const filesPath = (name) => updateArtifactUrl('', FIXTURE_VERSION, name);

/** Start a loopback server, run `fn` against its base URL, always shut it down.
 *  `closeAllConnections()` first: undici keeps sockets alive, and without it
 *  `close()` waits for them and this drill hangs instead of finishing. */
async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A site that serves the fixtures correctly, plus a `/dl/` alias that 302s to
 *  the versioned path — the real site's shape, per the measurement in 25904fa. */
function goodSite(req, res) {
  const url = decodeURIComponent(req.url);
  if (url === `/dl/${PROJECT}/${CHANNEL}/${APK_NAME}`) {
    res.writeHead(302, { location: decodeURIComponent(filesPath(APK_NAME)) });
    res.end();
    return;
  }
  if (url === decodeURIComponent(filesPath(APK_NAME))) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(APK_BYTES);
    return;
  }
  if (url === decodeURIComponent(filesPath(MSI_NAME))) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(MSI_BYTES);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

/** The composed manifest fragment the gate consumes — the same shape
 *  build-update-manifest.mjs builds in `platforms`. */
const platformsFor = (base) => ({
  android: {
    version: FIXTURE_VERSION,
    artifacts: [{
      kind: 'apk', locale: null, filename: APK_NAME,
      url: `${base}${filesPath(APK_NAME)}`, sha256: sha256(APK_BYTES), size: APK_BYTES.length,
    }],
  },
  'windows-x64': {
    version: FIXTURE_VERSION,
    artifacts: [{
      kind: 'msi', locale: 'zh-CN', filename: MSI_NAME,
      url: `${base}${filesPath(MSI_NAME)}`, sha256: sha256(MSI_BYTES), size: MSI_BYTES.length,
    }],
  },
});

// ── §1 the happy path, against a real server ────────────────────────────────
section('§1 a file that IS on the site, byte-for-byte, verifies');
await withServer(goodSite, async (base) => {
  samples['§1 real HTTP round-trips'] = 2;
  const r = await verifyRemoteArtifact({
    url: `${base}${filesPath(APK_NAME)}`, sha256: sha256(APK_BYTES), size: APK_BYTES.length,
  });
  assertTrue(r.verdict === 'ok', "a matching artifact → verdict 'ok'");
  assertTrue(r.status === 200, 'it records the final status (200)');
  assertTrue(r.remoteSize === APK_BYTES.length, `it MEASURED the remote size (${r.remoteSize}) rather than trusting a header`);
  assertTrue(r.remoteSha256 === sha256(APK_BYTES), 'it hashed the bytes that actually came back');
  assertTrue(r.redirected === false, 'the version-pinned URL does not redirect');

  // 🔴 Redirects: the `/dl/` shape 302s, and the check must follow it to the
  // final answer rather than reading the 302 as a non-200 refusal.
  const viaRedirect = await verifyRemoteArtifact({
    url: `${base}/dl/${PROJECT}/${CHANNEL}/${APK_NAME}`, sha256: sha256(APK_BYTES), size: APK_BYTES.length,
  });
  assertTrue(viaRedirect.verdict === 'ok', 'a 302 is FOLLOWED to the final 200, not refused as a non-200');
  assertTrue(viaRedirect.redirected === true, 'and the redirect is recorded rather than absorbed silently');
  // Derived from the composer, not spelled as a literal: this assertion used to
  // hard-code `/files/` and went red the day the path moved (PUB-1). What it is
  // actually about is that the POST-redirect url is reported rather than the one
  // that was asked for — so it pins that, against whatever path is current.
  assertTrue(
    viaRedirect.finalUrl.includes(decodeURIComponent(filesPath(APK_NAME))),
    `the FINAL url is reported (${viaRedirect.finalUrl.slice(-48)})`,
  );
});

// ── §2 a 404 — the silent failure this card exists to catch ─────────────────
section('§2 a URL that 404s is refused, and the refusal names the URL');
await withServer(goodSite, async (base) => {
  samples['§2 404 round-trips'] = 2;
  const missingUrl = `${base}${filesPath('FlowMic-0.0.0-fixture-portable-windows-x64.zip')}`;
  const r = await verifyRemoteArtifact({ url: missingUrl, sha256: sha256(APK_BYTES), size: APK_BYTES.length });
  assertTrue(r.verdict === 'not-found', "a 404 → verdict 'not-found'");
  assertTrue(r.status === 404, 'it reports the status it actually got');
  assertTrue(r.remoteSha256 === null && r.remoteSize === null, 'nothing is claimed about bytes that never arrived');

  const msg = remoteRefusalMessage('FlowMic-0.0.0-fixture-portable-windows-x64.zip', r);
  assertTrue(msg.includes(missingUrl), 'the refusal NAMES THE URL — the operator can paste it into a browser and see for themselves');
  assertTrue(/NOT ON THE DOWNLOAD CENTER/.test(msg), 'it says plainly that the file is not on the site');
  assertTrue(/upload them first/i.test(msg), 'it names the action: upload the artifacts, then re-run');
  assertTrue(msg.includes('先产物后清单'), 'it names the rule it is enforcing, so the refusal teaches rather than merely blocks');

  // A 500 is also 'not-found' by verdict (the URL did not yield the file) but
  // must still carry its real status, or the operator goes looking for a missing
  // upload when the site is broken.
  const boom = await withServer((_req, res) => { res.writeHead(500); res.end('boom'); }, (b) =>
    verifyRemoteArtifact({ url: `${b}/anything`, sha256: sha256(APK_BYTES), size: 1 }));
  assertTrue(boom.verdict === 'not-found' && boom.status === 500, 'a 500 is refused too, and reports 500 rather than being flattened into "404"');
});

// ── §3 200 with the WRONG BYTES — must not read like a 404 ──────────────────
// The card's sharpest requirement: these two refusals must be distinguishable,
// because "upload it" and "upload it AGAIN" are different instructions and only
// one of them is right in each case.
section('§3 wrong bytes at a live URL are refused, and distinguishably from a 404');
{
  samples['§3 mismatch round-trips'] = 3;
  const stale = randomBytes(APK_BYTES.length + 4096);          // different length
  const sameLen = randomBytes(APK_BYTES.length);               // same length, different bytes

  const mismatch = await withServer((_req, res) => { res.writeHead(200); res.end(stale); }, (b) =>
    verifyRemoteArtifact({ url: `${b}${filesPath(APK_NAME)}`, sha256: sha256(APK_BYTES), size: APK_BYTES.length }));
  assertTrue(mismatch.verdict === 'content-mismatch', "200 with different bytes → 'content-mismatch', NOT 'ok' and NOT 'not-found'");
  assertTrue(mismatch.remoteSize === stale.length && mismatch.remoteSha256 === sha256(stale), 'it reports what it actually measured on the wire, as evidence');

  const truncated = await withServer((_req, res) => { res.writeHead(200); res.end(APK_BYTES.subarray(0, 1000)); }, (b) =>
    verifyRemoteArtifact({ url: `${b}${filesPath(APK_NAME)}`, sha256: sha256(APK_BYTES), size: APK_BYTES.length }));
  assertTrue(truncated.verdict === 'content-mismatch', 'a truncated upload is caught — the size check alone would catch this one');

  const swapped = await withServer((_req, res) => { res.writeHead(200); res.end(sameLen); }, (b) =>
    verifyRemoteArtifact({ url: `${b}${filesPath(APK_NAME)}`, sha256: sha256(APK_BYTES), size: APK_BYTES.length }));
  assertTrue(swapped.verdict === 'content-mismatch', '🔴 SAME LENGTH, different bytes is caught too — this is the case a size-only check would pass');

  // The messages, which is where the distinction actually has to survive.
  const mm = remoteRefusalMessage(APK_NAME, mismatch);
  const nf = remoteRefusalMessage(APK_NAME, { ...mismatch, verdict: 'not-found', status: 404 });
  assertTrue(/SERVING DIFFERENT BYTES/.test(mm), 'the mismatch refusal says the site is serving different bytes');
  assertTrue(/NOT a 404/.test(mm), 'and says explicitly that this is NOT a 404 — the confusion is pre-empted in the text itself');
  assertTrue(mm.includes(mismatch.remoteSha256.slice(0, 12)) && mm.includes(mismatch.expectedSha256.slice(0, 12)), 'it prints BOTH hashes, so the claim can be checked rather than believed');
  assertTrue(/refuse to install/.test(mm), 'it states the consequence: clients would hash and refuse — broken, not merely absent');
  assertTrue(mm !== nf && !/NOT ON THE DOWNLOAD CENTER/.test(mm), 'the mismatch and 404 refusals are two different texts');

  // Same length vs different length are diagnosed differently, because the
  // likely causes differ (corrupt/other build vs stale or cut-short upload).
  const sameLenMsg = remoteRefusalMessage(APK_NAME, swapped);
  assertTrue(/same length but different bytes/.test(sameLenMsg), 'a same-length mismatch is named as such');
  assertTrue(/different length entirely/.test(mm), 'a different-length mismatch is named as such');
  assertTrue(sameLenMsg !== mm, 'and the two mismatch shapes do not produce one identical message');
}

// ── §4 'unreachable' — "I could not ask" is never "the answer is no" ────────
// UP-9's blind/missing contract, moved to the network. This is the section that
// stops the gate from sending someone to re-upload a correct artifact because
// their VPN dropped.
section('§4 a transport failure is BLIND, not a verdict about the artifact');
{
  samples['§4 real transport failures'] = 2;
  // A REAL closed port: bind one, learn the number, close it, then aim at it.
  const deadBase = await withServer(() => {}, (b) => b);
  const r = await verifyRemoteArtifact({ url: `${deadBase}${filesPath(APK_NAME)}`, sha256: sha256(APK_BYTES), size: APK_BYTES.length });
  assertTrue(r.verdict === 'unreachable', "a refused connection → 'unreachable', NOT 'not-found'");
  assertTrue(r.status === null, 'no status is invented for an answer that never came');
  assertTrue(typeof r.error === 'string' && r.error.length > 0, `the transport cause is dug out and reported (${r.error})`);
  assertTrue(/ECONNREFUSED/i.test(r.error), 'and it is the real OS error code, not "fetch failed"');

  // A timeout is 'unreachable' too. Server accepts, sends headers, never
  // finishes the body — the hang this timeout exists to bound.
  const hung = await withServer((_req, res) => { res.writeHead(200); res.write(APK_BYTES.subarray(0, 16)); }, (b) =>
    verifyRemoteArtifact({ url: `${b}${filesPath(APK_NAME)}`, sha256: sha256(APK_BYTES), size: APK_BYTES.length, timeoutMs: 400 }));
  assertTrue(hung.verdict === 'unreachable', "a stalled download → 'unreachable', not 'content-mismatch' — the bytes that arrived may have been perfectly correct");

  const msg = remoteRefusalMessage(APK_NAME, r);
  assertTrue(/COULD NOT ASK/.test(msg), 'the refusal says the check did not run');
  assertTrue(/says NOTHING about whether the artifact is published/i.test(msg), 'it states what it does NOT know');
  assertTrue(/do NOT re-upload/i.test(msg), '🔴 and actively warns AGAINST the other refusals’ actions');
  assertTrue(msg.includes(REMOTE_VERIFY_SKIP_FLAG), 'it points at the escape hatch — the one situation where offline is legitimate');
  assertTrue(!/NOT ON THE DOWNLOAD CENTER/.test(msg) && !/SERVING DIFFERENT BYTES/.test(msg), 'and does not borrow either of the other two refusals’ words');
}

// ── §5 the gate: all-match emits, one bad artifact refuses ─────────────────
section('§5 the gate over a whole composed manifest: all-match passes, one 404 refuses');
await withServer(goodSite, async (base) => {
  samples['§5 whole-manifest gate runs'] = 3;
  const oks = [];
  const errs = [];
  const green = await gateRemoteArtifacts({ platforms: platformsFor(base), fail: (m) => errs.push(m), ok: (m) => oks.push(m) });
  assertTrue(green.refused === 0 && green.checked === 2, 'ALL MATCH: both artifacts verify, refused=0 — the builder proceeds to emit');
  assertTrue(errs.length === 0, 'and nothing was reported through fail()');
  assertTrue(oks.length === 2 && oks.every((m) => /逐字节相符/.test(m)), 'each success prints its evidence (size + hash), so the log says what was checked');

  // ONE 404 among otherwise-good artifacts.
  const mixed = platformsFor(base);
  const goneName = 'FlowMic-0.0.0-fixture-portable-windows-x64.zip';
  const goneUrl = `${base}${filesPath(goneName)}`;
  mixed['windows-x64'].artifacts.push({ kind: 'portable-zip', locale: null, filename: goneName, url: goneUrl, sha256: sha256(MSI_BYTES), size: MSI_BYTES.length });
  const errs2 = [];
  const oks2 = [];
  const red = await gateRemoteArtifacts({ platforms: mixed, fail: (m) => errs2.push(m), ok: (m) => oks2.push(m) });
  assertTrue(red.refused === 1, 'ONE 404: the gate refuses (refused=1)');
  assertTrue(red.checked === 3 && oks2.length === 2, '🔴 and still checked ALL THREE — one run tells the operator everything that is wrong, not one thing per run');
  assertTrue(errs2.length === 1 && errs2[0].includes(goneUrl), 'the single refusal names the offending URL');
  assertTrue(errs2[0].includes(goneName), 'and names the file, so it can be matched against ./publish');

  // A size/hash mismatch through the same gate, distinguishable in the output.
  const bad = platformsFor(base);
  bad.android.artifacts[0].sha256 = sha256(Buffer.from('a different build entirely'));
  const errs3 = [];
  const mism = await gateRemoteArtifacts({ platforms: bad, fail: (m) => errs3.push(m), ok: () => {} });
  assertTrue(mism.refused === 1 && /SERVING DIFFERENT BYTES/.test(errs3[0]), 'a hash mismatch refuses through the gate, with the mismatch wording');
  assertTrue(!/NOT ON THE DOWNLOAD CENTER/.test(errs3[0]), 'and is not reported as a 404');
});

// ── §6 wiring: the builder calls it, awaits it, and refuses BEFORE writing ──
// A correct mechanism nobody invokes is this repo's headline historical bug
// class, and here it has a second failure shape that is just as bad: a gate
// invoked but not AWAITED would resolve after the manifest had already been
// written, turning a refusal into a warning printed over a published file.
//
// ✅ REVERSE CONTROL, actually performed rather than asserted [measured
// 2026-08-09, dev-pc-a]: the gate call in build-update-manifest.mjs was
// replaced with an inert `{ checked: 0, refused: 0 }` and this drill went RED
// here, on this section, exactly once — then the file was restored from a
// byte-level backup and re-hashed identical (sha256 89c7e52e…), with the marker
// string grepping to 0. A gate that has never been seen red is not known to be
// capable of going red, and this section is what would have to notice.
section('§6 build-update-manifest.mjs calls it, awaits it, and refuses before writeFileSync');
{
  samples['§6 pinned wiring facts'] = 4;
  assertTrue(/from '\.\/verify-remote-artifact\.mjs'/.test(BUILDER_SRC), 'the builder imports the verifier module');
  const gateIdx = BUILDER_SRC.indexOf('await gateRemoteArtifacts({ platforms, fail, ok })');
  assertTrue(gateIdx !== -1, 'it calls gateRemoteArtifacts with AWAIT — an un-awaited gate would resolve after the manifest was already written');

  const writeIdx = BUILDER_SRC.indexOf('writeFileSync(MANIFEST');
  assertTrue(writeIdx !== -1 && gateIdx < writeIdx, 'the gate runs BEFORE writeFileSync — it refuses a manifest instead of annotating one');
  const checkExitIdx = BUILDER_SRC.indexOf('if (CHECK_ONLY)');
  assertTrue(checkExitIdx !== -1 && gateIdx < checkExitIdx, '🔴 and BEFORE the --check early exit, so --check cannot report "this manifest is fine" without asking the site');
  assertTrue(/refused > 0[\s\S]{0,600}process\.exit\(1\)/.test(BUILDER_SRC), 'a non-zero refusal count exits 1 — the refusal actually stops the run');

  // The URL shape this drill models must still be the shape the builder builds,
  // or §1–§5 have been exercising a path nobody composes. This used to be a
  // source-text match on the literal template; since PUB-1 the fixtures call
  // the builder's own composer (see the import at the top), so what is left to
  // pin is that the builder still uses it rather than re-spelling a URL inline.
  assertTrue(
    BUILDER_SRC.includes('url: updateArtifactUrl(DOWNLOAD_BASE, VERSION, name)'),
    'the builder composes artifact URLs through updateArtifactUrl — the shared composer these fixtures drive',
  );
  assertTrue(
    /resolveUpdateDownloadBase\(\)/.test(BUILDER_SRC),
    'the base is still env-overridable (FLOWMIC_UPDATE_DOWNLOAD_BASE), which is what makes a loopback drill of the whole script possible later',
  );

  // The correction must stay: the header used to say this script could not
  // enforce ordering, and an expired truth there costs a question nobody asks.
  assertTrue(!/这条脚本拦不住它 —— 它是流程约束/.test(BUILDER_SRC.split('🔴 这一段原本收尾于')[0]), 'the old "this script cannot enforce it" claim no longer stands as live text');
  assertTrue(/闸 ②/.test(BUILDER_SRC), 'the header names the new gate');
}

// ── §7 the escape hatch is opt-in, loud, and never inferred ─────────────────
section('§7 --skip-remote-verify: opt-in, loud, and never inferred from a failure');
{
  samples['§7 flag facts'] = 3;
  assertTrue(REMOTE_VERIFY_SKIP_FLAG === '--skip-remote-verify', 'the flag is spelled as the card specifies');
  assertTrue(
    BUILDER_SRC.includes('const SKIP_REMOTE_VERIFY = args.includes(REMOTE_VERIFY_SKIP_FLAG)'),
    'the builder reads it from argv, and from the module’s constant rather than a second spelling',
  );
  assertTrue(!/SKIP_REMOTE_VERIFY\s*=\s*true/.test(BUILDER_SRC), 'it is never defaulted to on');
  assertTrue(!/process\.env\.[A-Z_]*SKIP_REMOTE/.test(BUILDER_SRC + MODULE_SRC), 'there is no env-var form of it — an env bypass is the kind that gets set once and forgotten');

  // 🔴 The failure that must NOT downgrade into a skip. If 'unreachable' quietly
  // became "skip", the flag would be redundant and the gate could never fail.
  //
  // ⚠️ This is asserted by DRIVING the gate, not by grepping the builder. The
  // assertion that first stood here was a regex — "the word 'unreachable' must
  // not appear near SKIP_REMOTE_VERIFY" — and it went RED on the first run
  // against a correct implementation, because it matched the builder's own
  // comment EXPLAINING that unreachable does not downgrade. A source-text
  // assertion that a correct comment can trip is measuring prose, and prose is
  // not the thing that has to hold. It is also the wrong failure direction:
  // deleting the comment would have turned it green. Recorded rather than
  // quietly swapped, because the near-miss is the useful part.
  const deadBase = await withServer(() => {}, (b) => b);
  const deadErrs = [];
  const deadOks = [];
  const dead = await gateRemoteArtifacts({
    platforms: platformsFor(deadBase),
    fail: (m) => deadErrs.push(m),
    ok: (m) => deadOks.push(m),
    timeoutMs: 3_000,
  });
  assertTrue(dead.refused === 2 && dead.checked === 2, '🔴 an unreachable site REFUSES every artifact (refused=2/2) — it does NOT downgrade into a silent skip');
  assertTrue(deadOks.length === 0, 'and nothing is reported as verified when nothing could be asked');
  assertTrue(deadErrs.length === 2 && deadErrs.every((m) => /COULD NOT ASK/.test(m)), 'each refusal is the blind one — the flag remains the ONLY way to proceed without asking');

  const banner = remoteVerifySkipBanner().join('\n');
  assertTrue(/🔴/.test(banner) && banner.includes(REMOTE_VERIFY_SKIP_FLAG), 'the banner is marked and names the flag that caused it');
  assertTrue(/404/.test(banner), 'it names the concrete risk: the manifest may point at 404s');
  assertTrue(/离线演练/.test(banner), 'it names the one legitimate use');
  assertTrue(/不是「红了绕过去」的路子/.test(banner), '🔴 and says outright that it is not a way past a red check');
  assertTrue(BUILDER_SRC.includes('remoteVerifySkipBanner()'), 'and the builder actually prints it rather than skipping silently');

  assertTrue(DEFAULT_REMOTE_TIMEOUT_MS >= 60_000, `the default timeout (${DEFAULT_REMOTE_TIMEOUT_MS} ms) is generous — too tight would report "could not ask" about a site that was answering`);
}

console.log('\nSAMPLES PER CASE:');
for (const [k, v] of Object.entries(samples)) console.log(`  ${String(v).padStart(3)}  ${k}`);
console.log(`\nACCOUNTING: sections run ${sectionsRun}/${TOTAL_SECTIONS}, ${failures} assertion failure(s)`);
if (failures > 0) {
  console.error(`\n✗ UP-10 drill FAILED (${failures} assertion(s))`);
  process.exit(1);
}
if (sectionsRun !== TOTAL_SECTIONS) {
  console.error(`\n✗ UP-10 drill ran ${sectionsRun}/${TOTAL_SECTIONS} sections — a partial run is not a pass.`);
  process.exit(1);
}
console.log('\n✓ UP-10 drill PASSED');
