// SC-9 drill for scripts/ship-watch.mjs
// (docs/strategy/2026-09-17-ship-chain-eight-minute-design.md §3.2, §4 R7,
//  §5 row SC-9.)
//
// WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT.
//
// The watcher makes two kinds of claim and only one of them can be tested here:
//
//   · "given this text, the queue is in this state" — testable, and tested
//     against the REAL bytes the producing machines print. The mac fixture is a
//     trimmed copy of ~/mac-release-0378.log's tail, the TestFlight fixture is
//     asc-build-state.mjs's own verdict lines, the CI fixture is the JSON shape
//     `gh run list --json` really returns, and the download-centre fixture is
//     the JSON http://100.64.7.68/api/v1/projects/flowmic/latest really
//     returned on 2026-09-18. A drill whose fixtures are invented tests the
//     drill's idea of the far side, which is the one thing never in doubt.
//
//   · "the ssh/gh/http call is wired up correctly" — NOT testable here, and
//     nothing in this file pretends otherwise: no section starts ssh, gh or a
//     network request. That half is proved by running the real thing once
//     (`node scripts/ship-watch.mjs <round> --once`), which is why the card
//     required a real run and the quoting of its four lines.
//
// 🔴 §4 R7 is the reason this file exists at all, so it gets two sections: a
// probe that throws must land as PENDING carrying what it threw (§5), and a
// terminal row must never be un-set by a later poll (§4). The unknown-state path
// is in §5 too, because failing closed on a word nobody wrote a comparison for
// is the same rule seen from the other side.
//
// EXIT CODES (scripts/run-script-tests.mjs header): 0 = PASS, 1 = FAIL, 2 = SKIP.
//
// Run: `node scripts/ship-watch.test.mjs`

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CADENCE_MS,
  DONE,
  FAILED,
  PENDING,
  QUEUES,
  REQUIRED_WORKFLOWS,
  allTerminal,
  formatLine,
  NO_NODE,
  macDoneMarker,
  macNodeCommand,
  main,
  mergeReading,
  parseBuildState,
  parseMacLog,
  parseStatusFile,
  pollOnce,
  readStatusFile,
  renderStatusFile,
  resolvePublicSha,
  rotationReading,
  runProbe,
  summariseRuns,
  summaryLine,
  writeStatusFile,
} from './ship-watch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WATCH = join(HERE, 'ship-watch.mjs');

let failures = 0;
let sectionsRun = 0;
const TOTAL_SECTIONS = 8;
const section = (t) => { sectionsRun += 1; console.log(`\n=== ${t} ===`); };
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); failures += 1; }
}

const tempDirs = [];
const makeTempDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tempDirs.push(d); return d; };

const V = '0.3.78';

// ── the fixtures, each a trimmed copy of what a real machine printed ─────────

/** The tail of ~/mac-release-0378.log on flowmic-mac (read 2026-09-18). The line
 *  before the marker is what adopt-artifact.mjs's --sha256 consumes. */
const MAC_LOG_DONE = [
  'Processing: /Users/FlowMic-app/flowmic-app/apps/desktop/src-tauri/target/release/bundle/macos/FlowMic.app',
  'The validate action worked!',
  '  team=1 devid-authority=1 verify-DR=1 spctl-notarized=1 staple-ok=1',
  'sherpa sidecar addon verified.',
  '=== ZIP ARTIFACT (portable name) ===',
  '-rw-r--r--  1 FlowMic-app  staff  60215172 Sep  8 07:46 FlowMic-0.3.78-portable-macos-arm64.zip',
  'ebc6f90a10d456e41e8fb72fd8826fecad6aa902005cd98b11b2622e10d3533a  FlowMic-0.3.78-portable-macos-arm64.zip',
  macDoneMarker(V),
].join('\n');

/** The same log mid-run: cargo has finished, nothing is notarised, no marker. */
const MAC_LOG_RUNNING = [
  '    Finished `release` profile [optimized] target(s) in 20.31s',
  'signing FlowMic.app ...',
].join('\n');

const MAC_LOG_REJECTED = [
  '  team=1 devid-authority=1 verify-DR=1 spctl-notarized=0 staple-ok=0',
  macDoneMarker(V),
].join('\n');

/** asc-build-state.mjs's own verdict lines (taken from its source on the Mac). */
const TF_READY = [
  'app: FlowMic (6752893012)',
  `VERDICT ${V}: builds = 1:VALID`,
  `READY: ${V} has a VALID build -- testers can install it`,
].join('\n');
const TF_PROCESSING = [
  `VERDICT ${V}: builds = 1:PROCESSING`,
  `NOT READY: ${V} has no VALID build yet`,
].join('\n');
const TF_NONE = `VERDICT: ${V} has NO pre-release version record yet`;

/** The shape `gh run list --repo flowmicapp/flowmic --commit <sha> --json
 *  workflowName,name,status,conclusion,createdAt` really returns. */
const ciRun = (workflowName, conclusion, createdAt = '2026-09-13T10:00:00Z') =>
  ({ workflowName, name: workflowName, status: conclusion ? 'completed' : 'in_progress', conclusion, createdAt });
const CI_ALL_GREEN = REQUIRED_WORKFLOWS.map((w) => ciRun(w, 'success'));

/** The download centre's real /latest payload, trimmed (2026-09-18). */
const dcLatest = (version) => ({ project: 'flowmic', channel: 'release', version, primary: { version } });
const dcArtifacts = (versions) => versions.map((version) => ({ artifact_id: `id-${version}`, version, filename: `FlowMic-${version}-release.apk` }));

/**
 * Drive the REAL entry point in process, with the repo root injected.
 *
 * `main` already takes `{ root }` — the same seam `writeStatusFile` and
 * `readStatusFile` take — so this exercises parseArgs, the poll loop, the status
 * write and the summary line exactly as the CLI does. The first draft of this
 * file spawned the script instead, and every child resolved REPO_ROOT from its
 * own location and wrote four rounds of fixture readings into the real
 * `.local/ship/`: both pollution, and a drill reading a directory it never set
 * up. Two sections below still spawn, and say why they can.
 */
async function runWatch(argv, root, extra = {}) {
  const out = [];
  const code = await main(argv, { root, log: (...a) => out.push(a.join(' ')), ...extra });
  return { code, stdout: out.join('\n') };
}

function writeFixtures(dir, { mac, tf, runs, latest, artifacts }) {
  writeFileSync(join(dir, 'mac.log'), mac, 'utf8');
  writeFileSync(join(dir, 'testflight.txt'), tf, 'utf8');
  writeFileSync(join(dir, 'runs.json'), JSON.stringify(runs), 'utf8');
  writeFileSync(join(dir, 'dc-latest.json'), JSON.stringify(latest), 'utf8');
  writeFileSync(join(dir, 'dc-artifacts.json'), JSON.stringify(artifacts), 'utf8');
}

// ── §1 the four criteria read the real text ──────────────────────────────────

section('§1 each criterion is read out of the text the producing machine prints');
{
  const done = parseMacLog(MAC_LOG_DONE, V);
  assertTrue(done.state === DONE, `mac: marker + spctl-notarized=1 staple-ok=1 ⇒ DONE (got ${done.state})`);
  assertTrue(done.extra?.sha256 === 'ebc6f90a10d456e41e8fb72fd8826fecad6aa902005cd98b11b2622e10d3533a'
    && done.extra?.zipName === 'FlowMic-0.3.78-portable-macos-arm64.zip',
  "mac: DONE also yields the zip name and the producing machine's sha256 (what --sha256 needs)");
  assertTrue(parseMacLog(MAC_LOG_RUNNING, V).state === PENDING, 'mac: a log without the marker is PENDING, not DONE');
  assertTrue(parseMacLog(MAC_LOG_REJECTED, V).state === FAILED, 'mac: spctl-notarized=0 is FAILED, marker or no marker');
  // 🔴 The marker alone is NOT the criterion: reaching the last line of a script
  // and Apple accepting the bundle are different sentences.
  assertTrue(parseMacLog(`nothing notarised here\n${macDoneMarker(V)}`, V).state === PENDING,
    'mac: marker with no spctl/staple line stays PENDING — the marker is not the notarisation');

  assertTrue(parseBuildState(TF_READY, V).state === DONE, 'testflight: `READY: … has a VALID build` ⇒ DONE');
  assertTrue(parseBuildState(TF_PROCESSING, V).state === PENDING, 'testflight: `NOT READY` ⇒ PENDING');
  assertTrue(parseBuildState(TF_NONE, V).state === PENDING, 'testflight: no pre-release record ⇒ PENDING, not FAILED (nobody uploaded yet)');
  assertTrue(parseBuildState('NO APP RECORD for app.flowmic.ios', V).state === FAILED, 'testflight: NO APP RECORD ⇒ FAILED');

  assertTrue(summariseRuns(CI_ALL_GREEN, 'c761c98ccff4').state === DONE, `public ci: all ${REQUIRED_WORKFLOWS.length} required workflows success ⇒ DONE`);
  const oneRed = summariseRuns([...CI_ALL_GREEN.slice(1), ciRun('verify', 'failure')], 'c761c98ccff4');
  assertTrue(oneRed.state === FAILED && oneRed.detail.includes('verify=failure'), 'public ci: a failed workflow ⇒ FAILED and the line NAMES it (§1-13)');
  assertTrue(summariseRuns(CI_ALL_GREEN.slice(0, 2), 'c761c98ccff4').state === PENDING, 'public ci: two of four green ⇒ PENDING');
  // A re-run that went green must not stay red because attempt #1 is still listed.
  assertTrue(summariseRuns([...CI_ALL_GREEN, ciRun('verify', 'failure', '2026-09-13T09:00:00Z')], 'c761c98ccff4').state === DONE,
    'public ci: only the newest run per workflow counts — an older failed attempt does not outvote a green re-run');

  assertTrue(rotationReading(dcLatest(V), dcArtifacts([V, '0.3.77', '0.3.76']), V).state === DONE, 'download centre: /latest=this version and 3 retained ⇒ DONE');
  assertTrue(rotationReading(dcLatest('0.3.77'), dcArtifacts(['0.3.77']), V).state === PENDING, 'download centre: /latest still on the previous version ⇒ PENDING');
  assertTrue(rotationReading(dcLatest(V), dcArtifacts([V, '0.3.77', '0.3.76', '0.3.75']), V).state === PENDING,
    'download centre: uploaded but four versions still on the site ⇒ PENDING (rotation is part of the criterion, not a detail)');
}

// ── §2 the four lines start PENDING and flip INDEPENDENTLY ───────────────────

section('§2 the four lines start PENDING and each flips on its own evidence');
{
  const root = makeTempDir('flowmic-sw-root-');
  const fx = makeTempDir('flowmic-sw-fx-');
  const round = 'roundA';
  const once = () => runWatch([round, '--once', '--version', V, '--fixtures', fx], root);

  // Nothing has happened anywhere.
  writeFixtures(fx, { mac: MAC_LOG_RUNNING, tf: TF_PROCESSING, runs: {}, latest: dcLatest('0.3.77'), artifacts: dcArtifacts(['0.3.77']) });
  let r = await once();
  let rows = readStatusFile(round, root);
  assertTrue(r.code === 0, `--once exits 0 on a pass where nothing is terminal (got ${r.code})`);
  assertTrue(QUEUES.every((q) => rows.get(q)), 'all four lines exist in the file after one pass');
  assertTrue(QUEUES.every((q) => rows.get(q)?.state === PENDING), 'all four lines start PENDING');
  const sinceAtStart = Object.fromEntries(QUEUES.map((q) => [q, rows.get(q).since]));

  // Only the download centre moves.
  writeFixtures(fx, { mac: MAC_LOG_RUNNING, tf: TF_PROCESSING, runs: {}, latest: dcLatest(V), artifacts: dcArtifacts([V, '0.3.77', '0.3.76']) });
  await once();
  rows = readStatusFile(round, root);
  assertTrue(rows.get('DC_ROTATION').state === DONE, 'DC_ROTATION flips DONE on its own');
  assertTrue(QUEUES.filter((q) => q !== 'DC_ROTATION').every((q) => rows.get(q).state === PENDING), 'the other three are untouched by it');
  assertTrue(rows.get('MAC').since === sinceAtStart.MAC,
    'a row whose state did not change keeps its ORIGINAL `since` — the file says how long this has been pending, not when it was last polled');

  // Then the Mac finishes, then TestFlight and CI. Each on its own evidence.
  writeFixtures(fx, { mac: MAC_LOG_DONE, tf: TF_PROCESSING, runs: {}, latest: dcLatest(V), artifacts: dcArtifacts([V, '0.3.77', '0.3.76']) });
  await once();
  rows = readStatusFile(round, root);
  assertTrue(rows.get('MAC').state === DONE && rows.get('TESTFLIGHT').state === PENDING && rows.get('PUBLIC_CI').state === PENDING,
    'MAC flips DONE while TESTFLIGHT and PUBLIC_CI stay PENDING');

  writeFixtures(fx, { mac: MAC_LOG_DONE, tf: TF_READY, runs: { sha: 'c761c98ccff4', runs: CI_ALL_GREEN }, latest: dcLatest(V), artifacts: dcArtifacts([V, '0.3.77', '0.3.76']) });
  r = await once();
  rows = readStatusFile(round, root);
  assertTrue(allTerminal(rows), 'with all four answered, every row is terminal');
  assertTrue(r.stdout.includes('SHIP-WATCH') && r.stdout.includes('SETTLED'), 'the final summary line is written and says SETTLED');
}

// ── §3 the file is plain text and idempotently rewritten ─────────────────────

section('§3 the status file is plain text, fixed-format, and rewriting it twice produces the same bytes');
{
  const root = makeTempDir('flowmic-sw-idem-');
  const round = 'roundB';
  const rows = new Map(QUEUES.map((q) => [q, { queue: q, state: PENDING, since: '2026-09-18T00:00:00.000Z', detail: 'not polled yet' }]));
  const meta = { round, version: V, startedAt: '2026-09-18T00:00:00.000Z' };
  const p = writeStatusFile(round, rows, meta, root);
  const first = readFileSync(p, 'utf8');
  writeStatusFile(round, rows, meta, root);
  assertTrue(readFileSync(p, 'utf8') === first, 'the same readings written twice produce byte-identical files');

  const lines = first.split('\n').filter((l) => l && !l.startsWith('#'));
  assertTrue(lines.length === QUEUES.length, `exactly ${QUEUES.length} data lines, one per queue (got ${lines.length})`);
  assertTrue(lines.every((l) => /^[A-Z_]+ (PENDING|DONE|FAILED) \d{4}-\d{2}-\d{2}T[\d:.]+Z( .*)?$/.test(l)),
    'every line matches `<QUEUE> <STATE> <since ISO> <detail>`');
  assertTrue(lines.map((l) => l.split(' ')[0]).join(',') === QUEUES.join(','), 'the queues appear in a fixed order, so a diff of two files is readable');

  // A detail containing newlines must not be able to grow a fifth row.
  const noisy = formatLine({ queue: 'MAC', state: PENDING, since: '2026-09-18T00:00:00.000Z', detail: 'line one\nMAC DONE 2026-09-18T00:00:00.000Z injected' });
  assertTrue(!noisy.includes('\n'), 'a detail carrying a newline is flattened — a probe message cannot forge a second row');
  assertTrue(parseStatusFile(renderStatusFile(rows, meta)).size === QUEUES.length, 'what it writes is what it reads back');
}

// ── §4 a terminal row is never un-set ────────────────────────────────────────

section('§4 R7: a FAILED line never relaxes back to PENDING, and a DONE is never erased by a later blind poll');
{
  const now = '2026-09-18T01:00:00.000Z';
  const failed = { queue: 'PUBLIC_CI', state: FAILED, since: '2026-09-18T00:00:00.000Z', detail: 'verify=failure' };
  const back = mergeReading(failed, { queue: 'PUBLIC_CI', state: PENDING, detail: '2/4 green' }, now);
  assertTrue(back.row.state === FAILED && back.row.since === failed.since && back.row.detail === failed.detail,
    'FAILED + a later PENDING reading ⇒ still FAILED, same since, same detail');
  assertTrue(mergeReading(failed, { queue: 'PUBLIC_CI', state: PENDING, detail: 'unreachable: gh exit 1' }, now).row.state === FAILED,
    'FAILED + an unreachable probe ⇒ still FAILED');
  const doneRow = { queue: 'MAC', state: DONE, since: '2026-09-18T00:00:00.000Z', detail: 'staple-ok=1' };
  assertTrue(mergeReading(doneRow, { queue: 'MAC', state: PENDING, detail: 'unreachable: ssh timeout' }, now).row.state === DONE,
    'DONE + an unreachable probe ⇒ still DONE (an answer, once given, stands)');
  assertTrue(mergeReading(doneRow, { queue: 'MAC', state: FAILED, detail: 'nope' }, now).row.state === DONE,
    'DONE is not downgraded either — two terminal answers for one queue is a bug upstream, not a state transition');

  // End to end: a FAILED on disk survives a later pass whose fixture says green.
  const root = makeTempDir('flowmic-sw-term-');
  const fx = makeTempDir('flowmic-sw-fxterm-');
  const round = 'roundC';
  writeFixtures(fx, {
    mac: MAC_LOG_RUNNING, tf: TF_PROCESSING,
    runs: { sha: 'c761c98ccff4', runs: [...CI_ALL_GREEN.slice(1), ciRun('verify', 'failure')] },
    latest: dcLatest('0.3.77'), artifacts: dcArtifacts(['0.3.77']),
  });
  await runWatch([round, '--once', '--version', V, '--fixtures', fx], root);
  assertTrue(readStatusFile(round, root).get('PUBLIC_CI').state === FAILED, 'a red CI run lands as FAILED on disk');
  writeFixtures(fx, { mac: MAC_LOG_RUNNING, tf: TF_PROCESSING, runs: { sha: 'x', runs: CI_ALL_GREEN }, latest: dcLatest('0.3.77'), artifacts: dcArtifacts(['0.3.77']) });
  const again = await runWatch([round, '--once', '--version', V, '--fixtures', fx], root);
  assertTrue(readStatusFile(round, root).get('PUBLIC_CI').state === FAILED,
    'and it is still FAILED after a pass whose fixture says all-green — terminal means terminal');
  assertTrue(again.stdout.includes('FAILED'), 'the summary line reports FAILED rather than SETTLED');
}

// ── §5 R7: a probe that throws is PENDING with the error, never DONE ─────────

section('§5 R7: a probe that throws produces PENDING carrying the error — never DONE, never silence');
{
  const thrown = await runProbe('MAC', () => { throw new Error('ssh flowmic-mac: connect timed out'); }, {});
  assertTrue(thrown.state === PENDING, 'a thrown probe is PENDING');
  assertTrue(thrown.detail.startsWith('unreachable: ') && thrown.detail.includes('connect timed out'),
    'the message it threw is IN the line, prefixed `unreachable:` so the two kinds of PENDING are told apart on the line itself');
  const rejected = await runProbe('DC_ROTATION', async () => { throw new Error('fetch failed'); }, {});
  assertTrue(rejected.state === PENDING && rejected.detail.includes('fetch failed'), 'a rejected async probe behaves the same');
  assertTrue((await runProbe('TESTFLIGHT', async () => 'DONE', {})).state === PENDING,
    'a probe returning a bare string is not a reading — PENDING, not DONE');
  const missing = await runProbe('PUBLIC_CI', undefined, {});
  assertTrue(missing.state === PENDING && missing.detail.includes('no probe registered'), 'a queue with no probe at all is PENDING and says so');

  // Fail closed on a word nobody wrote a comparison for.
  const weird = mergeReading(undefined, { queue: 'MAC', state: 'OK' }, '2026-09-18T01:00:00.000Z');
  assertTrue(weird.row.state === PENDING && weird.row.detail.includes('unknown state'),
    'an unrecognised state word becomes PENDING with a named reason — not a fourth state, and not DONE');

  // The whole-file path: every probe throwing leaves four PENDING rows, zero DONE.
  const rows = new Map();
  await pollOnce({
    round: 'r', version: V, rows,
    probes: Object.fromEntries(QUEUES.map((q) => [q, () => { throw new Error('the network is gone'); }])),
  });
  assertTrue(QUEUES.every((q) => rows.get(q).state === PENDING), 'a pass in which every probe throws yields four PENDING rows');
  assertTrue(QUEUES.every((q) => rows.get(q).detail.startsWith('unreachable:')), 'and every one of them says it could not ask');
  assertTrue(!summaryLine({ round: 'r', version: V, rows, elapsedMs: 0, timedOut: true }).includes(DONE),
    'the summary line of that pass contains no DONE at all');
}

// ── §6 --once writes and exits ───────────────────────────────────────────────

section('§6 --once polls each queue once, writes the file, and exits without waiting for a cadence');
{
  const root = makeTempDir('flowmic-sw-once-');
  const fx = makeTempDir('flowmic-sw-fxonce-');
  const round = 'roundD';
  writeFixtures(fx, { mac: MAC_LOG_RUNNING, tf: TF_PROCESSING, runs: {}, latest: dcLatest('0.3.77'), artifacts: dcArtifacts(['0.3.77']) });
  // 🔴 `sleep` is injected as a function that RECORDS instead of waiting. A drill
  // that proved "--once is fast" by timing it would pass just as happily on a
  // machine that happened to be quick, and would say nothing about whether the
  // loop reached a wait at all. The evidence here is that it never called one.
  const slept = [];
  const r = await runWatch([round, '--once', '--version', V, '--fixtures', fx], root, { sleep: async (ms) => { slept.push(ms); } });
  assertTrue(r.code === 0, '--once exits 0');
  assertTrue(slept.length === 0,
    `--once never entered a cadence wait (recorded ${slept.length} sleeps; the shortest cadence is ${Math.min(...Object.values(CADENCE_MS)) / 1000}s)`);
  assertTrue(readStatusFile(round, root).size === QUEUES.length, '--once wrote all four lines before exiting');
  assertTrue(r.stdout.includes('SHIP-WATCH'), '--once still prints the fixed final line (the orchestrator quotes it)');
  // 🔴 REGRESSION PIN, from the first real run: the summary said SETTLED beside
  // four PENDING rows, because SETTLED had quietly come to mean "the loop
  // stopped" and --once always stops the loop. The word must mean what it says.
  assertTrue(/SHIP-WATCH \S+ \S+ PENDING /.test(r.stdout) && !r.stdout.includes('SETTLED'),
    'a --once pass on which nothing settled says PENDING, not SETTLED — the verdict is about the queues, not about the loop');
}

// ── §7 the fixture seam is visible in the output, and cannot publish ─────────

section('§7 the one seam that fakes a reading announces itself, and refuses to act on the world');
{
  const root = makeTempDir('flowmic-sw-fxvis-');
  const fx = makeTempDir('flowmic-sw-fxvis2-');
  const round = 'roundE';
  writeFixtures(fx, { mac: MAC_LOG_DONE, tf: TF_READY, runs: { sha: 'c761c98ccff4', runs: CI_ALL_GREEN }, latest: dcLatest(V), artifacts: dcArtifacts([V, '0.3.77', '0.3.76']) });
  const r = await runWatch([round, '--once', '--version', V, '--fixtures', fx], root);
  assertTrue(r.stdout.includes('FIXTURES'), 'the console says the readings are fixtures');
  const file = readFileSync(join(root, '.local', 'ship', round, 'external.status'), 'utf8');
  assertTrue(file.includes('# FIXTURES'), 'and so does the file — four DONE lines with no header would be indistinguishable from a real green round');

  // 🔴 --adopt uploads bytes; a fixture reading is not evidence about bytes.
  // These two ARE real child processes, on purpose: both refuse inside parseArgs
  // or immediately after, BEFORE anything is written, so spawning them proves the
  // refusal reaches an exit code and stderr without touching any tree.
  const adopt = spawnSync(process.execPath, [WATCH, round, '--once', '--version', V, '--fixtures', fx, '--adopt'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assertTrue(adopt.status === 2 && /refuses to run against --fixtures/.test(adopt.stderr),
    '--adopt + --fixtures is refused outright (exit 2), not quietly allowed');
  const bad = spawnSync(process.execPath, [WATCH, round, '--nonsense'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assertTrue(bad.status === 2 && /unknown option/.test(bad.stderr), 'an unknown flag is a usage error, not something skipped in silence');
}

// ── §8 resolving the public sha never guesses ────────────────────────────────

section('§8 the public sha is resolved from a commit that NAMES the version, or not at all');
{
  const fakeGh = (out) => () => ({ status: 0, stdout: out, stderr: '' });
  const listing = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa release 0.3.85',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb release 0.3.84',
  ].join('\n');
  assertTrue(resolvePublicSha('0.3.85', fakeGh(listing)) === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a commit naming the version yields its sha');
  assertTrue(resolvePublicSha('0.3.89', fakeGh(listing)) === null,
    "no commit names 0.3.89 ⇒ null, NOT the newest commit — this repo's HEAD is never the public sha, and the nearest commit is not an answer");
  let threw = false;
  try { resolvePublicSha('0.3.85', () => ({ status: 1, stdout: '', stderr: 'HTTP 401' })); } catch { threw = true; }
  assertTrue(threw, 'a gh failure throws, so runProbe turns it into an `unreachable:` PENDING rather than "no synced commit"');

  // 🔴 Also from the first real run: `ssh flowmic-mac 'node …'` answers
  // `command not found: node`. Nothing is on PATH on that host. These assertions
  // pin the shape of the fix, not the reachability of the machine — no ssh here.
  const cmd = macNodeCommand('~/asc-build-state.mjs', '0.3.89');
  assertTrue(!/(^|[^-\w])node ~\//.test(cmd), 'the Mac helper is never invoked through a bare `node` — nothing is on PATH on that host');
  assertTrue(cmd.includes('~/.local/node-*/bin/node') && cmd.includes('resources/node'),
    'both staged runtimes mac-verify.sh names are tried, in its order');
  assertTrue(cmd.includes('ls -d') && !/ ~\/\.local\/node-\*\/bin\/node[^)]*\| head/.test(cmd.split('N=$(ls')[0]),
    'the glob goes through `ls … 2>/dev/null` — an unmatched zsh glob aborts the command rather than expanding to nothing');
  assertTrue(cmd.includes(NO_NODE), '"no interpreter at all" is echoed as a named token, not left as an empty reading to be guessed at');
  // 🔴 REGRESSION PIN, also from a real run: the first spelling was
  // `[ -x "$N" ] && "$N" … || echo __NO_NODE__`. `A && B || C` runs C when B
  // FAILS, and asc-build-state.mjs exits 3 on NOT READY and 2 with no
  // pre-release record — its ordinary answers. A good reading came back with
  // __NO_NODE__ attached and was reported as "no node on the Mac", a sentence
  // about our ssh setup rather than about Apple.
  assertTrue(/if \[ -x "\$N" \]; then/.test(cmd) && !/&&[^;]*\|\| echo/.test(cmd),
    'the interpreter test is an if/else, so the helper\'s own non-zero exit codes cannot be read as "there is no node"');
}

for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

// ─────────────────────────────────────────────────────────────────────────────
// REVERSE CONTROL — run 2026-09-18, machine dev-pc-a.
//
// The claim every section here rests on is "an error path can never produce
// DONE" (§4 R7). To show this drill can see that being false, `runProbe`'s catch
// in scripts/ship-watch.mjs was changed from
//
//     return { queue, state: PENDING, detail: `unreachable: ${msg}` };
// to
//     return { queue, state: DONE, detail: `unreachable: ${msg}` };
//
// and `node scripts/ship-watch.test.mjs` went red on exactly the assertions that
// exist for it — the output is quoted in the delivery report.
//
// The edit was reverted, `git diff` came back empty, and the file re-ran green.
//
// 🔴 The half that STAYED GREEN is the point. §1, §3 and §8 were untouched by
// that edit: the four criteria still parsed the real text correctly, the file was
// still idempotent, the sha resolver still refused to guess. A drill written only
// against "does it read the Mac log right" would have been fully green while
// every unreachable queue in production reported DONE — which is precisely the
// failure §4 R7 names, and the one a watcher is in a position to commit at 3am
// with nobody reading.
// ─────────────────────────────────────────────────────────────────────────────
if (failures > 0 || sectionsRun !== TOTAL_SECTIONS) {
  console.log(`\nFAIL: ${sectionsRun}/${TOTAL_SECTIONS} sections ran, ${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nPASS: ${sectionsRun}/${TOTAL_SECTIONS} sections ran, 0 failure(s)`);
process.exit(0);
